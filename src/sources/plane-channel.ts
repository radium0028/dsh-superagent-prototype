/**
 * Plane outbound channel: posts replies as work-item comments through the MCP adapter, idempotently by message ID.
 *
 * Plane does not deduplicate comments, so the reply is idempotent by protocol: the outgoing message's id is the
 * comment's `external_id` with `external_source: dsh-superagent`, and retrying the same message posts nothing new.
 * A 404 means the work item no longer accepts comments — the only `gone` case; everything else throws for the Outbox
 * to retry with backoff.
 */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import type { PlaneMcp } from './plane-mcp.ts'
import { planeTriggerId, type PlaneIssueRef } from './plane-trigger.ts'

/** Escapes plain text and wraps it as HTML paragraphs, the format Plane renders in a comment. */
export function planeHtml(text: string): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text.split(/\n{2,}/).map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`).join('')
}

/** True when Plane permanently rejects a reply because the work item is gone; only a 404 means that. */
const gone = (error: unknown): boolean => /404|not found|不存在/i.test(error instanceof Error ? error.message : String(error))

/** The work item URL Plane serves; `host` is the self-hosted instance from the MCP connection. */
export const planeWorkItemUrl = (host: string, ref: PlaneIssueRef): string =>
  `${host.replace(/\/$/, '')}/app-workspace/${ref.projectId}/work-items/${ref.workItemId}`

/**
 * The send function the kind's channel uses. `self` carries the MCP adapter (the kind callback only receives the CLI
 * commands port, so the plugin entry closes over this).
 */
export function planeSender(mcp: () => PlaneMcp) {
  return async (context: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> => {
    const ref: PlaneIssueRef = { projectId: String(message.channel.address.projectId ?? ''),
      workItemId: String(message.channel.address.workItemId ?? '') }
    if (!ref.projectId || !ref.workItemId) throw new Error('Missing Plane reply target')
    const parentId = message.channel.address.commentId
    try { await mcp().reply(ref, message.id, planeHtml(message.text), parentId || undefined) }
    catch (error) { if (gone(error)) return 'gone'; throw error }
    return 'sent'
  }
}

/** Work item link for cards; `host` is the Plane base URL from the MCP connection. */
export function planeLink(address: Record<string, string>, host: string): ChannelLink {
  const ref = { projectId: address.projectId ?? '', workItemId: address.workItemId ?? '' }
  return { url: ref.projectId && ref.workItemId ? planeWorkItemUrl(host, ref) : '',
    label: { zh: 'Plane 工作项', en: 'Plane work item' }, ...(address.commentId ? { triggerId: planeTriggerId(address.commentId) } : {}) }
}