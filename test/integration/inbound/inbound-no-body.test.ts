/**
 * PRD — **raw email 을 Postgres 에 저장하지 않는다** (계획 §6 P3 Acceptance: "통합 테스트가 raw email 의
 * Postgres 미저장을 단언").
 *
 * 두 층으로 본다:
 *   ① **컬럼 집합**: P3a 테이블의 컬럼은 `P3A_TABLE_COLUMNS` 와 **동일**하다(부분집합이 아니라 — 잡으려는
 *      사고가 "본문 컬럼이 늘어나는 것" 이다).
 *   ② **값 전수 검사**: 본문·HTML·첨부에만 든 센티널을 실은 메일 한 통을 파이프라인에 태운 뒤, `public`
 *      스키마의 **모든 테이블의 모든 문자열·JSON·바이트·배열 컬럼**을 센티널로 훑는다 → 0건.
 *      컬럼 이름이 무엇이든(누가 `notes jsonb` 를 만들어 본문을 넣든) 값이 들어가면 잡힌다.
 *      **비공허성**: 같은 센티널이 S3 쪽(파싱 결과 JSON·첨부 객체)에는 **있음**을 먼저 확인한다 —
 *      센티널이 파이프라인을 타지 않았다면 0건은 아무것도 증명하지 않는다.
 *
 * 덧붙여 스레드 권한을 지키는 DB 제약(불변·append-only·발송 행의 스레드 필수)과 발송 저장소의 수신자·스레드
 * 기록을 여기서 본다 — 전부 "DB 가 집행한다" 는 같은 종류의 명제다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { P3A_TABLE_COLUMNS, P3A_TABLES } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE, hex64, provisioningPool, seedFixture, seedMessage, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId, scanForSentinel } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function columnsOf(table: string): Promise<string[]> {
  const result = await testPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

describe.skipIf(!DATABASE_AVAILABLE)('PRD — Postgres 에 본문이 없다', () => {
  it('① P3a 테이블의 컬럼 집합 = P3A_TABLE_COLUMNS (동일)', async () => {
    expect([...P3A_TABLES].sort()).toEqual(Object.keys(P3A_TABLE_COLUMNS).sort());
    for (const table of P3A_TABLES) {
      expect(await columnsOf(table), table).toEqual([...P3A_TABLE_COLUMNS[table]].sort());
    }
  });

  it('② 본문·HTML·첨부에 든 센티널이 S3 에는 있고 Postgres 의 어떤 컬럼에도 없다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const objects = newObjectStore();
    const deps = consumerDeps(pool, objects);
    const sentinel = `ZZSENTINEL${randomUUID().replace(/-/g, '')}`;
    const sesMessageId = newSesMessageId();

    const outcome = await deliver(
      deps,
      eml({
        from: 'sender@example.com',
        subject: '제목에는 센티널이 없다',
        text: `확인 코드 안내\n${sentinel}-plain\n끝`,
        html: `<p>${sentinel}-html</p><div style="display:none">${sentinel}-hidden</div>`,
        attachment: {
          filename: 'report.txt',
          contentType: 'text/plain',
          bytes: new TextEncoder().encode(`attachment ${sentinel}-bytes`),
        },
      }),
      { sesMessageId, recipients: [fixture.address] },
    );
    expect(outcome).toBe('stored');

    // 비공허성 — 센티널은 실제로 파이프라인을 탔다.
    const parsed = new TextDecoder().decode(await objects.get(deps.artifacts.parsedKeyFor(sesMessageId), 10_000_000));
    expect(parsed).toContain(`${sentinel}-plain`);
    expect(parsed).toContain(`${sentinel}-html`);
    const attachment = new TextDecoder().decode(
      await objects.get(deps.artifacts.attachmentKeyFor(sesMessageId, 0), 1_000_000),
    );
    expect(attachment).toContain(`${sentinel}-bytes`);
    const raw = new TextDecoder().decode(await deps.rawMail.get(deps.rawMail.keyFor(sesMessageId)));
    expect(raw.length).toBeGreaterThan(0);

    // 그리고 Postgres 에는 한 글자도 없다.
    expect(await scanForSentinel(sentinel)).toEqual([]);
    // 전 테이블 스캔이라 부하가 큰 기계(동시에 도는 스위트)에서는 기본 5초를 넘을 수 있다.
  }, 60_000);
});

describe.skipIf(!DATABASE_AVAILABLE)('스레드 권한을 지키는 DB 제약', () => {
  it('inbound_messages.thread_id(권한용)는 바꿀 수 없다 · display_thread_id 는 바꿀 수 있다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    await deliver(deps, eml({ from: 'a@example.com' }), { sesMessageId, recipients: [fixture.address] });
    const other = await pool.query<{ id: string }>(
      `INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'external', 'z@example.com') RETURNING id`,
      [fixture.agentId],
    );
    const otherThread = other.rows[0]?.id;

    // 앱 롤은 inbound_messages UPDATE 가 없다(202609230750 — 앱 코드에 UPDATE 가 없다). 트리거는 권한을 가진 롤(소유자)의 2차 층.
    await expect(
      pool.query('UPDATE inbound_messages SET display_thread_id = $1 WHERE ses_message_id = $2', [otherThread, sesMessageId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      provisioningPool().query('UPDATE inbound_messages SET thread_id = $1 WHERE ses_message_id = $2', [otherThread, sesMessageId]),
    ).rejects.toThrow(/immutable column inbound_messages\.thread_id/);
    await expect(
      provisioningPool().query('UPDATE inbound_messages SET display_thread_id = $1 WHERE ses_message_id = $2', [otherThread, sesMessageId]),
    ).resolves.toBeDefined();
  });

  it('다른 에이전트의 스레드에 붙일 수 없다(복합 FK)', async () => {
    const pool = testPool();
    const a = await seedFixture(pool);
    const b = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    await deliver(deps, eml({ from: 'a@example.com' }), { sesMessageId, recipients: [a.address] });
    const foreign = await pool.query<{ id: string }>(
      `INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'external', 'z@example.com') RETURNING id`,
      [b.agentId],
    );
    await expect(
      provisioningPool().query('UPDATE inbound_messages SET display_thread_id = $1 WHERE ses_message_id = $2', [
        foreign.rows[0]?.id,
        sesMessageId,
      ]),
    ).rejects.toThrow(/inbound_messages_display_thread_fkey/);
  });

  it('발송 행: 스레드 없이 만들 수 없고, 스레드를 바꿀 수 없다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await expect(
      pool.query(
        `INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header,
                               idempotency_key, request_hash, recipient_count)
         VALUES ($1, 'outbound', $2, 'atmark.ai', 'pending', $3, $4, $5, 1)`,
        [fixture.agentId, hex64(), `<${randomUUID()}@atmark.ai>`, randomUUID(), hex64()],
      ),
    ).rejects.toThrow(/messages_outbound_has_thread/);

    const messageId = await seedMessage(pool, fixture.agentId);
    const other = await pool.query<{ id: string }>(
      `INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id`,
      [fixture.agentId],
    );
    // 앱 롤은 messages 의 상태·임대·결과 칸만 UPDATE 한다(202609230750 — 컬럼 단위). 소유자 롤이면 트리거가 막는다.
    await expect(
      pool.query('UPDATE messages SET thread_id = $1 WHERE id = $2', [other.rows[0]?.id, messageId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      provisioningPool().query('UPDATE messages SET thread_id = $1 WHERE id = $2', [other.rows[0]?.id, messageId]),
    ).rejects.toThrow(/immutable column messages\.thread_id/);
  });

  // 앱 롤에는 UPDATE·DELETE 권한 자체가 없다(GRANT SELECT, INSERT). 트리거(reject_row_update/delete)는 그 밑의
  // 두 번째 층이다 — 소유자 롤로만 닿으므로 여기서는 앱 롤이 실제로 막히는 첫 층을 본다.
  it('outbound_recipients 는 append-only — 수신자를 사후에 더하거나 바꿀 수 없다(UPDATE·DELETE 거부)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresOutboundMessageStore(pool);
    const inserted = await store.insertOrReplay({
      agentId: fixture.agentId,
      fromAddress: fixture.address,
      subject: 'x',
      messageIdHeader: `<${randomUUID()}@atmark.ai>`,
      idempotencyKey: randomUUID(),
      requestHash: hex64(),
      recipientCount: 1,
      recipients: ['bob@example.com'],
      threadId: null,
    });
    await expect(
      pool.query(`UPDATE outbound_recipients SET address = 'eve@example.com' WHERE message_id = $1`, [inserted.message.id]),
    ).rejects.toThrow(/permission denied for table outbound_recipients/);
    await expect(pool.query('DELETE FROM outbound_recipients WHERE message_id = $1', [inserted.message.id])).rejects.toThrow(
      /permission denied for table outbound_recipients/,
    );
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('발송 저장소 — 스레드 · 수신자 전원 (prepareOutbound 의 INSERT)', () => {
  it('발송 행 = 에이전트 스레드 1 + 수신자 전원(소문자·중복 제거) · 재호출은 스레드를 새로 만들지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresOutboundMessageStore(pool);
    const input = {
      agentId: fixture.agentId,
      fromAddress: fixture.address,
      subject: 'Re: 견적',
      messageIdHeader: `<${randomUUID()}@atmark.ai>`,
      idempotencyKey: randomUUID(),
      requestHash: hex64(),
      recipientCount: 3,
      recipients: ['Bob@Example.com', 'bob@example.com', 'carol@example.com'],
      threadId: null,
    };
    const first = await store.insertOrReplay(input);
    expect(first.kind).toBe('inserted');

    const thread = await pool.query<{ started_by: string; starter_address: string; subject_normalized: string }>(
      `SELECT t.started_by, t.starter_address, t.subject_normalized
         FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1`,
      [first.message.id],
    );
    expect(thread.rows).toEqual([{ started_by: 'agent', starter_address: fixture.address, subject_normalized: '견적' }]);
    const recipients = await pool.query<{ address: string }>(
      'SELECT address FROM outbound_recipients WHERE message_id = $1 ORDER BY address',
      [first.message.id],
    );
    expect(recipients.rows.map((row) => row.address)).toEqual(['bob@example.com', 'carol@example.com']);

    const before = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM threads WHERE agent_id = $1', [
      fixture.agentId,
    ]);
    const again = await store.insertOrReplay({ ...input, messageIdHeader: `<${randomUUID()}@atmark.ai>` });
    expect(again.kind).toBe('replayed');
    const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM threads WHERE agent_id = $1', [
      fixture.agentId,
    ]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('수신자 목록이 비면 행을 만들지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const store = createPostgresOutboundMessageStore(pool);
    await expect(
      store.insertOrReplay({
        agentId: fixture.agentId,
        fromAddress: fixture.address,
        subject: 'x',
        messageIdHeader: `<${randomUUID()}@atmark.ai>`,
        idempotencyKey: randomUUID(),
        requestHash: hex64(),
        recipientCount: 1,
        recipients: [],
        threadId: null,
      }),
    ).rejects.toThrow(/recipients 가 비어 있다/);
  });
});
