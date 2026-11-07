/**
 * 서명 DB 롤(`atmark_passport_signer`)의 권한 · passport 전이/문서 가드 — **실제 Postgres**(마이그레이션 202609241200).
 *
 *   ① 실제 권한 = `RESTRICTED_ROLE_GRANTS[atmark_passport_signer]`(카탈로그 ACL 대조) · 소유·멤버십·위험 속성 0 · migrate `status` 가 넘치는 권한을 잡는다.
 *   ② 서명 롤은 조직·토큰·메시지 제목·정책을 **못 읽고**, passport 의 정체 칸(did·agent_id)을 못 바꾸고, 문서를 지우지 못한다.
 *   ③ admin 롤은 passport 버전을 위조하지 못한다(INSERT 는 있으나 서명 문서를 넣을 수 없어 커밋이 거부된다) · 앱 롤은 outbox·문서에 못 쓴다.
 *   ④ 전이 가드: 제자리 전이는 draft→published 하나 · 버전 건너뛰기·대체 전 INSERT·revoked 뒤 새 버전 거부 · 문서는 해시·JWS 페이로드가 맞아야 ·
 *      문서 UPDATE/DELETE 거부 · outbox 종단 불변 · requested_by 모양.
 * 전부 **롤백되는 트랜잭션** 안에서 한다(공유 DB 에 흔적을 남기지 않는다).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { createMigrateHandler, type MigrationStatus } from '../../../src/runtime/handlers/migrate';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { inspectRestrictedRole, PASSPORT_SIGNER_ROLE, RESTRICTED_ROLE_GRANTS } from '../../../src/runtime/role-bootstrap';
import { APP_URL, AVAILABLE, OWNER_URL } from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

async function rolledBack(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** 세이브포인트 안에서 문장 하나가 **거부되는지** 본다(바깥 트랜잭션은 살린다). */
async function rejects(client: PoolClient, sql: string, params: unknown[] = [], pattern?: RegExp): Promise<void> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    throw new Error(`거부돼야 했다: ${sql.slice(0, 80)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('거부돼야 했다')) throw error;
    if (pattern !== undefined) expect((error as Error).message).toMatch(pattern);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT probe');
  }
}

const agentId = (): string => randomBytes(16).toString('hex');
const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const didOf = (agent: string): string => `did:web:id.atmark.ai:agents:${agent}`;

/** 조직·에이전트·draft passport v1 을 심는다(소유자 롤, 열린 트랜잭션). */
async function seedDraft(client: PoolClient): Promise<{ agent: string; passportId: string }> {
  const agent = agentId();
  const org = await client.query<{ id: string }>(`INSERT INTO organizations (name, billing_status) VALUES ($1, 'active') RETURNING id`, [`pp-${agent.slice(0, 8)}`]);
  await client.query(`INSERT INTO agents (id, organization_id, name, status) VALUES ($1, $2, 'pp', 'active')`, [agent, org.rows[0]?.id]);
  const passport = await client.query<{ id: string }>(
    `INSERT INTO passports (agent_id, did, controller) VALUES ($1, $2, 'did:web:id.atmark.ai') RETURNING id`,
    [agent, didOf(agent)],
  );
  return { agent, passportId: passport.rows[0]?.id ?? '' };
}

/** 문서 한 벌(해시·JWS 페이로드가 맞는). 서명 부분은 모양만 — DB 는 서명을 검증하지 않는다(그건 외부 검증기의 일). */
function documentFor(text: string): { document: string; jws: string; hash: string } {
  return { document: text, jws: `${b64url('{"alg":"EdDSA"}')}.${b64url(text)}.c2ln`, hash: sha(text) };
}

async function publishInPlace(client: PoolClient, passportId: string, text = '{"v":1}'): Promise<void> {
  const doc = documentFor(text);
  await client.query(`UPDATE passports SET status = 'published', metadata_uri = 'https://id.atmark.ai/x', content_hash = $2 WHERE id = $1`, [passportId, doc.hash]);
  await client.query(`INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, $2, $3, now(), now() + interval '90 days')`, [
    passportId,
    doc.document,
    doc.jws,
  ]);
}

describe.skipIf(!AVAILABLE)('서명 DB 롤 · passport 게시 가드 (202609241200)', () => {
  let owner: Pool;
  let signer: Pool;
  let admin: Pool;
  let app: Pool;

  beforeAll(() => {
    owner = createPool(OWNER_URL, { max: 2 });
    signer = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    admin = createPool(roleUrl('atmark_admin'), { max: 2 });
    app = createPool(APP_URL, { max: 2 });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), signer.end(), admin.end(), app.end()]);
  });

  it('① 실제 권한 = 허용 목록(정확히) · 소유·멤버십·위험 속성 0', async () => {
    const report = await inspectRestrictedRole(owner, PASSPORT_SIGNER_ROLE);
    expect(report.exists).toBe(true);
    expect(report.grants).toEqual([...RESTRICTED_ROLE_GRANTS[PASSPORT_SIGNER_ROLE]].sort());
    expect(report.problems).toEqual([]);
  });

  it('① migrate status 는 서명 롤의 여분 권한을 ok=false 로 잡는다(검사가 잠들지 않았다)', async () => {
    await rolledBack(owner, async (client) => {
      await client.query('GRANT SELECT ON organizations TO atmark_passport_signer');
      const borrowed = { query: client.query.bind(client), release: () => undefined };
      const pool = { connect: () => Promise.resolve(borrowed), end: () => Promise.resolve() };
      const handler = createMigrateHandler({
        owner: () => Promise.resolve({ deps: null, pool: pool as never }),
        bootstrap: () => Promise.reject(new Error('불리면 안 된다')),
      });
      const context: LambdaContext = { awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:m', callbackWaitsForEmptyEventLoop: true };
      const status = (await handler({ action: 'status' }, context)) as MigrationStatus;
      expect(status.ok).toBe(false);
      expect(status.restrictedRoles.find((entry) => entry.role === PASSPORT_SIGNER_ROLE)?.problems).toContain('허용 목록 밖 권한 organizations:SELECT');
    });
  });

  it('② 서명 롤은 조직·토큰·메시지 제목·정책·연락처 목록을 읽지 못한다 · passport 정체 칸을 못 바꾼다 · 문서를 못 지운다', async () => {
    await rolledBack(signer, async (client) => {
      for (const sql of [
        'SELECT name FROM organizations LIMIT 1',
        'SELECT owner_email FROM organizations LIMIT 1',
        'SELECT token_hash FROM agent_api_keys LIMIT 1',
        'SELECT subject FROM messages LIMIT 1',
        'SELECT outbound_mode FROM agent_policies LIMIT 1',
        'SELECT value FROM agent_contact_rules LIMIT 1',
        'SELECT organization_id FROM agents LIMIT 1',
        "UPDATE passports SET did = 'x' WHERE false",
        'DELETE FROM passport_documents WHERE false',
        "INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref) VALUES ('x', 'y', 'ed25519', 'devfile://x')",
      ]) {
        await rejects(client, sql, [], /permission denied/);
      }
      // 비공허: 허용된 읽기는 된다.
      await client.query('SELECT id, name, status, created_at FROM agents LIMIT 1');
      await client.query('SELECT agent_id, key_ref FROM agent_keypairs LIMIT 1');
    });
  });

  it('③ admin 은 passport 버전을 위조하지 못한다(문서 없는 published → 커밋 거부) · 앱 롤은 outbox·문서에 못 쓴다', async () => {
    await rolledBack(app, async (client) => {
      await rejects(client, "INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ('x', 'publish', 'system:x')", [], /permission denied/);
      await rejects(client, "INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES (gen_random_uuid(), '{}', 'a.b.c', now(), now())", [], /permission denied/);
      await rejects(client, "UPDATE passports SET status = 'published' WHERE false", [], /permission denied/);
    });
    await rolledBack(admin, async (client) => {
      await rejects(client, "INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES (gen_random_uuid(), '{}', 'a.b.c', now(), now())", [], /permission denied/);
      await rejects(client, "UPDATE passport_publish_requests SET status = 'done' WHERE false", [], /permission denied/);
    });
    // admin 이 INSERT 로 v2 published 를 만들어도(문서 없음) 커밋에서 죽는다 — 지연 제약.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const { agent, passportId } = await seedDraft(client);
      await publishInPlace(client, passportId);
      await client.query('UPDATE passports SET superseded_at = now() WHERE id = $1', [passportId]);
      await client.query(
        `INSERT INTO passports (agent_id, did, controller, status, version, content_hash, metadata_uri)
         VALUES ($1, $3, 'did:web:id.atmark.ai', 'published', 2, $2, 'https://id.atmark.ai/x')`,
        [agent, 'a'.repeat(64), didOf(agent)],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/without a signed document/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('④ 전이 가드 — 제자리 전이는 draft→published 하나 · 버전 규칙 · revoked 는 종단', async () => {
    await rolledBack(owner, async (client) => {
      const { agent, passportId } = await seedDraft(client);
      // v1 은 draft 여야 한다 — 첫 버전으로 published 를 바로 넣지 못한다.
      const stranger = agentId();
      await rejects(client, `INSERT INTO passports (agent_id, did, controller, status, version, content_hash, metadata_uri) VALUES ($1, $3, 'did:web:id.atmark.ai', 'published', 1, $2, 'https://x')`, [stranger, 'a'.repeat(64), didOf(stranger)]);
      // draft 는 대체되지 않는다.
      await rejects(client, 'UPDATE passports SET superseded_at = now() WHERE id = $1', [passportId], /draft/);
      await publishInPlace(client, passportId);
      // 제자리로 published → suspended·draft 불가.
      await rejects(client, "UPDATE passports SET status = 'suspended' WHERE id = $1", [passportId], /in-place/);
      await rejects(client, "UPDATE passports SET status = 'draft' WHERE id = $1", [passportId], /in-place/);
      // 대체 전 새 버전 불가 · 버전 건너뛰기 불가.
      const v2 = documentFor('{"v":2}');
      const insertVersion = `INSERT INTO passports (agent_id, did, controller, status, version, content_hash, metadata_uri)
                             VALUES ($1, $5, 'did:web:id.atmark.ai', $2, $3, $4, 'https://x') RETURNING id`;
      const did = didOf(agent);
      await rejects(client, insertVersion, [agent, 'suspended', 2, v2.hash, did], /supersede/);
      await client.query('UPDATE passports SET superseded_at = now() WHERE id = $1', [passportId]);
      await rejects(client, 'UPDATE passports SET superseded_at = now() + interval \'1 day\' WHERE id = $1', [passportId], /write-once/);
      await rejects(client, insertVersion, [agent, 'suspended', 3, v2.hash, did], /version must be 2/);
      await rejects(client, insertVersion, [agent, 'draft', 2, v2.hash, did], /draft/);
      const revoked = await client.query<{ id: string }>(insertVersion, [agent, 'revoked', 2, v2.hash, did]);
      await client.query(`INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, $2, $3, now(), now())`, [
        revoked.rows[0]?.id,
        v2.document,
        v2.jws,
      ]);
      await client.query('UPDATE passports SET superseded_at = now() WHERE id = $1', [revoked.rows[0]?.id]);
      await rejects(client, insertVersion, [agent, 'published', 3, documentFor('{"v":3}').hash, did], /terminal/);
    });
  });

  it('④ 문서 가드 — 해시 불일치·JWS 페이로드 불일치 거부 · UPDATE·DELETE 거부 · 해시 먼저', async () => {
    await rolledBack(owner, async (client) => {
      const { passportId } = await seedDraft(client);
      const doc = documentFor('{"v":1}');
      const insertDocument = 'INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, $2, $3, now(), now())';
      await rejects(client, insertDocument, [passportId, doc.document, doc.jws], /content_hash/);
      await client.query(`UPDATE passports SET status = 'published', metadata_uri = 'https://x', content_hash = $2 WHERE id = $1`, [passportId, doc.hash]);
      await rejects(client, insertDocument, [passportId, '{"v":2}', documentFor('{"v":2}').jws], /hash/);
      await rejects(client, insertDocument, [passportId, doc.document, documentFor('{"v":9}').jws], /payload/);
      await client.query(insertDocument, [passportId, doc.document, doc.jws]);
      await rejects(client, "UPDATE passport_documents SET document = '{}' WHERE passport_id = $1", [passportId], /immutable/);
      await rejects(client, 'DELETE FROM passport_documents WHERE passport_id = $1', [passportId], /append-only/);
    });
  });

  it('④ outbox — 종단 불변 · 대기 칸 둘(일반 1 · 우선 1, 202609241210) · requested_by 모양(사람 이름·메일 불가)', async () => {
    await rolledBack(owner, async (client) => {
      const { agent } = await seedDraft(client);
      await rejects(client, "INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'publish', 'jin@example.com')", [agent], /requested_by/);
      const first = await client.query<{ id: string }>("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'publish', 'system:test') RETURNING id", [agent]);
      // 일반 칸(publish·resign)은 하나 — 대기 중 게시 옆에 재서명은 못 들어온다.
      await rejects(client, "INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:test')", [agent], /one_pending/);
      // 우선 칸(suspend·revoke)은 따로 하나 — 대기 중 게시가 있어도 정지는 들어온다(비상 경로), 둘째 우선 요청은 안 된다.
      await client.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'suspend', 'system:test')", [agent]);
      await rejects(client, "INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'revoke', 'operator:test')", [agent], /one_pending_priority/);
      await client.query("UPDATE passport_publish_requests SET status = 'rejected', outcome = 'rejected', outcome_reason = 'x', completed_at = now() WHERE id = $1", [first.rows[0]?.id]);
      await rejects(client, "UPDATE passport_publish_requests SET status = 'pending', outcome = NULL, outcome_reason = NULL, completed_at = NULL WHERE id = $1", [first.rows[0]?.id], /terminal/);
      await rejects(client, "UPDATE passport_publish_requests SET kind = 'revoke' WHERE id = $1", [first.rows[0]?.id], /immutable|terminal/);
      await rejects(client, 'DELETE FROM passport_publish_requests WHERE id = $1', [first.rows[0]?.id], /append-only/);
    });
  });

  it('⑤ 요청자 가드(202609241210 ④) — admin 은 publish·suspend 를 admin:session 으로만 · 서명 롤은 resign 을 system: 으로만 · 소유자(런북)는 제한 없음', async () => {
    const session = 'admin:session:00000000-0000-4000-8000-000000000000';
    // 지반: 소유자 롤로 커밋된 에이전트(롤이 다른 연결에서 보이게) — 행은 문제없이 남아도 된다(요청 행은 아래에서 전부 롤백).
    const seeded = await owner.connect();
    let agent = '';
    try {
      await seeded.query('BEGIN');
      agent = (await seedDraft(seeded)).agent;
      await seeded.query('COMMIT');
    } finally {
      seeded.release();
    }
    await rolledBack(admin, async (client) => {
      for (const [kind, by] of [
        ['revoke', session], // 종단 — 관리 API 에 없는 행위
        ['resign', session],
        ['publish', 'operator:mallory'], // 운영자 사칭
        ['suspend', 'system:resign'],
      ] as const) {
        await rejects(client, 'INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, $2, $3)', [agent, kind, by], /atmark_admin may only/);
      }
      // 비공허: 콘솔 모양은 들어간다.
      await client.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'publish', $2)", [agent, session]);
    });
    await rolledBack(signer, async (client) => {
      for (const [kind, by] of [
        ['publish', 'system:resign'],
        ['revoke', 'system:resign'],
        ['resign', 'operator:x'],
      ] as const) {
        await rejects(client, 'INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, $2, $3)', [agent, kind, by], /atmark_passport_signer may only/);
      }
      await client.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:resign')", [agent]);
    });
    await rolledBack(owner, async (client) => {
      await client.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'revoke', 'operator:test')", [agent]);
    });
  });

  it('⑥ 조직 검토 판정 함수 — 서명 롤은 불리언 하나만 얻는다(조직 행은 여전히 못 읽는다)', async () => {
    await rolledBack(owner, async (client) => {
      const { agent } = await seedDraft(client);
      const active = await client.query<{ active: boolean }>('SELECT passport_agent_organization_active($1) AS active', [agent]);
      expect(active.rows[0]?.active).toBe(true);
      await client.query("UPDATE organizations SET review_status = 'pending_review' WHERE id = (SELECT organization_id FROM agents WHERE id = $1)", [agent]);
      const pending = await client.query<{ active: boolean }>('SELECT passport_agent_organization_active($1) AS active', [agent]);
      expect(pending.rows[0]?.active).toBe(false);
      const missing = await client.query<{ active: boolean | null }>("SELECT passport_agent_organization_active('ffffffffffffffffffffffffffffffff') AS active");
      expect(missing.rows[0]?.active).toBeNull();
    });
    await rolledBack(signer, async (client) => {
      await client.query("SELECT passport_agent_organization_active('ffffffffffffffffffffffffffffffff')");
      await rejects(client, 'SELECT review_status FROM organizations LIMIT 1', [], /permission denied/);
    });
    await rolledBack(app, async (client) => {
      await rejects(client, "SELECT passport_agent_organization_active('ffffffffffffffffffffffffffffffff')", [], /permission denied/);
    });
  });
});
