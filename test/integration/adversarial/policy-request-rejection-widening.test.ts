/**
 * 정책 변경 요청 **L-2 후속 적대 검증**(202610131600 — 2026-10-13 교차 감사의 L-2 우회) — 실제 Postgres · 앱 롤 · 실제 라우트.
 *
 * 소유자가 거절한 add_rule 은 24시간 동안 같은 지문뿐 아니라 **그 값을 덮는 값**으로도 다시 묻지 못한다(P0A58 → 409 `policy_request_recently_rejected`):
 *   - `+tag` 만 바꾼 같은 주소(태그 붙이기 · 떼기 · 바꾸기 · 대소문자).
 *   - 거절된 주소의 도메인 · 그 도메인을 덮는 `*.` 와일드카드(상위 도메인).
 *   - 거절된 도메인 · 와일드카드를 덮는 와일드카드.
 * 막지 않는 것(회귀): 좁히기(도메인 거절 뒤 그 도메인의 주소 하나) · 다른 방향 · 다른 목록 · 다른 주소 · 덮지 않는 와일드카드(정점 제외) · 24시간 뒤 ·
 * 다른 에이전트 · remove_rule 의 지문 일치(그대로).
 *
 * 실메일 0 · AWS 0.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decidePolicyRequestOp, listPolicyRequestsOp } from '../../../src/admin/ops/policy-requests';
import { handleCreatePolicyRequest, type PolicyRequestRouteDependencies } from '../../../src/api/routes/policy-requests';
import { toAgentId } from '../../../src/db/schema';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories';
import { createPostgresPolicyRequestStore } from '../../../src/db/repositories/policy-request-store';
import { hashAgentToken, issueAgentToken } from '../../../src/identity/agent-token';
import { policyRequestHash } from '../../../src/policy/policy-requests';
import { adminRolePool, appPool, AVAILABLE, ownerPool } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';

interface Agent {
  readonly agentId: string;
  readonly organizationId: string;
  readonly token: string;
}

type Body = Readonly<Record<string, string>>;

describe.skipIf(!AVAILABLE || !DATABASE_AVAILABLE)('정책 변경 요청 L-2 후속 — 거절 덮기 우회', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let api: PolicyRequestRouteDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    api = { tokens: createPostgresAgentTokenStore(app), policyRequests: createPostgresPolicyRequestStore(app), now: () => new Date() };
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end()]);
    await closeTestPool();
  });

  async function agentWithToken(): Promise<Agent> {
    const seed = await seedFixture(testPool());
    const issued = issueAgentToken(seed.agentId, ['messages:send', 'agent:read_self', 'policy:request']);
    await createPostgresAgentTokenStore(provisioningPool()).insert({ agentId: seed.agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
    return { agentId: seed.agentId, organizationId: seed.organizationId, token: issued.plaintext };
  }

  function rule(value: string, direction = 'outbound', list = 'allow', action = 'add_rule'): Body {
    return { action, direction, list, value, reason: 'please' };
  }

  async function create(a: Agent, body: Body): Promise<{ status: number; error: unknown; id: string }> {
    const response = await handleCreatePolicyRequest(api, { headers: { authorization: `Bearer ${a.token}` }, query: {}, body }, { agentId: 'me' });
    return { status: response.status, error: response.body['error'], id: String(response.body['request_id']) };
  }

  async function reject(a: Agent, requestId: string): Promise<void> {
    const user = await owner.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [`widen-${randomUUID()}@example.com`]);
    const outcome = await decidePolicyRequestOp(admin, {
      organizationId: a.organizationId,
      agentId: toAgentId(a.agentId),
      requestId,
      decision: 'reject',
      actor: 'admin:session:widen',
      userId: user.rows[0]?.id ?? '',
      now: new Date(),
    });
    expect(outcome.kind).toBe('rejected');
  }

  /** 새 에이전트에 `rejected` 를 요청 → 소유자 거절. */
  async function rejectedAgent(rejected: Body): Promise<Agent> {
    const a = await agentWithToken();
    const created = await create(a, rejected);
    expect(created.status, String(created.error)).toBe(202);
    await reject(a, created.id);
    return a;
  }

  const BLOCKED: [string, Body, Body][] = [
    ['+tag 붙이기', rule('ceo@corp.example'), rule('ceo+urgent@corp.example')],
    ['+tag 떼기', rule('ceo+urgent@corp.example'), rule('ceo@corp.example')],
    ['+tag 바꾸기', rule('ceo+a@corp.example'), rule('ceo+b@corp.example')],
    ['대소문자', rule('ceo@corp.example'), rule('CEO+X@Corp.Example')],
    ['주소 → 그 도메인', rule('ceo@corp.example'), rule('corp.example')],
    ['하위 도메인 주소 → 상위 와일드카드', rule('ceo@mail.corp.example'), rule('*.corp.example')],
    ['하위 도메인 주소 → 더 위 와일드카드', rule('ceo@a.b.corp.example'), rule('*.corp.example')],
    ['도메인 → 그것을 덮는 와일드카드', rule('mail.corp.example'), rule('*.corp.example')],
    ['와일드카드 → 같은 와일드카드(대소문자)', rule('*.corp.example'), rule('*.CORP.example')],
    ['와일드카드 → 더 넓은 와일드카드', rule('*.mail.corp.example'), rule('*.corp.example')],
    ['수신 차단 목록도 같은 규칙', rule('spam@corp.example', 'inbound', 'block'), rule('spam+1@corp.example', 'inbound', 'block')],
    ['수신 허용 · 주소 → 도메인', rule('news@list.example', 'inbound', 'allow'), rule('list.example', 'inbound', 'allow')],
    ['발신 차단 · 주소 → 와일드카드', rule('x@a.corp.example', 'outbound', 'block'), rule('*.corp.example', 'outbound', 'block')],
  ];

  for (const [label, first, second] of BLOCKED) {
    it(`★ 거절 뒤 ${label} — 409 policy_request_recently_rejected · 요청 행 0`, async () => {
      const a = await rejectedAgent(first);
      const before = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM policy_change_requests WHERE agent_id = $1', [a.agentId]);
      const again = await create(a, second);
      expect([again.status, again.error]).toEqual([409, 'policy_request_recently_rejected']);
      const after = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM policy_change_requests WHERE agent_id = $1', [a.agentId]);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });
  }

  const ALLOWED: [string, Body, Body][] = [
    ['좁히기(도메인 → 그 도메인의 주소)', rule('corp.example'), rule('ceo@corp.example')],
    ['좁히기(와일드카드 → 하위 와일드카드)', rule('*.corp.example'), rule('*.mail.corp.example')],
    ['정점은 와일드카드가 덮지 않는다(주소)', rule('ceo@corp.example'), rule('*.corp.example')],
    ['정점은 와일드카드가 덮지 않는다(도메인)', rule('corp.example'), rule('*.corp.example')],
    ['정확 도메인은 하위 도메인 주소를 덮지 않는다', rule('ceo@mail.corp.example'), rule('corp.example')],
    ['접미사 경계(orp.example ≠ corp.example)', rule('ceo@x.corp.example'), rule('*.orp.example')],
    ['다른 로컬파트', rule('ceo@corp.example'), rule('cfo@corp.example')],
    ['다른 방향', rule('ceo@corp.example', 'outbound'), rule('ceo+x@corp.example', 'inbound')],
    ['다른 목록', rule('ceo@corp.example', 'outbound', 'allow'), rule('ceo+x@corp.example', 'outbound', 'block')],
  ];

  for (const [label, first, second] of ALLOWED) {
    it(`회귀 — ${label} 는 막지 않는다(202)`, async () => {
      const a = await rejectedAgent(first);
      const again = await create(a, second);
      expect(again.status, String(again.error)).toBe(202);
    });
  }

  it('★ 덮는 값도 24시간이 지나면 된다 · 다른 에이전트의 거절은 세지 않는다', async () => {
    const a = await agentWithToken();
    const token = await owner.query<{ id: string }>('SELECT id::text AS id FROM agent_api_keys WHERE token_hash = $1', [hashAgentToken(a.token)]);
    await owner.query(
      `INSERT INTO policy_change_requests (agent_id, organization_id, token_id, action, direction, list, value, reason, request_hash, base_version, tainted,
                                           status, created_at, expires_at, decided_at, decided_by)
       VALUES ($1, $2, $3::uuid, 'add_rule', 'outbound', 'allow', 'ceo@corp.example', 'old', $4, 1, false, 'rejected',
               now() - interval '26 hours', now() - interval '26 hours' + interval '7 days', now() - interval '25 hours', 'admin:session:x')`,
      [a.agentId, a.organizationId, token.rows[0]?.id, policyRequestHash({ action: 'add_rule', direction: 'outbound', list: 'allow', value: 'ceo@corp.example' })],
    );
    expect((await create(a, rule('corp.example'))).status).toBe(202);

    const victim = await rejectedAgent(rule('boss@corp.example'));
    expect(victim.agentId).not.toBe(a.agentId);
    const other = await agentWithToken();
    expect((await create(other, rule('boss+1@corp.example'))).status).toBe(202);
  });

  it('★ set_mode 는 지문 일치 그대로 — 같은 모드 재요청은 409 · 다른 모드는 다른 질문(202)', async () => {
    const a = await agentWithToken();
    const mode = await create(a, { action: 'set_mode', direction: 'inbound', mode: 'allowlist', reason: 'please' });
    expect(mode.status, String(mode.error)).toBe(202);
    await reject(a, mode.id);
    const again = await create(a, { action: 'set_mode', direction: 'inbound', mode: 'allowlist', reason: 'again' });
    expect([again.status, again.error]).toEqual([409, 'policy_request_recently_rejected']);
    // 다른 모드는 다른 질문이다.
    expect((await create(a, { action: 'set_mode', direction: 'inbound', mode: 'blocklist', reason: 'please' })).status).toBe(202);
  });

  it('★ L-3 콘솔 — 24시간 안에 같은 방향 · 목록의 add_rule 을 거절했으면 대기 요청에 recentRejections(좁힌 재요청도 사람이 본다) · 다른 목록은 0', async () => {
    const a = await rejectedAgent(rule('corp.example'));
    const narrowed = await create(a, rule('ceo@corp.example'));
    expect(narrowed.status).toBe(202);
    const other = await create(a, rule('x@else.example', 'inbound', 'allow'));
    expect(other.status).toBe(202);
    const list = await listPolicyRequestsOp(admin, a.organizationId, toAgentId(a.agentId), 'pending', new Date());
    const byId = new Map(list.items.map((item) => [item.id, item.recentRejections]));
    expect(byId.get(narrowed.id)).toBe(1);
    expect(byId.get(other.id)).toBe(0);
  });

  it('SQL 덮기 판정 표 — 주소 · 도메인 · 와일드카드 · NULL', async () => {
    const cases: [string, string | null, boolean][] = [
      ['a@d.example', 'a+x@d.example', true],
      ['a+y@d.example', 'a+x@d.example', true],
      ['b@d.example', 'a@d.example', false],
      ['d.example', 'a@d.example', true],
      ['d.example', 'a@m.d.example', false],
      ['*.d.example', 'a@m.d.example', true],
      ['*.d.example', 'a@d.example', false],
      ['*.d.example', '*.m.d.example', true],
      ['*.m.d.example', '*.d.example', false],
      ['d.example', '*.d.example', false],
      ['a@d.example', 'd.example', false],
      ['*.d.example', null, false],
    ];
    for (const [next, rejected, expected] of cases) {
      const result = await owner.query<{ v: boolean }>('SELECT atmark_policy_request_rule_covers($1, $2) AS v', [next, rejected]);
      expect(result.rows[0]?.v, `${next} ⊇ ${String(rejected)}`).toBe(expected);
    }
    // 앱 롤은 이 함수를 직접 부르지 못한다(정의자 안에서만).
    await expect(app.query("SELECT atmark_policy_request_rule_covers('a@d.example', 'a@d.example')")).rejects.toMatchObject({ code: '42501' });
  });
});
