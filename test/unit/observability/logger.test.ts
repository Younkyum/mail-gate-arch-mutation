/**
 * `logger.ts` — **PII 가 로그로 새지 않는다**, 그리고 **로깅은 던지지 않는다**.
 * 둘 다 깨져도 조용하다 — 주소가 샌 로그는 멀쩡해 보이고, 던지는 로거는 발송 실패로 위장한다.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  LOG_FIELD_KEYS,
  MAX_STRING_LENGTH,
  REDACTED_ADDRESS,
  REDACTED_NONSCALAR,
  REDACTED_TOKEN,
  TRUNCATION_MARKER,
  log,
  redact,
  resetLogSink,
  setLogSink,
  writeLine,
  type LogFields,
} from '../../../src/observability/logger';

/** 실제 PII — 이 값들이 출력 어디에도 나타나면 안 된다. */
const RECIPIENT = 'victim@example.com';
const SUBJECT = '3분기 정산 내역 확인 부탁드립니다';
const BODY = '안녕하세요. 첨부한 계좌로 입금 부탁드립니다. 계좌번호는 110-123-456789 입니다.';

function capture(): { readonly lines: string[] } {
  const lines: string[] = [];
  setLogSink((line) => {
    lines.push(line);
  });
  return { lines };
}

afterEach(() => {
  resetLogSink();
});

describe('logger — PII 규율 ① 닫힌 어휘', () => {
  it('어휘에 수신자·제목·본문을 담을 키가 존재하지 않는다', () => {
    // `log('x', { subject })` 가 타입 에러인 근거.
    const forbidden = ['subject', 'body', 'text', 'html', 'to', 'recipients', 'from_address', 'email'];
    expect(LOG_FIELD_KEYS.filter((key) => forbidden.includes(key))).toEqual([]);
  });

  it('어휘 밖의 키는 버려진다 — 타입이 없는 경계(JSON·캐스팅)에서도 막힌다', () => {
    const { lines } = capture();
    log('info', 'test', { subject: SUBJECT, to: RECIPIENT, route_id: 'send' } as unknown as LogFields);

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain(SUBJECT);
    expect(line).not.toContain(RECIPIENT);
    expect(JSON.parse(line)).toMatchObject({ route_id: 'send' });
  });
});

describe('logger — PII 규율 ② 런타임 치환', () => {
  it('주소 형태 토큰은 키와 무관하게 치환된다', () => {
    // DB 드라이버 오류는 값을 그대로 에코하고, 그 오류가 `detail` 로 들어온다.
    expect(redact(`duplicate key value: (address)=(${RECIPIENT})`)).toBe(
      `duplicate key value: (address)=(${REDACTED_ADDRESS})`,
    );
  });

  it('여러 주소가 한 줄에 있어도 전부 치환된다', () => {
    const redacted = redact(`to=a@x.com, b@y.co.kr cc=c@z.org`);
    expect(redacted).not.toContain('@x.com');
    expect(redacted).not.toContain('@y.co.kr');
    expect(redacted).not.toContain('@z.org');
  });

  it('Message-ID 헤더 형태도 주소로 보고 지운다 — 도메인 + 로컬파트이기 때문이다', () => {
    expect(redact('<mucer1q5.abc@atmark.ai>')).toContain(REDACTED_ADDRESS);
  });

  it('본문 한 통이 detail 로 들어와도 상한에서 잘린다', () => {
    const long = BODY.repeat(50);
    const redacted = redact(long);
    expect(typeof redacted).toBe('string');
    expect(String(redacted).length).toBe(MAX_STRING_LENGTH + TRUNCATION_MARKER.length);
    expect(String(redacted).endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('스칼라는 건드리지 않는다', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
  });

  it('비스칼라는 표지로 바뀐다 — 안쪽은 어휘 밖이므로 통째로 거부한다', () => {
    // P1c 검증에서 뚫린 자리 — 어휘 안의 키(`detail`)에 객체를 실으면 세 겹이 전부 무반응이었다.
    expect(redact({ to: RECIPIENT, subject: SUBJECT })).toBe(REDACTED_NONSCALAR);
    expect(redact([RECIPIENT, SUBJECT])).toBe(REDACTED_NONSCALAR);
    expect(redact(() => RECIPIENT)).toBe(REDACTED_NONSCALAR);
    // `JSON.stringify` 를 던지게 해 줄을 통째로 삼키던 타입도 표지로 바뀐다.
    expect(redact(BigInt(1))).toBe(REDACTED_NONSCALAR);
    expect(redact(Symbol('s'))).toBe(REDACTED_NONSCALAR);
  });

  it.each([
    ['중첩 객체', { to: RECIPIENT, subject: SUBJECT, body: BODY }],
    ['배열(수신자 목록)', [RECIPIENT, 'second@example.com']],
  ])('어휘 안의 키에 %s 가 와도 내용물이 한 글자도 나가지 않는다', (_label, detail) => {
    const { lines } = capture();

    log('info', 'probe.nested', { detail } as unknown as LogFields);

    const line = lines[0] ?? '';
    for (const leaked of ['victim', '@example.com', SUBJECT, BODY]) expect(line).not.toContain(leaked);
    expect(JSON.parse(line)).toMatchObject({ detail: REDACTED_NONSCALAR });
  });

  it('거부는 조용하지 않다 — 표지가 남아 "안 실었다" 와 구별된다', () => {
    const { lines } = capture();

    log('info', 'probe.marker', { detail: {} as unknown as string, route_id: 'send' });
    log('info', 'probe.absent', { route_id: 'send' });

    const rejected = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    const absent = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    expect(rejected['detail']).toBe(REDACTED_NONSCALAR);
    expect(absent['detail']).toBeUndefined();
  });

  it('`detail: String(error)` 경로는 그대로 산다 — 거부가 깨면 안 되는 유일한 계약', () => {
    const { lines } = capture();
    const error = new Error(`duplicate key value: (address)=(${RECIPIENT})`);

    log('error', 'audit.resolve_failed', { detail: error instanceof Error ? error.message : String(error) });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['detail']).toBe(`duplicate key value: (address)=(${REDACTED_ADDRESS})`);
  });

  it('실제 발송 한 건의 로그에 수신자·제목·본문이 하나도 없다', () => {
    const { lines } = capture();

    log('info', 'gate.attempt', {
      route_id: 'send',
      agent_id: 'a'.repeat(32),
      message_id: '11111111-2222-3333-4444-555555555555',
      recipient_count: 3,
      verdict: 'allowed',
      detail: `send to ${RECIPIENT}: ${SUBJECT} / ${BODY}`,
    });

    const line = lines[0] ?? '';
    expect(line).not.toContain(RECIPIENT);
    expect(line).not.toContain('victim');
    // 참조는 ID·카운트로 남는다.
    expect(JSON.parse(line)).toMatchObject({ recipient_count: 3, agent_id: 'a'.repeat(32) });
  });
});

describe('logger — 관측은 결말을 뒤집지 않는다 (경계 ③)', () => {
  it.each([
    ['writeLine', (): void => writeLine('{}')],
    ['log', (): void => log('error', 'audit.resolve_failed', { message_id: 'm-1' })],
  ])('싱크가 던져도 %s 는 던지지 않는다 — BLOCKER 재발 방지', (_label, call) => {
    setLogSink(() => {
      throw new Error('EPIPE');
    });
    expect(call).not.toThrow();
  });

  it('순환 참조가 와도 던지지 않고, 그 줄은 표지와 함께 살아남는다', () => {
    const { lines } = capture();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => {
      log('info', 'test', { detail: circular as unknown as string, route_id: 'send' });
    }).not.toThrow();

    // 비스칼라 거부가 직렬화 앞에 서므로 순환은 `JSON.stringify` 까지 가지 않고, 나머지 필드가 산다.
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ detail: REDACTED_NONSCALAR, route_id: 'send' });
  });

  it('그래도 직렬화가 실패하면 아무것도 쓰지 않는다 — 반쯤 쓴 줄을 남기지 않는다', () => {
    const { lines } = capture();
    // 필드는 스칼라로 정제되므로 남은 직렬화 실패 경로는 `event` 뿐이다(`bigint`).
    expect(() => {
      log('info', BigInt(1) as unknown as string, { route_id: 'send' });
    }).not.toThrow();
    expect(lines).toEqual([]);
  });
});

describe('logger — 출력 형태', () => {
  it('한 줄은 ts·level·event 를 갖는 JSON 이다', () => {
    const { lines } = capture();
    log('warn', 'api.preflight_rejected', { route_id: 'send', http_status: 400 });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('warn');
    expect(parsed['event']).toBe('api.preflight_rejected');
    expect(typeof parsed['ts']).toBe('string');
    expect(parsed['http_status']).toBe(400);
  });
});

describe('logger — 우리가 발급한 비밀은 값에서 지워진다 (P2 매직링크·웹훅)', () => {
  // HTTP 오류는 URL(승인 링크 토큰)을 에코해 `detail` 로 들어온다 — 어휘(①)는 이 경로를 막지 못한다.
  const LINK = 'atk_link_k1.eyJhIjoiMSJ9.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
  const AGENT = 'atk_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const WHSEC = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw+8/xYz==';

  it.each([
    ['승인 링크 URL 이 담긴 오류', `request to https://app.atmark.ai/approve#${LINK} failed`, LINK],
    ['에이전트 토큰', `Authorization: Bearer ${AGENT}`, AGENT],
    ['웹훅 시크릿', `secret=${WHSEC}`, WHSEC],
  ])('%s', (_label, value, secret) => {
    const { lines } = capture();
    log('error', 'test', { detail: value });
    const line = lines[0] ?? '';
    expect(line).not.toContain(secret);
    expect(line).toContain(REDACTED_TOKEN);
  });

  it('토큰 치환이 주소 치환을 깨지 않는다', () => {
    expect(redact(`${LINK} ${RECIPIENT}`)).toBe(`${REDACTED_TOKEN} ${REDACTED_ADDRESS}`);
  });
});
