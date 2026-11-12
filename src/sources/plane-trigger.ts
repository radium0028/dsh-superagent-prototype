/**
 * Normalizes Plane workspace webhook v2 payloads into domain Triggers.
 *
 * Plane sends dotted event names (`workitem.comment.created`) but its own documentation shows Python enum members
 * (`WebhookScope.ScopeChoices.WORK_ITEM_UPDATED`), so both forms are accepted. The comment payload carries only
 * `comment_stripped` (plain text); there is no comment_html to inspect, which is why rule 1 (any comment by a listed
 * member is an explicit request) is the default trigger rule.
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

const CommentEventSchema = z.looseObject({
  event_id: z.string().min(1),
  event: z.string().min(1),
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

/** The dotted form of an event name, from either the dotted or the Python-enum form. */
export function eventName(raw: string): string {
  const dotted = /^workitem\.([a-z_]+)$/.exec(raw)
  if (dotted) return raw
  // `WebhookScope.ScopeChoices.WORK_ITEM_UPDATED` → `workitem.updated` (comment events keep their full dotted path).
  const enumed = /^WebhookScope\.ScopeChoices\.WORK_ITEM_([A-Z_]+)$/.exec(raw)
  if (enumed) return `workitem.${enumed[1]!.toLowerCase()}`
  const commentEnumed = /^WebhookScope\.ScopeChoices\.WORK_ITEM_COMMENT_([A-Z_]+)$/.exec(raw)
  if (commentEnumed) return `workitem.comment.${commentEnumed[1]!.toLowerCase()}`
  return raw
}
/** The agent's own Plane user id is fetched once (`member me`) and cached; its comments never become Triggers. */
export function planeTrigger(input: unknown, selfId: string | undefined): Trigger | undefined {
  const event = CommentEventSchema.parse(input)
  const kind = eventName(event.event)
  if (kind !== 'workitem.comment.created' || !event.data.comment) return
  // The agent's own comments would otherwise loop: every reply arrives as a new comment event.
  if (selfId && event.data.comment.actor_id === selfId) return
  const ref: PlaneIssueRef = { projectId: event.data.project_id ?? '', workItemId: event.data.id }
  const commentId = event.data.comment.id
  return { id: planeTriggerId(event.event_id), source: SOURCE, threads: [{ source: SOURCE, id: `plane:${ref.projectId}:${ref.workItemId}` }],
    actor: { source: SOURCE, id: event.data.comment.actor_id }, human: true, addressed: 'direct',
    at: new Date().toISOString(), text: event.data.comment.comment_stripped,
    channel: planeChannel(ref, commentId),
    meta: { eventId: event.event_id, kind, projectId: ref.projectId, workItemId: ref.workItemId, commentId,
      workItemName: event.data.name ?? '', workspaceId: event.workspace_id ?? '', entityType: event.entity_type ?? 'issue' } }
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