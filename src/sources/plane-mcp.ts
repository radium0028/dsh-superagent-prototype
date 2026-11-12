/**
 * Plane MCP adapter: the single module that translates internal calls (read a work item, list comments, post a reply,
 * read the member roster) into `mcp__plane__*` tool executions, and normalizes their envelopes.
 *
 * Tool names are the contract: the adapter is the only place that spells `mcp__<server>__<tool>` and the `action`
 * values, so an MCP server upgrade touches this file alone. The tools service registers MCP tools globally
 * (process-wide, without scope), so both the orchestrator and worker sessions see them.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'

/** Minimal structural view of the harness tools service this adapter needs. */
interface ToolsLike {
  get(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
}

/** One page of comments as the MCP `workitem_comment` tool returns it. */
const CommentPageSchema = z.looseObject({
  results: z.array(z.looseObject({
    id: z.string(),
    comment_html: z.string().nullish(),
    comment_stripped: z.string().nullish(),
    access: z.string().nullish(),
    actor_id: z.string().nullish(),
    created_at: z.string().nullish(),
  })).default([]),
  next_cursor: z.string().nullish(),
})
/** One work item as the MCP `workitem` tool returns it. */
const WorkItemSchema = z.looseObject({
  id: z.string(),
  name: z.string().default(''),
  project_id: z.string().nullish(),
  state_id: z.string().nullish(),
  priority: z.string().nullish(),
  description_stripped: z.string().nullish(),
  sequence_id: z.number().int().nullish(),
  created_by_id: z.string().nullish(),
  assignee_ids: z.array(z.string()).nullish(),
})
/** The workspace member roster as the MCP `member` tool returns it. */
const MemberPageSchema = z.looseObject({
  results: z.array(z.looseObject({ member: z.looseObject({ id: z.string(), display_name: z.string().nullish() }).nullish() })).default([]),
  next_cursor: z.string().nullish(),
})

export interface PlaneComment {
  id: string
  html: string | null
  text: string
  actorId: string | null
  at: string
}
export interface PlaneWorkItem {
  id: string
  name: string
  projectId: string | null
  stateId: string | null
  priority: string | null
  description: string
  sequenceId: number | null
}
export interface PlaneMember { id: string; name: string | null }
export interface PlanePage<T> { items: T[]; nextCursor: string | undefined }

/** Why an MCP call failed: the server is not registered (`unavailable`) or the call itself threw. */
export class PlaneMcpUnavailable extends Error {
  constructor(readonly tool: string) { super(`The Plane MCP server is not connected: tool ${tool} is not registered`) }
}

const timestamp = (value: string | null | undefined): string => {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString()
}

/**
 * Adapts the harness tools service to Plane reads and writes. The constructor takes the tools service directly (the
 * plugin entry passes `ctx.tools`) so kind callbacks that only receive the CLI commands port still reach MCP through
 * the closures this factory builds.
 */
export function planeMcp(tools: ToolsLike, server = 'plane') {
  const tool = (name: string): string => `mcp__${server}__${name}`
  const call = async <T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const definition = tools.get(tool(name))
    if (!definition) throw new PlaneMcpUnavailable(tool(name))
    const exec = { signal: new AbortController().signal }
    const result = await definition.execute(args, exec) as { isError?: boolean; value?: unknown; error?: { message?: string } }
    if (result?.isError) throw new Error(`Plane MCP ${name} failed: ${result.error?.message ?? 'unknown error'}`)
    return schema.parse(result?.value)
  }
  return {
    /** Whether the MCP server is connected (its first tool is registered). */
    available(): boolean { return !!tools.get(tool('workitem')) },
    /** One work item by id; `description_stripped` is plain text. */
    async workItem(id: string): Promise<PlaneWorkItem> {
      const raw = await call('workitem', { action: 'retrieve', work_item_id: id }, WorkItemSchema)
      return { id: raw.id, name: raw.name, projectId: raw.project_id ?? null, stateId: raw.state_id ?? null,
        priority: raw.priority ?? null, description: raw.description_stripped ?? '', sequenceId: raw.sequence_id ?? null }
    },
    /** One page of a work item's comments, oldest first, with a cursor for the next page. */
    async comments(issue: { projectId: string; workItemId: string }, cursor?: string): Promise<PlanePage<PlaneComment>> {
      const page = await call('workitem_comment',
        { action: 'list', project_id: issue.projectId, work_item_id: issue.workItemId, ...(cursor ? { cursor } : {}) }, CommentPageSchema)
      return { items: page.results.map(item => ({ id: item.id, html: item.comment_html ?? null, text: item.comment_stripped ?? '',
        actorId: item.actor_id ?? null, at: timestamp(item.created_at) })), nextCursor: page.next_cursor ?? undefined }
    },
    /** Posts one reply as a comment; `externalId` makes Plane deduplicate retries of the same message. */
    async reply(issue: { projectId: string; workItemId: string }, externalId: string, html: string, parentId?: string): Promise<string> {
      const raw = await call('workitem_comment',
        { action: 'create', project_id: issue.projectId, work_item_id: issue.workItemId, comment_html: html,
          external_id: externalId, external_source: 'dsh-superagent', ...(parentId ? { parent_id: parentId } : {}) },
        z.looseObject({ id: z.string() }))
      return raw.id
    },
    /** The authenticated Plane user (the API key owner); its comments are the agent's own and never trigger work. */
    async me(): Promise<PlaneMember | undefined> {
      const page = await call('member', { action: 'me' }, MemberPageSchema)
      return page.results[0]?.member ? { id: page.results[0].member.id, name: page.results[0].member.display_name ?? null } : undefined
    },
    /** Pages of the workspace member roster; Plane user UUIDs resolve to names. */
    async members(cursor?: string): Promise<PlanePage<PlaneMember>> {
      const page = await call('member', { action: 'list_workspace', ...(cursor ? { cursor } : {}) }, MemberPageSchema)
      return { items: page.results.flatMap(entry => entry.member ? [{ id: entry.member.id, name: entry.member.display_name ?? null }] : []),
        nextCursor: page.next_cursor ?? undefined }
    },
  }
}
export type PlaneMcp = ReturnType<typeof planeMcp>