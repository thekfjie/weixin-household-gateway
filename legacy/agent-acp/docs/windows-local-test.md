# Windows 本地测试说明

这份说明面向当前开发机：

- 仓库目录：`E:\program\weixin-household-gateway`
- 目标：先在 Windows 上完成本地联调，再迁移到 Linux 服务器

## 推荐入口

直接运行：

```powershell
.\infra\scripts\windows\run-local.cmd
```

脚本会自动完成：

1. 设置仓库内的 `COREPACK_HOME` 和 `PNPM_HOME`
2. 创建 `data`、`runtime/codex-admin`、`runtime/codex-family`
3. 安装依赖
4. 构建 TypeScript
5. 如果本地还没有微信账号，打印二维码并等待扫码确认
6. 启动服务

已有账号时会自动跳过扫码。

## 常用参数

绑定首个账号为 `admin`：

```powershell
.\infra\scripts\windows\run-local.cmd -Role admin
```

绑定家人账号：

```powershell
.\infra\scripts\windows\run-local.cmd -Role family -ForceSetup
```

只启动，不做扫码检查：

```powershell
.\infra\scripts\windows\run-local.cmd -SkipSetup
```

## 默认本地目录

为了方便 Windows 本地测试，项目默认把运行目录放在仓库内部：

- 数据目录：`.\data`
- admin 工作目录：`.\runtime\codex-admin`
- family 工作目录：`.\runtime\codex-family`

迁移到 Linux 后可通过 `.env` 或环境变量覆盖这些路径。

## 常用环境变量

- `PORT`
- `TIMEZONE`
- `DATA_DIR`
- `WECHAT_API_BASE_URL`
- `WECHAT_CDN_BASE_URL`
- `WECHAT_CHANNEL_VERSION`
- `WECHAT_ROUTE_TAG`
- `CODEX_ADMIN_COMMAND`
- `CODEX_ADMIN_MODE`
- `CODEX_ADMIN_WORKSPACE`
- `CODEX_FAMILY_COMMAND`
- `CODEX_FAMILY_MODE`
- `CODEX_FAMILY_WORKSPACE`

Windows 默认优先使用 `codex.cmd`。如果你的本机命令不同，可以手动设置：

```powershell
$env:CODEX_ADMIN_COMMAND = "codex.cmd"
$env:CODEX_FAMILY_COMMAND = "codex.cmd"
```

## 当前适合验证的内容

- 配置读取
- 数据库初始化
- 会话创建
- 终端二维码登录
- 多账号绑定记录
- 长轮询 worker 是否能启动
- Codex 路由预览
- 文件上传发送模块的入参和出口

## 仍需真实环境 E2E 的内容

- 服务器上的真实扫码登录
- 真实微信文本消息收发闭环
- 真实 Codex 自动回复闭环
- 真实微信文件发送 smoke test
