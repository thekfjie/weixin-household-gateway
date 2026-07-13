# ACP 工作流

本文记录项目当前对 Agent Client Protocol（ACP）事件的理解和处理方式。
后续改 collector、权限策略、微信过程输出或 final answer 提取时，优先参考
这里。

当前项目使用 `@agentclientprotocol/codex-acp` `1.1.2`、
`@agentclientprotocol/sdk` `1.2.1`，并在项目锁文件中固定 `@openai/codex`
`0.144.3`。适配器会把图片生成作为 tool call 事件发出；项目侧统一按
`tool_call/tool_call_update` 归一成 `tool_progress`，再由微信发送层按角色限频和过滤。

## 适用路径

当前项目有两条 ACP 路径：

| 路径 | 会话持久性 | 默认过程输出 | 用途 |
| --- | --- | --- | --- |
| `admin-acp` | 持久 | 开启 | 管理员运维、代码、文件和长任务 |
| `family-acp` | 非持久 | 关闭 | family 复杂附件、归档文件、文档和工具任务 |

普通 `family` 聊天优先走 direct API，不走 ACP；只有复杂任务或 API 不可用时
才升级到 `family-acp`。

## 原始事件

ACP 会通过 `sessionUpdate` 持续发送事件。当前代码显式关心这些类型：

| 原始事件 | 含义 | 当前处理 |
| --- | --- | --- |
| `available_commands_update` | 会话能力或命令列表更新 | 转成 `status`，并结束当前可见文本 run |
| `agent_thought_chunk` | 模型内部思考片段 | 只作为 `thinking` 状态，不把正文发微信 |
| `agent_message_chunk` | 对外可见文本增量 | 收集成 message run，触发 `responding` |
| `tool_call` | 工具调用开始或状态事件，包括图片生成等新版工具事件 | 转成 `tool_progress` |
| `tool_call_update` | 工具调用状态更新 | 去重后转成 `tool_progress` |
| `usage_update` | token/usage 更新 | 忽略 |

相关代码：

- `apps/server/src/codex/acp-connection.ts`
- `apps/server/src/codex/acp-response-collector.ts`
- `apps/server/src/codex/backend-types.ts`

## 归一化事件

collector 对外暴露 `CodexProgressEvent`，目前有 5 类：

| phase | 来源 | 是否带正文 | 说明 |
| --- | --- | --- | --- |
| `status` | `available_commands_update` | 否 | 会话或能力状态 |
| `thinking` | `agent_thought_chunk` | 否 | 只表示进入思考，不暴露具体思考 |
| `responding` | 第一个 `agent_message_chunk` | 否 | 开始输出对外文本 |
| `tool_progress` | `tool_call/tool_call_update` | 是 | 工具调用过程，例如准备执行、正在处理、完成、失败 |
| `visible_message_run` | 一段连续 `agent_message_chunk` | 是 | 对外可见文本块，可能是过程说明，也可能是最终回答 |

注意：`visible_message_run` 不能仅凭事件名判断是不是最终答案。它只是“一段
可见文本 run”。最终答案由 collector 在 prompt 结束时按 `responseMode` 决定。

## final_message_run

微信不适合直接播放所有 ACP 文本。当前 ACP 请求统一使用：

```ts
responseMode: "final_message_run"
```

在这个模式下，collector 会返回最后一个非空 `visible_message_run` 作为最终回
复文本。这个策略匹配 Codex 常见输出形态：

1. 先产出过程说明；
2. 执行工具；
3. 再产出新的可见文本；
4. 最后一段可见文本通常是最终答案，并以 `end_turn` 收尾。

如果没有可见文本 run，则回退到所有 `agent_message_chunk` 拼接文本。

## 微信发送策略

| 模式 | 默认过程输出 | 30s 思考提示 | 过程/分段限制 |
| --- | --- | --- | --- |
| `admin-acp` | 开 | 关闭 | 最多占用前 `N-1` 条过程预算，至少间隔 15 秒；发送 `visible_message_run` 和 `tool_progress` |
| `family-acp` | 关 | 开 | 默认不发 ACP 过程；开 `/output process on` 后最多 4 条且不超过前 `N-1` 条，至少间隔 8 秒，只发过滤后的 `visible_message_run`，不发工具进度 |
| `family-api` | 早发默认关 | 开 | 开 `/output family-api-stream on` 后最多提前发 2 条且不超过前 `N-1` 条，至少 60 字，至少间隔 2.5 秒，只在强边界切 |

单轮微信发送预算由 `WECHAT_TURN_MESSAGE_LIMIT=N` 控制，默认 10。项目没有把
这个数字当成 iLink 协议保证，而是当成微信客户端展示稳定性的经验护栏：同一个
`context_token` 下前 `N-1` 条可用于过程消息、思考提示或 API 早发，第 `N` 条固定
发送最终答案。

- ACP 过程输出按事件流发送，不做 token 级刷新；
- `admin-acp` 过程消息前后更密，中间更少，最多使用前 `N-1` 条；
- 最终答案固定占最后 1 条；
- 最终答案不再做普通长度分段。

### admin-acp

默认开启过程输出：

```dotenv
WECHAT_ADMIN_PROGRESS_ENABLED=true
```

发送规则：

- 最多发送 `WECHAT_TURN_MESSAGE_LIMIT - 1` 条过程消息；
- 相邻过程消息至少间隔 15 秒；
- 过程消息按任务时间线发送：开头和接近超时时更密，中间更克制；
- 会发送 `visible_message_run`；
- 会发送 `tool_progress`；
- 不发送 `thinking` 具体内容；
- 开启过程输出时关闭 30 秒“思考中”提示，避免双重噪音。

### family-acp

默认关闭过程输出：

```dotenv
WECHAT_FAMILY_PROGRESS_ENABLED=false
```

用户可以在当前会话里打开：

```text
/output process on
```

打开后：

- 最多发送 4 条过程消息；
- 相邻过程消息至少间隔 8 秒；
- 只发送过滤后的 `visible_message_run`；
- 不发送工具进度；
- 不发送内部思考；
- family 输出仍经过 `filterFamilyOutput()`。

### family-api

默认关闭提前分段发送：

```dotenv
WECHAT_FAMILY_API_STREAMING_ENABLED=false
```

用户可以在当前会话里打开：

```text
/output family-api-stream on
```

打开后，direct API 的 SSE delta 会进入早发缓冲器：

- 最多提前发送 2 条；
- 最短候选文本 60 字；
- 相邻早发消息至少间隔 2.5 秒；
- 只在强边界发送：空行、完整句末、稳定列表项结尾；
- 不再做固定长度硬切；
- 内容重复或包含关系明显时跳过；
- 遇到内部文件动作标记 `[[...]]` 后停止早发，等最终回复处理。

`family-api` 未开启早发时，会等 API 完整返回后再发最终回答。
最终答案默认按完整消息发送，不再做普通长度分段。
如果最终答案里带有项目识别出的系统提示块，也会被合并进最后一条最终消息，避免
突破单轮消息预算。

上下文策略：

- direct API 维护独立的 `familyApiContext`，不再直接扫描同一 session 的全部消息；
- `familyApiContext` 约有 100k 字符预算，超出后优先按完整旧轮次裁剪，避免在一轮中间截断；
- prompt cache key 按 `role + wechatAccountId + contactId` 生成，不随 session 轮转改变；
- 当前 HTTP `/responses` 兼容接口不支持 `previous_response_id`，因此不依赖服务端连续上下文；
- `family-acp` 非持久路径只带 deterministic carryover 和短尾巴，避免复杂附件任务塞入过长聊天历史；
- ACP 完成后只把最后可见答案写入 `lastAcpTaskNote` 交给 API 轨道；该 note 也有 100k 字符预算，
  API 成功消费后清掉该 note。

deterministic carryover 不调用小模型，只由当前已有摘要、最近消息和相关文件名拼出。

## 用户命令

当前会话可用：

```text
/output
/output process on
/output process off
/output family-api-stream on
/output family-api-stream off
/stop
/cancel
```

`/output` 设置保存在当前 session 的 `memoryJson` 中，不需要 schema 迁移。
`/stop` 和 `/cancel` 会停止当前联系人正在执行的任务：ACP 会发送
`session/cancel`，API 会 abort HTTP 请求，CLI 会终止子进程。已经发出的微信消息
不会撤回。

## 权限策略要点

`family-acp` 使用更保守的权限策略：

- 使用 Codex `weixin_family` permission profile，而不是旧版全盘只读 sandbox；
- `runtime/family`、当前会话 `office` 和 `outbox` 可读写，`inbox` 只读；
- 可写目录的父目录保持拒绝；未列入当前会话的目录不可读写；
- 系统临时目录不会获得默认写权限；
- 工具临时文件通过 `TMPDIR` / `TMP` / `TEMP` 写入 `runtime/family/.tmp`；
- admin/family ACP host 都使用各自独立的运行 Codex home；family App Server
  线程额外设为 ephemeral；ACP 只允许使用运行 home 内的 file credential store，
  不读取同一系统用户的 keyring 登录状态；
- 项目 `.env`、Codex home 和系统凭据不在可读范围；
- admin/family 工具环境都按安全白名单构造，不继承服务凭据；
- bot 主进程只从配置的认证 Codex home 读取 Key；ACP 的 OpenAI-compatible 请求由
  loopback 代理通过一次性本机头鉴权并替换上游 Authorization，真实 Key 不进入
  ACP、App Server、工具环境，也不会由正常认证链路写入 Codex 本地日志；
- 拒绝系统级包管理、服务管理和越界路径访问；
- 部分被拒请求会进入小模型权限复核；
- 包管理、系统安装、服务操作即使复核也应保守拒绝。

`@agentclientprotocol/codex-acp` `1.1.2` 仍会在每轮请求中发送旧版
`sandboxPolicy`，这会覆盖 Codex 0.144.3 的 permission profile。项目通过
`pnpm-lock.yaml` 中固定的依赖补丁，在 family 启用 profile 时省略该覆盖，并把
ACP `additionalDirectories` 合并为本次会话的精确 workspace roots。安装和更新必须
使用 `pnpm install --frozen-lockfile`，不能绕过锁文件安装未补丁的适配器。

提示词层面也约束模型：

- 先使用当前环境已有的只读或低风险工具；
- 不为了缺少工具反复绕路；
- 工具明显不足时，说明缺少能力和最小可控授权方案；
- 不主动执行系统级安装、包管理、服务管理或大范围环境修改。

## 当前限制

- 微信侧没有“更新同一条消息”的能力，本项目只能发送多条消息，不能原地刷新。
- ACP prompt 到达环境配置的超时时间后会显式发送 `session/cancel`，并最多再等待
  2 分钟收集取消前后的最后可见文本。若拿到部分内容，会把“已生成内容，可能不完整”发给微信；若 ACP
  没有确认取消，会重置 ACP 连接并清掉该会话的持久 ACP session，避免下一轮继续
  撞上旧任务。
- `/stop` 是尽力停止：它能停止项目还在等待的 ACP/API/CLI 任务，但不能撤回已经
  发出的微信消息；如果底层工具进程不响应取消，项目会在等待窗口结束后重置 ACP
  连接。
- `visible_message_run` 是启发式边界，不是协议保证的最终答案标记。

## 开发注意事项

- 不要把 token 级流式直接映射到微信消息，会刷屏。
- 不要把 `agent_thought_chunk` 发给 family。
- 不要仅凭 `visible_message_run` 认定最终答案；最终答案应由
  `responseMode=final_message_run` 在 turn 结束后统一提取。
- 过程输出必须限频、限条数、去重，并遵守 `WECHAT_TURN_MESSAGE_LIMIT` 的单轮微信可见消息预算。
- family 输出过滤必须在发送前执行，已经发出的微信消息不能撤回。
- `/stop` 相关改动必须同时覆盖 API stream、ACP prompt、CLI 子进程、typing 状态
  和已排队的过程消息。
