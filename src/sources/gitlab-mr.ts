/** Merge request binding, lifecycle observation, and terminal IM notification helpers, bound to the execution project. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment, GitlabAccount } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { ticketBranch } from './github-pull.ts'
import { gitlabPage, parseThread, SOURCE, threadKey, MrSchema } from './gitlab-trigger.ts'

/** An MR as `merge_requests/<iid>` returns it, plus the project path and iid the read named. */
export type MrRecord = z.infer<typeof MrSchema> & { project: string; iid: number }
export const readMr = async (ctx: SourceContext, project: string, iid: number, signal?: AbortSignal): Promise<MrRecord> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(MrSchema, `projects/${encodeURIComponent(project)}/merge_requests/${iid}`), project, iid })
/** The GitLab MR threads a ticket follows, as project and iid pairs; with `open`, only the ones still open. */
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): { project: string; iid: number }[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed)
    .flatMap(item => { const parsed = parseThread(item.thread); return parsed?.kind === 'mr' ? [{ project: parsed.project, iid: parsed.iid }] : [] })
export const mrOf = (ticket: Pick<Ticket, 'follows'>): { project: string; iid: number } | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/** True when the MR was opened by the agent account in the execution project (not a fork or another watched project). */
export const agentMr = (mr: Pick<MrRecord, 'author' | 'project'>, gitlab: Deployment['gitlab']): boolean =>
  !!gitlab && sameName(mr.author.username, gitlab.login) && sameName(mr.project, gitlab.project)
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR in the
 * execution project from the ticket's branch, enforcing that one MR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the MR is bound or not open (which is not an error).
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: MrRecord): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isMr === true && source.meta.iid === mr.iid && source.meta.project === mr.project
  const opened = agentMr(mr, ctx.deployment.gitlab) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the agent account'
    return `MR does not belong to this ticket: use the source MR, or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME in $DSH_SUPERAGENT_GITLAB_PROJECT; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).some(other => other.project === mr.project && other.iid === mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadKey(mr.project, mr.iid, 'mr'))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, mr: MrRecord): Promise<boolean> {
  const ended = mr.state === 'closed' || mr.state === 'merged' || !!mr.merged_at
  if (ended) closeMr(ctx, mr)
  else {
    const candidates = agentMr(mr, ctx.deployment.gitlab) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === threadKey(mr.project, mr.iid, 'mr') && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(other => other.project === mr.project && other.iid === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  ctx.threads.describe(threadKey(mr.project, mr.iid, 'mr'), { facts: { autoMerge: !ended && mr.merge_when_pipeline_succeeds === true ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MrRecord, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `${mr.project}!${mr.iid}` }, own)
    ctx.threads.patch(threadKey(mr.project, mr.iid, 'mr'), { iid: mr.iid, project: mr.project, isMr: true, url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/**
 * Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the MR stays so a later human note there resumes the ticket.
 */
function closeMr(ctx: SourceContext, mr: MrRecord): void {
  const follows = (id: string): boolean => (ctx.tickets.get(id)?.follows ?? []).some(item => item.thread === threadKey(mr.project, mr.iid, 'mr'))
  if (!ctx.tickets.open().some(ticket => follows(ticket.id))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `${mr.project}!${mr.iid}` }, mr.merged_at ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its MR (selecting the last-closed MR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function mrEndNotices(ticket: Ticket, request: string, gitlab: GitlabAccount): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const closed = (item: Follow): { project: string; iid: number } | undefined => {
    const parsed = parseThread(item.thread)
    return parsed?.kind === 'mr' && item.closed ? { project: parsed.project, iid: parsed.iid } : undefined
  }
  const follows = (ticket.follows ?? []).flatMap(item => { const mr = closed(item); return mr ? [{ ...mr, own: item.own, closed: item.closed! }] : [] })
  const latest = <T extends { closed: { at: string } }>(items: T[]): T | undefined => items.sort((a, b) => b.closed.at.localeCompare(a.closed.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const label = `${follow.project}!${follow.iid}`
  const url = gitlabPage(gitlab.host, follow.project, follow.iid, 'mr')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR ${label}](${url}) 已合并。` : `[MR ${label}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR ${label}](${url}) has merged.` : `[MR ${label}](${url}) was closed without merging.`
  // GitLab notes and MR timelines already show the merge or closure, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', label, channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
