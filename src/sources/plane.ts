/** Plane source kind definition (configuration, policy, channel, thread context, environment) and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { PlaneAccountsSchema } from '../deployment.ts'
import { planeLink, planeSender } from './plane-channel.ts'
import { planeThreadContext } from './plane-read.ts'
import { planeMcp } from './plane-mcp.ts'
import { planeChannel, planeTrigger, planeTriggerId, workItemTrigger } from './plane-trigger.ts'
import { planeWebhook } from './plane-webhook.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { planeChannel, planeRef, planeTriggerId, planeTrigger, workItemTrigger } from './plane-trigger.ts'
export type { PlaneIssueRef } from './plane-trigger.ts'
export { planeMcp, PlaneMcpUnavailable } from './plane-mcp.ts'
export { planeHtml, planeLink, planeSender } from './plane-channel.ts'
export { planeThreadContext } from './plane-read.ts'
export { planeWebhook, planeSignatureValid, MAX_BODY_BYTES } from './plane-webhook.ts'
void planeChannel

const PlaneConfigSchema = PlaneAccountsSchema.extend({
  mcpServer: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase namespace').default('plane'),
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
/** The Plane Source's settings, falling back to schema defaults while the plugin is disabled. */
export const planeSettings = (sources: SourceRegistry): PlaneConfig => sources.instance<PlaneConfig>('plane')?.config ?? PlaneConfigSchema.parse({})

/** Where the MCP connection's Plane base URL is read from (the connection env, not the settings page). */
const planeBaseUrl = (): string => process.env.PLANE_BASE_URL ?? 'https://api.plane.so'

/**
 * The Plane kind. The channel and threadContext close over the MCP adapter, which the plugin entry builds from the
 * tools service — kind callbacks only receive the CLI commands port, so the factory bridges the two.
 */
export function planeKind(deps: { mcp: () => ReturnType<typeof planeMcp> }): SourceKind<PlaneConfig> {
  return {
    kind: 'plane',
    title: { zh: 'Plane', en: 'Plane' },
    description: { zh: '接收 Plane 工作项的新评论，在工作项的讨论串里回复；Plane 的读写都经 MCP 服务器。', en: 'Receives new comments on Plane work items and replies in their threads; all Plane reads and writes go through the MCP server.' },
    schema: PlaneConfigSchema,
    fields: [
      { key: 'secret', type: 'text', pattern: '^plane_wh_[A-Za-z0-9]+$', label: { zh: 'webhook 密钥', en: 'Webhook secret' },
        hint: { zh: 'plane_wh_…，创建 webhook 时以 CSV 下载；改动它触发 dsh-superagent 重启。', en: 'plane_wh_…, downloaded as CSV when the webhook is created; changing it restarts dsh-superagent.' } },
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
    scope({ meta }, config) {
      const projectId = String(meta.projectId ?? '')
      const project = config.projects.find(item => item.id === projectId)
      if (!project) return { listened: false, reason: 'project_not_listed' }
      // Rule 1: any comment by a listed member is an explicit request; the admission table decides the rest.
      return { listened: true, observed: project.listen === 'all', row: project.id }
    },
    channel: {
      allowed: (address, config) => planeKind(deps).scope!({ meta: { projectId: address.projectId ?? '' } }, config).listened,
      send: planeSender(deps.mcp),
      link: (address) => planeLink(address, planeBaseUrl()),
    },
    threadContext: planeThreadContext({ mcp: deps.mcp }),
    find: query => ({ threads: [], terms: [...new Set(query.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])] }),
    repliesTo: trigger => typeof trigger.meta.commentId === 'string' && trigger.meta.commentId
      ? planeTriggerId(String(trigger.meta.commentId)) : undefined,
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
        const config = PlaneConfigSchema.parse(stored)
        const all = { zh: '全部评论', en: 'All comments' }
        const mentions = { zh: '仅 @', en: '@ only' }
        return config.projects.map(project => ({ id: project.id, label: project.name || project.id, note: project.listen === 'all' ? all : mentions,
          cells: { listedUnaddressed: true, unlistedAddressed: project.listen === 'all', unlistedUnaddressed: project.listen === 'all' } }))
      },
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_PLANE_WORKSPACE', description: { zh: 'Plane workspace slug', en: 'The Plane workspace slug' } },
        { key: 'DSH_SUPERAGENT_PLANE_PROJECT', description: { zh: '接下工单的 Plane 项目 id；工单不是从 Plane 来的时为空', en: 'id of the Plane project that started the ticket; empty when the ticket did not start on Plane' } },
        { key: 'DSH_SUPERAGENT_PLANE_WORK_ITEM', description: { zh: '接下工单的 Plane 工作项 id；工单不是从 Plane 来的时为空', en: 'id of the Plane work item that started the ticket; empty when the ticket did not start on Plane' } },
      ],
      values: ({ deployment, trigger }) => ({
        DSH_SUPERAGENT_PLANE_WORKSPACE: process.env.PLANE_WORKSPACE_SLUG ?? '',
        DSH_SUPERAGENT_PLANE_PROJECT: trigger?.source === 'plane' ? String(trigger.meta.projectId ?? '') : '',
        DSH_SUPERAGENT_PLANE_WORK_ITEM: trigger?.source === 'plane' ? String(trigger.meta.workItemId ?? '') : '',
      }),
    },
    facts: (deployment): Record<string, Localized | string> => deployment?.plane
      ? { mcp: { zh: 'Plane MCP 已连接', en: 'Plane MCP connected' } } : {},
  }
}

export const name = 'dsh-superagent-plane'
export const inject = ['orchestrator', 'tools', 'webServer']
export function apply(ctx: Context): void {
  const mcp = () => planeMcp(ctx.tools, planeSettings(ctx.orchestrator.sources).mcpServer)
  const kind = planeKind({ mcp })
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'plane: source kind')
  // The agent's own Plane user id (the API key owner), fetched once; its comments never become Triggers.
  const self = { id: undefined as string | undefined }
  ctx.effect(() => {
    const controller = new AbortController()
    const running = mcp().me().then(member => { self.id = member?.id }).catch(() => {})
    return async () => { controller.abort(); await running }
  }, 'plane: self identity')
  // The webhook receiver answers on the DSH web server under /plane/webhook (the operator's reverse proxy forwards it).
  // Accepted deliveries answer 2xx — including ones the receiving scope filters out — so Plane never burns its retries.
  ctx.effect(() => {
    const handler = async (req: Parameters<typeof planeWebhook>[0], res: Parameters<typeof planeWebhook>[1]): Promise<void> => {
      await planeWebhook(req, res, planeSettings(ctx.orchestrator.sources).secret, async (payload, eventId) => {
        const context = sourceContext(ctx.orchestrator, kind)
        const config = planeSettings(ctx.orchestrator.sources)
        const trigger = config.workItemCreated
          ? planeTrigger(payload, self.id) ?? workItemTrigger(payload, self.id)
          : planeTrigger(payload, self.id)
        if (!trigger || trigger.id !== planeTriggerId(eventId)) return { status: 202, reason: 'ignored' }
        await context.receive(trigger)
        return { status: 202, reason: 'stored' }
      })
    }
    return ctx.webServer.register({ kind: 'prefix', path: '/plane/webhook', handler })
  }, 'plane: webhook receiver')
}