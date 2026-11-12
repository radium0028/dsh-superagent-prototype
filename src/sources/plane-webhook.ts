/**
 * Plane webhook HTTP receiver: raw-body HMAC verification, event routing, and status codes.
 *
 * Plane signs every delivery with `HMAC-SHA256(secret, raw body)` in `X-Plane-Signature`; the comparison uses the
 * original bytes with `crypto.timingSafeEqual` — never a re-serialized JSON. Delivery semantics matter: any `2xx`
 * acknowledges (including events the receiving scope filters out, so Plane does not burn its five retries on a
 * webhook it should keep), `4xx` is a deliberate refusal Plane never retries, and only `5xx` (the Trigger failed to
 * store) asks Plane to retry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

export interface WebhookResult { status: number; reason: string }
/**
 * One delivery: verify, then hand the parsed payload to `route` with the delivery headers.
 * `route` answers `stored` (accepted, whether it became a Trigger or was filtered/ignored) or throws (retry with 5xx).
 */
export async function planeWebhook(req: IncomingMessage, res: ServerResponse, secret: string,
  route: (payload: unknown, eventId: string) => Promise<WebhookResult>): Promise<void> {
  const body = await readRaw(req)
  if ('status' in body) { reply(res, body.status, 'Request body too large'); return }
  if (!planeSignatureValid(secret, body.raw, req.headers['x-plane-signature'] as string | undefined)) {
    reply(res, 403, 'Invalid signature'); return
  }
  let payload: unknown
  try { payload = JSON.parse(body.raw.toString('utf8')) }
  catch { reply(res, 400, 'The request body is not JSON'); return }
  const eventId = z.looseObject({ event_id: z.string().min(1) }).safeParse(payload)
  if (!eventId.success) { reply(res, 400, 'Missing event_id'); return }
  try {
    const result = await route(payload, eventId.data.event_id)
    reply(res, result.status, result.reason)
  } catch (error) {
    // Only a storage failure asks Plane to retry; anything else already answered 2xx inside `route`.
    reply(res, 500, `Failed to store the trigger: ${error instanceof Error ? error.message : String(error)}`)
  }
}