/**
 * 발신 DLP 의 **선형 시간** — `injection-redos.test.ts` 와 같은 두 겹(정적 규율 + 1MB 적대 입력 실측).
 *
 * 왜: 발신 본문은 에이전트가 만든다 — 인젝션에 걸린 에이전트는 곧 적대 입력의 작성자다. DLP 가 발송 경로에서 역추적 폭발하면
 * 관문 타임아웃이 곧 발송 장애다.
 *
 *   1. 정적: `SECRET_AUDITED_PATTERNS` 에 가변 수량자(`+` `*` `{n,}`)가 없고, 부정 클래스·`.` 위의 긴 간격이 정규식마다 하나 이하다.
 *      코드 투영·shingle 은 정규식이 아니라 한 번 훑는 루프다(그래서 감사 목록에 없다).
 *   2. 동적: 계열마다 가장 불리한 모양(접두사만 반복 · 마디가 맞지 않는 긴 덩어리 · 숫자/구분자 교대 · 단어 반복)을 1MB 로 만들어
 *      `scanOutbound` 한 번이 예산 안에 끝난다 — 지문이 있는 맥락(코드 HMAC · shingle HMAC 이 실제로 도는 경로)으로.
 *
 * 감사기(`audit`)는 `injection-redos.test.ts` 의 것과 같은 규칙이다(그 파일을 고치지 않으려고 옮겨 적었다).
 */

import { describe, expect, it } from 'vitest';

import { parseHmacKeyring } from '../../../../src/security/hmac-keyring';
import { fold } from '../../../../src/security/injection/normalize';
import { fingerprintCode, type CodeFingerprint } from '../../../../src/security/dlp/codes';
import { DECODE_AUDITED_PATTERNS } from '../../../../src/security/dlp/decode';
import { MARKUP_AUDITED_PATTERNS } from '../../../../src/security/dlp/markup';
import { MAX_OUTBOUND_SCAN_CHARS, scanOutbound, type DlpContext, type OutboundContent } from '../../../../src/security/dlp/scan';
import { SECRET_AUDITED_PATTERNS } from '../../../../src/security/dlp/secrets';

const AUDITED = [...SECRET_AUDITED_PATTERNS, ...MARKUP_AUDITED_PATTERNS, ...DECODE_AUDITED_PATTERNS];
const plain = (text: string): OutboundContent => ({ subject: null, text, html: null, attachments: [] });
import { inboundShingles } from '../../../../src/security/dlp/shingle';

interface Audit {
  readonly unbounded: string[];
  readonly gaps: number;
}

function audit(source: string): Audit {
  const unbounded: string[] = [];
  let gaps = 0;
  let inClass = false;
  let classNegated = false;
  let lastAtom: 'gap' | 'other' = 'other';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      if ((next === 'u' || next === 'p' || next === 'P') && source[i + 2] === '{') i = source.indexOf('}', i);
      else i += 1;
      if (!inClass) lastAtom = 'other';
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        lastAtom = classNegated ? 'gap' : 'other';
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      classNegated = source[i + 1] === '^';
      if (classNegated) i += 1;
      if (source[i + 1] === ']') i += 1;
      continue;
    }
    if (ch === '+' || ch === '*') {
      unbounded.push(`${ch} @${String(i)}`);
      continue;
    }
    if (ch === '{') {
      const close = source.indexOf('}', i);
      const body = source.slice(i + 1, close);
      if (/^\d+,$/.test(body)) unbounded.push(`{${body}} @${String(i)}`);
      const range = /^(\d+),(\d+)$/.exec(body);
      if (range && Number(range[2]) > 16 && lastAtom === 'gap') gaps += 1;
      i = close;
      continue;
    }
    lastAtom = ch === '.' ? 'gap' : 'other';
  }
  return { unbounded, gaps };
}

describe('정적 — DLP 정규식에 역추적 폭발 모양이 없다', () => {
  it('감사 목록이 비어 있지 않다 · 감사기가 위반을 잡는다', () => {
    expect(AUDITED.length).toBeGreaterThanOrEqual(19);
    expect(audit('a+b').unbounded).toHaveLength(1);
    expect(audit('x{2,}').unbounded).toHaveLength(1);
    expect(audit('a[^.]{0,60}b[^.]{0,60}c').gaps).toBe(2);
    expect(audit('[a-z0-9+/]{40,88}').unbounded).toEqual([]);
  });

  it.each(AUDITED.map((p) => [p.name, p.source] as const))('%s', (_name, source) => {
    const result = audit(source);
    expect(result.unbounded).toEqual([]);
    expect(result.gaps).toBeLessThanOrEqual(1);
  });
});

const MB = MAX_OUTBOUND_SCAN_CHARS;
const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
const BUDGET_MS = 3_000;

const KEYRING = parseHmacKeyring(`k1:${Buffer.alloc(32, 7).toString('base64url')}`, 'TEST_KEYS');
const prints: CodeFingerprint[] = [];
for (let n = 0; n < 32; n += 1) {
  const print = fingerprintCode(KEYRING, String(100000 + n * 7919), `origin${String(n)}.example`);
  if (print !== null) prints.push(print);
}
const shingleText = Array.from({ length: 400 }, (_, i) => `word${String(i)} lorem ipsum dolor`).join(' ');
const CTX: DlpContext = {
  keyring: KEYRING,
  recipients: ['someone@attacker.example'],
  recipientDomains: ['attacker.example'],
  codeFingerprints: prints,
  inboundCopies: Array.from({ length: 50 }, (_, i) => ({
    inboundMessageId: `in-${String(i)}`,
    senderAddress: `s${String(i)}@sender.example`,
    threadId: null,
    threadParticipants: [],
    shingles: inboundShingles(KEYRING, fold(`${shingleText} ${String(i)}`).text),
  })),
};

describe('동적 — 1MB 적대 발신 본문이 예산 안에 끝난다', () => {
  it.each([
    ['한 글자 반복', fill('a')],
    ['영어 산문', fill('lorem ipsum dolor sit amet consectetur ')],
    ['서로 다른 단어(지문 최다)', Array.from({ length: 200_000 }, (_, i) => `w${i.toString(36)}`).join(' ').slice(0, MB)],
    ['atk 접두사만', fill('atk_agent_')],
    ['atk 서명 토큰 마디 불일치', fill('atk_link_k1.AAAAAAAAAAAAAAAA')],
    ['긴 base64url 덩어리', fill('Ab3_-Zq9xY0mN7pL2kW8vR4tU6sH1jG5fD0cE3bA9zQ')],
    ['whsec 접두사 반복', fill('whsec_AAAA')],
    ['AKIA 반복', fill('AKIAAAAA')],
    ['gh 접두사 반복', fill('ghp_')],
    ['xoxb 반복', fill('xoxb-')],
    ['PEM 머리 조각', fill('-----BEGIN RSA ')],
    ['JWT 두 마디(셋째 없음)', fill('eyJhbGciOiJIUzI1NiJ9.eyJhbGciOiJIUzI1NiJ9 ')],
    ['eyJ 반복', fill('eyJ')],
    ['숫자만', fill('1')],
    ['숫자·공백 교대(코드 후보 최다)', fill('1 2 ')],
    ['숫자·하이픈 교대', fill('4-8-')],
    ['짧은 원자·구분자', fill('a1.')],
    ['전각 숫자', fill('４８２９１３ ')],
    ['한글 음절', fill('가나다라마바사 ')],
    ['한국어 문장', fill('인증번호는 482913 입니다 ')],
    ['NFKD 확장 글자', fill(String.fromCodePoint(0xfdfa))],
    ['제로폭 교대', fill(`a${String.fromCodePoint(0x200b)}`)],
    ['인용 표시 반복', fill('> ')],
    // M0 보강 — 마크업 정규화 · 넓힌 구분자 · 새 비밀 형식
    ['여는 꺾쇠 + 글자 반복(태그 미완성)', fill('<a ')],
    ['긴 속성의 미완성 태그', fill(`<a ${'x'.repeat(600)}`)],
    ['선언 미완성', fill('<!')],
    ['엔티티 반복', fill('&#95;')],
    ['엔티티 미완성', fill('&#')],
    ['이중 엔티티', fill('&amp;#95;')],
    ['퍼센트 반복', fill('%5F')],
    ['span 으로 쪼갠 숫자', fill('4<span></span>8')],
    ['숫자·쉼표 교대', fill('1,2;')],
    ['숫자·줄바꿈 교대', fill('12\n')],
    ['아라비아-인도 숫자', fill('٤٨٢ ')],
    ['데바나가리 숫자', fill('४८२')],
    ['sk- 접두사 반복', fill('sk-')],
    ['sk-ant 반복', fill('sk-ant-')],
    ['AIza 반복', fill('AIza')],
    ['glpat 반복', fill('glpat-')],
    ['xoxe.xoxp 반복', fill('xoxe.xoxp-')],
    // 2026-10-08 풀어 본 보기(`decode.ts`) — 읽히는 글로 풀리는 덩어리 · 짧은 후보 최다 · 16진수 · 퍼센트 UTF-8 · 줄바꿈 base64 · 두 겹
    ['읽히는 base64 반복', fill('QUJD')],
    ['짧은 base64 후보(숫자 포함) 최다', fill('NDgyOTEz ')],
    ['16진수 쌍 + 공백', fill('41 ')],
    ['\\x 16진수', fill('\\x41')],
    ['퍼센트 UTF-8(제로폭)', fill('%E2%80%8B')],
    ['퍼센트 UTF-8(한글)', fill('%ED%95%9C')],
    ['줄바꿈 base64', fill('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n')],
    ['두 겹(base64 안의 16진수)', fill(Buffer.from('41424344454647484950', 'utf8').toString('base64'))],
    ['낙타 표기 낱말(안쪽 대문자)', fill('getElementById ')],
  ])('%s', (_name, text) => {
    const started = performance.now();
    scanOutbound(plain(text), CTX);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  }, 30_000);

  it('서로 다른 6자리 숫자 1MB — 후보 상한에 닿아 scan_limit 으로 닫히고 예산 안에 끝난다', () => {
    const text = Array.from({ length: 150_000 }, (_, i) => String(100_000 + i)).join(' ').slice(0, MB);
    const started = performance.now();
    expect(scanOutbound(plain(text), CTX).families).toContain('scan_limit');
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  }, 30_000);

  it('모든 파트가 함께 1MB(상한 경계) — html·첨부까지 예산 안에 끝난다', () => {
    const quarter = MB / 4;
    const started = performance.now();
    scanOutbound(
      {
        subject: fill('sk-').slice(0, 1000),
        text: fill('1 2 ').slice(0, quarter),
        html: fill('<a ').slice(0, quarter),
        attachments: [{ text: fill('&#95;').slice(0, quarter) }, { text: fill('lorem ipsum ').slice(0, quarter) }],
      },
      CTX,
    );
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
