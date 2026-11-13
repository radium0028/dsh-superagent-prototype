/** GitLab source kind definition, project-stream and thread polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { gitlabThreadContext, pipelineCounts, pipelineFact, pipelineFailures, pipelineSnapshot, pipelineSummary } from './gitlab-read.ts'
import { branchCiTrigger, ciTrigger, IssueSchema, isSystemNote, issueTrigger, MrSchema, mrTrigger, NoteSchema, noteTrigger,
  parseThread, SOURCE, threadKey, type GitlabIssue, type GitlabMr, type GitlabNote, type NoteRef } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { mrsOf, observeMr, readMr, type MrRecord } from './gitlab-mr.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(1),
  observeIssues: z.boolean().default(false), observeMrs: z.boolean().default(false),
  observeNotes: z.boolean().default(false), observePipelines: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mrs: 'observeMrs', notes: 'observeNotes', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  // A default-branch pipeline transition names its ref; a merge request's own pipeline is observed with the merge request.
  if (meta.ci === true) return typeof meta.ref === 'string' ? 'pipelines' : undefined
  // A note carries the iid and kind of its Issue or merge request, and is its own admission row.
  if (typeof meta.noteId === 'number') return 'notes'
  if (meta.kind === 'issue') return 'issues'
  return meta.kind === 'mr' ? 'mrs' : undefined
}
/** A discussion thread of a merge request; its notes carry the discussion id a reply addresses. */
const DiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(z.unknown()).nullish() })
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收监听项目里发给它的 Issue、合并请求和讨论，以及默认分支的流水线变化。', en: 'The agent\'s GitLab accounts; receives Issues, merge requests, and discussion addressed to it in the watched projects, and the default branches\' pipeline changes.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', label: { zh: '实例域名', en: 'Instance host' },
      hint: { zh: '仅自建实例，如 gitlab.example.com。保存时检查智能体账号能否推送执行项目，然后重启 dsh-superagent。', en: 'A self-built instance only, such as gitlab.example.com. Saving checks that the agent account can push to the execution project, then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', label: { zh: '执行项目', en: 'Execution project' },
      hint: { zh: '完整项目路径，可含子群组。智能体在这里开合并请求、执行工单；保存时检查智能体账号能否推送它，然后重启 dsh-superagent。', en: 'The full project path, with subgroups as needed. The agent opens its merge requests and runs tickets here; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'projects', type: 'rows', label: { zh: '其余监听项目', en: 'Other watched projects' },
      hint: { zh: '执行项目之外只监听不执行的项目路径；这些项目只需智能体账号可读。', en: 'Paths of projects that are only listened to, not executed in; the agent account needs read access to them.' },
      columns: [{ key: 'path', type: 'text', label: { zh: '项目路径', en: 'Project path' }, pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)*' }] },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GITLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存时检查它登录的账号能否推送执行项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving checks that this account can push to the execution project, then restarts dsh-superagent.' } },
    { key: 'agentEmail', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' }, advanced: true,
      hint: { zh: '留空时用 glab 登录账号的提交邮箱，都没有时回退实例的无回复地址。', en: 'When empty, the signed-in account\'s commit email, falling back to the instance\'s no-reply address.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'GitLab 来源没有服务器建议间隔，只由这里决定。', en: 'The GitLab Source has no server-suggested interval; this setting alone decides.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the projects' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the projects' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and diff comments on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branches\' pipelines' },
      hint: { zh: '打开后，每个监听项目默认分支的流水线失败和恢复会收到，由策略的接收表决定是否成为候选。合并请求自身的流水线不受这个开关控制。', en: 'Failures of each watched project\'s default-branch pipeline, and their recovery, are received, and the Policy\'s admission table decides whether they become candidates. A merge request\'s own pipeline is independent of this switch.' } }],
  // What the Source observes across the projects it watches; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `<path>#12`, `<path>!12`, or the page of an Issue or merge request names that thread; a bare number names nothing,
  // because Issues and merge requests number in separate sequences across many projects.
  find: query => {
    const text = query.trim()
    const issue = /^([^\s#]+)#(\d+)$/.exec(text)
    const merge = /^([^\s!]+)!(\d+)$/.exec(text)
    const page = /^https:\/\/[^/]+\/(.+)\/-\/(issues|merge_requests)\/(\d+)\/?$/i.exec(text)
    const item = issue ? { project: issue[1]!, iid: Number(issue[2]), kind: 'issue' as const }
      : merge ? { project: merge[1]!, iid: Number(merge[2]), kind: 'mr' as const }
        : page ? { project: page[1]!, iid: Number(page[3]), kind: page[2]!.toLowerCase() === 'merge_requests' ? ('mr' as const) : ('issue' as const) }
          : undefined
    return item ? { threads: [threadKey(item.project, item.iid, item.kind)], terms: [] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+(\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。GitLab 的 API 不标记机器人账号，所以自动账号要写在这里。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the projects on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted. GitLab\'s API does not flag bot accounts, so automated accounts are named here.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+(\\[bot\\])?' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request, or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mrs', { zh: '新合并请求', en: 'New merge requests' }),
        row('notes', { zh: '评论', en: 'Comments' }),
        // Pipelines have no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'pipelines', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' },
          note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例的域名；glab 与 git 都以它访问实例', en: 'Domain of the GitLab instance; glab and git reach it by this host' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '执行项目的完整路径；智能体在这里开合并请求，工单报告用 mr_iid 命名这里的合并请求', en: 'The execution project\'s full path; the agent opens its merge requests here, and a ticket report names one by mr_iid in it' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECTS', description: { zh: '全部监听项目的路径，逗号分隔', en: 'Every watched project\'s path, separated by commas' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除自动合并外的 GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求的 iid；工单不是从 GitLab 来的时为空', en: 'iid of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const thread = trigger?.threads[0]
      const parsed = thread?.source === SOURCE ? parseThread(`${SOURCE}:${thread.id}`) : undefined
      const iid = parsed?.iid ?? (thread?.source === SOURCE && typeof trigger?.meta.iid === 'number' ? trigger.meta.iid : undefined)
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_PROJECTS: (gitlab?.projects ?? []).join(','), DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.email ?? '', DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** True when GitLab answers HTTP 404, which it returns for a deleted or inaccessible private item alike. */
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 404
function account(ctx: SourceContext): { login: string; host: string; project: string; projects: string[] } {
  const gitlab = ctx.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working glab CLI')
  return gitlab
}
function available(ctx: SourceContext): boolean {
  // GitLab is an optional second source: a setup that keeps failing pauses only this Source, like the Feishu bot.
  if (ctx.configured() && ctx.deployment.gitlab) return true
  ctx.report('gitlab', ctx.problem ? { state: 'paused', detail: ctx.problem.detail }
    : health('paused', ctx.configured() ? 'sourceOff' : 'setupPending'))
  return false
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  mrs: Map<string, Promise<MrRecord>>; read: Set<string>; failures: string[]; dropped: string[]; abandoned: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, mrs: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const RETRY_WINDOW_MS = 24 * 3600_000
/** Records a failed read on the Thread and in the round; a thread GitLab answers 404 for, or one abandoned (24h+), does not fail the round. */
function failed(ctx: SourceContext, round: Round, ref: string, error: unknown, abandoned = false): void {
  if (gone(error)) round.dropped.push(ref)
  else if (abandoned) round.abandoned.push(ref)
  else round.failures.push(`${ref}: ${String(error)}`)
  ctx.threads.patch(ref, { pollError: String(error) })
}
/** The watched projects' list streams; GitLab has no notifications, so each project's issues and merge requests are read incrementally. */
const streams = (config: GitlabConfig) => [
  { kind: 'issues' as const, kindId: 'issue' as const, observed: config.observeIssues, schema: IssueSchema, path: 'issues' },
  { kind: 'mrs' as const, kindId: 'mr' as const, observed: config.observeMrs, schema: MrSchema, path: 'merge_requests' },
]
/** Polls every watched project's issues and merge requests streams; each stream reads from when it was switched on and fails independently. */
async function pollProjects(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  for (const project of ctx.deployment.gitlab?.projects ?? []) {
    if (stopped(ctx, round)) return
    try { await pollProject(ctx, round, project, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project}: ${String(error)}`) }
  }
}
/**
 * Polls one project's issues and merge requests lists (oldest first) since their cursors with `updated_after`, and steps
 * each cursor to five seconds before its newest item (`cursorAt`), relying on Trigger ID deduplication so repeated
 * messages are no-ops. Items from before the cursor (the stream's start) or beyond the horizon are only changes: their
 * notes are read, but they bring no Issue or merge request description.
 */
async function pollProject(ctx: SourceContext, round: Round, project: string, config: GitlabConfig): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const enc = encodeURIComponent(project)
  const stored = ctx.state.get(KV.gitlab.since(project))
  // A cursor older than the polling horizon reads from the horizon on the hour, so a long outage costs one bounded read.
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const { login } = account(ctx)
  const cursors: { issues: string; mrs: string } = { issues: stored?.issues ?? '', mrs: stored?.mrs ?? '' }
  for (const stream of streams(config)) {
    if (stopped(ctx, round)) return
    const at = cursors[stream.kind]
    const since = new Date(Math.max(Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.parse(round.started), horizon)).toISOString()
    const listed = await commands.gitlabApi(z.array(z.unknown()),
      `projects/${enc}/${stream.path}?order_by=updated_at&sort=asc&per_page=100&updated_after=${encodeURIComponent(since)}`)
    const items = validItems(stream.schema, listed, round.tally)
    let newest = Date.parse(since)
    for (const item of items) {
      // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      newest = Math.max(newest, Date.parse(item.updated_at))
      const kind = stream.kindId
      // An item opened by someone else since the cursor brings its title and description; the agent's own does not.
      // Its notes are still read — a person's note on the agent's own item is a trigger like any other, and the
      // item may have no subscribed Thread for the thread poll to have read it.
      if (Date.parse(item.created_at) >= Date.parse(since) && !sameName(item.author.username, login)) {
        await ctx.receive(stream.kind === 'mrs' ? mrTrigger(item as GitlabMr, login, project) : issueTrigger(item, login, project))
      }
      await intakeNotes(ctx, { project, iid: item.iid, isMr: stream.kind === 'mrs' },
        ctx.state.get(KV.gitlab.cursor(project, kind, item.iid)) ?? since, round)
      if (stream.kind === 'mrs') await observeMr(ctx, { ...(item as GitlabMr), project, iid: item.iid })
      nameThread(ctx, project, item.iid, kind, item.title)
      round.read.add(threadKey(project, item.iid, kind))
      ctx.state.set(KV.gitlab.cursor(project, kind, item.iid), cursorAt(round.started))
    }
    // The cursor steps back five seconds before the newest item so late-arriving remote events are not missed.
    const moved = cursorAt(new Date(newest).toISOString())
    cursors[stream.kind] = Date.parse(moved) > Date.parse(since) ? moved : since
  }
  // Only the observed streams advance; the others keep their position for when they are switched on.
  if (streams(config).some(stream => stream.observed)) ctx.atomic(() => ctx.state.set(KV.gitlab.since(project), cursors))
}
/**
 * Reads a merge request's discussion threads and the Issue or merge request conversation newest note first, stopping at
 * `since`; the overlap with the last read is deduplicated by Trigger ID. GitLab has no `since` filter for notes, so the
 * read walks down from the newest note. System records and the agent's own notes are skipped.
 */
async function intakeNotes(ctx: SourceContext, ref: NoteRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = account(ctx)
  const enc = encodeURIComponent(ref.project)
  // Diff and discussion notes live in discussion threads, which only merge requests have.
  if (ref.isMr) {
    const discussions = await commands.gitlabPages(DiscussionSchema, `projects/${enc}/merge_requests/${ref.iid}/discussions?per_page=100`, round.tally)
    const inline = discussions.flatMap(discussion => validItems(NoteSchema, discussion.notes ?? [], round.tally)
        .filter(note => !isSystemNote(note)).map(note => ({ note, discussionId: discussion.id })))
      .sort((a, b) => Date.parse(a.note.created_at) - Date.parse(b.note.created_at)).reverse()
    for (const { note, discussionId } of inline) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (Date.parse(note.created_at) < Date.parse(since)) break
      if (sameName(note.author.username, login)) continue
      await ctx.receive(noteTrigger(note, { ...ref, discussionId }, note.type ? 'inline' : 'conversation', login))
    }
  }
  const listed = await commands.gitlabApi(z.array(z.unknown()),
    `projects/${enc}/${ref.isMr ? 'merge_requests' : 'issues'}/${ref.iid}/notes?order_by=created_at&sort=desc&per_page=100`)
  const notes = validItems(NoteSchema, listed, round.tally)
  for (const note of notes) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (Date.parse(note.created_at) < Date.parse(since)) break
    if (isSystemNote(note) || sameName(note.author.username, login)) continue
    await ctx.receive(noteTrigger(note, { ...ref }, 'conversation', login))
  }
}
/** Polls the merge requests of open tickets; each is read at most once per round, and an open one's pipeline is polled. */
export async function pollTicketMrs(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const refs = [...new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)).map(ref => `${ref.project}!${ref.iid}`))]
    .map(name => ({ project: name.slice(0, name.lastIndexOf('!')), iid: Number(name.slice(name.lastIndexOf('!') + 1)) }))
  for (const ref of refs) {
    if (stopped(ctx, round)) return
    try {
      const mr = await pull(ctx, round, ref)
      if (mr.state !== 'closed' && mr.state !== 'merged' && !mr.merged_at) await pollMrPipeline(ctx, round, mr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, threadKey(ref.project, ref.iid, 'mr'), error) }
  }
}
/** Reads and observes a merge request at most once per polling round. */
function pull(ctx: SourceContext, round: Round, ref: { project: string; iid: number }): Promise<MrRecord> {
  const id = `${ref.project}!${ref.iid}`
  let read = round.mrs.get(id)
  if (!read) {
    read = readMr(ctx, ref.project, ref.iid, round.signal).then(async mr => { await observeMr(ctx, mr); return mr })
    round.mrs.set(id, read)
  }
  return read
}
/** Polls a merge request's pipeline; only changes after the first baseline observation become Triggers. */
async function pollMrPipeline(ctx: SourceContext, round: Round, mr: MrRecord): Promise<void> {
  const snapshot = await pipelineSnapshot(ctx.commands.withSignal(round.signal), mr.project, mr.sha ?? mr.source_branch, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.gitlab.pipeline(mr.project, mr.iid))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) {
    await ctx.receive(ciTrigger({ project: mr.project, iid: mr.iid, web_url: mr.web_url, author: mr.author.username }, revision,
      pipelineSummary(snapshot, `MR ${mr.project}!${mr.iid}`, `gitlab/projects/${encodeURIComponent(mr.project)}/mrs/${mr.iid}/pipelines`)))
  }
  ctx.state.set(KV.gitlab.pipeline(mr.project, mr.iid), { fingerprint, revision })
  ctx.threads.describe(threadKey(mr.project, mr.iid, 'mr'), { facts: { ci: pipelineFact(pipelineCounts(snapshot)) } })
}
/** Polls every watched project's default-branch pipeline; a change of its failed jobs after the first baseline becomes a Trigger. */
async function pollBranchPipelines(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  const projects = ctx.deployment.gitlab?.projects ?? []
  if (!config?.observePipelines) {
    // Switched off, clear each failure baseline but preserve the revision counter so future triggers have unique IDs.
    for (const project of projects) {
      const seen = ctx.state.get(KV.gitlab.branchCi(project))
      if (seen) ctx.state.set(KV.gitlab.branchCi(project), { revision: seen.revision })
    }
    return
  }
  for (const project of projects) {
    if (stopped(ctx, round)) return
    try {
      const commands = ctx.commands.withSignal(round.signal)
      const enc = encodeURIComponent(project)
      const { default_branch: branch } = await commands.gitlabApi(z.looseObject({ default_branch: z.string() }), `projects/${enc}`)
      // A ref without a pipeline (GitLab answers 403 or 404) reads as an empty snapshot.
      const snapshot = await pipelineSnapshot(commands, project, branch, round.tally)
      const previous = ctx.state.get(KV.gitlab.branchCi(project))
      // The first observation after switching on or renaming the default branch establishes the baseline.
      const known = previous?.branch === branch ? previous.failures : undefined
      const failures = pipelineFailures(snapshot)
      const counts = pipelineCounts(snapshot)
      // Retain previous failures while jobs are still running so recovery is reported only once every job passes.
      const now = failures.length || !counts.running ? failures : known ?? []
      let revision = previous?.revision ?? 0
      if (known && JSON.stringify(now) !== JSON.stringify(known)) {
        revision += 1
        const sha = snapshot.head
        const summary = pipelineSummary(snapshot, branch, `gitlab/projects/${enc}/pipelines/${branch}`)
        await ctx.receive(branchCiTrigger(project, branch, sha, revision, summary, `https://${account(ctx).host}/${project}/-/commit/${sha}`))
        ctx.threads.describe(`gitlab:${project}:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: pipelineFact(counts) } })
      }
      ctx.state.set(KV.gitlab.branchCi(project), { branch, failures: now, revision })
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project} default branch pipeline: ${String(error)}`) }
  }
}
function nameThread(ctx: SourceContext, project: string, iid: number, kind: 'issue' | 'mr', title: string): void {
  const ref = threadKey(project, iid, kind)
  const label = `${project}${kind === 'mr' ? '!' : '#'}${iid}`
  ctx.threads.patch(ref, { title })
  ctx.threads.describe(ref, { label: `${label} ${title}`, facts: { number: { value: label } } })
}
/** Polls subscribed Issue and merge request Threads not already read in this round; a thread GitLab answers 404 for is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      // The read failure, and any drop or abandonment, is already recorded on the Thread and in the round.
      throw error
    }
  }, thread => round.read.has(thread.key))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // A default-branch pipeline Thread has no Issue or merge request to read; its transitions arrive as Triggers.
  if (thread.ref.id.includes(':ci:')) return
  const parsed = parseThread(thread.key)
  if (!parsed) throw new Error('Subscribed thread has no GitLab project path and iid')
  round.read.add(thread.key)
  const checkpoint = KV.gitlab.cursor(parsed.project, parsed.kind, parsed.iid)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  const retries = { ...ctx.state.get(KV.gitlab.retries) }
  try {
    await intakeNotes(ctx, { project: parsed.project, iid: parsed.iid, isMr: parsed.kind === 'mr' }, since, round)
    delete retries[thread.key]
    ctx.atomic(() => { ctx.state.set(checkpoint, cursorAt(round.started)); ctx.state.set(KV.gitlab.retries, retries) })
  } catch (error) {
    const retry = { ...(retries[thread.key] ?? { thread: thread.key, since }), failedAt: retries[thread.key]?.failedAt ?? round.started,
      attempts: (retries[thread.key]?.attempts ?? 0) + 1 }
    // Abandon thread retries after 24 hours of failures so a permanently unreadable thread does not hold source health in
    // error; its cursor stays so a later poll still reads what was missed.
    const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
    failed(ctx, round, thread.key, error, abandoned)
    if (!gone(error) && !abandoned) retries[thread.key] = retry
    else delete retries[thread.key]
    ctx.state.set(KV.gitlab.retries, retries)
    throw error
  }
}
/**
 * One polling round: the projects' issues and merge requests streams, then the merge requests of open tickets with their
 * pipelines, then the watched projects' default-branch pipelines, then subscribed Threads. Each step and each project or
 * Thread fails independently so all steps run before the round fails. A read that GitLab answers 404 for is dropped, and
 * one whose reads kept failing for a day is abandoned; neither fails the round.
 * @returns the polling interval in seconds, the configured one.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const pollSeconds = ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60
  await pollProjects(ctx, round)
  await pollTicketMrs(ctx, signal, round)
  await pollBranchPipelines(ctx, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return pollSeconds
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (refs: string[]) => [...new Set(refs)].sort().join(', ')
  const dropped = (round.dropped.length ? `; gone on GitLab: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('gitlab', { state: 'ready', detail: `${ctx.deployment.gitlab?.projects.length ?? 0} projects; next poll in ${pollSeconds}s${dropped}`, at: round.started })
  return pollSeconds
}
