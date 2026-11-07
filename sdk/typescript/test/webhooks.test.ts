/**
 * Webhook signature vectors — generated with the server's own signing code (`src/webhooks/signing.ts`) and shared with
 * the Python SDK through `sdk/fixtures/webhook-vectors.json`. Regenerate: `ATMARK_UPDATE_SDK_FIXTURES=1 pnpm test:sdk`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { signWebhook, verifyWebhook } from '../../../src/webhooks/signing';
import { memorySeenIds, verifyWebhookSignature } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/webhook-vectors.json', import.meta.url));
const UPDATE = process.env['ATMARK_UPDATE_SDK_FIXTURES'] === '1';

interface Vector {
  readonly name: string;
  readonly secret: string;
  readonly headers: { readonly 'webhook-id': string; readonly 'webhook-timestamp': string; readonly 'webhook-signature': string };
  readonly body: string;
  readonly now_unix: number;
  readonly expected: 'valid' | 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature';
}

const secretOf = (seed: number): string => `whsec_${Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 256)).toString('base64')}`;
const SECRET = secretOf(1);
const OLD_SECRET = secretOf(2);
const OTHER_SECRET = secretOf(3);
const SIGNED_AT = new Date('2026-10-08T09:00:00.000Z');
const T = Math.floor(SIGNED_AT.getTime() / 1000);
const EVENT_ID = '0b9f3c7e-5d2a-4c1b-9e8f-7a6b5c4d3e2f';
const BODY = JSON.stringify({
  id: EVENT_ID,
  type: 'message.received',
  api_version: '2026-09-23',
  created_at: '2026-10-08T09:00:00.000Z',
  agent_id: '7c21aa00bb11cc22dd33ee44ff55f5a1',
  data: { message_id: '11111111-2222-4333-8444-555555555555', thread_id: '66666666-7777-4888-9999-aaaaaaaaaaaa', received_at: '2026-10-08T08:59:59.000Z' },
});
const UNICODE_BODY = JSON.stringify({ id: EVENT_ID, type: 'message.sent', data: { note: '안녕하세요 — émoji 🙂  ' } });

function signed(secrets: readonly string[], body: string, at: Date = SIGNED_AT, id: string = EVENT_ID): Vector['headers'] {
  return signWebhook(secrets, id, body, at);
}

function buildVectors(): Vector[] {
  const base = signed([SECRET], BODY);
  const draft: Omit<Vector, 'expected'>[] = [
    { name: 'valid', secret: SECRET, headers: base, body: BODY, now_unix: T },
    { name: 'valid at +300s edge', secret: SECRET, headers: base, body: BODY, now_unix: T + 300 },
    { name: 'valid at -300s edge (clock behind)', secret: SECRET, headers: base, body: BODY, now_unix: T - 300 },
    { name: 'too old (+301s)', secret: SECRET, headers: base, body: BODY, now_unix: T + 301 },
    { name: 'too far in the future (-301s)', secret: SECRET, headers: base, body: BODY, now_unix: T - 301 },
    { name: 'rotation: new + old signatures, receiver has new', secret: SECRET, headers: signed([SECRET, OLD_SECRET], BODY), body: BODY, now_unix: T },
    { name: 'rotation: new + old signatures, receiver still has old', secret: OLD_SECRET, headers: signed([SECRET, OLD_SECRET], BODY), body: BODY, now_unix: T },
    { name: 'wrong secret', secret: OTHER_SECRET, headers: base, body: BODY, now_unix: T },
    { name: 'tampered body', secret: SECRET, headers: base, body: BODY.replace('message.received', 'message.sent'), now_unix: T },
    { name: 'tampered id', secret: SECRET, headers: { ...base, 'webhook-id': 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, body: BODY, now_unix: T },
    { name: 'tampered timestamp', secret: SECRET, headers: { ...base, 'webhook-timestamp': String(T + 1) }, body: BODY, now_unix: T },
    { name: 'malformed timestamp', secret: SECRET, headers: { ...base, 'webhook-timestamp': '17e8' }, body: BODY, now_unix: T },
    { name: 'negative timestamp', secret: SECRET, headers: { ...base, 'webhook-timestamp': `-${T}` }, body: BODY, now_unix: T },
    { name: 'unknown version is skipped, v1 matches', secret: SECRET, headers: { ...base, 'webhook-signature': `v2,AAAA ${base['webhook-signature']}` }, body: BODY, now_unix: T },
    { name: 'only unknown versions', secret: SECRET, headers: { ...base, 'webhook-signature': base['webhook-signature'].replace('v1,', 'v2,') }, body: BODY, now_unix: T },
    { name: 'truncated signature', secret: SECRET, headers: { ...base, 'webhook-signature': base['webhook-signature'].slice(0, 20) }, body: BODY, now_unix: T },
    { name: 'empty signature header', secret: SECRET, headers: { ...base, 'webhook-signature': '' }, body: BODY, now_unix: T },
    { name: 'unicode body', secret: SECRET, headers: signed([SECRET], UNICODE_BODY), body: UNICODE_BODY, now_unix: T },
    { name: 'empty body', secret: SECRET, headers: signed([SECRET], ''), body: '', now_unix: T },
  ];
  return draft.map((vector) => {
    const result = verifyWebhook(
      vector.secret,
      { id: vector.headers['webhook-id'], timestamp: vector.headers['webhook-timestamp'], signature: vector.headers['webhook-signature'] },
      vector.body,
      new Date(vector.now_unix * 1000),
    );
    return { ...vector, expected: result.kind === 'valid' ? 'valid' : result.reason };
  });
}

describe('verifyWebhookSignature', () => {
  const vectors = buildVectors();

  it('the shared fixture equals vectors generated by src/webhooks/signing.ts (regenerate: ATMARK_UPDATE_SDK_FIXTURES=1 pnpm test:sdk)', () => {
    const current = `${JSON.stringify({ generated_by: 'sdk/typescript/test/webhooks.test.ts from src/webhooks/signing.ts', vectors }, null, 2)}\n`;
    if (UPDATE) writeFileSync(FIXTURE, current);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(current);
  });

  it('covers valid and every invalid reason', () => {
    expect(new Set(vectors.map((v) => v.expected))).toEqual(new Set(['valid', 'malformed', 'timestamp_out_of_tolerance', 'no_matching_signature']));
  });

  for (const vector of vectors) {
    it(`matches the server reference: ${vector.name} → ${vector.expected}`, async () => {
      const result = await verifyWebhookSignature(vector.body, vector.headers, vector.secret, { now: new Date(vector.now_unix * 1000) });
      expect(result.valid ? 'valid' : result.reason).toBe(vector.expected);
    });
  }

  it('accepts Uint8Array bodies, Headers objects and mixed-case header names', async () => {
    const vector = vectors.find((v) => v.name === 'unicode body')!;
    const headers = new Headers(vector.headers);
    const bytes = new TextEncoder().encode(vector.body);
    expect(await verifyWebhookSignature(bytes, headers, vector.secret, { now: new Date(vector.now_unix * 1000) })).toMatchObject({ valid: true });
    const mixed = { 'Webhook-Id': vector.headers['webhook-id'], 'WEBHOOK-TIMESTAMP': vector.headers['webhook-timestamp'], 'Webhook-Signature': vector.headers['webhook-signature'] };
    expect(await verifyWebhookSignature(vector.body, mixed, vector.secret, { now: new Date(vector.now_unix * 1000) })).toMatchObject({ valid: true });
  });

  it('seenIds: a valid delivery whose webhook-id was already processed is a duplicate (memorySeenIds)', async () => {
    const vector = vectors.find((v) => v.name === 'valid')!;
    const now = new Date(vector.now_unix * 1000);
    const seenIds = memorySeenIds();
    expect(await verifyWebhookSignature(vector.body, vector.headers, vector.secret, { now, seenIds })).toEqual({ valid: true, id: vector.headers['webhook-id'] });
    expect(await verifyWebhookSignature(vector.body, vector.headers, vector.secret, { now, seenIds })).toEqual({ valid: false, reason: 'duplicate' });
    // Not consulted (and not recorded) when the signature is wrong.
    const calls: string[] = [];
    const tampered = await verifyWebhookSignature(`${vector.body} `, vector.headers, vector.secret, { now, seenIds: async (id) => (calls.push(id), false) });
    expect([tampered, calls]).toEqual([{ valid: false, reason: 'no_matching_signature' }, []]);
  });

  it('missing headers are malformed; a secret without whsec_ throws', async () => {
    expect(await verifyWebhookSignature('{}', {}, SECRET)).toEqual({ valid: false, reason: 'malformed' });
    await expect(verifyWebhookSignature('{}', {}, 'not-a-secret')).rejects.toThrow(/whsec_/);
  });
});
