/**
 * `parseSendBody` — **정책이 판정하는 문자열과 SES 로 나가는 문자열이 갈라지지 않는가**(P1b 리뷰 MAJOR 4 회귀).
 * 정책은 `normalizeAddress` 사본을 보고 전송단은 원본을 받는다 — `from` 이 정규형이 아니면 둘이 갈라진다
 * (`demo-x+anything@atmark.ai` → 정규화 `demo-x@…` 로 Stage 1 통과 → SES 는 `+anything` 으로 보낸다).
 */

import { describe, expect, it } from 'vitest';

import { parseReplyBody, parseSendBody } from '../../../src/api/outbound-http';

const VALID = {
  agent_id: 'a'.repeat(32),
  from: 'agent@atmark.ai',
  to: ['friend@example.com'],
  subject: 'hello',
  text: '본문',
};

function parse(overrides: Record<string, unknown>): ReturnType<typeof parseSendBody> {
  return parseSendBody({ ...VALID, ...overrides });
}

function codeOf(outcome: ReturnType<typeof parseSendBody>): string {
  if (outcome.kind === 'ok') throw new Error('거부를 기대했는데 통과했다');
  return String(outcome.response.body['error']);
}

function detailOf(outcome: ReturnType<typeof parseSendBody>): string {
  if (outcome.kind === 'ok') throw new Error('거부를 기대했는데 통과했다');
  return String(outcome.response.body['detail']);
}

describe('parseSendBody — from 은 정규형이어야 한다 (MAJOR 4)', () => {
  it('정규형 from 은 통과한다', () => {
    expect(parse({}).kind).toBe('ok');
  });

  it.each([
    ['`+tag` — 평가한 주소와 나가는 주소가 다르다', 'demo-x+anything@atmark.ai', 'canonical form'],
    ['대문자 — 같은 비대칭의 다른 축', 'Agent@Atmark.ai', 'canonical form'],
    ['`@` 없음 — 어떤 정책 항목과도 매칭되지 않는다', 'not-an-address', 'not an email address'],
    ['개행 — `\\s` 가 CRLF 를 포함한다(헤더 인젝션)', 'agent@atmark.ai\r\nBcc: everyone@x.com', 'not an email address'],
  ])('from 거부: %s', (_label, from, detail) => {
    expect(detailOf(parse({ from }))).toContain(detail);
  });
});

describe('parseSendBody — to 는 모양만 요구한다', () => {
  it('수신자의 `+tag` 는 통과한다 — 수신자가 자기 메일함을 분류하려고 붙인 것이다', () => {
    // **의도된 비대칭이다.** 여기서 거부하면 서브어드레싱을 쓰는 정상 수신자가
    // 우리에게서만 메일을 못 받는다. 억제·차단은 정규화 사본으로 판정하므로
    // `victim+x@gmail.com` 이 억제 목록을 우회하지도 않는다.
    expect(parse({ to: ['friend+newsletter@example.com'] }).kind).toBe('ok');
  });

  it('대문자 수신자도 통과한다 — 판정만 정규화되고 전송은 원본이다', () => {
    expect(parse({ to: ['Friend@Example.com'] }).kind).toBe('ok');
  });

  it('CRLF 가 든 수신자는 거부된다 — 헤더 인젝션이 관문 앞에서 죽는다', () => {
    const outcome = parse({ to: ['victim@x.com\r\nBcc: everyone@y.com'] });
    expect(outcome.kind).toBe('error');
    expect(codeOf(outcome)).toBe('invalid_recipient');
  });

  it('`@` 가 두 개인 수신자는 거부된다', () => {
    expect(parse({ to: ['a@b@c'] }).kind).toBe('error');
  });

  it('여러 수신자 중 하나만 깨져도 요청 전체가 거부된다 — 부분 발송은 없다', () => {
    const outcome = parse({ to: ['ok@example.com', 'broken'] });
    expect(outcome.kind).toBe('error');
    expect(detailOf(outcome)).toContain('broken');
  });
});

describe('parseSendBody·parseReplyBody — 수신자는 ASCII dot-atom 만 (202609241040 — 검증 M2)', () => {
  // 셋 다 SES 에서는 같은 메일함인데 차단·억제의 문자열 비교를 비껴갔다(관문 통과 실측).
  const BYPASSES = [
    '"bad"@x.com',
    'bad@x.com.',
    'u@evil.com.',
    'bad\\@x.com',
    '"bad@x.com"@y.com',
    'u@[1.2.3.4]',
    '.bad@x.com',
    'bad.@x.com',
    'b..ad@x.com',
    'bad@x..com',
    'bad@-x.com',
    'bad@localhost',
    'b\u00e4d@x.com',
    'bad@x.com\u200b',
    `${'a'.repeat(65)}@x.com`,
  ];

  it.each(BYPASSES)('%j → 400 invalid_recipient', (address) => {
    const outcome = parse({ to: ['ok@example.com', address] });
    expect(codeOf(outcome)).toBe('invalid_recipient');
    expect(detailOf(outcome)).toContain(JSON.stringify(address).slice(1, -1).slice(0, 5));
    expect(outcome.kind === 'error' ? outcome.response.status : 0).toBe(400);
  });

  it('회신의 명시 수신자도 같은 검사 · 정상 주소(대소문자·+tag·하이픈 도메인)는 그대로 통과한다', () => {
    const reply = parseReplyBody({ ...VALID, in_reply_to: '00000000-0000-4000-8000-000000000001', to: ['"bad"@x.com'] });
    expect(reply.kind === 'error' ? reply.response.body['error'] : null).toBe('invalid_recipient');
    const ok = parse({ to: ['Friend+Tag@Mail.Example-Co.com', "o'brien@example.ie", 'first.last@sub.example.co.kr'] });
    expect(ok.kind === 'ok' ? ok.value.recipients : null).toEqual(['Friend+Tag@Mail.Example-Co.com', "o'brien@example.ie", 'first.last@sub.example.co.kr']);
  });
});
