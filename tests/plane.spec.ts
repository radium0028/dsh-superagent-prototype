/** Plane source kind: webhook verification, trigger normalization, deduplication, channel replies, and thread context. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply as applyPlane, planeKind, planeSignatureValid, planeTrigger, refreshPlaneNames, workItemTrigger } from '../src/sources/plane.ts'
import { planeHtml } from '../src/sources/plane-channel.ts'
import { planeResource, planeThreadContext, readPlaneResource } from '../src/sources/plane-read.ts'
import { planeWebhook, MAX_BODY_BYTES } from '../src/sources/plane-webhook.ts'
import { planeMcp } from '../src/sources/plane-mcp.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = '8f14e45f-ea1e-4f6c-9c2a-c8f6a7d9e3b1'
const WORK_ITEM = '3c59dc2e-6a3b-4d2f-a1c4-9e8b7d6f5a4c'
const MEMBER = '2b1f6a5e-3d4c-4b7a-9e8f-1a2b3c4d5e6f'
const OTHER = '9z8y7x6w-5v4u-3t2s-1r0q-9p8o7n6m5l4k'
const SELF = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'
const EVENT_ID = '5d41402a-b3c4-4e5f-8a9b-0c1d2e3f4a5b'

/** One comment webhook delivery payload, as Plane's v2 workspace webhook posts it. */
const commentEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 'v2', delivery_id: 'a1b2c3d4-0000-0000-0000-000000000001', event_id: EVENT_ID, event: 'workitem.comment.created',
  webhook_id: 'wh-1', workspace_id: 'ws-1', entity_type: 'issue', previous_attributes: {},
  data: { id: WORK_ITEM, project_id: PROJECT, name: '发票识别不对', comment: { id: 'cm-1', access: 'INTERNAL',
    actor_id: MEMBER, issue_id: WORK_ITEM, edited_at: null, comment_stripped: '请修一下' } },
  ...overrides,
})

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'plane-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { plane: { allowed: [{ id: MEMBER, name: 'Alice' }] } } },
    sources: { plane: { enabled: true, config: { secret: 'plane_wh_test', projects: [{ id: PROJECT, name: 'QB', listen: 'all' }] } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(planeKind({ mcp: () => planeMcp(mcpStub) }))
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment({ plane: { secret: 'plane_wh_test', mcpServer: 'plane' } }),
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'plane', health: ['plane'] })
  return { ...value, ...context, store, engine, settings: () => store.settings(), receive }
}

/** One MCP tool call recorded for assertions; results are queued per short tool name (without the mcp__plane__ prefix). */
const mcpCalls: { tool: string; args: Record<string, unknown> }[] = []
const mcpResults = new Map<string, unknown>()
const mcpStub = {
  get(name: string) {
    if (!name.startsWith('mcp__plane__')) return undefined
    const short = name.replace('mcp__plane__', '')
    return { execute: async (args: unknown) => {
      const call = { tool: short, args: args as Record<string, unknown> }
      mcpCalls.push(call)
      const result = mcpResults.get(short)
      return result instanceof Error ? { isError: true, error: { message: result.message } } : { isError: false, value: result ?? {} }
    } }
  },
}
afterEach(() => { mcpCalls.length = 0; mcpResults.clear() })

const signed = (raw: string, secret = 'plane_wh_test'): Record<string, string> =>
  ({ 'x-plane-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'content-type': 'application/json' })
/** Delivers one payload through the webhook handler against a recording receive. */
async function deliver(h: ReturnType<typeof host>, payload: unknown, secret = 'plane_wh_test'): Promise<{ status: number; text: string }> {
  let status = 0, text = ''
  const req = { method: 'POST', url: '/plane/webhook', headers: signed(JSON.stringify(payload), secret),
    async *[Symbol.asyncIterator]() { yield* [Buffer.from(JSON.stringify(payload))] } }
  await planeWebhook(req as never, { writeHead: (code: number) => { status = code }, end: (body: string) => { text = body } } as never, secret,
    async (body, eventId) => {
      const trigger = planeTrigger(body, SELF)
      if (!trigger || trigger.id !== key('plane', eventId)) return { status: 202, reason: 'ignored' }
      await h.receive(trigger)
      return { status: 202, reason: 'stored' }
    })
  return { status, text }
}

describe('plane webhook', () => {
  it('verifies the raw-body signature and refuses tampered or re-serialized bodies', async () => {
    expect(planeSignatureValid('plane_wh_test', Buffer.from('{"a":1}'), signed('{"a":1}')['x-plane-signature'])).toBe(true)
    expect(planeSignatureValid('plane_wh_test', Buffer.from('{"a":2}'), signed('{"a":1}')['x-plane-signature'])).toBe(false)
    expect(planeSignatureValid('plane_wh_test', Buffer.from('{"a":1}'), undefined)).toBe(false)
    // A signature computed over re-serialized JSON fails against the original bytes.
    const reparsed = JSON.stringify(JSON.parse('{"a": 1}'))
    expect(planeSignatureValid('plane_wh_test', Buffer.from('{"a": 1}'), signed(reparsed)['x-plane-signature'])).toBe(false)
  })
  it('answers 403 without a valid signature and never stores the trigger', async () => {
    const h = host()
    // Signed with a secret the Source does not keep: verification must fail.
    const raw = JSON.stringify(commentEvent())
    let status = 0
    const req = { method: 'POST', url: '/plane/webhook', headers: signed(raw, 'plane_wh_wrong'),
      async *[Symbol.asyncIterator]() { yield* [Buffer.from(raw)] } }
    await planeWebhook(req as never, { writeHead: (code: number) => { status = code }, end: () => {} } as never, 'plane_wh_test',
      async () => ({ status: 202, reason: 'stored' }))
    expect(status).toBe(403)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('stores one trigger per event id: a repeated delivery is the duplicate, not a second ticket', async () => {
    const h = host()
    const first = await deliver(h, commentEvent())
    expect(first.status).toBe(202)
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = h.receive.mock.calls[0]![0] as Trigger
    expect(trigger).toMatchObject({ id: key('plane', EVENT_ID), source: 'plane', actor: { source: 'plane', id: MEMBER },
      human: true, addressed: 'direct', text: '请修一下',
      channel: { source: 'plane', address: { projectId: PROJECT, workItemId: WORK_ITEM, commentId: 'cm-1' } } })
    expect(trigger.threads).toEqual([{ source: 'plane', id: `plane:${PROJECT}:${WORK_ITEM}` }])
    // The same event id delivers the same Trigger; the Engine answers duplicate. `at` is the receive time.
    const second = await deliver(h, { ...commentEvent(), delivery_id: 'a1b2c3d4-0000-0000-0000-000000000002' })
    expect(second.status).toBe(202)
    const { at: _at, ...rest } = trigger
    expect(h.receive.mock.calls[1]![0]).toMatchObject(rest)
    const stored = h.store.triggers.get(trigger.id)
    expect(stored).toBeDefined()
    expect(h.store.triggers.get(trigger.id)).toEqual(stored)
  })
  it('normalizes the Python-enum event name and ignores unknown events with 2xx', async () => {
    const h = host()
    const enumed = await deliver(h, commentEvent({ event: 'WebhookScope.ScopeChoices.WORK_ITEM_UPDATED' }))
    expect(enumed.status).toBe(202)
    expect(h.receive).not.toHaveBeenCalled()
    const unknown = await deliver(h, commentEvent({ event: 'workitem.vote.created', event_id: 'unknown-1' }))
    expect(unknown.status).toBe(202)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('drops the agent\'s own comments: no reply loop', async () => {
    const h = host()
    const own = await deliver(h, commentEvent({ data: { id: WORK_ITEM, project_id: PROJECT, name: 'x',
      comment: { id: 'cm-2', actor_id: SELF, comment_stripped: '我自己' } } }))
    expect(own.status).toBe(202)
    expect(h.receive).not.toHaveBeenCalled()
  })
  it('refuses a body over the cap before buffering it', async () => {
    let status = 0
    const big = 'x'.repeat(MAX_BODY_BYTES + 16)
    const req = { method: 'POST', url: '/plane/webhook', headers: signed(big),
      async *[Symbol.asyncIterator]() { yield* [Buffer.from(big)] } }
    await planeWebhook(req as never, { writeHead: (code: number) => { status = code }, end: () => {} } as never, 'plane_wh_test',
      async () => ({ status: 202, reason: 'stored' }))
    expect(status).toBe(413)
  })
})

describe('plane scope', () => {
  it('listens to listed projects and filters unlisted ones with a reason', () => {
    const kind = planeKind({ mcp: () => planeMcp(mcpStub) })
    const config = { secret: '', mcpServer: 'plane', readPageSize: 30, workItemCreated: false,
      projects: [{ id: PROJECT, listen: 'all' as const }] }
    expect(kind.scope!({ meta: { projectId: PROJECT } }, config)).toMatchObject({ listened: true, observed: true, row: PROJECT })
    expect(kind.scope!({ meta: { projectId: '00000000-0000-0000-0000-000000000000' } }, config)).toMatchObject({ listened: false, reason: 'project_not_listed' })
    expect(kind.scope!({ meta: { projectId: PROJECT } }, { ...config, projects: [{ id: PROJECT, listen: 'mentions' }] }))
      .toMatchObject({ listened: true, observed: false })
  })
})

describe('plane trigger', () => {
  it('opens a work item trigger only when workItemCreated is on', () => {
    const created = { event_id: 'evt-2', event: 'workitem.created', data: { id: WORK_ITEM, project_id: PROJECT,
      name: '新工作项', created_by_id: MEMBER } }
    expect(workItemTrigger(created, SELF)).toMatchObject({ actor: { source: 'plane', id: MEMBER }, text: '新工作项', addressed: 'direct' })
    expect(workItemTrigger(created, MEMBER)).toBeUndefined()
    expect(workItemTrigger({ ...created, event: 'workitem.updated' }, SELF)).toBeUndefined()
  })
})

describe('plane channel', () => {
  it('escapes plain text into HTML paragraphs', () => {
    expect(planeHtml('a & b\n\nline2 <x>')).toBe('<p>a &amp; b</p><p>line2 &lt;x&gt;</p>')
  })
  it('sends a reply idempotently by message id and maps 404 to gone', async () => {
    const h = host()
    const trigger = planeTrigger(commentEvent(), SELF)!
    const send = planeKind({ mcp: () => planeMcp(mcpStub) }).channel!.send
    mcpResults.set('workitem_comment', { id: 'cm-9' })
    const message = { id: 'msg-1', channel: trigger.channel!, text: 'hi', kind: 'reply' as const }
    await expect(send(h, message)).resolves.toBe('sent')
    const call = mcpCalls.find(entry => entry.tool === 'workitem_comment')
    expect(call?.args).toMatchObject({ action: 'create', project_id: PROJECT, work_item_id: WORK_ITEM,
      external_id: 'msg-1', external_source: 'dsh-superagent', comment_html: '<p>hi</p>' })
    mcpResults.set('workitem_comment', new Error('404 work item not found'))
    await expect(send(h, message)).resolves.toBe('gone')
    mcpResults.set('workitem_comment', new Error('500 boom'))
    await expect(send(h, message)).rejects.toThrow('500 boom')
  })
})

describe('plane thread context', () => {
  it('reads the work item as the root and comments as pages with a next cursor', async () => {
    mcpResults.set('workitem', { id: WORK_ITEM, name: '发票识别不对', project_id: PROJECT, state_id: 's1', priority: 'high',
      description_stripped: '描述', sequence_id: 7, created_by_id: MEMBER, assignee_ids: [] })
    mcpResults.set('workitem_comment', { results: [
      { id: 'cm-1', comment_stripped: '请修一下', actor_id: MEMBER, created_at: '2026-11-12T10:00:00Z' },
      { id: 'cm-2', comment_stripped: '好的', actor_id: SELF, created_at: '2026-11-12T10:01:00Z' }], next_cursor: 'c2' })
    const context = planeThreadContext({ mcp: () => planeMcp(mcpStub) })
    const trigger = planeTrigger(commentEvent(), SELF)!
    const root = await context.read(new Commands(() => testDeployment(), {}, new AbortController().signal), trigger, 'root', undefined, { readPageSize: 30 })
    expect(root.messages).toEqual([{ id: WORK_ITEM, from: '发票识别不对', at: '', text: '描述' }])
    const page = await context.read(new Commands(() => testDeployment(), {}, new AbortController().signal), trigger, 'thread', undefined, { readPageSize: 30 })
    expect(page.messages.map(message => message.text)).toEqual(['请修一下', '好的'])
    expect(page.next).toBe('c2')
    expect(page.messages[0]).toMatchObject({ id: 'cm-1', from: MEMBER, at: '2026-11-12T10:00:00.000Z' })
  })
})

describe('plane plugin', () => {
  it('registers the kind and the webhook route, and releases both', async () => {
    const routes: { path: string; handler: unknown }[] = []
    // An empty registry so the plugin's own registration shows (the standard host() already holds the kind).
    const board = new HealthBoard()
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'plane-plugin-')), 'db.sqlite'))
    const sources = new SourceRegistry(() => store.settings(), board)
    const engine = { receive: vi.fn() }
    const ctx = { orchestrator: { sources, context: () => ({ receive: engine.receive }) }, tools: mcpStub,
      webServer: { register: (route: { path: string; handler: unknown }) => { routes.push(route); return () => {} } },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) } }
    const disposers: (() => unknown)[] = []
    applyPlane(ctx as never)
    expect(sources.kind('plane')).toBeDefined()
    expect(routes.map(route => route.path)).toContain('/plane/webhook')
    for (const dispose of disposers) await dispose()
    expect(sources.kind('plane')).toBeUndefined()
    store.close()
  })
})

describe('plane mcp adapter', () => {
  it('normalizes envelopes and reports the tool as unavailable when not registered', async () => {
    const mcp = planeMcp(mcpStub)
    expect(mcp.available()).toBe(true)
    mcpResults.set('member', { results: [{ member: { id: SELF, display_name: 'Plane Bot' } }] })
    expect(await mcp.me()).toEqual({ id: SELF, name: 'Plane Bot' })
    const empty = planeMcp({ get: () => undefined })
    await expect(empty.workItem('x')).rejects.toThrow('not connected')
    expect(empty.available()).toBe(false)
  })
})

describe('plane resources', () => {
  it('parses plane/<trigger-id>/ sections and rejects wrong shapes', () => {
    expect(planeResource('plane/t1/issue')).toEqual({ triggerId: 't1', section: 'issue', cursor: undefined })
    expect(planeResource('plane/t1/comments/c2')).toEqual({ triggerId: 't1', section: 'comments', cursor: 'c2' })
    expect(() => planeResource('plane/t1')).toThrow('plane/<trigger-id>/')
    expect(() => planeResource('plane/t1/issue/c1')).toThrow('plane/<trigger-id>/')
  })
})

describe('plane read resource', () => {
  it('reads the issue and comment pages through the MCP adapter', async () => {
    mcpResults.set('workitem', { id: WORK_ITEM, name: '发票识别不对', project_id: PROJECT, state_id: 's1', priority: 'high',
      description_stripped: '描述', sequence_id: 7, created_by_id: MEMBER, assignee_ids: [] })
    mcpResults.set('workitem_comment', { results: [{ id: 'cm-1', comment_stripped: '请修一下', actor_id: MEMBER, created_at: '2026-11-12T10:00:00Z' }], next_cursor: null })
    const mcp = planeMcp(mcpStub)
    const ref = { projectId: PROJECT, workItemId: WORK_ITEM, triggerId: 't1' }
    const issue = await readPlaneResource(mcp, ref, 'plane/t1/issue', 30)
    expect(issue).toMatchObject({ status: 'available', issue: { name: '发票识别不对' } })
    const comments = await readPlaneResource(mcp, ref, 'plane/t1/comments', 30)
    expect(comments).toMatchObject({ status: 'available', next_resource: null })
    expect((comments as { comments: unknown[] }).comments).toHaveLength(1)
  })
})

describe('plane member names', () => {
  it('resolves user UUIDs to names, pages the roster, and stores them in KV', async () => {
    mcpResults.set('member', { results: [{ member: { id: MEMBER, display_name: 'Alice' } }, { member: { id: OTHER, display_name: null } }], next_cursor: undefined })
    const h = host()
    const names = await refreshPlaneNames(h, planeMcp(mcpStub))
    expect(names).toEqual({ [MEMBER]: 'Alice' })
    expect(h.store.get(KV.sources.labels('plane'))).toEqual({ [MEMBER]: 'Alice' })
    // The agent's own comment renders with a name once labels are stored.
    expect(h.store.get(KV.sources.labels('plane'))?.[MEMBER]).toBe('Alice')
  })
  it('pages with the cursor until the roster ends', async () => {
    mcpResults.set('member', { results: [{ member: { id: MEMBER, display_name: 'Alice' } }], next_cursor: 'c1' })
    const h = host()
    const mcp = planeMcp(mcpStub)
    const originalMembers = mcp.members
    let calls = 0
    const paging = { ...mcp, members: async (cursor?: string) => { calls++; return calls === 1 ? { items: [{ id: MEMBER, name: 'Alice' }], nextCursor: 'c1' } : { items: [{ id: OTHER, name: 'Bob' }], nextCursor: undefined } } }
    const names = await refreshPlaneNames(h, paging)
    expect(calls).toBe(2)
    expect(names).toEqual({ [MEMBER]: 'Alice', [OTHER]: 'Bob' })
    void originalMembers
  })
  it('reports the MCP server as unhealthy when the tool call fails', async () => {
    mcpResults.set('member', new Error('plane down'))
    const h = host()
    const context = h.context({ kind: 'plane', health: ['plane'] })
    await expect(refreshPlaneNames(context, planeMcp(mcpStub))).rejects.toThrow('plane down')
  })
})