import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { threadKey } from '../src/sources/gitlab-trigger.ts'
import { agentMr, claimMr, mrEndNotices, mrOf, mrsOf, observeMr, type MrRecord } from '../src/sources/gitlab-mr.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Engine } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GITLAB = { cli: '/bin/false', host: 'gitlab.example.com', login: 'glab-bot', email: 'glab-bot@example.com', project: 'group/proj', projects: ['group/proj'] }
const deployment = testDeployment({ gitlab: GITLAB })
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function host(overrides: Partial<SourceContextDeps> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-mr-'))
  dirs.push(directory)
  const store = new Store(join(directory, 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const assessor = { request: vi.fn(async () => {}) }
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(settings, sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => engine.receive(trigger))
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const context = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  return { ...context, store, engine, executor }
}
const ticket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [githubChannel(30, 'https://github.com/acme/widgets/pull/30#issuecomment-1')], assignments: [{ id: 'a', state: 'running', createdAt: '' }],
  inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'one', directory: '/tmp/one', assignment: 'x' },
  origin: { triggerId: 'x', triggerIds: [] }, ...overrides })
const openMr = (iid: number, branch = 'agent/one', project = 'group/proj'): MrRecord => ({ id: 9000 + iid, iid, project,
  title: `MR ${iid}`, description: '', state: 'opened', author: { id: 7, username: 'glab-bot' }, created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z', web_url: `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
  labels: [], source_branch: branch, target_branch: 'main', sha: 'abc1234' })
const mergedMr = (iid: number, at: string): MrRecord => ({ ...openMr(iid), state: 'merged', merged_at: at })
const closedMr = (iid: number, at: string): MrRecord => ({ ...openMr(iid), state: 'closed', closed_at: at })
const follow = (iid: number, project = 'group/proj') => ({ thread: threadKey(project, iid, 'mr'), own: true })

describe('MR identity on tickets', () => {
  it('collects a ticket\'s MR threads, the open one last', () => {
    const t = ticket('t1', { follows: [follow(12), { thread: 'gitlab:other!7', own: false, closed: { at: '', outcome: 'merged' } }, { thread: 'github:9', own: false }] })
    expect(mrsOf(t, true)).toEqual([{ project: 'group/proj', iid: 12 }])
    // Follows keep their insertion order; the ticket's MR is the last open one, else the last one it followed.
    expect(mrsOf(t).map(mr => mr.iid)).toEqual([12, 7])
    expect(mrOf(t)).toEqual({ project: 'group/proj', iid: 12 })
    expect(mrOf(ticket('t2'))).toBeUndefined()
  })
  it('recognizes the agent\'s own MR from the execution project only', () => {
    expect(agentMr(openMr(12), GITLAB)).toBe(true)
    expect(agentMr({ ...openMr(12), project: 'other/proj' }, GITLAB)).toBe(false)
    expect(agentMr({ ...openMr(12), author: { id: 3, username: 'carol' } }, GITLAB)).toBe(false)
    expect(agentMr(openMr(12), undefined)).toBe(false)
  })
})

describe('claiming an MR for a ticket', () => {
  it('binds the agent MR on the ticket branch and refuses a foreign one', () => {
    const h = host()
    h.store.tickets.save(ticket('t1'))
    expect(claimMr(h, 't1', openMr(12))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:group/proj!12', own: true }])
    expect(h.store.threads.get('gitlab:group/proj!12')?.meta).toMatchObject({ iid: 12, isMr: true, project: 'group/proj', mrAuthor: 'glab-bot' })
    expect(claimMr(h, 't1', { ...openMr(13, 'agent/one', 'other/proj'), author: { id: 3, username: 'carol' } }))
      .toContain('$DSH_SUPERAGENT_GITLAB_PROJECT')
    h.store.close()
  })
  it('binds the ticket\'s origin MR even when a person opened it', () => {
    const h = host()
    const origin: Trigger = { id: 'origin', source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/proj!20' }],
      actor: { source: 'gitlab', id: 'carol' }, human: true, at: '', text: 'please', meta: { project: 'group/proj', iid: 20, isMr: true, kind: 'mr' } }
    h.store.triggers.save(origin)
    h.store.tickets.save(ticket('t1', { origin: { triggerId: origin.id, triggerIds: [origin.id] } }))
    expect(claimMr(h, 't1', openMr(20, 'carol/fix'))).toBeUndefined()
    // A source MR binds as context, not as the ticket's own work; the agent's MR binds as its own.
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:group/proj!20', own: false }])
    h.store.close()
  })
  it('lets one open MR belong to one open ticket, and passes on a closed MR', () => {
    const h = host()
    h.store.tickets.save(ticket('t1'))
    expect(claimMr(h, 't1', openMr(12))).toBeUndefined()
    h.store.tickets.save(ticket('t2'))
    expect(claimMr(h, 't2', openMr(12))).toBe('MR already belongs to another active ticket')
    expect(claimMr(h, 't2', closedMr(14, '2026-09-02T00:00:00Z'))).toBeUndefined()
    expect(claimMr(h, 'ended', { ...openMr(15), source_branch: 'agent/one' })).toBe('Ticket ended because its MR was closed')
    h.store.tickets.save({ ...ticket('ended'), ended: { at: '', by: 'human', outcome: 'stopped' } })
    h.store.close()
  })
})

describe('observing MRs', () => {
  it('auto-binds an open agent MR to the unique open ticket on its branch and shows auto-merge', async () => {
    const h = host()
    h.store.tickets.save(ticket('t1'))
    await observeMr(h, { ...openMr(12), merge_when_pipeline_succeeds: true })
    expect(h.store.tickets.get('t1')!.follows).toEqual([follow(12)])
    expect(h.store.threads.get('gitlab:group/proj!12')?.meta).toMatchObject({ facts: { autoMerge: { value: { en: 'on' } } } })
    h.store.close()
  })
  it('ends tickets when the MR merges, keeps the follow, and notices the other conversations in the request language', async () => {
    const h = host()
    const request: Trigger = { id: key('r'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: '', text: '@bot 修一下标题', meta: {} }
    h.store.tickets.save(ticket('t1', { channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }] }))
    expect(claimMr(h, 't1', openMr(12))).toBeUndefined()
    expect(await observeMr(h, mergedMr(12, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('gitlab:group/proj!12')?.subscriptions).toEqual(['t1'])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    const notices = mrEndNotices(h.store.tickets.get('t1')!, request.text, GITLAB)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'notice', text: '[MR group/proj!12](https://gitlab.example.com/group/proj/-/merge_requests/12) 已合并。' })
    expect(notices[0]!.channel.source).toBe('feishu')
    // The same end notices once: the id is stable across rereads.
    expect(mrEndNotices(h.store.tickets.get('t1')!, request.text, GITLAB).map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
    const english = mrEndNotices(h.store.tickets.get('t1')!, 'fix the title', GITLAB)
    expect(english[0]!.text).toBe('[MR group/proj!12](https://gitlab.example.com/group/proj/-/merge_requests/12) has merged.')
    h.store.close()
  })
  it('closes without merging in English and keeps a ticket working on its other open MR', async () => {
    const h = host()
    h.store.tickets.save(ticket('t3', { execution: { name: 'one', directory: '/tmp', assignment: 'x' } }))
    expect(claimMr(h, 't3', openMr(21))).toBeUndefined()
    expect(claimMr(h, 't3', openMr(22))).toBeUndefined()
    expect(await observeMr(h, closedMr(22, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
    expect(mrOf(h.store.tickets.get('t3')!)).toEqual({ project: 'group/proj', iid: 21 })
    const request = { text: 'fix the title' }
    const notices = mrEndNotices({ ...ticket('t3', { follows: [{ thread: 'gitlab:group/proj!22', own: true, closed: { at: '2026-09-02T00:00:00Z', outcome: 'closed' } }] }),
      ended: { at: '', by: 'executor', outcome: 'closed' } } as Ticket, request.text, GITLAB)
    expect(notices[0]!.text).toContain('was closed without merging')
    h.store.close()
  })
})
