import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError, type Commands } from '../src/infra/commands.ts'
import type { Trigger } from '../src/core/index.ts'
import { gitlabThreadContext, pipelineCounts, pipelineFact, pipelineFailures, pipelineSnapshot, pipelineSummary,
  readGitlab } from '../src/sources/gitlab-read.ts'

const api = vi.fn<(schema: unknown, path: string, ...flags: string[]) => Promise<unknown>>()
const pages = vi.fn<(item: unknown, path: string, tally?: unknown) => Promise<unknown>>()
const commands = { gitlabApi: api, gitlabPages: pages } as unknown as Commands
beforeEach(() => { api.mockReset(); pages.mockReset() })

/** Fake GitLab note payload. */
const note = (fields: Record<string, unknown> = {}) => ({ id: 301, body: 'looks wrong', author: { id: 42, username: 'alice' },
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T01:00:00Z', ...fields })
/** Fake GitLab issue payload; an MR adds its branches on top. */
const issue = (fields: Record<string, unknown> = {}) => ({ id: 9001, iid: 12, title: 'Fix the margin', description: 'Details',
  state: 'opened', author: { id: 42, username: 'alice' }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
  web_url: 'https://gitlab.example.com/group/sub/proj/-/issues/12', labels: [{ id: 7, title: 'ui' }], ...fields })
const mr = (fields: Record<string, unknown> = {}) => ({ ...issue({ iid: 34, web_url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34' }),
  source_branch: 'agent/fix', target_branch: 'main', ...fields })
const trigger = (meta: Record<string, unknown>, fields: Partial<Trigger> = {}): Trigger => ({ id: 'gitlab-note-1', source: 'gitlab',
  threads: [{ source: 'gitlab', id: 'g/p#1' }], actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z',
  text: 'hello', meta, ...fields } as Trigger)

describe('gitlab read', () => {
  it('reads an Issue with its labels, open state, and description message', async () => {
    api.mockResolvedValue(issue())
    expect(await readGitlab(commands, 'gitlab/projects/group/sub/proj/issues/12')).toEqual({
      iid: 12, project: 'group/sub/proj', title: 'Fix the margin', state: 'open', labels: ['ui'],
      web_url: 'https://gitlab.example.com/group/sub/proj/-/issues/12',
      id: 'https://gitlab.example.com/group/sub/proj/-/issues/12', from: 'alice', at: '2026-09-01T00:00:00Z',
      text: 'Fix the margin\n\nDetails' })
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/group%2Fsub%2Fproj/issues/12')
  })

  it('reads a merge request with its branches, head commit, draft, and auto-merge state', async () => {
    api.mockResolvedValue(mr({ sha: 'abc1234', draft: true, merge_when_pipeline_succeeds: true, detailed_merge_status: 'ci_still_running' }))
    expect(await readGitlab(commands, 'gitlab/projects/group/sub/proj/mrs/34')).toEqual({
      iid: 34, project: 'group/sub/proj', title: 'Fix the margin', state: 'open', labels: ['ui'],
      web_url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34', source_branch: 'agent/fix', target_branch: 'main',
      sha: 'abc1234', draft: true, autoMerge: true, detailed_merge_status: 'ci_still_running',
      id: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34', from: 'alice', at: '2026-09-01T00:00:00Z',
      text: 'Fix the margin\n\nDetails' })
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/group%2Fsub%2Fproj/merge_requests/34')
  })

  it('reads a bounded note page with inline positions, skipping system notes, and exposes the next page', async () => {
    const items: Record<string, unknown>[] = Array.from({ length: 20 }, (_, index) => note({ id: index + 1, body: `c${index}`, system: index === 19 ? true : undefined }))
    items[0] = { ...items[0]!, type: 'DiffNote', position: { new_path: 'src/render.ts', new_line: 43, old_path: null, old_line: null } }
    api.mockResolvedValue(items)
    const page = await readGitlab(commands, 'gitlab/projects/g/p/issues/12/notes/2') as { messages: { id: string; text: string }[] }
    expect(page.messages).toHaveLength(19)
    expect(page.messages[0]).toEqual({ id: '1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'src/render.ts:43\n\nc0',
      path: 'src/render.ts', line: 43 })
    expect(page.messages[1]).toEqual({ id: '2', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'c1' })
    expect((page as { next_resource?: string }).next_resource).toBe('gitlab/projects/g/p/issues/12/notes/3')
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/issues/12/notes?per_page=20&page=2')
    // merge request notes are the same shape on the merge_requests path
    api.mockResolvedValue([note({ id: 1 })])
    await readGitlab(commands, 'gitlab/projects/g/p/mrs/34/notes/1')
    expect(api).toHaveBeenLastCalledWith(expect.anything(), 'projects/g%2Fp/merge_requests/34/notes?per_page=20&page=1')
  })

  it('rejects malformed or mismatched resources without making a request', async () => {
    for (const resource of ['gitlab/../x', 'gitlab/projects/a..b/issues/1', 'gitlab/projects/g/p/issues/0', 'gitlab/projects/g/p/issues/1/notes/0',
      'gitlab/projects/g/p/issues/1/discussions/1', 'gitlab/projects/g/p/issues/1/pipelines', 'gitlab/projects/g/p/pipelines/',
      'gitlab/projects/g/p/pipelines/..', 'gitlab/projects/g/p/pipelines/%zz', 'gitlab/projects/g/p/mrs/1/discussion']) {
      await expect(readGitlab(commands, resource)).rejects.toThrow()
    }
    expect(api).not.toHaveBeenCalled()
    expect(pages).not.toHaveBeenCalled()
  })

  it('reads a page of merge request discussions with their resolution state and the next page', async () => {
    const discussions = [{ id: 'd1', individual_note: false, notes: [note({ id: 1, body: 'root' }), note({ id: 2, body: 'reply' })] },
      { id: 'd2', individual_note: true, resolvable: true, resolved: true, notes: [note({ id: 3, body: 'noise', system: true })] },
      ...Array.from({ length: 18 }, (_, index) => ({ id: `dx${index}`, notes: [] }))]
    api.mockResolvedValue(discussions)
    expect(await readGitlab(commands, 'gitlab/projects/g/p/mrs/34/discussions/1')).toEqual({
      discussions: [
        { id: 'd1', notes: [{ id: '1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'root' },
          { id: '2', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'reply' }] },
        { id: 'd2', resolvable: true, resolved: true, notes: [] },
        ...Array.from({ length: 18 }, (_, index) => ({ id: `dx${index}`, notes: [] }))],
      next_resource: 'gitlab/projects/g/p/mrs/34/discussions/2' })
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/merge_requests/34/discussions?per_page=20&page=1')
  })

  it('reads one discussion by id as a thread whose replies answer the root note', async () => {
    pages.mockResolvedValue([{ id: 'other', notes: [note({ id: 9, body: 'elsewhere' })] },
      { id: 'd1', resolvable: true, notes: [note({ id: 1, body: 'root' }), note({ id: 2, body: 'noise', system: true }), note({ id: 3, body: 'reply2' })] }])
    expect(await readGitlab(commands, 'gitlab/projects/g/p/mrs/34/discussion/d1')).toEqual({ messages: [
      { id: '1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'root' },
      { id: '3', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'reply2', reply_to: '1' }] })
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/merge_requests/34/discussions?per_page=100')
    pages.mockResolvedValue([])
    await expect(readGitlab(commands, 'gitlab/projects/g/p/mrs/34/discussion/zz')).rejects.toThrow('that id')
  })

  it('reads a merge request pipeline for its head commit, or an empty snapshot when it has none', async () => {
    api.mockResolvedValueOnce(mr({ sha: 'abc1234' })).mockResolvedValueOnce([{ id: 77 }])
    pages.mockResolvedValue([{ name: 'rspec', status: 'failed' }, { name: 'lint', status: 'success' }])
    expect(await readGitlab(commands, 'gitlab/projects/g/p/mrs/34/pipelines'))
      .toEqual({ head: 'abc1234', checks: [{ name: 'rspec', state: 'failed' }, { name: 'lint', state: 'done' }] })
    expect(api).toHaveBeenNthCalledWith(1, expect.anything(), 'projects/g%2Fp/merge_requests/34')
    expect(api).toHaveBeenNthCalledWith(2, expect.anything(), 'projects/g%2Fp/pipelines?sha=abc1234&per_page=1')
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/pipelines/77/jobs?per_page=100')
    api.mockReset().mockResolvedValueOnce(mr({ sha: 'abc1234' })).mockResolvedValueOnce([])
    expect(await readGitlab(commands, 'gitlab/projects/g/p/mrs/34/pipelines')).toEqual({ head: 'abc1234', checks: [] })
  })

  it('reads a ref pipeline snapshot, taking encoded refs, and stays silent when the ref has none', async () => {
    api.mockResolvedValueOnce({ id: 77, sha: 'abcdef1234567890' })
    pages.mockResolvedValue([{ name: 'jest', status: 'running' }, { name: 'build', status: 'failed' }, { name: 'docs', status: 'success' }])
    expect(await readGitlab(commands, 'gitlab/projects/g/p/pipelines/main')).toEqual({ head: 'abcdef1234567890', checks: [
      { name: 'jest', state: 'running' }, { name: 'build', state: 'failed' }, { name: 'docs', state: 'done' }] })
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/pipelines/latest?ref=main')
    api.mockReset().mockResolvedValueOnce({ id: 77, sha: 'abcdef1234567890' })
    pages.mockResolvedValue([])
    await readGitlab(commands, 'gitlab/projects/g/p/pipelines/feature%2Fx')
    expect(api).toHaveBeenLastCalledWith(expect.anything(), 'projects/g%2Fp/pipelines/latest?ref=feature%2Fx')
    api.mockRejectedValue(new CliError('Not Found (404)', 404))
    expect(await pipelineSnapshot(commands, 'g/p', 'main')).toEqual({ head: '', checks: [] })
    api.mockRejectedValue(new CliError('Forbidden (403)', 403))
    expect(await pipelineSnapshot(commands, 'g/p', 'main')).toEqual({ head: '', checks: [] })
    api.mockRejectedValue(new CliError('Internal Server Error (500)', 500))
    await expect(pipelineSnapshot(commands, 'g/p', 'main')).rejects.toThrow('Internal Server Error')
  })

  it('counts, names, summarizes, and reports pipeline checks', () => {
    const snapshot = { head: 'abcdef1234567890', checks: [
      { name: 'zebra', state: 'failed' as const }, { name: 'apple', state: 'running' as const },
      { name: 'mango', state: 'done' as const }, { name: 'kiwi', state: 'failed' as const }] }
    expect(pipelineCounts(snapshot)).toEqual({ failed: 2, running: 1 })
    expect(pipelineFailures(snapshot)).toEqual(['kiwi', 'zebra'])
    expect(pipelineSummary(snapshot, 'g/p!34', 'gitlab/projects/g/p/mrs/34/pipelines'))
      .toBe('Pipeline failed 2/4 on g/p!34 at abcdef1: zebra, kiwi; 1 still running\nRead gitlab/projects/g/p/mrs/34/pipelines for every job.')
    expect(pipelineSummary({ head: '', checks: [] }, 'g/p#12', 'somewhere'))
      .toBe('Pipeline passed 0/0 on g/p#12 at \nRead somewhere for every job.')
    expect(pipelineFact({ failed: 2, running: 0 })).toEqual({ label: { zh: '流水线失败', en: 'Pipeline failed' }, value: '2', problem: true })
    expect(pipelineFact({ failed: 0, running: 3 })).toEqual({ label: { zh: '流水线进行中', en: 'Pipeline running' }, value: '3' })
    expect(pipelineFact({ failed: 0, running: 0 })).toEqual({ label: '流水线', value: { zh: '通过', en: 'passed' } })
  })

  it('reads a pipeline trigger as its single CI message', async () => {
    const ci = trigger({ ci: true, project: 'g/p', ref: 'main', sha: 'abc', revision: 1 },
      { url: 'https://gitlab.example.com/g/p/-/pipelines/7', text: 'Pipeline failed' })
    expect(gitlabThreadContext.messageId(ci)).toBe('https://gitlab.example.com/g/p/-/pipelines/7')
    const part = await gitlabThreadContext.read(commands, ci, 'thread', undefined, undefined)
    expect(part.messages).toEqual([{ id: 'https://gitlab.example.com/g/p/-/pipelines/7', from: 'CI', at: '2026-09-01T00:00:00Z',
      text: 'Pipeline failed', bot: true }])
    expect(api).not.toHaveBeenCalled()
  })

  it('reads an inline note as its discussion thread, whose replies answer the root, or as its root alone', async () => {
    const inline = trigger({ project: 'g/p', kind: 'mr', iid: 34, isMr: true, noteId: 301, discussionId: 'd1' })
    expect(gitlabThreadContext.messageId(inline)).toBe('301')
    pages.mockResolvedValue([{ id: 'd1', notes: [note({ id: 1, body: 'root' }), note({ id: 2, body: 'reply' })] }])
    const full = await gitlabThreadContext.read(commands, inline, 'thread', undefined, undefined)
    expect(full.messages).toEqual([{ id: '1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'root' },
      { id: '2', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'reply', reply_to: '1' }])
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'projects/g%2Fp/merge_requests/34/discussions?per_page=100')
    const first = await gitlabThreadContext.read(commands, inline, 'root', undefined, undefined)
    expect(first.messages).toEqual([{ id: '1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'root' }])
  })

  it('reads the conversation page by page with the description first on page 1', async () => {
    const conversation = trigger({ project: 'g/p', kind: 'issue', iid: 12, isMr: false, noteId: 500 })
    expect(gitlabThreadContext.messageId(conversation)).toBe('500')
    api.mockResolvedValueOnce(issue()).mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => note({ id: index + 10 })))
    const part = await gitlabThreadContext.read(commands, conversation, 'thread', undefined, undefined)
    expect(part.messages[0]).toEqual({ id: 'https://gitlab.example.com/group/sub/proj/-/issues/12', from: 'alice',
      at: '2026-09-01T00:00:00Z', text: 'Fix the margin\n\nDetails' })
    expect(part.messages).toHaveLength(101)
    expect(part.next).toBe('2')
    expect(api).toHaveBeenNthCalledWith(1, expect.anything(), 'projects/g%2Fp/issues/12')
    expect(api).toHaveBeenNthCalledWith(2, expect.anything(), 'projects/g%2Fp/issues/12/notes?per_page=100&page=1')
    // later pages list notes only
    api.mockReset().mockResolvedValueOnce([note({ id: 700 })])
    const later = await gitlabThreadContext.read(commands, conversation, 'thread', '2', undefined)
    expect(later.messages).toEqual([{ id: '700', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'looks wrong' }])
    expect(later.next).toBeUndefined()
    // a merge request conversation reads the merge request description and its notes
    const mrConversation = trigger({ project: 'g/p', kind: 'mr', iid: 34, isMr: true })
    api.mockReset().mockResolvedValueOnce(mr()).mockResolvedValueOnce([note({ id: 800 })])
    const mrs = await gitlabThreadContext.read(commands, mrConversation, 'thread', undefined, undefined)
    expect(mrs.messages[0]!.id).toBe('https://gitlab.example.com/group/sub/proj/-/merge_requests/34')
    expect(api).toHaveBeenNthCalledWith(1, expect.anything(), 'projects/g%2Fp/merge_requests/34')
    expect(api).toHaveBeenNthCalledWith(2, expect.anything(), 'projects/g%2Fp/merge_requests/34/notes?per_page=100&page=1')
  })
})
