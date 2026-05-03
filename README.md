# weixin-household-gateway

家庭共享微信 AI 网关。服务长期运行在 Linux 服务器上，家人直接在微信里聊天，你保留 `admin` 权限。

仓库地址当前仍是：

```text
https://github.com/thekfjie/weixin-household-agent-acp
```

## 一键安装

用普通 SSH 用户登录到 Linux 服务器后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/thekfjie/weixin-household-agent-acp/main/infra/scripts/linux/bootstrap.sh | bash
```

安装流程会：

1. 拉取代码到 `/opt/weixin-household-gateway`
2. 创建数据目录 `/var/lib/weixin-household-gateway`
3. 安装依赖并构建
4. 为服务用户安装受管的 `codex` CLI 到用户自己的 `PNPM_HOME`
5. 写入 `.env` 和 systemd 服务
6. 首次扫码绑定微信账号
7. 启动服务并运行自检

不要用 `sudo bash` 运行。脚本会在需要写 `/opt`、`/var/lib` 和 `systemd` 时自行调用 `sudo`。

## 无人值守安装

如果你明确要走默认值并尽量减少交互，可以这样：

```bash
curl -fsSL https://raw.githubusercontent.com/thekfjie/weixin-household-agent-acp/main/infra/scripts/linux/bootstrap.sh | \
BOOTSTRAP_YES=1 \
bash
```

`BOOTSTRAP_YES=1` 时有两种认证路径：

- 如果同时提供了 `CODEX_CLI_BASE_URL` 和 `CODEX_CLI_API_KEY`，安装器会走第三方兼容 API key 模式。
- 如果没有提供完整的 `BASE_URL/API_KEY`，安装器会自动回退到 `login` 模式，不会卡死在输入提示上。

## Codex 认证

默认推荐走第三方兼容中转站，不需要官方 OpenAI 网页登录。

示例：

```bash
curl -fsSL https://raw.githubusercontent.com/thekfjie/weixin-household-agent-acp/main/infra/scripts/linux/bootstrap.sh | \
BOOTSTRAP_YES=1 \
CODEX_CLI_AUTH_MODE=api_key \
CODEX_CLI_BASE_URL=https://your-gateway.example/v1 \
CODEX_CLI_API_KEY=sk-xxx \
CODEX_CLI_MODEL=gpt-5.4 \
CODEX_CLI_REVIEW_MODEL=gpt-5.4 \
LOGIN_ROLE=admin \
bash
```

如果你不用中转站，也可以走登录模式：

```bash
/home/ubuntu/.local/share/pnpm/codex login
/home/ubuntu/.local/share/pnpm/codex exec --skip-git-repo-check "请用一句话回复：Codex 已接通"
cd /opt/weixin-household-gateway
node dist/apps/server/doctor.js --acp-session
```

说明：

- 现在安装器默认把 `codex` 装到服务用户自己的 `PNPM_HOME`，不放进项目目录，也不依赖跨用户全局 wrapper。
- 如果配置了 `CODEX_CLI_BASE_URL`，生成的 Codex 配置会按“兼容 API”处理，不再强制表现成官方 OpenAI 登录流。
- 服务默认走 `ACP` 后端，不是单次 `codex exec`。

## 安装完成后

常用命令：

```bash
sudo systemctl status weixin-household-gateway
journalctl -u weixin-household-gateway -f
curl http://127.0.0.1:18080/healthz
```

自检：

```bash
cd /opt/weixin-household-gateway
node dist/apps/server/doctor.js
node dist/apps/server/doctor.js --acp-session
```

添加 family 账号：

```bash
cd /opt/weixin-household-gateway
node dist/apps/server/setup.js family --force
sudo systemctl restart weixin-household-gateway
```

更新：

```bash
cd /opt/weixin-household-gateway
git pull
corepack pnpm build
sudo systemctl restart weixin-household-gateway
```

卸载但保留数据：

```bash
bash /opt/weixin-household-gateway/infra/scripts/linux/uninstall.sh --yes --keep-data
```

完整卸载：

```bash
bash /opt/weixin-household-gateway/infra/scripts/linux/uninstall.sh --yes
```

## 目录约定

```text
/opt/weixin-household-gateway              项目代码、dist、node_modules
/var/lib/weixin-household-gateway          SQLite、账号、会话、附件
/var/lib/weixin-household-gateway/inbox    用户发来的文件
/var/lib/weixin-household-gateway/office   文档处理中间文件
/var/lib/weixin-household-gateway/outbox   准备发回微信的文件
/home/ubuntu/.local/share/pnpm             服务用户自己的 pnpm / codex 命令
/home/ubuntu/.codex                        服务用户自己的 Codex 配置和认证
```

## 更多文档

- [办公技能和文件工作区](docs/office-skills.md)
- [提示词参考](docs/prompts.md)
- [产品检查清单](docs/product-checklist.md)
- [架构草案](docs/architecture-v0.md)
- [后续计划](docs/roadmap.md)
