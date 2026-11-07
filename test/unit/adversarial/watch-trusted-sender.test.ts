/**
 * 적대적 검증 A-1 (순수 함수 단) — 신뢰 발신자 항목 파서 · 일치 규칙 · 오염 등급의 우회 규칙.
 * 표의 한 줄 = 시도 하나.
 */

import { describe, expect, it } from 'vitest';

import { classifyInboundLevel } from '../../../src/security/levels';
import { classifyTaint, type ExposureField, type TaintInput } from '../../../src/security/taint';
import { matchesTrustedSender, MAX_TRUSTED_SENDERS, parseTrustedSender, type TrustedSender } from '../../../src/watch/settings';

// ---------------------------------------------------------------------------
// 파서 — 콘솔이 넣은 한 줄
// ---------------------------------------------------------------------------

const REJECTED: [id: string, name: string, input: string][] = [
  ['U-001', '빈 문자열', ''],
  ['U-002', '공백만', '   \t '],
  ['U-003', '와일드카드 *', '*'],
  ['U-004', '와일드카드 *.도메인', '*.partner.example'],
  ['U-005', '와일드카드 *@도메인', '*@partner.example'],
  ['U-006', '로컬파트 와일드카드 ce*@', 'ce*@partner.example'],
  ['U-007', '@도메인(로컬파트 없음)', '@partner.example'],
  ['U-008', '로컬파트만 ceo@', 'ceo@'],
  ['U-009', '이중 @', 'a@@partner.example'],
  ['U-010', '세 번째 @', 'a@b@partner.example'],
  ['U-011', '로컬파트에 공백', 'a b@partner.example'],
  ['U-012', '라벨 하나(tld 없음)', 'partner'],
  ['U-013', '끝 점', 'partner.example.'],
  ['U-014', '앞 점', '.partner.example'],
  ['U-015', '빈 라벨 ..', 'partner..example'],
  ['U-016', '밑줄 라벨', 'part_ner.example'],
  ['U-017', '하이픈으로 시작', '-partner.example'],
  ['U-018', '하이픈으로 끝', 'partner-.example'],
  ['U-019', '라벨 64자', `${'a'.repeat(64)}.example`],
  ['U-020', '로컬파트 65자', `${'a'.repeat(65)}@partner.example`],
  ['U-021', '전체 321자 이상', `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.${'f'.repeat(30)}.example`],
  ['U-022', '키릴 동형 도메인', 'pаrtner.example'],
  ['U-023', '전각 도메인', 'ｐartner.example'],
  ['U-024', '한글 도메인(비 punycode)', '파트너.example'],
  ['U-025', '개행이 낀 도메인', 'partner.example\nevil.example'],
  ['U-026', 'NUL 이 낀 도메인', 'partner.example\u0000'],
  ['U-027', 'SQL 조각', "partner.example'; DROP TABLE org_trusted_senders;--"],
  ['U-028', 'SQL 조각 주소', "x'--@partner.example\u0000"],
  ['U-029', '제어문자(탭) 낀 로컬파트', 'ce\to@partner.example'],
  ['U-030', 'TLD 한 글자', 'a@b.c'],
  ['U-031', '숫자 TLD', 'a@b.123'],
  ['U-032', 'IP 리터럴', 'ceo@[203.0.113.9]'],
  ['U-033', '도메인 자리에 IP', '203.0.113.9'],
  ['U-034', 'localhost', 'localhost'],
  ['U-035', '경로 포함', 'partner.example/path'],
  ['U-036', 'URL', 'https://partner.example'],
  ['U-037', '포트 포함', 'partner.example:25'],
  ['U-038', '쉼표로 두 개', 'ceo@partner.example,evil@x.example'],
  ['U-039', '세미콜론 두 개', 'ceo@partner.example;evil@x.example'],
  ['U-040', '표시 이름 포함 꺾쇠 형식', 'CEO <ceo@partner.example>'],
  ['U-041', '따옴표 로컬파트 공백', '"a b"@partner.example'],
  ['U-042', '비 ASCII 로컬파트의 제어문자(U+0085)', 'ce\u0085o@partner.example'],
  ['U-043', 'U+2028 줄 구분자 낀 로컬파트', 'ce o@partner.example'],
  ['U-044', '라벨 사이 공백', 'partner .example'],
  ['U-045', '매우 긴 입력(100KB)', 'a'.repeat(100_000)],
  ['U-046', '점만', '...'],
  ['U-047', '하이픈만 TLD xn-- 접두 오류(xn-- 뒤 비어 있음)', 'partner.xn--'],
  // 고침(2026-10-08) — 비 ASCII 입력은 받지 않는다(켈빈 기호가 소문자 접기로 k 가 되는 충돌을 항목에도 막는다 — 예전에는 받아 kbank.example 로 접었다).
  ['U-053', '켈빈 기호(비 ASCII) 도메인 — 접기 충돌이라 거부', 'Kbank.example'],
  ['U-048', '도메인 전체 254자', `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(10)}.example`],
];

const ACCEPTED: [id: string, name: string, input: string, expected: TrustedSender][] = [
  ['U-049', '앞뒤 공백 · 대문자는 접는다', '  Partner.Example  ', { kind: 'domain', value: 'partner.example' }],
  ['U-050', '주소의 대문자는 접는다', 'CEO@Partner.Example', { kind: 'address', value: 'ceo@partner.example' }],
  ['U-051', '플러스 태그 주소는 그대로(태그 제거 안 함)', 'ceo+tag@partner.example', { kind: 'address', value: 'ceo+tag@partner.example' }],
  ['U-052', 'punycode 도메인은 정당한 입력', 'xn--prtner-t9a.example', { kind: 'domain', value: 'xn--prtner-t9a.example' }],
];

/** 알려진 취약 — 보안 기대는 그대로 두고 이름에 `VULN:` 을 붙인다(보고서 참조). */
const VULN_IDS: ReadonlySet<string> = new Set(['U-005', 'U-006', 'U-071', 'U-080', 'U-081']);
const tag = (id: string): string => (VULN_IDS.has(id) ? 'VULN: ' : '');

describe('A-1 신뢰 발신자 파서', () => {
  it.each(REJECTED.map((r) => [`${tag(r[0])}[${r[0]}] 거부: ${r[1]}`, r[2]] as const))('%s', (_title, input) => {
    expect(parseTrustedSender(input)).toBeNull();
  });
  it.each(ACCEPTED)('[%s] 허용 · 정규화: %s', (_id, _name, input, expected) => {
    expect(parseTrustedSender(input)).toEqual(expected);
  });
  it('[U-054] 상한 상수는 200 (DB 트리거 · 정의자 함수와 같은 값)', () => {
    expect(MAX_TRUSTED_SENDERS).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 일치 규칙
// ---------------------------------------------------------------------------

const DOMAIN: TrustedSender = { kind: 'domain', value: 'partner.example' };
const ADDRESS: TrustedSender = { kind: 'address', value: 'ceo@partner.example' };

const MATCH_FALSE: [id: string, name: string, entries: TrustedSender[], address: string, authenticated: boolean][] = [
  ['U-055', 'DMARC 미인증 + 도메인 일치', [DOMAIN], 'ceo@partner.example', false],
  ['U-056', 'DMARC 미인증 + 주소 일치', [ADDRESS], 'ceo@partner.example', false],
  ['U-057', '빈 목록', [], 'ceo@partner.example', true],
  ['U-058', '하위 도메인', [DOMAIN], 'ceo@mail.partner.example', true],
  ['U-059', '상위 도메인 항목이 아닌 더 긴 도메인', [{ kind: 'domain', value: 'mail.partner.example' }], 'ceo@partner.example', true],
  ['U-060', '접두 붙이기', [DOMAIN], 'ceo@xpartner.example', true],
  ['U-061', '접미 붙이기', [DOMAIN], 'ceo@partner.example.evil.com', true],
  ['U-062', '끝 점', [DOMAIN], 'ceo@partner.example.', true],
  ['U-063', '주소 항목 vs 다른 로컬파트', [ADDRESS], 'cfo@partner.example', true],
  ['U-064', '주소 항목 vs 플러스 태그', [ADDRESS], 'ceo+x@partner.example', true],
  ['U-065', '주소 항목 vs 점 변형', [ADDRESS], 'c.eo@partner.example', true],
  ['U-066', '@ 없는 주소', [DOMAIN], 'partner.example', true],
  ['U-067', '로컬파트 없는 주소(@ 맨 앞)', [DOMAIN], '@partner.example', true],
  ['U-068', '빈 주소', [DOMAIN], '', true],
  ['U-069', '도메인 항목이 로컬파트에 있다', [DOMAIN], 'partner.example@evil.example', true],
  ['U-070', '이중 @ — lastIndexOf 가 뒤를 본다', [DOMAIN], 'ceo@partner.example@evil.example', true],
  ['U-071', '이중 @ — 뒤가 신뢰 도메인(로컬파트에 @ 낀 주소는 서면 안 된다)', [DOMAIN], 'ceo@evil.example@partner.example', true],
  ['U-072', '따옴표 로컬파트에 @ (앞뒤 모두 신뢰)', [ADDRESS], '"ceo@partner.example"@partner.example', true],
  ['U-073', '키릴 동형', [DOMAIN], 'ceo@pаrtner.example', true],
  ['U-074', '전각', [DOMAIN], 'ceo@ｐartner.example', true],
  ['U-075', '공백이 낀 도메인', [DOMAIN], 'ceo@partner .example', true],
  ['U-076', '도메인 항목이 주소 종류 값으로 잘못 들어온 경우(종류 혼동 — 주소 항목에 도메인 문자열)', [{ kind: 'address', value: 'partner.example' }], 'ceo@partner.example', true],
  ['U-077', '주소 종류 항목이 도메인 종류로 들어온 경우(DB CHECK 가 막는 값 — 순수 함수는 우연히 서지 않아야)', [{ kind: 'domain', value: 'ceo@partner.example' }], 'ceo@partner.example', true],
  ['U-078', '항목 값이 대문자(저장소가 소문자만 보장 — 대문자 항목은 서지 않는다)', [{ kind: 'domain', value: 'PARTNER.EXAMPLE' }], 'ceo@partner.example', true],
  ['U-079', '제로폭 공백 낀 도메인', [DOMAIN], 'ceo@part​ner.example', true],
  ['U-080', '켈빈 기호 도메인 vs 항목 kbank.example(소문자 접기 충돌 — 서면 안 된다)', [{ kind: 'domain', value: 'kbank.example' }], 'ceo@Kbank.example', true],
  ['U-081', '켈빈 기호 로컬파트 vs 주소 항목', [{ kind: 'address', value: 'kevin@corp.example' }], 'Kevin@corp.example', true],
  ['U-082', '터키어 İ 도메인', [{ kind: 'domain', value: 'info.example' }], 'ceo@İnfo.example', true],
];

const MATCH_TRUE: [id: string, name: string, entries: TrustedSender[], address: string][] = [
  ['U-083', '대조: 도메인 일치', [DOMAIN], 'anyone@partner.example'],
  ['U-084', '대조: 주소 일치', [ADDRESS], 'ceo@partner.example'],
  ['U-085', '대조: 대문자 From', [DOMAIN], 'CEO@PARTNER.EXAMPLE'],
  ['U-086', '대조: 앞뒤 공백', [ADDRESS], '  ceo@partner.example '],
  ['U-087', '대조: 여러 항목 중 하나', [{ kind: 'domain', value: 'a.example' }, ADDRESS, { kind: 'domain', value: 'b.example' }], 'ceo@partner.example'],
];

describe('A-1 신뢰 발신자 일치 규칙', () => {
  it.each(MATCH_FALSE.map((r) => [`${tag(r[0])}[${r[0]}] 일치하지 않는다: ${r[1]}`, r[0], r[2], r[3], r[4]] as const))('%s', (_title, id, entries, address, authenticated) => {
    const result = matchesTrustedSender(entries, { fromAddress: address, fromAuthenticated: authenticated });
    // 켈빈 기호(U-080 · U-081) — 고친 뒤 소비자는 From 을 **접기 전 원문**으로 넘긴다(`inbound-consumer.ts` watchRecordOf 호출). 원문 그대로 본다.
    expect(result).toBe(false);
  });
  it.each(MATCH_TRUE)('[%s] %s', (_id, _name, entries, address) => {
    expect(matchesTrustedSender(entries, { fromAddress: address, fromAuthenticated: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 오염 등급 — 우회가 지우는 범위
// ---------------------------------------------------------------------------

function taint(overrides: Partial<TaintInput> & { field: ExposureField }): ReturnType<typeof classifyTaint> {
  return classifyTaint({
    surface: 'message_detail',
    injectionRisk: 'high',
    findings: [{ family: 'override', damped: false }],
    auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', fromAuthenticated: true },
    senderTrust: 'seen',
    trustedBypass: true,
    ...overrides,
  });
}

describe('A-1 오염 등급 — 우회의 범위', () => {
  it('[U-088] 대조: 우회 + 본문 + high → T2 가 아니다', () => {
    expect(taint({ field: 'body' })).not.toBe('T2');
  });
  it('[U-089] 우회 + 제목 + high → T2 가 아니다', () => {
    expect(taint({ field: 'subject', surface: 'message_list' })).not.toBe('T2');
  });
  it('[U-090] 우회 + 첨부 텍스트 + 첨부 판정 high → T2 (본문 우회가 첨부를 신뢰하지 않는다)', () => {
    expect(taint({ field: 'attachment_text', surface: 'attachment_content' })).toBe('T2');
  });
  it('[U-091] 우회 + 첨부 텍스트 + 판정 없음(null) → T2', () => {
    expect(taint({ field: 'attachment_text', surface: 'attachment_content', injectionRisk: null, findings: [] })).toBe('T2');
  });
  it('[U-092] 우회 + 첨부 텍스트 + low → T2', () => {
    expect(taint({ field: 'attachment_text', surface: 'attachment_content', injectionRisk: 'low', findings: [] })).toBe('T2');
  });
  it('[U-093] 우회 + 첨부 다운로드 URL(판정 없음) → T2', () => {
    expect(taint({ field: 'attachment_text', surface: 'attachment_url', injectionRisk: null, findings: [] })).toBe('T2');
  });
  it('[U-094] 우회 + 인증 코드 면 + 메일 high → T2', () => {
    expect(taint({ field: 'verification_code', surface: 'verification_code' })).toBe('T2');
  });
  it('[U-095] 우회 + 인증 코드 면 + DMARC fail → T2 (규칙 5)', () => {
    expect(
      taint({ field: 'verification_code', surface: 'verification_code', injectionRisk: 'none', findings: [], auth: { spf: 'pass', dkim: 'pass', dmarc: 'fail', fromAuthenticated: false } }),
    ).toBe('T2');
  });
  it('[U-096] 플래그만 있고 DMARC 미인증 → 우회가 서지 않아 T2', () => {
    expect(taint({ field: 'body', auth: { spf: 'pass', dkim: 'pass', dmarc: 'fail', fromAuthenticated: false } })).toBe('T2');
  });
  it('[U-097] 플래그만 있고 DMARC 미인증 + 제목 면 + 위험 low + 움직이는 계열 → T2', () => {
    expect(
      taint({ field: 'subject', surface: 'message_list', injectionRisk: 'low', auth: { spf: 'pass', dkim: 'pass', dmarc: 'none' as never, fromAuthenticated: false } }),
    ).toBe('T2');
  });
  it('[U-098] 풀린 메일은 우회와 겹쳐도 T2 (released 가 이긴다)', () => {
    expect(taint({ field: 'body', released: true })).toBe('T2');
  });
  it.each(['message_detail', 'message_list', 'thread', 'attachment_content', 'attachment_url', 'verification_code'] as const)(
    '[U-099/%s] 풀린 메일은 면 %s 에서도 T2',
    (surface) => {
      for (const field of ['body', 'subject', 'attachment_text', 'verification_code'] as const) {
        expect(taint({ field, surface, released: true, injectionRisk: 'none', findings: [] })).toBe('T2');
      }
    },
  );
  it('[U-100] 우회 없는 high 본문은 T2 (대조)', () => {
    expect(taint({ field: 'body', trustedBypass: false })).toBe('T2');
  });
  it('[U-101] 우회 + 본문 + 판정 low · 움직이는 계열 → T2 가 아니다(우회 = 메일 판정 무시)', () => {
    expect(taint({ field: 'body', injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }] })).not.toBe('T2');
  });
  it('[U-102] 우회 없는 low · narrative 본문은 T2 (대조)', () => {
    expect(taint({ field: 'body', trustedBypass: false, injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }] })).toBe('T2');
  });
});

// ---------------------------------------------------------------------------
// 등급 계산
// ---------------------------------------------------------------------------

describe('A-1 등급 계산 — 우회와 숨김', () => {
  const base = { quarantined: false, quarantineReason: null, injectionRisk: 'high' as const, findings: [{ family: 'override' as const, damped: false }], trustedBypass: true };
  it('[U-103] 우회 + 보임 → none · trustedBypass', () => {
    expect(classifyInboundLevel(base)).toMatchObject({ level: 'none', trustedBypass: true });
  });
  it('[U-104] 우회 + 판정 없음 격리(scanner_error) → block (우회가 지우지 못한다)', () => {
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'scanner_error', injectionRisk: null, findings: [] })).toMatchObject({ level: 'block', trustedBypass: false });
  });
  it('[U-105] 우회 + 정책 차단 → none · policyBlocked · trustedBypass 거짓', () => {
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'policy_blocked' })).toMatchObject({ level: 'none', policyBlocked: true, trustedBypass: false });
  });
  it('[U-106] 우회 + 인젝션 격리가 이미 걸린 행(우회가 안 선 경우) → block', () => {
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'injection_risk' })).toMatchObject({ level: 'block', trustedBypass: false });
  });
  it('[U-107] 우회 + 위험 보류 행 → risk (우회가 보류를 지우지 못한다)', () => {
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'risk_hold', injectionRisk: 'low' })).toMatchObject({ level: 'risk' });
  });
  it('[U-108] 우회 없는 보임 high(CHECK 가 막는 행) → block (fail closed)', () => {
    expect(classifyInboundLevel({ ...base, trustedBypass: false })).toMatchObject({ level: 'block' });
  });
  it('[U-109] 우회 없는 보임 + 판정 없음(null) → block (fail closed)', () => {
    expect(classifyInboundLevel({ ...base, trustedBypass: false, injectionRisk: null, findings: [] })).toMatchObject({ level: 'block' });
  });
  it('[U-110] 우회 + 보임 + 판정 없음(null) — 순수 함수는 우회를 신뢰한다(DB CHECK 가 이 조합을 막는다)', () => {
    // 비정상 조합. 등급 함수가 none 을 주더라도 DB 가 행을 거부하므로 도달할 수 없다(통합 시도 T1-D*).
    expect(classifyInboundLevel({ ...base, injectionRisk: null, findings: [] }).level).toBe('none');
  });
});
