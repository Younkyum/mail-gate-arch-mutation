/**
 * `atmark-domain-policy-audit`(보안 리뷰 M2) — 읽기 전용 독립 감사. 입력 판별(정기 · CloudTrail 정책 이벤트만) · identity 하나/전수 · EMF 한 줄.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DOMAIN_METRIC_NAMES } from '../../../src/domains/metrics';
import { IDENTITY_POLICY_NAME_PREFIX, identityPolicyDocument } from '../../../src/domains/contract';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  auditTargetOf,
  composeDomainPolicyAudit,
  createDomainPolicyAuditHandler,
  DOMAIN_POLICY_AUDIT_BUDGET_MS,
  runDomainPolicyAudit,
  type DomainPolicyAuditDependencies,
} from '../../../src/runtime/handlers/domain-policy-audit';

const ACCOUNT = '123456789012';
const SENDER = `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`;
const DOMAIN = 'agents.example.com';
const NAME = `${IDENTITY_POLICY_NAME_PREFIX}11111111-1111-4111-8111-111111111111-0`;
const good = identityPolicyDocument({ senderRoleArn: SENDER, accountId: ACCOUNT, domain: DOMAIN }, [`a@${DOMAIN}`]);

function deps(policies: Record<string, Record<string, string>>): DomainPolicyAuditDependencies & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    senderRoleArn: SENDER,
    accountId: ACCOUNT,
    region: 'ap-northeast-2',
    ses: {
      listIdentities: () => Promise.resolve(Object.keys(policies)),
      getIdentity: (identity) => {
        reads.push(identity);
        const found = policies[identity];
        return Promise.resolve(found === undefined ? null : { tags: {}, policies: found, dkimTokens: [], dkimStatus: null, mailFromStatus: null });
      },
    },
  };
}

const cloudTrail = (eventName: string, requestParameters: unknown): unknown => ({
  source: 'aws.ses',
  'detail-type': 'AWS API Call via CloudTrail',
  detail: { eventSource: 'ses.amazonaws.com', eventName, requestParameters },
});

afterEach(() => resetLogSink());

describe('독립 정책 감사', () => {
  it('입력 판별 — 정기는 전수 · 정책 이벤트는 그 identity(v2 emailIdentity · v1 identity) · 이름을 못 읽으면 전수 · 그 밖은 던진다', () => {
    expect(auditTargetOf({ source: 'atmark.schedule' })).toEqual({ kind: 'all' });
    expect(auditTargetOf(cloudTrail('CreateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: 'x', policy: '{}' }))).toEqual({
      kind: 'one',
      identity: DOMAIN,
      eventPolicy: { name: 'x', document: '{}' },
    });
    // 쓰기 이벤트인데 원문이 없다(칸 이름이 다르다) → unreadable(재검증 LOW-A — 조용히 지금 상태만 보지 않는다).
    expect(auditTargetOf(cloudTrail('PutIdentityPolicy', { identity: DOMAIN }))).toEqual({ kind: 'one', identity: DOMAIN, eventPolicy: 'unreadable' });
    expect(auditTargetOf(cloudTrail('CreateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: 'x', policyDocument: '{}' }))).toEqual({
      kind: 'one',
      identity: DOMAIN,
      eventPolicy: 'unreadable',
    });
    // 지우기 이벤트도 깨운다(재검증 MEDIUM-1) — 원문은 없다.
    expect(auditTargetOf(cloudTrail('DeleteEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: 'x' }))).toEqual({ kind: 'one', identity: DOMAIN, eventPolicy: null });
    expect(auditTargetOf(cloudTrail('UpdateEmailIdentityPolicy', null))).toEqual({ kind: 'all' });
    for (const bad of [{}, { source: 'atmark.schedule', extra: 1 }, cloudTrail('SendEmail', { emailIdentity: DOMAIN }), { task: 'domain-recheck' }]) {
      expect(() => auditTargetOf(bad)).toThrow();
    }
  });

  it('위반이 있으면 EMF 에 identity 수 · 로그에 문제 코드(도메인명 없음) · 깨끗하면 0', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const fake = deps({ 'atmark.ai': {}, [DOMAIN]: { [NAME]: good.replace(SENDER, '*') }, 'clean.example.com': {} });
    const out = await createDomainPolicyAuditHandler(() => fake)({ source: 'atmark.schedule' });
    expect(out).toEqual({ audited: 3, violating: 1 });
    const metric = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => DOMAIN_METRIC_NAMES.policyShapeViolation in line);
    expect(metric?.[DOMAIN_METRIC_NAMES.policyShapeViolation]).toBe(1);
    expect(lines.join('\n')).toContain('problems=principal');
    expect(lines.join('\n')).not.toContain(DOMAIN);

    const one = deps({ [DOMAIN]: { [NAME]: good }, 'other.example.com': { x: '{}' } });
    await expect(createDomainPolicyAuditHandler(() => one)(cloudTrail('CreateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: NAME, policy: good }))).resolves.toEqual({ audited: 1, violating: 0 });
    expect(one.reads).toEqual([DOMAIN]);
  });

  it('★ 만들고 보내고 지우기(TOCTOU) — 지금 상태가 깨끗해도 쓰기 이벤트의 원문이 넓으면 위반(OR · 재검증 MEDIUM-1)', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const widened = good.replace(SENDER, '*');
    const fake = deps({ [DOMAIN]: {} }); // 이미 지워졌다
    await expect(
      createDomainPolicyAuditHandler(() => fake)(cloudTrail('CreateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: NAME, policy: widened })),
    ).resolves.toEqual({ audited: 1, violating: 1 });
    expect(lines.join('\n')).toContain('problems=principal');
    // 원문이 깨끗해도 지금 상태를 건너뛰지 않는다 — 원문은 알람 쪽으로만 쓴다.
    const now = deps({ [DOMAIN]: { [NAME]: widened } });
    await expect(createDomainPolicyAuditHandler(() => now)(cloudTrail('UpdateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: NAME, policy: good }))).resolves.toEqual({
      audited: 1,
      violating: 1,
    });
    // 이벤트 감사는 하트비트를 내지 않는다(정기 전수만).
    expect(lines.some((line) => line.includes(DOMAIN_METRIC_NAMES.policyAuditAudited))).toBe(false);
  });

  it('★ 쓰기 이벤트의 원문 칸이 없으면 지금 상태가 깨끗해도 unreadable 위반(재검증 LOW-A)', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const fake = deps({ [DOMAIN]: { [NAME]: good } });
    await expect(createDomainPolicyAuditHandler(() => fake)(cloudTrail('UpdateEmailIdentityPolicy', { emailIdentity: DOMAIN, policyName: NAME }))).resolves.toEqual({
      audited: 1,
      violating: 1,
    });
    expect(lines.join('\n')).toContain('problems=unreadable');
  });

  it('★ 읽지 못한 identity 는 unreadable 위반 · 나머지는 계속 본다 · 정기 전수는 하트비트(0 이어도) · 목록 실패는 던진다(재검증 MEDIUM-2)', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const flaky = deps({ 'a.example.com': {}, 'b.example.com': { [NAME]: good.replace(DOMAIN, 'b.example.com').replace(`a@${DOMAIN}`, 'a@b.example.com') } });
    const failing: DomainPolicyAuditDependencies = {
      ...flaky,
      ses: { ...flaky.ses, getIdentity: (identity) => (identity === 'a.example.com' ? Promise.reject(new Error('throttled')) : flaky.ses.getIdentity(identity)) },
    };
    await expect(createDomainPolicyAuditHandler(() => failing)({ source: 'atmark.schedule' })).resolves.toEqual({ audited: 2, violating: 1 });
    expect(lines.join('\n')).toContain('problems=unreadable');
    const heartbeat = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => DOMAIN_METRIC_NAMES.policyAuditAudited in line);
    expect(heartbeat?.[DOMAIN_METRIC_NAMES.policyAuditAudited]).toBe(2);
    const empty = deps({});
    await expect(createDomainPolicyAuditHandler(() => empty)({ source: 'atmark.schedule' })).resolves.toEqual({ audited: 0, violating: 0 });
    const noList: DomainPolicyAuditDependencies = { ...empty, ses: { ...empty.ses, listIdentities: () => Promise.reject(new Error('denied')) } };
    await expect(createDomainPolicyAuditHandler(() => noList)({ source: 'atmark.schedule' })).rejects.toThrow('denied');
  });

  it('시간 예산을 넘긴 identity 는 읽지 않고 unreadable 위반으로 센다(조용히 건너뛰지 않는다)', async () => {
    let clock = 0;
    const slow = deps({ 'a.example.com': {}, 'b.example.com': {} });
    const timed: DomainPolicyAuditDependencies = { ...slow, now: () => (clock += DOMAIN_POLICY_AUDIT_BUDGET_MS + 1) };
    const result = await runDomainPolicyAudit(timed, { kind: 'all' });
    expect(result.violating).toBe(2);
    expect(result.problems).toEqual(['unreadable']);
  });

  it('조립 — 운영 · 발송 역할 ARN 모양', () => {
    expect(() => composeDomainPolicyAudit({ ATMARK_ENV: 'production', AWS_REGION: 'ap-northeast-2', SENDER_ROLE_ARN: '*' })).toThrow();
    expect(composeDomainPolicyAudit({ ATMARK_ENV: 'production', AWS_REGION: 'ap-northeast-2', SENDER_ROLE_ARN: SENDER }).accountId).toBe(ACCOUNT);
  });

  it('고아 태그(#13 M2) — 관리 identity 의 행 태그가 없거나 모양이 아니면 orphan_tag 위반 · 관리 행 태그는 uuid 만 목록으로', async () => {
    const row = '22222222-2222-4222-8222-222222222222';
    const tags: Record<string, Record<string, string>> = {
      'a.example.com': { 'atmark:managed': 'customer-domain', 'atmark:row': row },
      'b.example.com': { 'atmark:managed': 'customer-domain' },
      'c.example.com': { 'atmark:managed': 'customer-domain', 'atmark:row': 'not-a-row' },
      'manual.example.com': {},
    };
    const fake: DomainPolicyAuditDependencies = {
      senderRoleArn: SENDER,
      accountId: ACCOUNT,
      region: 'ap-northeast-2',
      ses: {
        listIdentities: () => Promise.resolve(Object.keys(tags)),
        getIdentity: (identity) => Promise.resolve({ tags: tags[identity] ?? {}, policies: {}, dkimTokens: [], dkimStatus: null, mailFromStatus: null }),
      },
    };
    const result = await runDomainPolicyAudit(fake, { kind: 'all' });
    expect(result).toMatchObject({ audited: 4, violating: 2, problems: ['orphan_tag'], managedRows: [row] });
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    await createDomainPolicyAuditHandler(() => fake)({ source: 'atmark.schedule' });
    const listed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line['event'] === 'domain_policy_audit.managed_rows');
    expect(listed?.['detail']).toBe(`count=1 rows=${row}`);
    expect(lines.join('\n')).not.toContain('example.com');
  });
});
