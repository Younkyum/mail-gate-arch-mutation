/**
 * **발신 스니펫 보존(2026-09-24 검증 F3, 마이그레이션 202609241700) — 실제 Postgres · 실제 롤.**
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 스윕(앱 롤 — TTL 스위퍼와 같은 롤)이 365일 넘은 발신 행의 `snippet` 을 NULL 로 비운다 · 365일 안의 행은 그대로.
 *     (스윕을 빼거나 GRANT 를 빼면 → 스니펫이 남거나 42501.)
 *   - 트리거 `messages_snippet_retention_only`(모든 롤): 스니펫은 **NULL 로만**, **365일 넘은 행만** — 앱 롤이 발신 로그 미리보기를
 *     위조하거나(다른 문자열로), 보존 기간 안에 지우지 못한다. 소유자 롤도 같은 규칙이다.
 *   - 앱 롤의 새 권한은 `snippet` 한 칸뿐 — 같은 행의 `subject` UPDATE 는 여전히 42501.
 *   - 스윕 인덱스가 부분 인덱스(`snippet IS NOT NULL`)로 있다.
 *   - 2026-09-24 최종 검증 L2: 다른 트리거가 **한 행**의 UPDATE 를 거부해도 스윕은 던지지 않고 그 행만 건너뛴다(`stuckIds`) — 전에는
 *     배치 전체가 롤백되고 같은 행이 매 틱 맨 앞에 다시 골라져 영원히 멈췄다. 가장 오래된 행이 막혀도 `limit` 1 로 다음 행을 비운다.
 */

import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresSnippetRetention, SNIPPET_RETENTION_DAYS } from '../../../src/db/repositories/snippet-retention';
import { MAIL_BODY_RETENTION_DAYS } from '../../../src/admin/routes/logs';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from './support/harness';

const OWNER_AVAILABLE = DATABASE_AVAILABLE && (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!OWNER_AVAILABLE)('발신 스니펫 보존 — 365일 뒤 NULL (검증 F3)', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await seedFixture(testPool());
  });
  afterAll(async () => {
    await closeTestPool();
  });

  /** 발신 행 하나를 `ageDays` 전 생성 시각으로 심는다(`created_at` 은 INSERT 때만 정할 수 있다 — UPDATE 는 불변 트리거). */
  async function outbound(ageDays: number, snippet: string | null): Promise<string> {
    const owner = provisioningPool();
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [fixture.agentId]);
    const row = await owner.query<{ id: string }>(
      `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, subject, status, message_id_header,
                             idempotency_key, request_hash, recipient_count, created_at, snippet, ses_message_id, sent_at)
       VALUES ($1, $2, 'outbound', $3, split_part($4, '@', 2), 'retention', 'sent', $5, $6, $7, 1, $8, $9, $10, now())
       RETURNING id`,
      [
        fixture.agentId,
        thread.rows[0]?.id,
        createHash('sha256').update(fixture.address, 'utf8').digest('hex'),
        fixture.address,
        `<${randomUUID()}@atmark.test>`,
        `idem-${randomUUID()}`,
        createHash('sha256').update(randomUUID()).digest('hex'),
        new Date(Date.now() - ageDays * DAY_MS),
        snippet,
        `ses-${randomUUID()}`,
      ],
    );
    return row.rows[0]?.id ?? '';
  }

  const snippetOf = async (id: string): Promise<string | null | undefined> =>
    (await testPool().query<{ snippet: string | null }>('SELECT snippet FROM messages WHERE id = $1', [id])).rows[0]?.snippet;

  it('보존 일수는 S3 본문 수명주기·관리 로그의 expired 판정과 같은 값(365)', () => {
    expect(SNIPPET_RETENTION_DAYS).toBe(365);
    expect(SNIPPET_RETENTION_DAYS).toBe(MAIL_BODY_RETENTION_DAYS);
  });

  it('★ 스윕(앱 롤): 365일 넘은 행의 스니펫만 비운다 · 364일 행은 그대로 · 두 번 돌아도 같은 결과', async () => {
    const old = await outbound(400, 'old preview');
    const edge = await outbound(366, 'just past retention');
    const young = await outbound(364, 'young preview');
    const retention = createPostgresSnippetRetention(testPool());

    const { cleared, stuckIds } = await retention.sweep(1000);
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(stuckIds).toEqual([]);
    expect(await snippetOf(old)).toBeNull();
    expect(await snippetOf(edge)).toBeNull();
    expect(await snippetOf(young)).toBe('young preview');

    // 멱등 — 이미 비운 행은 다시 세지 않는다(부분 인덱스 밖).
    await retention.sweep(1000);
    expect(await snippetOf(young)).toBe('young preview');
    await expect(retention.sweep(0)).rejects.toThrow(RangeError);
  });

  it('★ 가드(앱 롤): 보존 기간 안의 스니펫은 못 지운다 · 다른 값으로 못 바꾼다 · NULL 에서 되살리지 못한다', async () => {
    const app = testPool();
    const young = await outbound(10, 'young preview');
    const old = await outbound(400, 'old preview');
    const oldNull = await outbound(400, null);
    await expect(app.query('UPDATE messages SET snippet = NULL WHERE id = $1', [young])).rejects.toMatchObject({ code: '23514' });
    await expect(app.query(`UPDATE messages SET snippet = 'forged' WHERE id = $1`, [young])).rejects.toMatchObject({ code: '23514' });
    await expect(app.query(`UPDATE messages SET snippet = 'forged' WHERE id = $1`, [old])).rejects.toMatchObject({ code: '23514' });
    await expect(app.query(`UPDATE messages SET snippet = 'revived' WHERE id = $1`, [oldNull])).rejects.toMatchObject({ code: '23514' });
    expect(await snippetOf(young)).toBe('young preview');
    // 같은 값으로의 UPDATE(바뀌지 않음)는 통과한다 — 가드는 "바뀔 때" 만 본다.
    await expect(app.query('UPDATE messages SET snippet = snippet WHERE id = $1', [young])).resolves.toBeDefined();
  });

  it('★ 가드는 모든 롤 — 소유자 롤도 보존 기간 안의 스니펫을 지우거나 위조하지 못한다', async () => {
    const owner = provisioningPool();
    const young = await outbound(10, 'young preview');
    await expect(owner.query('UPDATE messages SET snippet = NULL WHERE id = $1', [young])).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query(`UPDATE messages SET snippet = 'forged' WHERE id = $1`, [young])).rejects.toMatchObject({ code: '23514' });
  });

  it('★ 앱 롤의 새 권한은 snippet 한 칸뿐 — subject 는 여전히 42501', async () => {
    const old = await outbound(400, 'old preview');
    await expect(testPool().query(`UPDATE messages SET subject = 'x' WHERE id = $1`, [old])).rejects.toMatchObject({ code: '42501' });
    const grants = await testPool().query<{ ok: boolean }>(
      `SELECT has_column_privilege('atmark_app', 'messages', 'snippet', 'UPDATE') AS ok`,
    );
    expect(grants.rows[0]?.ok).toBe(true);
  });

  it('★ L2: 다른 트리거가 한 행을 거부해도 스윕은 던지지 않는다 — 그 행만 건너뛰고(stuckIds) 나머지를 비운다 · 가장 오래된 행이 막혀도 진행한다', async () => {
    const owner = provisioningPool();
    const marker = `poison-${randomUUID()}`;
    const fn = `test_snippet_block_${randomUUID().replace(/-/g, '')}`;
    // 이 테스트만의 거부 트리거 — 스니펫이 marker 인 행의 UPDATE 를 거부한다(다른 파일의 행은 건드리지 않는다).
    await owner.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'blocked by test trigger' USING ERRCODE = 'P0001'; END; $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON messages FOR EACH ROW WHEN (OLD.snippet = '${marker}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      // 가장 오래된 행(5000일)이 막힌 행 — 예전 구현에서는 `ORDER BY created_at LIMIT n` 이 매번 이 행을 맨 앞에 골랐다.
      const poison = await outbound(5000, marker);
      const poison2 = await outbound(4999, marker);
      const good = await outbound(4998, 'clear me');
      const retention = createPostgresSnippetRetention(testPool());

      // limit 1: 막힌 두 행을 건너뛰고 그 뒤의 한 행을 비운다.
      const first = await retention.sweep(1);
      expect(first.cleared).toBe(1);
      expect(first.stuckIds).toEqual([poison, poison2]);
      expect(await snippetOf(good)).toBeNull();
      expect(await snippetOf(poison)).toBe(marker);

      // 큰 배치: 던지지 않고, 막힌 행은 다시 막힌 것으로 센다(메트릭이 매 틱 나온다).
      const second = await retention.sweep(1000);
      expect(second.stuckIds).toEqual(expect.arrayContaining([poison, poison2]));
      expect(await snippetOf(poison2)).toBe(marker);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON messages`);
      await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  it('스윕 인덱스 — snippet IS NOT NULL 부분 인덱스 · 가드 트리거가 켜져 있다', async () => {
    const index = await testPool().query<{ def: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indexrelid = 'messages_snippet_retention_idx'::regclass`,
    );
    expect(index.rows[0]?.def).toMatch(/\(created_at\) WHERE \(snippet IS NOT NULL\)/);
    const trigger = await testPool().query<{ enabled: string }>(
      `SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid = 'messages'::regclass AND tgname = 'messages_snippet_retention_only'`,
    );
    expect(trigger.rows[0]?.enabled).toBe('O');
  });
});
