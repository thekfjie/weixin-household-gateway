# Codex 配置

安装器默认把 admin/family 都接到 ACP 后端，并生成 `.env` 里的 Codex 相关配置。

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

## 手动验证 CLI

```bash
codex exec --skip-git-repo-check "请用一句话回复：Codex 已接通"
```

如果使用 `login` 模式，先执行：

```bash
codex login
```
