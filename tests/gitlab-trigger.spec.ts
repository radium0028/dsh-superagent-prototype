import { describe, expect, it } from 'vitest'
import { SOURCE, UserSchema, branchCiTrigger, ciTrigger, gitlabAddress, gitlabChannel, gitlabPage, isSystemNote, issueTrigger,
  mentions, mrTrigger, notePlace, noteTrigger, parseThread, pipelineClass, threadKey, type GitlabIssue, type GitlabMr, type GitlabNote } from '../src/sources/gitlab-trigger.ts'

const note = (fields: Partial<GitlabNote> = {}): GitlabNote =>
  ({ id: 301, body: 'looks wrong', author: { id: 42, username: 'alice' }, created_at: '2026-09-01T00:00:00Z', ...fields })
const issue = (fields: Partial<GitlabIssue> = {}): GitlabIssue =>
  ({ id: 9001, iid: 12, title: 'Title', description: 'Body', state: 'opened', author: { id: 42, username: 'alice' }, created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z', web_url: 'https://gitlab.example.com/group/sub/proj/-/issues/12', ...fields })
const mr = (fields: Partial<GitlabMr> = {}): GitlabMr =>
  ({ ...issue({ iid: 34, web_url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34' }),
    source_branch: 'fix', target_branch: 'main', ...fields })

describe('gitlab trigger', () => {
  it('builds and parses thread keys for issues and merge requests across multi-segment paths', () => {
    expect(SOURCE).toBe('gitlab')
    expect(threadKey('group/sub/proj', 12, 'issue')).toBe('gitlab:group/sub/proj#12')
    expect(threadKey('group/sub/proj', 34, 'mr')).toBe('gitlab:group/sub/proj!34')
    expect(parseThread('gitlab:group/sub/proj#12')).toEqual({ project: 'group/sub/proj', iid: 12, kind: 'issue' })
    expect(parseThread('gitlab:a/b!7')).toEqual({ project: 'a/b', iid: 7, kind: 'mr' })
    // a project path may itself end in digits; the last separator wins
    expect(parseThread('gitlab:proj2#3')).toEqual({ project: 'proj2', iid: 3, kind: 'issue' })
    for (const [project, iid, kind] of [['group/sub/proj', 12, 'issue'], ['g/p', 34, 'mr'], ['proj2', 3, 'issue']] as const)
      expect(parseThread(threadKey(project, iid, kind))).toEqual({ project, iid, kind })
    for (const unknown of ['github:9', 'gitlab:group/proj', 'gitlab:group/proj#12x', 'gitlab:group/proj!', 'gitlab:group:ci:main'])
      expect(parseThread(unknown)).toBeUndefined()
  })

  it('parses issue and merge request web URLs on the configured host, and nothing else', () => {
    expect(gitlabAddress('https://gitlab.example.com/group/sub/proj/-/issues/12', 'gitlab.example.com'))
      .toEqual({ project: 'group/sub/proj', iid: 12, kind: 'issue' })
    expect(gitlabAddress('https://gitlab.example.com/group/sub/proj/-/merge_requests/34#note_56', 'gitlab.example.com'))
      .toEqual({ project: 'group/sub/proj', iid: 34, kind: 'mr', note: 56 })
    expect(gitlabAddress('https://gitlab.example.com/g/p/-/merge_requests/34/discussions#note_9', 'gitlab.example.com'))
      .toEqual({ project: 'g/p', iid: 34, kind: 'mr', note: 9 })
    expect(gitlabAddress('https://GITLAB.Example.COM/g/p/-/issues/12#note_7', 'gitlab.example.com'))
      .toEqual({ project: 'g/p', iid: 12, kind: 'issue', note: 7 })
    for (const url of ['https://gitlab.com/g/p/-/issues/12', 'https://other.example.com/g/p/-/issues/12',
      'https://gitlab.example.com/g/p/-/merge_requests/34/discussions/5', 'https://gitlab.example.com/g/p/-/wikis/home', ''])
      expect(gitlabAddress(url, 'gitlab.example.com')).toBeUndefined()
  })

  it('addresses a channel at the project path with iid, kind and optional discussion', () => {
    expect(gitlabChannel('group/sub/proj', 12, 'issue')).toEqual({ source: 'gitlab', thread: 'gitlab:group/sub/proj#12',
      address: { project: 'group/sub/proj', iid: '12', kind: 'issue' } })
    expect(gitlabChannel('g/p', 34, 'mr', 'abc123')).toEqual({ source: 'gitlab', thread: 'gitlab:g/p!34',
      address: { project: 'g/p', iid: '34', kind: 'mr', discussion: 'abc123' } })
    expect(gitlabPage('gitlab.example.com', 'group/sub/proj', 12, 'issue')).toBe('https://gitlab.example.com/group/sub/proj/-/issues/12')
    expect(gitlabPage('gitlab.example.com', 'g/p', 34, 'mr')).toBe('https://gitlab.example.com/g/p/-/merge_requests/34')
  })

  it('normalizes conversation notes into triggers: people are human, mentions address, and ids stay stable across re-polls', () => {
    const trigger = noteTrigger(note({ updated_at: '2026-09-02T00:00:00Z' }), { project: 'group/sub/proj', iid: 12, isMr: false }, 'conversation', 'agent-bot')
    expect(trigger).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/sub/proj#12' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-09-02T00:00:00Z', text: 'looks wrong',
      channel: { thread: 'gitlab:group/sub/proj#12', address: { project: 'group/sub/proj', iid: '12', kind: 'issue' } },
      meta: { project: 'group/sub/proj', kind: 'issue', iid: 12, isMr: false, noteId: 301 } })
    expect(trigger.meta).not.toHaveProperty('noteType')
    expect(trigger.meta).not.toHaveProperty('discussionId')
    const again = noteTrigger(note({ updated_at: '2026-09-02T00:00:00Z' }), { project: 'group/sub/proj', iid: 12, isMr: false }, 'conversation', 'agent-bot')
    expect(again.id).toBe(trigger.id)
    expect(noteTrigger(note(), { project: 'group/sub/proj', iid: 12, isMr: false }, 'conversation', 'agent-bot').id).not.toBe(trigger.id)
    expect(noteTrigger(note({ id: 302 }), { project: 'group/sub/proj', iid: 12, isMr: false }, 'conversation', 'agent-bot').id).not.toBe(trigger.id)
    // the agent's own notes are automated; a mention of the agent addresses it, an email address does not
    expect(noteTrigger(note({ body: 'done' }), { project: 'g/p', iid: 12, isMr: false }, 'conversation', 'alice').human).toBe(false)
    expect(noteTrigger(note({ body: '@Agent-Bot please fix' }), { project: 'g/p', iid: 12, isMr: false }, 'conversation', 'agent-bot'))
      .toMatchObject({ human: true, addressed: 'mention' })
    expect(noteTrigger(note({ body: 'mail@agent-bot.example' }), { project: 'g/p', iid: 12, isMr: false }, 'conversation', 'agent-bot'))
      .not.toHaveProperty('addressed')
  })

  it('starts an inline diff note with its file and line, and answers in its discussion', () => {
    const inline = note({ id: 302, type: 'DiffNote', discussion_id: 'd1', updated_at: '2026-09-02T00:00:00Z',
      position: { old_path: 'src/render.ts', new_path: 'src/render.ts', old_line: 40, new_line: 43 } })
    const trigger = noteTrigger(inline, { project: 'g/p', iid: 34, isMr: true }, 'inline', 'agent-bot')
    expect(trigger.text).toBe('src/render.ts:43\n\nlooks wrong')
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'g/p!34' }])
    expect(trigger.channel).toEqual({ source: 'gitlab', thread: 'gitlab:g/p!34',
      address: { project: 'g/p', iid: '34', kind: 'mr', discussion: 'd1' } })
    expect(trigger.meta).toMatchObject({ project: 'g/p', kind: 'mr', iid: 34, isMr: true, noteId: 302, noteType: 'DiffNote',
      path: 'src/render.ts', line: 43, discussionId: 'd1' })
    // a discussion pinned by the poll layer wins over the note's own discussion id; a conversation note stays top-level
    const pinned = noteTrigger(inline, { project: 'g/p', iid: 34, isMr: true, discussionId: 'root-d' }, 'conversation', 'agent-bot')
    expect(pinned.channel!.address).toEqual({ project: 'g/p', iid: '34', kind: 'mr', discussion: 'root-d' })
    expect(pinned.meta.discussionId).toBe('root-d')
    const top = noteTrigger(note({ discussion_id: 'd9' }), { project: 'g/p', iid: 34, isMr: true }, 'conversation', 'agent-bot')
    expect(top.channel!.address).toEqual({ project: 'g/p', iid: '34', kind: 'mr' })
  })

  it('builds issue and merge request triggers with title, description and stable ids', () => {
    const trigger = issueTrigger(issue(), 'agent-bot', 'group/sub/proj')
    expect(trigger).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/sub/proj#12' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Title\n\nBody',
      channel: { thread: 'gitlab:group/sub/proj#12', address: { project: 'group/sub/proj', iid: '12', kind: 'issue' } },
      url: 'https://gitlab.example.com/group/sub/proj/-/issues/12',
      meta: { project: 'group/sub/proj', kind: 'issue', iid: 12, isMr: false } })
    expect(issueTrigger(issue(), 'agent-bot', 'group/sub/proj').id).toBe(trigger.id)
    expect(issueTrigger(issue({ description: '@agent-bot 修一下标题' }), 'agent-bot', 'group/sub/proj')).toMatchObject({ addressed: 'mention' })
    const opened = mrTrigger(mr(), 'agent-bot', 'group/sub/proj')
    expect(opened.id).not.toBe(trigger.id)
    expect(opened).toMatchObject({ text: 'Title\n\nBody', threads: [{ source: 'gitlab', id: 'group/sub/proj!34' }],
      channel: { thread: 'gitlab:group/sub/proj!34', address: { project: 'group/sub/proj', iid: '34', kind: 'mr' } },
      url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34',
      meta: { project: 'group/sub/proj', kind: 'mr', iid: 34, isMr: true, author: 'alice' } })
    expect(mrTrigger(mr({ draft: true }), 'agent-bot', 'g/p').meta).toMatchObject({ draft: true, author: 'alice' })
    expect(mrTrigger(mr(), 'agent-bot', 'g/p').meta).not.toHaveProperty('draft')
  })

  it('builds branch CI triggers without a channel and MR CI triggers with one', () => {
    const branch = branchCiTrigger('group/sub/proj', 'main', 'abc123', 3, 'CI failed on main', 'https://gitlab.example.com/group/sub/proj/-/pipelines/9')
    expect(branch).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/sub/proj:ci:main' }],
      actor: { source: 'gitlab', id: '' }, human: false, text: 'CI failed on main',
      url: 'https://gitlab.example.com/group/sub/proj/-/pipelines/9',
      meta: { ci: true, project: 'group/sub/proj', ref: 'main', sha: 'abc123', revision: 3 } })
    expect(branch).not.toHaveProperty('channel')
    const mrCi = ciTrigger({ project: 'group/sub/proj', iid: 34, web_url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34', author: 'alice' }, 2, 'CI failed 1/3')
    expect(mrCi).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'group/sub/proj!34' }],
      actor: { source: 'gitlab', id: '' }, human: false, text: 'CI failed 1/3',
      channel: { thread: 'gitlab:group/sub/proj!34', address: { project: 'group/sub/proj', iid: '34', kind: 'mr' } },
      url: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/34',
      meta: { project: 'group/sub/proj', kind: 'mr', iid: 34, isMr: true, author: 'alice', ci: true, revision: 2 } })
  })

  it('classifies every documented pipeline status into failed, running, or done', () => {
    expect(pipelineClass('failed')).toBe('failed')
    for (const status of ['created', 'waiting_for_resource', 'preparing', 'waiting_for_callback', 'pending', 'running', 'canceling'])
      expect(pipelineClass(status)).toBe('running')
    for (const status of ['success', 'skipped', 'scheduled', 'manual', 'canceled'])
      expect(pipelineClass(status)).toBe('done')
  })

  it('parses authors, notes, and system flags defensively', () => {
    expect(UserSchema.parse({ id: 7, username: 'alice', name: 'Alice' })).toMatchObject({ id: 7, username: 'alice' })
    expect(UserSchema.parse({ id: 99, username: null })).toMatchObject({ id: 0, username: 'ghost' })
    expect(UserSchema.parse({ id: 99, username: '' })).toMatchObject({ id: 0, username: 'ghost' })
    expect(UserSchema.parse({ id: 99 })).toMatchObject({ id: 0, username: 'ghost' })
    expect(isSystemNote(note({ system: true }))).toBe(true)
    expect(isSystemNote(note({ system: false }))).toBe(false)
    expect(isSystemNote(note())).toBe(false)
    expect(notePlace(note({ type: 'DiffNote', position: { old_path: 'a.ts', new_path: 'a.ts', old_line: 1, new_line: 2 } }))).toBe('a.ts:2')
    expect(notePlace(note())).toBe('')
    expect(mentions('hey @Agent-Bot look', 'agent-bot')).toBe(true)
    expect(mentions('@agent-bot at the start', 'agent-bot')).toBe(true)
    expect(mentions('hey @agent-botx look', 'agent-bot')).toBe(false)
    expect(mentions('hey agent-bot', 'agent-bot')).toBe(false)
    expect(mentions('mail me at a@agent-bot.io', 'agent-bot')).toBe(false)
  })
})
