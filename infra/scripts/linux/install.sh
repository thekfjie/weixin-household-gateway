#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SERVICE_NAME="weixin-household-gateway"
PNPM_VERSION="10.13.1"
STATE_FILE_NAME=".install-state"

DEFAULT_APP_DIR="${REPO_DIR}"
DEFAULT_DATA_DIR="/var/lib/weixin-household-gateway"
DEFAULT_PORT="18080"
DEFAULT_TIMEZONE="Asia/Shanghai"
LEGACY_TMP_ENV="/tmp/${SERVICE_NAME}.env"
LEGACY_TMP_SERVICE="/tmp/${SERVICE_NAME}.service"

TMP_ENV_FILE=""
TMP_SERVICE_FILE=""
PNPM_CMD=()

YES=0
APP_DIR="${DEFAULT_APP_DIR}"
DATA_DIR="${DEFAULT_DATA_DIR}"
PORT="${DEFAULT_PORT}"
TIMEZONE="${DEFAULT_TIMEZONE}"
CODEX_CLI_AUTH_MODE="api_key"
CODEX_CLI_BASE_URL=""
CODEX_CLI_API_KEY=""
CODEX_DEFAULT_MODEL="gpt-5.6-sol"
CODEX_CLI_MODEL="${CODEX_DEFAULT_MODEL}"
CODEX_CLI_REVIEW_MODEL="gpt-5.5"
CODEX_CLI_REASONING_EFFORT="high"
CODEX_FAMILY_PERMISSION_REVIEW_ENABLED="true"
CODEX_FAMILY_PERMISSION_REVIEW_MODEL="gpt-5.4-mini"
USER_MODE="current"
SERVICE_USER="weixin-agent"
SERVICE_GROUP="weixin-agent"
PERMISSION_MODE="full"
ADMIN_COMMAND=""
FAMILY_COMMAND=""
LOGIN_ROLE="admin"
SKIP_LOGIN=0
FORCE_LOGIN=0
NO_START=0
APP_DIR_MARKED_CREATED=0
SERVICE_WAS_ACTIVE=0
SERVICE_RESTARTED=0

APP_DIR_CREATED_BY_INSTALLER=0
DATA_DIR_CREATED_BY_INSTALLER=0
SERVICE_USER_CREATED_BY_INSTALLER=0
SERVICE_GROUP_CREATED_BY_INSTALLER=0
SERVICE_FILE_CREATED_BY_INSTALLER=0
SUDOERS_CREATED_BY_INSTALLER=0
SERVICE_FILE_BACKUP=""
SUDOERS_FILE_BACKUP=""

service_user_home() {
  if [[ "${USER_MODE}" == "current" ]]; then
    printf '%s\n' "${HOME}"
    return
  fi

  local home_dir
  home_dir="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
  if [[ -n "${home_dir}" ]]; then
    printf '%s\n' "${home_dir}"
    return
  fi

  printf '%s\n' "/home/${SERVICE_USER}"
}

service_user_pnpm_home() {
  printf '%s\n' "$(service_user_home)/.local/share/pnpm"
}

service_user_corepack_home() {
  printf '%s\n' "$(service_user_home)/.cache/node/corepack"
}

project_codex_command() {
  printf '%s\n' "${APP_DIR}/node_modules/.bin/codex"
}

resolve_existing_codex_command() {
  local project_codex
  project_codex="$(project_codex_command)"
  if [[ -x "${project_codex}" ]]; then
    printf '%s\n' "${project_codex}"
    return 0
  fi

  local managed_codex
  managed_codex="$(service_user_pnpm_home)/codex"
  if [[ -x "${managed_codex}" ]]; then
    printf '%s\n' "${managed_codex}"
    return 0
  fi

  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi

  return 1
}

resolve_configurable_codex_command() {
  project_codex_command
}

cleanup() {
  local exit_code=$?

  if [[ -n "${TMP_ENV_FILE}" && -f "${TMP_ENV_FILE}" ]]; then
    rm -f "${TMP_ENV_FILE}"
  fi

  if [[ -n "${TMP_SERVICE_FILE}" && -f "${TMP_SERVICE_FILE}" ]]; then
    rm -f "${TMP_SERVICE_FILE}"
  fi

  if [[
    "${exit_code}" -ne 0 &&
    "${SERVICE_WAS_ACTIVE}" -eq 1 &&
    "${SERVICE_RESTARTED}" -eq 0
  ]]; then
    echo "安装失败，尝试恢复原服务：${SERVICE_NAME}" >&2
    if ! sudo systemctl start "${SERVICE_NAME}"; then
      echo "原服务恢复失败，请手动检查：systemctl status ${SERVICE_NAME}" >&2
    fi
  fi

  return "${exit_code}"
}

trap cleanup EXIT

usage() {
  cat <<EOF
用法：bash infra/scripts/linux/install.sh [选项]

这是本项目的 Linux 安装器。默认使用当前登录用户运行 systemd 服务，
自动安装依赖、构建、必要时停下来扫码，扫码后继续启动服务。

选项：
  -y, --yes                         使用默认值，不进入配置问答
      --app-dir PATH                应用目录，默认当前仓库
      --data-dir PATH               数据目录，默认 ${DEFAULT_DATA_DIR}
      --port PORT                   服务端口，默认 ${DEFAULT_PORT}
      --timezone TZ                 业务时区，默认 ${DEFAULT_TIMEZONE}
      --codex-auth-mode MODE        api_key|login，默认 api_key
      --codex-base-url URL          第三方兼容 API Base URL
      --codex-api-key KEY           第三方兼容 API Key
      --codex-model MODEL           对话模型，默认 gpt-5.6-sol
      --codex-review-model MODEL    压缩/回顾模型，默认 gpt-5.5
      --codex-reasoning-effort LVL  思考强度：none|minimal|low|medium|high|xhigh|max|ultra，默认 high
      --family-permission-review-enabled BOOL  family 小模型权限审核 true|false，默认 true
      --family-permission-review-model MODEL   family 小模型权限审核模型，默认 gpt-5.4-mini
      --user-mode current|dedicated 服务用户模式，默认 current
      --service-user USER           dedicated 模式下的服务用户名
      --permission-mode MODE        none|limited|full sudo 策略，默认 full
      --admin-command CMD           admin Codex 命令
      --family-command CMD          family Codex 命令
      --login-role admin|family     首次扫码绑定角色，默认 admin
      --skip-login                  不执行终端扫码
      --force-login                 即使已有账号也继续扫码添加
      --no-start                    安装和构建，但不启动 systemd 服务
      --app-dir-created             告诉安装器应用目录由 bootstrap 刚创建
  -h, --help                        显示帮助
EOF
}

prompt_default() {
  local label="$1"
  local default_value="$2"
  local input

  if [[ "${YES}" -eq 1 ]]; then
    printf '%s\n' "${default_value}"
    return
  fi

  read -r -p "${label} [${default_value}]: " input
  if [[ -z "${input}" ]]; then
    printf '%s\n' "${default_value}"
  else
    printf '%s\n' "${input}"
  fi
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local input

  if [[ "${YES}" -eq 1 ]]; then
    [[ "${default_value}" =~ ^[yY] ]]
    return
  fi

  read -r -p "${label} [${default_value}]: " input
  input="${input:-$default_value}"
  case "${input}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_required() {
  local label="$1"
  local current_value="$2"
  local allow_empty_choice_label="${3:-}"
  local input

  if [[ "${YES}" -eq 1 ]]; then
    printf '%s\n' "${current_value}"
    return
  fi

  while true; do
    if [[ -n "${current_value}" ]]; then
      read -r -p "${label} [${current_value}]: " input
      input="${input:-$current_value}"
    else
      read -r -p "${label}: " input
    fi

    if [[ -n "${input}" ]]; then
      printf '%s\n' "${input}"
      return
    fi

    if [[ -n "${allow_empty_choice_label}" ]]; then
      if prompt_yes_no "${allow_empty_choice_label}" "n"; then
        printf '%s\n' ""
        return
      fi
    fi

    echo "这个值不能为空，请重新输入。"
  done
}

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' "apt"
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    printf '%s\n' "dnf"
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    printf '%s\n' "yum"
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    printf '%s\n' "pacman"
    return
  fi

  printf '%s\n' "unknown"
}

install_system_packages() {
  local package_manager="$1"
  shift
  local packages=("$@")

  case "${package_manager}" in
    apt)
      sudo apt-get update
      sudo apt-get install -y "${packages[@]}"
      ;;
    dnf)
      sudo dnf install -y "${packages[@]}"
      ;;
    yum)
      sudo yum install -y "${packages[@]}"
      ;;
    pacman)
      sudo pacman -Sy --noconfirm --needed "${packages[@]}"
      ;;
    *)
      echo "当前系统包管理器不受支持，无法自动安装：${packages[*]}" >&2
      exit 1
      ;;
  esac
}

ensure_bubblewrap() {
  if command -v bwrap >/dev/null 2>&1 && command -v bubblewrap >/dev/null 2>&1; then
    return
  fi

  local package_manager
  package_manager="$(detect_package_manager)"

  if ! command -v bwrap >/dev/null 2>&1 && ! command -v bubblewrap >/dev/null 2>&1; then
    echo "未检测到 bubblewrap/bwrap。Codex 的默认沙箱和部分 ACP 运行模式需要它。"
    if [[ "${package_manager}" == "unknown" ]]; then
      echo "当前系统包管理器不受支持，请按发行版文档手动安装 bubblewrap；安装器将继续。" >&2
      return
    fi

    if ! prompt_yes_no "是否现在安装系统包 bubblewrap？" "y"; then
      echo "跳过 bubblewrap 安装。admin 如果启用 danger-full-access 可继续；family ACP 可能无法使用默认沙箱。" >&2
      return
    fi

    install_system_packages "${package_manager}" bubblewrap
  fi

  if command -v bwrap >/dev/null 2>&1 && ! command -v bubblewrap >/dev/null 2>&1; then
    sudo install -d -m 755 /usr/local/bin
    sudo ln -sfn "$(command -v bwrap)" /usr/local/bin/bubblewrap
    echo "已创建兼容命令：/usr/local/bin/bubblewrap -> $(command -v bwrap)"
  fi

  if command -v bubblewrap >/dev/null 2>&1 && ! command -v bwrap >/dev/null 2>&1; then
    sudo install -d -m 755 /usr/local/bin
    sudo ln -sfn "$(command -v bubblewrap)" /usr/local/bin/bwrap
    echo "已创建兼容命令：/usr/local/bin/bwrap -> $(command -v bubblewrap)"
  fi
}

ensure_command_with_prompt() {
  local command_name="$1"
  local package_manager="$2"
  shift 2
  local packages=("$@")

  if command -v "${command_name}" >/dev/null 2>&1; then
    return
  fi

  echo "未检测到命令：${command_name}"
  if ! prompt_yes_no "是否现在用系统包管理器安装 ${command_name}？" "y"; then
    echo "缺少必要命令：${command_name}" >&2
    exit 1
  fi

  install_system_packages "${package_manager}" "${packages[@]}"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "安装后仍未找到命令：${command_name}" >&2
    exit 1
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "缺少必要命令：${command_name}" >&2
    exit 1
  fi
}

require_non_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    echo "请用普通登录用户运行安装器，不要在命令前加 sudo。" >&2
    echo "安装器会在需要写入 /opt、/var/lib、/etc/systemd/system 时单独调用 sudo。" >&2
    exit 1
  fi
}

ensure_node_runtime() {
  if command -v node >/dev/null 2>&1; then
    if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);'; then
      return
    fi
  fi

  echo "未检测到可用的 Node.js >= 22.5.0。"
  if ! prompt_yes_no "是否现在安装系统级 Node.js 22 LTS？" "y"; then
    echo "需要 Node.js >= 22.5.0，因为项目使用 node:sqlite。" >&2
    exit 1
  fi

  local package_manager
  package_manager="$(detect_package_manager)"

  case "${package_manager}" in
    apt)
      install_system_packages "${package_manager}" ca-certificates curl gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      install_system_packages "${package_manager}" nodejs
      ;;
    dnf|yum)
      install_system_packages "${package_manager}" ca-certificates curl
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      install_system_packages "${package_manager}" nodejs
      ;;
    pacman)
      install_system_packages "${package_manager}" nodejs npm
      ;;
    *)
      echo "当前系统包管理器不受支持，无法自动安装 Node.js。请手动安装 Node.js 22 LTS 后重试。" >&2
      exit 1
      ;;
  esac

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 安装后仍不可用。" >&2
    exit 1
  fi

  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);'; then
    echo "安装后的 Node.js 版本仍低于 22.5.0：$(node -v)" >&2
    exit 1
  fi
}

ensure_codex_cli() {
  local failed=0
  if ! command_is_available "${ADMIN_COMMAND}"; then
    echo "admin Codex 命令不可用：${ADMIN_COMMAND}" >&2
    failed=1
  fi
  if ! command_is_available "${FAMILY_COMMAND}"; then
    echo "family Codex 命令不可用：${FAMILY_COMMAND}" >&2
    failed=1
  fi
  if [[ "${failed}" -ne 0 ]]; then
    echo "默认应使用项目隔离命令：$(project_codex_command)" >&2
    exit 1
  fi
}

validate_choice() {
  local value="$1"
  shift
  local allowed
  for allowed in "$@"; do
    if [[ "${value}" == "${allowed}" ]]; then
      return
    fi
  done

  echo "无效取值：${value}" >&2
  exit 1
}

validate_model_reasoning_effort() {
  local model="$1"
  local effort="$2"
  local allowed=""

  case "${model}" in
    gpt-5.6-sol|gpt-5.6-terra)
      allowed="low medium high xhigh max ultra"
      ;;
    gpt-5.6-luna)
      allowed="low medium high xhigh max"
      ;;
    gpt-5.5|gpt-5.4|gpt-5.4-mini|gpt-5.2|codex-auto-review)
      allowed="low medium high xhigh"
      ;;
    *)
      return
      ;;
  esac

  if [[ " ${allowed} " != *" ${effort} "* ]]; then
    echo "模型 ${model} 不支持思考强度 ${effort}；可选：${allowed// /|}" >&2
    exit 1
  fi
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -y|--yes)
        YES=1
        shift
        ;;
      --app-dir)
        APP_DIR="$2"
        shift 2
        ;;
      --data-dir)
        DATA_DIR="$2"
        shift 2
        ;;
      --port)
        PORT="$2"
        shift 2
        ;;
      --timezone)
        TIMEZONE="$2"
        shift 2
        ;;
      --codex-auth-mode)
        CODEX_CLI_AUTH_MODE="$2"
        shift 2
        ;;
      --codex-base-url)
        CODEX_CLI_BASE_URL="$2"
        shift 2
        ;;
      --codex-api-key)
        CODEX_CLI_API_KEY="$2"
        shift 2
        ;;
      --codex-model)
        CODEX_CLI_MODEL="$2"
        shift 2
        ;;
      --codex-review-model)
        CODEX_CLI_REVIEW_MODEL="$2"
        shift 2
        ;;
      --codex-reasoning-effort)
        CODEX_CLI_REASONING_EFFORT="$2"
        shift 2
        ;;
      --family-permission-review-enabled)
        CODEX_FAMILY_PERMISSION_REVIEW_ENABLED="$2"
        shift 2
        ;;
      --family-permission-review-model)
        CODEX_FAMILY_PERMISSION_REVIEW_MODEL="$2"
        shift 2
        ;;
      --user-mode)
        USER_MODE="$2"
        shift 2
        ;;
      --service-user)
        SERVICE_USER="$2"
        USER_MODE="dedicated"
        shift 2
        ;;
      --permission-mode)
        PERMISSION_MODE="$2"
        shift 2
        ;;
      --admin-command)
        ADMIN_COMMAND="$2"
        shift 2
        ;;
      --family-command)
        FAMILY_COMMAND="$2"
        shift 2
        ;;
      --login-role)
        LOGIN_ROLE="$2"
        shift 2
        ;;
      --skip-login)
        SKIP_LOGIN=1
        shift
        ;;
      --force-login)
        FORCE_LOGIN=1
        shift
        ;;
      --no-start)
        NO_START=1
        shift
        ;;
      --app-dir-created)
        APP_DIR_MARKED_CREATED=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "未知选项：$1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

require_node_version() {
  ensure_node_runtime
}

resolve_codex_command() {
  resolve_existing_codex_command || printf '%s\n' "$(service_user_pnpm_home)/codex"
}

command_is_available() {
  local command_name="$1"

  if [[ -z "${command_name}" ]]; then
    return 1
  fi

  if [[ "${command_name}" == */* ]]; then
    [[ -x "${command_name}" ]]
    return
  fi

  command -v "${command_name}" >/dev/null 2>&1
}

state_app_file() {
  printf '%s\n' "${APP_DIR}/${STATE_FILE_NAME}"
}

state_data_file() {
  printf '%s\n' "${DATA_DIR}/install-state.env"
}

load_previous_state_flags() {
  local state_file
  state_file="$(state_app_file)"
  if [[ ! -f "${state_file}" ]]; then
    state_file="$(state_data_file)"
  fi

  if [[ ! -f "${state_file}" ]]; then
    return
  fi

  # shellcheck disable=SC1090
  source "${state_file}"

  if [[ "${INSTALL_APP_DIR:-}" == "${APP_DIR}" ]]; then
    APP_DIR_CREATED_BY_INSTALLER="${INSTALL_APP_DIR_CREATED_BY_INSTALLER:-${APP_DIR_CREATED_BY_INSTALLER}}"
  fi

  if [[ "${INSTALL_DATA_DIR:-}" == "${DATA_DIR}" ]]; then
    DATA_DIR_CREATED_BY_INSTALLER="${INSTALL_DATA_DIR_CREATED_BY_INSTALLER:-${DATA_DIR_CREATED_BY_INSTALLER}}"
  fi

  if [[ "${INSTALL_SERVICE_USER:-}" == "${SERVICE_USER}" ]]; then
    SERVICE_USER_CREATED_BY_INSTALLER="${INSTALL_SERVICE_USER_CREATED_BY_INSTALLER:-${SERVICE_USER_CREATED_BY_INSTALLER}}"
  fi

  if [[ "${INSTALL_SERVICE_GROUP:-}" == "${SERVICE_GROUP}" ]]; then
    SERVICE_GROUP_CREATED_BY_INSTALLER="${INSTALL_SERVICE_GROUP_CREATED_BY_INSTALLER:-${SERVICE_GROUP_CREATED_BY_INSTALLER}}"
  fi
}

capture_preinstall_state() {
  load_previous_state_flags

  if [[ "${APP_DIR_MARKED_CREATED}" -eq 1 || ! -e "${APP_DIR}" ]]; then
    APP_DIR_CREATED_BY_INSTALLER=1
  fi

  if [[ ! -e "${DATA_DIR}" ]]; then
    DATA_DIR_CREATED_BY_INSTALLER=1
  fi
}

validate_app_dir_target() {
  if [[ "${APP_DIR}" == "${REPO_DIR}" ]]; then
    return
  fi

  if [[ "${APP_DIR_MARKED_CREATED}" -eq 1 || -f "$(state_app_file)" ]]; then
    return
  fi

  if [[ -e "${APP_DIR}" ]]; then
    echo "应用目录已存在，且没有本项目安装清单：${APP_DIR}" >&2
    echo "为避免覆盖用户已有目录后无法完整恢复，安装器不会接管它。" >&2
    echo "请换一个 --app-dir，或先手动移走该目录。" >&2
    exit 1
  fi
}

prepare_package_manager() {
  export COREPACK_HOME="${COREPACK_HOME:-$(service_user_corepack_home)}"
  export PNPM_HOME="${PNPM_HOME:-$(service_user_pnpm_home)}"
  export PATH="${PNPM_HOME}:${PATH}"

  mkdir -p "${COREPACK_HOME}" "${PNPM_HOME}"

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    PNPM_CMD=(corepack pnpm)
    return
  fi

  if command -v npm >/dev/null 2>&1; then
    PNPM_CMD=(npm exec --yes "pnpm@${PNPM_VERSION}" --)
    return
  fi

  echo "缺少 pnpm/corepack/npm。请安装带 Corepack 的 Node.js 后重试。" >&2
  exit 1
}

run_pnpm() {
  "${PNPM_CMD[@]}" "$@"
}

configure_interactively() {
  APP_DIR="$(prompt_default "应用目录" "${APP_DIR}")"
  DATA_DIR="$(prompt_default "数据目录" "${DATA_DIR}")"
  PORT="$(prompt_default "服务端口" "${PORT}")"
  TIMEZONE="$(prompt_default "业务时区" "${TIMEZONE}")"
  CODEX_CLI_AUTH_MODE="$(prompt_default "Codex 认证方式(第三方 API key/login)" "${CODEX_CLI_AUTH_MODE}")"

  validate_choice "${CODEX_CLI_AUTH_MODE}" api_key login

  if [[ "${CODEX_CLI_AUTH_MODE}" == "api_key" ]]; then
    if [[ "${YES}" -eq 1 && ( -z "${CODEX_CLI_BASE_URL}" || -z "${CODEX_CLI_API_KEY}" ) ]]; then
      CODEX_CLI_AUTH_MODE="login"
    else
    CODEX_CLI_BASE_URL="$(
      prompt_required \
        "第三方兼容 API Base URL" \
        "${CODEX_CLI_BASE_URL}" \
        "不填 Base URL，是否改用 login 模式？"
    )"
    if [[ -z "${CODEX_CLI_BASE_URL}" ]]; then
      CODEX_CLI_AUTH_MODE="login"
    else
      CODEX_CLI_API_KEY="$(
        prompt_required \
          "第三方兼容 API Key" \
          "${CODEX_CLI_API_KEY}" \
          "不填 API Key，是否改用 login 模式？"
      )"
      if [[ -z "${CODEX_CLI_API_KEY}" ]]; then
        CODEX_CLI_AUTH_MODE="login"
      fi
    fi
    fi
  fi
  CODEX_CLI_MODEL="$(prompt_default "Codex 对话模型" "${CODEX_CLI_MODEL}")"
  CODEX_CLI_REVIEW_MODEL="$(prompt_default "Codex 压缩/回顾模型" "${CODEX_CLI_REVIEW_MODEL}")"
  CODEX_CLI_REASONING_EFFORT="$(prompt_default "Codex 思考强度(none/minimal/low/medium/high/xhigh/max/ultra)" "${CODEX_CLI_REASONING_EFFORT}")"
  CODEX_FAMILY_PERMISSION_REVIEW_ENABLED="$(prompt_default "family 小模型权限审核(true/false)" "${CODEX_FAMILY_PERMISSION_REVIEW_ENABLED}")"
  CODEX_FAMILY_PERMISSION_REVIEW_MODEL="$(prompt_default "family 小模型权限审核模型" "${CODEX_FAMILY_PERMISSION_REVIEW_MODEL}")"

  if [[ "${YES}" -eq 0 ]]; then
    echo ""
    echo "服务用户模式："
    echo "  1) current   - 使用当前登录用户运行服务，推荐给 admin Codex"
    echo "  2) dedicated - 创建或复用专用服务用户"
    local service_user_mode
    read -r -p "请选择服务用户模式 [1]: " service_user_mode
    if [[ "${service_user_mode:-1}" == "2" ]]; then
      USER_MODE="dedicated"
    else
      USER_MODE="current"
    fi
  fi

  if [[ "${USER_MODE}" == "dedicated" ]]; then
    SERVICE_USER="$(prompt_default "专用服务用户" "${SERVICE_USER:-weixin-agent}")"
    SERVICE_GROUP="${SERVICE_USER}"
  else
    SERVICE_USER="$(id -un)"
    SERVICE_GROUP="$(id -gn)"
  fi

  if [[ "${YES}" -eq 0 ]]; then
    echo ""
    echo "服务用户 sudo 策略："
    echo "  1) none    - 不给服务用户额外 sudo 权限"
    echo "  2) limited - 仅允许 systemctl/journalctl/docker/apt"
    echo "  3) full    - NOPASSWD 全 sudo，仅建议你自己的 admin 环境"
    local choice
    read -r -p "请选择 sudo 策略 [3]: " choice
    case "${choice:-3}" in
      1) PERMISSION_MODE="none" ;;
      2) PERMISSION_MODE="limited" ;;
      3) PERMISSION_MODE="full" ;;
      *) PERMISSION_MODE="full" ;;
    esac
  fi

  ADMIN_COMMAND="$(prompt_default "admin Codex 命令" "${ADMIN_COMMAND:-$(resolve_configurable_codex_command)}")"
  FAMILY_COMMAND="$(prompt_default "family Codex 命令" "${FAMILY_COMMAND:-${ADMIN_COMMAND}}")"
  LOGIN_ROLE="$(prompt_default "首次扫码绑定角色" "${LOGIN_ROLE}")"

  validate_choice "${USER_MODE}" current dedicated
  validate_choice "${PERMISSION_MODE}" none limited full
  validate_choice "${LOGIN_ROLE}" admin family
  validate_choice "${CODEX_CLI_REASONING_EFFORT}" none minimal low medium high xhigh max ultra
  validate_model_reasoning_effort "${CODEX_CLI_MODEL}" "${CODEX_CLI_REASONING_EFFORT}"
}

stop_existing_service() {
  if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
    SERVICE_WAS_ACTIVE=1
    echo "停止现有服务，准备安全更新依赖和构建产物：${SERVICE_NAME}"
    sudo systemctl stop "${SERVICE_NAME}"
  fi
}

ensure_service_user() {
  if [[ "${USER_MODE}" == "current" ]]; then
    SERVICE_USER="$(id -un)"
    SERVICE_GROUP="$(id -gn)"
    mkdir -p "$(service_user_pnpm_home)" "$(service_user_corepack_home)"
    return
  fi

  SERVICE_GROUP="${SERVICE_USER}"

  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    echo "创建服务用户组：${SERVICE_GROUP}"
    sudo groupadd --system "${SERVICE_GROUP}"
    SERVICE_GROUP_CREATED_BY_INSTALLER=1
  fi

  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    echo "创建服务用户：${SERVICE_USER}"
    sudo useradd -m -s /bin/bash -g "${SERVICE_GROUP}" "${SERVICE_USER}"
    SERVICE_USER_CREATED_BY_INSTALLER=1
  fi

  sudo -u "${SERVICE_USER}" -H mkdir -p "$(service_user_pnpm_home)" "$(service_user_corepack_home)"
}

prepare_system_backups() {
  local backup_dir="${DATA_DIR}/backups"
  local stamp
  stamp="$(date +%Y%m%d%H%M%S)"

  sudo mkdir -p "${backup_dir}"

  if [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    SERVICE_FILE_BACKUP="${backup_dir}/${SERVICE_NAME}.service.${stamp}.bak"
    sudo cp -a "/etc/systemd/system/${SERVICE_NAME}.service" "${SERVICE_FILE_BACKUP}"
  else
    SERVICE_FILE_CREATED_BY_INSTALLER=1
  fi

  if [[ -f "/etc/sudoers.d/${SERVICE_NAME}" ]]; then
    SUDOERS_FILE_BACKUP="${backup_dir}/${SERVICE_NAME}.sudoers.${stamp}.bak"
    sudo cp -a "/etc/sudoers.d/${SERVICE_NAME}" "${SUDOERS_FILE_BACKUP}"
  elif [[ "${PERMISSION_MODE}" != "none" ]]; then
    SUDOERS_CREATED_BY_INSTALLER=1
  fi
}

build_env_pairs() {
  local admin_workspace="${DATA_DIR}/runtime/admin"
  local family_workspace="${DATA_DIR}/runtime/family"
  local codex_home
  local codex_provider="OpenAI"
  local codex_provider_name="OpenAI"
  local admin_args="exec --skip-git-repo-check"
  local admin_acp_args=""

  codex_home="$(service_user_home)/.codex"

  if [[ -n "${CODEX_CLI_BASE_URL}" ]]; then
    codex_provider="openai_compat"
    codex_provider_name="OpenAI-compatible"
  fi

  if [[ "${PERMISSION_MODE}" != "none" ]]; then
    admin_args="exec --skip-git-repo-check -s danger-full-access"
    admin_acp_args='-c sandbox_mode=\"danger-full-access\"'
  fi

  cat <<EOF
PORT=${PORT}
TIMEZONE=${TIMEZONE}
DATA_DIR=${DATA_DIR}

WECHAT_API_BASE_URL=https://ilinkai.weixin.qq.com
WECHAT_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
WECHAT_CHANNEL_VERSION=weixin-household-gateway-0.1.0
WECHAT_ROUTE_TAG=
WECHAT_TYPING_REFRESH_MS=7000
WECHAT_THINKING_NOTICE_MS=30000
WECHAT_TURN_MESSAGE_LIMIT=10

SESSION_ADMIN_AUTO_ROTATE_ENABLED=false
SESSION_FAMILY_AUTO_ROTATE_ENABLED=true
SESSION_FAMILY_HOT_IDLE_MINUTES=90

CODEX_ADMIN_COMMAND=${ADMIN_COMMAND}
CODEX_ADMIN_ARGS=${admin_args}
CODEX_ADMIN_BACKEND=acp
CODEX_ADMIN_ACP_COMMAND=
CODEX_ADMIN_ACP_ARGS=${admin_acp_args}
CODEX_ADMIN_ACP_AUTH_MODE=auto
CODEX_ADMIN_HOME=${codex_home}
CODEX_ADMIN_MODE=full-auto
CODEX_ADMIN_WORKSPACE=${admin_workspace}
CODEX_ADMIN_ENV_MODE=inherit
CODEX_ADMIN_ENV_PASSTHROUGH=

CODEX_FAMILY_COMMAND=${FAMILY_COMMAND}
CODEX_FAMILY_ARGS=exec --skip-git-repo-check
CODEX_FAMILY_BACKEND=acp
CODEX_FAMILY_ACP_COMMAND=
CODEX_FAMILY_ACP_ARGS=
CODEX_FAMILY_ACP_AUTH_MODE=auto
CODEX_FAMILY_HOME=${codex_home}
CODEX_FAMILY_MODE=suggest
CODEX_FAMILY_WORKSPACE=${family_workspace}
CODEX_FAMILY_ENV_MODE=minimal
CODEX_FAMILY_ENV_PASSTHROUGH=
CODEX_FAMILY_PERMISSION_REVIEW_ENABLED=${CODEX_FAMILY_PERMISSION_REVIEW_ENABLED}
CODEX_FAMILY_PERMISSION_REVIEW_MODEL=${CODEX_FAMILY_PERMISSION_REVIEW_MODEL}
CODEX_FAMILY_PERMISSION_REVIEW_TIMEOUT_MS=8000

CODEX_TIMEOUT_MS=180000

CODEX_CLI_AUTH_MODE=${CODEX_CLI_AUTH_MODE}
CODEX_CLI_HOME=${codex_home}
CODEX_CLI_PROVIDER=${codex_provider}
CODEX_CLI_PROVIDER_NAME=${codex_provider_name}
CODEX_CLI_BASE_URL=${CODEX_CLI_BASE_URL}
CODEX_CLI_API_KEY=${CODEX_CLI_API_KEY}
CODEX_CLI_WIRE_API=responses
CODEX_CLI_MODEL=${CODEX_CLI_MODEL}
CODEX_CLI_REVIEW_MODEL=${CODEX_CLI_REVIEW_MODEL}
CODEX_CLI_REASONING_EFFORT=${CODEX_CLI_REASONING_EFFORT}
CODEX_CLI_DISABLE_RESPONSE_STORAGE=true
CODEX_CLI_NETWORK_ACCESS=enabled
CODEX_CLI_CONTEXT_WINDOW=272000
CODEX_CLI_AUTO_COMPACT_TOKEN_LIMIT=240000

CODEX_API_BASE_URL=
CODEX_API_KEY=
CODEX_API_MODEL=${CODEX_CLI_MODEL}
CODEX_API_TIMEOUT_MS=180000

FAMILY_STRIP_REASONING=true
FAMILY_STRIP_COMMANDS=true
FAMILY_STRIP_PATHS=true
ALLOW_FILE_SEND=true
FILE_SEND_ALLOWED_DIRS=${DATA_DIR}/outbox:${DATA_DIR}/inbox:${DATA_DIR}/office:/tmp
FILE_SEND_MAX_BYTES=52428800
EOF
}

write_env_file() {
  local target_file="$1"
  build_env_pairs > "${target_file}"
}

write_systemd_service() {
  local service_file="$1"

  cat > "${service_file}" <<EOF
[Unit]
Description=${SERVICE_NAME}
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/env node dist/apps/server/index.js
Restart=always
RestartSec=5
User=${SERVICE_USER}
Group=${SERVICE_GROUP}

[Install]
WantedBy=multi-user.target
EOF
}

write_sudoers() {
  local sudoers_file="/etc/sudoers.d/${SERVICE_NAME}"

  sudo rm -f "${sudoers_file}"

  case "${PERMISSION_MODE}" in
    none)
      return
      ;;
    limited)
      sudo tee "${sudoers_file}" >/dev/null <<EOF
Defaults:${SERVICE_USER} !requiretty
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl, /usr/bin/docker, /usr/bin/apt, /usr/bin/apt-get
EOF
      ;;
    full)
      sudo tee "${sudoers_file}" >/dev/null <<EOF
Defaults:${SERVICE_USER} !requiretty
${SERVICE_USER} ALL=(ALL) NOPASSWD: ALL
EOF
      ;;
  esac

  sudo chmod 440 "${sudoers_file}"
}

sync_app_dir() {
  sudo mkdir -p "${APP_DIR}" "${DATA_DIR}" "${DATA_DIR}/runtime/admin" "${DATA_DIR}/runtime/family" "${DATA_DIR}/inbox" "${DATA_DIR}/outbox" "${DATA_DIR}/office"
  sudo rm -f "${LEGACY_TMP_ENV}" "${LEGACY_TMP_SERVICE}"
  sudo rm -f "/tmp/${SERVICE_NAME}.env."* "/tmp/${SERVICE_NAME}.service."* 2>/dev/null || true

  if [[ "${APP_DIR}" != "${REPO_DIR}" ]]; then
    require_command rsync
    sudo rsync -a --delete \
      --exclude ".git" \
      --exclude "node_modules" \
      --exclude "dist" \
      --exclude "data" \
      "${REPO_DIR}/" "${APP_DIR}/"
    sudo chown -R "$(id -un):$(id -gn)" "${APP_DIR}"
  fi

  sudo chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DATA_DIR}"
}

install_env_and_service() {
  TMP_ENV_FILE="$(mktemp "/tmp/${SERVICE_NAME}.env.XXXXXX")"
  TMP_SERVICE_FILE="$(mktemp "/tmp/${SERVICE_NAME}.service.XXXXXX")"

  write_env_file "${TMP_ENV_FILE}"
  sudo install -m 640 -o root -g "${SERVICE_GROUP}" "${TMP_ENV_FILE}" "${APP_DIR}/.env"

  write_sudoers
  write_systemd_service "${TMP_SERVICE_FILE}"
  sudo install -m 644 -o root -g root "${TMP_SERVICE_FILE}" "/etc/systemd/system/${SERVICE_NAME}.service"
}

build_project() {
  pushd "${APP_DIR}" >/dev/null
  prepare_package_manager

  if [[ "${SERVICE_USER}" == "$(id -un)" ]]; then
    if ! CI=1 run_pnpm install --frozen-lockfile; then
      CI=1 run_pnpm install
    fi
    run_pnpm build
  else
    local user_home
    local user_pnpm_home
    local user_corepack_home
    user_home="$(service_user_home)"
    user_pnpm_home="$(service_user_pnpm_home)"
    user_corepack_home="$(service_user_corepack_home)"

    if ! sudo -u "${SERVICE_USER}" -H env \
      HOME="${user_home}" \
      COREPACK_HOME="${user_corepack_home}" \
      PNPM_HOME="${user_pnpm_home}" \
      PATH="${user_pnpm_home}:${PATH}" \
      bash -lc "cd \"${APP_DIR}\" && CI=1 pnpm install --frozen-lockfile"; then
      sudo -u "${SERVICE_USER}" -H env \
        HOME="${user_home}" \
        COREPACK_HOME="${user_corepack_home}" \
        PNPM_HOME="${user_pnpm_home}" \
        PATH="${user_pnpm_home}:${PATH}" \
        bash -lc "cd \"${APP_DIR}\" && CI=1 pnpm install"
    fi
    sudo -u "${SERVICE_USER}" -H env \
      HOME="${user_home}" \
      COREPACK_HOME="${user_corepack_home}" \
      PNPM_HOME="${user_pnpm_home}" \
      PATH="${user_pnpm_home}:${PATH}" \
      bash -lc "cd \"${APP_DIR}\" && pnpm build"
  fi
  popd >/dev/null
}

run_node_as_service_user() {
  local script_path="$1"
  shift

  local -a env_args=()
  while IFS='=' read -r key value; do
    [[ -z "${key}" || "${key}" == \#* ]] && continue
    env_args+=("${key}=${value}")
  done < <(build_env_pairs)

  if [[ "${script_path}" == "-e" ]]; then
    local snippet="$1"
    shift
    if [[ "${SERVICE_USER}" == "$(id -un)" ]]; then
      env "${env_args[@]}" node -e "${snippet}" "$@"
    else
      sudo -u "${SERVICE_USER}" -H env "${env_args[@]}" node -e "${snippet}" "$@"
    fi
    return
  fi

  if [[ "${SERVICE_USER}" == "$(id -un)" ]]; then
    env "${env_args[@]}" node "${script_path}" "$@"
  else
    sudo -u "${SERVICE_USER}" -H env "${env_args[@]}" node "${script_path}" "$@"
  fi
}

has_saved_accounts() {
  local db_file="${DATA_DIR}/weixin-household-gateway.sqlite"

  if [[ ! -f "${db_file}" ]]; then
    return 1
  fi

  run_node_as_service_user -e '
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

run_login_if_needed() {
  if [[ "${SKIP_LOGIN}" -eq 1 ]]; then
    echo "按要求跳过扫码登录。"
    return
  fi

  if [[ "${FORCE_LOGIN}" -eq 0 ]] && has_saved_accounts; then
    echo "已发现微信账号记录，跳过扫码登录。"
    return
  fi

  local setup_args=("${LOGIN_ROLE}")
  if [[ "${FORCE_LOGIN}" -eq 1 ]]; then
    setup_args+=("--force")
  fi

  echo ""
  echo "开始终端扫码登录，绑定角色：${LOGIN_ROLE}"
  echo "请用微信扫码并在手机上确认；确认后安装器会继续运行。"
  echo ""

  pushd "${APP_DIR}" >/dev/null
  run_node_as_service_user "dist/apps/server/setup.js" "${setup_args[@]}"
  popd >/dev/null
}

start_service() {
  sudo chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DATA_DIR}"
  sudo chmod -R a+rX "${APP_DIR}"
  # Keep the shared app tree readable, but don't reopen the secret env file.
  if [[ -f "${APP_DIR}/.env" ]]; then
    sudo chmod 640 "${APP_DIR}/.env"
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable "${SERVICE_NAME}"

  if [[ "${NO_START}" -eq 1 ]]; then
    echo "已安装 systemd 服务，但因 --no-start 未启动。"
    return
  fi

  sudo systemctl restart "${SERVICE_NAME}"
}

run_post_install_doctor() {
  if [[ "${NO_START}" -eq 1 ]]; then
    return
  fi

  echo ""
  echo "运行安装后自检..."
  sleep 2
  pushd "${APP_DIR}" >/dev/null
  if ! run_node_as_service_user "dist/apps/server/doctor.js"; then
    echo ""
    echo "自检发现问题。请查看："
    echo "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    echo "  cd ${APP_DIR} && node dist/apps/server/doctor.js --json"
  fi
  popd >/dev/null
}

write_install_state_file() {
  local target_file="$1"
  local tmp_file
  tmp_file="$(mktemp "/tmp/${SERVICE_NAME}.state.XXXXXX")"

  {
    printf 'INSTALL_STATE_VERSION=%q\n' "1"
    printf 'INSTALL_SERVICE_NAME=%q\n' "${SERVICE_NAME}"
    printf 'INSTALL_APP_DIR=%q\n' "${APP_DIR}"
    printf 'INSTALL_DATA_DIR=%q\n' "${DATA_DIR}"
    printf 'INSTALL_SERVICE_USER=%q\n' "${SERVICE_USER}"
    printf 'INSTALL_SERVICE_GROUP=%q\n' "${SERVICE_GROUP}"
    printf 'INSTALL_USER_MODE=%q\n' "${USER_MODE}"
    printf 'INSTALL_PERMISSION_MODE=%q\n' "${PERMISSION_MODE}"
    printf 'INSTALL_APP_DIR_CREATED_BY_INSTALLER=%q\n' "${APP_DIR_CREATED_BY_INSTALLER}"
    printf 'INSTALL_DATA_DIR_CREATED_BY_INSTALLER=%q\n' "${DATA_DIR_CREATED_BY_INSTALLER}"
    printf 'INSTALL_SERVICE_USER_CREATED_BY_INSTALLER=%q\n' "${SERVICE_USER_CREATED_BY_INSTALLER}"
    printf 'INSTALL_SERVICE_GROUP_CREATED_BY_INSTALLER=%q\n' "${SERVICE_GROUP_CREATED_BY_INSTALLER}"
    printf 'INSTALL_SERVICE_FILE_CREATED_BY_INSTALLER=%q\n' "${SERVICE_FILE_CREATED_BY_INSTALLER}"
    printf 'INSTALL_SUDOERS_CREATED_BY_INSTALLER=%q\n' "${SUDOERS_CREATED_BY_INSTALLER}"
    printf 'INSTALL_SERVICE_FILE_BACKUP=%q\n' "${SERVICE_FILE_BACKUP}"
    printf 'INSTALL_SUDOERS_FILE_BACKUP=%q\n' "${SUDOERS_FILE_BACKUP}"
    printf 'INSTALL_CREATED_AT=%q\n' "$(date -Is)"
  } > "${tmp_file}"

  sudo install -m 644 -o root -g root "${tmp_file}" "${target_file}"
  rm -f "${tmp_file}"
}

write_install_state() {
  write_install_state_file "$(state_app_file)"
  write_install_state_file "$(state_data_file)"
}

print_permission_summary() {
  echo ""
  echo "权限说明："
  echo "  - 请用普通登录用户运行安装器，不要 sudo bash install.sh。"
  echo "  - 安装器只在必要步骤调用 sudo：创建/写入应用目录、数据目录、systemd 服务、可选 sudoers、启动服务。"
  echo "  - 如果应用目录在 /opt 下，安装器会用 sudo 创建 ${APP_DIR}，并只把这个项目目录归属给当前用户，方便 git pull、pnpm install 和构建；不会修改 /opt 本身。"
  echo "  - 数据目录会归属给服务用户 ${SERVICE_USER}:${SERVICE_GROUP}，因为运行中的服务需要写 SQLite、二维码和附件缓存。"
  echo "  - 卸载时会读取安装清单；自己创建的目录/用户会删除，覆盖前备份过的 systemd/sudoers 会恢复。"
}

print_codex_setup_help() {
  local codex_command
  codex_command="$(resolve_codex_command)"
  echo ""
  echo "还需要为服务用户准备 Codex CLI 和认证："
  echo "  1. 确保当前服务用户能直接运行 ${codex_command}"
  echo "  2. 推荐在 .env 中配置第三方 API key，再运行：node dist/apps/server/configure-codex.js --apply"
  echo "  3. 可选：如果不用 API key，也可以用这个真实用户执行：${codex_command} login"
  echo "  4. 再执行：${codex_command} exec --skip-git-repo-check \"请用一句话回复：Codex 已接通\""
  echo "  5. 最后运行：node dist/apps/server/doctor.js --acp-session"
}

configure_codex_cli() {
  pushd "${APP_DIR}" >/dev/null
  local codex_command
  codex_command="$(resolve_codex_command)"
  if [[ "${CODEX_CLI_AUTH_MODE}" == "api_key" ]]; then
    if [[ -z "${CODEX_CLI_BASE_URL}" || -z "${CODEX_CLI_API_KEY}" ]]; then
      echo "api_key 模式缺少完整的 CODEX_CLI_BASE_URL / CODEX_CLI_API_KEY，自动切回 login 模式。"
      CODEX_CLI_AUTH_MODE="login"
      popd >/dev/null
      configure_codex_cli
      return
    fi
    run_node_as_service_user "dist/apps/server/configure-codex.js" --apply
  else
    echo ""
    echo "当前选择 login 模式。请在服务用户环境里执行："
    echo "  ${codex_command} login"
    echo "然后再继续使用 doctor 校验 ACP 链路。"
  fi
  popd >/dev/null
}

print_summary() {
  local codex_command
  local codex_home
  codex_command="$(resolve_codex_command)"
  codex_home="$(service_user_home)/.codex"
  echo ""
  echo "安装完成。"
  echo "安装清单："
  echo "  $(state_app_file)"
  echo "  $(state_data_file)"
  echo ""
  echo "关键路径："
  echo "  应用目录: ${APP_DIR}"
  echo "  数据目录: ${DATA_DIR}"
  echo "  Codex 命令: ${codex_command}"
  echo "  Codex 配置: ${codex_home}"
  echo ""
  echo "常用命令："
  echo "  sudo systemctl status ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -f"
  echo "  curl http://127.0.0.1:${PORT}/healthz"
  echo ""
  echo "之后添加家人账号："
  echo "  cd ${APP_DIR} && node dist/apps/server/setup.js family --force"
  echo ""
  echo "卸载并恢复环境："
  echo "  bash ${APP_DIR}/infra/scripts/linux/uninstall.sh --yes"
  echo "保留微信账号和会话数据："
  echo "  bash ${APP_DIR}/infra/scripts/linux/uninstall.sh --yes --keep-data"
}

main() {
  parse_args "$@"
  require_non_root
  local package_manager
  package_manager="$(detect_package_manager)"

  ensure_command_with_prompt bash "${package_manager}" bash
  ensure_command_with_prompt sudo "${package_manager}" sudo
  ensure_command_with_prompt git "${package_manager}" git
  require_node_version

  configure_interactively
  capture_preinstall_state
  validate_app_dir_target
  ensure_service_user

  echo "== ${SERVICE_NAME} 安装 =="
  echo "源码目录：${REPO_DIR}"
  echo "应用目录：${APP_DIR}"
  echo "数据目录：${DATA_DIR}"
  echo "服务用户：${SERVICE_USER}:${SERVICE_GROUP}"
  echo "服务用户 sudo 策略：${PERMISSION_MODE}"
  echo "Codex 认证模式：${CODEX_CLI_AUTH_MODE}"
  if [[ "${CODEX_CLI_AUTH_MODE}" == "api_key" ]]; then
    echo "Codex Base URL：${CODEX_CLI_BASE_URL:-"(未设置)"}"
  fi
  echo "Codex 对话模型：${CODEX_CLI_MODEL}"
  echo "Codex 压缩/回顾模型：${CODEX_CLI_REVIEW_MODEL}"
  echo "Codex 思考强度：${CODEX_CLI_REASONING_EFFORT}"
  echo "family 小模型权限审核：${CODEX_FAMILY_PERMISSION_REVIEW_ENABLED}"
  echo "family 小模型权限审核模型：${CODEX_FAMILY_PERMISSION_REVIEW_MODEL}"
  echo "端口：${PORT}"
  echo "时区：${TIMEZONE}"
  echo "首次扫码角色：${LOGIN_ROLE}"
  print_permission_summary
  echo ""

  if ! prompt_yes_no "继续安装？" "y"; then
    echo "安装已取消。"
    exit 0
  fi

  ensure_bubblewrap
  stop_existing_service
  sync_app_dir
  prepare_system_backups
  install_env_and_service
  build_project
  ensure_codex_cli
  configure_codex_cli
  run_login_if_needed
  start_service
  SERVICE_RESTARTED=1
  run_post_install_doctor
  write_install_state
  print_summary
}

main "$@"
