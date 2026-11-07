/**
 * `signing.ts` — Standard Webhooks 규격 서명. **수신측이 기성 라이브러리로 검증할 수 있어야 한다.**
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import {
  WebhookSecretUnavailableError,
  deriveWebhookSecret,
  signWebhook,
  verifyWebhook,
} from '../../../src/webhooks/signing';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const NOW = new Date('2026-09-23T00:00:00.000Z');
const BODY = '{"id":"x","type":"message.sent"}';

function secretFor(endpointId = randomUUID(), version = 1): string {
  return deriveWebhookSecret(RING, { endpointId, kid: 'w1', version });
}

function headersOf(signed: ReturnType<typeof signWebhook>) {
  return { id: signed['webhook-id'], timestamp: signed['webhook-timestamp'], signature: signed['webhook-signature'] };
}

describe('웹훅 서명', () => {
  it('규격대로다: HMAC-SHA256(base64decode(secret), "<id>.<ts>.<body>") 의 base64, 접두사 v1,', () => {
    // 구현을 거치지 않고 규격 문장만으로 다시 계산한다. 수신측 라이브러리가 하는 일이다.
    const secret = secretFor();
    const eventId = randomUUID();
    const signed = signWebhook([secret], eventId, BODY, NOW);
    const ts = Math.floor(NOW.getTime() / 1000);
    const expected = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
      .update(`${eventId}.${ts}.${BODY}`)
      .digest('base64');
    expect(signed).toEqual({
      'webhook-id': eventId,
      'webhook-timestamp': String(ts),
      'webhook-signature': `v1,${expected}`,
    });
  });

  it('서명한 것은 검증된다', () => {
    const secret = secretFor();
    const signed = signWebhook([secret], randomUUID(), BODY, NOW);
    expect(verifyWebhook(secret, headersOf(signed), BODY, NOW)).toEqual({ kind: 'valid' });
  });

  it('본문 변조·id 변조·다른 시크릿은 no_matching_signature', () => {
    const secret = secretFor();
    const signed = signWebhook([secret], randomUUID(), BODY, NOW);
    const headers = headersOf(signed);
    expect(verifyWebhook(secret, headers, `${BODY} `, NOW)).toMatchObject({ reason: 'no_matching_signature' });
    // id 가 서명 범위 안이다 — 헤더 id 를 바꿔 수신측 중복 제거를 우회하는 재생이 막힌다.
    expect(verifyWebhook(secret, { ...headers, id: randomUUID() }, BODY, NOW)).toMatchObject({
      reason: 'no_matching_signature',
    });
    expect(verifyWebhook(secretFor(), headers, BODY, NOW)).toMatchObject({ reason: 'no_matching_signature' });
  });

  it('재생 방지: 타임스탬프가 5분을 넘으면 과거든 미래든 거부된다', () => {
    const secret = secretFor();
    const signed = signWebhook([secret], randomUUID(), BODY, NOW);
    const headers = headersOf(signed);
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    expect(verifyWebhook(secret, headers, BODY, at(300)).kind).toBe('valid');
    expect(verifyWebhook(secret, headers, BODY, at(301))).toMatchObject({ reason: 'timestamp_out_of_tolerance' });
    expect(verifyWebhook(secret, headers, BODY, at(-301))).toMatchObject({ reason: 'timestamp_out_of_tolerance' });
    // 타임스탬프를 현재로 고쳐 쓰면 서명이 깨진다(서명 범위 안).
    const refreshed = { ...headers, timestamp: String(Number(headers.timestamp) + 600) };
    expect(verifyWebhook(secret, refreshed, BODY, at(600))).toMatchObject({ reason: 'no_matching_signature' });
  });

  it('시크릿 회전 중에는 서명이 둘 실리고 어느 쪽 시크릿으로도 검증된다', () => {
    const endpointId = randomUUID();
    const [oldSecret, newSecret] = [secretFor(endpointId, 1), secretFor(endpointId, 2)];
    const signed = signWebhook([newSecret, oldSecret], randomUUID(), BODY, NOW);
    expect(signed['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifyWebhook(oldSecret, headersOf(signed), BODY, NOW).kind).toBe('valid');
    expect(verifyWebhook(newSecret, headersOf(signed), BODY, NOW).kind).toBe('valid');
  });

  it('형식이 틀린 타임스탬프는 malformed', () => {
    const secret = secretFor();
    const signed = signWebhook([secret], randomUUID(), BODY, NOW);
    expect(verifyWebhook(secret, { ...headersOf(signed), timestamp: '1e9' }, BODY, NOW)).toMatchObject({
      reason: 'malformed',
    });
  });
});

describe('웹훅 시크릿 파생 — DB 에 비밀 0바이트', () => {
  it('결정적이다: 같은 (endpoint, kid, version) 은 같은 시크릿', () => {
    const endpointId = randomUUID();
    expect(secretFor(endpointId)).toBe(secretFor(endpointId));
    expect(secretFor(endpointId)).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  });

  it('엔드포인트·버전이 다르면 다른 시크릿이다 — 한 엔드포인트의 시크릿으로 다른 엔드포인트를 위조할 수 없다', () => {
    const endpointId = randomUUID();
    expect(secretFor(endpointId, 1)).not.toBe(secretFor(endpointId, 2));
    expect(secretFor(endpointId)).not.toBe(secretFor(randomUUID()));
  });

  it('묶음에 없는 kid 나 잘못된 버전이면 던진다 — 다른 키로 대신 서명하지 않는다', () => {
    expect(() => deriveWebhookSecret(RING, { endpointId: randomUUID(), kid: 'nope', version: 1 })).toThrow(
      WebhookSecretUnavailableError,
    );
    expect(() => deriveWebhookSecret(RING, { endpointId: randomUUID(), kid: 'w1', version: 0 })).toThrow(
      WebhookSecretUnavailableError,
    );
  });
});
