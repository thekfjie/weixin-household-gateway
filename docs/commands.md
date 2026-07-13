# 微信命令

## 全部角色

- `/help` 查看可用命令
- `/time` 查看北京时间
- `/stop` 停止当前正在执行的任务，`/cancel` 同义
- `/whoami` 查看角色和会话信息
- `/new` 开启新话题，保留轻量上下文
- `/reset` `/clear` 彻底清空当前对话
- `/last` 查看上一段对话
- `/yesterday` 查看昨天的上一段对话
- `/memory` 查看当前 memory 状态
- `/summary` 查看当前摘要
- `/output` 查看或切换当前会话输出设置
- `/output process on|off` 开关 ACP 过程输出

## admin

- `/mode admin|family` 切换当前会话模式
- `/recent` 查看最近几条消息
- `/sessions` 查看最近会话
- `/accounts` 查看已绑定微信账号
- `/files` 查看最近可发送文件
- `/file <路径> [说明]` 发送服务器文件
- `/codex [角色] [操作]` 查看或修改模型、思考强度
- `/provider` 查看或切换供应商路径

示例：

```text
/codex admin
/codex admin model gpt-5.6-sol
/codex family reasoning high
/codex admin reset
/provider
/provider list
/provider ccswitch
/provider lock family-api on
/provider lock family-acp on
/provider admin-acp use vendorx
/provider use vendorx
/provider reset admin-acp
/output process on
/stop
```

`/codex` 参数提示：

- 角色：`admin`、`family`
- 操作：`model <模型>`、`reasoning <强度>`、`reset`
- 模型示例：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`
- 思考强度会按模型校验：`gpt-5.6-sol` / `terra` 支持 `low` 到 `ultra`，
  `gpt-5.6-luna` 支持 `low` 到 `max`，`gpt-5.5` 支持 `low` 到 `xhigh`；
  未知第三方模型允许透传全部合法枚举。

`/provider use <供应商名>` 会批量切换未锁定路径；先锁定 `family-api` 和
`family-acp` 后，再批量切换就只会影响未锁定路径。精确切换可直接使用
`/provider admin-acp use <供应商名>`、`/provider family-api use <供应商名>` 或
`/provider family-acp use <供应商名>`。

`/provider ccswitch` 会读取 cc-switch 的 Codex 供应商列表，默认路径是
`~/.cc-switch/cc-switch.db`，也可以用 `CC_SWITCH_DB_PATH` 覆盖。这个命令只展示
供应商 ID、名称、当前项、模型、base URL 和 wire_api，不展示密钥。

## family

- `/mode` 只能查看当前模式，不能切到 `admin`
- `/file <outbox文件路径> [说明]` 只允许回传当前会话 `outbox` 里的成品文件
- `/output family-api-stream on|off` 开关直连 API 的提前分段发送

`/memory` 会显示 `family_api_context_chars`、`last_acp_task_note_chars` 和
上一轮 family 后端，方便排查 API/ACP 轨道是否按预期切换。
