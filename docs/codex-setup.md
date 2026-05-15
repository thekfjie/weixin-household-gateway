# Codex 配置

当前默认策略是：

- `admin`：ACP 持久会话
- `family`：普通聊天优先直连 API；复杂任务或 API 不可用时回退到 ACP 非持久会话

安装器会生成 `.env` 里的 Codex 相关配置；`family` 直连 API 会优先读取 `CODEX_FAMILY_API_*`，没有时继续兼容 `CODEX_API_*` 和 `CODEX_CLI_*`。

## Linux Codex 路径

安装器会优先复用服务用户 PATH 里的 `codex`。如果没有检测到可用 CLI，会询问是否用 pnpm 为服务用户安装受管的 `@openai/codex`，默认路径是：

```text
~/.local/share/pnpm/codex
```

其中 `~` 是服务用户的 home。默认 `USER_MODE=current` 时服务用户就是当前安装用户；使用独立服务用户时，路径会落在该服务用户的 home 下。安装器会把解析后的命令写入：

```dotenv
CODEX_ADMIN_COMMAND=/path/to/codex
CODEX_FAMILY_COMMAND=/path/to/codex
```

## Admin 运维沙箱

项目的 `admin` ACP 权限策略可以允许 `sudo`、`systemctl`、`docker` 等运维动作，但 Codex CLI 自己还有一层 sandbox。Linux 默认 sandbox 使用 bubblewrap/bwrap，并可能带有 `NoNewPrivs=1`，这会让已经通过项目权限审核的 `sudo` 仍然失败。

当安装时选择的服务用户 sudo 策略不是 `none`，安装器会给 admin 默认写入：

```dotenv
CODEX_ADMIN_ARGS=exec --skip-git-repo-check -s danger-full-access
CODEX_ADMIN_ACP_ARGS=-c sandbox_mode=\"danger-full-access\"
```

这只作用于 `admin`。`family` 仍保持默认沙箱和更严格的权限策略，不建议配置 `CODEX_FAMILY_ACP_ARGS` 为 `danger-full-access`。

## bubblewrap/bwrap

Ubuntu/Debian 包名通常是 `bubblewrap`，命令名常见为 `/usr/bin/bwrap`。部分 Codex 错误信息会提到 `bubblewrap`，容易让人误判为包没有安装。安装器会：

- 如果 `bwrap` 和 `bubblewrap` 都不存在，询问是否安装系统包 `bubblewrap`。
- 如果只有 `bwrap` 没有 `bubblewrap`，创建 `/usr/local/bin/bubblewrap -> /usr/bin/bwrap` 兼容软链。
- 如果只有 `bubblewrap` 没有 `bwrap`，创建 `/usr/local/bin/bwrap` 兼容软链。

## Trusted Projects

`configure-codex.js --apply` 会重写 `~/.codex/config.toml`。项目只会信任当前应用目录和 admin runtime：

```toml
[projects."/opt/weixin-household-gateway"]
trust_level = "trusted"

[projects."/var/lib/weixin-household-gateway/runtime/admin"]
trust_level = "trusted"
```

不要把 `/` 配成 trusted project。根目录作为 workspace 容易触发 `/.git Permission denied`，也会扩大 Codex 的默认信任范围。

## 首次验证

```bash
cd /opt/weixin-household-gateway
node dist/apps/server/doctor.js --acp-session
```

如果你改了 `.env` 里的 API 配置或模型配置，重新生成 Codex CLI 配置：

```bash
node dist/apps/server/configure-codex.js --apply
sudo systemctl restart weixin-household-gateway
```

## 常见变量

```dotenv
CODEX_CLI_AUTH_MODE=api_key
CODEX_CLI_BASE_URL=https://your-openai-compatible-endpoint/v1
CODEX_CLI_API_KEY=sk-...
CODEX_CLI_MODEL=gpt-5.5
CODEX_CLI_REVIEW_MODEL=gpt-5.5
CODEX_CLI_REASONING_EFFORT=high
```

family 权限审核默认模型单独是：

```dotenv
CODEX_FAMILY_PERMISSION_REVIEW_MODEL=gpt-5.4-mini
```

如果要显式给 `family` 直连 API 单独配置，也可以使用：

```dotenv
CODEX_FAMILY_API_BASE_URL=https://your-openai-compatible-endpoint/v1
CODEX_FAMILY_API_KEY=sk-...
CODEX_FAMILY_API_MODEL=gpt-5.5
```

`family` 直连 API 的调用逻辑是：

- 优先 `/responses`
- 接口明确不支持时，自动回退 `/chat/completions`
- 普通网络波动、超时、`429`、`5xx` 不会被当成“不支持”

## 手动验证 CLI

```bash
codex exec --skip-git-repo-check "请用一句话回复：Codex 已接通"
```

如果使用 `login` 模式，先执行：

```bash
codex login
```
