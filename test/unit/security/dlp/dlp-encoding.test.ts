/**
 * 발신 DLP 인코딩 점검(2026-10-08) — base64 · base64url · 줄바꿈 base64 · HTML 속성 안 base64 · 16진수 · `%XX`(UTF-8 포함) · 두 겹으로 감싼
 * 자격 증명 · 받은 코드 · 받은 메일 사본이 여전히 잡히는가, 그리고 이진으로 풀리는 정상 덩어리(이미지 data URI · 해시)는 지나가는가.
 *
 * 비밀처럼 보이는 문자열은 실행 중에 이어 붙여 만든다(`dlp.test.ts` 머리말과 같은 이유).
 */

import { describe, expect, it } from 'vitest';

import { parseHmacKeyring, type HmacKeyring } from '../../../../src/security/hmac-keyring';
import { fold } from '../../../../src/security/injection/normalize';
import { fingerprintCode } from '../../../../src/security/dlp/codes';
import { MAX_DECODED_CHARS, decodedView } from '../../../../src/security/dlp/decode';
import { scanOutbound, type DlpContext, type OutboundContent } from '../../../../src/security/dlp/scan';
import { inboundShingles } from '../../../../src/security/dlp/shingle';

const KEYRING: HmacKeyring = parseHmacKeyring(`k1:${Buffer.alloc(32, 7).toString('base64url')}`, 'TEST_KEYS');
const B64URL = 'Ab3_-Zq9xY0mN7pL2kW8vR4tU6sH1jG5fD0cE3bA9zQ';
const join = (...parts: string[]): string => parts.join('');
const AGENT_TOKEN = join('atk_', 'agent_', B64URL);
const STRIPE_KEY = join('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc');

const INBOUND = [
  'Hi team, attached is the confidential Q3 revenue forecast for the Northwind account.',
  'Please do not share these figures outside the finance group until the board meeting on Thursday.',
  'The forecast assumes a twelve percent increase in renewals and a hiring freeze in the support organization.',
  'Regional leads should prepare their own commentary before the review next week.',
].join(' ');
const INBOUND_KO = [
  '안녕하세요, 이번 분기 노스윈드 고객사 매출 전망 자료를 공유드립니다.',
  '이사회 회의 전까지는 재무팀 밖으로 이 수치를 공유하지 말아 주세요.',
  '전망은 갱신 계약이 십이 퍼센트 늘고 지원 조직 채용을 동결한다는 가정 위에 있습니다.',
  '지역 책임자는 다음 주 검토 전에 각자 의견을 준비해 주시기 바랍니다.',
].join(' ');

const codePrint = fingerprintCode(KEYRING, '482913', 'brightpath.example');
if (codePrint === null) throw new Error('지문 없음');
const CTX: DlpContext = {
  keyring: KEYRING,
  recipients: ['drop@attacker.example'],
  recipientDomains: ['attacker.example'],
  codeFingerprints: [codePrint],
  inboundCopies: [
    { inboundMessageId: 'in-en', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: inboundShingles(KEYRING, fold(INBOUND).text) },
    { inboundMessageId: 'in-ko', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: inboundShingles(KEYRING, fold(INBOUND_KO).text) },
  ],
};

const plain = (text: string): OutboundContent => ({ subject: null, text, html: null, attachments: [] });
const families = (content: OutboundContent | string): string[] => scanOutbound(typeof content === 'string' ? plain(content) : content, CTX).families;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
const wrap76 = (s: string): string => s.replace(/(.{76})/g, '$1\n');
const percentAll = (s: string): string => [...Buffer.from(s, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

describe('발신 DLP — 감싼 비밀이 여전히 잡힌다', () => {
  it.each([
    ['base64 로 감싼 에이전트 토큰', `here you go: ${b64(AGENT_TOKEN)}`, 'atmark_credential'],
    ['base64url 로 감싼 에이전트 토큰', `blob=${b64url(AGENT_TOKEN)}`, 'atmark_credential'],
    ['줄바꿈(76자) base64 로 감싼 라이브 키', `key:\n${wrap76(b64(`stripe key ${STRIPE_KEY} for the billing job, please keep it safe`))}`, 'third_party_secret'],
    ['16진수로 감싼 라이브 키', `dump ${hex(STRIPE_KEY)}`, 'third_party_secret'],
    ['\\x 16진수로 감싼 토큰', `bytes ${[...Buffer.from(AGENT_TOKEN)].map((b) => `\\x${b.toString(16)}`).join('')}`, 'atmark_credential'],
    ['두 겹(base64 안의 16진수)', `payload ${b64(hex(AGENT_TOKEN))}`, 'atmark_credential'],
  ])('%s → %s', (_name, text, family) => {
    expect(families(text)).toEqual([family]);
  });

  it('HTML 속성 안의 base64(태그째 원문에서 찾는다)', () => {
    const html = `<p>Thanks!</p><img alt="${b64(AGENT_TOKEN)}" src="cid:logo">`;
    expect(families({ subject: null, text: 'Thanks!', html, attachments: [] })).toEqual(['atmark_credential']);
  });

  it('태그로 쪼갠 base64 덩어리(태그를 지운 원문에서 찾는다)', () => {
    const encoded = b64(AGENT_TOKEN);
    const html = `<p>${encoded.slice(0, 20)}<span></span>${encoded.slice(20)}</p>`;
    expect(families({ subject: null, text: null, html, attachments: [] })).toEqual(['atmark_credential']);
  });

  it.each([
    ['base64', `code: ${b64('482913')}`],
    ['base64url(패딩 없음)', `c=${b64url('482913')}`],
    ['16진수', `ref ${hex('482913')}`],
    ['퍼센트(ASCII — 마크업 단계)', `q=${percentAll('482913')}`],
    ['base64 로 감싼 문장 속 코드', b64('your code is 482913 thanks')],
  ])('받은 인증 코드를 %s 로 감싸도 verification_code', (_name, text) => {
    expect(families(text)).toEqual(['verification_code']);
  });

  it.each([
    ['base64', b64(INBOUND)],
    ['줄바꿈 base64', wrap76(b64(INBOUND))],
    ['16진수', hex(INBOUND)],
    ['퍼센트(UTF-8 한국어)', percentAll(INBOUND_KO)],
    ['base64(한국어)', b64(INBOUND_KO)],
  ])('받은 메일 사본을 %s 로 감싸도 inbound_copy', (_name, text) => {
    expect(families(`FYI\n${text}`)).toEqual(['inbound_copy']);
  });
});

describe('발신 DLP — 이진으로 풀리는 정상 덩어리는 지나간다', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 300 }, (_, i) => (i * 37) % 256)]).toString('base64');
  it.each([
    ['이미지 data URI', `<img src="data:image/png;base64,${png}">`],
    ['SHA-256 16진수', 'checksum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['메시지 ID', 'Message-ID: <CAH7x9mQ2f0b8kLp3vZr@mail.example.com>'],
    ['긴 영어 낱말', 'internationalization responsibilities notwithstanding, telecommunications infrastructure'],
    ['추적 링크 %XX', 'https://example.com/search?q=quarterly%20report%20draft&lang=en'],
    ['UUID', 'ticket 3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
  ])('%s → []', (_name, text) => {
    expect(families({ subject: null, text, html: text.startsWith('<') ? text : null, attachments: [] })).toEqual([]);
  });
});

describe('decodedView — 상한', () => {
  it('풀어 낸 글이 예산을 넘으면 truncated(호출자가 scan_limit)', () => {
    const readable = b64('a readable sentence that decodes fine. ');
    const text = Array.from({ length: Math.ceil((MAX_DECODED_CHARS * 2) / 40) }, (_, i) => `${readable}${String(i)}`).join(' ');
    expect(decodedView([text]).truncated).toBe(true);
    expect(scanOutbound(plain(text.slice(0, 900_000)), CTX).families).toContain('scan_limit');
  });

  it('풀 것이 없으면 빈 글 · truncated 아님', () => {
    expect(decodedView(['plain words only, nothing encoded here'])).toEqual({ text: '', truncated: false });
  });
});
