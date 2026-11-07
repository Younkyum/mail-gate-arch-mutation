/**
 * `authorization.ts` — 웹훅 인증 헤더의 입력 규칙(헤더 주입 · 길이 · 비 ASCII) · 힌트 · 봉인/열기(AAD 결속 · 변조 · 키 없음).
 * 디스패처가 헤더를 싣는지 · 열지 못하면 보내지 않는지도 여기서 본다(가짜 포트 — 네트워크 없음).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import {
  MAX_WEBHOOK_AUTHORIZATION_LENGTH,
  openWebhookAuthorization,
  parseWebhookAuthorization,
  sealWebhookAuthorization,
  webhookAuthorizationHint,
  webhookAuthorizationRejectionDetail,
  WebhookAuthorizationUnavailableError,
} from '../../../src/webhooks/authorization';
import {
  dispatchDueWebhooks,
  type ClaimedDelivery,
  type WebhookDispatchDependencies,
  type WebhookHttpRequest,
} from '../../../src/webhooks/dispatcher';
import { deriveWebhookSecret, verifyWebhook } from '../../../src/webhooks/signing';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const AGENT = 'a'.repeat(32);
const URL_A = 'https://hooks.example.com/atmark';
const EP = '6d1f3c2a-9b8e-4c7d-a5f4-3e2d1c0b9a87';
const TOKEN = 'Bearer tok_0123456789abcdefWXYZ';

describe('parseWebhookAuthorization — 입력 규칙', () => {
  it('생략 · null 은 없음', () => {
    expect(parseWebhookAuthorization(undefined)).toEqual({ kind: 'absent' });
    expect(parseWebhookAuthorization(null)).toEqual({ kind: 'absent' });
  });

  it('앞뒤 공백은 자르고 값은 그대로', () => {
    expect(parseWebhookAuthorization(`  ${TOKEN}\n`)).toEqual({ kind: 'value', value: TOKEN });
    expect(parseWebhookAuthorization('Basic dXNlcjpwYXNz')).toEqual({ kind: 'value', value: 'Basic dXNlcjpwYXNz' });
    expect(parseWebhookAuthorization('raw-api-key')).toEqual({ kind: 'value', value: 'raw-api-key' });
  });

  it.each([
    ['문자열 아님', 42, 'not_string'],
    ['배열', ['Bearer x'], 'not_string'],
    ['빈 값', '', 'empty'],
    ['공백뿐', '   \t ', 'empty'],
    ['CRLF 주입', 'Bearer x\r\nX-Evil: 1', 'invalid_characters'],
    ['LF 주입', 'Bearer x\nHost: evil', 'invalid_characters'],
    ['CR', 'Bearer x\ry', 'invalid_characters'],
    ['NUL', 'Bearer x\u0000y', 'invalid_characters'],
    ['탭', 'Bearer\tx', 'invalid_characters'],
    ['DEL', 'Bearer x\u007f', 'invalid_characters'],
    ['한글', 'Bearer 토큰', 'invalid_characters'],
    ['U+2028', 'Bearer x y', 'invalid_characters'],
    ['NEL', 'Bearer x\u0085y', 'invalid_characters'],
    ['헤더 이름째', 'Authorization: Bearer x', 'includes_header_name'],
    ['헤더 이름 대소문자', 'authorization :Bearer x', 'includes_header_name'],
  ])('%s → 거부', (_name, raw, reason) => {
    expect(parseWebhookAuthorization(raw)).toEqual({ kind: 'invalid', reason });
  });

  it('길이 — 2048 은 되고 2049 는 거부 · 아주 긴 입력은 정규식 전에 거부', () => {
    const max = `Bearer ${'a'.repeat(MAX_WEBHOOK_AUTHORIZATION_LENGTH - 7)}`;
    expect(parseWebhookAuthorization(max)).toEqual({ kind: 'value', value: max });
    expect(parseWebhookAuthorization(`${max}a`)).toEqual({ kind: 'invalid', reason: 'too_long' });
    expect(parseWebhookAuthorization('a'.repeat(1_000_000))).toEqual({ kind: 'invalid', reason: 'too_long' });
  });

  it('거부 사유 문장에 값이 없다', () => {
    for (const reason of ['not_string', 'empty', 'too_long', 'invalid_characters', 'includes_header_name'] as const) {
      expect(webhookAuthorizationRejectionDetail(reason)).not.toContain('tok_');
    }
  });
});

describe('webhookAuthorizationHint', () => {
  it.each([
    [TOKEN, 'Bearer …WXYZ'],
    ['Bearer short', 'Bearer …'],
    // 보안 리뷰 L1 — Basic · Digest 는 끝 글자를 보이지 않는다(base64 의 끝은 비밀번호의 끝).
    ['Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==', 'Basic …'],
    ['basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==', 'basic …'],
    ['Digest username="u", response="0123456789abcdef"', 'Digest …'],
    ['0123456789abcdef9f2c', '…9f2c'],
    ['short', '…'],
    ['token 0123456789abcdefWXYZ', 'token …WXYZ'],
    ['ApiKey 0123456789abcdefWXYZ', 'ApiKey …WXYZ'],
    ['AWS4-HMAC-SHA256 Credential=AKIA/x, SignedHeaders=host, Signature=0123456789abcdef', 'AWS4-HMAC-SHA256 …'],
  ])('%s → %s', (value, hint) => {
    expect(webhookAuthorizationHint(value)).toBe(hint);
  });

  // 재검증 L1 — 모르는 첫 낱말은 방식으로 보이지 않고(비밀번호일 수 있다) · `:`(user:pass) · 공백이 든 자격은 끝 글자도 숨긴다.
  it.each(['hunter2secret anything-here-long', 'MyS3cretPassw0rd! 1234567890abcdefgh', 'user:password12345678', 'Custom s3cr3t-0123456789abcdef'])(
    '%s → 비밀 글자를 하나도 보이지 않는다',
    (value) => {
      const hint = webhookAuthorizationHint(value);
      expect(hint).toBe('…');
      for (const word of value.split(/[ :]/)) if (word.length > 0) expect(hint).not.toContain(word.slice(0, 3));
    },
  );
});

describe('봉인 · 열기', () => {
  const binding = { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A };

  it('왕복 · 봉인값에 평문 조각이 없다 · 같은 값도 매번 다른 봉인(iv)', () => {
    const a = sealWebhookAuthorization(RING, binding, TOKEN);
    const b = sealWebhookAuthorization(RING, binding, TOKEN);
    expect(a.kid).toBe('w1');
    expect(a.hint).toBe('Bearer …WXYZ');
    expect(a.sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.sealed).not.toContain('tok_');
    expect(Buffer.from(a.sealed.split('.')[2] ?? '', 'base64url').toString('latin1')).not.toContain('tok_');
    expect(openWebhookAuthorization(RING, binding, a)).toBe(TOKEN);
  });

  it('다른 URL · 다른 에이전트 · 다른 kid 로는 열리지 않는다(행 옮기기 · URL 바꾸기)', () => {
    const sealed = sealWebhookAuthorization(RING, binding, TOKEN);
    expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: 'https://evil.example.com/atmark' }, sealed)).toThrow(WebhookAuthorizationUnavailableError);
    expect(() => openWebhookAuthorization(RING, { agentId: 'b'.repeat(32), endpointId: EP, generation: 1, url: URL_A }, sealed)).toThrow(WebhookAuthorizationUnavailableError);
    // 보안 리뷰 L2 — 같은 에이전트 · 같은 URL 이라도 다른(새로 만들었거나 다시 등록한) 엔드포인트로는 열리지 않는다.
    expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId: randomUUID(), generation: 1, url: URL_A }, sealed)).toThrow(WebhookAuthorizationUnavailableError);
    // 재검증 L2 — 다른 세대(지우거나 교체한 뒤)로는 열리지 않는다 · 세대가 정수 1 이상이 아니면 봉인하지 않는다.
    for (const generation of [2, 3, 100]) {
      expect(() => openWebhookAuthorization(RING, { ...binding, generation }, sealed)).toThrow(WebhookAuthorizationUnavailableError);
    }
    for (const generation of [0, -1, 1.5, Number.NaN]) {
      expect(() => sealWebhookAuthorization(RING, { ...binding, generation }, TOKEN)).toThrow(WebhookAuthorizationUnavailableError);
    }
    const other = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
    expect(() => openWebhookAuthorization(other, binding, sealed)).toThrow(WebhookAuthorizationUnavailableError);
    expect(() => openWebhookAuthorization(RING, binding, { ...sealed, kid: 'w9' })).toThrow(/묶음에 없다/);
  });

  it('모양 틀림 · 변조는 던지고 오류에 값이 없다', () => {
    const sealed = sealWebhookAuthorization(RING, binding, TOKEN);
    for (const bad of ['', 'v2.x.y', sealed.sealed.slice(0, -2), `${sealed.sealed}A`]) {
      let message = '';
      try {
        openWebhookAuthorization(RING, binding, { kid: 'w1', sealed: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('tok_');
    }
  });

  it('봉인은 규칙을 다시 본다(라우트가 빠뜨려도)', () => {
    expect(() => sealWebhookAuthorization(RING, binding, 'Bearer x\r\nHost: evil')).toThrow(WebhookAuthorizationUnavailableError);
  });
});

describe('디스패처 — 인증 헤더', () => {
  function delivery(endpoint: Partial<ClaimedDelivery['endpoint']>): ClaimedDelivery {
    return {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      body: '{"id":"e","type":"message.sent"}',
      attempt: 1,
      endpoint: { id: EP, url: URL_A, secretKid: 'w1', secretVersion: 1, disabled: false, ...endpoint },
    };
  }

  function deps(claimed: readonly ClaimedDelivery[]) {
    const requests: WebhookHttpRequest[] = [];
    const retried: string[] = [];
    const value: WebhookDispatchDependencies = {
      outbox: {
        claimDue: async () => claimed,
        markDelivered: async () => true,
        scheduleRetry: async (_id, _attempt, _at, error) => {
          retried.push(error);
          return true;
        },
        markDead: async () => true,
      },
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      keyring: RING,
      transport: {
        post: vi.fn(async (request: WebhookHttpRequest) => {
          requests.push(request);
          return { kind: 'response' as const, status: 200 };
        }),
      },
    };
    return { value, requests, retried };
  }

  it('봉인값이 있으면 authorization 헤더를 싣고 서명은 그대로다', async () => {
    const sealed = sealWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A }, TOKEN);
    const claimed = delivery({ agentId: AGENT, authorization: { kid: sealed.kid, sealed: sealed.sealed, generation: 1 } });
    const h = deps([claimed]);
    const now = new Date('2026-10-14T00:00:00.000Z');
    const [report] = await dispatchDueWebhooks(h.value, now);
    expect(report?.outcome).toBe('delivered');
    const headers = h.requests[0]?.headers ?? {};
    expect(headers['authorization']).toBe(TOKEN);
    const secret = deriveWebhookSecret(RING, { endpointId: claimed.endpoint.id, kid: 'w1', version: 1 });
    expect(
      verifyWebhook(secret, { id: headers['webhook-id'] ?? '', timestamp: headers['webhook-timestamp'] ?? '', signature: headers['webhook-signature'] ?? '' }, claimed.body, now),
    ).toEqual({ kind: 'valid' });
    // 보고서에 값이 없다.
    expect(JSON.stringify(report)).not.toContain('tok_');
  });

  it('없으면 헤더가 없다', async () => {
    const h = deps([delivery({ agentId: AGENT, authorization: null })]);
    await dispatchDueWebhooks(h.value, new Date());
    expect(Object.keys(h.requests[0]?.headers ?? {})).not.toContain('authorization');
  });

  it('열지 못하면(URL 바뀜 · 에이전트 모름 · 변조) 보내지 않고 authorization_unavailable 로 재시도', async () => {
    const sealed = sealWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A }, TOKEN);
    const h = deps([
      delivery({ agentId: AGENT, url: 'https://evil.example.com/atmark', authorization: { kid: 'w1', sealed: sealed.sealed, generation: 1 } }),
      delivery({ authorization: { kid: 'w1', sealed: sealed.sealed, generation: 1 } }),
      delivery({ id: randomUUID(), agentId: AGENT, authorization: { kid: 'w1', sealed: sealed.sealed, generation: 1 } }),
      delivery({ agentId: AGENT, authorization: { kid: 'w1', sealed: `${sealed.sealed.slice(0, -4)}AAAA`, generation: 1 } }),
      // 재검증 L2 — 저장된 세대가 봉인 때와 다르면(옛 봉인값을 다음 세대 행에 다시 넣음) 열리지 않는다.
      delivery({ agentId: AGENT, authorization: { kid: 'w1', sealed: sealed.sealed, generation: 2 } }),
    ]);
    const reports = await dispatchDueWebhooks(h.value, new Date());
    expect(h.requests).toHaveLength(0);
    expect(reports.map((r) => [r.outcome, r.errorKind])).toEqual([
      ['retry_scheduled', 'authorization_unavailable'],
      ['retry_scheduled', 'authorization_unavailable'],
      ['retry_scheduled', 'authorization_unavailable'],
      ['retry_scheduled', 'authorization_unavailable'],
      ['retry_scheduled', 'authorization_unavailable'],
    ]);
  });
});
