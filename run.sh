#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PNPM_VERSION="10.13.1"
LOGIN_ROLE="${LOGIN_ROLE:-admin}"
SKIP_SETUP="${SKIP_SETUP:-0}"
FORCE_SETUP="${FORCE_SETUP:-0}"
PNPM_CMD=()

cd "${SCRIPT_DIR}"

export COREPACK_HOME="${COREPACK_HOME:-${SCRIPT_DIR}/.corepack}"
export PNPM_HOME="${PNPM_HOME:-${SCRIPT_DIR}/.pnpm-home}"
export PATH="${PNPM_HOME}:${PATH}"
export DATA_DIR="${DATA_DIR:-${SCRIPT_DIR}/data}"
export TIMEZONE="${TIMEZONE:-Asia/Shanghai}"
export PORT="${PORT:-18080}"
export CODEX_ADMIN_WORKSPACE="${CODEX_ADMIN_WORKSPACE:-${SCRIPT_DIR}/runtime/codex-admin}"
export CODEX_FAMILY_WORKSPACE="${CODEX_FAMILY_WORKSPACE:-${SCRIPT_DIR}/runtime/codex-family}"

mkdir -p \
  "${COREPACK_HOME}" \
  "${PNPM_HOME}" \
  "${DATA_DIR}" \
  "${CODEX_ADMIN_WORKSPACE}" \
  "${CODEX_FAMILY_WORKSPACE}"

if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || true
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM_CMD=(corepack pnpm)
elif command -v npm >/dev/null 2>&1; then
  PNPM_CMD=(npm exec --yes "pnpm@${PNPM_VERSION}" --)
else
  echo "Missing pnpm/corepack/npm. Install Node.js with Corepack enabled, then rerun." >&2
  exit 1
fi

run_pnpm() {
  "${PNPM_CMD[@]}" "$@"
}

has_accounts() {
  local db_file="${DATA_DIR}/weixin-household-gateway.sqlite"
  [[ -f "${db_file}" ]] || return 1

  node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
try {
  const row = db.prepare("SELECT COUNT(*) AS count FROM wechat_accounts").get();
  process.exit(Number(row.count) > 0 ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  db.close();
}
' "${db_file}" >/dev/null 2>&1
}

echo "[run] installing dependencies if needed..."
if ! CI=1 run_pnpm install --frozen-lockfile; then
  CI=1 run_pnpm install
fi

echo "[run] building project..."
run_pnpm build

if [[ "${SKIP_SETUP}" != "1" ]]; then
  if [[ "${FORCE_SETUP}" == "1" ]] || ! has_accounts; then
    setup_args=("${LOGIN_ROLE}")
    if [[ "${FORCE_SETUP}" == "1" ]]; then
      setup_args+=("--force")
    fi

    echo "[run] starting QR login for role: ${LOGIN_ROLE}"
    echo "[run] scan with WeChat and confirm; service will start afterwards."
    node dist/apps/server/setup.js "${setup_args[@]}"
  else
    echo "[run] saved WeChat account found; skipping QR login."
  fi
fi

echo "[run] starting service on port ${PORT}..."
node dist/apps/server/index.js
