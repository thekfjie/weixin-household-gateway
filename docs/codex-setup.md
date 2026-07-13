# Codex 配置

当前默认策略是：

- `admin`：ACP 持久会话
- `family`：普通聊天优先直连 API；复杂任务或 API 不可用时回退到 ACP 非持久会话

安装器会生成 `.env` 里的 Codex 相关配置；`family` 直连 API 会优先读取 `CODEX_FAMILY_API_*`，没有时继续兼容 `CODEX_API_*` 和 `CODEX_CLI_*`。

## Linux Codex 路径

安装器默认使用项目锁文件安装的隔离版 Codex，路径是：

```text
/opt/weixin-household-gateway/node_modules/.bin/codex
```

`@agentclientprotocol/codex-acp` 也从项目依赖解析同一个 `@openai/codex` 版本；
因此 bot 不依赖服务用户 PATH 里的全局版本。只有显式传入 `--admin-command` 或
`--family-command` 时才改用外部命令。安装器会把项目内命令写入：

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

这只作用于 `admin`。`family` 强制使用项目的 `weixin_family` permission profile；
其中的旧版 `sandbox_mode` / `sandbox_workspace_write` 参数会被移除，不能用
`CODEX_FAMILY_ACP_ARGS` 把 family 切到 `danger-full-access`。

## Family 文件与凭据隔离

`family-acp` 不使用 Codex 旧版 `read-only` 模式。旧模式虽然禁止写入，但会自动
允许读取服务用户能读到的系统文件。项目改用 Codex 0.144.3 permission profile：

- `runtime/family` 可读写；
- 当前会话的 `office`、`outbox` 可读写；
- 当前会话的 `inbox` 只读；
- 可写目录的父目录保持拒绝，其他会话目录和系统临时目录不可读写；
- 工具临时文件统一重定向到 `runtime/family/.tmp`；
- admin/family ACP host 分别使用独立的 `runtime/admin-codex-home` 和
  `runtime/family-codex-home`，并禁用系统 keyring 凭据读取；family 线程不落地；
- 项目 `.env`、Codex home 和系统凭据不可读；
- family/admin 工具子进程都只继承安全白名单环境和显式 passthrough；
- bot 主进程只从配置的认证 Codex home 读取 Key；ACP 的 Responses 请求通过仅监听
  loopback 的本机代理转发，Codex 只拿到一次性本机头，不把真实 Key 放进 ACP/App
  Server 环境、线程配置、工具，也不会由正常认证链路写入本地日志。

ACP 1.1.2 尚未原生把新版 permission profile 暴露成 ACP mode，因此项目在锁文件
中固定了一个小范围适配器补丁。`pnpm install --frozen-lockfile` 会自动应用
`patches/@agentclientprotocol__codex-acp@1.1.2.patch`。doctor 会检查 profile、
子进程凭据环境和隔离网关鉴权是否同时生效。

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
CODEX_CLI_MODEL=gpt-5.6-sol
CODEX_CLI_REVIEW_MODEL=gpt-5.5
CODEX_CLI_REASONING_EFFORT=high
```

思考强度按模型校验：`gpt-5.6-sol` / `terra` 支持 `low` 到 `ultra`，
`gpt-5.6-luna` 支持 `low` 到 `max`，`gpt-5.5` 支持 `low` 到 `xhigh`。
`none`、`minimal` 只对明确支持这些档位的未知第三方模型透传；当前 Codex 0.144.3
目录中的上述模型不支持这两个档位。

family 权限审核默认模型单独是：

```dotenv
CODEX_FAMILY_PERMISSION_REVIEW_MODEL=gpt-5.4-mini
```

如果要显式给 `family` 直连 API 单独配置，也可以使用：

```dotenv
CODEX_FAMILY_API_BASE_URL=https://your-openai-compatible-endpoint/v1
CODEX_FAMILY_API_KEY=sk-...
CODEX_FAMILY_API_MODEL=gpt-5.6-sol
```

## 微信内供应商切换

可以在 `.env` 里定义额外供应商 profile，然后由 admin 在微信里用 `/provider`
切换：

```dotenv
CODEX_PROVIDER_NAMES=vendorx
CODEX_PROVIDER_VENDORX_DISPLAY_NAME=Vendor X
CODEX_PROVIDER_VENDORX_API_BASE_URL=https://vendor.example/v1
CODEX_PROVIDER_VENDORX_API_KEY=sk-...
CODEX_PROVIDER_VENDORX_MODEL=gpt-5.6-sol
```

配置新的 `API_BASE_URL` 时不会继承默认供应商的 Key；该端点需要鉴权时必须同时
配置自己的 `API_KEY`，避免把默认凭据发送给其他供应商。

可切换路径是：

```text
admin-acp
family-api
family-acp
```

常用命令：

```text
/provider
/provider list
/provider ccswitch
/provider lock family-api on
/provider lock family-acp on
/provider admin-acp use vendorx
/provider use vendorx
/provider reset admin-acp
```

`/provider use <name>` 只会切换未锁定路径；精确路径命令如
`/provider admin-acp use vendorx` 会直接切该路径。

`/provider list` 会同时展示本项目 `.env` 中配置的 profile，以及 cc-switch 的
Codex 供应商列表。cc-switch 数据库默认读取 `~/.cc-switch/cc-switch.db`，可用
`CC_SWITCH_DB_PATH` 覆盖；展示时不会输出 API key。

对 `family-api`，profile 里的 `API_BASE_URL`、`API_KEY`、`MODEL` 会直接作用于
直连 API。对 `admin-acp` / `family-acp`，profile 会传入 key/model/env，并可附加
`CODEX_PROVIDER_<NAME>_CODEX_HOME` 或 `CODEX_PROVIDER_<NAME>_ACP_ARGS`。如果提供了
`API_BASE_URL`，项目会自动生成新版 ACP 所需的 provider 配置，并用
`OPENAI_API_KEY` 作为 `env_key`。`ACP_ARGS` 中现有的 `-c key=value` 写法仍兼容，
项目会在启动 ACP 1.x 时转换为 `CODEX_CONFIG` JSON。

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
