/**
 * §4B.1 불변 트리거 — **4구멍 전부를 DB 에서 직접 시도해 거부되는 것을 실측한다.**
 *
 * arch 테스트(`test/arch/keypair-immutability.arch.test.ts`)는 *우리 코드에* 쓰기 경로가
 * 없음을 단언한다. 이 파일은 다른 명제를 단언한다: **코드가 아니라 DB 가 거부한다.**
 * 둘이 필요한 이유는 arch 층이 동적 SQL·psql·마이그레이션·운영자의 손을 못 보기 때문이다.
 *
 * ---
 *
 * **두 층이 있고, 각 층을 각각 실측한다.**
 *
 * | 층 | 무엇이 막는가 | 이 파일에서 재현되는 방식 |
 * |---|---|---|
 * | 1차 — 권한 | 앱 롤(`atmark_app`)에 `agent_keypairs` UPDATE·DELETE·TRUNCATE 미부여 | `TEST_DATABASE_URL` 로 항상 실행 |
 * | 2차 — 트리거 | `agent_keypairs_immutable` / `_no_delete` / `_no_truncate` | 소유자 롤로 실행 (아래 참조) |
 *
 * 1차만 있으면 `GRANT ALL` 한 줄이 보증을 지운다(그리고 그 한 줄은 "권한 오류를 고치려고"
 * 실제로 일어난다). 2차만 있으면 앱이 트리거까지 도달하는 경로가 열려 있다는 뜻이다.
 * **권한이 1차 방어선이고 트리거는 권한이 잘못 부여됐을 때의 2차 방어선이다**
 * (`202609221430_audit_and_suppression.sql` 의 TRUNCATE 주석과 같은 논지).
 *
 * **소유자 롤 접속이 없으면 2차 층 단언은 건너뛴다.** 그 상태를 숨기지 않기 위해
 * `OWNER_AVAILABLE` 을 읽는 단언이 파일 이름에 드러나고, 1차 층은 그때도 전부 돈다.
 * 로컬에서 켜려면: `TEST_MIGRATION_DATABASE_URL=postgres://<owner>@localhost:5432/atmark`.
 */

import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { AGENT_KEYPAIR_COLUMNS, PP_A_TABLES } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import type { Pool } from 'pg';

const ownerUrl =
  process.env['TEST_MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_MIGRATION_URL'] ?? '';

/** 소유자 롤 접속이 있는가. 2차(트리거) 층 단언의 게이트. */
const OWNER_AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '';

let ownerPool: Pool | undefined;
function owner(): Pool {
  ownerPool ??= createPool(ownerUrl, { max: 2 });
  return ownerPool;
}

/** 공개키 자리에 들어갈 수 있는 값(base64url 43자). 내용은 의미 없다 — 형식만 맞으면 된다. */
function fakePublicKey(seed: string): string {
  return seed.repeat(43).slice(0, 43).replace(/[^A-Za-z0-9_-]/g, 'A');
}

/**
 * 에이전트 1개 + keypair 1개 + draft passport 1개. 테스트마다 새로 만든다. **소유자 롤로 심는다** — 앱 롤은 두 테이블에
 * INSERT 가 없다(202609230750, 2차 검증 H-B — 프로비저닝은 CLI·admin 만).
 */
async function seedIdentity(): Promise<{ agentId: string; did: string }> {
  const fixture = await seedFixture(testPool());
  const did = `did:web:id.atmark.ai:agents:${fixture.agentId}`;

  await provisioningPool().query(
    `INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref)
     VALUES ($1, $2, 'ed25519', $3)`,
    [fixture.agentId, fakePublicKey('K'), `devfile://${fixture.agentId}`],
  );
  await provisioningPool().query(
    `INSERT INTO passports (agent_id, did, controller, version)
     VALUES ($1, $2, 'did:web:id.atmark.ai', 1)`,
    [fixture.agentId, did],
  );

  return { agentId: fixture.agentId, did };
}

describe.skipIf(!DATABASE_AVAILABLE)('PP-A 스키마', () => {
  afterAll(async () => {
    await ownerPool?.end();
    await closeTestPool();
  });

  it('PP-A 의 2테이블이 실재한다', async () => {
    const result = await testPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...PP_A_TABLES]],
    );
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...PP_A_TABLES].sort());
  });

  it('agent_keypairs 의 컬럼 집합이 화이트리스트와 **정확히** 같다 (개인키 컬럼 부재)', async () => {
    const result = await testPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_keypairs' ORDER BY column_name`,
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([...AGENT_KEYPAIR_COLUMNS].sort());
  });

  it('불변 트리거 3개가 기대 함수에 묶여 있고 켜져 있다', async () => {
    // arch 층도 권한 층도 못 보는 사실: "트리거가 존재하고 **활성**인가".
    // `ALTER TABLE ... DISABLE TRIGGER` 한 줄이 아래 2차 층 단언을 통째로 무력화한다.
    const result = await testPool().query<{ tgname: string; proname: string; tgenabled: string }>(
      `SELECT t.tgname, p.proname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE c.relname = 'agent_keypairs' AND NOT t.tgisinternal
        ORDER BY t.tgname`,
    );
    expect(result.rows).toEqual([
      { tgname: 'agent_keypairs_immutable', proname: 'reject_row_update', tgenabled: 'O' },
      { tgname: 'agent_keypairs_no_delete', proname: 'reject_row_delete', tgenabled: 'O' },
      { tgname: 'agent_keypairs_no_truncate', proname: 'reject_truncate', tgenabled: 'O' },
      // US-013(202609242200) — 불변 트리거가 아니라 투명성 로그 수집(키 연결 → identity.key_bound 잎). 켜져 있어야 한다.
      { tgname: 'agent_keypairs_tlog_enqueue', proname: 'tlog_enqueue', tgenabled: 'O' },
    ]);
  });

  it('passports.did 는 agent_id 와 어긋날 수 없다 (ADR-0002 경로 동결의 DB 집행)', async () => {
    const fixture = await seedFixture(testPool());
    await expect(
      provisioningPool().query(
        `INSERT INTO passports (agent_id, did, controller, version)
         VALUES ($1, 'did:web:evil.example:agents:deadbeef', 'did:web:id.atmark.ai', 1)`,
        [fixture.agentId],
      ),
    ).rejects.toThrow(/passports_check|violates check constraint/);
  });

  it('draft passport 는 게시 문서 없이 존재할 수 있다 — agents.status 와 축이 다르다', async () => {
    const { agentId } = await seedIdentity();
    const result = await testPool().query<{ status: string; agent_status: string }>(
      `SELECT p.status, a.status AS agent_status
         FROM passports p JOIN agents a ON a.id = p.agent_id
        WHERE p.agent_id = $1`,
      [agentId],
    );
    // 에이전트는 active 인데 passport 는 draft — P1~P5 내내 정상인 조합이다(§4B.3 r4).
    expect(result.rows[0]).toEqual({ status: 'draft', agent_status: 'active' });
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('§4B.1 4구멍 — 1차 방어선(앱 롤 권한)', () => {
  /** 네 구멍을 SQL 그대로 적는다. **표의 각 행이 여기 한 줄로 대응한다.** */
  const holes = [
    {
      hole: '① DELETE + INSERT (UPDATE 트리거 우회로 키 교체와 같은 효과)',
      sql: (id: string) => ['DELETE FROM agent_keypairs WHERE agent_id = $1', [id]] as const,
    },
    {
      hole: '② key_ref UPDATE (공개키는 그대로, 포인터만 교체 — 전 서명의 조용한 무효화)',
      sql: (id: string) =>
        ['UPDATE agent_keypairs SET key_ref = $2 WHERE agent_id = $1', [id, 'awssm://arn:evil']] as const,
    },
    {
      hole: '③ algorithm UPDATE (검증 경로 불일치)',
      sql: (id: string) =>
        ['UPDATE agent_keypairs SET algorithm = $2 WHERE agent_id = $1', [id, 'ed25519']] as const,
    },
    {
      hole: 'public_key UPDATE',
      sql: (id: string) =>
        ['UPDATE agent_keypairs SET public_key = $2 WHERE agent_id = $1', [id, fakePublicKey('Z')]] as const,
    },
  ] as const;

  it.each(holes)('$hole 가 앱 롤에서 거부된다', async ({ sql }) => {
    const { agentId } = await seedIdentity();
    const [text, values] = sql(agentId);
    // 권한이 없으면 **트리거에 도달조차 하지 않는다** — 42501 이 1차 방어선의 지문이다.
    await expect(testPool().query(text, [...values])).rejects.toThrow(/permission denied/);
  });

  it('TRUNCATE 도 앱 롤에서 거부된다 (행 트리거가 보지 못하는 경로)', async () => {
    await expect(testPool().query('TRUNCATE agent_keypairs')).rejects.toThrow(/permission denied/);
  });

  it('④ agents.id UPDATE: 앱 롤은 권한이 없다(202609230730) · 권한이 있는 롤(소유자)도 **트리거**가 거부한다', async () => {
    // 예전에는 이 구멍만 1차 방어선이 없었다 — 앱 롤에 `agents` 테이블 UPDATE 가 있었다. 앱 코드는 `agents` 를 갱신하지
    // 않으므로(프로비저닝·정지는 CLI·admin) 202609230730 이 거뒀다. 트리거는 권한을 가진 롤(소유자·admin)에 대한 2차 방어선이다.
    const { agentId } = await seedIdentity();
    await expect(
      testPool().query(`UPDATE agents SET id = $2 WHERE id = $1`, [agentId, 'ffffffffffffffffffffffffffffffff']),
    ).rejects.toThrow(/permission denied/);
    if (!OWNER_AVAILABLE) return;
    await expect(
      owner().query(`UPDATE agents SET id = $2 WHERE id = $1`, [agentId, 'ffffffffffffffffffffffffffffffff']),
    ).rejects.toThrow(/immutable column agents\.id cannot be updated/);
  });

  it('두 번째 keypair INSERT — 앱 롤은 INSERT 자체가 없고(202609230750), 권한이 있는 롤도 PK 가 거부한다 (회전의 또 다른 모양)', async () => {
    const { agentId } = await seedIdentity();
    const second = [
      `INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref)
         VALUES ($1, $2, 'ed25519', $3)`,
      [agentId, fakePublicKey('Y'), `devfile://${agentId}-2`],
    ] as const;
    await expect(testPool().query(second[0], [...second[1]])).rejects.toThrow(/permission denied/);
    await expect(provisioningPool().query(second[0], [...second[1]])).rejects.toThrow(/duplicate key value|agent_keypairs_pkey/);
  });

  it('개인키를 담을 컬럼이 없어 INSERT 자체가 불가능하다 (§3.5 AC-e1)', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      testPool().query(
        `UPDATE agent_keypairs SET private_key = 'leak' WHERE agent_id = $1`,
        [agentId],
      ),
    ).rejects.toThrow(/column "private_key" of relation "agent_keypairs" does not exist|permission denied/);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('§4B.1 4구멍 — 2차 방어선(트리거, 소유자 롤)', () => {
  /**
   * **여기서 보는 것은 "권한이 GRANT ALL 로 넓어져도 막히는가" 다.**
   * 소유자 롤은 REVOKE 의 영향을 받지 않으므로, 이 롤로 시도하면 1차 방어선을 건너뛰고
   * 트리거가 유일한 방어선인 상태를 그대로 재현한다.
   */
  it('① DELETE 를 트리거가 거부한다', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query('DELETE FROM agent_keypairs WHERE agent_id = $1', [agentId]),
    ).rejects.toThrow(/rows in agent_keypairs are append-only and cannot be deleted/);
  });

  it('② key_ref UPDATE 를 트리거가 거부한다', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query('UPDATE agent_keypairs SET key_ref = $2 WHERE agent_id = $1', [
        agentId,
        'awssm://arn:aws:secretsmanager:evil',
      ]),
    ).rejects.toThrow(/rows in agent_keypairs are immutable/);
  });

  it('③ algorithm UPDATE 를 트리거가 거부한다 — **값이 같아도** 거부된다', async () => {
    // 행 전체 불변이라 "바뀐 컬럼이 없는 UPDATE" 도 거부된다. 컬럼 열거(deny-list)
    // 방식이었다면 이 경로가 통과하고, 그 통과가 곧 나중에 추가되는 컬럼의 구멍이 된다.
    const { agentId } = await seedIdentity();
    await expect(
      owner().query(`UPDATE agent_keypairs SET algorithm = 'ed25519' WHERE agent_id = $1`, [agentId]),
    ).rejects.toThrow(/rows in agent_keypairs are immutable/);
  });

  it('public_key UPDATE 를 트리거가 거부한다', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query('UPDATE agent_keypairs SET public_key = $2 WHERE agent_id = $1', [
        agentId,
        fakePublicKey('Q'),
      ]),
    ).rejects.toThrow(/rows in agent_keypairs are immutable/);
  });

  it('TRUNCATE 를 문장 트리거가 거부한다', async () => {
    await expect(owner().query('TRUNCATE agent_keypairs')).rejects.toThrow(
      /table agent_keypairs is append-only and cannot be truncated/,
    );
  });

  it('passports 행은 삭제되지 않는다 (§4B.1b — 삭제는 사칭보다 나쁜 실패 모드)', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query('DELETE FROM passports WHERE agent_id = $1', [agentId]),
    ).rejects.toThrow(/rows in passports are append-only/);
  });

  it('passports.did 는 UPDATE 되지 않는다 (allow-list 밖 컬럼)', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query('UPDATE passports SET did = $2 WHERE agent_id = $1', [
        agentId,
        'did:web:evil.example:agents:deadbeefdeadbeefdeadbeefdeadbeef',
      ]),
    ).rejects.toThrow(/immutable column passports\.did cannot be updated/);
  });

  it('content_hash 는 1회 쓰기다 — NULL→값은 되고, 값→다른 값은 거부된다', async () => {
    const { agentId } = await seedIdentity();
    // P6(202609241200) 부터 게시된 버전에는 커밋 시점에 서명 문서가 있어야 한다 — 게시(서명 Lambda)와 같은 한 트랜잭션으로 한다.
    //   문서 = '{}', 해시 = SHA-256('{}'), JWS 페이로드 = base64url('{}')(DB 가 셋의 일치를 대조한다).
    const first = createHash('sha256').update('{}', 'utf8').digest('hex');
    const client = await owner().connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ id: string }>(
        `UPDATE passports SET status = 'published', content_hash = $2, metadata_uri = $3
          WHERE agent_id = $1 RETURNING id`,
        [agentId, first, `https://id.atmark.ai/agents/${agentId}/passport.json`],
      );
      await client.query(
        `INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, '{}', $2, now(), now())`,
        [updated.rows[0]?.id, `e30.${Buffer.from('{}').toString('base64url')}.c2ln`],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await expect(
      owner().query('UPDATE passports SET content_hash = $2 WHERE agent_id = $1', [
        agentId,
        'b'.repeat(64),
      ]),
    ).rejects.toThrow(/write-once column passports\.content_hash cannot be overwritten/);
  });

  it('published 상태인데 문서가 없는 행은 만들어지지 않는다', async () => {
    const { agentId } = await seedIdentity();
    await expect(
      owner().query(`UPDATE passports SET status = 'published' WHERE agent_id = $1`, [agentId]),
    ).rejects.toThrow(/passports_published_requires_document/);
  });
});
