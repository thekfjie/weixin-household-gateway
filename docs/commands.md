# 微信命令

## 全部角色

- `/help` 查看可用命令
- `/time` 查看北京时间
- `/whoami` 查看角色和会话信息
- `/new` `/reset` `/clear` 重置当前对话
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

示例：

```text
/codex admin
/codex admin model gpt-5.5
/codex family reasoning high
/codex admin reset
/output process on
```

## family

- `/mode` 只能查看当前模式，不能切到 `admin`
- `/file <outbox文件路径> [说明]` 只允许回传当前会话 `outbox` 里的成品文件
- `/output family-api-stream on|off` 开关直连 API 的提前分段发送
