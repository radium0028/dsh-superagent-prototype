# GitLab Source 设计规格

状态：已评审（grilling 四轮 + 事实纠错一轮，2026-11-09 敲定）
关联：[ADR-0001](../adr/0001-gitlab-source-watches-many-projects-executes-in-one.md) · [ADR-0002](../adr/0002-gitlab-identity-carries-kind-and-iid.md) · [CONTEXT.md](../../CONTEXT.md)
实施计划：[docs/plans/2026-11-09-gitlab-source.md](../plans/2026-11-09-gitlab-source.md)

为 dsh-superagent 新增 `gitlab` Source kind：通过 glab CLI 与**自建 GitLab 实例**（≥16）通信，全对等复刻 GitHub 来源闭环——Issue/MR/评论/流水线触发与准入、评论交付、执行侧分支/MR/自动合并/CI 观察、agent skill。GitHub 仍为全局必需来源；GitLab 为可选副来源（配置失败仅自身降级，语义同 Feishu）。

## 1. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 能力范围 | 全对等（issue/MR/notes/pipelines trigger、note 交付、分支/MR/auto-merge/CI watching、skill） |
| D2 | 实例 | 仅自建（gitlab.com 明确不支持），单实例单 host |
| D3 | 项目 | N 观察 + 1 执行；执行项目显式配置（与 GitHub 的 repository 字段同机制），API 规范化校验 |
| D4 | 来源地位 | 可选副来源；失败降级不阻断（feishu 模式）；打包默认 disabled（opt-in） |
| D5 | agent 邮箱 | 探测 `glab api user` 的 `commit_email`（fallback `email`），`agentEmail` 配置可覆盖；都没有时回退 `<id>-<username>@noreply.<host>` |
| D6 | pipeline 观察 | 所有 watch 项目默认分支的 pipeline；MR 自身 pipeline 独立不受该开关控制 |
| D7 | 轮询入口 | 列表 + `updated_after` 增量轮询（无 `/notifications` 等价物；Todos/Events 弃用） |
| D8 | 验收 | 伪造 glab 的单测为准；DoD 对齐 GitHub 覆盖面（代码+spec+SKILL.md+locales+打包+docs） |

次级决定（第二轮"我准备这样定"清单，用户无异议）：source id `gitlab`；admission 行 `issues/mrs/notes/pipelines`；幂等 marker 沿用 GitHub 模式；资源语法 `gitlab/projects/<path>/…`；worker 剥离 `GITLAB_TOKEN/GITLAB_ACCESS_TOKEN/OAUTH_TOKEN/GITLAB_HOST` 等。

## 2. 身份模型（ADR-0002）

- **thread key**：`gitlab:<path>#<iid>`（Issue）、`gitlab:<path>!<iid>`（MR）、`gitlab:<path>:ci:<ref>`（默认分支 pipeline，ref 含多段斜杠时原样拼接）。`<path>` 为 URL-encoding 前的明文项目路径（`group/sub/project`）。
- **trigger id**：`key()` 哈希于全局数字 id——`key('gitlab-note', String(note.id), note.updated_at ?? '')`、`key('gitlab-issue', String(issue.id))`、`key('gitlab-mr', String(mr.id))`、`key('gitlab-ci', 'branch:<path>:<ref>', String(revision))`、`key('gitlab-ci', String(mr.id), String(revision))`。GitLab 的 `id` 全局唯一，跨项目去重天然成立。
- **ChannelRef.address**：`{ project: <path>, iid: '<n>', kind: 'issue' | 'mr', discussion?: '<discussion_id>' }`。GitLab discussion 有稳定 id，比 GitHub 靠 URL 反解更直接。
- **find(query)**：接受 `<path>#<iid>`、`<path>!<iid>`、`https://<host>/<path>/-/issues/<iid>`、`…/-/merge_requests/<iid>`。裸数字因多项目×双编号空间歧义而返回空。

## 3. 配置与安装校验

### 3.1 配置 schema（settings.sources.gitlab.config）

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `host` | string，必填 | 实例域名（无 scheme），如 `gitlab.example.com` |
| `project` | string，必填 | 执行项目完整路径（可多段子群组） |
| `projects` | string[]，默认 `[]` | 其余观察项目路径；实际观察列表 = `projects ∪ {project}` |
| `cli` | string，必填 | glab 包装脚本（命令名或绝对路径，等价 gh-agent） |
| `agentEmail` | string，默认 `''` | 覆盖探测的提交邮箱 |
| `pollSeconds` | int 60（60–3600） | 轮询间隔 |
| `failuresBeforeError` | int 1（1–20） | 连续失败阈值 |
| `observeIssues/Mrs/Notes/Pipelines` | bool，默认 false | 四个观察开关，作用于全部 watch 项目 |

`GitlabAccountsSchema`（部署字段，进 `SETUP_FIELDS`，变更触发重启）：`{ host, project, projects, cli, agentEmail }`。

### 3.2 Deployment 与探测

`Deployment.gitlab?: { cli: string; host: string; login: string; email: string; project: string; projects: string[] }`（`projects` 已含执行项目，均经 API 规范化）。

`resolveGitlab(machine, gitlab, probe, path)` 流程（每步失败抛对应 SetupError）：

1. 解析配置：无 host → `gitlabHostUnset`。
2. `executable(cli)` → `gitlabAgentCliMissing`。
3. `probe([cli, 'api', 'user', '--hostname', host])` → 失败 `gitlabAgentCliSignedOut`；解析不出 `{id, username}` → `gitlabAgentCliNoAccount`。
4. 执行项目：`probe([cli, 'api', 'projects/<enc(project)>', '--hostname', host, '--jq', '{path: .path_with_namespace, level: (.permissions.project_access.access_level // .permissions.group_access.access_level // 0)}'])` → 失败 `gitlabProjectUnreadable`；解析失败 `gitlabProjectUnreported`；`level < 30` → `gitlabProjectReadOnly`；以返回的 `path` 为规范化路径。
5. 每个 watch 项目同样探测，`level < 20` 或不可读 → `gitlabWatchUnreadable {project}`。
6. `email = agentEmail || commit_email || email || '<id>-<username>@noreply.<host>'`。

glab 无 gh 的 `--jq` 差异问题（两者都内嵌 jq）；注意 `-f/-F` 语义与 gh 对调，写操作 body 一律 `--raw-field`。

### 3.3 Setup 错误码（SETUP_PROBLEMS 新增，place 均为 `gitlab`）

`gitlabHostUnset`、`gitlabAgentCliUnset`、`gitlabAgentCliMissing`、`gitlabAgentCliSignedOut`、`gitlabAgentCliNoAccount`、`gitlabProjectUnset`、`gitlabProjectUnreadable`、`gitlabProjectUnreported`、`gitlabProjectReadOnly`、`gitlabWatchUnreadable`。

降级语义：`Setup.resolve` 在 `resolveDeployment`（github，全局阻断）之后调 `resolveGitlab`，SetupError 记入 `Setup.gitlabProblem` 并 `logger.warn`，部署继续；`check()`/`checkAccounts('source:gitlab')` 与 feishu 分支同构。`Runtime.gitlabProblem` 透出给 HTTP/视图（`problemOf` 按 place 匹配，无需 per-source 视图代码）。

## 4. 命令封装（src/infra/commands.ts 新增方法，不动 gh 路径限制）

```
gitlab(): { host, cli } | undefined        // deployment.gitlab 不存在时各调用方自觉短路
gitlabApi(schema|null, path, ...flags)     // <cli> api <path> --hostname <host> …；path 以 'projects/<enc>/' 开头，防越狱守卫同 path() 风格但按项目路径参数化
gitlabPages(item, path, tally?)            // --paginate --output ndjson，逐行 JSON 解析后 validItems
```

- HTTP 错误：glab stderr 形如 `glab: <message> (HTTP <status>)`，现有 `commandError` 的 `HTTP (\d{3})` 正则已兼容，无需改 `CliError`。错误体 `message` 可能为对象——仅在需要展示时做类型守卫。
- 分页：`glab api --paginate` REST 自动 `per_page=100` 跟随 Link；机器解析固定 `--output ndjson`（`--output json` 多页时是多个数组拼接，不可解析）。
- 写操作：`-f/--raw-field`（纯字符串）传 body，杜绝 `-F` 的类型魔法把 `[`/`{` 开头文本误判为结构。

## 5. 轮询设计（src/sources/gitlab.ts）

无 GitHub 的 notifications 主入口，采用 D7。每轮顺序（沿用 `pollRound` 骨架：独立失败聚合、`failuresBeforeError` 阈值、`paused/setupPending`、`x-poll-interval` 无对应物故间隔只由配置决定）：

1. **项目列表流**（每 watch 项目、每轮）：
   - `projects/<enc>/issues?order_by=updated_at&sort=asc&per_page=100&updated_after=<since.issues>`
   - `projects/<enc>/merge_requests?order_by=updated_at&sort=asc&per_page=100&updated_after=<since.mrs>`（`view=simple` 不用：缺 author/draft 等字段）
   - `updated_at` 推进 `KV.gitlab.since(project)`（`cursorAt` 回拨 5s，horizon 14 天与 github 一致）。
   - 新开条目：`created_at >= stream started[kind]` 且作者非 agent → `issueTrigger`/`mrTrigger`；否则仅视作"变化"，进入第 2 步。
2. **变化条目的 notes 增量**：notes 无 `since` 过滤——`projects/<enc>/(issues|merge_requests)/<iid>/notes?order_by=created_at&sort=desc&per_page=100`，从新到旧遍历，`created_at < cursor` 即停（重叠靠 trigger id 幂等去重）。`system: true` 的系统 note 一律跳过。MR 另拉 `discussions` 展开 DiffNote/DiscussionNote（inline 线程：type 非 null 的 note 带 `position`）。
3. **ticket MR 观察**：`pullsOf` 对等 `mrsOf(ticket)`，`readMr` + `observeMr`（见 §8），开放 MR 再观察其 pipeline。
4. **默认分支 pipeline**（每 watch 项目，`observePipelines` 开）：`projects/<enc>` 取 `default_branch` → `pipelines/latest?ref=<branch>`（403=无 pipeline，静默）→ jobs 快照 → 失败集合变化才 `branchCiTrigger`（revision 计数器同 github）。
5. **已订阅线程轮询**：复用 `pollEach`；按 thread key 解析 project/kind/iid 读 notes 增量。

**KV.gitlab**（kv.ts 登记，store.spec 强制）：

| 键 | 类型 | 用途 |
|---|---|---|
| `gitlab-since:<project>` | `{ issues: string; mrs: string }` | 项目列表流游标 |
| `gitlab-cursor:<project>:<issue|mr>:<iid>` | string | 每线程 notes 游标 |
| `gitlab-retry` | `Record<string, GitlabRetry>` | 失败重试表（键=线程 key 字符串） |
| `gitlab-branch-ci:<project>` | `{ branch?; failures?; revision }` | 默认分支 pipeline 基线 |
| `gitlab-pipeline:<project>:<mr-iid>` | `{ fingerprint; revision }` | MR pipeline 指纹 |

## 6. Trigger 构造（src/sources/gitlab-trigger.ts）

- `UserSchema`：`{ id: number, username: string, name? }`；删除态作者 GitLab 返回的 username 为空时回退 `ghost`。
- `NoteSchema`：`{ id, body, author, created_at, updated_at, system, type, discussion_id, position? {new_path, old_path, new_line, old_line}, resolvable?, resolved? }`。
- `IssueSchema`：`{ id, iid, title, description, state, author, created_at, updated_at, web_url, labels }`。
- `MrSchema`：Issue 字段 + `{ source_branch, target_branch, sha, draft, detailed_merge_status, merge_when_pipeline_succeeds, merged_at, closed_at, head_pipeline? }`。
- `noteTrigger(note, ref, kind: 'conversation' | 'inline', agent)`：text = [`path:line`（仅 DiffNote）, body] 过滤拼接；`addressed: 'mention'` 判定复用 `mentions`；meta = `{ project, kind, iid, isMr, noteId, type?, path?, line?, discussionId? }`；`human = !sameName(username, agent)`（bot 判定交 policy bots 名单，见 §12 局限）。
- `issueTrigger`/`mrTrigger`：text = `title

description`；meta 带 `kind: 'issue' | 'mr'`。
- `branchCiTrigger`/`ciTrigger`：无收件人时无 channel（对齐 github）。
- 状态映射：`opened→open`；pipeline 状态分类——FAILING={failed}，RUNNING={created,waiting_for_resource,preparing,waiting_for_callback,pending,running,canceling}，其余（success/skipped/scheduled/manual/canceled）非失败。

## 7. 交付通道（src/sources/gitlab-channel.ts)

- `sendGitlab(host, message)`：
  - address 带 `discussion` → `POST projects/<enc>/merge_requests/<iid>/discussions/<discussion_id>/notes`（`-f body=`），否则 → `POST projects/<enc>/(issues|merge_requests)/<iid>/notes`。对 issue 上误携 discussion 的情况回退顶层 note。
  - 幂等：先 `gitlabPages` 扫本人（`sameName(author.username, login)`）+ 同 discussion + body 含 `<!-- dsh-superagent:<message.id> -->` 的 note，命中即 `'sent'`。GitLab 会 normalize body（quick action 剥离、去尾随空白），marker 是 HTML 注释不被触碰，容错匹配与 github 相同。
  - `'gone'`：CliError 404（GitLab 对无权限/已删一律 404，私有仓库语义下视为永久）或 issue/MR `state` 已关闭且锁定（403 + locked 文案）。
- `gitlabLink(address, links)`：url = `https://<links.gitlab.host>/<project>/-(issues|merge_requests)/<iid>`（address.url 优先）；label 区分 discussion。

## 8. MR 绑定与执行集成（src/sources/gitlab-mr.ts）

对等 github-pull.ts，全部限定**执行项目**（非执行项目 MR 只对话不绑定）：

- `agentMr(mr, deployment)`：`sameName(author.username, gitlab.login) && sameName(project, gitlab.project)`。
- `ticketBranch` 复用（分支末段 = DSH_SUPERAGENT_NAME）。
- `claimMr(ctx, ticketId, mr)`：合法绑定 = 工单 origin trigger 是该 MR，或 `agentMr && ticketBranch`；一个开放 MR 只绑一个开放工单。executor `orchestrator_report` 新增 `mr_iid`（int，描述指向 `$DSH_SUPERAGENT_GITLAB_PROJECT`），执行项目内唯一化（`readMr(ctx, project, iid)`）。
- `observeMr`：`state ∈ {closed, merged}` → `threadClosed('merged' | 'closed')`；facts：`autoMerge = merge_when_pipeline_succeeds`、`ci`（MR pipeline jobs 快照）。
- `mrEndNotices(ticket, request, gitlab)`：对齐 `pullEndNotices`（中英文判定、排除 `source === 'gitlab'` 的 channel、`key('mr-terminal', …)` 幂等）；`runtime.ts` 的 `ticket.ended` 钩子拼接两来源 notices。
- `cards.ts`：`mrOf(ticket)` → 卡片 `mr_iid` 字段（与 `pr_number` 并列）。
- `ChannelLinks` 类型扩展：`Partial<Pick<Deployment, 'repository' | 'feishu' | 'gitlab'>>`；`runtime.links()` 填充。

## 9. 读取资源与线程上下文（src/sources/gitlab-read.ts）

资源语法（`orchestrator_read`，resources 表新增 `gitlab/` 前缀 + 资源清单行）：

```
gitlab/projects/<path>/issues/<iid>                       描述：{iid,title,state,labels,...}
gitlab/projects/<path>/issues/<iid>/notes/<page>          分页 20/页，满页给 next_resource
gitlab/projects/<path>/mrs/<iid>                          描述 + head/target/sha/draft/detailed_merge_status/auto_merge
gitlab/projects/<path>/mrs/<iid>/notes/<page>
gitlab/projects/<path>/mrs/<iid>/discussions/<page>       线程列表（individual_note=false 的含全部 notes）
gitlab/projects/<path>/mrs/<iid>/discussion/<id>          单线程消息
gitlab/projects/<path>/mrs/<iid>/pipelines                MR pipeline 快照 {head, checks[{name,status}]}
gitlab/projects/<path>/pipelines/<ref>                    ref 最新 pipeline 快照（默认分支 CI 用）
```

`<path>` 校验：多段 `[A-Za-z0-9_.-]+(/…)*`，URL-encode 后进 API。仓库文件读取不进资源语法（worker 用 glab shim 直接 `glab api …/repository/files/…`，SKILL.md 教）。

`gitlabThreadContext`：`messageId = note.id`（String）；pipeline trigger → 单条 bot 消息；inline note → 其 discussion 全部 notes（root 的 reply_to）；否则 conversation 分页（page1 附 issue/MR 标题+描述，`per_page=100`）。

**assesssment 取舍**：`assessment.ts` 的 file/directory 资源继续读 GitHub 的 `deployment.repository`（执行环境 clone 由 prepare 决定，github 仍是必需来源）；GitLab 项目文件经由上述资源/CLI 读取。不改 `readRepositoryPath`。

## 10. Worker 隔离（src/infra/environment.ts）

- `WORKER_COMMANDS` + `glab`；`shim('glab', run(gitlab.cli))`（未配置时 fail-shim 文案同 lark-cli 风格）。
- gitconfig（仅 gitlab 配置时追加）：`[credential "https://<host>"] helper = !<cli> auth git-credential`、`[url "https://<host>/"] insteadOf = git@<host>: / ssh://git@<host>/`。`glab auth git-credential get` 为隐藏子命令（已验证存在），按 stdin 的 host 从 per-host 凭据解析。
- `agentVariables` 剥离：`GITLAB_TOKEN`、`GITLAB_ACCESS_TOKEN`、`OAUTH_TOKEN`、`GITLAB_HOST`、`GITLAB_URI`、`GL_HOST`、`GLAB_API_PROTOCOL`（防串身份——env token 优先级最高且只发 trusted host）。
- `verifyEnvironment`：gitlab 配置时同样校验 `credential.https://<host>.helper` 精确解析（gitTooOld 判定共用）。
- blockedCommands 的 fail-shim 文案在 gitlab 配置时提示 "use gh or glab"。
- **注意**：`tests/environment.spec.ts:87` 与 `tests/fixtures/host.ts:150` 对 gitconfig 内容做全量精确断言，新增段必改。

## 11. 环境变量（kind.environment）

| 变量 | 值 |
|---|---|
| `DSH_SUPERAGENT_GITLAB_HOST` | 实例域名 |
| `DSH_SUPERAGENT_GITLAB_PROJECT` | 执行项目路径 |
| `DSH_SUPERAGENT_GITLAB_PROJECTS` | 全部 watch 项目，逗号分隔 |
| `DSH_SUPERAGENT_GITLAB_ACCOUNT` | agent 用户名 |
| `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL` | agent 提交邮箱 |
| `DSH_SUPERAGENT_GITLAB_IID` | 工单来源 Issue/MR 的 iid（trigger 作用域，非 gitlab 来源为空） |

## 12. Skill 与 builtin 注册

- `skills/dsh-superagent-gitlab/SKILL.md`：frontmatter + 教 worker：`orchestrator_read` 读上表资源；评论/回复用 `glab api`（notes、discussions 回复、`-f body=`、`--hostname`）；discussion resolve 需 Developer+ 或变更作者；MR 创建 `POST projects/<enc>/merge_requests`（source_branch/target_branch/title）；创建后立即 `orchestrator_report state:progress mr_iid`；自动合并 `PUT …/merge -f merge_when_pipeline_succeeds=true`；仓库文件 `repository/files/<enc>?ref=`（base64）。
- builtin 硬编码点逐一加 `gitlab`：`skill-files.ts` bundledSkills、`context.ts` sourceSkills（Record 键类型）、`prompts.ts` PART_KEYS `skill/gitlab` + `composeSkill` + `skills()` **条件注册**（`Prompts` 构造函数加 `gitlab: () => boolean`，注册顺序 `[…feishu?, 'github', …gitlab?, …custom]`）、`sessions.ts` bindSkills、`runtime.ts` Prompts 构造传入 `() => setup.configured() && !!setup.deployment.gitlab`。
- locale key `promptPart.skill/gitlab`。

## 13. 面板与本地化

- locales 新 key：`source.gitlab`、`health.gitlab`、`problemSetupFix.gitlab`、`promptPart.skill/gitlab`、`setup.gitlabHostUnset` 等 10 个错误码文案（zh/en 成对，`tests/locales.spec.ts` 校验完整性）。
- `ticket.tsx` 图标分支：`item.source === 'gitlab' ? 'mr'/'issue' : …`。
- 来源卡片由 `kind.fields` 驱动，无 per-source 代码；`problemOf(place==='gitlab')` 自动路由到设置页。

## 14. 打包注册

- `tsdown.config.ts` entry：`'gitlab-watch': 'src/sources/gitlab.ts'`。
- `package.json` exports：`"./gitlab-watch": "./lib/gitlab-watch.js"`。
- `cordis.patch.yml` insert：`dsh-superagent-gitlab`（`name: dsh-superagent/gitlab-watch`，`disabled: true` 起）。
- `tests/bundle-patch.spec.ts:31` 顺序断言更新。
- `docs/007-architecture.md` 模块表/测试表随文件落地（docs.spec 强制同步）。

## 15. 测试计划

| spec | 覆盖 |
|---|---|
| `tests/gitlab-trigger.spec.ts` | thread key/address/URL 解析、trigger 构造（note/issue/mr/ci）、状态映射、mentions、system note 跳过 |
| `tests/gitlab-read.spec.ts` | 资源语法（含拒绝样例 `../`、越权 project）、notes 分页 next_resource、discussion 读取、pipeline 快照/summary、threadContext（vi.spyOn(commands,'gitlabApi') 风格，同 github-read.spec） |
| `tests/commands.spec.ts` 扩展 | gitlabApi path 守卫、ndjson 分页、`-f` body、link 构建、sendGitlab 幂等/gone |
| `tests/deployment.spec.ts` 扩展 | resolveGitlab 全错误码、规范化路径、email 探测链 |
| `tests/environment.spec.ts` 扩展 | gitlab 段 gitconfig、glab shim、env 剥离、verify |
| `tests/gitlab-mr.spec.ts` | agentMr/claimMr/observeMr/mrEndNotices |
| `tests/gitlab-source.spec.ts` | pollRound 全链路（列表增量、notes 截断、pipeline revision、retry/abandon） |
| 既有 spec 更新 | prompts（顺序/占名）、bundle-patch、locales、store(KV)、model-surface（资源前缀枚举 + seed）、fixtures host/panel-server/deployment |

伪造 glab：沿用 fixtures `program()`/answers 表（argv join 后匹配，如 `<cli> api user --hostname gitlab.example.com`）。

## 16. 用户文档变更预案（与代码同批提交）

- `docs/001-domain.md`：Source/Channel 表各加 GitLab 行。
- `docs/002-authorization.md`：Admission 行枚举加 GitLab（new Issues, merge requests, notes, default-branch pipelines）；bots 段补"GitLab 用 Policy bots 名单（API 无 bot 标记）"。
- `docs/003-execution.md`：环境变量表加 6 个 GITLAB 变量。
- `docs/006-deployment.md`：Prerequisites（glab 版本 ≥1.90 建议 1.92）、Accounts（glab-agent 包装、`glab auth login --hostname`）、blocks 表（`source:gitlab` 字段）、admission 行键、health 表（`gitlab`）、Troubleshooting（10 个错误码）、prepare 示例。
- `docs/007-architecture.md`：模块表 + 测试表 + （如索引提及）新增行。
- `docs/008-cookbook.md`：Add a Source 配方不变（gitlab 是正式来源非配方案例）。

## 17. 非目标、假设与风险

**非目标**：gitlab.com；webhook 推送；keyset 分页；多实例；全多仓执行；Todos/Events 轮询；`glab <1.90` 兼容承诺。

**假设**：实例版本 ≥16（`updated_after`、discussions、draft、detailed_merge_status(15.6+) 均可用）；反向代理不解码 `%2F`。

**已知风险与对策**：
1. notes 无增量过滤 → desc 截断 + id 幂等，重读成本 = 每 changed 条目一页。
2. 16–18 内嵌 author 无 bot 标记 → policy bots 名单承担；ContextMessage 不标 bot（评估器依赖 gate）。
3. GitLab 404 混淆"不存在/无权限" → channel 404 判 gone 可能误杀偶发权限抖动；用 retry 表 24h 放弃机制兜底（与 github 一致）。
4. `detailed_merge_status` 枚举随版本增长 → schema 用 string + 白名单映射，未知值显示原文。
5. events/todos 均不用的决定依赖"列表增量足够"——若项目条目数巨大（>10000），offset 分页头部开销增大；观察 `x-total`，必要时二期 keyset。
