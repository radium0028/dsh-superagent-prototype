import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV, type GitlabRetry } from '../src/kv.ts'
import { apply as applyGitlab, gitlabKind, name as pluginName, inject as pluginInject, pollFailure, pollRound } from '../src/sources/gitlab.ts'
import { issueTrigger, threadKey, type GitlabIssue, type GitlabMr, type GitlabNote } from '../src/sources/gitlab-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GITLAB = { cli: '/bin/false', host: 'gitlab.example.com', login: 'glab-bot', email: 'glab-bot@example.com',
  project: 'group/proj', projects: ['group/proj', 'acme/watched'] }
const HOSTED = `https://${GITLAB.host}`
const ENC = encodeURIComponent('group/proj')
/** Hour `n` of today, so fixture times sit inside the 14-day polling horizon. */
const at = (n: number) => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + n * 3_600_000).toISOString()
const SINCE = at(0)
const dirs: string[] = []
const boards = new WeakMap<SourceRegistry, HealthBoard>()
afterEach(() => { for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* A store left open by a failed test keeps the file locked. */ } } })

function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  boards.set(sources, board)
  return sources
}
function host(overrides: Partial<SourceContextDeps> = {},
  source: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} }) {
  const directory = mkdtempSync(join(tmpdir(), 'gitlab-source-'))
  dirs.push(directory)
  const store = new Store(join(directory, 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { gitlab: { allowed: [{ id: 'carol' }] } } }, eval: { mode: 'auto' },
    sources: { gitlab: source } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const deployment = testDeployment({ gitlab: GITLAB })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'gitlab', health: ['gitlab'] })
  const health = overrides.sources ? boards.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
const subscribed = (h: ReturnType<typeof host>, ref: { source: string; id: string }, meta: Record<string, unknown> = {}) =>
  h.store.threads.save({ key: `${ref.source}:${ref.id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['t1'],
    correlated: [], pending: [], meta })
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'carol' }, scope: '' }, channels: [],
  assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  execution: { name: 'one', directory: '/w/one', assignment: '' }, origin: { triggerId: 'x', triggerIds: [] } })
const issue = (iid: number, fields: Partial<GitlabIssue> = {}): GitlabIssue => ({ id: 500 + iid, iid, title: `Issue ${iid}`,
  description: 'details', state: 'opened', author: { id: 3, username: 'carol' }, created_at: at(2), updated_at: at(3),
  web_url: `${HOSTED}/group/proj/-/issues/${iid}`, ...fields })
const mr = (iid: number, fields: Partial<GitlabMr> = {}): GitlabMr => ({ ...issue(iid), id: 9000 + iid, title: `MR ${iid}`,
  web_url: `${HOSTED}/group/proj/-/merge_requests/${iid}`, source_branch: `feature/${iid}`, target_branch: 'main',
  sha: `sha-${iid}aaaa`, ...fields })
const note = (id: number, username: string, when: string, fields: Partial<GitlabNote> = {}): GitlabNote =>
  ({ id, body: `note ${id}`, author: { id: 3, username }, created_at: when, updated_at: when, system: false, type: null,
    discussion_id: null, ...fields })
const refused = (status: number, text: string) => commandError({ stderr: `glab: ${text} (HTTP ${status})`, code: 1 })
/** Stubs `glab api` calls against the two watched projects and returns the requested paths in order. */
function gitlab(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!)
    const path = args[1]!.split('?')[0]!
    const listed = /\/(issues|merge_requests|notes|discussions|jobs|latest)$/.test(path)
    const route = routes[path] ?? (listed ? [] : refused(404, 'Not Found'))
    const value: unknown = typeof route === 'function' ? (route as (args: string[]) => unknown)(args) : route
    if (value instanceof Error) throw value
    // `--paginate --output ndjson` answers one JSON item per line.
    if (args.includes('ndjson')) return (Array.isArray(value) ? value : [value]).map(item => JSON.stringify(item)).join('\n')
    return JSON.stringify(value)
  })
  return reads
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0])

describe('gitlab source', () => {
  it('registers its kind as a plugin and waits for setup before polling', async () => {
    const value = host({ sources: emptyRegistry(), configured: () => false })
    const disposers: (() => unknown)[] = []
    applyGitlab({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(value.sources.kind('gitlab')).toBe(gitlabKind)
    expect(pluginName).toBe('dsh-superagent-gitlab')
    expect(pluginInject).toEqual(['orchestrator'])
    await vi.waitFor(() => expect(value.health.gitlab).toMatchObject({ state: 'paused', detail: 'Waiting for the deployment check' }))
    for (const dispose of disposers) await dispose()
    value.store.close()
  })
  it('defaults its configuration, and reports failures only at the threshold', () => {
    expect(gitlabKind.schema.parse({})).toEqual({ host: '', project: '', projects: [], cli: '', agentEmail: '', pollSeconds: 60,
      failuresBeforeError: 1, observeIssues: false, observeMrs: false, observeNotes: false, observePipelines: false })
    expect(pollFailure(1, 2, new Error('boom'))).toBeUndefined()
    expect(pollFailure(2, 2, new Error('boom'))).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } })
  })
  it('maps triggers onto the admission table rows of its watched scopes', () => {
    const config = gitlabKind.schema.parse({ observeIssues: true })
    const rows = gitlabKind.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual(['issues', 'mrs', 'notes', 'pipelines'])
    expect(rows.map(row => [row.cells.listedUnaddressed, row.cells.unlistedAddressed, row.cells.unlistedUnaddressed]))
      .toEqual([[true, true, true], [false, true, false], [false, true, false], [false, false, false]])
    expect(rows[3]!.label).toEqual({ zh: '默认分支的流水线', en: 'Default branch pipelines' })
    expect(rows[3]!.note).toEqual({ zh: '不接收', en: 'Not received' })
    const scope = gitlabKind.scope!
    expect(scope({ meta: { ci: true, ref: 'main' } }, config)).toEqual({ listened: true, observed: false, row: 'pipelines' })
    // A merge request's own pipeline has no ref of its own; it is observed with the merge request.
    expect(scope({ meta: { ci: true, iid: 7 } }, config)).toEqual({ listened: true, observed: false })
    expect(scope({ meta: { kind: 'issue', iid: 3 } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(scope({ meta: { kind: 'mr', iid: 7, isMr: true } }, config)).toEqual({ listened: true, observed: false, row: 'mrs' })
    // A note carries the iid and kind of its Issue or merge request, and is its own row.
    expect(scope({ meta: { kind: 'issue', iid: 3, noteId: 5 } }, config)).toEqual({ listened: true, observed: false, row: 'notes' })
  })
  it('exposes the execution environment variables, with the iid only for a trigger of its own', () => {
    const values = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: GITLAB }), config: gitlabKind.schema.parse({}) })
    expect(values).toEqual({ DSH_SUPERAGENT_GITLAB_HOST: 'gitlab.example.com', DSH_SUPERAGENT_GITLAB_PROJECT: 'group/proj',
      DSH_SUPERAGENT_GITLAB_PROJECTS: 'group/proj,acme/watched', DSH_SUPERAGENT_GITLAB_ACCOUNT: 'glab-bot',
      DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: 'glab-bot@example.com', DSH_SUPERAGENT_GITLAB_IID: '' })
    const issueOf = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: GITLAB }), config: gitlabKind.schema.parse({}),
      trigger: issueTrigger(issue(3), 'glab-bot', 'group/proj') })
    expect(issueOf.DSH_SUPERAGENT_GITLAB_IID).toBe('3')
    const elsewhere = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: GITLAB }), config: gitlabKind.schema.parse({}),
      trigger: { id: 't', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'a' }, human: true,
        at: '', text: '', meta: { iid: 7 } } })
    expect(elsewhere.DSH_SUPERAGENT_GITLAB_IID).toBe('')
    expect(gitlabKind.facts!(testDeployment({ gitlab: GITLAB }))).toEqual({ cli: { zh: '当前账号 @glab-bot', en: 'Current account @glab-bot' } })
    expect(gitlabKind.facts!(testDeployment())).toEqual({})
  })
  it('finds threads by project path and iid, and bare numbers name nothing', () => {
    expect(gitlabKind.find!('group/proj#12')).toEqual({ threads: ['gitlab:group/proj#12'], terms: [] })
    expect(gitlabKind.find!('group/proj!12')).toEqual({ threads: ['gitlab:group/proj!12'], terms: [] })
    expect(gitlabKind.find!(`${HOSTED}/group/proj/-/issues/12`)).toEqual({ threads: ['gitlab:group/proj#12'], terms: [] })
    expect(gitlabKind.find!(`${HOSTED}/group/proj/-/merge_requests/12/`)).toEqual({ threads: ['gitlab:group/proj!12'], terms: [] })
    // Issues and merge requests number in separate sequences across many projects, so a bare number is ambiguous.
    expect(gitlabKind.find!('12')).toEqual({ threads: [], terms: [] })
  })
  it('lists each project\'s issues and merge requests since its cursor, takes in new ones, and skips its own', async () => {
    const h = host({}, { enabled: true, config: { observeIssues: true, observeMrs: true } })
    h.store.set(KV.gitlab.since('group/proj'), { issues: SINCE, mrs: SINCE })
    const agents = { author: { id: 9, username: 'glab-bot' } }
    const routes: Record<string, unknown> = {
      [`projects/${ENC}/issues`]: [issue(3, { description: '@glab-bot please fix the login' }), issue(4, agents), issue(5, { created_at: at(-48), updated_at: at(4) })],
      [`projects/${ENC}/merge_requests`]: [mr(7, { merge_when_pipeline_succeeds: true, updated_at: at(5) })],
      [`projects/acme%2Fwatched/issues`]: [], [`projects/acme%2Fwatched/merge_requests`]: [],
      [`projects/${ENC}/issues/3/notes`]: [], [`projects/${ENC}/issues/5/notes`]: [],
      [`projects/${ENC}/merge_requests/7/discussions`]: [], [`projects/${ENC}/merge_requests/7/notes`]: [],
    }
    const reads = gitlab(h, routes)
    await pollRound(h)
    const taken = h.receive.mock.calls.map(([trigger]) => trigger)
    // #3 is new and addresses the agent; #4 is the agent's own; #5 only changed, so it brings no description; #7 is a new MR.
    expect(taken.map(trigger => [trigger.meta.kind, trigger.meta.iid, trigger.addressed])).toEqual([['issue', 3, 'mention'], ['mr', 7, undefined]])
    expect(taken.find(trigger => trigger.meta.iid === 3)).toMatchObject({ id: key('gitlab-issue', '503'), url: `${HOSTED}/group/proj/-/issues/3`,
      channel: { source: 'gitlab', thread: 'gitlab:group/proj#3', address: { project: 'group/proj', iid: '3', kind: 'issue' } } })
    // The cursors moved to five seconds before the newest item of each stream, and each read item got its own checkpoint.
    const cursors = h.store.get<{ issues: string; mrs: string }>(KV.gitlab.since('group/proj'))!
    expect(cursors.issues).toBe(new Date(Date.parse(at(4)) - 5000).toISOString())
    expect(cursors.mrs).toBe(new Date(Date.parse(at(5)) - 5000).toISOString())
    // Each read item's checkpoint moved past what the stream read before, and the agent's own item got none.
    expect(Date.parse(h.store.get<string>(KV.gitlab.cursor('group/proj', 'issue', 3))!)).toBeGreaterThan(Date.parse(at(4)))
    expect(Date.parse(h.store.get<string>(KV.gitlab.cursor('group/proj', 'issue', 5))!)).toBeGreaterThan(Date.parse(at(4)))
    expect(Date.parse(h.store.get<string>(KV.gitlab.cursor('group/proj', 'mr', 7))!)).toBeGreaterThan(Date.parse(at(5)))
    expect(h.store.get(KV.gitlab.cursor('group/proj', 'issue', 4))).toBeUndefined()
    // The threads are named by their project path, iid, and title.
    expect(h.store.threads.get('gitlab:group/proj#3')!.meta).toMatchObject({ title: 'Issue 3', label: 'group/proj#3 Issue 3',
      facts: { number: { value: 'group/proj#3' } } })
    expect(h.store.threads.get('gitlab:group/proj!7')!.meta).toMatchObject({ title: 'MR 7', label: 'group/proj!7 MR 7',
      facts: { autoMerge: { value: { en: 'on' } } } })
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: '2 projects; next poll in 60s' })
    expect(bare(reads)).toEqual(expect.arrayContaining([`projects/${ENC}/issues`, `projects/${ENC}/merge_requests`]))
    h.store.close()
  })
  it('reads a changed item\'s notes newest first, stops before what it read, and skips system and own notes', async () => {
    const h = host({}, { enabled: true, config: { observeIssues: true } })
    h.store.set(KV.gitlab.since('group/proj'), { issues: SINCE, mrs: SINCE })
    const routes: Record<string, unknown> = {
      [`projects/${ENC}/issues`]: [issue(5, { created_at: at(-48), updated_at: at(4) })],
      [`projects/acme%2Fwatched/issues`]: [],
      [`projects/${ENC}/issues/5/notes`]: [note(31, 'carol', at(6)), note(32, 'glab-bot', at(6)), note(33, 'carol', at(6), { system: true }),
        note(30, 'carol', at(-1))],
    }
    const reads = gitlab(h, routes)
    await pollRound(h)
    // The list asks GitLab for the newest first; the read stops at the first note older than the cursor.
    expect(reads.find(path => path.includes('/notes'))).toBe(`projects/${ENC}/issues/5/notes?order_by=created_at&sort=desc&per_page=100`)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.noteId)).toEqual([31])
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { source: 'gitlab', id: 'carol' }, human: true, text: 'note 31',
      threads: [{ source: 'gitlab', id: 'group/proj#5' }], meta: { project: 'group/proj', kind: 'issue', iid: 5, noteId: 31 } })
    // The next round starts after what it read, so the same page brings nothing again.
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.store.close()
  })
  it('observes a ticket\'s merge request, and reports its pipeline change once', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t1'), follows: [{ thread: threadKey('group/proj', 12, 'mr'), own: true }] })
    subscribed(h, { source: 'gitlab', id: 'group/proj!12' }, { project: 'group/proj', iid: 12, isMr: true })
    const jobs = [({ name: 'test', status: 'success' })]
    const routes: Record<string, unknown> = {
      [`projects/${ENC}/merge_requests/12`]: mr(12, { source_branch: 'agent/one', author: { id: 9, username: 'glab-bot' }, sha: 'bbb2222', merge_when_pipeline_succeeds: true }),
      [`projects/${ENC}/pipelines/latest`]: { id: 9, sha: 'bbb2222' },
      [`projects/${ENC}/pipelines/9/jobs`]: () => jobs,
      [`projects/${ENC}/merge_requests/12/notes`]: [],
    }
    const reads = gitlab(h, routes)
    await pollRound(h)
    // The MR is read once per round, its auto-merge is observed, and the first pipeline look is only a baseline.
    expect(reads.filter(path => path === `projects/${ENC}/merge_requests/12`)).toHaveLength(1)
    expect(h.store.threads.get('gitlab:group/proj!12')!.meta.facts).toMatchObject({ autoMerge: { value: { en: 'on' } },
      ci: { label: '流水线', value: { zh: '通过', en: 'passed' } } })
    expect(h.store.get(KV.gitlab.pipeline('group/proj', 12))).toEqual({ fingerprint: expect.any(String), revision: 0 })
    expect(h.receive).not.toHaveBeenCalled()
    jobs[0] = { name: 'test', status: 'failed' }
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({
      id: key('gitlab-ci', 'group/proj!12', '1'), meta: { project: 'group/proj', kind: 'mr', iid: 12, isMr: true, author: 'glab-bot', ci: true, revision: 1 },
      text: `Pipeline failed 1/1 on MR group/proj!12 at bbb2222: test\nRead gitlab/projects/${ENC}/mrs/12/pipelines for every job.` })])
    expect(h.store.get(KV.gitlab.pipeline('group/proj', 12))).toEqual({ fingerprint: expect.any(String), revision: 1 })
    h.store.close()
  })
  it('tells of a watched project\'s default-branch pipeline once its failed jobs change, and skips a pipeline-less project', async () => {
    const h = host({}, { enabled: true, config: { observePipelines: true } })
    subscribed(h, { source: 'gitlab', id: 'group/proj:ci:main' })
    const jobs = [({ name: 'lint', status: 'success' }), ({ name: 'e2e', status: 'success' })]
    const routes: Record<string, unknown> = {
      [`projects/${ENC}`]: { default_branch: 'main' },
      [`projects/acme%2Fwatched`]: { default_branch: 'main' },
      [`projects/${ENC}/pipelines/latest`]: { id: 1, sha: 'aaa1111' },
      [`projects/acme%2Fwatched/pipelines/latest`]: refused(404, 'Not Found'),
      [`projects/${ENC}/pipelines/1/jobs`]: () => jobs,
    }
    const reads = gitlab(h, routes)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.branchCi('group/proj'))).toEqual({ branch: 'main', failures: [], revision: 0 })
    // A project whose default branch has no pipeline reads as empty instead of failing the round.
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: '2 projects; next poll in 60s' })
    jobs[0] = { name: 'lint', status: 'failed' }
    jobs[1] = { name: 'e2e', status: 'running' }
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({
      id: key('gitlab-ci', 'branch:group/proj:main', '1'),
      threads: [{ source: 'gitlab', id: 'group/proj:ci:main' }],
      text: `Pipeline failed 1/2 on main at aaa1111: lint; 1 still running\nRead gitlab/projects/${ENC}/pipelines/main for every job.`,
      url: `${HOSTED}/group/proj/-/commit/aaa1111`,
      meta: { ci: true, project: 'group/proj', ref: 'main', sha: 'aaa1111', revision: 1 } })])
    expect(h.store.threads.get('gitlab:group/proj:ci:main')!.meta).toMatchObject({ label: 'CI on main',
      facts: { ci: { label: { zh: '流水线失败', en: 'Pipeline failed' }, value: '1', problem: true } } })
    // A poll that changes nothing reports nothing again, and the CI Thread asks for no notes.
    const before = h.receive.mock.calls.length
    await pollRound(h)
    expect(h.receive.mock.calls).toHaveLength(before)
    expect(reads.filter(path => path.includes('acme%2Fwatched/pipelines'))).toHaveLength(3)
    expect(h.store.get(KV.gitlab.branchCi('group/proj'))).toEqual({ branch: 'main', failures: ['lint'], revision: 1 })
    h.store.close()
  })
  it('polls a subscribed thread since its checkpoint and advances it', async () => {
    const h = host()
    subscribed(h, { source: 'gitlab', id: 'group/proj#3' }, { project: 'group/proj', iid: 3, kind: 'issue' })
    h.store.set(KV.gitlab.cursor('group/proj', 'issue', 3), SINCE)
    gitlab(h, { [`projects/${ENC}/issues/3/notes`]: [note(31, 'carol', at(6)), note(30, 'carol', at(-1))] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.noteId)).toEqual([31])
    expect(Date.parse(h.store.get<string>(KV.gitlab.cursor('group/proj', 'issue', 3))!)).toBeGreaterThan(Date.parse(SINCE))
    expect(h.store.threads.get('gitlab:group/proj#3')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('records a failed thread read, retries it, and drops it after a day or when GitLab answers 404', async () => {
    const h = host()
    subscribed(h, { source: 'gitlab', id: 'group/proj#5' }, { project: 'group/proj', iid: 5, kind: 'issue' })
    const routes: Record<string, unknown> = { [`projects/${ENC}/issues/5/notes`]: refused(502, 'Bad Gateway') }
    gitlab(h, routes)
    // Every step runs, and then the round fails; the read position stays where it was.
    await expect(pollRound(h)).rejects.toThrow('gitlab:group/proj#5: Error: glab: Bad Gateway (HTTP 502)')
    const retries = () => h.store.get<Record<string, GitlabRetry>>(KV.gitlab.retries)!
    expect(retries()['gitlab:group/proj#5']).toEqual({ thread: 'gitlab:group/proj#5', since: expect.any(String),
      failedAt: expect.any(String), attempts: 1 })
    expect(h.store.threads.get('gitlab:group/proj#5')!.meta.pollError).toContain('502')
    // However many reads failed, a day of failures has not passed: the read is retried, and the round still fails.
    const first = retries()['gitlab:group/proj#5']!
    await expect(pollRound(h)).rejects.toThrow('gitlab:group/proj#5')
    expect(retries()['gitlab:group/proj#5']!.attempts).toBe(2)
    // A day after the first failed read, it is dropped: the round does not fail, and its read position stays.
    h.store.set(KV.gitlab.retries, { [`gitlab:group/proj#5`]: { ...first, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } })
    await pollRound(h)
    expect(h.store.get(KV.gitlab.retries)).toEqual({})
    expect(h.store.get(KV.gitlab.cursor('group/proj', 'issue', 5))).toBeUndefined()
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: expect.stringContaining('dropped after their reads kept failing: gitlab:group/proj#5') })
    // GitLab answers 404 for a deleted or inaccessible item alike: that is dropped at once, not retried.
    routes[`projects/${ENC}/issues/5/notes`] = refused(404, 'Not Found')
    await pollRound(h)
    expect(h.health.gitlab).toMatchObject({ state: 'ready', detail: expect.stringContaining('gone on GitLab: gitlab:group/proj#5') })
    expect(h.store.get(KV.gitlab.retries)).toEqual({})
    h.store.close()
  })
})
