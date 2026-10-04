# 产品目标核对

本文把最初讨论过的想法和当前实现状态放在一起，方便后续继续推进。

## A. 产品目标

- 家里人直接在微信里和 AI 聊：已实现基础聊天链路，`family` 角色有输出过滤和更自然的微信场景提示。
- admin 高权限身份：已实现 `admin/family` 角色区分；默认单人服务器安装可给服务用户 `full sudo`，也可以用 `PERMISSION_MODE=none|limited` 降权。
- 长期运行在服务器上：已用 `systemd` 托管，默认端口 `18080`，数据目录默认 `/var/lib/weixin-household-gateway`。
- 简单安装/卸载/重装：已有 `bootstrap / install / uninstall`；卸载按安装清单恢复环境，`--keep-data` 可保留数据，`--purge-all` 可强制清空。

## B. 功能目标

- 多微信账号绑定：已支持多账号登录、账号列表、角色修改、启停。
- 权限分层：已支持 `admin/family`；`family` 默认最小环境变量和输出过滤。
- 文件能力：已支持 admin 发送白名单目录文件，包括 CLI、微信 `/file`、自然语言触发、结构化动作标记；已预留 `inbox/office/outbox` 办公文件工作区。
- 会话管理：已自动按微信 peer 建 active session；`/new`/`/reset` 清上下文；`/sessions` 可查看最近会话。
- ACP session：映射会持久化；如果 adapter 声明支持 `session/load`，服务重启后会尝试恢复。
- 时间语义：prompt 中统一带北京时间锚点。
- 输出控制：admin 保留更多错误信息但已做脱敏；family 不返回内部路径、命令、工具细节。

## C. 现阶段新增进展

- 已支持 `family` 在 ACP 下优先取本轮最后一段连续回答作为对外回复。
- 已支持会话按跨天、空闲时长、轮数、估算 token 数自动开新段。
- 已支持 `carryoverSummary`：上一段对话摘要/最近消息可带入下一段。
- 已支持 `/last`、`/yesterday`、`/memory` 查看上一段和当前 memory 信息。
- 已支持用户自然提到“昨天”“上一次”“前面的那个”时，内部按需附带上一段摘要。
- 已支持 `family` 只允许回传当前会话 `outbox` 内的成品文件。

## 当前建议配置

单人服务器推荐直接统一到 `ubuntu`：

```text
systemd User=ubuntu
HOME=/home/ubuntu
/home/ubuntu/.codex/config.toml 存在
/home/ubuntu/.codex/auth.json 存在（如果用 login 模式）
CODEX_ADMIN_BACKEND=acp
CODEX_FAMILY_BACKEND=acp
```

默认推荐认证路径：

```text
ACP + 第三方 API key
```

也就是：

- `CODEX_CLI_AUTH_MODE=api_key`
- `CODEX_CLI_BASE_URL=...`
- `CODEX_CLI_API_KEY=...`

官方 `codex login` 仍可选，但不是默认推荐。

关键原则：不要用跨用户 `/usr/local/bin/codex` wrapper。CLI 后端和 ACP 后端必须看到同一个真实用户、同一个 `HOME`、同一套 `~/.codex`。

## 仍未完全完成

- ACP session 真正跨重启恢复仍取决于 adapter 是否声明 `loadSession=true`。
- 定时 sum-up 和更完整的 memory/skill 体系还没完全做完。
- 当前 `summary_text` 已开始轻量落地，但还不是完整的模型摘要系统。
- 图片/视频/语音的完整媒体发送仍待继续补齐。
- 公众号/文章卡片这类结构化内容仍不稳定。
- 更细的流式体验仍在逐步优化，当前微信侧仍以最终文本或分段文本发送为主。
