/**
 * `policy-loader.ts` — 선적재·정규화·jsonb 좁히기.
 *
 * 로더가 하는 일은 전부 "엔진이 순수 함수일 수 있게 하는 일" 이다. 그래서 여기서
 * 검사하는 것도 두 가지뿐이다: ① 정규화가 **한 곳에서** 일어나는가,
 * ② 잘못된 jsonb 가 **엔진에 도달하기 전에** 죽는가.
 */

import { ATTACHMENT_BYTES_CEILING } from '../../../src/api/outbound-attachments';
import { ENTITLEMENT_CEILINGS, PLAN_CATALOG } from '../../../src/billing/plans';
import { entitlementRow } from '../../support/entitlements';
import { describe, expect, it } from 'vitest';
import type {
  AgentPolicyRow,
  AgentRow,
  ContactRuleRow,
  OrganizationRow,
  PolicyVersionRow,
  SuppressionEntryRow,
} from '../../../src/db/schema';
import {
  ATTACHMENT_BYTES_TOTAL_CEILING,
  loadEvaluationInput,
  normalizeAddress,
  PolicyShapeError,
  resolveOutboundRules,
  PolicySourceUnavailableError,
  resolveContentPolicy,
  resolveLimits,
  resolvePolicy,
  unavailablePolicySource,
  type PolicySource,
  type PolicySourceResult,
} from '../../../src/policy/policy-loader';
import { evaluate } from '../../../src/policy/engine';
import { AGENT_ID, NOW, ORG_ID, POLICY_VERSION_ID, baseAttempt, baseCounters } from './fixtures';

const LIMITS_JSON = { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 };
const CONFIG_JSON = {
  max_attachment_bytes_total: 5_000_000,
  allowed_mime_types: ['application/pdf'],
};

/** 연락처 규칙 한 행(정책 v2). DB 는 소문자만 받지만 로더도 한 번 더 접는다 — 그 접힘을 보려고 대문자를 넣는 테스트가 있다. */
function rule(direction: ContactRuleRow['direction'], list: ContactRuleRow['list'], value: string): ContactRuleRow {
  return {
    id: `rule-${direction}-${list}-${value}`,
    agent_id: AGENT_ID,
    direction,
    list,
    kind: value.includes('@') ? 'address' : 'domain',
    value,
    created_at: NOW,
    created_by: null,
    removed_at: null,
    removed_by: null,
  };
}

const FRIEND_RULE = rule('outbound', 'allow', 'Friend@Example.com');

/** 규칙들을 싣은 버전 스냅샷 — 관문은 목록을 스냅샷에서 읽는다(202609241040). */
function snapshotOf(rules: readonly ContactRuleRow[]): PolicyVersionRow['snapshot'] {
  return { contact_rules: rules.map(({ id, direction, list, kind, value }) => ({ id, direction, list, kind, value })) };
}

const organization: OrganizationRow = {
  id: ORG_ID,
  name: 'Atmark',
  ses_tenant_id: null,
  billing_status: 'active',
  abuse_freeze: false,
  owner_paused: false,
  review_status: 'active',
  sending_started_at: new Date('2026-09-01T00:00:00.000Z'),
  created_at: NOW,
  updated_at: NOW,
};

const agent: AgentRow = {
  id: AGENT_ID,
  organization_id: ORG_ID,
  name: 'demo',
  status: 'active',
  plan: 'free',
  monthly_budget_cents: 10_000,
  created_at: NOW,
  updated_at: NOW,
};

const policyRow: AgentPolicyRow = {
  agent_id: AGENT_ID,
  outbound_mode: 'allowlist_only',
  inbound_mode: 'all',
  require_approval: false,
  limits: LIMITS_JSON,
  config_json: CONFIG_JSON,
  current_version: 3,
  created_at: NOW,
  updated_at: NOW,
};

const versionRow: PolicyVersionRow = {
  id: POLICY_VERSION_ID,
  agent_id: AGENT_ID,
  version: 3,
  outbound_mode: 'allowlist_only',
  inbound_mode: 'all',
  snapshot: snapshotOf([FRIEND_RULE]),
  created_by: null,
  created_at: NOW,
};

function suppression(address: string, source: SuppressionEntryRow['source']): SuppressionEntryRow {
  return {
    id: `sup-${address}`,
    organization_id: ORG_ID,
    address,
    domain: address.slice(address.lastIndexOf('@') + 1),
    source,
    reason: null,
    expires_at: null,
    created_at: NOW,
  };
}

function sourceOf(overrides: Partial<PolicySourceResult> = {}): PolicySource {
  return {
    load: () =>
      Promise.resolve({
        entitlements: entitlementRow('beta'),
        organization,
        agent,
        addresses: [
          { id: 'addr-1', agent_id: AGENT_ID, address: 'Agent@Atmark.ai', domain: 'atmark.ai', is_primary: true, created_at: NOW },
        ],
        policy: policyRow,
        policyVersion: versionRow,
        suppressions: [],
        counters: baseCounters,
        monthToDateSpentCents: 0,
        relationships: [],
        approvalGrant: null,
        outboundSentCount: 0,
        agentRequestedRuleIds: [],
        // 고객 도메인(ADR-0014) — 에이전트 주소가 전부 atmark.ai 라 소스가 고객 도메인 행을 주지 않는다.
        inactiveAddresses: [],
        customDomains: [],
        thread: null,
        ...overrides,
      }),
  };
}

const request = {
  agentId: AGENT_ID,
  attempt: { ...baseAttempt, fromAddress: '  Agent@Atmark.AI ', recipients: ['Friend@Example.com'] },
  now: NOW,
  traceId: null,
  thisAttemptCostCents: 10,
  release: null,
};

describe('자기 주소(recipient_is_self, 202609241040 — 검증 L1) — 로더의 판정형을 지나 +tag·대소문자 변형도 잡힌다', () => {
  it('Agent+Loop@Atmark.AI → 판정형 agent@atmark.ai = 에이전트 자기 주소 → 거부', async () => {
    const input = await loadEvaluationInput(sourceOf(), { ...request, attempt: { ...request.attempt, recipients: ['Agent+Loop@Atmark.AI'] } });
    const decision = evaluate(input.ctx, input.policy);
    expect([decision.verdict, decision.reasons]).toEqual(['denied', ['recipient_is_self']]);
  });
});

describe('요금제(ADR-0011) — 로더가 행을 해석한다: 행이 없으면 Free(fail-closed) · 유예가 끝났으면 Free · 천장으로 자른다', () => {
  const entitlementsFrom = async (entitlements: ReturnType<typeof entitlementRow> | null) =>
    (await loadEvaluationInput(sourceOf({ entitlements }), request)).ctx.organization.entitlements;

  it('행 없음(null) → Free', async () => {
    expect(await entitlementsFrom(null)).toEqual({ planCode: 'free', basis: 'missing', ...PLAN_CATALOG.free });
  });

  it('행 → 그 값 · 유예 전이면 그대로 · 유예가 끝났으면 Free', async () => {
    expect(await entitlementsFrom(entitlementRow('team'))).toMatchObject({ planCode: 'team', basis: 'row', maxAgents: 50, agentPerMinuteMax: 120 });
    expect(await entitlementsFrom(entitlementRow('team', { grace_until: new Date(NOW.getTime() + 60_000) }))).toMatchObject({ planCode: 'team', basis: 'row' });
    expect(await entitlementsFrom(entitlementRow('team', { grace_until: NOW }))).toMatchObject({ planCode: 'free', basis: 'grace_expired', maxAgents: 3 });
  });

  it('천장 밖의 값(운영자 덮어쓰기·손댄 행)은 천장으로 자른다 · 모르는 요금제 코드는 Free', async () => {
    const wild = await entitlementsFrom(entitlementRow('scale', { recipients_per_message_max: 500, org_daily_recipients: 20_000, tokens_per_agent_max: 20 }));
    expect(wild).toMatchObject({ recipientsPerMessageMax: 50, orgDailyRecipients: 1000, tokensPerAgentMax: 5 });
    expect(await entitlementsFrom(entitlementRow('beta', { plan_code: 'enterprise' }))).toMatchObject({ planCode: 'free', basis: 'missing' });
  });
});

describe('normalizeAddress — 정규화는 한 곳에서만 일어난다', () => {
  it('공백 제거 + 소문자화', () => {
    expect(normalizeAddress('  Agent@Atmark.AI ')).toBe('agent@atmark.ai');
  });

  it('`+tag` 를 절단한다 — Gmail 에서 둘은 같은 메일함이다', () => {
    expect(normalizeAddress('victim+x@gmail.com')).toBe('victim@gmail.com');
    expect(normalizeAddress('Victim+A+B@Gmail.com')).toBe('victim@gmail.com');
  });

  it('주소가 아닌 값은 손대지 않는다 — 잘라서 `@domain` 을 만들면 도메인 항목과 우연히 일치한다', () => {
    expect(normalizeAddress('not-an-address')).toBe('not-an-address');
    expect(normalizeAddress('+tag@example.com')).toBe('+tag@example.com');
    expect(normalizeAddress('@example.com')).toBe('@example.com');
  });
});

describe('loadEvaluationInput', () => {
  it('발신·수신·바인딩 주소를 전부 정규화해 엔진에 넘긴다', async () => {
    const { ctx } = await loadEvaluationInput(sourceOf(), request);

    expect(ctx.attempt.fromAddress).toBe('agent@atmark.ai');
    expect(ctx.attempt.recipients).toEqual(['friend@example.com']);
    expect(ctx.agent.boundAddresses).toEqual(['agent@atmark.ai']);
  });

  it('억제 항목을 출처별로 나눈다 — 해소 경로가 다르므로 사유 코드도 달라야 한다', async () => {
    const { ctx } = await loadEvaluationInput(
      sourceOf({
        suppressions: [
          suppression('friend@example.com', 'bounce'),
          suppression('friend@example.com', 'ses_account_level'),
        ],
      }),
      request,
    );

    expect(ctx.suppressedRecipients).toEqual(['friend@example.com']);
    expect(ctx.sesSuppressedRecipients).toEqual(['friend@example.com']);
  });

  it('**`+tag` 수신자가 억제 목록을 우회하지 못한다** — 불만 신고한 사람에게 다시 가는 경로', () => {
    // 이 케이스가 이 파일에서 가장 비싼 한 줄이다. 통과하면 bounce·complaint 가 다시 쌓이고,
    // §3.3 의 5% 임계에서 SES 계정이 정지된다 — 억제는 우리 의사가 아니라 상대의 의사다.
    return loadEvaluationInput(
      sourceOf({ suppressions: [suppression('victim@example.com', 'bounce')] }),
      { ...request, attempt: { ...request.attempt, recipients: ['Victim+Newsletter@Example.com'] } },
    ).then(({ ctx }) => {
      expect(ctx.suppressedRecipients).toEqual(['victim@example.com']);
    });
  });

  it('이번 수신자가 아닌 억제 항목은 버린다', async () => {
    const { ctx } = await loadEvaluationInput(
      sourceOf({ suppressions: [suppression('someone-else@example.com', 'bounce')] }),
      request,
    );
    expect(ctx.suppressedRecipients).toEqual([]);
  });

  it('예산·카운터·조직 스냅샷이 행에서 그대로 옮겨진다', async () => {
    const { ctx } = await loadEvaluationInput(sourceOf({ monthToDateSpentCents: 4_200 }), request);

    expect(ctx.budget).toEqual({
      monthlyBudgetCents: 10_000,
      monthToDateSpentCents: 4_200,
      thisAttemptCostCents: 10,
    });
    expect(ctx.organization.sendingStartedAt).toEqual(organization.sending_started_at);
  });

  it('소유자 정지(owner_paused)와 플랫폼 동결(abuse_freeze)이 각자의 칸으로 옮겨진다 — 섞이지 않는다', async () => {
    const paused = await loadEvaluationInput(sourceOf({ organization: { ...organization, owner_paused: true } }), request);
    expect(paused.ctx.organization).toMatchObject({ ownerPaused: true, abuseFreeze: false });
    const frozen = await loadEvaluationInput(sourceOf({ organization: { ...organization, abuse_freeze: true } }), request);
    expect(frozen.ctx.organization).toMatchObject({ ownerPaused: false, abuseFreeze: true });
  });

  it('운영자 검토 상태(review_status)가 reviewStatus 칸으로 옮겨진다', async () => {
    for (const status of ['pending_review', 'active', 'rejected'] as const) {
      const loaded = await loadEvaluationInput(sourceOf({ organization: { ...organization, review_status: status } }), request);
      expect(loaded.ctx.organization.reviewStatus).toBe(status);
    }
  });

  it('allowlist 도 정규화된다 — 대소문자 때문에 허용 목록이 안 먹는 일이 없어야 한다', async () => {
    const { policy } = await loadEvaluationInput(sourceOf(), request);
    expect(policy.allowlist).toEqual(['friend@example.com']);
  });
});

describe('시도 입력 검증 — 정책은 우리가 쓰고 시도는 에이전트가 쓴다', () => {
  it('첨부 바이트가 음수면 PolicyShapeError — 합이 음수가 되어 Stage 6 을 통과한다', async () => {
    await expect(
      loadEvaluationInput(sourceOf(), {
        ...request,
        attempt: {
          ...request.attempt,
          attachments: [
            { filename: 'a.pdf', mimeType: 'application/pdf', bytes: -1e9 },
            { filename: 'b.pdf', mimeType: 'application/pdf', bytes: 40e6 },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(PolicyShapeError);
  });

  it('첨부 바이트가 NaN·소수여도 거부한다', async () => {
    for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        loadEvaluationInput(sourceOf(), {
          ...request,
          attempt: { ...request.attempt, attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', bytes }] },
        }),
      ).rejects.toBeInstanceOf(PolicyShapeError);
    }
  });

  it('이번 시도 비용이 음수면 PolicyShapeError — 예산이 무제한이 된다', async () => {
    await expect(
      loadEvaluationInput(sourceOf(), { ...request, thisAttemptCostCents: -1e9 }),
    ).rejects.toBeInstanceOf(PolicyShapeError);
  });

  it('시도 쪽 mimeType 도 정책 쪽과 같은 정규화를 탄다 — 비대칭이면 왜 막혔는지 아무도 설명 못 한다', async () => {
    const { ctx } = await loadEvaluationInput(sourceOf(), {
      ...request,
      attempt: { ...request.attempt, attachments: [{ filename: 'a.pdf', mimeType: ' Application/PDF ', bytes: 10 }] },
    });
    expect(ctx.attempt.attachments[0]?.mimeType).toBe('application/pdf');
  });
});

describe('unavailablePolicySource — P1a 의 스텁', () => {
  it('빈 결과가 아니라 예외를 낸다 — 읽을 수 없으면 보낼 수 없다', async () => {
    await expect(loadEvaluationInput(unavailablePolicySource(), request)).rejects.toBeInstanceOf(
      PolicySourceUnavailableError,
    );
  });
});

describe('jsonb 좁히기 — 잘못된 정책은 엔진에 도달하지 않는다', () => {
  it('limits 필드가 정수가 아니면 PolicyShapeError', () => {
    expect(() => resolveLimits({ ...LIMITS_JSON, per_minute: '10' })).toThrow(PolicyShapeError);
    expect(() => resolveLimits({ ...LIMITS_JSON, per_hour: -1 })).toThrow(PolicyShapeError);
    expect(() => resolveLimits({ ...LIMITS_JSON, per_day: 1.5 })).toThrow(PolicyShapeError);
    expect(() => resolveLimits({})).toThrow(PolicyShapeError);
  });

  it('limits 에 warmup_daily_cap 이 있어도 무시된다 — 캡은 코드 상수다 (§3.3)', () => {
    const limits = resolveLimits({ ...LIMITS_JSON, warmup_daily_cap: 999_999 });
    expect(Object.keys(limits).sort()).toEqual(['perDay', 'perHour', 'perMinute', 'recipientsPerMessage']);
  });

  it('config_json 의 목록이 문자열 배열이 아니면 PolicyShapeError', () => {
    expect(() => resolveContentPolicy({ ...CONFIG_JSON, allowed_mime_types: 'application/pdf' })).toThrow(
      PolicyShapeError,
    );
    expect(() => resolveContentPolicy({ ...CONFIG_JSON, allowed_mime_types: [1, 2] })).toThrow(
      PolicyShapeError,
    );
  });

  it('MIME 타입은 소문자화한다', () => {
    const content = resolveContentPolicy({ ...CONFIG_JSON, allowed_mime_types: [' Application/PDF '] });
    expect(content.allowedMimeTypes).toEqual(['application/pdf']);
  });

  it('정책 행과 버전 행이 갈라져 있으면 거부한다 — audit 근거가 실제 판정과 달라진다', () => {
    expect(() => resolvePolicy(policyRow, { ...versionRow, version: 2 }, [])).toThrow(PolicyShapeError);
  });

  it('outbound_mode 는 **버전 스냅샷** 쪽을 쓴다 (§4.3)', () => {
    const resolved = resolvePolicy(
      { ...policyRow, outbound_mode: 'unrestricted' },
      { ...versionRow, outbound_mode: 'allowlist_only' },
      [],
    );
    expect(resolved.outboundMode).toBe('allowlist_only');
    expect(resolved.versionId).toBe(POLICY_VERSION_ID);
    expect(resolved.version).toBe(3);
  });

  it('수신 방향 규칙이 섞이면 PolicyShapeError — 수신 allow 가 발신 allow 로 새지 않는다', () => {
    expect(() => resolveOutboundRules([rule('inbound', 'allow', 'friend@example.com')], [])).toThrow(PolicyShapeError);
    // 스냅샷에는 두 방향이 다 있다 — resolvePolicy 는 발신 방향만 읽는다.
    const resolved = resolvePolicy(policyRow, { ...versionRow, snapshot: snapshotOf([rule('inbound', 'allow', 'in@example.com')]) }, []);
    expect(resolved.allowlist).toEqual([]);
  });

  it('옛 config_json.allowlist/blocklist 는 판정에 들어오지 않는다(정책 v2 — 목록은 agent_contact_rules 만)', () => {
    const resolved = resolvePolicy(
      { ...policyRow, config_json: { ...CONFIG_JSON, allowlist: ['old@example.com'], blocklist: {} } },
      { ...versionRow, snapshot: {} },
      [],
    );
    expect(resolved.allowlist).toEqual([]);
    expect(resolved.blocklist).toEqual([]);
  });
});

describe('resolvePolicy — 허용 목록은 좁게, 차단 목록은 넓게 (V1 MINOR-2)', () => {
  it('allowlist 는 소문자화만(`+tag` 보존), blocklist 주소는 판정형(`+tag` 절단), 도메인 값은 그대로', () => {
    const resolved = resolvePolicy(policyRow, {
      ...versionRow,
      snapshot: snapshotOf([
        rule('outbound', 'allow', ' Sales+EU@Corp.com '),
        rule('outbound', 'allow', 'partner.example'),
        rule('outbound', 'block', 'Victim+x@Gmail.com'),
        rule('outbound', 'block', '*.spam.example'),
      ]),
    }, []);
    expect(resolved.allowlist).toEqual(['sales+eu@corp.com', 'partner.example']);
    expect(resolved.blocklist).toEqual(['victim@gmail.com', '*.spam.example']);
    expect(resolved.agentRequestedAllowlist).toEqual([]);
  });
});

describe('resolvePolicy — 에이전트가 요청해 생긴 발신 allow 주소 규칙(보안 감사 H-1)', () => {
  it('스냅샷의 규칙 id 가 요청 출처면 agentRequestedAllowlist 에 싣는다 — 허용 판정 목록(allowlist)은 그대로', () => {
    const requested = { ...rule('outbound', 'allow', 'Attacker@Evil.example'), id: 'rule-req' };
    const owned = { ...rule('outbound', 'allow', 'friend@example.com'), id: 'rule-own' };
    const domain = { ...rule('outbound', 'allow', 'evil.example'), id: 'rule-dom' };
    const block = { ...rule('outbound', 'block', 'x@evil.example'), id: 'rule-blk' };
    const resolved = resolvePolicy(policyRow, { ...versionRow, snapshot: snapshotOf([requested, owned, domain, block]) }, ['rule-req', 'rule-dom', 'rule-blk', 'not-in-snapshot']);
    expect(resolved.allowlist).toEqual(['attacker@evil.example', 'friend@example.com', 'evil.example']);
    expect(resolved.agentRequestedAllowlist).toEqual(['attacker@evil.example']);
  });
});

describe('메일 기본기 2차 D6·A2 — Stage 6 첨부 총량 = min(정책, 요금제, 천장 25 MiB) (AC-A2-5)', () => {
  const MIB = 1024 * 1024;
  const withPolicyMax = (bytes: number): PolicySourceResult['policy'] => ({
    ...policyRow,
    config_json: { ...policyRow.config_json, max_attachment_bytes_total: bytes, allowed_mime_types: ['application/pdf'] },
  });
  const verdictFor = async (plan: 'free' | 'beta' | 'scale', policyMax: number, totalBytes: number) => {
    const input = await loadEvaluationInput(sourceOf({ entitlements: entitlementRow(plan), policy: withPolicyMax(policyMax) }), {
      ...request,
      attempt: { ...request.attempt, attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', bytes: totalBytes }] },
    });
    return { max: input.policy.content.maxAttachmentBytesTotal, decision: evaluate(input.ctx, input.policy) };
  };

  it('Free 조직 6 MiB → denied(attachment_bytes_exceeded) · Beta 6 MiB → 첨부 거부 없음', async () => {
    const free = await verdictFor('free', 10 * MIB, 6 * MIB);
    expect(free.max).toBe(5 * MIB);
    expect(free.decision.reasons).toContain('attachment_bytes_exceeded');
    const beta = await verdictFor('beta', 10 * MIB, 6 * MIB);
    expect(beta.max).toBe(10 * MIB);
    expect(beta.decision.reasons).not.toContain('attachment_bytes_exceeded');
  });

  it('Scale 에이전트 정책 30 MiB → 천장 25 MiB 적용(26 MiB 거부 · 25 MiB 통과)', async () => {
    const over = await verdictFor('scale', 30 * MIB, 26 * MIB);
    expect(over.max).toBe(25 * MIB);
    expect(over.decision.reasons).toContain('attachment_bytes_exceeded');
    const at = await verdictFor('scale', 30 * MIB, 25 * MIB);
    expect(at.decision.reasons).not.toContain('attachment_bytes_exceeded');
  });

  it('정책 값이 null(프로비저닝 기본 — "요금제를 따른다") → min(요금제, 천장): Free 5 · Team 20 · Scale 25 MiB · 키 없음은 여전히 거부', async () => {
    const withNull = (plan: 'free' | 'team' | 'scale') =>
      loadEvaluationInput(
        sourceOf({ entitlements: entitlementRow(plan), policy: { ...policyRow, config_json: { ...policyRow.config_json, max_attachment_bytes_total: null } } }),
        request,
      );
    expect((await withNull('free')).policy.content.maxAttachmentBytesTotal).toBe(5 * MIB);
    expect((await withNull('team')).policy.content.maxAttachmentBytesTotal).toBe(20 * MIB);
    expect((await withNull('scale')).policy.content.maxAttachmentBytesTotal).toBe(25 * MIB);
    const { max_attachment_bytes_total: _dropped, ...withoutKey } = policyRow.config_json as Record<string, unknown>;
    await expect(
      loadEvaluationInput(sourceOf({ policy: { ...policyRow, config_json: withoutKey as never } }), request),
    ).rejects.toThrow(/max_attachment_bytes_total/);
  });

  it('정책이 요금제보다 좁으면 정책 값 · 천장 상수 = 엔타이틀먼트 천장 = 업로드 천장', async () => {
    expect((await verdictFor('scale', 3 * MIB, 1)).max).toBe(3 * MIB);
    expect(ATTACHMENT_BYTES_TOTAL_CEILING).toBe(ENTITLEMENT_CEILINGS.attachmentBytesTotalMax);
    expect(ATTACHMENT_BYTES_TOTAL_CEILING).toBe(ATTACHMENT_BYTES_CEILING);
  });
});

describe('고객 도메인(ADR-0014 단계 0) — 로더가 바인딩 도메인을 접는다(규칙은 아직 읽지 않는다)', () => {
  const CUSTOM = 'agents.customer.com';
  const addresses = [
    { id: 'addr-1', agent_id: AGENT_ID, address: 'Agent@Atmark.ai', domain: 'atmark.ai', is_primary: true, created_at: NOW },
    { id: 'addr-2', agent_id: AGENT_ID, address: `bot@${CUSTOM}`, domain: CUSTOM, is_primary: false, created_at: NOW },
    { id: 'addr-3', agent_id: AGENT_ID, address: 'bot@old.customer.com', domain: 'old.customer.com', is_primary: false, created_at: NOW },
  ];
  const domainRow = (domain: string, status: 'verified' | 'suspended' | 'removed' | 'missing', reason: 'plan_limit' | 'ownership_lost' | null = null) => ({
    domain,
    status,
    suspended_reason: reason,
    sending_started_at: status === 'missing' ? null : new Date('2026-09-20T00:00:00Z'),
    recipients_last_day: 7,
  });

  it('atmark.ai → platform · verified → verified · plan_limit → plan_limit · removed·행 없음 → blocked · atmark.ai 발신이면 도메인 입력 없음', async () => {
    const input = await loadEvaluationInput(
      sourceOf({ addresses, customDomains: [domainRow(CUSTOM, 'verified'), domainRow('old.customer.com', 'removed')] }),
      request,
    );
    expect([...input.ctx.agent.boundDomains.entries()]).toEqual([
      ['atmark.ai', 'platform'],
      [CUSTOM, 'verified'],
      ['old.customer.com', 'blocked'],
    ]);
    expect(input.ctx.sendingDomain).toBeNull();
    expect(input.ctx.counters.domainRecipientsLastDay).toBe(0);

    const planLimited = await loadEvaluationInput(sourceOf({ addresses, customDomains: [domainRow(CUSTOM, 'suspended', 'plan_limit')] }), request);
    expect(planLimited.ctx.agent.boundDomains.get(CUSTOM)).toBe('plan_limit');
    expect(planLimited.ctx.agent.boundDomains.get('old.customer.com')).toBe('blocked'); // 소스에 행이 없다 = missing
  });

  it('고객 도메인으로 보내면 그 도메인의 워밍업 기준일 · 24시간 수신자를 싣는다 · 바인딩이 아닌 도메인이면 싣지 않는다', async () => {
    const source = sourceOf({ addresses, customDomains: [domainRow(CUSTOM, 'verified')] });
    const sending = await loadEvaluationInput(source, { ...request, attempt: { ...request.attempt, fromAddress: `Bot@${CUSTOM}` } });
    expect(sending.ctx.sendingDomain).toEqual({ domain: CUSTOM, sendingStartedAt: new Date('2026-09-20T00:00:00Z') });
    expect(sending.ctx.counters.domainRecipientsLastDay).toBe(7);
    const forged = await loadEvaluationInput(source, { ...request, attempt: { ...request.attempt, fromAddress: 'bot@elsewhere.com' } });
    expect(forged.ctx.sendingDomain).toBeNull();
    // 단계 0 — 관문 판정은 바뀌지 않는다(도메인 축을 읽는 규칙이 없다). 위조 발신은 여전히 Stage 1 이 막는다.
    expect(evaluate(forged.ctx, forged.policy).reasons).toEqual(['from_forgery']);
  });

  it('소스가 같은 도메인 행을 두 번 주면(계약 위반) 던진다 — 어느 행을 믿을지 고르지 않는다', async () => {
    await expect(
      loadEvaluationInput(sourceOf({ addresses, customDomains: [domainRow(CUSTOM, 'verified'), domainRow(CUSTOM, 'removed')] }), request),
    ).rejects.toThrow(/두 번/);
  });
});

describe('위험 신호(ADR-0016) — 로더만 riskHold 를 싣는다 · DLP 계열은 닫힌 집합으로 정규화', () => {
  const exposure = { level: 'T2' as const, exposedAt: new Date(NOW.getTime() - 60 * 60 * 1000), threadId: null, senderAddress: 'mallory@evil.example' };
  const signals = { load: () => Promise.resolve({ mode: 'enforce' as const, exposures: [exposure] }) };

  it('포트가 없으면 null · 있으면 창을 계산해 싣는다 · 릴리스면 포트를 부르지 않는다', async () => {
    expect((await loadEvaluationInput(sourceOf(), request)).ctx.approval.riskHold).toBeNull();
    expect((await loadEvaluationInput(sourceOf(), request, signals)).ctx.approval.riskHold).toEqual({
      enforce: true,
      agentTainted: true,
      threadTainted: false,
      taintedSenders: ['mallory@evil.example'],
    });
    let called = 0;
    const counting = { load: () => { called += 1; return signals.load(); } };
    const release = await loadEvaluationInput(sourceOf(), { ...request, release: { approvalId: '11111111-1111-4111-8111-111111111111', auditId: '22222222-2222-4222-8222-222222222222' } } as never, counting);
    expect(release.ctx.approval.riskHold).toBeNull();
    expect(called).toBe(0);
  });

  it('포트가 던지면 로더가 던진다(관문이 evaluation_error 로 닫는다)', async () => {
    await expect(loadEvaluationInput(sourceOf(), request, { load: () => Promise.reject(new Error('db down')) })).rejects.toThrow('db down');
  });

  it('DLP 계열 — 닫힌 순서 · 중복 제거 · 모르는 값은 scan_limit 으로 접는다(fail closed)', async () => {
    const dlpOf = async (dlp: readonly string[]) =>
      (await loadEvaluationInput(sourceOf(), { ...request, attempt: { ...request.attempt, dlp: dlp as never } })).ctx.attempt.dlp;
    expect(await dlpOf(['inbound_copy', 'atmark_credential', 'inbound_copy'])).toEqual(['atmark_credential', 'inbound_copy']);
    expect(await dlpOf(['made_up'])).toEqual(['scan_limit']);
    expect(await dlpOf([])).toEqual([]);
  });
});
