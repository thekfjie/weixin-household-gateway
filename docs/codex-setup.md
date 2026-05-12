# Codex 配置

当前默认策略是：

- `admin`：ACP 持久会话
- `family`：普通聊天优先直连 API；复杂任务或 API 不可用时回退到 ACP 非持久会话

安装器会生成 `.env` 里的 Codex 相关配置；`family` 直连 API 会优先读取 `CODEX_FAMILY_API_*`，没有时继续兼容 `CODEX_API_*` 和 `CODEX_CLI_*`。

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
