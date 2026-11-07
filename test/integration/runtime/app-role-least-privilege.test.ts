/**
 * **앱 롤 최소 권한 · 가드 트리거** — 실제 Postgres 위에서 (202609230750, ADR-0006 보강 — 2차 적대적 검증).
 *
 *   - H-A · H-B 재현: 검증자가 `atmark_app` 으로 해 보인 문장을 **그대로** 다시 보내 전부 거부되는 것을 본다.
 *   - `agent_api_keys.revoked_at` 쓰기 1회 — 소유자 롤·admin 롤 모두 되살리지 못하고, 폐기·회전은 그대로 된다.
 *   - 예약 로컬파트 — DB 목록 = TS `RESERVED_LOCAL_PARTS`(같은 순서·같은 값), DB 가 거부한다.
 *   - `sender_relationships` 가드 · `audit_logs` `allowed` 가드 · 정지 중 승인 불가(L-A) · 운영자 정지는 소유자 롤만(7) ·
 *     `TEMPORARY` 없음(L-D).
 *
 * `TEST_DATABASE_URL`(앱 롤) / `TEST_MIGRATION_DATABASE_URL`(소유자 롤)이 없으면 건너뛴다. 쓰는 행은 전부 새 조직·새 에이전트다.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approveRequest, rejectRequest } from '../../../src/approval/service';
import { createPostgresApprovalStore } from '../../../src/db/repositories';
import { ApprovalBlockedByPauseError } from '../../../src/db/repositories/approval-store';
import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, issueAgentToken } from '../../../src/identity/agent-token';
import { buildAgentAddress, OPERATOR_ASSIGNABLE_ADDRESSES, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { revokeAgentTokensOp, setAgentSuspendedOp } from '../../../src/admin/ops/agents';
import { ADMIN_ROLE_URL, adminRolePool, loginMailerPool } from '../admin/support';
import {
  closeTestPool,
  codeOf,
  DATABASE_AVAILABLE,
  hex64,
  provisioningPool,
  rolledBack,
  seedFixture,
  seedMessage,
  testPool,
  type Fixture,
} from '../db/support/harness';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '' && ADMIN_ROLE_URL.trim() !== '';

/** 관문이 여는 모양의 승인 대기 하나(요청 → audit 대기 행 → 항목). 앱 롤로 연다 — 운영과 같은 권한. */
async function openApproval(app: Pool, fixture: Fixture, recipient = 'bob@example.com'): Promise<{ approvalId: string; auditId: string }> {
  const messageId = await seedMessage(app, fixture.agentId);
  const approvalId = randomUUID();
  const createdAt = new Date(Date.now() - 1000);
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES ($1, $2, 'message', $3, $4)`,
      [approvalId, fixture.agentId, createdAt, new Date(createdAt.getTime() + 24 * 3_600_000)],
    );
    const audit = await client.query<{ id: string }>(
      `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version, approval_id)
       VALUES ($1, $2, 'pending_approval', ARRAY['approval_required'], $3, 1, $4) RETURNING id`,
      [fixture.agentId, messageId, fixture.policyVersionId, approvalId],
    );
    await client.query(
      `INSERT INTO approval_request_items (approval_id, message_id, audit_id, from_address, recipients, is_thread_reply, thread_id, cost_cents)
       VALUES ($1, $2, $3, $4, $5::text[], false, NULL, 0)`,
      [approvalId, messageId, audit.rows[0]?.id, fixture.address, [recipient]],
    );
    await client.query('COMMIT');
    return { approvalId, auditId: audit.rows[0]?.id ?? '' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!AVAILABLE)('앱 롤 최소 권한 · 가드 (202609230750)', () => {
  let app: Pool;
  let owner: Pool;
  let admin: Pool;
  beforeAll(() => {
    app = testPool();
    owner = provisioningPool();
    admin = adminRolePool();
  });
  afterAll(async () => {
    await admin.end();
    await closeTestPool();
  });

  it('H-B — 앱 롤은 백도어 에이전트를 심지 못한다: 조직·에이전트·주소(예약 포함)·토큰·키·여권·정책·버전 INSERT 전부 42501', async () => {
    const victim = await seedFixture(app);
    const agentId = toAgentId(hex64().slice(0, 32));
    const token = issueAgentToken(victim.agentId);
    const attempts: readonly (readonly [string, readonly unknown[]])[] = [
      [`INSERT INTO organizations (name, billing_status, owner_email) VALUES ('evil', 'active', 'evil@attacker.example')`, []],
      [`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, 'backdoor', 'active', 'free', 1)`, [agentId, victim.organizationId]],
      [`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, 'login@atmark.ai', 'atmark.ai', false)`, [victim.agentId]],
      [`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, 'notify-team@atmark.ai', 'atmark.ai', false)`, [victim.agentId]],
      [`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, '{messages:send}')`, [victim.agentId, token.tokenHash]],
      [`INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref) VALUES ($1, $2, 'ed25519', 'devfile://x')`, [victim.agentId, 'A'.repeat(43)]],
      [`INSERT INTO passports (agent_id, did, controller, version) VALUES ($1, $2, 'did:web:id.atmark.ai', 1)`, [victim.agentId, `did:web:id.atmark.ai:agents:${victim.agentId}`]],
      [`INSERT INTO agent_policies (agent_id) VALUES ($1)`, [agentId]],
      [`INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 2, 'unrestricted', '{}'::jsonb)`, [victim.agentId]],
    ];
    for (const [sql, values] of attempts) expect(await codeOf(() => app.query(sql, [...values])), sql).toBe('42501');
  });

  it('H-B — 주소 가로채기 · H-A — 정책 해제 · 폐기 토큰 부활 · 억제 목록 지우기: UPDATE·DELETE 전부 42501', async () => {
    const victim = await seedFixture(app);
    const attacker = await seedFixture(app);
    const attempts: readonly (readonly [string, readonly unknown[]])[] = [
      [`UPDATE agent_addresses SET agent_id = $2 WHERE agent_id = $1`, [victim.agentId, attacker.agentId]],
      [`UPDATE agent_policies SET outbound_mode = 'unrestricted' WHERE agent_id = $1`, [victim.agentId]],
      [`UPDATE agent_api_keys SET revoked_at = NULL WHERE agent_id = $1`, [victim.agentId]],
      // last_used_at 은 202609241400(US-007)부터 앱 롤이 한 칸만 앞으로 쓸 수 있다 — 다른 칸은 여전히 42501.
      [`UPDATE agent_api_keys SET expires_at = now() WHERE agent_id = $1`, [victim.agentId]],
      [`DELETE FROM suppression_entries WHERE organization_id = $1`, [victim.organizationId]],
      [`INSERT INTO suppression_entries (organization_id, address, domain, source) VALUES ($1, 'x@example.com', 'example.com', 'complaint')`, [victim.organizationId]],
      [`UPDATE webhook_endpoints SET url = 'https://evil.example/' WHERE agent_id = $1`, [victim.agentId]],
      [`UPDATE inbound_messages SET quarantined = false WHERE agent_id = $1`, [victim.agentId]],
      [`UPDATE messages SET subject = 'x' WHERE agent_id = $1`, [victim.agentId]],
    ];
    for (const [sql, values] of attempts) expect(await codeOf(() => app.query(sql, [...values])), sql).toBe('42501');
  });

  it('H-A ① — 앱 롤은 "처음부터 승인된 요청" 을 만들지 못하고, 릴리스 일정·알림 행을 직접 만들지 못한다', async () => {
    const fixture = await seedFixture(app);
    const now = new Date();
    expect(
      await codeOf(() =>
        app.query(
          `INSERT INTO approval_requests (id, agent_id, subject, status, created_at, expires_at, decided_at, decided_by, granted_scope)
           VALUES ($1, $2, 'message', 'approved', $3, $4, $3, 'x', 'recipient')`,
          [randomUUID(), fixture.agentId, now, new Date(now.getTime() + 3_600_000)],
        ),
      ),
    ).toBe('42501');
    const { approvalId } = await openApproval(app, fixture);
    const item = await app.query<{ message_id: string; audit_id: string }>('SELECT message_id, audit_id FROM approval_request_items WHERE approval_id = $1', [approvalId]);
    const row = item.rows[0];
    expect(
      await codeOf(() =>
        app.query(
          `INSERT INTO approval_releases (message_id, approval_id, audit_id, agent_id, next_release_at, deadline_at)
           VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour')`,
          [row?.message_id, approvalId, row?.audit_id, fixture.agentId],
        ),
      ),
    ).toBe('42501');
    // 트리거는 그대로 만든다(SECURITY DEFINER) — 요청 INSERT 가 알림 행 1개를 남겼다.
    const notifications = await app.query('SELECT 1 FROM approval_notifications WHERE approval_id = $1', [approvalId]);
    expect(notifications.rowCount).toBe(1);
  });

  it('H-A ④ — 앱 롤은 seed·owner_provisioning 관계를 못 만들고, approved 관계는 승인된 자기 요청만 가리킨다 (소유자·admin 은 seed 를 만든다)', async () => {
    const fixture = await seedFixture(app);
    const other = await seedFixture(app);
    const seed = (pool: Pool, address: string) =>
      pool.query(
        `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
        [fixture.agentId, address],
      );
    expect(await codeOf(() => seed(app, 'seed-app@example.com'))).toBe('42501');
    expect(await codeOf(() => seed(owner, `seed-owner-${randomUUID()}@example.com`))).toBe('ok');
    expect(await codeOf(() => seed(admin, `seed-admin-${randomUUID()}@example.com`))).toBe('ok');

    const { approvalId } = await openApproval(app, fixture);
    const approved = (agentId: string, address: string) =>
      app.query(
        `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_via_approval_id, granted_by)
         VALUES ($1, 'recipient', $2, 'approved', $3, 'owner')`,
        [agentId, address, approvalId],
      );
    // 대기 중 요청을 가리키는 approved 관계 — 모든 롤에서 거부(소유자 포함).
    expect(await codeOf(() => approved(fixture.agentId, 'pending@example.com'))).toBe('23514');
    // 결정 경로 그대로(같은 트랜잭션: 요청 approved → 관계) — 된다.
    const store = createPostgresApprovalStore(app);
    const outcome = await approveRequest(store, { approvalId, decidedBy: 'owner@example.com', now: new Date(), scope: 'recipient', confirmScope: null });
    expect(outcome.kind).toBe('approved');
    // 승인된 요청이어도 **다른 에이전트**의 관계로는 못 쓴다.
    expect(await codeOf(() => approved(other.agentId, 'cross@example.com'))).toBe('23514');
  });

  it('H-A ⑤ — 대기 audit 행은 승인된 요청 없이 allowed 가 되지 못한다(모든 롤) · denied 는 된다', async () => {
    const fixture = await seedFixture(app);
    const { auditId } = await openApproval(app, fixture);
    for (const pool of [app, owner]) {
      expect(await codeOf(() => pool.query(`UPDATE audit_logs SET decision = 'allowed', approved_by = 'x' WHERE id = $1`, [auditId]))).toBe('23514');
    }
    expect(
      await codeOf(() =>
        app.query(`UPDATE audit_logs SET decision = 'denied', resolved_at = now(), resolution_reason = 'approval_rejected' WHERE id = $1`, [auditId]),
      ),
    ).toBe('ok');
  });

  it('② revoked_at 은 쓰기 1회 — 소유자 롤도 admin 롤도 되살리거나 고쳐 쓰지 못한다 · 폐기·회전(CLI·admin)은 그대로 된다', async () => {
    const fixture = await seedFixture(app);
    const first = issueAgentToken(fixture.agentId);
    await owner.query(`INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, '{messages:send}')`, [fixture.agentId, first.tokenHash]);
    // admin 롤의 회전(`revokeAgentTokensOp` — 콘솔과 CLI 가 같은 함수).
    const rotated = await revokeAgentTokensOp(admin, fixture.agentId, 'rotate', { capabilities: ['messages:send'], expiresAt: null });
    expect(rotated.revoked).toBe(1);
    // 소유자 롤(CLI)의 revoke-all.
    expect((await revokeAgentTokensOp(owner, fixture.agentId, 'revoke-all', { capabilities: [], expiresAt: null })).revoked).toBe(1);
    for (const pool of [owner, admin]) {
      expect(await codeOf(() => pool.query('UPDATE agent_api_keys SET revoked_at = NULL WHERE token_hash = $1', [first.tokenHash]))).toBe('23514');
      expect(
        await codeOf(() => pool.query(`UPDATE agent_api_keys SET revoked_at = now() + interval '1 day' WHERE token_hash = $1`, [first.tokenHash])),
      ).toBe('23514');
    }
    const row = await owner.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM agent_api_keys WHERE token_hash = $1', [
      hashAgentToken(first.plaintext),
    ]);
    expect(row.rows[0]?.revoked).toBe(true);
  });

  it('③ 예약 로컬파트 — DB 목록은 TS RESERVED_LOCAL_PARTS 와 같고(순서·값), DB 가 그 주소를 거부한다(정확 일치만 — TS 와 같다)', async () => {
    const listed = await owner.query<{ parts: string[] }>('SELECT atmark_reserved_local_parts() AS parts');
    expect(listed.rows[0]?.parts).toEqual([...RESERVED_LOCAL_PARTS]);
    const fixture = await seedFixture(app);
    await rolledBack(owner, async (client) => {
      for (const part of RESERVED_LOCAL_PARTS) {
        await client.query('SAVEPOINT s');
        const state = await codeOf(() =>
          client.query(`INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, 'atmark.ai')`, [fixture.agentId, `${part}@atmark.ai`]),
        );
        await client.query('ROLLBACK TO SAVEPOINT s');
        // 운영자 예약 주소(202609301500 — support@·onve@·abuse@·postmaster@)는 CHECK 를 지나고 허가 가드가 42501 로 막는다(이 조직에 허가 없음).
        expect(state, part).toBe((OPERATOR_ASSIGNABLE_ADDRESSES as readonly string[]).includes(`${part}@atmark.ai`) ? '42501' : '23514');
        expect(() => buildAgentAddress(part), part).toThrow(/reserved_local_part/);
      }
      // 접두 규칙은 TS 에도 없다 — 둘 다 받는다(한쪽만 넓히면 여기서 갈린다).
      for (const part of ['notify-team', 'postmaster2', 'my-abuse']) {
        expect(buildAgentAddress(part)).toBe(`${part}@atmark.ai`);
        await client.query(`INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, 'atmark.ai')`, [fixture.agentId, `${part}-${randomUUID().slice(0, 8)}@atmark.ai`]);
      }
    });
  });

  it('L-A — 조직 정지·동결 중에는 승인이 성립하지 않는다: 저장소가 사유로 거부 · 관계 0 · 요청 pending · DB 트리거도 거부 · 거절은 된다', async () => {
    for (const column of ['owner_paused', 'abuse_freeze'] as const) {
      const fixture = await seedFixture(app);
      const { approvalId } = await openApproval(app, fixture, `paused-${column}@example.com`);
      await owner.query(`UPDATE organizations SET ${column} = true WHERE id = $1`, [fixture.organizationId]);
      const store = createPostgresApprovalStore(app);
      await expect(
        approveRequest(store, { approvalId, decidedBy: 'owner@example.com', now: new Date(), scope: 'recipient', confirmScope: null }),
      ).rejects.toThrow(ApprovalBlockedByPauseError);
      const relationships = await app.query('SELECT 1 FROM sender_relationships WHERE granted_via_approval_id = $1', [approvalId]);
      expect(relationships.rowCount).toBe(0);
      expect((await store.find(approvalId))?.status).toBe('pending');
      // 앱 코드를 건너뛴 raw UPDATE(앱 롤이 가진 결정 칸)도 DB 가 막는다.
      expect(
        await codeOf(() =>
          app.query(`UPDATE approval_requests SET status = 'approved', decided_at = now(), decided_by = 'x', granted_scope = 'recipient' WHERE id = $1`, [approvalId]),
        ),
      ).toBe('55000');
      // 거절은 안전 방향이라 된다.
      expect(await rejectRequest(store, { approvalId, decidedBy: 'owner@example.com', now: new Date() })).toBe(true);
    }
  });

  it('7 — admin 롤은 운영자 정지를 raw UPDATE 로 풀지 못하고 운영자 정지를 걸지도 못한다 · 소유자 정지는 그대로 · 소유자 롤(CLI)은 운영자 정지를 푼다', async () => {
    const fixture = await seedFixture(app);
    await setAgentSuspendedOp(owner, fixture.agentId, true, 'operator');
    for (const sql of [
      `UPDATE agents SET status = 'active', suspended_by = NULL WHERE id = $1`,
      `UPDATE agents SET suspended_by = 'owner' WHERE id = $1`,
    ]) {
      expect(await codeOf(() => admin.query(sql, [fixture.agentId])), sql).toBe('42501');
    }
    await setAgentSuspendedOp(owner, fixture.agentId, false, 'operator');

    expect(await codeOf(() => admin.query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [fixture.agentId]))).toBe('42501');
    // 소유자 정지·해제(콘솔 경로)는 된다.
    expect((await setAgentSuspendedOp(admin, fixture.agentId, true, 'owner')).suspendedBy).toBe('owner');
    expect((await setAgentSuspendedOp(admin, fixture.agentId, false, 'owner')).status).toBe('active');
    // 소유자 롤은 소유자 정지를 넘겨받아 운영자 정지로 바꿀 수 있다(CLI kill-switch).
    await setAgentSuspendedOp(admin, fixture.agentId, true, 'owner');
    expect((await setAgentSuspendedOp(owner, fixture.agentId, true, 'operator')).suspendedBy).toBe('operator');
  });

  it('L-D — 앱·admin·로그인 메일 롤은 임시 테이블을 만들지 못한다', async () => {
    const mailer = loginMailerPool();
    try {
      for (const pool of [app, admin, mailer]) {
        expect(await codeOf(() => pool.query('CREATE TEMP TABLE temp_probe (id int)'))).toBe('42501');
      }
    } finally {
      await mailer.end();
    }
  });
});
