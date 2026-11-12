/**
 * Trigger-scoped Plane context reader: returns the work item and its comments as model-readable pages, with explicit
 * pagination continuation, mirroring the `feishu/…` resource shape so workers read both kinds the same way.
 *
 * Reads go through the MCP adapter (comments page by page with a cursor, the work item with `description_stripped`).
 * A failed call reports the source as unhealthy instead of throwing an unhandled error.
 */
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import type { PlaneMcp } from './plane-mcp.ts'
import { planeRef } from './plane-trigger.ts'

/** Sections a `plane/<trigger-id>/…` resource addresses: the work item, its comments, or one comment. */
export const planeResource = (resource: string): { triggerId: string; section: string; cursor: string | undefined } => {
  const match = /^plane\/([^/]+)\/(issue|comments|comment)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] === 'issue')) {
    throw new Error('Use plane/<trigger-id>/issue, /comments or /comment; follow returned next_resource for another page')
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}

export interface PlaneIssueRef { projectId: string; workItemId: string }
export interface PlaneReadDeps { mcp: () => PlaneMcp }

const iso = (value: string): string => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : value }
/** One comment as a normalized context message; `bot` marks a non-human sender. */
export const planeView = (comment: { id: string; text: string; actorId: string | null; at: string }): ContextMessage =>
  ({ id: comment.id, from: comment.actorId ?? '', at: iso(comment.at), text: comment.text })

/** The kind's threadContext: reads through the MCP adapter, so assessments stay within the MCP call budget. */
export function planeThreadContext(deps: PlaneReadDeps): ThreadContext<{ readPageSize: number }> {
  const readPage = async (trigger: Trigger, cursor: string | undefined, pageSize: number) => {
    const ref = planeRef(trigger)
    if (!ref) throw new Error('A Plane source trigger is required')
    return deps.mcp().comments(ref, cursor)
  }
  return {
    messageId: trigger => String(trigger.meta.commentId ?? ''),
    async read(commands, trigger, part, cursor, config) {
      const ref = planeRef(trigger)
      if (!ref) throw new Error('A Plane source trigger is required')
      if (part === 'root') {
        // The work item is the topic root of a Plane thread: title, state, priority and the plain-text description.
        const item = await deps.mcp().workItem(ref.workItemId)
        const message: ContextMessage = { id: item.id, from: item.name, at: '', text: item.description }
        return { messages: [message], body: { status: 'available', issue: item }, status: 'available' }
      }
      if (part === 'parent') {
        // The parent of the trigger's comment, read from the first page (Plane keeps threads shallow).
        const parentId = typeof trigger.meta.parentCommentId === 'string' ? trigger.meta.parentCommentId : undefined
        if (!parentId) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
        const page = await deps.mcp().comments(ref)
        const parent = page.items.find(item => item.id === parentId)
        if (!parent) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
        return { messages: [planeView(parent)], body: { status: 'available', comment: parent }, status: 'available' }
      }
      const page = await readPage(trigger, cursor, config.readPageSize)
      const messages = page.items.map(planeView)
      return { messages, next: page.nextCursor, body: { status: 'available', comments: page.items }, status: 'available' }
    },
  }
}