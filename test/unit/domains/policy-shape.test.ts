/**
 * `src/domains/policy-shape.ts` — SES identity 자원 정책 모양 검사(보안 리뷰 M2 — 읽기 전용 감사 λ 와 `check-ses-principals.sh` 가 같은 규칙).
 * 계약의 `identityPolicyDocument` 그대로면 문제 0 · 하나라도 넓히면 그 문제 코드.
 */

import { describe, expect, it } from 'vitest';

import { IDENTITY_POLICY_NAME_PREFIX, identityPolicyDocument } from '../../../src/domains/contract';
import { identityPolicyProblems, isPlatformIdentity } from '../../../src/domains/policy-shape';

const ACCOUNT = '123456789012';
const SENDER = `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`;
const DOMAIN = 'agents.example.com';
const FRAME = { senderRoleArn: SENDER, accountId: ACCOUNT, region: 'ap-northeast-2' };
const NAME = `${IDENTITY_POLICY_NAME_PREFIX}11111111-1111-4111-8111-111111111111-0`;
const good = identityPolicyDocument({ senderRoleArn: SENDER, accountId: ACCOUNT, domain: DOMAIN }, [`a@${DOMAIN}`]);
const patched = (patch: (statement: Record<string, unknown>) => Record<string, unknown>): string => {
  const doc = JSON.parse(good) as { Version: string; Statement: Record<string, unknown>[] };
  return JSON.stringify({ ...doc, Statement: doc.Statement.map(patch) });
};

describe('identity 자원 정책 모양', () => {
  it('계약 문서 그대로 → 문제 0 · 정책 0 → 문제 0', () => {
    expect(identityPolicyProblems(DOMAIN, { [NAME]: good }, FRAME)).toEqual([]);
    expect(identityPolicyProblems(DOMAIN, {}, FRAME)).toEqual([]);
  });

  it.each([
    ['Principal *', patched((s) => ({ ...s, Principal: '*' })), 'principal'],
    ['다른 역할', patched((s) => ({ ...s, Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/x` } })), 'principal'],
    ['Principal 키 둘', patched((s) => ({ ...s, Principal: { AWS: SENDER, Service: 'x' } })), 'principal'],
    ['대량 발송', patched((s) => ({ ...s, Action: ['ses:SendEmail', 'ses:SendBulkEmail'] })), 'action'],
    ['ses:*', patched((s) => ({ ...s, Action: 'ses:*' })), 'action'],
    ['identity/*', patched((s) => ({ ...s, Resource: `arn:aws:ses:ap-northeast-2:${ACCOUNT}:identity/*` })), 'resource'],
    ['조건 없음', patched(({ Condition: _c, ...s }) => s), 'condition'],
    ['StringLike', patched((s) => ({ ...s, Condition: { StringLike: { 'ses:FromAddress': `*@${DOMAIN}` } } })), 'condition'],
    ['남의 주소', patched((s) => ({ ...s, Condition: { StringEquals: { 'ses:FromAddress': ['ceo@example.com'] } } })), 'from_address'],
    ['빈 주소', patched((s) => ({ ...s, Condition: { StringEquals: { 'ses:FromAddress': [] } } })), 'from_address'],
    ['Deny', patched((s) => ({ ...s, Effect: 'Deny' })), 'not_allow'],
    ['NotPrincipal', patched((s) => ({ ...s, NotPrincipal: { AWS: SENDER } })), 'not_field'],
    ['JSON 아님', 'nope', 'not_json'],
    ['Statement 없음', '{"Version":"2012-10-17"}', 'no_statement'],
  ])('%s → %s', (_label, document, problem) => {
    expect(identityPolicyProblems(DOMAIN, { [NAME]: document }, FRAME)).toContain(problem);
  });

  it('이름 접두사 밖 → name_prefix · 플랫폼 identity(와 하위·대문자)에 정책 → platform_policy', () => {
    expect(identityPolicyProblems(DOMAIN, { manual: good }, FRAME)).toEqual(['name_prefix']);
    expect(identityPolicyProblems('atmark.ai', { [NAME]: good }, FRAME)).toEqual(['platform_policy']);
    expect(identityPolicyProblems('tx.ATMARK.ai', { x: '{}' }, FRAME)).toEqual(['platform_policy']);
    expect(isPlatformIdentity('atmark.ai.evil.com')).toBe(false);
    expect(isPlatformIdentity('notatmark.ai')).toBe(false);
  });
});
