/**
 * Paddle 웹훅 서명(`src/billing/paddle/signature.ts`) — 계획 §3-2 · 수용 기준 B-1.
 *
 * 벡터는 이 테스트가 스스로 만든다(가짜 비밀 — 실제 `pdl_`·웹훅 비밀 형식 문자열 없음). 정답 서명 = HMAC-SHA256(비밀, `ts:` + 원문 바이트).
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PADDLE_SIGNATURE_HEADER_MAX_LENGTH,
  PADDLE_SIGNATURE_MAX_H1,
  PADDLE_SIGNATURE_TOLERANCE_SECONDS,
  parsePaddleSignatureHeader,
  parsePaddleWebhookSecrets,
  verifyPaddleSignature,
  type PaddleWebhookSecrets,
} from '../../../src/billing/paddle/signature';

const CURRENT = 'test-webhook-secret-current-0123456789';
const PREVIOUS = 'test-webhook-secret-previous-9876543210';
const SECRETS: PaddleWebhookSecrets = { current: CURRENT, previous: null };
const TS = 1_790_000_000;
const BODY = Buffer.from('{"event_id":"evt_01hv000000000000000000000a","event_type":"subscription.updated","data":{"id":"sub_x"}}', 'utf8');

function sign(secret: string, ts: number, body: Uint8Array): string {
  return createHmac('sha256', secret).update(`${String(ts)}:`).update(body).digest('hex');
}

function verify(header: string | undefined, overrides: Partial<{ body: Uint8Array; secrets: PaddleWebhookSecrets; now: number }> = {}) {
  return verifyPaddleSignature({
    header,
    rawBody: overrides.body ?? BODY,
    secrets: overrides.secrets ?? SECRETS,
    nowSeconds: overrides.now ?? TS,
  });
}

describe('Paddle 서명 — 정답과 변조', () => {
  it('정답 서명은 통과한다(타임스탬프를 돌려준다)', () => {
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS, BODY)}`)).toEqual({ ok: true, timestamp: TS });
  });

  it('바디를 1바이트만 바꿔도 거부한다', () => {
    const tampered = Buffer.from(BODY);
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS, BODY)}`, { body: tampered })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('재직렬화한 바디(공백·키 순서)는 거부한다 — 원문 바이트로만 잰다', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(BODY.toString('utf8')), null, 1), 'utf8');
    expect(reserialized.equals(BODY)).toBe(false);
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS, BODY)}`, { body: reserialized }).ok).toBe(false);
  });

  it('비ASCII 바이트가 든 바디도 바이트 그대로 잰다(UTF-8 원문)', () => {
    const body = Buffer.from('{"note":"결제 — é"}', 'utf8');
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS, body)}`, { body }).ok).toBe(true);
  });

  it('다른 비밀로 만든 서명은 거부한다', () => {
    expect(verify(`ts=${String(TS)};h1=${sign('another-secret-value-000000', TS, BODY)}`)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('서명의 ts 와 헤더의 ts 가 다르면 거부한다(ts 는 서명 대상이다)', () => {
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS + 1, BODY)}`).ok).toBe(false);
  });

  it('h1 이 둘이면 하나만 맞아도 통과한다(Paddle 쪽 비밀 교체 중)', () => {
    const wrong = sign('stale-secret-value-00000000', TS, BODY);
    expect(verify(`ts=${String(TS)};h1=${wrong};h1=${sign(CURRENT, TS, BODY)}`).ok).toBe(true);
    expect(verify(`ts=${String(TS)};h1=${sign(CURRENT, TS, BODY)};h1=${wrong}`).ok).toBe(true);
  });

  it('우리 쪽 previous 비밀로 서명된 것도 통과한다 · previous 가 null 이면 거부한다', () => {
    const header = `ts=${String(TS)};h1=${sign(PREVIOUS, TS, BODY)}`;
    expect(verify(header, { secrets: { current: CURRENT, previous: PREVIOUS } }).ok).toBe(true);
    expect(verify(header, { secrets: { current: CURRENT, previous: null } }).ok).toBe(false);
  });
});

describe('Paddle 서명 — 타임스탬프 창(±5초, 경계 포함)', () => {
  const header = `ts=${String(TS)};h1=${sign(CURRENT, TS, BODY)}`;

  it.each([
    ['과거 5초', TS + 5, true],
    ['과거 6초', TS + 6, false],
    ['미래 5초', TS - 5, true],
    ['미래 6초', TS - 6, false],
    ['한 시간 뒤 재전송', TS + 3600, false],
  ] as const)('%s → 통과 %s(서명이 맞아도 창 밖이면 거부)', (_label, now, ok) => {
    expect(PADDLE_SIGNATURE_TOLERANCE_SECONDS).toBe(5);
    expect(verify(header, { now })).toEqual(ok ? { ok: true, timestamp: TS } : { ok: false, reason: 'timestamp_out_of_window' });
  });
});

describe('Paddle 서명 — 헤더 파서(엄격)', () => {
  const h1 = sign(CURRENT, TS, BODY);

  it.each([
    ['없음', undefined],
    ['빈 문자열', ''],
    ['ts 없음', `h1=${h1}`],
    ['h1 없음', `ts=${String(TS)}`],
    ['ts 중복', `ts=${String(TS)};ts=${String(TS)};h1=${h1}`],
    ['ts 9자리', `ts=${String(TS).slice(1)};h1=${h1}`],
    ['ts 11자리', `ts=${String(TS)}0;h1=${h1}`],
    ['ts 음수', `ts=-${String(TS).slice(1)};h1=${h1}`],
    ['ts 소수', `ts=${String(TS).slice(0, 9)}.;h1=${h1}`],
    ['h1 대문자', `ts=${String(TS)};h1=${h1.toUpperCase()}`],
    ['h1 63자', `ts=${String(TS)};h1=${h1.slice(1)}`],
    ['h1 65자', `ts=${String(TS)};h1=${h1}0`],
    ['h1 hex 아님', `ts=${String(TS)};h1=${'z'.repeat(64)}`],
    ['공백 섞임', `ts=${String(TS)}; h1=${h1}`],
    ['끝 세미콜론', `ts=${String(TS)};h1=${h1};`],
    ['앞 세미콜론', `;ts=${String(TS)};h1=${h1}`],
    ['쉼표 구분', `ts=${String(TS)},h1=${h1}`],
    ['모르는 키', `ts=${String(TS)};h1=${h1};v1=${h1}`],
    ['키 대문자', `TS=${String(TS)};h1=${h1}`],
    ['등호 없음', `ts${String(TS)};h1=${h1}`],
    ['빈 키', `=${String(TS)};h1=${h1}`],
    ['h1 다섯 개', `ts=${String(TS)};${Array.from({ length: PADDLE_SIGNATURE_MAX_H1 + 1 }, () => `h1=${h1}`).join(';')}`],
    ['너무 긺', `ts=${String(TS)};h1=${h1};${'x'.repeat(PADDLE_SIGNATURE_HEADER_MAX_LENGTH)}`],
  ])('%s → 거부(header_malformed)', (_name, header) => {
    expect(parsePaddleSignatureHeader(header)).toBeNull();
    expect(verify(header)).toEqual({ ok: false, reason: 'header_malformed' });
  });

  it('h1 넷까지는 받는다', () => {
    const header = `ts=${String(TS)};${Array.from({ length: PADDLE_SIGNATURE_MAX_H1 }, () => `h1=${h1}`).join(';')}`;
    expect(parsePaddleSignatureHeader(header)?.h1).toHaveLength(PADDLE_SIGNATURE_MAX_H1);
  });

  it('퍼징 — 무작위 헤더 5 000개: 던지지 않고, 정답이 아니면 전부 거부한다', () => {
    // 결정적 의사난수(LCG) — 실패가 재현된다.
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    const alphabet = 'ts=h1;0123456789abcdefABCDEF,:= \t-_.\u0000é';
    const valid = `ts=${String(TS)};h1=${h1}`;
    for (let i = 0; i < 5000; i += 1) {
      let header: string;
      const mode = next() % 3;
      if (mode === 0) {
        header = Array.from({ length: next() % 120 }, () => alphabet[next() % alphabet.length]).join('');
      } else if (mode === 1) {
        // 정답을 한 글자 바꾸거나 지우거나 끼운다.
        const at = next() % valid.length;
        const op = next() % 3;
        const ch = alphabet[next() % alphabet.length] ?? 'x';
        header = op === 0 ? valid.slice(0, at) + ch + valid.slice(at + 1) : op === 1 ? valid.slice(0, at) + valid.slice(at + 1) : valid.slice(0, at) + ch + valid.slice(at);
      } else {
        header = `ts=${String(next() % 10_000_000_000).padStart(10, '0')};h1=${Array.from({ length: 64 }, () => '0123456789abcdef'[next() % 16]).join('')}`;
      }
      let verdict: ReturnType<typeof verify> | undefined;
      expect(() => {
        verdict = verify(header);
      }, header).not.toThrow();
      if (header !== valid) expect(verdict?.ok, JSON.stringify(header)).toBe(false);
    }
  });
});

describe('웹훅 비밀 JSON', () => {
  it('{"current","previous"} — previous 는 null·없음 모두 허용', () => {
    expect(parsePaddleWebhookSecrets(JSON.stringify({ current: CURRENT, previous: null }))).toEqual({ current: CURRENT, previous: null });
    expect(parsePaddleWebhookSecrets(JSON.stringify({ current: CURRENT }))).toEqual({ current: CURRENT, previous: null });
    expect(parsePaddleWebhookSecrets(JSON.stringify({ current: CURRENT, previous: PREVIOUS }))).toEqual({ current: CURRENT, previous: PREVIOUS });
  });

  it.each([
    ['JSON 아님', 'not json'],
    ['배열', '[]'],
    ['자리표시', JSON.stringify({ _unset: 'placeholder' })],
    ['current 빈 문자열', JSON.stringify({ current: '' })],
    ['current 짧음', JSON.stringify({ current: 'short' })],
    ['current 앞뒤 공백', JSON.stringify({ current: ` ${CURRENT} ` })],
    ['current 숫자', JSON.stringify({ current: 12 })],
    ['previous 빈 문자열', JSON.stringify({ current: CURRENT, previous: '' })],
  ])('%s → null', (_name, raw) => {
    expect(parsePaddleWebhookSecrets(raw)).toBeNull();
  });
});
