/**
 * Webhook signature verification (Standard Webhooks). Matches the server's reference `verifyWebhook` in
 * `src/webhooks/signing.ts` exactly — the shared vectors in `sdk/fixtures/webhook-vectors.json` are generated from it.
 *
 *   webhook-id:        <event id>
 *   webhook-timestamp: <unix seconds>
 *   webhook-signature: v1,<base64(HMAC-SHA256(base64decode(secret without "whsec_"), "<id>.<timestamp>.<body>"))> [v1,<...> ...]
 *
 * Several signatures appear for 24 hours after a secret rotation; any one matching is enough. Timestamps more than
 * 5 minutes away (either direction) are refused. Uses WebCrypto (`crypto.subtle`), so it runs in Node ≥ 20, Deno,
 * Bun, workers and browsers. Pass the raw body exactly as received, before JSON parsing.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerification =
  | { readonly valid: true; readonly id: string }
  | { readonly valid: false; readonly reason: 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature' | 'duplicate' };

export type WebhookHeaders =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookOptions {
  readonly toleranceSeconds?: number;
  /** Defaults to the current time. */
  readonly now?: Date;
  /**
   * De-duplication. Retries resend the same `webhook-id` (with a fresh signature), so receivers should process each id
   * once. Called only after the signature checks out; return true if this id was already processed (and record it
   * otherwise) — the result is then `{ valid: false, reason: 'duplicate' }`. Use a shared store across instances;
   * `memorySeenIds()` is a single-process helper.
   */
  readonly seenIds?: (id: string) => boolean | Promise<boolean>;
}

/** Single-process `seenIds` helper: remembers the last `max` ids (keep at least ~32 hours of traffic — retries span ~31 h 40 min). */
export function memorySeenIds(max: number = 10_000): (id: string) => boolean {
  const order: string[] = [];
  const seen = new Set<string>();
  return (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    order.push(id);
    if (order.length > max) seen.delete(order.shift() as string);
    return false;
  };
}

const SECRET_PREFIX = 'whsec_';

function headerValue(headers: WebhookHeaders, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): string | null }).get(name);
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(' ');
  }
  return null;
}

/** Lenient base64 decode like Node's `Buffer.from(s, 'base64')`: ignores characters outside the alphabet and missing padding. */
function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  const cleaned = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const usable = cleaned.length % 4 === 1 ? cleaned.slice(0, -1) : cleaned;
  const binary = atob(usable + '='.repeat((4 - (usable.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookVerification> {
  if (!secret.startsWith(SECRET_PREFIX)) throw new TypeError('webhook secret must start with whsec_');
  const id = headerValue(headers, 'webhook-id');
  const timestampText = headerValue(headers, 'webhook-timestamp');
  const signatures = headerValue(headers, 'webhook-signature');
  if (id === null || timestampText === null || signatures === null) return { valid: false, reason: 'malformed' };
  if (!/^\d{1,12}$/.test(timestampText)) return { valid: false, reason: 'malformed' };
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const key = await globalThis.crypto.subtle.importKey('raw', base64Bytes(secret.slice(SECRET_PREFIX.length)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const body = typeof rawBody === 'string' ? utf8(rawBody) : rawBody;
  const signed = concat([utf8(`${id}.${timestamp}.`), body]);
  for (const entry of signatures.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
    const provided = base64Bytes(entry.slice(comma + 1).split(',')[0] ?? '');
    if (provided.length !== 32) continue;
    // `subtle.verify` compares in constant time.
    if (await globalThis.crypto.subtle.verify('HMAC', key, provided, signed)) {
      if (options.seenIds !== undefined && (await options.seenIds(id))) return { valid: false, reason: 'duplicate' };
      return { valid: true, id };
    }
  }
  return { valid: false, reason: 'no_matching_signature' };
}
