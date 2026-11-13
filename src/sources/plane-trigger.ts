/**
 * Normalizes Plane workspace webhook payloads into domain Triggers.
 *
 * Two payload dialects arrive, because the deployed Plane version predates webhook v2: the v2 shape (dotted
 * `workitem.comment.created`, `data` holding the work item with a nested `comment`) and the v1 shape (event
 * `issue_comment` with a top-level `action`, `data` being the comment object itself with `issue`/`project`/`actor`
 * fields). Both are accepted; the envelope still requires `event_id`, so deduplication works across redeliveries.
 *
 * Plane's own documentation example also shows Python enum members (`WebhookScope.ScopeChoices.…`), so that form is
 * normalized too. The v1 comment payload carries `comment_html` (no plain text), which is why rule 1 (any comment by
 * a listed member is an explicit request) is the default trigger rule.
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'plane'
export interface PlaneIssueRef { projectId: string; workItemId: string }

/** Constructs a Plane reply channel address; `commentId` names the comment a reply hangs under. */
export const planeChannel = (ref: PlaneIssueRef, commentId: string): ChannelRef =>
  ({ source: SOURCE, thread: `plane:${ref.projectId}:${ref.workItemId}`, address: { projectId: ref.projectId, workItemId: ref.workItemId, commentId } })
/** Deterministic trigger ID from the webhook event id: repeated deliveries of one event produce one Trigger. */
export const planeTriggerId = (eventId: string): string => key(SOURCE, eventId)

/** The webhook envelope every dialect shares; pre-v2 payloads carry no `event_id`, so `data.id` stands in for it. */
const EnvelopeSchema = z.looseObject({ event_id: z.string().min(1).optional(), event: z.string().min(1), action: z.string().nullish() })
/** v2 payload: `data` holds the work item and a nested `comment` object. */
const V2CommentSchema = z.looseObject({
  workspace_id: z.string().nullish(),
  entity_type: z.string().nullish(),
  data: z.looseObject({
    id: z.string().min(1),
    project_id: z.string().nullish(),
    name: z.string().nullish(),
    comment: z.looseObject({
      id: z.string().min(1),
      actor_id: z.string().min(1),
      comment_stripped: z.string().default(''),
    }).nullish(),
  }),
})
/** v1 payload: `data` is the comment object itself (`issue` and `project` instead of nested ids). */
const V1CommentSchema = z.looseObject({
  workspace_id: z.string().nullish(),
  entity_type: z.string().nullish(),
  data: z.looseObject({
    id: z.string().min(1),
    issue: z.string().min(1),
    project: z.string().min(1),
    actor: z.string().min(1),
    comment_html: z.string().nullish(),
    comment_stripped: z.string().nullish(),
    created_at: z.string().nullish(),
    external_source: z.string().nullish(),
  }),
})
/** A work-item event (created/updated/archived/deleted); `data` is the work item object itself. */
const WorkItemEventSchema = z.looseObject({
  event_id: z.string().min(1),
  event: z.string().min(1),
  workspace_id: z.string().nullish(),
  data: z.looseObject({
    id: z.string().min(1),
    project_id: z.string().min(1),
    name: z.string().nullish(),
    created_by_id: z.string().nullish(),
  }),
})

/** The comment text: v2 delivers plain `comment_stripped`; v1 delivers only HTML, which is reduced to text. */
export function planeText(comment: { comment_stripped?: string | null; comment_html?: string | null }): string {
  if (comment.comment_stripped) return comment.comment_stripped
  return (comment.comment_html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PlaneTriggerOptions {
  /**
   * When set, only a comment whose markup mentions this Plane user counts as addressed (rule 3); every other comment
   * stays unaddressed, so it can at most become an inferred candidate under `listen: all`. The webhook payload carries
   * no mention list, so the mention is recognized in the comment's HTML. Empty keeps rule 1 (any comment by a listed
   * member is an explicit request).
   */
  mentionUser?: string
}
/**
 * True when the comment's markup mentions the given Plane user. The deployed editor serializes a mention as a
 * `<mention-component entity_identifier="<user uuid>" entity_name="user_mention">` element (confirmed against the
 * instance); newer editors use `data-mention-id`, so both attributes are accepted.
 */
export function planeMentions(comment: { comment_html?: string | null }, userId: string): boolean {
  if (!userId) return false
  return new RegExp(`(?:entity_identifier|data-(?:mention-)?id)="${userId}"`, 'i').test(comment.comment_html ?? '')
}

/** The dotted form of an event name, from the dotted, Python-enum, or v1 (`issue_comment` + `action`) forms. */
export function eventName(raw: string, action?: string): string {
  const dotted = /^workitem\.[a-z_]+(\.[a-z_]+)?$/.exec(raw)
  if (dotted) return raw
  // `WebhookScope.ScopeChoices.WORK_ITEM_COMMENT_CREATED` → `workitem.comment.created`; check the longer form first,
  // or the work-item regex below would collapse it to `workitem.comment_created`.
  const commentEnumed = /^WebhookScope\.ScopeChoices\.WORK_ITEM_COMMENT_([A-Z_]+)$/.exec(raw)
  if (commentEnumed) return `workitem.comment.${commentEnumed[1]!.toLowerCase()}`
  const enumed = /^WebhookScope\.ScopeChoices\.WORK_ITEM_([A-Z_]+)$/.exec(raw)
  if (enumed) return `workitem.${enumed[1]!.toLowerCase()}`
  // v1: `issue_comment.created`, or a bare `issue_comment` whose verb rides a top-level `action` field.
  if (raw === 'issue_comment.created' || (raw === 'issue_comment' && action === 'created')) return 'workitem.comment.created'
  return raw
}
/** The agent's own Plane user id is fetched once (`member me`) and cached; its comments never become Triggers. */
export function planeTrigger(input: unknown, selfId: string | undefined, options: PlaneTriggerOptions = {}): Trigger | undefined {
  const payload = EnvelopeSchema.parse(input)
  const kind = eventName(payload.event, payload.action ?? undefined)
  if (kind !== 'workitem.comment.created') return

  const v2 = V2CommentSchema.safeParse(input)
  if (v2.success && v2.data.data.comment) {
    const eventId = payload.event_id ?? v2.data.data.comment.id
    const comment = v2.data.data.comment
    // The agent's own comments would otherwise loop: every reply arrives as a new comment event.
    if (selfId && comment.actor_id === selfId) return
    const ref: PlaneIssueRef = { projectId: v2.data.data.project_id ?? '', workItemId: v2.data.data.id }
    return { id: planeTriggerId(eventId), source: SOURCE, threads: [{ source: SOURCE, id: `plane:${ref.projectId}:${ref.workItemId}` }],
      actor: { source: SOURCE, id: comment.actor_id }, human: true, addressed: 'direct',
      at: new Date().toISOString(), text: comment.comment_stripped,
      channel: planeChannel(ref, comment.id),
      meta: { eventId, kind, projectId: ref.projectId, workItemId: ref.workItemId, commentId: comment.id,
        workItemName: v2.data.data.name ?? '', workspaceId: v2.data.workspace_id ?? '', entityType: v2.data.entity_type ?? 'issue' } }
  }

  const v1 = V1CommentSchema.safeParse(input)
  if (v1.success) {
    const comment = v1.data.data
    const eventId = payload.event_id ?? comment.id
    // The agent's own replies carry its `external_source`; that marker guards the reply loop even before the
    // agent's own user id is known (the member probe may still be waiting out an API rate limit).
    if (comment.external_source === 'dsh-superagent') return
    if (selfId && comment.actor === selfId) return
    const ref: PlaneIssueRef = { projectId: comment.project, workItemId: comment.issue }
    const at = comment.created_at && Number.isFinite(Date.parse(comment.created_at))
      ? new Date(Date.parse(comment.created_at)).toISOString() : new Date().toISOString()
    // Rule 3: with a mention user configured, only a comment @-mentioning that user is addressed; the rest stay
    // unaddressed (rule 1 applies when no mention user is set).
    const mentioned = options.mentionUser ? planeMentions(comment, options.mentionUser) : true
    return { id: planeTriggerId(eventId), source: SOURCE, threads: [{ source: SOURCE, id: `plane:${ref.projectId}:${ref.workItemId}` }],
      actor: { source: SOURCE, id: comment.actor }, human: true, ...(mentioned ? { addressed: options.mentionUser ? 'mention' as const : 'direct' as const } : {}),
      at, text: planeText(comment),
      channel: planeChannel(ref, comment.id),
      meta: { eventId, kind, projectId: ref.projectId, workItemId: ref.workItemId, commentId: comment.id, mentioned,
        workItemName: '', workspaceId: v1.data.workspace_id ?? '', entityType: v1.data.entity_type ?? 'issue_comment' } }
  }
  return
}
/** Converts a `workitem.created` event into a Trigger (actor is the creator); only used when `workItemCreated` is on. */
export function workItemTrigger(input: unknown, selfId: string | undefined): Trigger | undefined {
  const event = WorkItemEventSchema.parse(input)
  const kind = eventName(event.event)
  if (kind !== 'workitem.created') return
  const actorId = event.data.created_by_id
  if (!actorId || (selfId && actorId === selfId)) return
  const ref: PlaneIssueRef = { projectId: event.data.project_id, workItemId: event.data.id }
  return { id: planeTriggerId(event.event_id), source: SOURCE, threads: [{ source: SOURCE, id: `plane:${ref.projectId}:${ref.workItemId}` }],
    actor: { source: SOURCE, id: actorId }, human: true, addressed: 'direct',
    at: new Date().toISOString(), text: event.data.name ?? '',
    channel: planeChannel(ref, event.data.id),
    meta: { eventId: event.event_id, kind, projectId: ref.projectId, workItemId: ref.workItemId, commentId: '',
      workItemName: event.data.name ?? '', workspaceId: event.workspace_id ?? '', entityType: 'issue' } }
}
/** The issue reference recorded on a Plane Trigger. */
export function planeRef(trigger: Trigger): PlaneIssueRef | undefined {
  const meta = trigger.meta as { projectId?: string; workItemId?: string }
  if (trigger.source !== SOURCE || !meta.projectId || !meta.workItemId) return undefined
  return { projectId: meta.projectId, workItemId: meta.workItemId }
}
