# 项目架构 v0

## 1. 项目目标

`weixin-household-gateway` 是一个面向日常真实使用场景的微信 AI 网关。

核心目标：

- 让家里人直接在微信里和 AI 对话
- 给项目所有者保留一条单独的高权限运维路径
- 比当前 `weixin-agent-sdk + weixin-acp` 方案更容易部署
- 稳定支持文件发送
- 让普通用户几乎无感知地使用上下文能力
- 统一按北京时间理解和呈现时间

## 2. 参考来源

这个项目参考了以下仓库：

- `Tencent/openclaw-weixin`
  - 作为 iLink 官方协议形态参考
  - 参考其多账号模型
  - 参考其官方媒体上传流程
- `lith0924/wechat-ilink-sdk-java`
  - 参考更完整的媒体消息实现
  - 参考上下文缓存、重试、异常处理思路
  - 尤其参考文件发送链路
- `UNLINEARITY/CLI-WeChat-Bridge`
  - 参考线程映射和操作者工作流设计

## 3. 产品形态

系统定位为 WeChat 与 Codex 之间的一层中控服务。

高层流程：

1. 微信账号通过 iLink 二维码登录
2. 网关接收微信消息
3. 网关识别发送者、角色、会话与策略
4. 网关构建带北京时间的上下文
5. 网关调用对应的 Codex 运行目标
6. 网关过滤、整理并渲染输出
7. 网关将文本、图片或文件发回微信

## 4. v0 不做的事

首个里程碑暂不覆盖：

- 群聊
- 语音发送
- 复杂 Web 管理后台
- 技能市场式系统
- 完整长期驻留的终端镜像能力
- 同一运行时里的细粒度路径 ACL

## 5. 核心需求

### 5.1 多账号

必须支持多个微信账号绑定。

每次扫码登录都生成独立账号记录，每个账号都有：

- 独立 token
- 独立长轮询 cursor
- 独立联系人路由
- 独立会话命名空间

### 5.2 角色分离

v0 固定两类角色：

- `admin`
- `family`

`admin` 面向项目所有者：

- 使用高权限 Codex 运行环境
- 可承担运维、代码、系统任务
- 可保留更完整的内部过程信息

`family` 面向普通家庭成员：

- 日常问答
- 办公场景辅助
- 文档生成
- 文件回传
- 不应默认拥有高风险操作能力

### 5.3 时间感知

所有用户可感知的时间统一按 `Asia/Shanghai`。

要求：

- 每条消息保存绝对时间
- 每次请求模型都注入当前北京时间
- 摘要和 memory 也统一带北京时间锚点

### 5.4 面向普通人的会话体验

不能假设家庭成员会主动切换会话或管理上下文。

系统必须：

- 对外看起来像连续自然对话
- 对内在合适时机自动拆分上下文
- 上下文过长时自动摘要
- 恢复时优先用摘要而不是全量历史

### 5.5 稳定的文件发送

文件发送是硬需求。

明确决策：

- 不沿用旧 ACP 文件出站链路
- 文件发送直接实现官方 iLink 媒体上传流程
- 设计上参考 Java SDK 的完整实现思路

## 6. 总体架构

v0 推荐的运行形态：

- 一个 Node.js 主服务进程
- 两个 Codex 运行目标
  - `codex-admin`
  - `codex-family`
- 一个 SQLite 数据库
- 一个本地文件目录用于附件与缓存

v0 推荐的部署形态：

- 直接运行在 Linux 宿主机
- 使用 `systemd` 托管
- 第一阶段不强依赖 Docker

## 7. 会话模型

默认会话键仍按：

```text
wechat_account_id + contact_id
```

但当前实现已经补了更进一步的会话轮转能力：

- 跨天开新段
- 空闲超时开新段
- 超过轮数阈值开新段
- 超过估算 token 阈值开新段

并且会把上一段摘要/最近消息作为 carryover 信息带入下一段。

## 8. 当前安装默认

当前默认推荐：

- 服务用户：当前 SSH 登录用户
- 权限模式：`PERMISSION_MODE=full`
- Codex 后端：`ACP`
- Codex 认证：第三方 API key 模式优先

默认目录：

```text
/opt/weixin-household-gateway
/var/lib/weixin-household-gateway
/var/lib/weixin-household-gateway/runtime/admin
/var/lib/weixin-household-gateway/runtime/family
/var/lib/weixin-household-gateway/inbox
/var/lib/weixin-household-gateway/office
/var/lib/weixin-household-gateway/outbox
```

## 9. 安装与卸载原则

- 推荐用普通 SSH 用户运行，不要 `sudo su -`
- 安装器只在必要步骤调用 `sudo`
- 默认允许为单人服务器 admin 提供 full sudo
- 卸载默认按安装清单恢复环境
- `--keep-data` 保留数据
- `--purge-all` 明确强制清空应用目录和数据目录

## 10. 当前已经实现的重点

- 多账号登录和角色分权
- ACP 会话映射与持久化
- `family` 输出过滤
- 文件入站下载解密
- 文件回传链路
- `family` 只允许回传当前会话 `outbox`
- `/mode`、`/last`、`/yesterday`、`/memory`
- 轻量 deterministic `summary_text`
- 自然语言“昨天/上一次”引用上一段摘要

## 11. 后续重点

- 更完整的模型摘要生成
- 更细的流式体验
- 图片/视频/语音媒体链路
- 更稳定的历史回看和话题切换策略
