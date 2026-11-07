/**
 * 고객 도메인 계약(`src/domains/contract.ts` · `src/billing/plans.ts` 도메인 칸) = 마이그레이션(202609291100 · 1110 · 1120)의 값(ADR-0014 단계 0).
 * 한쪽만 바꾸면 여기서 빨개진다. 실제 DB 동작(트리거 · 전이 · 권한)은 통합 테스트 `test/integration/db/custom-domains-triggers.test.ts` 가 본다.
 *
 *   - CHECK 목록(상태 · 정지 사유 · pending 사유 · 사가 · 제거 · SES 상태 · MX · 알림 종류) = 계약 유니온.
 *   - 전이 가드의 허용 쌍 = `CUSTOM_DOMAIN_TRANSITIONS`.
 *   - 코드 천장 함수 셋 = `CUSTOM_DOMAINS_CEILING` · `CUSTOM_DOMAIN_PENDING_MAX` · `CUSTOM_DOMAIN_ADDRESS_CEILING`.
 *   - SQLSTATE 가 마이그레이션에 있다 · 요금제 한도(J3) · 관문 접기 · 레코드 표 · 비활성 포트.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CUSTOM_DOMAIN_LIMITS, CUSTOM_DOMAIN_PENDING_MAX, CUSTOM_DOMAINS_CEILING, customDomainLimitOf, PLAN_CODES } from '../../../src/billing/plans';
import { DOMAIN_TICK_ROLE_NAME } from '../../../src/db/migrate';
import {
  AWS_ACCOUNT_ID_LENGTH,
  CUSTOM_DOMAIN_ADDRESS_CEILING,
  CUSTOM_DOMAIN_MAX_LENGTH,
  CUSTOM_DOMAIN_SUSPENSION_STRENGTH,
  customDomainAddressCeiling,
  domainAcceptsInboundOf,
  DOMAIN_TICK_ROLE,
  IDENTITY_POLICY_FRAME_BYTES,
  identityPolicyChunks,
  identityPolicyDocument,
  MAIL_CLAIM_KINDS,
  OWNER_ONLY_LIFT_REASONS,
  SENDER_ROLE_ARN_MAX_LENGTH,
  CUSTOM_DOMAIN_PENDING_REASONS,
  CUSTOM_DOMAIN_REMOVAL_STEPS,
  CUSTOM_DOMAIN_SAGA_STEPS,
  CUSTOM_DOMAIN_SES_STATUSES,
  CUSTOM_DOMAIN_STATUSES,
  CUSTOM_DOMAIN_SUSPENDED_REASONS,
  CUSTOM_DOMAIN_TRANSITIONS,
  dnsRecordsFor,
  DMARC_RECOMMENDED_VALUE,
  DNS_RECORD_REQUIRED,
  challengeRecordName,
  challengeRecordNames,
  combineChallengeVerdicts,
  DOMAIN_CONTROL_OPS,
  PENDING_SAGA_LAST_STEP,
  DOMAIN_TICK_PENDING_BUDGET,
  identityStewardshipOf,
  DOMAIN_NOTICE_KINDS,
  DOMAIN_SQLSTATES,
  DomainControlUnavailableError,
  domainGateStatusOf,
  INBOUND_MX_STATUSES,
  SES_IDENTITY_POLICIES_MAX,
  SES_IDENTITY_POLICY_MAX_BYTES,
  unavailableDomainControlInvoker,
} from '../../../src/domains/contract';

const read = (name: string): string => readFileSync(new URL(`../../../src/db/migrations/${name}`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
const M1100 = read('202609291100_custom_domains.sql');
const M1110 = read('202609291110_mail_identity_claims.sql');
const M1120 = read('202609291120_agent_address_domain_guards.sql');
// 대표 주소 포인터 모델(ADR-0014 2026-10 개정) — P0A08 · P0A09(선택 가드) · P0A10(앵커 이름 충돌).
const M2100 = read('202610021100_agent_primary_changes.sql');
const M2101 = read('202610021101_anchor_namespace.sql');
// 도메인 알림 종류 `verified`(콘솔 도메인 작업 2026-10-05) — kind CHECK 교체(NOT VALID → 1001 검증).
const M5100 = read('202610051000_domain_notice_verified.sql');
const M5101 = read('202610051001_domain_notice_verified_validate.sql');

/** `<칸> text … CHECK (<칸> IN (…))` 의 값 목록. */
function checkList(sql: string, column: string): string[] {
  const match = new RegExp(`\\b${column}\\s+text[^\\n]*?(?:\\n\\s+)?CHECK \\(${column} IN \\(([^)]*)\\)`).exec(sql);
  if (match === null) throw new Error(`${column} CHECK 를 찾지 못했다`);
  return [...(match[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((value) => value[1] ?? '');
}

describe('CHECK 목록 = 계약 유니온(202609291100)', () => {
  it.each([
    ['status', CUSTOM_DOMAIN_STATUSES],
    ['suspended_reason', CUSTOM_DOMAIN_SUSPENDED_REASONS],
    ['pending_reason', CUSTOM_DOMAIN_PENDING_REASONS],
    ['saga_step', CUSTOM_DOMAIN_SAGA_STEPS],
    ['removal_step', CUSTOM_DOMAIN_REMOVAL_STEPS],
    ['dkim_status', CUSTOM_DOMAIN_SES_STATUSES],
    ['mail_from_status', CUSTOM_DOMAIN_SES_STATUSES],
    ['inbound_mx_status', INBOUND_MX_STATUSES],
  ] as const)('%s', (column, values) => {
    expect(checkList(M1100, column)).toEqual([...values]);
  });

  it('domain_notices.kind — 최신 CHECK(202610051000 교체 · 1001 검증) = DOMAIN_NOTICE_KINDS, 처음 CHECK 는 verified 앞까지', () => {
    const replaced = /ADD CONSTRAINT domain_notices_kind_check CHECK \(kind IN \(([^)]*)\)\) NOT VALID/.exec(M5100)?.[1] ?? '';
    expect([...replaced.matchAll(/'([a-z0-9_]+)'/g)].map((value) => value[1] ?? '')).toEqual([...DOMAIN_NOTICE_KINDS]);
    expect(M5100).toContain('DROP CONSTRAINT domain_notices_kind_check');
    expect(M5101).toContain('VALIDATE CONSTRAINT domain_notices_kind_check');
    expect(checkList(M1100, 'kind')).toEqual(DOMAIN_NOTICE_KINDS.filter((kind) => kind !== 'verified'));
  });

  it('전이 가드의 허용 쌍 = CUSTOM_DOMAIN_TRANSITIONS(removed 는 종착)', () => {
    const body = /CREATE FUNCTION custom_domains_transition_guard\(\)[\s\S]*?\$\$;/.exec(M1100)?.[0] ?? '';
    const pairs = [...body.matchAll(/OLD\.status = '([a-z]+)' AND NEW\.status IN \(([^)]*)\)/g)].map((match) => [
      match[1] ?? '',
      [...(match[2] ?? '').matchAll(/'([a-z]+)'/g)].map((value) => value[1] ?? ''),
    ]);
    const expected = Object.entries(CUSTOM_DOMAIN_TRANSITIONS).filter(([, to]) => to.length > 0);
    expect(Object.fromEntries(pairs)).toEqual(Object.fromEntries(expected.map(([from, to]) => [from, [...to]])));
    expect(CUSTOM_DOMAIN_TRANSITIONS.removed).toEqual([]);
  });

  it('코드 천장 함수 = TS 상수(20 · 2) · 주소 천장 SQL 식의 상수 = TS 상수(프레임 · ARN · 계정 · 4,000 · 20 · 1,000)', () => {
    const value = (name: string): number => Number(new RegExp(`FUNCTION ${name}\\(\\) RETURNS integer\\s+LANGUAGE sql IMMUTABLE PARALLEL SAFE AS \\$\\$ SELECT (\\d+) \\$\\$`).exec(M1100)?.[1]);
    expect(value('atmark_custom_domains_ceiling')).toBe(CUSTOM_DOMAINS_CEILING);
    expect(value('atmark_custom_domains_pending_max')).toBe(CUSTOM_DOMAIN_PENDING_MAX);
    const body = /FUNCTION atmark_custom_domain_address_ceiling\(p_domain text\)[\s\S]*?\$\$\s*SELECT ([^\n]*)\n\$\$/.exec(M1120)?.[1] ?? '';
    expect(body).toBe(
      `greatest(0, least(${String(CUSTOM_DOMAIN_ADDRESS_CEILING)}, ${String(SES_IDENTITY_POLICIES_MAX)} * ((${String(SES_IDENTITY_POLICY_MAX_BYTES)} - ` +
        `(${String(IDENTITY_POLICY_FRAME_BYTES)} + ${String(SENDER_ROLE_ARN_MAX_LENGTH)} + ${String(AWS_ACCOUNT_ID_LENGTH)} + length(p_domain))) / (64 + 1 + length(p_domain) + 3))))`,
    );
    expect(M1100).toContain('length(domain) <= ' + String(CUSTOM_DOMAIN_MAX_LENGTH));
  });

  it('정지 사유의 세기 = 전이 가드의 CASE · 소유자만 푸는 사유 = 가드의 목록 · 틱 롤 이름 = migrate 상수', () => {
    const body = /CREATE FUNCTION custom_domains_transition_guard\(\)[\s\S]*?\$\$;/.exec(M1100)?.[0] ?? '';
    const strength = /old_strength integer := CASE OLD\.suspended_reason ([\s\S]*?) ELSE 0 END;/.exec(body)?.[1] ?? '';
    const parsed = Object.fromEntries([...strength.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map((match) => [match[1] ?? '', Number(match[2])]));
    expect(parsed).toEqual(CUSTOM_DOMAIN_SUSPENSION_STRENGTH);
    expect(body).toContain(`OLD.suspended_reason IN (${OWNER_ONLY_LIFT_REASONS.map((reason) => `'${reason}'`).join(', ')})`);
    expect(DOMAIN_TICK_ROLE).toBe(DOMAIN_TICK_ROLE_NAME);
    expect(M1100).toContain(`TO ${DOMAIN_TICK_ROLE}`);
  });

  it('claim 종류 = 1110 CHECK', () => {
    expect(checkList(M1110, 'kind')).toEqual([...MAIL_CLAIM_KINDS]);
  });

  it('SQLSTATE(P0A01~P0A10)가 트리거·함수에 있다 · 서로 다르다', () => {
    const all = `${M1100}\n${M1110}\n${M1120}\n${M2100}\n${M2101}`;
    for (const code of Object.values(DOMAIN_SQLSTATES)) expect(all, code).toContain(`ERRCODE = '${code}'`);
    expect(new Set(Object.values(DOMAIN_SQLSTATES)).size).toBe(Object.values(DOMAIN_SQLSTATES).length);
  });
});

describe('identity policy 조립(S1 · critic 4)', () => {
  const frame = (domain: string) => ({ senderRoleArn: 'r'.repeat(SENDER_ROLE_ARN_MAX_LENGTH), accountId: '1'.repeat(AWS_ACCOUNT_ID_LENGTH), domain });

  it('빈 문서의 바이트 = 프레임 상수 + ARN + 계정 + 도메인', () => {
    const domain = 'agents.younkyum.me';
    expect(identityPolicyDocument(frame(domain), []).length).toBe(IDENTITY_POLICY_FRAME_BYTES + SENDER_ROLE_ARN_MAX_LENGTH + AWS_ACCOUNT_ID_LENGTH + domain.length);
    expect(JSON.parse(identityPolicyDocument(frame(domain), ['a@agents.younkyum.me']))).toMatchObject({
      Statement: [{ Principal: { AWS: 'r'.repeat(128) }, Condition: { StringEquals: { 'ses:FromAddress': ['a@agents.younkyum.me'] } } }],
    });
  });

  it('천장만큼의 최악 주소(로컬파트 64자)는 길이 1~100 어디서든 정책 20개 안에 들어간다 · 하나 더 많으면 넘칠 수 있다', () => {
    for (const length of [1, 4, 10, 18, 30, 50, 75, 100]) {
      const domain = 'd'.repeat(length);
      const ceiling = customDomainAddressCeiling(domain);
      const addresses = Array.from({ length: ceiling }, (_, index) => `${String(index).padStart(64, 'x')}@${domain}`);
      const packed = identityPolicyChunks(frame(domain), addresses);
      expect(packed.kind, String(length)).toBe('ok');
      if (packed.kind !== 'ok') continue;
      for (const chunk of packed.chunks) expect(Buffer.byteLength(identityPolicyDocument(frame(domain), chunk))).toBeLessThanOrEqual(SES_IDENTITY_POLICY_MAX_BYTES);
      expect(packed.chunks.flat().sort()).toEqual([...addresses].sort());
    }
    expect([18, 50, 100].map((length) => customDomainAddressCeiling('d'.repeat(length)))).toEqual([820, 600, 400]);
  });

  it('빈 목록 = 정책 0개 · 20개를 넘기면 too_large · 순서 무관', () => {
    const domain = 'agents.x.com';
    expect(identityPolicyChunks(frame(domain), [])).toEqual({ kind: 'ok', chunks: [] });
    const many = Array.from({ length: 3000 }, (_, index) => `${String(index).padStart(64, 'y')}@${domain}`);
    expect(identityPolicyChunks(frame(domain), many)).toEqual({ kind: 'too_large' });
    const some = ['b@agents.x.com', 'a@agents.x.com'];
    expect(identityPolicyChunks(frame(domain), some)).toEqual(identityPolicyChunks(frame(domain), [...some].reverse()));
  });
});

describe('요금제 한도(J3) · SES 한도(S1)', () => {
  it('free 0 · beta 1 · pro 1 · team 3 · scale 10 · 천장 20 · pending 2', () => {
    expect(PLAN_CODES.map((plan) => CUSTOM_DOMAIN_LIMITS[plan])).toEqual([0, 1, 1, 3, 10]);
    for (const plan of PLAN_CODES) expect(customDomainLimitOf(plan)).toBeLessThanOrEqual(CUSTOM_DOMAINS_CEILING);
    expect(CUSTOM_DOMAINS_CEILING).toBe(20);
    expect(CUSTOM_DOMAIN_PENDING_MAX).toBe(2);
  });

  it('정책 4,000바이트 × 20개 · 도메인당 주소 절대 천장 1,000 · 도메인 100자', () => {
    expect(CUSTOM_DOMAIN_MAX_LENGTH).toBe(100);
    expect(SES_IDENTITY_POLICY_MAX_BYTES).toBe(4000);
    expect(SES_IDENTITY_POLICIES_MAX).toBe(20);
    expect(CUSTOM_DOMAIN_ADDRESS_CEILING).toBe(1000);
  });
});

describe('관문 접기(domainGateStatusOf) — 허용은 verified 하나 · plan_limit 만 transient · 나머지 blocked', () => {
  it.each([
    [{ status: 'verified', suspendedReason: null }, 'verified'],
    [{ status: 'suspended', suspendedReason: 'plan_limit' }, 'plan_limit'],
    [{ status: 'suspended', suspendedReason: 'ownership_lost' }, 'blocked'],
    [{ status: 'suspended', suspendedReason: 'dkim_failed' }, 'blocked'],
    [{ status: 'suspended', suspendedReason: 'reputation' }, 'blocked'],
    [{ status: 'suspended', suspendedReason: 'operator' }, 'blocked'],
    [{ status: 'removed', suspendedReason: null }, 'blocked'],
    [{ status: 'pending', suspendedReason: null }, 'blocked'],
    [{ status: 'verifying', suspendedReason: null }, 'blocked'],
    [{ status: 'missing', suspendedReason: null }, 'blocked'],
  ] as const)('%j → %s', (state, expected) => {
    expect(domainGateStatusOf(state)).toBe(expected);
  });
});

describe('수신 판정(domainAcceptsInboundOf) — verified · 평판·운영자·요금제 정지는 받는다, 소유권 상실·제거·없음은 받지 않는다', () => {
  it.each([
    [{ status: 'verified', suspendedReason: null }, true],
    [{ status: 'suspended', suspendedReason: 'reputation' }, true],
    [{ status: 'suspended', suspendedReason: 'operator' }, true],
    [{ status: 'suspended', suspendedReason: 'plan_limit' }, true],
    [{ status: 'suspended', suspendedReason: 'ownership_lost' }, false],
    [{ status: 'suspended', suspendedReason: 'dkim_failed' }, false],
    [{ status: 'removed', suspendedReason: null }, false],
    [{ status: 'missing', suspendedReason: null }, false],
    [{ status: 'pending', suspendedReason: null }, false],
  ] as const)('%j → %s', (state, expected) => {
    expect(domainAcceptsInboundOf(state)).toBe(expected);
  });
});

describe('레코드 표 · 비활성 포트', () => {
  it('DKIM 토큰이 없으면 DKIM 줄 없이 다섯(DMARC 포함) · 있으면 셋이 더 · 순서 소유 → 수신 MX → MAIL FROM → DKIM → DMARC · 소유 증명은 서브도메인 아래', () => {
    const token = 'A'.repeat(43);
    expect(dnsRecordsFor('agents.x.com', token, []).map((record) => record.purpose)).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dmarc']);
    const records = dnsRecordsFor('agents.x.com', token, ['t1', 't2', 't3']);
    expect(records.map((record) => record.purpose)).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dkim', 'dkim', 'dkim', 'dmarc']);
    expect(records[0]).toEqual({ purpose: 'ownership', type: 'TXT', name: '_atmark-challenge.agents.x.com', value: `atmark-domain-verification=${token}`, required: true });
    expect(records[1]).toEqual({ purpose: 'inbound_mx', type: 'MX', name: 'agents.x.com', value: '10 inbound-smtp.ap-northeast-2.amazonaws.com', required: true });
    expect(records.filter((record) => record.purpose === 'dkim').map((record) => record.name)).toEqual([
      't1._domainkey.agents.x.com',
      't2._domainkey.agents.x.com',
      't3._domainkey.agents.x.com',
    ]);
  });

  it('DMARC — 마지막 · 권장(required:false) · 최소 값 p=none(rua 없음) · 나머지는 전부 필수', () => {
    const records = dnsRecordsFor('agents.x.com', 'A'.repeat(43), ['t1', 't2', 't3']);
    expect(records.at(-1)).toEqual({ purpose: 'dmarc', type: 'TXT', name: '_dmarc.agents.x.com', value: 'v=DMARC1; p=none', required: false });
    expect(DMARC_RECOMMENDED_VALUE).not.toMatch(/rua=/);
    expect(records.filter((record) => !record.required).map((record) => record.purpose)).toEqual(['dmarc']);
    expect(Object.entries(DNS_RECORD_REQUIRED).filter(([, required]) => !required).map(([purpose]) => purpose)).toEqual(['dmarc']);
  });

  it('소유 증명 이름 — 서브도메인 먼저 · apex 도 인정(OR) · apex 자체면 하나', () => {
    expect(challengeRecordName('agents.x.com')).toBe('_atmark-challenge.agents.x.com');
    expect(challengeRecordNames('agents.x.com', 'x.com')).toEqual(['_atmark-challenge.agents.x.com', '_atmark-challenge.x.com']);
    expect(challengeRecordNames('x.com', 'x.com')).toEqual(['_atmark-challenge.x.com']);
  });

  it.each([
    [['present', 'absent'], 'present'],
    [['absent', 'present'], 'present'],
    [['absent', 'absent'], 'absent'],
    [['error', 'absent'], 'error'],
    [['absent', 'error'], 'error'],
    [['present', 'error'], 'present'],
    [['error', 'present'], 'present'],
    [['error', 'error'], 'error'],
    [['absent'], 'absent'],
    [[], 'error'],
  ] as const)('combineChallengeVerdicts(%j) = %s', (verdicts, expected) => {
    expect(combineChallengeVerdicts(verdicts)).toBe(expected);
  });

  it('op 목록 · pending 사가 끝 단계 · 예산', () => {
    expect(DOMAIN_CONTROL_OPS).toEqual(['check', 'saga_step', 'remove_step', 'sync_policy', 'audit_policy', 'check_expiry', 'peek_identity']);
    expect(PENDING_SAGA_LAST_STEP).toBe('config_set');
    expect(DOMAIN_TICK_PENDING_BUDGET).toBe(8);
  });

  it.each([
    [{ identityClaimedAt: null, identityReleasedAt: null, identityDeletedAt: null }, 'none'],
    [{ identityClaimedAt: new Date(0), identityReleasedAt: null, identityDeletedAt: null }, 'steward'],
    [{ identityClaimedAt: new Date(0), identityReleasedAt: new Date(1), identityDeletedAt: null }, 'released'],
    [{ identityClaimedAt: new Date(0), identityReleasedAt: null, identityDeletedAt: new Date(1) }, 'released'],
  ] as const)('identityStewardshipOf %# → %s', (facts, expected) => {
    expect(identityStewardshipOf(facts)).toBe(expected);
  });

  it('비활성 domain-control 포트는 던진다(빈 결과를 돌려주지 않는다)', async () => {
    await expect(unavailableDomainControlInvoker.invoke([])).rejects.toBeInstanceOf(DomainControlUnavailableError);
  });
});
