/** Read-only GitLab project, conversation, and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { isCliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { isSystemNote, IssueSchema, MrSchema, NoteSchema, notePlace, pipelineClass, type GitlabIssue, type GitlabMr, type GitlabNote } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

export interface PipelineSnapshot { head: string; checks: { name: string; state: 'failed' | 'running' | 'done' }[] }
const JobSchema = z.looseObject({ name: z.string(), status: z.string() })
const DiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(z.unknown()).nullish(),
  resolvable: z.boolean().nullish(), resolved: z.boolean().nullish() })
type Discussion = z.infer<typeof DiscussionSchema>

export function pipelineCounts(snapshot: PipelineSnapshot): { failed: number; running: number } {
  return { failed: snapshot.checks.filter(check => check.state === 'failed').length,
    running: snapshot.checks.filter(check => check.state === 'running').length }
}
export function pipelineSummary(snapshot: PipelineSnapshot, where: string, read: string): string {
  const results = snapshot.checks.map(({ name, state }) => ({ name, failed: state === 'failed', running: state === 'running' }))
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `Pipeline failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `Pipeline running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `Pipeline passed ${results.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every job.`
}
export function pipelineFailures(snapshot: PipelineSnapshot): string[] {
  return snapshot.checks.filter(check => check.state === 'failed').map(check => check.name).sort()
}
export function pipelineFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: '流水线失败', en: 'Pipeline failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: '流水线进行中', en: 'Pipeline running' }, value: String(counts.running) }
  return { label: '流水线', value: { zh: '通过', en: 'passed' } }
}

/** Formats a note as a model-facing message; an inline note carries its file and line from its position. */
function noteMessage(note: GitlabNote): ContextMessage {
  const position = note.type ? note.position : undefined
  const path = position?.new_path ?? position?.old_path ?? undefined
  const line = position?.new_line ?? position?.old_line ?? undefined
  return { id: String(note.id), from: note.author.username, at: note.created_at,
    text: [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n'),
    ...path ? { path } : {}, ...line != null ? { line } : {} }
}
/** Formats an Issue or merge request's own title and description, addressed by its web page. */
const gitlabMessage = (item: GitlabIssue | GitlabMr): ContextMessage =>
  ({ id: item.web_url, from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}` })

/** The pipeline jobs of one pipeline, classified into failed, running, and finished checks. */
async function pipelineJobs(commands: Commands, enc: string, id: number, tally?: Tally): Promise<PipelineSnapshot['checks']> {
  const jobs = await commands.gitlabPages(JobSchema, `projects/${enc}/pipelines/${id}/jobs?per_page=100`, ...(tally ? [tally] : []))
  return jobs.map(({ name, status }) => ({ name, state: pipelineClass(status) }))
}
/**
 * The latest pipeline of a ref (typically the default branch) as `{ head, checks }`; a ref without a pipeline
 * (GitLab answers 403 or 404) reads as an empty snapshot rather than an error.
 */
export async function pipelineSnapshot(commands: Commands, project: string, ref: string, tally?: Tally): Promise<PipelineSnapshot> {
  const enc = encodeURIComponent(project)
  try {
    const latest = await commands.gitlabApi(z.looseObject({ id: z.number(), sha: z.string() }), `projects/${enc}/pipelines/latest?ref=${encodeURIComponent(ref)}`)
    return { head: latest.sha, checks: await pipelineJobs(commands, enc, latest.id, tally) }
  } catch (error) {
    if (isCliError(error) && (error.code === 403 || error.code === 404)) return { head: '', checks: [] }
    throw error
  }
}

const USAGE = 'Use gitlab/projects/<path>/issues/<iid> or gitlab/projects/<path>/mrs/<iid>, append /notes/<page>, or for merge requests '
  + '/discussions/<page>, /discussion/<id> or /pipelines; or gitlab/projects/<path>/pipelines/<ref>'
/** Validates a path's segments now that dots are legal in project and ref names; `.` and `..` sequences escape. */
const noEscape = (path: string): string => {
  if (path.split('/').some(part => !part || part === '.' || part.includes('..'))) throw new Error(USAGE)
  return path
}
const PROJECT = '[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)*'
const ITEM = new RegExp(`^gitlab\\/projects\\/(${PROJECT})\\/(issues|mrs)\\/([1-9]\\d*)(?:\\/(notes|discussions|discussion|pipelines)(?:\\/([^\\/?#\\s]+))?)?$`)
const BRANCH = new RegExp(`^gitlab\\/projects\\/(${PROJECT})\\/pipelines\\/([^\\/?#\\s]+)$`)
/** The notes of one discussion, in order, with replies naming the discussion's first note. */
const threadMessages = (notes: GitlabNote[]): ContextMessage[] =>
  notes.map((note, index) => index ? { ...noteMessage(note), reply_to: String(notes[0]!.id) } : noteMessage(note))
const discussionNotes = (discussion: Discussion, tally?: Tally): ContextMessage[] =>
  validItems(NoteSchema, discussion.notes ?? [], tally).filter(note => !isSystemNote(note)).map(noteMessage)

/** One bounded page of an Issue's or merge request's notes, 20 per page with the next page reference when full. */
async function notePage(commands: Commands, project: string, kind: 'issue' | 'mr', iid: number, page: number) {
  const enc = encodeURIComponent(project)
  const listed = await commands.gitlabApi(z.array(z.unknown()),
    `projects/${enc}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => !isSystemNote(note))
  return { messages: notes.map(noteMessage), ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `gitlab/projects/${project}/${kind === 'mr' ? 'mrs' : 'issues'}/${iid}/notes/${page + 1}` } : {} }
}
/** One bounded page of a merge request's discussion threads, 20 per page with the next page reference when full. */
async function discussionPage(commands: Commands, project: string, iid: number, page: number) {
  const enc = encodeURIComponent(project)
  const listed = await commands.gitlabApi(z.array(z.unknown()), `projects/${enc}/merge_requests/${iid}/discussions?per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const discussions = validItems(DiscussionSchema, listed, tally)
  return { discussions: discussions.map(discussion => ({ id: discussion.id,
      ...discussion.resolvable ? { resolvable: true } : {}, ...discussion.resolved ? { resolved: true } : {},
      notes: discussionNotes(discussion, tally) })),
    ...tally.skipped ? { skipped: tally.skipped } : {},
    ...listed.length === 20 ? { next_resource: `gitlab/projects/${project}/mrs/${iid}/discussions/${page + 1}` } : {} }
}
/** All notes of one discussion thread, the first its root and every reply naming it. */
async function discussionThread(commands: Commands, project: string, iid: number, id: string): Promise<ContextMessage[]> {
  const discussions = await commands.gitlabPages(DiscussionSchema, `projects/${encodeURIComponent(project)}/merge_requests/${iid}/discussions?per_page=100`)
  const discussion = discussions.find(item => item.id === id)
  if (!discussion) throw new Error('No discussion of this merge request has that id')
  return threadMessages(validItems(NoteSchema, discussion.notes ?? []).filter(note => !isSystemNote(note)))
}
/** The Issue or merge request itself with its title and description message. */
async function description(commands: Commands, project: string, kind: 'issue' | 'mr', iid: number) {
  const enc = encodeURIComponent(project)
  const item = await commands.gitlabApi(kind === 'mr' ? MrSchema : IssueSchema, `projects/${enc}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`)
  if (kind === 'mr') return { iid: item.iid, project, title: item.title, state: item.state === 'opened' ? 'open' : item.state,
    labels: (item.labels ?? []).map(label => label.title), web_url: item.web_url, source_branch: item.source_branch,
    target_branch: item.target_branch, ...item.sha ? { sha: item.sha } : {}, ...item.draft ? { draft: true } : {},
    ...item.merge_when_pipeline_succeeds ? { autoMerge: true } : {},
    ...item.detailed_merge_status ? { detailed_merge_status: item.detailed_merge_status } : {}, ...gitlabMessage(item) }
  return { iid: item.iid, project, title: item.title, state: item.state === 'opened' ? 'open' : item.state,
    labels: (item.labels ?? []).map(label => label.title), web_url: item.web_url, ...gitlabMessage(item) }
}

/**
 * Reads an Issue or merge request, a page of its notes, a merge request's discussions, one discussion thread, or a
 * pipeline snapshot as model-facing `{ id, from, at, text, reply_to?, path?, line? }` messages and summaries
 * rather than raw GitLab API records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const branch = BRANCH.exec(resource)
  if (branch) {
    let ref: string
    try { ref = decodeURIComponent(branch[2]!) } catch { throw new Error(USAGE) }
    return pipelineSnapshot(commands, noEscape(branch[1]!), noEscape(ref))
  }
  const item = ITEM.exec(resource)
  if (!item) throw new Error(USAGE)
  const [, project, kind, iid, section, suffix] = item
  const isMr = kind === 'mrs'
  if (!isMr && (section === 'discussions' || section === 'discussion' || section === 'pipelines'))
    throw new Error('Discussions and pipelines require a merge request')
  if (section === 'discussion') {
    if (!suffix) throw new Error('Name the discussion by its id: gitlab/projects/<path>/mrs/<iid>/discussion/<discussion-id>')
    return { messages: await discussionThread(commands, noEscape(project!), Number(iid), suffix) }
  }
  if (section === 'pipelines') {
    if (suffix) throw new Error(USAGE)
    const enc = encodeURIComponent(noEscape(project!))
    const mr = await commands.gitlabApi(z.looseObject({ sha: z.string() }), `projects/${enc}/merge_requests/${iid}`)
    const sha = mr.sha ?? ''
    const listed = await commands.gitlabApi(z.array(z.looseObject({ id: z.number() })), `projects/${enc}/pipelines?sha=${encodeURIComponent(sha)}&per_page=1`)
    const [pipeline] = listed
    return { head: sha, checks: pipeline ? await pipelineJobs(commands, enc, pipeline.id) : [] }
  }
  if (section === 'notes' || section === 'discussions') {
    if (suffix && !/^[1-9]\d*$/.test(suffix)) throw new Error(USAGE)
    const page = suffix ? Number(suffix) : 1
    return section === 'notes' ? notePage(commands, noEscape(project!), isMr ? 'mr' : 'issue', Number(iid), page)
      : discussionPage(commands, noEscape(project!), Number(iid), page)
  }
  return description(commands, noEscape(project!), isMr ? 'mr' : 'issue', Number(iid))
}

/** One page of an Issue's or merge request's conversation (its description first on page 1), 100 notes per page. */
async function conversationPage(commands: Commands, project: string, kind: 'issue' | 'mr', iid: number, page: number) {
  const enc = encodeURIComponent(project)
  const messages: ContextMessage[] = []
  if (page === 1) messages.push(gitlabMessage(await commands.gitlabApi(kind === 'mr' ? MrSchema : IssueSchema,
    `projects/${enc}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`)))
  const listed = await commands.gitlabApi(z.array(z.unknown()),
    `projects/${enc}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes?per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => !isSystemNote(note))
  messages.push(...notes.map(noteMessage))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * Context reader for a GitLab Trigger: reads a pipeline trigger as its own single CI message, an inline note as its
 * discussion thread (whose first message is its root and parent), or the Issue/merge request conversation by page
 * (whose first page is its root and parent).
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => typeof trigger.meta.noteId === 'number' ? String(trigger.meta.noteId) : trigger.url ?? trigger.id,
  read: async (commands, trigger, part, cursor) => {
    // A pipeline transition has no conversation; its Trigger is its context.
    if (trigger.meta.ci === true) {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'pipeline', messages: [message] }, status: 'pipeline' }
    }
    const meta = trigger.meta
    if (typeof meta.discussionId === 'string' && typeof meta.project === 'string' && typeof meta.iid === 'number') {
      const thread = await discussionThread(commands, meta.project, meta.iid, meta.discussionId)
      const messages = part === 'thread' ? thread : thread.slice(0, 1)
      return { messages, body: { status: 'discussion', messages }, status: 'discussion' }
    }
    const body = await conversationPage(commands, String(meta.project), meta.kind === 'mr' ? 'mr' : 'issue', Number(meta.iid), Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
