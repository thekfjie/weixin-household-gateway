# 仓库与服务器迁移报告（2026-10-04）

唯一 canonical/active repository：`thekfjie/weixin-household-gateway`，默认分支 `main`。本次优先收回历史，保留当前根目录布局与既有服务器修复，不重新设计系统。

## 原始状态

| 位置 | 原默认分支/运行分支 | 原 HEAD SHA |
| --- | --- | --- |
| GitHub ACP（原为私有） | `main` | `73d3e48ef73babbf0d311dc7de7a5a0d81f8799a` |
| GitHub Gateway（公开） | `main` | `56d5229dee29bd851828beeb191b290f2ab3237f` |
| 服务器原主目录 | `checkpoint/wxbot-pre-codex-0.148.0` | `06849a96f685398766d5f1eb4bdcfba241026172` |
| 服务器活动 release | `upgrade/codex-0.153.4` | `0d839b827f9da71038b1ee8460732b02be736f1d` |
| 服务器前一个 release | `upgrade/codex-0.152.1` | `f7f7fb3dff91fd4e765500bd0a76848e7d69227e` |

主目录与活动 release 都有未提交修改，前一个 release 有未跟踪的 CDN 调试文档。先备份全部差异及非构建文件，再将这些资料分别提交到 archive 分支；没有覆盖或丢弃本地工作。

## 关系结论

旧 ACP 是 Gateway 的早期实现。旧仓在 2026-05-02 已改产品名，新 GitHub 仓库在 2026-05-04 承接主体代码，但 Git parent 链重新起头。旧仓最终版本与新仓首次主体导入的 72 个同路径文件中，50 个完全相同、22 个不同；数据库、协议、媒体、会话和权限多处直接沿用。新仓主要拆分了 HTTP、命令、附件和 worker，之后再发展 family API 路由、输出策略和 prompt/context。

没有找到明确解释“为何新建仓库而不直接改名”的决策记录；动机只在 [项目历史文档](agent-acp-migration.md) 中标为推断。没有依据名称删掉旧实现。

## 检查覆盖

| 项目 | ACP | 原 Gateway |
| --- | --- | --- |
| 默认分支及全部 branches | `main`，1 个分支 | `main`，4 个分支；三个 feature/bugfix tip 均已在主线祖先中 |
| Tags/Releases | 均为 0 | 均为 0 |
| Git commits | 78 | 36；另收回服务器后续 9 个既有提交 |
| Issues/PR | 均为 0 | 1 个已关闭 Issue #1，无 PR、无评论；原入口保留，API 备份入库 |
| README/docs | README + 6 份 docs | README、ACP/提示词/命令/Codex/Windows 文档；保留既有 CDN 实验文档 |
| 源码与配置 | TypeScript、SQLite、ACP/CLI、iLink、角色策略、`.env.example` | 继续发展同一架构，增加 family API 和模块化分层 |
| 前后端/API | 服务内嵌登录页及 HTTP API，没有独立前端 | `login-page.ts` + `http/`；没有单独前端或 OpenAPI 文件 |
| 部署/scripts | Linux systemd、安装/卸载/办公技能、Windows/run.sh | Linux systemd 及同类工具 |
| Docker/Compose | 未发现 | 未发现；当前不是容器部署 |
| Actions | workflow/run 均为 0 | workflow/run 均为 0 |
| `.gitignore`/License | 保留原文件，MIT | MIT；补上凭据备份、数据库/session 忽略规则 |
| LFS/大文件 | 无 LFS pointer，历史最大 blob 68,190 字节 | 无 LFS pointer；原公开历史最大 blob 47116 字节 |
| 同路径不同版本 | 最终树对原 Gateway 有 47 个同路径不同文件 | 当前版本不被旧文件替换；两份各自保留 |
| Credentials | 全 refs 及全部 blob 扫描 | 包括全部服务器 Git refs、未提交源码和实验文档扫描 |

`github/` 保存 API 调查资料，`agent-acp-file-comparison.json` 保存逐文件对比，`agent-acp-path-map.tsv` 保存旧最终树每个路径的去向。

## 合并后目录与映射

```text
weixin-household-gateway/
  apps/server/src/             当前 Gateway 主体代码
  tests/                       服务器已有的六项回归测试
  prompts/                     当前角色提示词
  patches/                     当前 ACP 依赖补丁
  infra/                       当前部署工具
  docs/
    server-deployment.md
    ilink-cdn-upload-investigation-2026-09-02.md
    history/
      agent-acp-migration.md
      migration-report-2026-10-04.md
      backup-manifest.json
      agent-acp-path-map.tsv
      agent-acp-snapshot.json
      agent-acp-file-comparison.json
      agent-acp-commits.txt
      credential-audit.json
      bundles/                 两个原始 Git bundle
      github/                  两仓 GitHub 元数据
  legacy/agent-acp/
    README.md                  加入历史说明的原 README
    README.original.md         原 README 字节不变
    apps/server/src/           旧源码与 protocol/schema/prompt
    docs/                      六份原设计/说明文档
    infra/                     原 Linux/Windows/systemd 文件
    .env.example、LICENSE、package.json、pnpm-lock.yaml、run.sh、tsconfig*
```

| old | new |
| --- | --- |
| ACP `apps/` | `legacy/agent-acp/apps/` |
| ACP `docs/` | `legacy/agent-acp/docs/` |
| ACP `infra/` | `legacy/agent-acp/infra/` |
| ACP 根配置/README/License/lockfile | `legacy/agent-acp/` 同名文件；原 README 另有精确副本 |
| ACP `dist/` | 原 `archive/agent-acp` 分支及 bundle 中的 `dist/`，不进入 main 快照 |
| Gateway 当前代码 | 根目录 `apps/` 等，保留当前布局 |
| 服务器既有源码修复/测试 | 当前根目录，并有独立 source/active archive refs |
| 前一个 release 的 CDN 实验 | 当前 `docs/ilink-cdn-upload-investigation-2026-09-02.md` + 独立 archive ref |
| `/opt/weixin-household-gateway-releases/current` | 活动服务转到 `/opt/weixin-household-gateway` |
| 原两份 release worktrees | 受限备份目录 `server/release-layout/`，没有删除 |
| 主目录旧 dist/node_modules | 受限备份目录 `server/root-artifacts/` |
| 服务器 `.env`、SQLite、Codex home | 原持久位置，Git 忽略；release 路径配置归并为主目录路径 |

旧快照保留 78 个非构建文件，78 个原始文件内容的 SHA256 已核对（README 用原文副本核对）。没有移除源码、设计文档、配置示例或实验结果。

省略/清理的范围：旧仓已跟踪的 16 个 `dist/` 文件仅从 main 快照中省略，原历史完整保存；node_modules、Python/cache、日志、temporary/runtime/session、真实 `.env`、数据库和 credentials 没有迁入公开 Git。没有在原 Git 对象或服务器持久数据上做激进清理。主目录的日期 `.env` 备份移入私有备份；旧 release 依赖/构建保留供回滚。

## Git 历史与备份

所有 ACP commit SHA 不变，保存在 `archive/agent-acp` 和 `archive/agent-acp-final-20260503`，没有 force-push 或历史重写。main 仅加入 final snapshot，ACP 的独立 parent 链不混入当前主线。

| 新增 archive ref | SHA |
| --- | --- |
| `archive/agent-acp` / `archive/agent-acp-final-20260503` 标签 | `73d3e48ef73babbf0d311dc7de7a5a0d81f8799a` |
| `archive/gateway-pre-migration` | `56d5229dee29bd851828beeb191b290f2ab3237f` |
| `archive/server-source-20261004` | `a367e1c0a42e5b6bd3db6b2c6529a778d2a141a2` |
| `archive/server-active-20261004` | `38a6311c75e0e428067c7f97674dcbedc37dcc3c` |
| `archive/server-cdn-research-20261004` | `a94483d5600f946ee008f6fcb187471383fe52a2` |

备份根目录：`/var/backups/weixin-household-migration-20261004T101522Z`，目录权限 `0700`。mirror、refs、原 URL、default branch、HEAD、备份时间和校验结果均已保存。[完整 manifest](backup-manifest.json)。

| bundle（备份根目录下） | SHA256 | 仓内副本 |
| --- | --- | --- |
| `weixin-household-agent-acp/weixin-household-agent-acp.bundle` | `db9a093e1f004fef50ce340452717ed1f96dbdc21e1e03f88767c7a8691e3dad` | `docs/history/bundles/agent-acp-pre-migration.bundle` |
| `weixin-household-gateway/weixin-household-gateway.bundle` | `efee092e58c0b180d9850640554c8942670891df7b183ab9f5e38e711e06d7d7` | `docs/history/bundles/gateway-pre-migration.bundle` |

两份 bundle 均独立 mirror clone 恢复、`fsck --full` 通过，恢复 refs 与原 mirror 完全一致。Git bundle 不包含 GitHub Issue/PR/Release 等元数据，所以另用 API 备份；本次无 release asset 或 LFS 数据需要另下。

服务器另有完整 Git bundle、原应用非构建文件 tar、systemd tar、SQLite 在线 backup、约 983 MB 的 persistent-data tar、原 release env 与差异 patch。凭据只留受限本地备份。最终 server worktree 移入备份时保留依赖和构建，因此能恢复原运行布局。

## Credential 结果

未发现真实 credential 出现在两个原仓库或服务器 Git 历史中。Gitleaks 8.30.1 覆盖全部 refs；补充检查 739 个独立 blob、WeChat AppID、AppSecret/token、private key，并比对当前 `.env`/SQLite 的 151 个值，结果为 0 个发现。服务器确有正常使用的 API key、微信 account/context token，它们在 `.env`、Codex home 和 SQLite 中，未提交、未输出内容。

本次没有证据需要清理 Git 历史或 rotate 已泄漏 credential。未知/已过期/已删除旧凭据无法凭扫描完全排除；若今后找到真实 secret，应按 commit/path 处理历史并 rotate，而不是只删当前文件。[检查摘要](credential-audit.json)。

## 验证结果

| 验证 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 原远端 Gateway frozen install/check/build | 全通过 | 当前已包含服务器后续版本，另验证 |
| 服务器当前源码 frozen install/check/build | 全通过 | 全通过 |
| 现有 `test:wxbot` | 6/6 通过 | 6/6 通过 |
| 当前和历史 Linux shell 语法 | 已记录原源码 | 全部通过 |
| 旧 bundle 完整恢复和 refs | 原 mirror 已验证 | 两份独立恢复通过 |
| 78 文件快照字节核对 | 原 SHA/清单已保存 | 全通过 |
| Markdown 相对链接 | 原资料保存 | 47 个路径通过 |
| systemd/当前依赖路径/HTTP health/ready | active，HTTP 200，2 个账号 | 待服务器切换验证 |
| 凭据和 runtime 不进提交 | 原历史扫描通过 | staged 导出扫描与路径排除通过；推送前全 refs 再核对 |
| `weixin-mini-program-login` | 只读指纹已保存 | 待最终指纹核对 |

原公开版本没有 tests 脚本，因此没有虚构它通过单元测试。旧 ACP 不作为活动 runtime 重新安装或修复；Windows 脚本只保留并检查路径，没有 Windows 环境实跑。原 CDN 实验记录的是第三方上传 500 问题，本次不以一次健康检查声称它已修复。没有发送微信测试消息或调用模型生成任务。

迁移前已观察到的失败项：安装、类型检查、构建与六项回归测试没有失败；有历史 CDN 上传失败实验记录，未在本次重新触发。迁移新增失败：代码安装、类型检查、构建及测试未发现新增失败；服务器切换另在最终阶段核对。

## 旧仓处理与范围

- 旧仓 README 顶部迁移通知：待主仓验证后执行。
- 旧仓 Archive：待主仓验证后执行；保留其原 private 可见性，不删除仓库。
- 最终 canonical repository：`thekfjie/weixin-household-gateway`。
- `weixin-mini-program-login` 没有纳入 fetch、merge、push、部署或配置操作；只读 HEAD/status/目录指纹在最终阶段复核。

服务器收敛结果与后续命令见 [server-deployment.md](../server-deployment.md)。
