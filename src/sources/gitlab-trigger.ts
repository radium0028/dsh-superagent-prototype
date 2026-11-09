/** Normalizes GitLab issues, merge requests, notes, discussions, and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** Thread id inside the gitlab source: the project path plus `#iid` for an Issue or `!iid` for a merge request. */
const threadId = (project: string, iid: number, kind: 'issue' | 'mr'): string => `${project}${kind === 'mr' ? '!' : '#'}${iid}`
/** Full thread key of an Issue or merge request, `gitlab:<path>#<iid>` or `gitlab:<path>!<iid>`; the path may have many segments. */
export const threadKey = (project: string, iid: number, kind: 'issue' | 'mr'): string => `gitlab:${threadId(project, iid, kind)}`
/** Parses a thread key back to its project, iid, and kind; returns undefined for other sources or malformed keys. */
export function parseThread(thread: string): { project: string; iid: number; kind: 'issue' | 'mr' } | undefined {
  const match = /^gitlab:(.+)(!|#)(\d+)$/.exec(thread)
  if (!match) return undefined
  return { project: match[1]!, iid: Number(match[3]), kind: match[2] === '!' ? 'mr' : 'issue' }
}
/** GitLab reply address: the Issue/MR conversation, or a discussion thread when `discussion` is set. */
export const gitlabChannel = (project: string, iid: number, kind: 'issue' | 'mr', discussion?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(project, iid, kind),
    address: { project, iid: String(iid), kind, ...(discussion ? { discussion: String(discussion) } : {}) } })
/** Web page of an Issue or merge request on the instance. */
export const gitlabPage = (host: string, project: string, iid: number, kind: 'issue' | 'mr'): string =>
  `https://${host}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** Parses a web URL of an Issue, a merge request, or one of its notes on `host`; returns undefined for other hosts or URLs. */
export function gitlabAddress(url: string, host: string): { project: string; iid: number; kind: 'issue' | 'mr'; note?: number } | undefined {
  const address = /^https:\/\/([^/]+)\/(.+)\/-\/(issues|merge_requests)\/(\d+)\/?(?:\/discussions)?(?:#note_(\d+))?\/?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, host)) return undefined
  return { project: match[2]!, iid: Number(match[4]), kind: match[3]!.toLowerCase() === 'issues' ? 'issue' : 'mr',
    ...match[5] ? { note: Number(match[5]) } : {} }
}
/** GitLab reports a deleted account's username as empty and displays it as `ghost`. */
export const UserSchema = z.looseObject({ id: z.number(), username: z.string().nullish(), name: z.string().nullish() })
  .transform(({ id, username, ...rest }) => ({ id: username ? id : 0, username: username || 'ghost', ...rest }))
export type GitlabUser = z.infer<typeof UserSchema>
/**
 * A note (comment); a non-null `type` marks a diff or discussion note carrying `position` (its file and lines),
 * and `discussion_id` ties it to its discussion thread.
 */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema, created_at: z.string(), updated_at: z.string().nullish(),
  system: z.boolean().nullish(), type: z.string().nullish(), discussion_id: z.string().nullish(),
  position: z.looseObject({ old_path: z.string().nullish(), new_path: z.string().nullish(), old_line: z.number().nullish(), new_line: z.number().nullish() }).nullish(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** An Issue as the issues API returns it. */
export const IssueSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(), author: UserSchema,
  created_at: z.string(), updated_at: z.string(), web_url: z.string(), labels: z.array(z.looseObject({ title: z.string() })).nullish(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A merge request; it carries the Issue fields plus its branches, head commit, and lifecycle timestamps. */
export const MrSchema = IssueSchema.extend({
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullish(), draft: z.boolean().nullish(),
  detailed_merge_status: z.string().nullish(), merge_when_pipeline_succeeds: z.boolean().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), head_pipeline: z.unknown().nullish(),
})
export type GitlabMr = z.infer<typeof MrSchema>
/** Whether a note is a system record (label changes, assignments); the intake layer drops these. */
export const isSystemNote = (note: GitlabNote): boolean => note.system === true
/** Formats an inline diff note's file and line; empty for a conversation note. */
export function notePlace(note: GitlabNote): string {
  return note.position?.new_path ? `${note.position.new_path}:${note.position.new_line}` : ''
}
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
export interface NoteRef { project: string; iid: number; isMr: boolean; discussionId?: string; host?: string }
/**
 * Builds a trigger for a note; text is empty for a bodyless note. GitLab's API 16–18 carries no bot flag,
 * so `human` is name-based and automated accounts go through the policy list instead.
 */
export function noteTrigger(note: GitlabNote, ref: NoteRef, kind: 'conversation' | 'inline', agent: string): Trigger {
  const threadKind = ref.isMr ? 'mr' : 'issue'
  const discussion = ref.discussionId ?? (note.discussion_id && kind === 'inline' ? note.discussion_id : undefined)
  return { id: key('gitlab-note', String(note.id), note.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(ref.project, ref.iid, threadKind) }],
    actor: { source: SOURCE, id: note.author.username }, human: !sameName(note.author.username, agent),
    at: note.updated_at ?? note.created_at, text: [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n'),
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.project, ref.iid, threadKind, discussion),
    ...(ref.host ? { url: gitlabPage(ref.host, ref.project, ref.iid, threadKind) } : {}),
    meta: { project: ref.project, kind: threadKind, iid: ref.iid, isMr: ref.isMr, noteId: note.id,
      ...note.type ? { noteType: note.type } : {},
      ...note.position?.new_path ? { path: note.position.new_path, line: note.position.new_line ?? null } : {},
      ...discussion ? { discussionId: discussion } : {} } }
}
/** Builds the trigger for a newly opened Issue's title and description. */
export function issueTrigger(issue: GitlabIssue, agent: string, project: string): Trigger {
  return { id: key('gitlab-issue', String(issue.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(project, issue.iid, 'issue') }],
    actor: { source: SOURCE, id: issue.author.username }, human: !sameName(issue.author.username, agent), at: issue.created_at,
    text: `${issue.title}\n\n${issue.description ?? ''}`,
    ...(mentions(issue.description ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(project, issue.iid, 'issue'), url: issue.web_url,
    meta: { project, kind: 'issue', iid: issue.iid, isMr: false } }
}
/** Builds the trigger for a newly opened merge request; GitLab numbers Issues and merge requests in separate sequences, so it gets its own id format. */
export function mrTrigger(mr: GitlabMr, agent: string, project: string): Trigger {
  return { ...issueTrigger(mr, agent, project), id: key('gitlab-mr', String(mr.id)),
    threads: [{ source: SOURCE, id: threadId(project, mr.iid, 'mr') }], channel: gitlabChannel(project, mr.iid, 'mr'),
    meta: { project, kind: 'mr', iid: mr.iid, isMr: true, author: mr.author.username, ...mr.draft ? { draft: true } : {} } }
}
/** Builds a trigger for a default-branch pipeline transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(project: string, ref: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-ci', `branch:${project}:${ref}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `${project}:ci:${ref}` }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, url, meta: { ci: true, project, ref, sha, revision } }
}
/** Builds a trigger for a merge request's pipeline transition; the global id is not on a simple MR payload, so the id dedupes on `path!iid`. */
export function ciTrigger(mr: { project: string; iid: number; web_url: string; author: string }, revision: number, summary: string): Trigger {
  return { id: key('gitlab-ci', `${mr.project}!${mr.iid}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(mr.project, mr.iid, 'mr') }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, channel: gitlabChannel(mr.project, mr.iid, 'mr'), url: mr.web_url,
    meta: { project: mr.project, kind: 'mr', iid: mr.iid, isMr: true, author: mr.author, ci: true, revision } }
}
/** Classifies a pipeline status: failed, still running, or finished without failing. */
export function pipelineClass(status: string): 'failed' | 'running' | 'done' {
  if (status === 'failed') return 'failed'
  return ['created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'canceling'].includes(status) ? 'running' : 'done'
}
