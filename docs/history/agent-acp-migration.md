# ACP → Gateway 项目历史与迁移

调查与备份日期：2026-10-04（UTC）。唯一当前项目：`thekfjie/weixin-household-gateway`，默认分支 `main`。当前源码、配置、提示词和部署工具仍在根目录，旧实现位于 `legacy/agent-acp/`。

## 两仓的真实关系

这是同一项目的早期实现与后续发展，经历了产品改名、新建 GitHub 仓库和模块化整理。它不是两个互不相关的系统，也不是从零完全重写。

证据如下：

1. ACP 仓库创建于 `2026-04-28T10:50:37Z`。最早脚手架提交为 `7b56e38`，此后提交依次加入 iLink 登录/轮询、Codex CLI、文件收发、SQLite、ACP、持久会话及角色权限。完整 78 个提交见 [提交索引](agent-acp-commits.txt)。
2. `a0a14a0`（2026-05-02）开始调整 Gateway 命名和安装流程；`92d610f`（2026-05-02）明确记录 `Rename project to weixin-household-gateway`。旧仓最终 README 标题、`package.json` 名称、服务说明和默认部署路径都已使用 Gateway 名字，README 明确说仓库地址暂时仍是 ACP 地址。
3. Gateway 仓库创建于 `2026-05-04T06:49:19Z`，`579aa059` 是初始提交，`a2233cb6` 是随后导入主体代码的提交。两个仓库没有共同 Git ancestor；新仓没有保留旧仓的 parent 链。
4. 对比旧仓最后提交与 Gateway 的 `a2233cb6`：72 个同路径文件中，50 个 Git blob 完全相同、22 个不同；旧仓独有 22 个路径，新仓新增 20 个路径。完全相同的文件包括 SQLite schema/database、iLink protocol/media、会话 memory/rotation、ACP collector、family 权限审核、CLI 配置工具等。差异主要是拆出 HTTP、命令处理、附件、工作区和 prompt-builder 模块，并调整安装仓库 URL。
5. 对比旧仓最后提交与迁移前 Gateway 远端 `main`：25 个同路径文件完全相同、47 个不同。逐文件结果见 [文件对比](agent-acp-file-comparison.json)。同路径的不同版本全部各自保留，没有用旧代码覆盖当前代码。

**为何旧仓停止作为主仓：**现存证据能确认产品已改名，之后开发持续出现在 Gateway 仓库；但没有找到作者明确写下“为何新建仓库而不直接改名”的决策记录。根据现存仓库资料推断，新仓承接了改名后的项目入口及模块整理。不能把这个推断写成已经确认的个人动机。

## 旧 ACP 当时实现了什么

最后保存 SHA：`73d3e48ef73babbf0d311dc7de7a5a0d81f8799a`。最后提交作者时间为 `2026-05-04T00:07:07+08:00`，对应 UTC `2026-05-03T16:07:07Z`。

项目定位是长期运行的家庭微信 AI 网关：家人通过微信使用 AI，项目所有者保留 admin 运维入口。它不是只有 ACP 协议适配器。

| 组件 | 实现及证据路径（相对历史快照） |
| --- | --- |
| 微信接入 | `apps/server/src/transport/ilink/`：二维码登录、轮询、typing、消息发送、媒体下载/解密及 CDN 上传 |
| Codex 后端 | `apps/server/src/codex/`：CLI 回退、ACP subprocess、认证、session 创建/恢复、权限请求、响应 collector |
| 会话 | `apps/server/src/sessions/`：北京时间锚点、会话轮转、memory、carryover 和提示词 |
| 分权及命令 | `commands/`、`router/`、`policy/`：admin/family、文件动作、会话命令、输出脱敏 |
| 数据 | `storage/schema.ts`、`database.ts`：accounts、contacts、polling_state、sessions、messages、attachments、codex_role_settings |
| API/UI | 当时的 `index.ts` 内置 HTTP health/ready、账号、登录 API 和登录页面；没有单独前端应用 |
| 运维 | `setup.ts`、`doctor.ts`、`backup.ts`、`configure-codex.ts`、`send-file.ts`；Linux systemd、安装/卸载、Windows 本地脚本 |

架构是 TypeScript/Node.js 单服务、SQLite、本地附件及会话工作区，通过 ACP 或 CLI 调用 Codex。`docs/architecture-v0.md` 明确第一阶段不强依赖 Docker。两仓均未发现 Dockerfile、Compose、独立前端工程、OpenAPI 文件或 GitHub Actions workflow。

## Gateway 如何继续发展

Gateway 的首次主体导入是在 2026-05-04。代码证据说明，它在旧实现基础上拆分了 `http/`、`commands/handlers.ts`、`sessions/workspace.ts`、附件和文件命令模块，并修正 clone/bootstrap 地址。

后续可确认的变化：

- 2026-05-12 起：`fc7d64c` 引入 family direct API 路由，`6d2519d` 按角色拆分 ACP 持久策略，`18f6101` 增加复杂附件交接；普通 family 对话优先 API，复杂文件任务升级 ACP。
- 2026-05-13/14：改进过程输出、最终回答收集、family 上下文轨道、ACP 超时收尾和上下文压缩提示；`c563541` 将角色提示词外置到 `prompts/`。
- 2026-05-17/21：停止当前任务、微信消息预算及会话轮转策略更新。
- 2026-07-13：ACP/runtime 依赖更新、供应商切换、凭据与运行环境隔离。迁移前远端 `main` 停在 `56d5229`。
- 服务器在 2026-08/09 还有九个未推送到远端 `main` 的后续提交，涵盖运行输出过滤、runtime 升级、长回复拆分、入站队列、approval/sandbox 配置保留及个人/wxbot 凭据隔离。原活动 worktree 位于 `upgrade/codex-0.153.4`，SHA 为 `0d839b8`。这次原样收回这些已在服务器使用的修复，没有额外升级依赖。
- 服务器活动 worktree 的既有未提交修改涉及自然语言文件路由、模型目录配置和对应测试，已保存为 `38a6311c75e0e428067c7f97674dcbedc37dcc3c`；另一个 worktree 的 CDN 调试文档也保留在当前 `docs/`。

继承的主链路仍是 iLink → 角色/会话/附件 → Codex → 输出策略 → 微信，沿用了数据库、协议、媒体、工作区和权限设计。新的 HTTP/命令/worker 分层是重构；family API backend、API 上下文轨道及外置 prompt 是后续新增或重新实现。不能把“文件变了”一概说成“整套系统重写”。

## 如何保存旧资料

可读快照保留了旧仓最终版本的 78 个非构建文件。源码、六份旧 docs、配置示例、MIT License、lockfile、Linux/Windows 脚本和 systemd 文件都在 `legacy/agent-acp/`。旧仓没有独立 tests 目录；验证工具保留在源码中。

具有独立保存价值的文档：

- `docs/architecture-v0.md`：初始边界、参考来源和架构决定。
- `docs/product-checklist.md`、`roadmap.md`：当时完成情况、待办和限制，不能当作今天全部已实现的能力。
- `docs/prompts.md`：外置 prompt 之前的角色/时间/工作区和注入设计。
- `docs/office-skills.md`：办公工作区、技能来源和权限边界。
- `docs/windows-local-test.md`：当时的 Windows 路径。

旧仓最终树中的 16 个 `dist/` JavaScript 构建输出不放入主树快照，仍完整留在原历史分支和 bundle；没有删除旧 Git 对象。旧仓未跟踪 node_modules、数据库、真实 `.env`、session/runtime 数据或日志。更早已删除的文件仍由完整历史保留。

[完整路径表](agent-acp-path-map.tsv) 列出每个 old → new 路径及处理理由，[快照清单](agent-acp-snapshot.json) 提供原 blob 和 SHA256。`README.md` 增加了历史提示；原文逐字节保存在 `README.original.md`。其余快照文件保持原字节和文件权限。

旧安装脚本和旧 README 中的仓库 URL、绝对部署路径属于历史原文；没有让它们变成当前安装入口。它们不参与当前 TypeScript 编译和测试。当前根目录 bootstrap、systemd、文档和运行命令指向 Gateway。历史源码里的相对 import 以及文档相对链接仍可解析。本次没有尝试重新复活旧 runtime。

## Git 历史与完整恢复

采用“主树最终快照 + 原历史分支 + 标签 + 完整 bundle”，没有把无共同 ancestor 的 ACP commits 强行混入当前 `main`。

| 引用 | 用途 |
| --- | --- |
| `archive/agent-acp` | 原 78 个提交，分支 tip 就是旧仓最后 SHA |
| `archive/agent-acp-final-20260503` | 同一最终 SHA；标签日期使用 UTC |
| `archive/gateway-pre-migration` | 原 Gateway 远端 `main` 的 `56d5229` |
| `archive/server-source-20261004` | 原主目录源码与测试，包括当时未提交修改 |
| `archive/server-active-20261004` | 原运行版本及当时未提交修复 |
| `archive/server-cdn-research-20261004` | 原 0.152.1 worktree 及 CDN 实验文档 |

原 Gateway 的三个 feature/bugfix 分支保留，tip 都在当前主线祖先中。原两仓均没有 tag 或 GitHub release。

原始 bundle：

| 文件 | SHA256 |
| --- | --- |
| `bundles/agent-acp-pre-migration.bundle` | `db9a093e1f004fef50ce340452717ed1f96dbdc21e1e03f88767c7a8691e3dad` |
| `bundles/gateway-pre-migration.bundle` | `efee092e58c0b180d9850640554c8942670891df7b183ab9f5e38e711e06d7d7` |

在当前仓库根目录验证和独立恢复：

```bash
git bundle verify docs/history/bundles/agent-acp-pre-migration.bundle
git clone --mirror docs/history/bundles/agent-acp-pre-migration.bundle /path/to/acp-restored.git
git --git-dir=/path/to/acp-restored.git fsck --full
git fetch origin
git log origin/archive/agent-acp --oneline
git show origin/archive/agent-acp:docs/architecture-v0.md
```

完整 mirror、原 bundle、GitHub API 元数据及服务器私有数据备份位于：

```text
/var/backups/weixin-household-migration-20261004T101522Z/
  weixin-household-agent-acp/
  weixin-household-gateway/
  server/
```

[备份清单](backup-manifest.json) 记录 URL、默认分支、HEAD、所有 refs、时间、位置和 bundle hash。GitHub 元数据存放在 `github/`：旧仓无 Issue/PR；Gateway 保留原闭合 Issue #1，未发现 PR、Actions 或 Release。

服务器 `.env`、账号 token、SQLite、Codex home 和 session 只在受限本地备份中保存，不进入公开 Git。源码 archive 分支与原始 ACP bundle 经扫描后才推送到 Gateway。旧仓原为私有，当前 Gateway 原为公开；只发布项目源码和不含凭据的设计/实验资料。

## 安全与验证边界

Gitleaks 8.30.1 扫描了全部 refs；补充扫描了 739 个独立 Git blob，检查 WeChat AppID、字面量 AppSecret/token、private key，并与当前 `.env` 和 SQLite 中的 151 个凭据值逐一比对，未发现历史泄漏。完整检查摘要见 [credential-audit.json](credential-audit.json)。因此本次没有找到需要 rewrite history 或强制 rotate 的已泄漏 credential；扫描结果不能证明从未使用过的未知旧凭据一定不存在。

`.gitignore` 补上 `.env.*` 备份、认证文件、ACP session map 和数据库忽略规则，同时保留 `.env.example`。当前运行凭据继续存于原 `.env`、数据库和 Codex home，未公开其内容。

迁移前/后的安装、类型检查、构建、测试、bundle 恢复、快照和链接核对，以及服务器收敛结果，见 [迁移报告](migration-report-2026-10-04.md) 与 [服务器部署说明](../server-deployment.md)。健康检查不等同于重新验证第三方 CDN、模型 API 或真实微信对话；没有为仓库整理发送测试消息。

`weixin-mini-program-login` 属于独立的小程序登录/runtime 研究，未纳入任何 fetch、merge、push 或部署操作。仅做只读状态指纹核对，以验证没有改变。
