/** Plane source kind definition (configuration, policy, channel, thread context, environment) and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { PlaneAccountsSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { planeLink, planeSender } from './plane-channel.ts'
import { planeThreadContext } from './plane-read.ts'
import { planeMcp, type PlaneMcp } from './plane-mcp.ts'
import { planeChannel, planeTrigger, planeTriggerId, workItemTrigger } from './plane-trigger.ts'
import { planeWebhook, startPlaneWebhook, watchPlaneWebhook } from './plane-webhook.ts'
import { sourceContext } from './host.ts'
import type { ScopeResult } from '../core/index.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { planeChannel, planeRef, planeTriggerId, planeTrigger, workItemTrigger } from './plane-trigger.ts'
export type { PlaneIssueRef } from './plane-trigger.ts'
export { planeMcp, PlaneMcpUnavailable } from './plane-mcp.ts'
export { planeHtml, planeLink, planeSender } from './plane-channel.ts'
export { planeThreadContext } from './plane-read.ts'
export { planeWebhook, planeSignatureValid, startPlaneWebhook, watchPlaneWebhook, MAX_BODY_BYTES } from './plane-webhook.ts'

const PlaneConfigSchema = PlaneAccountsSchema.extend({
  mcpServer: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase namespace').default('plane'),
  /** When set, only a comment @-mentioning this Plane user is an explicit request (rule 3); empty keeps rule 1. */
  mentionUser: z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i, 'User UUID or empty').default(''),
  webhookHost: z.string().trim().regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*)$/, 'host or IP literal').default('127.0.0.1'),
  webhookPort: z.number().int().min(1).max(65535).default(3090),
  baseUrl: z.union([z.literal(''), z.string().trim().url()]).default(''),
  workspace: z.string().trim().regex(/^[a-z0-9-]*$/, 'workspace slug').default(''),
  readPageSize: z.number().int().min(1).max(100).default(30),
  projects: z.array(z.object({
    id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Project UUID'),
    name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']),
  }).strict()).refine(projects => new Set(projects.map(project => project.id)).size === projects.length, 'Duplicate project IDs')
    .default([]),
  workItemCreated: z.boolean().default(false),
}).strict()
export type PlaneConfig = z.infer<typeof PlaneConfigSchema>
export { PlaneConfigSchema }
/** The Plane Source's settings, falling back to schema defaults while the plugin is disabled. */
export const planeSettings = (sources: SourceRegistry): PlaneConfig => sources.instance<PlaneConfig>('plane')?.config ?? PlaneConfigSchema.parse({})

/** The Plane instance base URL for links: the Source's own setting first, then the MCP connection's env. */
const planeBase = (config: PlaneConfig): string => config.baseUrl || process.env.PLANE_BASE_URL || ''

/**
 * The Plane kind. The channel and threadContext close over the MCP adapter, which the plugin entry builds from the
 * tools service — kind callbacks only receive the CLI commands port, so the factory bridges the two. `settings`
 * supplies the live configuration for values the kind computes (link host, workspace slug); tests omit it.
 */
export interface PlaneKindDeps { mcp: () => PlaneMcp; settings?: () => PlaneConfig;
  /** Observes each roster refresh (startup probe and the panel's Sync now) so health reflects the outcome. */
  onRefresh?: (outcome: { ok: boolean; detail: string }) => void }
/** The receiving-scope rule, shared by the kind's `scope` and its Channel's `allowed`. */
const planeScope = (input: { meta: Record<string, unknown> }, config: PlaneConfig): ScopeResult => {
  const projectId = String(input.meta.projectId ?? '')
  const project = config.projects.find(item => item.id === projectId)
  if (!project) return { listened: false, reason: 'project_not_listed' }
  // Rule 1: any comment by a listed member is an explicit request; the admission table decides the rest.
  return { listened: true, observed: project.listen === 'all', row: project.id }
}
export function planeKind(deps: PlaneKindDeps): SourceKind<PlaneConfig> {
  const config = deps.settings ?? (() => PlaneConfigSchema.parse({}))
  return {
    kind: 'plane',
    title: { zh: 'Plane', en: 'Plane' },
    description: { zh: '接收 Plane 工作项的新评论，在工作项的讨论串里回复；Plane 的读写都经 MCP 服务器。', en: 'Receives new comments on Plane work items and replies in their threads; all Plane reads and writes go through the MCP server.' },
    schema: PlaneConfigSchema,
    refreshLabels: async (host, signal) => {
      try {
        const names = await refreshPlaneNames(sourceContext(host, { kind: 'plane', health: ['plane'] }), deps.mcp(), signal)
        deps.onRefresh?.({ ok: true, detail: 'Plane MCP connected' })
        return names
      } catch (error) {
        deps.onRefresh?.({ ok: false, detail: `Plane MCP unavailable: ${error instanceof Error ? error.message : String(error)}` })
        throw error
      }
    },
    fields: [
      { key: 'secret', type: 'text', pattern: '^plane_wh_[A-Za-z0-9]+$', label: { zh: 'webhook 密钥', en: 'Webhook secret' },
        hint: { zh: 'plane_wh_…，创建 webhook 时以 CSV 下载；改动它触发 dsh-superagent 重启。', en: 'plane_wh_…, downloaded as CSV when the webhook is created; changing it restarts dsh-superagent.' } },
      { key: 'mentionUser', type: 'text', pattern: '^([0-9a-f-]{36})?$', label: { zh: '提及触发的用户', en: 'Mention-trigger user' },
        hint: { zh: '填 Plane 用户 UUID（如机器人账号 DevelopBot）：只有评论里 @ 该用户的评论才算明确请求（规则 3，@ 标记从评论 HTML 识别）。留空则名单内成员的任意评论都算明确请求（规则 1）。', en: 'A Plane user UUID (a bot account such as DevelopBot): only comments @-mentioning that user are explicit requests (rule 3, recognized in the comment HTML). Empty keeps rule 1, where any comment by a listed member is an explicit request.' } },
      { key: 'webhookHost', type: 'text', pattern: '[A-Za-z0-9.-]+', label: { zh: '接收端监听地址', en: 'Receiver bind address' },
        hint: { zh: 'Plane Source 自己监听的地址（不是 DSH 的 web server）；frpc 从本机连它，保持 127.0.0.1 即可。改动 5 秒内自动重绑，不需要重启。', en: 'The address the Plane receiver itself binds (not the DSH web server); frpc connects from this host, so loopback is enough. A change rebinds within 5 s, without a restart.' } },
      { key: 'webhookPort', type: 'number', min: 1, max: 65535, label: { zh: '接收端监听端口', en: 'Receiver bind port' },
        hint: { zh: 'frpc 映射的本地端口要与它一致；默认 3090。', en: 'Must match the local port frpc maps to; defaults to 3090.' } },
      { key: 'baseUrl', type: 'text', pattern: '^(https?://.*)?$', label: { zh: 'Plane 实例地址', en: 'Plane base URL' },
        hint: { zh: '面板里外链工作项用的地址，例如 https://plane.example.com；留空则用 MCP 连接里的 PLANE_BASE_URL。', en: 'The instance URL links to, for example https://plane.example.com; empty falls back to PLANE_BASE_URL from the MCP connection.' } },
      { key: 'workspace', type: 'text', pattern: '[a-z0-9-]*', label: { zh: '工作区 slug', en: 'Workspace slug' },
        hint: { zh: 'Plane URL 里的工作区名；传给 worker 的环境变量 DSH_SUPERAGENT_PLANE_WORKSPACE，留空则用 MCP 连接里的 PLANE_WORKSPACE_SLUG。', en: 'The workspace name in Plane URLs; exported to workers as DSH_SUPERAGENT_PLANE_WORKSPACE, empty falls back to PLANE_WORKSPACE_SLUG from the MCP connection.' } },
      { key: 'projects', type: 'rows', label: { zh: '接收的项目', en: 'Projects' },
        hint: { zh: '“仅 @”只接收名单内成员的评论；“全部评论”也观察其余评论，评估可以按规则从中推断工作。', en: '"@ only" receives only comments by listed members; "All comments" also observes the rest, from which Eval may infer work under the rules.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[0-9a-f-]{36}', choose: { zh: '选择项目', en: 'Choose a project' }, refresh: { zh: '刷新项目列表', en: 'Refresh projects' } },
          { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部评论', en: 'All comments' } }] },
        ] },
      { key: 'workItemCreated', type: 'switch', label: { zh: '新建工作项也开工单', en: 'New work items open tickets too' } },
      { key: 'mcpServer', type: 'text', advanced: true, pattern: '^[a-z][a-z0-9_-]*$', label: { zh: 'MCP 服务器命名空间', en: 'MCP server namespace' },
        hint: { zh: '工具前缀 mcp__<命名空间>__*，对应 DSH 里 Plane MCP 连接的名字，默认 plane。', en: 'Tool prefix mcp__<namespace>__*, the name of the Plane MCP connection in DSH; defaults to plane.' } },
      { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '每页评论数', en: 'Comments per page' } },
    ],
    health: ['plane'],
    scope: planeScope,
    channel: {
      allowed: (address, cfg) => planeScope({ meta: { projectId: address.projectId ?? '' } }, cfg).listened,
      send: planeSender(deps.mcp),
      link: (address) => planeLink(address, planeBase(config())),
    },
    threadContext: planeThreadContext({ mcp: deps.mcp }),
    find: query => ({ threads: [], terms: [...new Set(query.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])] }),
    policy: {
      unnamed: { person: { zh: 'Plane 用户', en: 'Plane user' }, bot: { zh: 'Plane 机器人', en: 'Plane bot' } },
      schema: z.object({
        allowed: z.array(z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i, 'User UUID'), name: z.string().trim().max(100).optional() }).strict())
          .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user UUIDs').default([]),
      }).strict(),
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Plane 用户', en: 'Plane users who may originate work' },
          columns: [{ key: 'id', type: 'text', label: { zh: '用户', en: 'User' }, pattern: '[0-9a-f-]{36}' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      ],
      explicit: { zh: '名单内的人在受监听项目里写任何评论，都是明确的请求，不需要 @。', en: 'Anyone on the list who comments in a listened project always makes an explicit request; no @ needed.' },
      rows(stored) {
        const parsed = PlaneConfigSchema.parse(stored)
        const all = { zh: '全部评论', en: 'All comments' }
        const mentions = { zh: '仅 @', en: '@ only' }
        return parsed.projects.map(project => ({ id: project.id, label: project.name || project.id, note: project.listen === 'all' ? all : mentions,
          cells: { listedUnaddressed: true, unlistedAddressed: project.listen === 'all', unlistedUnaddressed: project.listen === 'all' } }))
      },
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_PLANE_WORKSPACE', description: { zh: 'Plane workspace slug', en: 'The Plane workspace slug' } },
        { key: 'DSH_SUPERAGENT_PLANE_PROJECT', description: { zh: '接下工单的 Plane 项目 id；工单不是从 Plane 来的时为空', en: 'id of the Plane project that started the ticket; empty when the ticket did not start on Plane' } },
        { key: 'DSH_SUPERAGENT_PLANE_WORK_ITEM', description: { zh: '接下工单的 Plane 工作项 id；工单不是从 Plane 来的时为空', en: 'id of the Plane work item that started the ticket; empty when the ticket did not start on Plane' } },
      ],
      values: ({ trigger }) => ({
        DSH_SUPERAGENT_PLANE_WORKSPACE: (config().workspace || process.env.PLANE_WORKSPACE_SLUG) ?? '',
        DSH_SUPERAGENT_PLANE_PROJECT: trigger?.source === 'plane' ? String(trigger.meta.projectId ?? '') : '',
        DSH_SUPERAGENT_PLANE_WORK_ITEM: trigger?.source === 'plane' ? String(trigger.meta.workItemId ?? '') : '',
      }),
    },
    facts: (deployment): Record<string, Localized | string> => deployment?.plane
      ? { mcp: { zh: 'Plane MCP 已连接', en: 'Plane MCP connected' } } : {},
  }
}

export const name = 'dsh-superagent-plane'
export const inject = ['orchestrator', 'tools']
/** Resolves Plane user UUIDs to names through the MCP member roster, stores them in KV, and returns them; also the MCP health probe. */
export async function refreshPlaneNames(ctx: { state: { get<V>(key: import('../kv.ts').Key<V>): V | undefined; set<V>(key: import('../kv.ts').Key<V>, value: V | undefined): void } },
  mcp: PlaneMcp, signal?: AbortSignal): Promise<Record<string, string>> {
  const names: Record<string, string> = {}
  let cursor: string | undefined
  do {
    const page = await mcp.members(cursor)
    for (const member of page.items) if (member.name) names[member.id] = member.name
    cursor = page.nextCursor
  } while (cursor && !signal?.aborted)
  ctx.state.set(KV.sources.labels('plane'), names)
  return names
}
/** One slice of the Source's health entry: the receiver and the MCP probe each own one, so neither clobbers the other. */
interface HealthSlice { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }

export interface PlaneApplyDeps { start?: typeof startPlaneWebhook }

export function apply(ctx: Context, deps: PlaneApplyDeps = {}): void {
  const start = deps.start ?? startPlaneWebhook
  const mcp = () => planeMcp(ctx.tools, planeSettings(ctx.orchestrator.sources).mcpServer)
  const kind = planeKind({ mcp, settings: () => planeSettings(ctx.orchestrator.sources),
    onRefresh: ({ ok, detail }) => { probe.state = ok ? 'ready' : 'error'; probe.detail = detail; publish() } })
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'plane: source kind')
  const context = sourceContext(ctx.orchestrator, kind)

  const listener: HealthSlice = { state: 'starting', detail: 'Starting the webhook receiver' }
  const probe: HealthSlice = { state: 'starting', detail: 'Waiting for the first member probe' }
  const publish = (): void => {
    const state = listener.state === 'error' || probe.state === 'error' ? 'error'
      : listener.state === 'ready' && probe.state === 'ready' ? 'ready'
      : listener.state === 'paused' || probe.state === 'paused' ? 'paused' : 'starting'
    context.report('plane', { state, detail: `${listener.detail}; ${probe.detail}`, at: new Date().toISOString() })
  }

  // The agent's own Plane user id (the API key owner): its comments never become Triggers. The id is cached in KV so a
  // restart with a down MCP server still excludes them; the member loop below refetches it whenever it is missing.
  const self = { id: context.state.get(KV.plane.self) }
  // The webhook receiver: the plugin's own listener (not a route on the DSH web server), so frp maps one port to it
  // without exposing the management panel. Accepted deliveries answer 2xx — including ones the receiving scope filters
  // out — so Plane never burns its retries on a webhook it should keep.
  ctx.effect(() => {
    const controller = new AbortController()
    const running = watchPlaneWebhook({
      target: () => {
        const config = context.config<PlaneConfig>('plane')
        return config ? { host: config.webhookHost, port: config.webhookPort } : undefined
      },
      start: (host, port) => start(host, port, async (req, res) => {
        await planeWebhook(req, res, planeSettings(ctx.orchestrator.sources).secret, async (payload, eventId) => {
          const settings = planeSettings(ctx.orchestrator.sources)
          const trigger = settings.workItemCreated
            ? planeTrigger(payload, self.id, { mentionUser: settings.mentionUser || undefined }) ?? workItemTrigger(payload, self.id)
            : planeTrigger(payload, self.id, { mentionUser: settings.mentionUser || undefined })
          if (!trigger || trigger.id !== planeTriggerId(eventId)) {
            // A dialect the translator does not know must be visible, not a silent 202.
            const seen = payload as { event?: unknown; action?: unknown; data?: unknown }
            ctx.logger.info('plane webhook ignored: event=%s action=%s data_keys=%s', String(seen.event), String(seen.action ?? ''),
              Object.keys((seen.data as Record<string, unknown>) ?? {}).join(','))
            return { status: 202, reason: 'ignored' }
          }
          await context.receive(trigger)
          return { status: 202, reason: 'stored' }
        })
      }),
      report: (state, detail) => { listener.state = state; listener.detail = detail; publish() },
      signal: controller.signal,
    }).catch((error: unknown) => {
      // watchPlaneWebhook itself never rejects, but a broken effect must not become an unhandled rejection.
      listener.state = 'error'; listener.detail = String(error); publish()
    })
    return async () => { controller.abort(); await running }
  }, 'plane: webhook receiver')
  // Startup probe: one bounded attempt series (Plane rate-limits the member list, so no permanent polling — the
  // panel's Sync now button re-runs the refresh on demand). Success also caches the agent's own Plane user id.
  ctx.effect(() => {
    const controller = new AbortController()
    const running = (async () => {
      await context.ready
      const pause = (ms: number): Promise<void> => new Promise(done => { const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true }) })
      for (let attempt = 1; attempt <= 3 && !controller.signal.aborted; attempt++) {
        try {
          if (!self.id) { const me = await mcp().me(); if (me?.id) { self.id = me.id; context.state.set(KV.plane.self, me.id) } }
          await refreshPlaneNames(context, mcp(), controller.signal)
          probe.state = 'ready'; probe.detail = 'Plane MCP connected'; publish(); return
        } catch (error) {
          probe.state = 'error'; probe.detail = `Plane MCP unavailable: ${error instanceof Error ? error.message : String(error)}`; publish()
          if (attempt < 3) await pause(30_000)
        }
      }
      if (!controller.signal.aborted) { probe.state = 'paused'; probe.detail = 'Member names not refreshed; use Sync now on the Source page'; publish() }
    })()
    return async () => { controller.abort(); await running.catch(() => {}) }
  }, 'plane: startup probe')
}