/**
 * 적대적 검증(웹훅 인증 헤더, 202610141400) — 헤더 주입 · 봉인 변조 · 결속 우회 · 값 누출. 안전 동작을 단언한다(깨지면 `VULN:`).
 *
 *   ① 헤더 주입: 줄바꿈 · NUL · 제어 문자 · 유니코드 줄 구분자 · 보이지 않는 글자를 앞 · 가운데 · 뒤에 넣은 값 → 받아들인 값은 **언제나** 인쇄 가능한 ASCII 뿐이고
 *      Node 의 헤더 검사(`validateHeaderValue`)를 지난다. 가운데에 든 것은 전부 거부.
 *   ② 봉인 변조: 봉인값의 글자 하나하나를 바꾼 것 · 잘라 낸 것 · 다른 봉인값의 iv/본문을 섞은 것 → 열리지 않는다.
 *   ③ 결속 우회: 같은 값을 다른 URL 변형(대소문자 · 끝 / · 쿼리 · 포트 · 하위 도메인) · 다른 에이전트 · 다른 엔드포인트 id · 다른 kid 로 열기 → 열리지 않는다.
 *   ④ 누출: 열기 실패 오류 · 디스패처 보고서 · 로그 어디에도 값이 없다.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { validateHeaderValue } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { openWebhookAuthorization, parseWebhookAuthorization, sealWebhookAuthorization, webhookAuthorizationHint } from '../../../src/webhooks/authorization';
import { dispatchDueWebhooks, type ClaimedDelivery, type WebhookHttpRequest } from '../../../src/webhooks/dispatcher';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')},w0:${randomBytes(32).toString('base64url')}`, 'TEST');
const AGENT = 'c'.repeat(32);
const URL_A = 'https://hooks.example.com/v1/atmark';
const EP = '6d1f3c2a-9b8e-4c7d-a5f4-3e2d1c0b9a87';
const TOKEN = 'Bearer adv_0123456789abcdefWXYZ';

afterEach(() => resetLogSink());

let attempts = 0;

describe('① 헤더 주입', () => {
  const NASTY = [
    '\r',
    '\n',
    '\r\n',
    '\n\r',
    '\u0000',
    '\u0001',
    '\u0007',
    '\u0008',
    '\t',
    '\u000b',
    '\u000c',
    '\u001b',
    '\u007f',
    '\u0085',
    ' ',
    ' ',
    ' ',
    '​',
    '‎',
    '‮',
    '﻿',
    '：',
    '😀',
    '\r\nX-Injected: 1',
    '\r\n\r\n{"evil":true}',
    '%0d%0aX-Injected: 1',
  ];
  const PLACES: ReadonlyArray<(nasty: string) => string> = [
    (n) => `${n}${TOKEN}`,
    (n) => `Bearer${n}adv_0123456789`,
    (n) => `${TOKEN}${n}`,
    (n) => `${TOKEN}${n}tail`,
  ];

  it('받아들인 값은 언제나 인쇄 가능한 ASCII 이고 Node 헤더 검사를 지난다 · 가운데의 위험 글자는 전부 거부', () => {
    for (const nasty of NASTY) {
      for (const [index, place] of PLACES.entries()) {
        attempts += 1;
        const raw = place(nasty);
        const parsed = parseWebhookAuthorization(raw);
        if (parsed.kind === 'value') {
          expect(parsed.value, `VULN: ${JSON.stringify(raw)}`).toMatch(/^[\x20-\x7E]+$/);
          expect(() => validateHeaderValue('authorization', parsed.value)).not.toThrow();
          // 가운데(1 · 3번 자리)에 든 비 ASCII · 제어 문자는 자르기로 사라질 수 없다 — 받아들였다면 그것은 ASCII 였다(`%0d%0a` 같은 글자 그대로).
          if (index === 1 || index === 3) expect(/[^\x20-\x7E]/.test(nasty), `VULN: ${JSON.stringify(raw)}`).toBe(false);
        } else {
          expect(parsed.kind).toBe('invalid');
        }
      }
    }
  });

  it('헤더 이름을 끼워 넣은 값 · 길이 넘침 변형은 거부', () => {
    for (const raw of ['Authorization: x', 'AUTHORIZATION:x', 'authorization\t: x', ' authorization : Bearer x', `Bearer ${'z'.repeat(2042)}`, 'a'.repeat(5000)]) {
      attempts += 1;
      expect(parseWebhookAuthorization(raw).kind, `VULN: ${raw.slice(0, 40)}`).toBe('invalid');
    }
  });

  it('힌트(재검증 L1)는 받아들인 어떤 주입 변형에서도 모르는 첫 낱말 · user:pass · 공백 든 자격의 글자를 보이지 않는다', () => {
    for (const value of ['hunter2secret anything-here-long', 'MyS3cretPassw0rd! 1234567890abcdefgh', 'user:password12345678', 'p@ss w0rd-0123456789abcd', 'admin:hunter2hunter2hunter2']) {
      attempts += 1;
      expect(webhookAuthorizationHint(value), `VULN: ${value}`).toBe('…');
    }
  });

  it('JSON 이 아닌 모양(객체 · 배열 · 수 · 불)은 거부', () => {
    for (const raw of [{}, [], ['Bearer x'], 0, 1, true, false, { toString: () => 'Bearer x' }]) {
      attempts += 1;
      expect(parseWebhookAuthorization(raw).kind).toBe('invalid');
    }
  });
});

describe('② 봉인 변조', () => {
  const binding = { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A };

  it('봉인값 글자를 하나씩 바꾸면 열리지 않는다 · 잘라도 · 다른 봉인과 섞어도', () => {
    const sealed = sealWebhookAuthorization(RING, binding, TOKEN);
    const other = sealWebhookAuthorization(RING, binding, 'Bearer other_0123456789abcdef');
    const [, iv, body] = sealed.sealed.split('.');
    const [, otherIv, otherBody] = other.sealed.split('.');
    const variants: string[] = [];
    for (let i = 3; i < sealed.sealed.length; i += 2) {
      const ch = sealed.sealed[i];
      if (ch === '.' || ch === undefined) continue;
      variants.push(`${sealed.sealed.slice(0, i)}${ch === 'A' ? 'B' : 'A'}${sealed.sealed.slice(i + 1)}`);
    }
    variants.push(sealed.sealed.slice(0, -1), sealed.sealed.slice(0, 30), `v1.${iv ?? ''}.${otherBody ?? ''}`, `v1.${otherIv ?? ''}.${body ?? ''}`, sealed.sealed.replace('v1.', 'v2.'));
    for (const variant of variants) {
      attempts += 1;
      let opened: string | null = null;
      try {
        opened = openWebhookAuthorization(RING, binding, { kid: 'w1', sealed: variant });
      } catch (error) {
        expect((error as Error).message).not.toContain('adv_');
      }
      // base64url 의 마지막 글자 끝 비트만 바꾼 경우 같은 바이트로 풀릴 수 있다 — 그때는 원래 값이어야 한다(변조된 다른 값이 나오면 안 된다).
      if (opened !== null) expect(opened, `VULN: ${variant}`).toBe(TOKEN);
    }
    expect(variants.length).toBeGreaterThan(40);
  });
});

describe('③ 결속 우회', () => {
  it('URL 변형 · 다른 에이전트 · 다른 kid 로는 열리지 않는다', () => {
    const sealed = sealWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A }, TOKEN);
    const urls = [
      'https://hooks.example.com/v1/atmark/',
      'https://hooks.example.com/v1/Atmark',
      'https://hooks.example.com/v1/atmark?x=1',
      'https://hooks.example.com:8443/v1/atmark',
      'https://evil.hooks.example.com/v1/atmark',
      'https://hooks.example.com.evil.net/v1/atmark',
      'https://hooks.example.com/v1/atmark#frag',
      'https://hooks.example.com//v1/atmark',
      'http://hooks.example.com/v1/atmark',
      `${URL_A} `,
    ];
    for (const url of urls) {
      attempts += 1;
      expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url }, sealed), `VULN: ${url}`).toThrow();
    }
    for (const agentId of ['d'.repeat(32), AGENT.toUpperCase(), `${AGENT} `, '']) {
      attempts += 1;
      expect(() => openWebhookAuthorization(RING, { agentId, endpointId: EP, generation: 1, url: URL_A }, sealed), `VULN: ${agentId}`).toThrow();
    }
    // 보안 리뷰 L2 — 다른 엔드포인트 id(새 등록 · 지우고 다시 만든 것 · 대소문자 · 빈 값)로는 열리지 않는다.
    for (const endpointId of [randomUUID(), randomUUID(), EP.toUpperCase(), `${EP} `, '']) {
      attempts += 1;
      expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId, generation: 1, url: URL_A }, sealed), `VULN: ${endpointId}`).toThrow();
    }
    // 재검증 L2 — 다른 세대로는 열리지 않는다(옛 봉인값 재삽입 · 지운 값 되살리기).
    for (const generation of [2, 3, 4, 10, 2 ** 31 - 1]) {
      attempts += 1;
      expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation, url: URL_A }, sealed), `VULN: gen ${generation}`).toThrow();
    }
    for (const kid of ['w0', 'w2', '', 'W1']) {
      attempts += 1;
      expect(() => openWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A }, { kid, sealed: sealed.sealed }), `VULN: ${kid}`).toThrow();
    }
  });
});

describe('④ 누출', () => {
  it('열지 못한 전달은 보내지 않고 · 보고서 · 로그에 값이 없다 · 연 전달은 헤더 하나만 더한다', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const sealed = sealWebhookAuthorization(RING, { agentId: AGENT, endpointId: EP, generation: 1, url: URL_A }, TOKEN);
    const claimed = (url: string): ClaimedDelivery => ({
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      body: '{"id":"e"}',
      attempt: 1,
      endpoint: { id: EP, url, secretKid: 'w1', secretVersion: 1, disabled: false, agentId: AGENT, authorization: { kid: sealed.kid, sealed: sealed.sealed, generation: 1 } },
    });
    const requests: WebhookHttpRequest[] = [];
    const reports = await dispatchDueWebhooks(
      {
        outbox: { claimDue: async () => [claimed(URL_A), claimed('https://attacker.example.net/x')], markDelivered: async () => true, scheduleRetry: async () => true, markDead: async () => true },
        resolve: async () => [{ address: '93.184.215.14', family: 4 }],
        keyring: RING,
        transport: {
          post: async (request) => {
            requests.push(request);
            return { kind: 'response', status: 200 };
          },
        },
      },
      new Date(),
    );
    attempts += 1;
    expect(requests.map((request) => request.hostname)).toEqual(['hooks.example.com']);
    expect(Object.keys(requests[0]?.headers ?? {}).sort()).toEqual(['authorization', 'content-type', 'user-agent', 'webhook-id', 'webhook-signature', 'webhook-timestamp']);
    expect(reports[1]?.errorKind).toBe('authorization_unavailable');
    expect(JSON.stringify(reports)).not.toContain('adv_');
    expect(lines.join('\n')).not.toContain('adv_');
  });

  it('공격 시도는 100회 이상이다', () => {
    expect(attempts).toBeGreaterThanOrEqual(100);
  });
});
