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
export interface PlaneKindDeps { mcp: () => PlaneMcp; settings?: () => PlaneConfig }
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
    refreshLabels: (host, signal) => refreshPlaneNames(sourceContext(host, { kind: 'plane', health: ['plane'] }), deps.mcp(), signal),
    fields: [
      { key: 'secret', type: 'text', pattern: '^plane_wh_[A-Za-z0-9]+$', label: { zh: 'webhook 密钥', en: 'Webhook secret' },
        hint: { zh: 'plane_wh_…，创建 webhook 时以 CSV 下载；改动它触发 dsh-superagent 重启。', en: 'plane_wh_…, downloaded as CSV when the webhook is created; changing it restarts dsh-superagent.' } },
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
  const kind = planeKind({ mcp, settings: () => planeSettings(ctx.orchestrator.sources) })
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
            ? planeTrigger(payload, self.id) ?? workItemTrigger(payload, self.id)
            : planeTrigger(payload, self.id)
          if (!trigger || trigger.id !== planeTriggerId(eventId)) return { status: 202, reason: 'ignored' }
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
  // The member-name refresh doubles as the MCP health probe: a minute like Feishu's chat-name loop, and the stored
  // names stay until a later read succeeds. A down MCP server turns the Source's health entry to error.
  ctx.effect(() => {
    const controller = new AbortController()
    const running = (async () => {
      await context.ready
      while (!controller.signal.aborted) {
        if (context.config<PlaneConfig>('plane')) {
          if (!self.id) {
            try { const me = await mcp().me(); if (me?.id) { self.id = me.id; context.state.set(KV.plane.self, me.id) } }
            catch { /* the probe's own report below covers a down MCP server */ }
          }
          try {
            await refreshPlaneNames(context, mcp(), controller.signal)
            probe.state = 'ready'; probe.detail = 'Plane MCP connected'
          } catch (error) {
            probe.state = 'error'; probe.detail = `Plane MCP unavailable: ${error instanceof Error ? error.message : String(error)}`
          }
        } else {
          probe.state = 'paused'; probe.detail = 'Off'
        }
        publish()
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 60_000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
      }
    })()
    return async () => { controller.abort(); await running.catch(() => {}) }
  }, 'plane: member names and MCP health')
}