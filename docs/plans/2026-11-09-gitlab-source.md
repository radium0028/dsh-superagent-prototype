# GitLab Source Implementation Plan

> **For agentic workers:** 本计划由当前会话内联执行（TDD，逐任务红-绿-提交）。步骤用 checkbox 跟踪。
> 与 writing-plans 模板的偏差：代码步骤给出**契约与骨架**（签名、键名、正则、断言样例）而非全文实现——实现者即本会话，设计依据见 [docs/design/gitlab-source.md](../design/gitlab-source.md)。

**Goal:** 为 dsh-superagent 新增 `gitlab` Source kind（自建 GitLab + glab CLI，全对等 GitHub 闭环）。

**Architecture:** 新建 `src/sources/gitlab{,-trigger,-channel,-read,-mr}.ts` 五件套镜像 github 同构文件；infra 层扩展 `Commands`（glab api/pages）、`Deployment.gitlab`（resolveGitlab 探测）、`environment`（glab shim/凭据/剥离）；app 层在 resources/cards/runtime/executor/prompts 等既有 github 接线点并列接入；打包注册 `gitlab-watch` 插件（默认 disabled）。

**Tech Stack:** TypeScript (es2024/esm) · zod · vitest · cordis 插件机制 · glab ≥1.90（实测 1.92）· GitLab ≥16 REST API v4

**验证命令**：`pnpm vitest run <spec>`（单任务）/ `pnpm typecheck` / `pnpm check`（typecheck+test+build，收尾必须全绿）

---

### Task 1: gitlab-trigger.ts（纯函数层）

**Files:** Create `src/sources/gitlab-trigger.ts`, `tests/gitlab-trigger.spec.ts`

- [ ] **1.1 写失败测试**：`SOURCE='gitlab'`；`gitlabAddress(url, host)` 解析 `https://<host>/group/sub/proj/-/issues/12`、`…/-/merge_requests/34#note_56`、`<host>/<path>/-/merge_requests/34/discussions` → `{project, iid, kind}`；它站 host/裸路径返回 undefined。`threadKey({project,iid,kind})` → `gitlab:group/sub/proj#12` / `gitlab:group/sub/proj!34`；`parseThread('gitlab:a/b!7')` → `{project:'a/b', iid:7, kind:'mr'}`。`noteTrigger/issueTrigger/mrTrigger/branchCiTrigger/ciTrigger` 构造断言（threads/actor/human/addressed/meta/channel；system note 被 `intake` 层跳过的判定函数 `isHumanNote`）。pipeline 状态映射 `pipelineClass(status)`。
- [ ] **1.2 跑** `pnpm vitest run tests/gitlab-trigger.spec.ts` → FAIL（模块不存在）
- [ ] **1.3 实现**：导出 `SOURCE, gitlabChannel(project,iid,kind,discussion?), gitlabAddress, gitlabPage(host,project,iid,kind), threadKey, parseThread, UserSchema, NoteSchema, IssueSchema, MrSchema, isHumanNote, notePlace(note), noteTrigger, issueTrigger, mrTrigger, branchCiTrigger, ciTrigger, mentions`。trigger id 前缀 `gitlab-note/gitlab-issue/gitlab-mr/gitlab-ci`。
- [ ] **1.4 跑** → PASS；`pnpm typecheck`
- [ ] **1.5 提交** `feat(gitlab): identity and trigger constructors`

### Task 2: Commands 的 glab 封装

**Files:** Modify `src/infra/commands.ts`；`tests/commands.spec.ts`

- [ ] **2.1 失败测试**：`gitlabApi(z.looseObject({id:z.number()}), 'user')` 调 `<cli> api user --hostname <host>`；path 守卫拒绝 `../`、`^[a-z]+:`、绝对路径与不以 `projects/` 开头的路径；`gitlabPages` 以 `--paginate --output ndjson` 发请求并逐行解析两页数据；无 `deployment.gitlab` 时抛错。
- [ ] **2.2 跑** → FAIL → **2.3 实现** `gitlabApi`（重载 schema/raw）+ `gitlabPages(item, path, tally?)`（ndjson 按行 JSON.parse，validItems 过滤）→ PASS → 提交 `feat(gitlab): glab command wrapper`

### Task 3: KV.gitlab

**Files:** Modify `src/kv.ts`；`tests/store.spec.ts`（如断言 KV 登记）

- [ ] **3.1** 增加 `KV.gitlab = { since: family<{issues:string;mrs:string},[project:string]>('gitlab-since:'), cursor: family<string,[project:string,kind:string,iid:number]>('gitlab-cursor:'), retries: record<Record<string,GitlabRetry>>('gitlab-retry'), branchCi: family<{branch?:string;failures?:string[];revision:number},[project:string]>('gitlab-branch-ci:'), pipeline: family<{fingerprint:string;revision:number},[project:string,iid:number]>('gitlab-pipeline:') }`；`GitlabRetry` 定义于 gitlab.ts 后回填 import（或本地定义）。跑全量 `pnpm vitest run tests/store.spec.ts` → 提交 `feat(gitlab): KV namespace`

### Task 4: resolveGitlab + 错误码

**Files:** Modify `src/deployment.ts`、`src/setup.ts`；`tests/deployment.spec.ts`

- [ ] **4.1 失败测试**：伪造 glab 脚本（`case "$*"` 应答 `api user --hostname …`、`api projects/g%2Fp --hostname … --jq …`）；逐错误码断言（10 个，见设计 §3.3）；成功路径断言 `Deployment.gitlab = {cli,host,login,email,project,projects}`、路径规范化、email 链 `agentEmail > commit_email > email > 回退`。`SetupPlace` 含 `'gitlab'`。
- [ ] **4.2 跑** → FAIL → **4.3 实现** `GitlabAccountsSchema`（host regex `^[A-Za-z0-9][A-Za-z0-9.-]*$`、project 多段、projects 数组去重含 project）、`resolveGitlab`、`SETUP_FIELDS.gitlab`、SETUP_PROBLEMS 10 码 → PASS → 提交 `feat(gitlab): deployment probing and setup codes`

### Task 5: Setup 降级分支 + runtime 透出

**Files:** Modify `src/app/setup.ts`、`src/app/runtime.ts`、`src/app/http.ts`（accounts 展示）

- [ ] **5.1** `Setup.gitlabProblem` 字段 + `resolve()` 内 feishu 式 catch；`check()`、`checkAccounts('source:gitlab')` 分支；`Runtime.gitlabProblem` getter；http state.accounts 增 gitlab 概要。测试：扩 `tests/http.spec.ts`（PUT `source:gitlab` 坏配置 → 400 setup place gitlab）→ FAIL → 实现 → PASS → 提交 `feat(gitlab): degraded optional source setup`

### Task 6: gitlab-read.ts + 资源路由

**Files:** Create `src/sources/gitlab-read.ts`、`tests/gitlab-read.spec.ts`；Modify `src/app/resources.ts`

- [ ] **6.1 失败测试**（风格同 github-read.spec，`vi.spyOn(commands,'gitlabApi')`）：八种资源语法（设计 §9 表）+ 拒绝样例（`../`、隐藏路径、非白名单 section、issue 上请求 discussions/pipelines）；notes 分页 20/页满页 `next_resource`；`pipelineSnapshot`（jobs→checks、failing/running 计数）、`pipelineSummary` 文案；`gitlabThreadContext`（pipeline→单条 bot 消息；inline→discussion 全 notes 带 reply_to；conversation page1 附描述）。
- [ ] **6.2 跑** → FAIL → **6.3 实现** `readGitlab(commands, resource)`、`pipelineSnapshot/pipelineSummary/pipelineFact/pipelineFailures`、`gitlabThreadContext`；resources.ts 注册 `['gitlab/', …]` 与资源清单行 → PASS → 提交 `feat(gitlab): read resources and thread context`

### Task 7: gitlab-channel.ts

**Files:** Create `src/sources/gitlab-channel.ts`；`tests/commands.spec.ts` 扩展

- [ ] **7.1 失败测试**：`sendGitlab` 顶层 note / discussion 回复两条 POST 路径与 `-f body=` 断言；幂等扫描命中返回 `'sent'` 不再 POST；404→`'gone'`；`gitlabLink` 有/无 links.gitlab、discussion 文案。
- [ ] **7.2 跑** → FAIL → **7.3 实现** → PASS → 提交 `feat(gitlab): outbound note channel`

### Task 8: gitlab-mr.ts + cards/executor/runtime 接线

**Files:** Create `src/sources/gitlab-mr.ts`、`tests/gitlab-mr.spec.ts`；Modify `src/app/cards.ts`、`src/app/tools/executor.ts`、`src/app/runtime.ts`、`src/sources/kind.ts`（ChannelLinks 加 `'gitlab'`）

- [ ] **8.1 失败测试**：`agentMr`（执行项目+作者判定）、`claimMr`（origin MR / 分支匹配 / 重复绑定拒绝三态）、`observeMr`（closed/merged→threadClosed；facts autoMerge/ci）、`mrEndNotices`（中英文、排除 gitlab channel、幂等 id）。executor：`orchestrator_report` schema 增 `mr_iid`，未配置 gitlab 时报错文案。cards：`mrOf` → `mr_iid` 字段。
- [ ] **8.2 跑** → FAIL → **8.3 实现**：`mrsOf/mrOf/readMr/agentMr/claimMr/observeMr/mrEndNotices`；executor host 增 `gitlab?: SourceContext`（runtime toolHost `get gitlab()`，未配置为 undefined）；runtime `ticket.ended` 钩子拼接 `mrEndNotices`；`links()` 填 `gitlab` → PASS → 提交 `feat(gitlab): MR binding and execution integration`

### Task 9: environment 隔离

**Files:** Modify `src/infra/environment.ts`；`tests/environment.spec.ts`；`tests/fixtures/host.ts`（answers 表 + gitconfig 断言）

- [ ] **9.1 失败测试**：配置 gitlab 时 gitconfig 追加 credential/insteadOf 段（全量断言更新）；`glab` shim 存在（未配置时 fail-shim）；`agentVariables` 剥离 7 个 env；`verifyEnvironment` 校验 gitlab helper。
- [ ] **9.2 跑** → FAIL → **9.3 实现**（`writeEnvironment` 签名扩为 `Pick<Deployment,'stateDir'|'repository'|'github'|'feishu'|'gitlab'>`）→ PASS → 提交 `feat(gitlab): worker isolation and credentials`

### Task 10: gitlab.ts kind + 轮询 + 插件入口

**Files:** Create `src/sources/gitlab.ts`、`tests/gitlab-source.spec.ts`；Modify `src/kv.ts`（GitlabRetry import 定稿）

- [ ] **10.1 失败测试**（风格仿 tests/sources.spec.ts 的 pollRound 驱动）：项目列表增量（issues/MRs 各游标推进、新开条目触发、started 开关裁剪、agent 自身条目跳过）；notes desc 截断（旧 note 不再消费、system note 跳过）；MR 绑定观察调用；默认分支 pipeline revision 触发与基线；重试/放弃路径；`scopeOf` 行映射 `issues/mrs/notes/pipelines`；kind 定义字段完整（schema 默认值、fields、policy rows、environment values、facts）。
- [ ] **10.2 跑** → FAIL → **10.3 实现**：`gitlabKind` 全量 + `watch/pollRound/pollProjects/intakeNotes/pollTicketMrs/pollBranchPipelines/pollThreads` + `export const name='dsh-superagent-gitlab'; inject=['orchestrator']; apply(ctx)` → PASS → 提交 `feat(gitlab): source kind and polling loop`

### Task 11: builtin skill 注册 + SKILL.md

**Files:** Create `skills/dsh-superagent-gitlab/SKILL.md`；Modify `src/app/skill-files.ts`、`src/app/context.ts`、`src/app/prompts.ts`、`src/app/sessions.ts`、`src/app/runtime.ts`（Prompts 构造 gitlab flag）；`tests/prompts.spec.ts`

- [ ] **11.1 失败测试**：`composeSkill('gitlab')` 内置文本；`skills()` 在 gitlab 配置时含 `['github','gitlab',…]`、未配置时不含；占名拒绝；PART_KEYS 含 `skill/gitlab`；override 校验。
- [ ] **11.2 跑** → FAIL → **11.3 实现** + SKILL.md（内容要点见设计 §12）→ PASS → 提交 `feat(gitlab): bundled skill and prompt wiring`

### Task 12: locales + 面板细节

**Files:** Modify `src/client/locales.ts`、`src/client/ticket.tsx`；`tests/locales.spec.ts`

- [ ] **12.1** 新 key：`source.gitlab`、`health.gitlab`、`problemSetupFix.gitlab`、`promptPart.skill/gitlab`、`setup.gitlab*` ×10；ticket 图标分支 → 跑 locales.spec → FAIL → 实现 → PASS → 提交 `feat(gitlab): panel localization`

### Task 13: 打包注册 + 用户文档（同批，docs.spec 同步）

**Files:** Modify `tsdown.config.ts`、`package.json`、`cordis.patch.yml`、`docs/001-domain.md`、`docs/002-authorization.md`、`docs/003-execution.md`、`docs/006-deployment.md`、`docs/007-architecture.md`；`tests/bundle-patch.spec.ts`

- [ ] **13.1 失败测试**：bundle-patch 顺序断言加入 `dsh-superagent-gitlab`（disabled）；docs.spec 全绿（007 两表随新文件加行）。
- [ ] **13.2 实现**：entry/exports/patch insert + 六份文档按设计 §16 变更点更新 → `pnpm vitest run tests/bundle-patch.spec.ts tests/docs.spec.ts` PASS → 提交 `feat(gitlab): packaging and documentation`

### Task 14: fixtures 全量接入 + 收尾验收

**Files:** Modify `tests/fixtures/host.ts`、`tests/fixtures/panel-server.ts`、`tests/fixtures/deployment.ts`、`tests/model-surface.spec.ts`、`tests/runtime.spec.ts`（按需）

- [ ] **14.1** `testDeployment` 增 gitlab 段；host/panel-server answers 表补 glab 命令；model-surface 资源前缀枚举加 `gitlab`、settings seed 双来源、credential 断言更新。
- [ ] **14.2 收尾**：`pnpm check` 全绿（typecheck + 全部测试 + build）；手工核对 cordis.patch.yml 与 package.json exports 一致。
- [ ] **14.3 提交** `test(gitlab): full fixture integration` —— 完工。

## Self-Review 记录

- **覆盖**：设计 §2→T1，§3→T4/5，§4→T2，§5/6→T10，§7→T7，§8→T8，§9→T6，§10→T9，§11→T10(env)/T8(cards)，§12→T11，§13→T12，§14→T13，§15→各任务 spec，§16→T13，§17→无需任务。
- **类型一致性**：`Deployment.gitlab` 字段名（host/login/email/project/projects）在 T4/T8/T9/T10 间一致；KV 键名 T3=T10；错误码 T4=T12。
- **已知约束**：environment.spec/host.ts 的全量断言在 T9 同步；007 表格在 T13 随文件同步（docs.spec）。
