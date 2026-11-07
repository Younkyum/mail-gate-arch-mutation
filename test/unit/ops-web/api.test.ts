/**
 * 운영자 웹 화면 `/api/*` 쓰기 — **CLI 와 같은 함수**를 부르고, 확인 입력 없이는 아무것도 부르지 않는다(DB 없이 — 가짜 풀·가짜 연산).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - `OPS` 의 함수가 CLI 가 부르는 바로 그 참조다(`reviewOrganizationOp` · `setOrgPlanOp` · `releaseToProviderOp` · `setOrganizationFreezeOp` ·
 *     `setAgentSuspendedOp`) — 웹이 SQL 을 따로 쓰지 않는다.
 *   - 확인 입력(조직 표시 이름)이 없거나 다르면 422 이고 연산은 불리지 않는다 · 거절·조직 정지 켜기는 `CONFIRM` 도.
 *   - 요금제 쓰기는 결제 운영자 풀로만(없으면 409 `billing_operator_missing`) · 덮어쓰기는 CLI 파서(천장 초과 거부) · 행위자 `admin:web:<운영자>`.
 *   - 에이전트 정지는 행위자 `operator` 로.
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { setAgentSuspendedOp, setOrganizationFreezeAuditedOp } from '../../../src/admin/ops/agents';
import { AdminInputError } from '../../../src/admin/ops/errors';
import { ENTITLEMENT_CEILINGS } from '../../../src/billing/plans';
import { reviewOrganizationOp } from '../../../scripts/admin/org-review';
import { releaseToProviderOp, setOrgPlanOp } from '../../../scripts/admin/plan';
import { ACK_WORD, displayName, handleApi, ID_PREFIX_LENGTH, OPS, requireConfirmation, type ApiContext, type OpsFunctions } from '../../../scripts/ops-web/api';
import type { WriteRecord } from '../../../scripts/ops-web/audit-log';

const ORG = '11111111-2222-4333-8444-555555555555';
const AGENT = 'a'.repeat(32);
const NAME = 'Acme 조직';
const ENTRY = '11111111-2222-4333-8444-555555555555';

function fakePool(label: string): Pool {
  return {
    label,
    query: vi.fn(async (sql: string) => {
      if (/SELECT name FROM organizations WHERE id/.test(sql)) return { rows: [{ name: NAME }], rowCount: 1 };
      if (/SELECT organization_id FROM agents WHERE id/.test(sql)) return { rows: [{ organization_id: ORG }], rowCount: 1 };
      if (/SELECT email, status FROM waitlist_entries WHERE id/.test(sql)) return { rows: [{ email: 'wait@example.com', status: 'waiting' }], rowCount: 1 };
      throw new Error(`unexpected SQL in unit test: ${sql}`);
    }),
  } as unknown as Pool;
}

function spies(): { [K in keyof OpsFunctions]: ReturnType<typeof vi.fn> } {
  return {
    reviewOrganization: vi.fn(async () => ({ from: 'pending_review', changed: true, suspended: [], revokedTokens: 0, plan: null })),
    setOrgPlan: vi.fn(async () => ({ changed: true, version: 2, fromPlan: 'free' })),
    releaseToProvider: vi.fn(async () => ({ changed: true, version: 3, fromPlan: 'beta' })),
    setOrganizationFreeze: vi.fn(async () => ({ changed: true })),
    setAgentSuspended: vi.fn(async () => ({ status: 'suspended', suspendedBy: 'operator', changed: true })),
    inviteWaitlistEntry: vi.fn(async () => ({ entryId: ENTRY, fromStatus: 'waiting', inviteExpiresAt: '2026-10-14T00:00:00.000Z' })),
    inviteOldestWaitlist: vi.fn(async () => [{ entryId: ENTRY, inviteExpiresAt: '2026-10-14T00:00:00.000Z' }]),
    removeWaitlistEntry: vi.fn(async () => ({ entryId: ENTRY, fromStatus: 'waiting' })),
  };
}

function context(withOperator = true): { ctx: ApiContext; ops: ReturnType<typeof spies>; owner: Pool; operator: Pool | null; records: WriteRecord[] } {
  const records: WriteRecord[] = [];
  const ops = spies();
  const owner = fakePool('owner');
  const operator = withOperator ? fakePool('operator') : null;
  const ctx: ApiContext = {
    owner,
    operator,
    target: { target: 'local', host: 'localhost', port: 5432, database: 'atmark_v2', user: 'jin', reasons: [] },
    actor: 'admin:web:jin',
    audit: (record) => records.push(record),
    idleMinutes: 30,
    maxHours: 8,
    ops: ops as unknown as OpsFunctions,
    now: () => new Date('2026-09-27T00:00:00Z'),
  };
  return { ctx, ops, owner, operator, records };
}

const post = (ctx: ApiContext, path: string, body: unknown) => handleApi(ctx, 'POST', path, new URLSearchParams(), body);

async function rejected(promise: Promise<unknown>): Promise<AdminInputError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdminInputError);
  return error as AdminInputError;
}

describe('OPS = CLI 의 그 함수', () => {
  it('참조가 같다', () => {
    expect(OPS.reviewOrganization).toBe(reviewOrganizationOp);
    expect(OPS.setOrgPlan).toBe(setOrgPlanOp);
    expect(OPS.releaseToProvider).toBe(releaseToProviderOp);
    expect(OPS.setOrganizationFreeze).toBe(setOrganizationFreezeAuditedOp);
    expect(OPS.setAgentSuspended).toBe(setAgentSuspendedOp);
  });

  it('displayName — 제어문자·줄바꿈을 지운 한 줄, 비면 id', () => {
    expect(displayName('악성\u001b[31m이름\n가짜', ORG)).not.toMatch(/[\u0000-\u001f]/);
    expect(displayName('​', ORG)).toBe(ORG);
  });
});

describe('검토 승인·거절', () => {
  it('확인 없음·다른 이름 → 422, 연산을 부르지 않는다', async () => {
    const { ctx, ops } = context();
    for (const body of [{ decision: 'activate' }, { decision: 'activate', confirm: 'Acme' }, { decision: 'activate', confirm: '' }]) {
      const error = await rejected(post(ctx, `/api/orgs/${ORG}/review`, body));
      expect([error.status, error.code]).toEqual([422, 'confirmation_required']);
    }
    expect(ops.reviewOrganization).not.toHaveBeenCalled();
  });

  it('승인 — 이름이 맞으면 CLI 함수(소유자 풀 · active · 웹 행위자)', async () => {
    const { ctx, ops, owner } = context();
    const result = await post(ctx, `/api/orgs/${ORG}/review`, { decision: 'activate', confirm: ` ${NAME} ` });
    expect(result.status).toBe(200);
    expect(ops.reviewOrganization).toHaveBeenCalledWith(owner, ORG, 'active', 'admin:web:jin');
  });

  it('거절(되돌릴 수 없다) — 이름이 아니라 조직 id 앞 8자리 + CONFIRM', async () => {
    const { ctx, ops, owner } = context();
    const error = await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'reject', confirm: NAME, ack: ACK_WORD }));
    expect(error.code).toBe('confirmation_required');
    await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'reject', confirm: ORG.slice(0, 8) }));
    await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'reject', confirm: ORG.slice(0, 8), ack: 'confirm' }));
    await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'reject', confirm: ORG.slice(0, 7), ack: ACK_WORD }));
    expect(ops.reviewOrganization).not.toHaveBeenCalled();
    expect(ID_PREFIX_LENGTH).toBe(8);
    await post(ctx, `/api/orgs/${ORG}/review`, { decision: 'reject', confirm: ` ${ORG.slice(0, 8).toUpperCase()} `, ack: ACK_WORD });
    expect(ops.reviewOrganization).toHaveBeenCalledWith(owner, ORG, 'rejected', 'admin:web:jin');
  });

  it('decision 이 이상하면 400 · 조직 id 모양이 아니면 400', async () => {
    const { ctx, ops } = context();
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'delete', confirm: NAME }))).code).toBe('invalid_decision');
    expect((await rejected(post(ctx, '/api/orgs/not-a-uuid/review', { decision: 'activate', confirm: NAME }))).code).toBe('invalid_organization');
    expect(ops.reviewOrganization).not.toHaveBeenCalled();
  });
});

describe('대기자 명단(202609301520)', () => {
  it('초대 · 지우기 — 확인 입력 = 대상 주소(대소문자 무관) · 틀리면 422 · 소유자 풀 + 웹 행위자 · 기록 한 줄씩', async () => {
    const { ctx, ops, owner, records } = context();
    for (const sub of ['invite', 'remove'] as const) {
      const error = await rejected(post(ctx, `/api/waitlist/${ENTRY}/${sub}`, { confirm: 'other@example.com' }));
      expect([error.status, error.code]).toEqual([422, 'confirmation_required']);
    }
    expect(ops.inviteWaitlistEntry).not.toHaveBeenCalled();
    expect(ops.removeWaitlistEntry).not.toHaveBeenCalled();
    expect((await post(ctx, `/api/waitlist/${ENTRY}/invite`, { confirm: ' WAIT@example.com ' })).status).toBe(200);
    expect(ops.inviteWaitlistEntry).toHaveBeenCalledWith(owner, ENTRY, 'admin:web:jin');
    expect((await post(ctx, `/api/waitlist/${ENTRY}/remove`, { confirm: 'wait@example.com' })).status).toBe(200);
    expect(ops.removeWaitlistEntry).toHaveBeenCalledWith(owner, ENTRY, 'admin:web:jin');
    expect(records.map((r) => [r.action, r.target, r.result])).toEqual([
      ['waitlist.invite', ENTRY, 'confirmation_required'],
      ['waitlist.remove', ENTRY, 'confirmation_required'],
      ['waitlist.invite', ENTRY, 'ok'],
      ['waitlist.remove', ENTRY, 'ok'],
    ]);
  });

  it('가장 오래 기다린 N 명 — n 은 1~50 정수 · 확인 = 그 수 · 항목 id 모양이 아니면 400', async () => {
    const { ctx, ops, owner } = context();
    expect((await rejected(post(ctx, '/api/waitlist/invite-oldest', { n: 51, confirm: '51' }))).code).toBe('invalid_count');
    expect((await rejected(post(ctx, '/api/waitlist/invite-oldest', { n: 3, confirm: '4' }))).code).toBe('confirmation_required');
    expect((await rejected(post(ctx, '/api/waitlist/not-a-uuid/invite', { confirm: 'x' }))).code).toBe('invalid_entry');
    expect(ops.inviteOldestWaitlist).not.toHaveBeenCalled();
    const result = await post(ctx, '/api/waitlist/invite-oldest', { n: 3, confirm: '3' });
    expect(result.body).toEqual({ waitlist: { invited: 1 } });
    expect(ops.inviteOldestWaitlist).toHaveBeenCalledWith(owner, 3, 'admin:web:jin');
  });
});

describe('요금제', () => {
  it('결제 운영자 풀이 없으면 409 — 소유자 풀로 떨어지지 않는다', async () => {
    const { ctx, ops } = context(false);
    const error = await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'beta', confirm: NAME }));
    expect([error.status, error.code]).toEqual([409, 'billing_operator_missing']);
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan/release`, { confirm: NAME }))).code).toBe('billing_operator_missing');
    expect(ops.setOrgPlan).not.toHaveBeenCalled();
    expect(ops.releaseToProvider).not.toHaveBeenCalled();
  });

  it('확인이 맞으면 운영자 풀로 setOrgPlanOp — 덮어쓰기·유예·사유가 CLI 모양으로', async () => {
    const { ctx, ops, operator } = context();
    await post(ctx, `/api/orgs/${ORG}/plan`, {
      plan: 'team',
      overrides: { max_agents: 20 },
      graceUntil: '2027-03-01T00:00:00Z',
      note: '  파트너  ',
      confirm: NAME,
    });
    expect(ops.setOrgPlan).toHaveBeenCalledWith(operator, {
      organizationId: ORG,
      plan: 'team',
      overrides: { max_agents: 20 },
      graceUntil: new Date('2027-03-01T00:00:00Z'),
      actor: 'admin:web:jin',
      note: '파트너',
    });
    await post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'beta', graceUntil: 'clear', confirm: NAME });
    expect(ops.setOrgPlan).toHaveBeenLastCalledWith(operator, expect.objectContaining({ plan: 'beta', graceUntil: null, overrides: {}, note: null }));
    await post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'beta', graceUntil: 'keep', confirm: NAME });
    expect(ops.setOrgPlan).toHaveBeenLastCalledWith(operator, expect.objectContaining({ graceUntil: undefined }));
  });

  it('입력 거부는 확인보다 먼저 — 모르는 요금제·모르는 칸·천장 초과·이상한 유예', async () => {
    const { ctx, ops } = context();
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'gold', confirm: NAME }))).code).toBe('invalid_plan');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'pro', overrides: { nope: 1 }, confirm: NAME }))).code).toBe('invalid_override');
    expect(
      (await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'pro', overrides: { max_agents: ENTITLEMENT_CEILINGS.maxAgents + 1 }, confirm: NAME }))).code,
    ).toBe('over_ceiling');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'pro', overrides: { max_agents: -1 }, confirm: NAME }))).code).toBe('invalid_override');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'pro', graceUntil: 'tomorrow', confirm: NAME }))).code).toBe('invalid_grace');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'pro', confirm: 'x' }))).code).toBe('confirmation_required');
    expect(ops.setOrgPlan).not.toHaveBeenCalled();
  });

  it('결제에 넘기기 — 확인 뒤 releaseToProviderOp(운영자 풀)', async () => {
    const { ctx, ops, operator } = context();
    await rejected(post(ctx, `/api/orgs/${ORG}/plan/release`, {}));
    expect(ops.releaseToProvider).not.toHaveBeenCalled();
    await post(ctx, `/api/orgs/${ORG}/plan/release`, { confirm: NAME });
    expect(ops.releaseToProvider).toHaveBeenCalledWith(operator, { organizationId: ORG, actor: 'admin:web:jin' });
  });
});

describe('킬스위치', () => {
  it('조직 정지 켜기는 id 앞 8자리 + CONFIRM · 끄기는 이름 + 사유 필수 · 소유자 풀로 감사되는 setOrganizationFreezeAuditedOp(행위자 admin:web)', async () => {
    const { ctx, ops, owner } = context();
    await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: true, confirm: NAME, ack: ACK_WORD }));
    await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: true, confirm: ORG.slice(0, 8) }));
    await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: 'yes', confirm: ORG.slice(0, 8), ack: ACK_WORD }));
    expect(ops.setOrganizationFreeze).not.toHaveBeenCalled();
    await post(ctx, `/api/orgs/${ORG}/freeze`, { on: true, confirm: ORG.slice(0, 8), ack: ACK_WORD });
    expect(ops.setOrganizationFreeze).toHaveBeenLastCalledWith(owner, { organizationId: ORG, on: true, actor: 'admin:web:jin', reason: null });
    // 해제는 사유 없이는 거부(쓰기 전) — 감사 없는 해제는 평판 창을 남겨 곧바로 다시 언다.
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: false, confirm: NAME }))).code).toBe('reason_required');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: false, confirm: NAME, reason: '   ' }))).code).toBe('reason_required');
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/freeze`, { on: false, confirm: NAME, reason: 7 }))).code).toBe('invalid_reason');
    expect(ops.setOrganizationFreeze).toHaveBeenCalledTimes(1);
    await post(ctx, `/api/orgs/${ORG}/freeze`, { on: false, confirm: NAME, reason: 'list cleaned' });
    expect(ops.setOrganizationFreeze).toHaveBeenLastCalledWith(owner, { organizationId: ORG, on: false, actor: 'admin:web:jin', reason: 'list cleaned' });
  });

  it('에이전트 정지 — 그 에이전트 조직의 이름 · 행위자 operator', async () => {
    const { ctx, ops, owner } = context();
    await rejected(post(ctx, `/api/agents/${AGENT}/suspend`, { on: true }));
    expect((await rejected(post(ctx, '/api/agents/zzz/suspend', { on: true, confirm: NAME }))).code).toBe('invalid_agent');
    expect(ops.setAgentSuspended).not.toHaveBeenCalled();
    await post(ctx, `/api/agents/${AGENT}/suspend`, { on: true, confirm: NAME });
    expect(ops.setAgentSuspended).toHaveBeenCalledWith(owner, AGENT, true, 'operator');
  });
});

describe('라우팅', () => {
  it('모르는 경로·메서드는 404 · 본문이 객체가 아니면 400', async () => {
    const { ctx } = context();
    expect((await handleApi(ctx, 'DELETE', `/api/orgs/${ORG}`, new URLSearchParams(), undefined)).status).toBe(404);
    expect((await handleApi(ctx, 'GET', '/api/nope', new URLSearchParams(), undefined)).status).toBe(404);
    expect((await rejected(post(ctx, `/api/orgs/${ORG}/review`, ['activate']))).code).toBe('invalid_body');
  });

  it('세션 — CSRF · 행위자 · 대상 · 요금제 쓰기 가능 여부', async () => {
    const { ctx } = context(false);
    const result = await handleApi(ctx, 'GET', '/api/session', new URLSearchParams(), undefined);
    expect(result.body).toMatchObject({ actor: 'admin:web:jin', billingOperator: false, idleMinutes: 30, maxHours: 8, target: { kind: 'local' } });
    expect(result.body).not.toHaveProperty('csrf');
  });
});

describe('확인 비교 — NFC', () => {
  it('조합형(NFD)으로 입력해도 완성형 이름과 같다 · 보이는 글자가 다른 이름은 거부', () => {
    const target = { id: ORG, name: '한글 조직' };
    expect(() => requireConfirmation({ confirm: '한글 조직'.normalize('NFD') }, target, 'name')).not.toThrow();
    expect(() => requireConfirmation({ confirm: '한글 조직' }, { id: ORG, name: '한글 조직'.normalize('NFD') }, 'name')).not.toThrow();
    expect(() => requireConfirmation({ confirm: '한글조직' }, target, 'name')).toThrow(AdminInputError);
  });
});

describe('쓰기 기록 — 성공·실패 모두, 비밀·이름 없이', () => {
  it('실패(확인 틀림)와 성공이 각각 한 줄 — 행위 · 대상 id · 결과 · 요약', async () => {
    const { ctx, records } = context();
    await rejected(post(ctx, `/api/orgs/${ORG}/review`, { decision: 'activate', confirm: 'x' }));
    await post(ctx, `/api/orgs/${ORG}/review`, { decision: 'activate', confirm: NAME });
    await post(ctx, `/api/orgs/${ORG}/freeze`, { on: false, confirm: NAME, reason: 'cleaned' });
    await post(ctx, `/api/orgs/${ORG}/plan`, { plan: 'beta', confirm: NAME, note: '비밀 아닌 사유' });
    await rejected(post(ctx, '/api/orgs/zzz/plan', { plan: 'beta' }));
    await post(ctx, `/api/agents/${AGENT}/suspend`, { on: true, confirm: NAME });
    expect(records.map((r) => [r.action, r.target, r.result])).toEqual([
      ['review.activate', ORG, 'confirmation_required'],
      ['review.activate', ORG, 'ok'],
      ['freeze.off', ORG, 'ok'],
      ['plan.set', ORG, 'ok'],
      ['plan.set', 'invalid', 'invalid_organization'],
      ['agent.suspend', AGENT, 'ok'],
    ]);
    expect(records.every((r) => r.actor === 'admin:web:jin' && r.at === '2026-09-27T00:00:00.000Z')).toBe(true);
    expect(records[1]?.summary).toContain('changed=true');
    expect(records[3]?.summary).toBe('changed=true v=2');
    const text = JSON.stringify(records);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('비밀 아닌 사유');
  });

  it('읽기는 기록하지 않는다', async () => {
    const { ctx, records } = context();
    await handleApi(ctx, 'GET', '/api/catalog', new URLSearchParams(), undefined);
    expect(records).toEqual([]);
  });
});

describe('읽기 집계 — 대시보드 · 요금제 · 긴급 정지(DB 없이)', () => {
  function aggregatePool(): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM organizations\s*$/.test(sql.trim()) || /AS signups_week/.test(sql)) return { rows: [{ pending: 2, active: 5, rejected: 1, frozen: 1, signups_day: 1, signups_week: 3 }] };
        if (/AS provisioning/.test(sql)) return { rows: [{ active: 7, suspended: 1, provisioning: 2, total: 10 }] };
        if (/signup_source = 'self_signup'\s+ORDER BY/.test(sql)) {
          return { rows: [{ id: ORG, name: 'Acme\u0007 조직', owner_email: 'a@b.example', review_status: 'pending_review', created_at: new Date('2026-09-26T23:00:00Z'), agents: 1 }] };
        }
        if (/FROM messages/.test(sql)) {
          return {
            rows: [
              { in_day: true, direction: 'outbound', status: 'sent', count: 3 },
              { in_day: false, direction: 'outbound', status: 'sent', count: 4 },
              { in_day: true, direction: 'outbound', status: 'dispatching', count: 1 },
              { in_day: false, direction: 'outbound', status: 'pending', count: 2 },
              { in_day: true, direction: 'outbound', status: 'denied', count: 5 },
              { in_day: false, direction: 'outbound', status: 'failed', count: 6 },
              { in_day: true, direction: 'inbound', status: 'received', count: 8 },
            ],
          };
        }
        if (/coalesce\(e\.plan_code, 'none'\)/.test(sql)) return { rows: [{ plan: 'beta', organizations: 4 }, { plan: 'none', organizations: 2 }] };
        if (/FROM org_entitlements/.test(sql)) return { rows: [] };
        if (/WHERE abuse_freeze/.test(sql)) return { rows: [{ id: ORG, name: NAME, owner_email: null, review_status: 'active', updated_at: new Date('2026-09-26T00:00:00Z') }] };
        if (/suspended_by = 'operator'/.test(sql)) return { rows: [{ id: AGENT, name: 'bot', address: 'bot@x.example', organization_id: ORG, organization_name: NAME, updated_at: new Date('2026-09-26T00:00:00Z') }] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    } as unknown as Pool;
    return { pool, calls };
  }
  const get = (ctx: ApiContext, path: string) => handleApi(ctx, 'GET', path, new URLSearchParams(), undefined);

  it('대시보드 — 창은 ctx.now 기준(24시간 · 7일) · 상태를 묶어 센다(대기 = pending + dispatching) · 이름 정화 · 쓰기 0', async () => {
    const { ctx, ops, records } = context();
    const { pool, calls } = aggregatePool();
    const body = (await get({ ...ctx, owner: pool }, '/api/dashboard')).body as Record<string, any>;
    const messages = calls.find((c) => /FROM messages/.test(c.sql));
    // 창은 [now - 창, now) — 위쪽 끝(ctx.now)을 둔다(고정 시각 창에 지금 들어오는 행이 섞이지 않게).
    expect(messages?.params).toEqual([new Date('2026-09-26T00:00:00Z'), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-27T00:00:00Z')]);
    expect(messages?.sql).toMatch(/created_at >= \$2 AND created_at < \$3/);
    const orgs = calls.find((c) => /signups_day/.test(c.sql));
    expect(orgs?.params).toEqual([new Date('2026-09-26T00:00:00Z'), new Date('2026-09-20T00:00:00Z'), new Date('2026-09-27T00:00:00Z')]);
    expect(body['sending']).toEqual({ day: { sent: 3, denied: 5, failed: 0, queued: 1, received: 8 }, week: { sent: 7, denied: 5, failed: 6, queued: 3, received: 8 } });
    expect(body['organizations']).toEqual({ pendingReview: 2, active: 5, rejected: 1, frozen: 1 });
    expect(body['signups']).toEqual({ day: 1, week: 3 });
    expect(body['agents']).toEqual({ active: 7, suspended: 1, provisioning: 2, total: 10 });
    expect(body['recentSignups'][0]).toMatchObject({ id: ORG, name: 'Acme 조직', reviewStatus: 'pending_review' });
    for (const call of calls) expect(call.sql, call.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(Object.values(ops).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(records).toEqual([]);
  });

  it('요금제 분포 — 요금제 코드 전부 + 행 없음, 없는 것은 0 · 긴급 정지 목록', async () => {
    const { ctx } = context();
    const { pool } = aggregatePool();
    const plans = (await get({ ...ctx, owner: pool }, '/api/plans')).body as { counts: unknown[]; items: unknown[] };
    expect(plans.counts).toEqual([
      { plan: 'free', organizations: 0 },
      { plan: 'beta', organizations: 4 },
      { plan: 'pro', organizations: 0 },
      { plan: 'team', organizations: 0 },
      { plan: 'scale', organizations: 0 },
      { plan: 'none', organizations: 2 },
    ]);
    const kill = (await get({ ...ctx, owner: pool }, '/api/killswitch')).body as Record<string, any>;
    expect(kill['frozenOrganizations']).toEqual([{ id: ORG, name: NAME, ownerEmail: null, reviewStatus: 'active', updatedAt: '2026-09-26T00:00:00.000Z' }]);
    expect(kill['suspendedAgents'][0]).toMatchObject({ id: AGENT, address: 'bot@x.example', organizationId: ORG, organizationName: NAME });
  });

  it('POST 로는 없다(읽기 전용)', async () => {
    const { ctx } = context();
    for (const path of ['/api/dashboard', '/api/plans', '/api/killswitch']) expect((await post(ctx, path, {})).status).toBe(404);
  });
});
