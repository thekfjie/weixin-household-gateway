# 服务器部署与更新

本次服务器整理以已经运行的 Gateway 版本为准，保留原 Node.js、Codex runtime 依赖版本及运行配置。唯一应用目录为 `/opt/weixin-household-gateway`，当前源码在根目录，systemd 直接运行该目录中的构建产物。

```text
/opt/weixin-household-gateway/
  .git/          当前仓库、main 与 archive refs
  .env           本机配置与凭据，Git 忽略
  apps/          当前源码
  dist/          当前构建产物，Git 忽略
  node_modules/  当前锁定依赖，Git 忽略
  docs/          当前运维与历史文档
  legacy/        旧 ACP 只读参考
  data/runtime   原 release 内的本地目录，若存在则保留，Git 忽略
/var/lib/weixin-household-gateway/
  weixin-household-gateway.sqlite
  codex-home/
  runtime/、inbox/、office/、outbox/
```

原 `/opt/weixin-household-gateway-releases/current` 不再作为活动代码入口。原两份 release worktree、源码差异、依赖/构建产物和 systemd 配置保存在迁移备份中；各版本的 Git 历史还有独立 archive 分支。本机持久数据与 credential 的位置保持不变。

日常更新：

```bash
cd /opt/weixin-household-gateway
git status --short
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:wxbot
sudo systemctl restart weixin-household-gateway
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18080/readyz
```

先处理本地修改，再更新；不要使用 `git reset --hard` 丢掉本地改动。只在明确调整 Codex 配置时执行 `pnpm codex:configure -- --apply`，这不是每次拉取源码都必须执行的步骤。

安装器仍支持生成 systemd unit。已有服务器的 EnvironmentFile、工作目录和 Codex 可执行文件都必须指向当前目录；本次已把 release 专用路径合并回 `.env`，并备份旧 release env。查看实际配置：

```bash
systemctl show weixin-household-gateway -p WorkingDirectory -p ExecStart -p EnvironmentFiles
systemctl status weixin-household-gateway
journalctl -u weixin-household-gateway -n 50
```

数据备份：

```bash
cd /opt/weixin-household-gateway
pnpm backup
```

应用 backup 工具默认不备份 `.env` 和 Codex credential。迁移备份另外保护了这些资料，目录为 `/var/backups/weixin-household-migration-20261004T101522Z`，目录权限 `0700`，凭据文件/压缩包 `0600`，不要上传到 GitHub。

回滚本次目录整理时，先停服务，从备份中恢复原应用及 release 目录、systemd unit/drop-in 和 release env，再执行 `systemctl daemon-reload` 与启动。恢复程序布局通常不需要恢复数据库；只有数据损坏时才使用 SQLite snapshot 和 persistent-data 备份。Git worktree 中记录了绝对路径，必须恢复到原路径或执行 `git worktree repair`。具体 SHA、bundle 和验证记录见 [迁移报告](history/migration-report-2026-10-04.md)。
