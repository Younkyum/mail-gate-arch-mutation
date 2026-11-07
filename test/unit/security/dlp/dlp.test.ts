/**
 * 발신 DLP(`src/security/dlp/**`, ADR-0016 B) — 참 양성 · 거짓 양성 표.
 *
 * 비밀처럼 보이는 문자열은 **실행 중에 이어 붙여** 만든다 — 저장소에 토큰 모양 리터럴이 그대로 있으면 push 보호·비밀 스캐너가 이 파일을
 * 유출로 읽는다(그리고 그것이 옳다).
 */

import { describe, expect, it } from 'vitest';

import { parseHmacKeyring, type HmacKeyring } from '../../../../src/security/hmac-keyring';
import { fold } from '../../../../src/security/injection/normalize';
import {
  fingerprintCode,
  fingerprintLink,
  foldDecimalDigits,
  isSecretToken,
  matchCodeFingerprints,
  normalizeVerificationCode,
  projectCodeCandidates,
  secretLinkTokens,
  type CodeFingerprint,
} from '../../../../src/security/dlp/codes';
import { normalizeMarkup } from '../../../../src/security/dlp/markup';
import { DLP_FAMILIES, MAX_OUTBOUND_SCAN_CHARS, scanOutbound, type DlpContext, type OutboundContent } from '../../../../src/security/dlp/scan';
import { detectSecretFamilies } from '../../../../src/security/dlp/secrets';
import { inboundCopyOverlap, inboundShingles, outboundShingles } from '../../../../src/security/dlp/shingle';

const KEYRING: HmacKeyring = parseHmacKeyring(`k1:${Buffer.alloc(32, 7).toString('base64url')}`, 'TEST_KEYS');
const ROTATED: HmacKeyring = parseHmacKeyring(
  `k2:${Buffer.alloc(32, 9).toString('base64url')},k1:${Buffer.alloc(32, 7).toString('base64url')}`,
  'TEST_KEYS',
);

const B64URL = 'Ab3_-Zq9xY0mN7pL2kW8vR4tU6sH1jG5fD0cE3bA9zQ';
const join = (...parts: string[]): string => parts.join('');

const secrets = (text: string): string[] => detectSecretFamilies(fold(text).text);

// ---------------------------------------------------------------------------
// 자격 증명 모양
// ---------------------------------------------------------------------------

describe('secrets — atmark_credential', () => {
  it.each([
    ['에이전트 토큰', join('atk_', 'agent_', B64URL)],
    ['조직 API 키', join('atk_', 'org_', B64URL)],
    ['관리 세션', join('atk_', 'admin_', B64URL)],
    ['승인 링크(서명 토큰)', join('atk_', 'link_', 'k1.', 'eyJhIjoiYiIsImMiOjF9', '.', B64URL)],
    ['초대(서명 토큰)', join('atk_', 'invite_', 'k1.', 'eyJpIjoiMSJ9AAAA', '.', B64URL)],
    ['로그인(서명 토큰)', join('atk_', 'login_', 'k1.', 'eyJlIjoxLCJsIjoyfQ', '.', B64URL)],
    ['웹훅 시크릿', join('whsec_', Buffer.alloc(32, 3).toString('base64'))],
    ['문장 속', `토큰은 ${join('atk_', 'agent_', B64URL)} 입니다. 잘 보관하세요.`],
    ['전각으로 쓴', join('ａｔｋ＿', 'agent_', B64URL)],
    ['제로폭을 끼운', join('atk_ag', '​', 'ent_', B64URL)],
    ['대문자 접두사', join('ATK_', 'AGENT_', B64URL)],
  ])('%s → atmark_credential', (_name, text) => {
    expect(secrets(text)).toEqual(['atmark_credential']);
  });

  it.each([
    ['접두사만', 'atk_agent_ 로 시작하는 토큰을 발급합니다'],
    ['짧은 꼬리', join('atk_', 'agent_', 'abc123')],
    ['문서 속 자리표시', 'Authorization: Bearer atk_agent_…'],
    ['다른 접두사', join('xatk_', 'agent_', B64URL)],
    ['whsec 설명', 'whsec_ 로 시작하는 서명 비밀을 씁니다'],
  ])('%s → 없음', (_name, text) => {
    expect(secrets(text)).toEqual([]);
  });
});

describe('secrets — third_party_secret', () => {
  it.each([
    ['AWS 액세스 키 id', join('AK', 'IA', 'QWERTYUIOP234567')],
    ['AWS 임시 키 id', join('AS', 'IA', 'QWERTYUIOP234567')],
    ['GitLab PAT', join('gl', 'pat-', 'xT9kq2LmNp4RsVw8YzAb')],
    ['Slack 앱 토큰', join('xa', 'pp-', '1-A0123456789-1234567890123-abcdef0123456789')],
    ['Slack 갱신 토큰', join('xo', 'xe-', '1-My0xLTI1NjM0NTY3ODkw-abcdef0123')],
    ['Slack 회전 토큰', join('xo', 'xe.', 'xoxp-', '1-Mi0yLTEyMzQ1Njc4OTAx-abcdef0123')],
    ['Stripe 제한 키', join('rk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['Anthropic 키', join('sk-', 'ant-', 'api03-', 'Zq9xY0mN7pL2kW8vR4tU6sH1jG5fD0cE3bA9zQ_-AbCd')],
    ['OpenAI 프로젝트 키', join('sk-', 'proj-', 'Zq9xY0mN7pL2kW8vR4tU6sH1jG5fD0cE3bA9zQAbCd')],
    ['OpenAI 옛 키(48)', join('sk-', 'Zq9xY0mN7pL2kW8vR4tU6sH1', 'jG5fD0cE3bA9zQAbCdEfGhIj')],
    ['Google API 키', join('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')],
    ['GitHub 고전 토큰', join('gh', 'p_', 'a'.repeat(20), 'B'.repeat(16))],
    ['GitHub 세밀 PAT', join('github', '_pat_', '1'.repeat(22), '_', 'x'.repeat(59))],
    ['Slack 봇 토큰', join('xo', 'xb-', '123456789012-', '1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx')],
    ['Stripe 라이브 키', join('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['PEM 개인 키', join('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA')],
    ['PEM OPENSSH', join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')],
    ['JWT', join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
  ])('%s → third_party_secret', (_name, text) => {
    expect(secrets(text)).toEqual(['third_party_secret']);
  });

  it.each([
    ['Stripe 테스트 키', join('sk_', 'test_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['공개 키 머리', '-----BEGIN PUBLIC KEY-----'],
    ['인증서', '-----BEGIN CERTIFICATE-----'],
    ['AKIA 로 시작하는 낱말', 'AKIASHORT'],
    ['xoxo 인사', 'xoxo, see you soon'],
    ['eyJ 한 마디', 'eyJhbGciOiJIUzI1NiJ9 only'],
    ['한국어 산문', '다음 주 회의 자료를 첨부합니다. 비밀번호는 따로 전화로 알려 드릴게요.'],
    ['git 커밋 해시', 'fixed in 3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
    ['ASIA 대륙', 'Asia-Pacific region launch'],
    ['sk- 로 시작하는 낱말', 'sk-learn and sk-ip are packages'],
    ['sk- + 47자(옛 키보다 짧다)', join('sk-', 'a'.repeat(47))],
    ['sk- + 49자(옛 키보다 길다)', join('sk-', 'a'.repeat(49))],
    ['아이자와(Aizawa) 이름', 'Aizawa-san will join the call'],
    ['glpat 설명', 'glpat- 로 시작하는 토큰'],
    ['xapp 낱말', 'xapp-store is a codename'],
    ['Stripe 공개 키', join('pk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')],
  ])('%s → 없음', (_name, text) => {
    expect(secrets(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 인증 코드 지문
// ---------------------------------------------------------------------------

describe('codes — 정규형과 후보 투영', () => {
  it.each([
    ['482913', '482913'],
    ['482-913', '482913'],
    ['４８２９１３', '482913'],
    ['BP-5521-KQ', 'bp5521kq'],
    ['٤٨٢٩١٣', '482913'],
    ['४८२९१३', '482913'],
    ['abcd', null],
    ['123', null],
    ['1234567890123', null],
  ])('normalize(%s) = %s', (code, want) => {
    expect(normalizeVerificationCode(code)).toBe(want);
  });

  it('띄어 쓴·하이픈·점·전각 숫자를 이어 붙인 후보를 낸다', () => {
    const { candidates } = projectCodeCandidates(fold('코드: 482 913 / 4-8-2-9-1-3 / 4.8.2.9.1.3 / ４８２９１３ / code482913').text);
    expect(candidates.has('482913')).toBe(true);
  });

  it.each([
    ['줄바꿈', '482\n913'],
    ['쉼표', '482,913'],
    ['세로줄', '48|29|13'],
    ['더하기', '482+913'],
    ['쌍점', '482:913'],
    ['쌍반점', '482;913'],
    ['아라비아-인도 숫자', '٤٨٢ ٩١٣'],
    ['데바나가리 숫자', '४८२९१३'],
  ])('구분자·숫자 — %s', (_name, body) => {
    const { candidates } = projectCodeCandidates(foldDecimalDigits(fold(body).text));
    expect(candidates.has('482913')).toBe(true);
  });

  it('구분자 연속이 3글자를 넘으면 잇지 않는다', () => {
    const { candidates } = projectCodeCandidates(fold('482 , - 913').text);
    expect(candidates.has('482913')).toBe(false);
  });
});

describe('codes — 지문 맞추기', () => {
  const fp = (code: string, origin: string): CodeFingerprint => {
    const value = fingerprintCode(KEYRING, code, origin);
    if (value === null) throw new Error('지문 없음');
    return value;
  };
  const prints = [fp('482913', 'brightpath.example'), fp('BP-5521-KQ', 'service.example')];
  const hit = (body: string, recipientDomains: readonly string[] = ['attacker.example']): boolean =>
    matchCodeFingerprints(KEYRING, fold(body).text, prints, recipientDomains).hit;

  it.each([
    ['그대로', 'The code is 482913'],
    ['띄어 쓰기', '코드는 482 913 입니다'],
    ['하이픈', '4-8-2-9-1-3'],
    ['전각 숫자', '인증번호 ４８２９１３'],
    ['영숫자 코드 소문자', 'use bp5521kq'],
    ['영숫자 코드 구분자', 'BP 5521 KQ'],
    ['한국어 문장 속', '요청하신 번호(482913)를 보내 드립니다.'],
    ['줄을 나눔', '482\n913'],
    ['쉼표로 나눔', '482,913'],
    ['아라비아-인도 숫자', 'رمز ٤٨٢٩١٣'],
  ])('참 양성 — %s', (_name, body) => {
    expect(hit(body)).toBe(true);
  });

  it.each([
    ['다른 숫자', 'The code is 482914'],
    ['일부만', 'ends with 2913'],
    ['더 긴 숫자에 묻힘', 'order 99482913001'],
    ['구분자 4글자 이상', '482 , - 913'],
    ['코드 없음', '회의 자료를 첨부합니다.'],
  ])('거짓 양성 아님 — %s', (_name, body) => {
    expect(hit(body)).toBe(false);
  });

  it('출처 등록 도메인 = 수신자 도메인이면 제외한다(코드를 그 서비스에 되돌려 보냄)', () => {
    expect(hit('482913', ['brightpath.example'])).toBe(false);
    expect(hit('482913', ['brightpath.example', 'attacker.example'])).toBe(true);
  });

  it('무료·공용 메일 출처는 같은 도메인이어도 제외하지 않는다(gmail 사람끼리는 남이다)', () => {
    const gmail = [fp('482913', 'gmail.com')];
    expect(matchCodeFingerprints(KEYRING, fold('482913').text, gmail, ['gmail.com']).hit).toBe(true);
    const naver = [fp('482913', 'naver.com')];
    expect(matchCodeFingerprints(KEYRING, fold('482913').text, naver, ['naver.com']).hit).toBe(true);
  });

  it('키를 돌려도 이전 kid 지문을 맞춘다 · 묶음에 없는 kid 는 비교하지 못하고 그 수를 드러낸다', () => {
    expect(matchCodeFingerprints(ROTATED, fold('482913').text, prints, ['x.example']).hit).toBe(true);
    const orphan = { ...prints[0], kid: 'gone' } as CodeFingerprint;
    const result = matchCodeFingerprints(KEYRING, fold('482913').text, [orphan, prints[1] as CodeFingerprint], ['x.example']);
    expect(result.hit).toBe(false);
    expect(result.droppedFingerprints).toBe(1);
  });

  it('지문에 원문 코드가 없다', () => {
    expect(JSON.stringify(prints)).not.toContain('482913');
    expect(JSON.stringify(prints).toLowerCase()).not.toContain('bp5521kq');
  });
});

// ---------------------------------------------------------------------------
// 받은 메일 복사
// ---------------------------------------------------------------------------

const INBOUND_EN = [
  'Hi team, attached is the confidential Q3 revenue forecast for the Northwind account.',
  'Please do not share these figures outside the finance group until the board meeting on Thursday.',
  'The forecast assumes a twelve percent increase in renewals and a hiring freeze in the support organization.',
  'Contract values for the top five customers are listed in the second table, with renewal dates and discount terms.',
  'Let me know if any of the numbers look wrong before I send the final version to the auditors next week.',
].join(' ');

const INBOUND_KO = [
  '안녕하세요, 이번 분기 노스윈드 고객사 매출 전망 자료를 공유드립니다.',
  '이사회 회의 전까지는 재무팀 밖으로 이 수치를 공유하지 말아 주세요.',
  '전망은 갱신 계약이 십이 퍼센트 늘고 지원 조직 채용을 동결한다는 가정 위에 있습니다.',
  '상위 다섯 고객사의 계약 금액과 갱신일 할인 조건은 두 번째 표에 정리했습니다.',
  '다음 주 감사인에게 최종본을 보내기 전에 이상한 숫자가 있으면 알려 주세요.',
].join(' ');

describe('shingle — 받은 메일 복사', () => {
  const en = inboundShingles(KEYRING, fold(INBOUND_EN).text);
  const ko = inboundShingles(KEYRING, fold(INBOUND_KO).text);
  const copied = (inbound: readonly string[], body: string): boolean => {
    const set = outboundShingles(KEYRING, fold(body).text, ['k1']).byKid.get('k1') ?? new Set<string>();
    return inboundCopyOverlap(set, inbound);
  };

  it('지문은 256개 이하이고 원문 단어가 없다', () => {
    expect(en.fingerprints.length).toBeGreaterThan(4);
    expect(en.fingerprints.length).toBeLessThanOrEqual(256);
    expect(en.fingerprints.join(' ')).not.toMatch(/northwind|forecast/i);
  });

  it.each([
    ['통째로 전달', () => copied(en.fingerprints, `FYI see below\n\n${INBOUND_EN}`)],
    ['인용 표시(>)를 붙여 전달', () => copied(en.fingerprints, INBOUND_EN.split('. ').map((s) => `> ${s}`).join('.\n'))],
    ['대소문자·공백을 바꿔 전달', () => copied(en.fingerprints, INBOUND_EN.toUpperCase().replace(/ /g, '  '))],
    ['한국어 본문 전달', () => copied(ko.fingerprints, `참고로 아래 내용입니다.\n${INBOUND_KO}`)],
    ['전각으로 바꿔 전달', () => copied(ko.fingerprints, INBOUND_KO.replace(/[0-9a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)))],
  ])('참 양성 — %s', (_name, run) => {
    expect(run()).toBe(true);
  });

  it.each([
    ['다른 내용', () => copied(en.fingerprints, 'Thanks for the update. I will review the numbers tomorrow morning and get back to you.')],
    ['한 문장(8단어 남짓)만 인용', () => copied(en.fingerprints, `You wrote: "Please do not share these figures outside the finance group." Understood.`)],
    ['상투구', () => copied(ko.fingerprints, '문의 사항이 있으시면 언제든지 연락 주세요. 감사합니다.')],
  ])('거짓 양성 아님 — %s', (_name, run) => {
    expect(run()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 마크업 정규화
// ---------------------------------------------------------------------------

describe('markup — 태그·엔티티·퍼센트로 쪼갠 토큰', () => {
  const token = join('atk_', 'agent_', B64URL);
  it.each([
    ['빈 span 끼우기', join('atk_age', '<span></span>', 'nt_', B64URL.slice(0, 20), '<b>', B64URL.slice(20), '</b>')],
    ['주석 끼우기', join('atk_agent_', B64URL.slice(0, 10), '<!-- x -->', B64URL.slice(10))],
    ['숫자 엔티티', join('atk&#95;agent&#x5F;', B64URL)],
    ['이중 인코딩 엔티티', join('atk&amp;#95;agent_', B64URL)],
    ['퍼센트 인코딩', join('atk%5Fagent%5F', B64URL)],
  ])('%s → atmark_credential', (_name, html) => {
    expect(secrets(normalizeMarkup(html, ''))).toEqual(['atmark_credential']);
    expect(secrets(html)).toEqual([]); // 정규화 없이는 놓친다 — 이 단계가 무언가를 지킨다
  });

  it('태그를 공백으로 바꾸면 단어 경계를 지킨다', () => {
    expect(normalizeMarkup('<p>alpha</p><p>beta</p>', ' ').trim().split(/\s+/)).toEqual(['alpha', 'beta']);
    expect(normalizeMarkup('<p>alpha</p><p>beta</p>', '')).toBe('alphabeta');
  });

  it('부등호가 든 산문은 그대로 · 퍼센트 제어문자는 풀지 않는다', () => {
    expect(normalizeMarkup('3 < 5 and 7 > 2', '')).toBe('3 < 5 and 7 > 2');
    expect(normalizeMarkup('50%0A off', '')).toBe('50%0A off');
    expect(token.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// scanOutbound — 묶음
// ---------------------------------------------------------------------------

const plain = (text: string): OutboundContent => ({ subject: null, text, html: null, attachments: [] });
const families = (content: OutboundContent | string, ctx: DlpContext): string[] =>
  scanOutbound(typeof content === 'string' ? plain(content) : content, ctx).families;

describe('scanOutbound', () => {
  const codePrint = fingerprintCode(KEYRING, '482913', 'brightpath.example');
  if (codePrint === null) throw new Error('지문 없음');
  const inbound = inboundShingles(KEYRING, fold(INBOUND_EN).text);
  const base: DlpContext = {
    keyring: KEYRING,
    recipients: ['someone@attacker.example'],
    recipientDomains: ['attacker.example'],
    codeFingerprints: [codePrint],
    inboundCopies: [{ inboundMessageId: 'in-1', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: inbound }],
  };

  it('계열은 닫힌 순서로, 중복 없이', () => {
    const body = `${join('atk_', 'agent_', B64URL)}\n${join('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc')}\ncode 482913\n${INBOUND_EN}`;
    expect(families(body, base)).toEqual(['atmark_credential', 'third_party_secret', 'verification_code', 'inbound_copy']);
    expect(DLP_FAMILIES).toEqual(['atmark_credential', 'third_party_secret', 'verification_code', 'secret_link', 'inbound_copy', 'scan_limit']);
  });

  it('깨끗한 본문(한국어) → []', () => {
    expect(families('안녕하세요, 다음 주 화요일 오후 3시에 뵙겠습니다. 주소는 서울시 중구 세종대로 110 입니다.', base)).toEqual([]);
  });

  it('제목 · html · text/* 첨부도 본다', () => {
    expect(families({ subject: `code 482913`, text: null, html: null, attachments: [] }, base)).toEqual(['verification_code']);
    expect(families({ subject: null, text: 'hi', html: `<p>${join('atk_', 'agent_', B64URL.slice(0, 9))}<i></i>${B64URL.slice(9)}</p>`, attachments: [] }, base)).toEqual(['atmark_credential']);
    expect(families({ subject: null, text: 'see attached', html: null, attachments: [{ text: INBOUND_EN }] }, base)).toEqual(['inbound_copy']);
  });

  it('읽지 못한 첨부 → scan_limit', () => {
    expect(families({ subject: null, text: 'see attached', html: null, attachments: [{ text: null }] }, base)).toEqual(['scan_limit']);
  });

  it('HTML 로 옮긴 받은 메일도 복사로 잡는다(태그는 단어 경계)', () => {
    const html = INBOUND_EN.split('. ').map((sentence) => `<p>${sentence}</p>`).join('');
    expect(families({ subject: null, text: null, html, attachments: [] }, base)).toEqual(['inbound_copy']);
  });

  it('인용 회신 제외 — 받은 메일을 **그 발신자에게** 인용해 답하면 inbound_copy 가 아니다', () => {
    const reply = `Thanks, noted.\n\nOn Mon, CFO wrote:\n${INBOUND_EN.split('. ').map((sentence) => `> ${sentence}`).join('.\n')}`;
    const toSender = { ...base, recipients: ['CFO@northwind.example'], recipientDomains: ['northwind.example'] };
    expect(families(reply, toSender)).toEqual([]);
  });

  it('N2 — 인용 체인 회신: 같은 발신자의 메일 여러 통을 인용해 그 사람에게 답해도 inbound_copy 가 아니다', () => {
    const older = inboundShingles(KEYRING, fold(INBOUND_KO).text);
    const ctx: DlpContext = {
      ...base,
      recipients: ['cfo@northwind.example'],
      recipientDomains: ['northwind.example'],
      inboundCopies: [
        { inboundMessageId: 'in-1', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: inbound },
        { inboundMessageId: 'in-0', senderAddress: 'CFO@northwind.example', threadId: null, threadParticipants: [], shingles: older },
      ],
    };
    const chain = `Got it.\n\n> ${INBOUND_EN}\n>\n>> ${INBOUND_KO}`;
    expect(families(chain, ctx)).toEqual([]);
  });

  it('N2 — 동료를 포함한 reply-all: 스레드 참여자가 없으면 inbound_copy', () => {
    const replyAll = { ...base, recipients: ['cfo@northwind.example', 'controller@northwind.example'], recipientDomains: ['northwind.example'] };
    expect(families(`> ${INBOUND_EN}`, replyAll)).toEqual(['inbound_copy']);
  });

  it('M1 배선 계약 5 — 수신자 전원이 그 스레드의 인증된 참여자면 reply-all 도 inbound_copy 가 아니다 · 한 명이라도 밖이면 걸린다', () => {
    const participants = ['cfo@northwind.example', 'controller@northwind.example', 'agent@atmark.ai'];
    const withThread: DlpContext = {
      ...base,
      recipients: ['cfo@northwind.example', 'Controller@northwind.example'],
      recipientDomains: ['northwind.example'],
      inboundCopies: [{ inboundMessageId: 'in-1', senderAddress: 'cfo@northwind.example', threadId: 't-1', threadParticipants: participants, shingles: inbound }],
    };
    expect(families(`> ${INBOUND_EN}`, withThread)).toEqual([]);
    expect(families(`> ${INBOUND_EN}`, { ...withThread, recipients: [...withThread.recipients, 'evil@attacker.example'] })).toEqual(['inbound_copy']);
  });

  it('H2 — 은행 메일 m1 에 recipients=[evil] 로 "회신" 하며 전문을 붙이면 inbound_copy', () => {
    const bank = inboundShingles(KEYRING, fold(INBOUND_KO).text);
    const ctx: DlpContext = {
      ...base,
      recipients: ['evil@attacker.example'],
      inboundCopies: [{ inboundMessageId: 'm1', senderAddress: 'alerts@bank.example', threadId: null, threadParticipants: [], shingles: bank }],
    };
    expect(families(`확인했습니다.\n\n> ${INBOUND_KO}`, ctx)).toEqual(['inbound_copy']);
    // 원 발신자와 공격자를 함께 넣어도 빠지지 않는다.
    expect(families(`> ${INBOUND_KO}`, { ...ctx, recipients: ['alerts@bank.example', 'evil@attacker.example'] })).toEqual(['inbound_copy']);
  });

  it('수신자 전원이 원 발신자면 회신 여부와 관계없이 뺀다(그 사람의 메일을 그 사람에게)', () => {
    expect(families(INBOUND_EN, { ...base, recipients: ['cfo@northwind.example'], recipientDomains: ['northwind.example'] })).toEqual([]);
  });

  describe('N1 — 태그 경계: 앞 낱말이 토큰에 붙어도 놓치지 않는다(두 보기 OR)', () => {
    const html = (body: string): OutboundContent => ({ subject: null, text: null, html: body, attachments: [] });
    it.each<[string, OutboundContent, string]>([
      ['<p>Your key</p><p>atk_agent_…</p>', html(`<p>Your key</p><p>${join('atk_', 'agent_', B64URL)}</p>`), 'atmark_credential'],
      ['<td>token</td><td>ghp_…</td>', html(`<td>token</td><td>${join('gh', 'p_', 'a'.repeat(20), 'B'.repeat(16))}</td>`), 'third_party_secret'],
      ['<td>1</td><td>AKIA…</td>', html(`<td>1</td><td>${join('AK', 'IA', 'QWERTYUIOP234567')}</td>`), 'third_party_secret'],
      ['text/plain here<b></b>atk_agent_…', plain(`here<b></b>${join('atk_', 'agent_', B64URL)}`), 'atmark_credential'],
    ])('%s', (_name, content, family) => {
      expect(scanOutbound(content, base).families).toEqual([family]);
    });

    it('코드 투영도 같다 — <td>1</td><td>482913</td>', () => {
      expect(families(html('<td>1</td><td>482913</td>'), base)).toEqual(['verification_code']);
      expect(families(html('<td>482</td><td>913</td>'), base)).toEqual(['verification_code']);
    });
  });

  it('코드를 출처 서비스에 회신 — 같은 등록 도메인은 제외', () => {
    expect(families('482913', { ...base, recipients: ['verify@brightpath.example'], recipientDomains: ['brightpath.example'] })).toEqual([]);
  });

  it('입력 상한을 넘으면 scan_limit(끝까지 보지 못한 본문을 깨끗하다고 하지 않는다)', () => {
    const big = 'a '.repeat(MAX_OUTBOUND_SCAN_CHARS / 2 + 10);
    expect(families(big, base)).toEqual(['scan_limit']);
  });

  it('상한 너머에 숨긴 비밀 — 앞부분 비밀은 잡고 scan_limit 도 낸다', () => {
    const big = `${join('atk_', 'agent_', B64URL)} ${'b'.repeat(MAX_OUTBOUND_SCAN_CHARS)}`;
    expect(families(big, base)).toEqual(['atmark_credential', 'scan_limit']);
  });

  it('키 묶음에 없는 kid 의 지문은 비교하지 못한 수로 드러난다', () => {
    const ctx: DlpContext = {
      ...base,
      codeFingerprints: [{ ...codePrint, kid: 'gone' }],
      inboundCopies: [{ inboundMessageId: 'in-1', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: { ...inbound, kid: 'gone' } }],
    };
    const result = scanOutbound(plain(`482913 ${INBOUND_EN}`), ctx);
    expect(result.families).toEqual([]);
    expect(result.droppedFingerprints).toBe(2);
  });
});

describe('scanOutbound — 제외를 얻으려고 수신자를 끼워 넣는 우회', () => {
  const codePrint = fingerprintCode(KEYRING, '482913', 'brightpath.example');
  if (codePrint === null) throw new Error('지문 없음');
  const inbound = inboundShingles(KEYRING, fold(INBOUND_EN).text);
  const ctx: DlpContext = {
    keyring: KEYRING,
    recipients: ['cfo@northwind.example', 'verify@brightpath.example', 'drop@attacker.example'],
    recipientDomains: ['northwind.example', 'brightpath.example', 'attacker.example'],
    codeFingerprints: [codePrint],
    inboundCopies: [{ inboundMessageId: 'in-1', senderAddress: 'cfo@northwind.example', threadId: null, threadParticipants: [], shingles: inbound }],
  };

  it('출처 서비스·원 발신자와 공격자를 함께 넣어도 잡는다', () => {
    expect(families(`482913\n${INBOUND_EN}`, ctx)).toEqual(['verification_code', 'inbound_copy']);
  });
});

// ---------------------------------------------------------------------------
// 비밀 링크(재검증 N2) — 재설정·로그인 링크의 URL 토큰
// ---------------------------------------------------------------------------

/** 재설정 토큰 모양(실행 중에 이어 붙인다). */
const RESET_TOKEN = join('Xq7', 'Lm2pR9', 'tZ4vB8', 'nK1wY6');

describe('codes — 비밀 링크 토큰의 기준', () => {
  it.each([
    ['base64url(대소문자 섞임)', RESET_TOKEN, true],
    ['16진수', '9f86d081884c7d659a2feaa0c55ad015', true],
    ['UUID', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', true],
    ['소문자 + 숫자, 글자 연속 4자 이하', 'ab12cd34ef56gh78ij90', true],
    ['사람이 쓴 경로(낱말)', '2024-annual-report-summary', false],
    ['숫자만', '1234567890123456', false],
    ['15자', 'Ab3Xq7Lm2pR9tZ4', false],
    ['낱말만', 'unsubscribe-from-newsletter', false],
  ])('%s → %s', (_name, run, want) => {
    expect(isSecretToken(run)).toBe(want);
  });

  it('URL 의 호스트 뒤(경로 · 쿼리 · 조각)만 본다 · 소문자 · 중복 없음 · URL 밖 문자열은 보지 않는다', () => {
    const text = [
      `Reset your password: https://accounts.brightpath.example/reset?token=${RESET_TOKEN}&utm=mail`,
      `(https://accounts.brightpath.example/r/${RESET_TOKEN})`,
      'Read more: https://news.example/2024-annual-report-summary',
      `Not a link: ${join('Zz9', 'Yy8Xx7', 'Ww6Vv5Uu4')}`,
      'https://9f86d081884c7d659a2feaa0c55ad015.cdn.example/logo.png',
    ].join('\n');
    expect(secretLinkTokens(text)).toEqual([RESET_TOKEN.toLowerCase()]);
  });

  it('R1 — 대소문자 섞임이 근거인 base64url 토큰도 지문이 남는다(모양은 원래 대소문자로 한 번만 본다)', () => {
    const token = join('Zx8Qw', 'ErTyUiOp3', 'AsDfGhJkL9');
    expect(isSecretToken(token)).toBe(true);
    expect(isSecretToken(token.toLowerCase())).toBe(false); // 소문자로는 모양 근거가 사라진다 — 그래서 다시 판정하면 안 된다
    const [found] = secretLinkTokens(`https://share.example/s/${token}`);
    expect(found).toBe(token.toLowerCase());
    const print = fingerprintLink(KEYRING, found ?? '', 'share.example');
    expect(print).not.toBeNull();
    const ctx: DlpContext = { keyring: KEYRING, recipients: ['drop@attacker.example'], recipientDomains: ['attacker.example'], codeFingerprints: print === null ? [] : [print], inboundCopies: [] };
    expect(scanOutbound(plain(`see https://share.example/s/${token}`), ctx).families).toEqual(['secret_link']);
  });

  it('지문에 원문 토큰이 없다 · 코드 지문과 서명 문맥이 다르다', () => {
    const print = fingerprintLink(KEYRING, RESET_TOKEN, 'brightpath.example');
    expect(print).not.toBeNull();
    expect(JSON.stringify(print)).not.toContain(RESET_TOKEN.toLowerCase());
    expect(fingerprintLink(KEYRING, 'too-short-1', 'brightpath.example')).toBeNull();
  });
});

describe('scanOutbound — 비밀 링크(재검증 N2 ② · secret_link)', () => {
  const linkPrint = fingerprintLink(KEYRING, RESET_TOKEN.toLowerCase(), 'brightpath.example');
  if (linkPrint === null) throw new Error('지문 없음');
  const ctx: DlpContext = {
    keyring: KEYRING,
    recipients: ['drop@attacker.example'],
    recipientDomains: ['attacker.example'],
    codeFingerprints: [linkPrint],
    inboundCopies: [],
  };

  it.each<[string, OutboundContent]>([
    ['본문에 링크 그대로', plain(`here: https://accounts.brightpath.example/reset?token=${RESET_TOKEN}`)],
    ['토큰만', plain(`token ${RESET_TOKEN}`)],
    ['href 속(태그를 걷은 보기에는 없다)', { subject: null, text: null, html: `<a href="https://x.example/?t=${RESET_TOKEN}">click</a>`, attachments: [] }],
    ['태그로 쪼갠', { subject: null, text: null, html: `${RESET_TOKEN.slice(0, 9)}<span></span>${RESET_TOKEN.slice(9)}`, attachments: [] }],
  ])('%s → secret_link', (_name, content) => {
    expect(scanOutbound(content, ctx).families).toEqual(['secret_link']);
  });

  it('같은 서비스(등록 도메인)로 되돌리면 제외 · 토큰이 없으면 걸리지 않는다', () => {
    expect(scanOutbound(plain(RESET_TOKEN), { ...ctx, recipients: ['help@brightpath.example'], recipientDomains: ['brightpath.example'] }).families).toEqual([]);
    expect(scanOutbound(plain('Thanks, I reset my password.'), ctx).families).toEqual([]);
  });
});

describe('scanOutbound — 수신자를 바꾼 회신의 대상 메일(재검증 N2 ①)', () => {
  const short = `Reset: https://accounts.brightpath.example/r/${RESET_TOKEN}`;
  const linkPrint = fingerprintLink(KEYRING, RESET_TOKEN, '');
  if (linkPrint === null) throw new Error('지문 없음');
  const source = {
    inboundMessageId: 'reset-1',
    senderAddress: 'no-reply@brightpath.example',
    threadId: 't-1',
    threadParticipants: [],
    shingles: inboundShingles(KEYRING, fold(short).text),
    secrets: [linkPrint],
  };
  const ctx: DlpContext = {
    keyring: KEYRING,
    recipients: ['drop@attacker.example'],
    recipientDomains: ['attacker.example'],
    codeFingerprints: [],
    inboundCopies: [source],
  };

  it('짧은 메일(8-gram 지문 없음)의 토큰을 붙이면 inbound_copy', () => {
    expect(source.shingles.fingerprints.length).toBeLessThan(4);
    expect(scanOutbound(plain(`> ${short}`), ctx).families).toEqual(['inbound_copy']);
  });

  it('원 발신자에게 되돌리거나 토큰이 없으면 걸리지 않는다', () => {
    expect(scanOutbound(plain(`> ${short}`), { ...ctx, recipients: ['no-reply@brightpath.example'], recipientDomains: ['brightpath.example'] }).families).toEqual([]);
    expect(scanOutbound(plain('Done.'), ctx).families).toEqual([]);
  });
});
