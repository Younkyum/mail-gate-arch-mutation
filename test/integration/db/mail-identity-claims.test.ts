/**
 * 에이전트 주소 ↔ 사람 이메일 상호 배제(ADR-0014 결정 7 · 202609291110, critic 1·3 · 보안 M1 반영판) — 실제 Postgres 위에서.
 *
 *   - TS `mailClaimKey` = SQL `atmark_mail_claim_key`(같은 표 — `+` 로 시작하는 로컬파트는 전체를 쓴다) · 해시 = sha256(키).
 *   - 멤버였던 사람(`human_member`: 멤버십 · 소유자 주소) ↔ 에이전트: 어느 쪽이 먼저든 P0A01.
 *   - 초대만 받은 사람(`human_invitee`)은 에이전트에게 진다: claim 이 지워지고 대기 초대가 취소된다 · 그 뒤 수락(멤버십 INSERT) · 새 초대는 P0A01.
 *   - 사람 주소는 어느 조직이든 지금 쥔 고객 도메인에 있을 수 없다(보안 M1).
 *   - 에이전트 claim 은 톰스톤 · 사람 claim 은 주소 지우기로 풀린다 · 백필 분류 · 결제 롤만 판정 함수.
 *
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다. 전부 소유자 트랜잭션 안에서 하고 되돌린다.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOMAIN_SQLSTATES } from '../../../src/domains/contract';
import { mailClaimKey } from '../../../src/identity/address';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, rolledBack, seedFixture, stateOf, testPool, type Fixture } from './support/harness';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
const AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '';
const CONFLICT = DOMAIN_SQLSTATES.mailIdentityConflict;

/** 조직의 verified 고객 도메인 하나(트랜잭션 안 — 기능 허용 포함). */
async function verifiedDomain(client: PoolClient, organizationId: string): Promise<string> {
  await client.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [organizationId]);
  const registrable = `mc${randomBytes(5).toString('hex')}.com`;
  const domain = `agents.${registrable}`;
  const row = await client.query<{ id: string }>(
    `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, domain, registrable, randomBytes(32).toString('base64url')],
  );
  const id = row.rows[0]?.id;
  await client.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [id]);
  await client.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [id]);
  return domain;
}

const addAlias = (client: PoolClient, agentId: string, address: string): Promise<string> =>
  stateOf(client, `INSERT INTO agent_addresses (agent_id, address, domain) VALUES ($1, $2, split_part($2, '@', 2))`, [agentId, address]);
const addUser = (client: PoolClient, email: string): Promise<string> => stateOf(client, 'INSERT INTO users (email) VALUES ($1)', [email]);

async function userId(client: PoolClient, email: string): Promise<string> {
  return (await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]?.id ?? '';
}

const addMembership = (client: PoolClient, user: string, organizationId: string, role = 'member'): Promise<string> =>
  stateOf(client, `INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'operator')`, [user, organizationId, role]);

async function kindsOf(client: PoolClient, email: string): Promise<string[]> {
  return (
    await client.query<{ kind: string }>(`SELECT kind FROM mail_identity_claims WHERE claim_hash = atmark_mail_claim_hash($1) ORDER BY kind, source_table`, [email])
  ).rows.map((row) => row.kind);
}

describe.skipIf(!AVAILABLE)('mail_identity_claims (202609291110)', () => {
  let fixture: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    fixture = await seedFixture(testPool());
    other = await seedFixture(testPool());
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('판정형 키 TS = SQL(같은 표 — `+` 로 시작하면 로컬파트 전체) · 해시 = sha256(키)', async () => {
    const inputs = [
      'bob@agents.c.com',
      'Bob+Sales@Agents.C.com',
      'bob+a+b@x.com',
      'a@b@c.com',
      'x.y_z-w@Example.ORG',
      '+tag@X.com',
      '++@x.com',
      'no-at-sign',
      '@x.com',
      'bob@',
      'agent@atmark.ai',
    ];
    const rows = await provisioningPool().query<{ input: string; key: string | null; hash: Buffer | null }>(
      'SELECT i AS input, atmark_mail_claim_key(i) AS key, atmark_mail_claim_hash(i) AS hash FROM unnest($1::text[]) AS i',
      [inputs],
    );
    expect(rows.rows).toHaveLength(inputs.length);
    for (const row of rows.rows) {
      expect(row.key, row.input).toBe(mailClaimKey(row.input));
      const expected = row.key === null ? null : createHash('sha256').update(row.key, 'utf8').digest('hex');
      expect(row.hash === null ? null : Buffer.from(row.hash).toString('hex'), row.input).toBe(expected);
    }
    expect(mailClaimKey('+tag@X.com')).toBe('+tag@x.com');
  });

  it('멤버였던 사람 ↔ 에이전트는 어느 쪽이 먼저든 P0A01(+tag · 대소문자 무관) · 소유자 주소도 멤버다', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const domain = await verifiedDomain(client, fixture.organizationId);
      // 에이전트가 먼저 — 사용자·소유자 주소 불가.
      expect(await addAlias(client, fixture.agentId, `bob@${domain}`)).toBe('ok');
      expect(await addUser(client, `bob+x@${domain}`)).toBe(CONFLICT);
      expect(await stateOf(client, 'UPDATE organizations SET owner_email = $2 WHERE id = $1', [other.organizationId, `Bob@${domain}`.toLowerCase()])).toBe(CONFLICT);
    });
    await rolledBack(provisioningPool(), async (client) => {
      // 사람이(멤버) 먼저 — 그 주소의 도메인이 아직 아무에게도 없을 때 가입했다. 그 뒤 같은 도메인을 고객 도메인으로 쥐어도 그 로컬파트는 에이전트가 못 된다.
      const registrable = `mh${randomBytes(5).toString('hex')}.com`;
      const email = `carol@agents.${registrable}`;
      expect(await addUser(client, email)).toBe('ok');
      expect(await addMembership(client, await userId(client, email), other.organizationId)).toBe('ok');
      expect(await kindsOf(client, email)).toEqual(['human_invitee', 'human_member']);
      await client.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [
        fixture.organizationId,
      ]);
      const row = await client.query<{ id: string }>(
        `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fixture.organizationId, `agents.${registrable}`, registrable, randomBytes(32).toString('base64url')],
      );
      await client.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
      await client.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
      expect(await addAlias(client, fixture.agentId, email)).toBe(CONFLICT);
      expect(await addAlias(client, fixture.agentId, `dave@agents.${registrable}`)).toBe('ok');
    });
  });

  it('초대만 받은 사람은 에이전트에게 진다 — claim 삭제 · 대기 초대 취소 · 그 뒤 수락·새 초대는 P0A01', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const registrable = `mi${randomBytes(5).toString('hex')}.com`;
      const invitee = `erin@agents.${registrable}`;
      // 초대하는 조직(other) — 활성 · owner 멤버.
      const inviter = `owner-${randomBytes(4).toString('hex')}@example.com`;
      expect(await addUser(client, inviter)).toBe('ok');
      expect(await addMembership(client, await userId(client, inviter), other.organizationId, 'owner')).toBe('ok');
      // 도메인이 아직 아무에게도 없을 때 other 가 erin@ 을 초대했다(선점 시도).
      expect(await addUser(client, invitee)).toBe('ok');
      const inviteeId = await userId(client, invitee);
      const invite = await client.query<{ id: string }>(
        `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day')) RETURNING id`,
        [other.organizationId, inviteeId, await userId(client, inviter)],
      );
      expect(await kindsOf(client, invitee)).toEqual(['human_invitee']);
      // fixture 조직이 그 도메인을 증명하고 erin@ 을 에이전트로 — 초대는 이긴다.
      await client.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [
        fixture.organizationId,
      ]);
      const row = await client.query<{ id: string }>(
        `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fixture.organizationId, `agents.${registrable}`, registrable, randomBytes(32).toString('base64url')],
      );
      await client.query(`UPDATE custom_domains SET status = 'verifying', txt_verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
      await client.query(`UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1`, [row.rows[0]?.id]);
      expect(await addAlias(client, fixture.agentId, invitee)).toBe('ok');
      expect(await kindsOf(client, invitee)).toEqual(['agent']);
      const revoked = await client.query<{ revoked: boolean; status: string }>('SELECT revoked_at IS NOT NULL AS revoked, status::text AS status FROM org_invites WHERE id = $1', [
        invite.rows[0]?.id,
      ]);
      expect(revoked.rows[0]).toEqual({ revoked: true, status: 'obsolete' });
      // 닫힌 쪽 — 그 사용자는 멤버가 될 수 없고 다시 초대할 수도 없다.
      expect(await addMembership(client, inviteeId, other.organizationId)).toBe(CONFLICT);
      expect(
        await stateOf(
          client,
          `INSERT INTO org_invites (organization_id, user_id, role, invited_by_user_id, expires_at)
           VALUES ($1, $2, 'member', $3, date_trunc('milliseconds', now() + interval '1 day'))`,
          [other.organizationId, inviteeId, await userId(client, inviter)],
        ),
      ).toBe(CONFLICT);
    });
  });

  it('에이전트 전용 도메인(누가 쥐었든)의 주소는 사람이 될 수 없다(보안 M1)', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const domain = await verifiedDomain(client, fixture.organizationId);
      expect(await addUser(client, `nobody@${domain}`)).toBe(CONFLICT);
      expect(await stateOf(client, 'UPDATE organizations SET owner_email = $2 WHERE id = $1', [other.organizationId, `owner@${domain}`])).toBe(CONFLICT);
      // 하위·형제 도메인은 쥔 것이 아니다.
      expect(await addUser(client, `someone@sub.${domain}`)).toBe('ok');
    });
  });

  it('에이전트 claim 은 톰스톤 — 폐기해도 남고 지울 수 없다 · 사람 claim 은 주소 지우기로 풀린다 · 판정 함수', async () => {
    await rolledBack(provisioningPool(), async (client) => {
      const domain = await verifiedDomain(client, fixture.organizationId);
      expect(await addAlias(client, fixture.agentId, `dan@${domain}`)).toBe('ok');
      await client.query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [`dan@${domain}`]);
      expect(await stateOf(client, `DELETE FROM mail_identity_claims WHERE claim_hash = atmark_mail_claim_hash($1)`, [`dan@${domain}`])).toBe('23514');
      expect(await stateOf(client, `UPDATE mail_identity_claims SET kind = 'human_member' WHERE claim_hash = atmark_mail_claim_hash($1)`, [`dan@${domain}`])).toBe(
        '23514',
      );

      const email = `frank-${randomBytes(4).toString('hex')}@example.com`;
      expect(await addUser(client, email)).toBe('ok');
      const id = await userId(client, email);
      expect(await addMembership(client, id, other.organizationId)).toBe('ok');
      // 초대만 받은 사용자 지우기와 같은 쓰기(자리표시 + erased_at — 소유자 롤) → claim 이 모두 풀리고 자리표시는 claim 을 잡지 않는다.
      await client.query(`UPDATE users SET email = 'erased-' || id::text || '@erased.invalid', erased_at = now() WHERE id = $1`, [id]);
      const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_identity_claims WHERE source_table = 'users' AND source_id = $1`, [id]);
      expect(left.rows[0]?.n).toBe(0);

      const isAgent = async (address: string): Promise<boolean> =>
        (await client.query<{ yes: boolean }>('SELECT atmark_is_agent_mail_identity($1) AS yes', [address])).rows[0]?.yes ?? false;
      expect(await isAgent(`Dan+Billing@${domain.toUpperCase()}`)).toBe(true);
      expect(await isAgent(`nobody@${domain}`)).toBe(false);
      expect(await isAgent(fixture.address)).toBe(true);
    });
  });

  it('백필 — 에이전트 주소 · 사용자(멤버였으면 member, 아니면 invitee) · 소유자 주소마다 claim · 교집합 0 · 결제 롤만 판정 함수', async () => {
    const owner = provisioningPool();
    const missing = await owner.query<{ agents: number; users: number; orgs: number; conflicts: number }>(
      `SELECT
         (SELECT count(*)::int FROM agent_addresses x WHERE NOT EXISTS (
            SELECT 1 FROM mail_identity_claims c WHERE c.source_table = 'agent_addresses' AND c.source_id = x.id::text AND c.kind = 'agent'
              AND c.claim_hash = atmark_mail_claim_hash(x.address))) AS agents,
         (SELECT count(*)::int FROM users u WHERE split_part(u.email, '@', 2) <> 'erased.invalid' AND NOT EXISTS (
            SELECT 1 FROM mail_identity_claims c WHERE c.source_table = 'users' AND c.source_id = u.id::text
              AND c.kind = CASE WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) THEN 'human_member' ELSE 'human_invitee' END)) AS users,
         (SELECT count(*)::int FROM organizations o WHERE o.owner_email IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM mail_identity_claims c WHERE c.source_table = 'organizations' AND c.source_id = o.id::text AND c.kind = 'human_member')) AS orgs,
         (SELECT count(*)::int FROM mail_identity_claims x JOIN mail_identity_claims y ON y.claim_hash = x.claim_hash
           WHERE x.kind = 'agent' AND y.kind = 'human_member') AS conflicts`,
    );
    expect(missing.rows[0]).toEqual({ agents: 0, users: 0, orgs: 0, conflicts: 0 });
    const executors = await owner.query<{ role: string; can: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'atmark_is_agent_mail_identity(text)', 'EXECUTE') AS can
         FROM unnest(ARRAY['atmark_billing', 'atmark_app', 'atmark_admin']) AS r ORDER BY r`,
    );
    expect(executors.rows).toEqual([
      { role: 'atmark_admin', can: false },
      { role: 'atmark_app', can: false },
      { role: 'atmark_billing', can: true },
    ]);
    const claimFunction = await owner.query<{ can: boolean }>(
      `SELECT bool_or(has_function_privilege(r, 'atmark_claim_mail_identity(text, text, text, text)', 'EXECUTE')) AS can
         FROM unnest(ARRAY['atmark_billing', 'atmark_app', 'atmark_admin', 'atmark_login_mailer', 'atmark_domain_tick']) AS r`,
    );
    expect(claimFunction.rows[0]?.can).toBe(false);
  });
});
