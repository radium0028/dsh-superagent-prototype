/**
 * Plane webhook HTTP receiver: raw-body HMAC verification, event routing, and status codes.
 *
 * Plane signs every delivery with `HMAC-SHA256(secret, raw body)` in `X-Plane-Signature`; the comparison uses the
 * original bytes with `crypto.timingSafeEqual` — never a re-serialized JSON. Delivery semantics matter: any `2xx`
 * acknowledges (including events the receiving scope filters out, so Plane does not burn its five retries on a
 * webhook it should keep), `4xx` is a deliberate refusal Plane never retries, and only `5xx` (the Trigger failed to
 * store) asks Plane to retry.
 *
 * The receiver is the plugin's own listener, not a route on the DSH web server: frp maps one TCP port to it, so the
 * superagent management panel is never exposed on the public side. `watchPlaneWebhook` owns the listener lifecycle —
 * it re-reads the bind target every few seconds (a host/port change rebinds without a restart), retries after a
 * failed bind, and closes on abort.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'

/** Plane delivers at most a few hundred KiB for a comment; refuse anything larger before buffering it. */
export const MAX_BODY_BYTES = 256 * 1024
const SignatureSchema = z.string().regex(/^[0-9a-f]+$/i)

/** Verify a delivery against its raw body; missing headers or a re-serialized body fail. */
export function planeSignatureValid(secret: string, raw: Buffer, header: string | undefined): boolean {
  const given = SignatureSchema.safeParse(header ?? '')
  if (!given.success) return false
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  // Both sides are fixed-length hex digests, so a length leak is not a concern here; timingSafeEqual still guards.
  const a = Buffer.from(given.data, 'hex'), b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Read the whole request body up to the cap; over-cap or non-buffering bodies fail with the right status. */
async function readRaw(req: IncomingMessage): Promise<{ status: number } | { raw: Buffer }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) return { status: 413 }
    chunks.push(bytes)
  }
  return { raw: Buffer.concat(chunks) }
}
const reply = (res: ServerResponse, status: number, text: string): void => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text) }

/** One line per delivery attempt, so a rejected or lost request is visible in the startup log. */
const trace = (what: string, detail: Record<string, unknown>): void => {
  console.log(`[plane-webhook] ${what} ${JSON.stringify(detail)}`)
}

export interface WebhookResult { status: number; reason: string }
/**
 * One delivery: verify, then hand the parsed payload to `route` with the delivery headers.
 * `route` answers `stored` (accepted, whether it became a Trigger or was filtered/ignored) or throws (retry with 5xx).
 */
export async function planeWebhook(req: IncomingMessage, res: ServerResponse, secret: string,
  route: (payload: unknown, eventId: string) => Promise<WebhookResult>): Promise<void> {
  const body = await readRaw(req)
  if ('status' in body) { trace('refused', { reason: 'too_large', limit: MAX_BODY_BYTES }); reply(res, body.status, 'Request body too large'); return }
  const signature = req.headers['x-plane-signature'] as string | undefined
  if (!planeSignatureValid(secret, body.raw, signature)) {
    trace('refused', { reason: 'signature', signature: signature ? `${signature.slice(0, 12)}…` : 'missing',
      bytes: body.raw.length, secretConfigured: !!secret })
    reply(res, 403, 'Invalid signature'); return
  }
  let payload: unknown
  try { payload = JSON.parse(body.raw.toString('utf8')) }
  catch { trace('refused', { reason: 'not_json', bytes: body.raw.length }); reply(res, 400, 'The request body is not JSON'); return }
  // Pre-v2 payloads carry no `event_id`; the entity id in `data.id` identifies the event there.
  const envelope = z.looseObject({ event_id: z.string().min(1).optional(), data: z.looseObject({ id: z.string().min(1) }).optional() }).safeParse(payload)
  const eventId = envelope.success ? envelope.data.event_id ?? envelope.data.data?.id : undefined
  if (!eventId) {
    trace('refused', { reason: 'no_event_id', body: body.raw.toString('utf8').slice(0, 1200) })
    reply(res, 400, 'Missing event_id'); return
  }
  try {
    const result = await route(payload, eventId)
    trace('delivered', { eventId, status: result.status, reason: result.reason })
    reply(res, result.status, result.reason)
  } catch (error) {
    // Only a storage failure asks Plane to retry; anything else already answered 2xx inside `route`.
    trace('failed', { eventId, error: error instanceof Error ? error.message : String(error) })
    reply(res, 500, `Failed to store the trigger: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A bound webhook listener; `address` is the `host:port` it actually answers on (the OS port when 0 was requested). */
export interface PlaneListener { address: string; close(): Promise<void> }

/** Bind the standalone receiver; `port` 0 asks the OS for a free port. Resolves once the socket listens, rejects on bind failure. */
export function startPlaneWebhook(host: string, port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<PlaneListener> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handler(req, res).catch(() => { if (!res.headersSent) reply(res, 500, 'The receiver failed the request') })
    })
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const bound = server.address()
      const address = typeof bound === 'object' && bound ? `${bound.address}:${bound.port}` : `${host}:${port}`
      resolve({ address, close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() }) })
    })
  })
}

export interface WebhookWatchDeps {
  /** The bind target, or undefined while the Source is off (nothing listens then). */
  target(): { host: string; port: number } | undefined
  start(host: string, port: number): Promise<PlaneListener>
  report(state: 'ready' | 'error' | 'paused', detail: string): void
  signal: AbortSignal
  /** Milliseconds between target checks; tests shorten it. @default 5000 */
  everyMs?: number
}

/** The listener's lifecycle: bind the target, rebind when it changes, retry after a failed bind, and close on abort. */
export async function watchPlaneWebhook(deps: WebhookWatchDeps): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise(done => {
    const timer = setTimeout(done, ms)
    deps.signal.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
  })
  let listener: PlaneListener | undefined
  try {
    while (!deps.signal.aborted) {
      const target = deps.target()
      if (!target) {
        if (listener) { const old = listener; listener = undefined; await old.close().catch(() => {}) }
        deps.report('paused', 'Off')
      } else if (!listener || listener.address !== `${target.host}:${target.port}`) {
        if (listener) { const old = listener; listener = undefined; await old.close().catch(() => {}) }
        const wanted = `${target.host}:${target.port}`
        try {
          listener = await deps.start(target.host, target.port)
          deps.report('ready', `Listening on ${listener.address}`)
        } catch (error) {
          deps.report('error', `Cannot listen on ${wanted}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await wait(deps.everyMs ?? 5_000)
    }
  } finally {
    if (listener) await listener.close().catch(() => {})
  }
}