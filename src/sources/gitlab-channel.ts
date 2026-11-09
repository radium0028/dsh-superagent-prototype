/** GitLab outbound channel: posts Issue/MR notes and discussion replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gitlabAddress, gitlabPage, NoteSchema, type GitlabNote } from './gitlab-trigger.ts'

/**
 * True when the target no longer accepts replies: GitLab answers 404 for a deleted or inaccessible private Issue/MR alike,
 * and 403 with a locked message when the conversation is closed and locked. Everything else may succeed on a retry.
 */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 404 || (error.code === 403 && /locked/i.test(error.message)))
/** Posts a note or discussion reply with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('The GitLab Source has no working glab CLI')
  const address = message.channel.address
  const project = String(address.project ?? '')
  const iid = Number(address.iid)
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  if (!project || !iid) throw new Error('Missing GitLab reply target')
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery; when URL and address disagree, the address wins.
    const retained = gitlabAddress(address.url ?? '', gitlab.host)
    let discussion = address.discussion
    if (!discussion && retained && retained.iid === iid && sameName(retained.project, project) && retained.note !== undefined) {
      discussion = String(retained.note)
    }
    const prefix = `projects/${encodeURIComponent(project)}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (note: GitlabNote) => sameName(note.author.username, gitlab.login) && (note.body ?? '').includes(marker)
    if ((await commands.gitlabPages(NoteSchema, `${prefix}/notes?per_page=100`)).some(mine)) return 'sent'
    // Discussion replies exist only on merge requests; an Issue address that carries a discussion falls back to a top-level note.
    const target = kind === 'mr' && discussion !== undefined ? `${prefix}/discussions/${discussion}/notes` : `${prefix}/notes`
    await commands.gitlabApi(z.unknown(), target, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Links an address to its Issue or merge request page on the instance, preferring the address's own URL. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const base = `GitLab ${address.project ?? ''}${address.kind === 'mr' ? '!' : '#'}${address.iid ?? ''}`
  return { url: address.url ?? (links.gitlab
    ? gitlabPage(links.gitlab.host, address.project ?? '', Number(address.iid), address.kind === 'mr' ? 'mr' : 'issue') : ''),
    label: address.discussion ? { zh: `${base} 的讨论`, en: `${base} (discussion)` } : { zh: base, en: base } }
}
