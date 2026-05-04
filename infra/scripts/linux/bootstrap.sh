#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="weixin-household-gateway"
REPO_URL="${REPO_URL:-https://github.com/thekfjie/weixin-household-gateway.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/weixin-household-gateway}"
DATA_DIR="${DATA_DIR:-/var/lib/weixin-household-gateway}"
PORT="${PORT:-18080}"
TIMEZONE="${TIMEZONE:-Asia/Shanghai}"
USER_MODE="${USER_MODE:-current}"
PERMISSION_MODE="${PERMISSION_MODE:-full}"
LOGIN_ROLE="${LOGIN_ROLE:-admin}"
APP_DIR_CREATED_BY_BOOTSTRAP=0
BOOTSTRAP_YES="${BOOTSTRAP_YES:-0}"

usage() {
  cat <<EOF
用法：curl -fsSL <bootstrap-url> | bash

可用环境变量：
  REPO_URL=${REPO_URL}
  BRANCH=${BRANCH}
  APP_DIR=${APP_DIR}
  DATA_DIR=${DATA_DIR}
  PORT=${PORT}
  TIMEZONE=${TIMEZONE}
  USER_MODE=${USER_MODE}
  PERMISSION_MODE=${PERMISSION_MODE}
  LOGIN_ROLE=${LOGIN_ROLE}
  BOOTSTRAP_YES=${BOOTSTRAP_YES}

示例：
  curl -fsSL https://raw.githubusercontent.com/thekfjie/weixin-household-gateway/main/infra/scripts/linux/bootstrap.sh | LOGIN_ROLE=admin PORT=18080 bash
  curl -fsSL https://raw.githubusercontent.com/thekfjie/weixin-household-gateway/main/infra/scripts/linux/bootstrap.sh | BOOTSTRAP_YES=1 LOGIN_ROLE=admin bash
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -eq 0 ]]; then
  echo "请用普通登录用户运行 bootstrap，不要加 sudo。" >&2
  echo "脚本会在需要写入 ${APP_DIR}、${DATA_DIR} 和 systemd 时单独调用 sudo。" >&2
  exit 1
fi

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "缺少必要命令：${command_name}" >&2
    exit 1
  fi
}

require_command git
require_command sudo
require_command bash

echo "== ${SERVICE_NAME} bootstrap =="
echo "仓库：${REPO_URL}"
echo "分支：${BRANCH}"
echo "应用目录：${APP_DIR}"
echo "权限说明：如果 ${APP_DIR} 位于 /opt，脚本只会 sudo 创建并 chown 这个项目目录给当前用户，方便 git 和 pnpm 写入；不会修改 /opt 本身。"
echo ""

if [[ -d "${APP_DIR}/.git" ]]; then
  echo "更新已有仓库..."
  git -C "${APP_DIR}" fetch origin "${BRANCH}"
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
else
  if [[ -e "${APP_DIR}" ]]; then
    echo "应用目录已存在但不是 git 仓库：${APP_DIR}" >&2
    echo "为保证卸载能恢复安装前状态，bootstrap 不会接管已有目录。" >&2
    echo "请先移走该目录，或设置 APP_DIR 到另一个新路径。" >&2
    exit 1
  fi

  sudo mkdir -p "${APP_DIR}"
  sudo chown "$(id -un):$(id -gn)" "${APP_DIR}"
  APP_DIR_CREATED_BY_BOOTSTRAP=1

  echo "克隆仓库..."
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"

install_args=(
  --app-dir "${APP_DIR}" \
  --data-dir "${DATA_DIR}" \
  --port "${PORT}" \
  --timezone "${TIMEZONE}" \
  --user-mode "${USER_MODE}" \
  --permission-mode "${PERMISSION_MODE}" \
  --login-role "${LOGIN_ROLE}"
)

if [[ "${BOOTSTRAP_YES}" == "1" ]]; then
  install_args=(--yes "${install_args[@]}")
fi

if [[ "${APP_DIR_CREATED_BY_BOOTSTRAP}" -eq 1 ]]; then
  install_args+=(--app-dir-created)
fi

if [[ "${BOOTSTRAP_YES}" == "1" ]]; then
  bash infra/scripts/linux/install.sh "${install_args[@]}"
elif [[ -r /dev/tty ]]; then
  bash infra/scripts/linux/install.sh "${install_args[@]}" </dev/tty
else
  echo "当前没有可用的交互终端；请改用 BOOTSTRAP_YES=1，或先把脚本下载到本地再执行。" >&2
  exit 1
fi
