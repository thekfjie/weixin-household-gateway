#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="weixin-household-gateway"
DEFAULT_APP_DIR="/opt/weixin-household-gateway"
DEFAULT_DATA_DIR="/var/lib/weixin-household-gateway"
STATE_FILE_NAME=".install-state"
LEGACY_TMP_ENV="/tmp/${SERVICE_NAME}.env"
LEGACY_TMP_SERVICE="/tmp/${SERVICE_NAME}.service"

YES=0
APP_DIR="${DEFAULT_APP_DIR}"
DATA_DIR="${DEFAULT_DATA_DIR}"
SERVICE_USER="weixin-agent"
SERVICE_GROUP="weixin-agent"
KEEP_DATA=0
KEEP_USER=0
FORCE_REMOVE_USER=0
PURGE_ALL=0
STATE_FILE=""
APP_DIR_SET=0
DATA_DIR_SET=0
SERVICE_USER_SET=0
STATE_FOUND=0

INSTALL_APP_DIR_CREATED_BY_INSTALLER=0
INSTALL_DATA_DIR_CREATED_BY_INSTALLER=0
INSTALL_SERVICE_USER_CREATED_BY_INSTALLER=0
INSTALL_SERVICE_GROUP_CREATED_BY_INSTALLER=0
INSTALL_SERVICE_FILE_CREATED_BY_INSTALLER=0
INSTALL_SUDOERS_CREATED_BY_INSTALLER=0
INSTALL_SERVICE_FILE_BACKUP=""
INSTALL_SUDOERS_FILE_BACKUP=""

usage() {
  cat <<EOF
用法：bash infra/scripts/linux/uninstall.sh [选项]

默认会尽量恢复安装前环境：停用 systemd、删除本项目安装器创建的
应用目录/数据目录/服务用户，并恢复安装前备份的 service 或 sudoers。

选项：
  -y, --yes                 使用默认值，不进入确认问答
      --app-dir PATH        应用目录
      --data-dir PATH       数据目录
      --state-file PATH     指定安装清单文件
      --keep-data           保留数据目录、SQLite、二维码和附件缓存
      --service-user USER   无安装清单时指定服务用户
      --keep-user           保留服务用户
      --remove-user         即使保留数据，也强制删除安装器创建的服务用户
      --purge-all           明确强制删除 app/data 目录，即使安装前已存在
  -h, --help                显示帮助
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
    return
  fi

  read -r -p "${label} [${default_value}]: " input
  input="${input:-$default_value}"
  case "${input}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
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
        APP_DIR_SET=1
        shift 2
        ;;
      --data-dir)
        DATA_DIR="$2"
        DATA_DIR_SET=1
        shift 2
        ;;
      --state-file)
        STATE_FILE="$2"
        shift 2
        ;;
      --keep-data)
        KEEP_DATA=1
        shift
        ;;
      --service-user)
        SERVICE_USER="$2"
        SERVICE_USER_SET=1
        shift 2
        ;;
      --keep-user)
        KEEP_USER=1
        shift
        ;;
      --remove-user)
        FORCE_REMOVE_USER=1
        shift
        ;;
      --purge-all)
        PURGE_ALL=1
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

require_safe_path() {
  local label="$1"
  local target="$2"

  if [[ -z "${target}" || "${target}" == "/" ]]; then
    echo "拒绝删除不安全的 ${label}: ${target}" >&2
    exit 1
  fi
}

find_state_file() {
  if [[ -n "${STATE_FILE}" ]]; then
    return
  fi

  if [[ -f "${APP_DIR}/${STATE_FILE_NAME}" ]]; then
    STATE_FILE="${APP_DIR}/${STATE_FILE_NAME}"
    return
  fi

  if [[ -f "${DATA_DIR}/install-state.env" ]]; then
    STATE_FILE="${DATA_DIR}/install-state.env"
  fi
}

load_state() {
  find_state_file

  if [[ -z "${STATE_FILE}" || ! -f "${STATE_FILE}" ]]; then
    STATE_FOUND=0
    return
  fi

  # shellcheck disable=SC1090
  source "${STATE_FILE}"
  STATE_FOUND=1

  if [[ "${APP_DIR_SET}" -eq 0 ]]; then
    APP_DIR="${INSTALL_APP_DIR:-${APP_DIR}}"
  fi

  if [[ "${DATA_DIR_SET}" -eq 0 ]]; then
    DATA_DIR="${INSTALL_DATA_DIR:-${DATA_DIR}}"
  fi

  if [[ "${SERVICE_USER_SET}" -eq 0 ]]; then
    SERVICE_USER="${INSTALL_SERVICE_USER:-${SERVICE_USER}}"
    SERVICE_GROUP="${INSTALL_SERVICE_GROUP:-${SERVICE_GROUP}}"
  fi
}

remove_known_data_contents() {
  sudo rm -f "${DATA_DIR}/weixin-household-gateway.sqlite"*
  sudo rm -f "${DATA_DIR}/schema.sql"
  sudo rm -rf "${DATA_DIR}/qrcodes"
  sudo rm -rf "${DATA_DIR}/runtime"
}

restore_or_remove_systemd_service() {
  if [[ -n "${INSTALL_SERVICE_FILE_BACKUP}" && -f "${INSTALL_SERVICE_FILE_BACKUP}" ]]; then
    sudo cp -a "${INSTALL_SERVICE_FILE_BACKUP}" "/etc/systemd/system/${SERVICE_NAME}.service"
    echo "已恢复安装前的 systemd service：/etc/systemd/system/${SERVICE_NAME}.service"
    return
  fi

  sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  echo "已删除 systemd service：/etc/systemd/system/${SERVICE_NAME}.service"
}

restore_or_remove_sudoers() {
  if [[ -n "${INSTALL_SUDOERS_FILE_BACKUP}" && -f "${INSTALL_SUDOERS_FILE_BACKUP}" ]]; then
    sudo cp -a "${INSTALL_SUDOERS_FILE_BACKUP}" "/etc/sudoers.d/${SERVICE_NAME}"
    sudo chmod 440 "/etc/sudoers.d/${SERVICE_NAME}"
    echo "已恢复安装前的 sudoers：/etc/sudoers.d/${SERVICE_NAME}"
    return
  fi

  sudo rm -f "/etc/sudoers.d/${SERVICE_NAME}"
  echo "已删除 sudoers：/etc/sudoers.d/${SERVICE_NAME}"
}

remove_app_dir() {
  if [[ "${PURGE_ALL}" -eq 1 ]]; then
    sudo rm -rf "${APP_DIR}"
    echo "已强制删除应用目录：${APP_DIR}"
    return
  fi

  if [[ "${STATE_FOUND}" -eq 1 && "${INSTALL_APP_DIR_CREATED_BY_INSTALLER}" != "1" ]]; then
    echo "应用目录安装前已存在，保守起见不删除：${APP_DIR}"
    echo "如确认整个目录都不需要，可手动删除，或重跑卸载并加 --purge-all。"
    return
  fi

  sudo rm -rf "${APP_DIR}"
  echo "已删除应用目录：${APP_DIR}"
}

remove_or_keep_data_dir() {
  if [[ "${KEEP_DATA}" -eq 1 ]]; then
    echo "按要求保留数据目录：${DATA_DIR}"
    return
  fi

  if [[ "${PURGE_ALL}" -eq 1 ]]; then
    sudo rm -rf "${DATA_DIR}"
    echo "已强制删除数据目录：${DATA_DIR}"
    return
  fi

  if [[ "${STATE_FOUND}" -eq 1 && "${INSTALL_DATA_DIR_CREATED_BY_INSTALLER}" != "1" ]]; then
    remove_known_data_contents
    echo "数据目录安装前已存在，仅清理本项目已知数据文件，保留目录：${DATA_DIR}"
    echo "如确认整个目录都不需要，可重跑卸载并加 --purge-all。"
    return
  fi

  sudo rm -rf "${DATA_DIR}"
  echo "已删除数据目录：${DATA_DIR}"
}

should_remove_service_user() {
  if [[ "${KEEP_USER}" -eq 1 ]]; then
    return 1
  fi

  if [[ "${KEEP_DATA}" -eq 1 && "${FORCE_REMOVE_USER}" -eq 0 ]]; then
    return 1
  fi

  if [[ "${FORCE_REMOVE_USER}" -eq 1 ]]; then
    return 0
  fi

  [[ "${STATE_FOUND}" -eq 1 && "${INSTALL_SERVICE_USER_CREATED_BY_INSTALLER}" == "1" ]]
}

remove_service_user_if_needed() {
  if ! should_remove_service_user; then
    echo "保留服务用户：${SERVICE_USER}"
    return
  fi

  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    sudo userdel -r "${SERVICE_USER}" 2>/dev/null || sudo userdel "${SERVICE_USER}"
    echo "已删除安装器创建的服务用户：${SERVICE_USER}"
  fi

  if [[ "${STATE_FOUND}" -eq 1 && "${INSTALL_SERVICE_GROUP_CREATED_BY_INSTALLER}" == "1" ]]; then
    if getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
      sudo groupdel "${SERVICE_GROUP}" 2>/dev/null || true
      echo "已删除安装器创建的服务用户组：${SERVICE_GROUP}"
    fi
  fi
}

print_summary() {
  echo ""
  echo "卸载计划："
  echo "  service=${SERVICE_NAME}"
  echo "  app_dir=${APP_DIR}"
  echo "  data_dir=${DATA_DIR}"
  echo "  keep_data=${KEEP_DATA}"
  echo "  purge_all=${PURGE_ALL}"
  echo "  service_user=${SERVICE_USER}"
  if [[ "${STATE_FOUND}" -eq 1 ]]; then
    echo "  install_state=${STATE_FILE}"
  else
    echo "  install_state=未找到，进入保守卸载模式"
  fi
  echo ""
  echo "权限说明："
  echo "  - 卸载会调用 sudo 停止/禁用 systemd 服务，删除或恢复 /etc/systemd/system 和 /etc/sudoers.d 中本项目的文件。"
  echo "  - 找到安装清单时，只删除安装器记录为自己创建的目录和用户。"
  echo "  - 使用 --keep-data 时会保留数据目录，并默认保留服务用户，避免保留数据变成无人拥有。"
  echo "  - 如需忽略“安装前已存在”的保守保护并强制清空目录，请显式加 --purge-all。"
}

main() {
  parse_args "$@"
  load_state

  APP_DIR="$(prompt_default "应用目录" "${APP_DIR}")"
  DATA_DIR="$(prompt_default "数据目录" "${DATA_DIR}")"
  SERVICE_USER="$(prompt_default "服务用户" "${SERVICE_USER}")"

  require_safe_path "app_dir" "${APP_DIR}"
  require_safe_path "data_dir" "${DATA_DIR}"

  print_summary

  if ! prompt_yes_no "继续卸载并恢复环境？" "n"; then
    echo "卸载已取消。"
    exit 0
  fi

  sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  sudo systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  restore_or_remove_systemd_service
  restore_or_remove_sudoers
  sudo rm -f "${LEGACY_TMP_ENV}" "${LEGACY_TMP_SERVICE}"
  sudo rm -f "/tmp/${SERVICE_NAME}.env."* "/tmp/${SERVICE_NAME}.service."* 2>/dev/null || true
  sudo systemctl daemon-reload
  sudo systemctl reset-failed

  remove_app_dir
  remove_or_keep_data_dir
  remove_service_user_if_needed

  echo ""
  echo "卸载完成。"
}

main "$@"
