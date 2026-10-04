#!/usr/bin/env bash
set -euo pipefail

SKILLS=(
  "devtools/docx"
  "devtools/pdf"
  "devtools/xlsx"
  "devtools/pptx"
)

DEST="${CODEX_SKILLS_DEST:-${CODEX_HOME:-${HOME}/.codex}/skills}"

usage() {
  cat <<EOF
用法：bash infra/scripts/linux/install-office-skills.sh

把常见办公类 Codex skills 安装到当前用户的 Codex skills 目录。

环境变量：
  CODEX_HOME=${CODEX_HOME:-${HOME}/.codex}
  CODEX_SKILLS_DEST=${DEST}

注意：
  - 请用 systemd 服务用户运行，例如 ubuntu。
  - 这不是默认安装步骤，因为公开技能市场来源不等同于本项目依赖。
  - 安装后需要重启 Codex/服务进程，让 ACP 重新加载技能。
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "缺少 npx。请先安装带 npm 的 Node.js。" >&2
  exit 1
fi

mkdir -p "${DEST}"

echo "办公技能安装目录：${DEST}"
echo "准备从 Codex Skills Registry 安装：${SKILLS[*]}"
echo ""

list_output=""
if list_output="$(npx codex-skills-registry@latest --list 2>/dev/null)"; then
  echo "已读取 registry 技能列表。"
else
  echo "读取 registry 技能列表失败，将逐个尝试安装候选技能。"
fi

installed=0
for skill in "${SKILLS[@]}"; do
  if [[ -n "${list_output}" ]] && ! grep -Eq "(^|[[:space:]])${skill}($|[[:space:]])" <<<"${list_output}"; then
    echo "跳过 ${skill}：当前 registry 列表里没有这个 slug。"
    continue
  fi

  echo "安装 ${skill} ..."
  if npx codex-skills-registry@latest --skill="${skill}" --dest="${DEST}" --yes; then
    installed=$((installed + 1))
  else
    echo "安装 ${skill} 失败，继续处理下一个。" >&2
  fi
done

echo ""
echo "办公技能安装完成：${installed}/${#SKILLS[@]}"
echo "下一步：sudo systemctl restart weixin-household-gateway"
