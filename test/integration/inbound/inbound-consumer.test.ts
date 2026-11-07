/**
 * 수신 파이프라인 — **실제 Postgres** 위에서 (계획 §6 P3a).
 *
 * 각 단언은 방어 하나를 겨냥한다. 방어를 끄면 빨개지는지 손으로 확인했다(보고서 "되돌리기"):
 *   - 멱등: 같은 SES 메시지 3회(순차·동시, 선조회 우회 포함) → 에이전트당 1행.
 *   - 에이전트 결정은 **봉투 수신자**로: 헤더 To 가 다른 에이전트를 가리켜도 그 에이전트에 행이 없다.
 *   - `from_authenticated` 는 DMARC 에서만: SPF·DKIM 통과 + DMARC 실패 → false. DB CHECK 가 한 번 더.
 *   - 스레드 권한: 우리 발신의 **수신자**가 **인증된** From 으로 회신해야만 같은 스레드.
 *   - poison pill: 알림 파싱 실패·MIME 거부·모르는 수신자·바이러스는 던지지 않고 결말로.
 *   - 일시 장애(S3·DB)만 `failed`, 재시도가 복구한다.
 *   - GATE B2③ 원자료(봉투 발신자·전달 헤더)가 저장된다.
 * Postgres 에 본문이 없다는 단언은 `inbound-no-body.test.ts` 에 따로 있다.
 */

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { InboundStore } from '../../../src/db/repositories/inbound-store';
import type { InboundMessageRow, InboundRejectionRow } from '../../../src/db/schema';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import type { ObjectStore } from '../../../src/storage/object-store';
import { consumeInboundMail, consumeInboundMailBatch } from '../../../src/workers/inbound-consumer';
import {
  closeTestPool,
  DATABASE_AVAILABLE,
  hex64,
  seedFixture,
  testPool,
  type Fixture,
} from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId, notification, objectExists } from './support';

const logs: string[] = [];

beforeAll(() => {
  setLogSink((line) => logs.push(line));
});

afterAll(async () => {
  resetLogSink();
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function inboundRows(agentId: string, sesMessageId?: string): Promise<InboundMessageRow[]> {
  const result = await testPool().query<InboundMessageRow>(
    `SELECT * FROM inbound_messages WHERE agent_id = $1 ${sesMessageId === undefined ? '' : 'AND ses_message_id = $2'}
      ORDER BY created_at`,
    sesMessageId === undefined ? [agentId] : [agentId, sesMessageId],
  );
  return result.rows;
}

async function rejections(sesMessageId: string): Promise<InboundRejectionRow[]> {
  const result = await testPool().query<InboundRejectionRow>(
    'SELECT * FROM inbound_rejections WHERE ses_message_id = $1 ORDER BY reason',
    [sesMessageId],
  );
  return result.rows;
}

/** 우리가 보낸 메일 하나 — 실제 발송 저장소로 만들고(스레드·수신자 포함) sent 로 확정한다. */
async function sentOutbound(fixture: Fixture, recipients: readonly string[], subject = '견적 요청'): Promise<{
  messageId: string;
  threadId: string;
  sesMessageId: string;
  messageIdHeader: string;
}> {
  const pool = testPool();
  const store = createPostgresOutboundMessageStore(pool);
  const messageIdHeader = `<${randomUUID()}@atmark.ai>`;
  const inserted = await store.insertOrReplay({
    agentId: fixture.agentId,
    fromAddress: fixture.address,
    subject,
    messageIdHeader,
    idempotencyKey: randomUUID(),
    requestHash: hex64(),
    recipientCount: recipients.length,
    recipients,
    threadId: null,
  });
  const messageId = inserted.message.id;
  const sesMessageId = newSesMessageId();
  await pool.query(
    `UPDATE messages SET status = 'dispatching', lease_id = gen_random_uuid(), lease_expires_at = now() + interval '1 minute'
      WHERE id = $1`,
    [messageId],
  );
  await pool.query(
    `UPDATE messages SET status = 'sent', ses_message_id = $2, sent_at = now(), lease_id = NULL, lease_expires_at = NULL
      WHERE id = $1`,
    [messageId, sesMessageId],
  );
  const thread = await pool.query<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = $1', [messageId]);
  return { messageId, threadId: thread.rows[0]?.thread_id ?? '', sesMessageId, messageIdHeader };
}

describe.skipIf(!DATABASE_AVAILABLE)('수신 — 저장의 모양', () => {
  it('메타는 Postgres, 본문은 S3 JSON, 첨부는 S3 바이트(키는 파일명이 아니다) · 체크섬 일치', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const objects = newObjectStore();
    const deps = consumerDeps(pool, objects);
    const sesMessageId = newSesMessageId();
    const bytes = new Uint8Array(randomUUID().split('').map((c) => c.charCodeAt(0)));

    const outcome = await deliver(
      deps,
      eml({
        from: 'Alice <Alice@Example.COM>',
        subject: '안녕하세요',
        text: '본문입니다',
        attachment: { filename: '../../outbound/content/evil.json', contentType: 'text/html', bytes },
      }),
      { sesMessageId, recipients: [fixture.address], commonFrom: ['Alice <alice@example.com>'] },
    );
    expect(outcome).toBe('stored');

    const [row] = await inboundRows(fixture.agentId, sesMessageId);
    expect(row).toMatchObject({
      envelope_recipient: fixture.address,
      from_address: 'alice@example.com',
      from_domain: 'example.com',
      subject: '안녕하세요',
      raw_storage_key: `inbound/raw/${sesMessageId}`,
      parsed_storage_key: `inbound/parsed/${sesMessageId}.json`,
      text_source: 'plain',
      attachment_count: 1,
      dmarc_verdict: 'pass',
    });
    // 발신 메시지 id 는 도메인 소문자로 정규화돼 저장된다(핸드오프 "조회 인덱스").
    expect(row?.message_id_header).toMatch(/@mail\.example\.com>$/);

    const parsed = JSON.parse(
      new TextDecoder().decode(await objects.get(row?.parsed_storage_key ?? '', 10_000_000)),
    ) as { version: number; message: { text: string } };
    expect(parsed.version).toBe(1);
    expect(parsed.message.text).toBe('본문입니다');

    const attachments = await pool.query<{ storage_key: string; sha256: string; filename: string; content_type: string }>(
      'SELECT storage_key, sha256, filename, content_type FROM inbound_attachments WHERE inbound_message_id = $1',
      [row?.id],
    );
    expect(attachments.rows).toHaveLength(1);
    const [attachment] = attachments.rows;
    expect(attachment?.storage_key).toBe(`inbound/attachments/${sesMessageId}/0`);
    expect(attachment?.filename).toBe('../../outbound/content/evil.json');
    expect(attachment?.content_type).toBe('text/html');
    const stored = await objects.get(attachment?.storage_key ?? '', 1_000_000);
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
    // AC-4 "첨부 체크섬 일치" 의 우리 쪽 절반.
    expect(attachment?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('멱등 — 같은 SES 메시지는 에이전트당 한 행', () => {
  it('순차 3회 → stored, duplicate, duplicate / 행 1', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    const raw = eml({ from: 'a@example.com' });
    const options = { sesMessageId, recipients: [fixture.address] };

    const outcomes = [await deliver(deps, raw, options), await deliver(deps, raw, options), await deliver(deps, raw, options)];
    expect(outcomes).toEqual(['stored', 'duplicate', 'duplicate']);
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(1);
  });

  it('**선조회를 우회한** 동시 3회도 행 1 · 외부 스레드 1 — 집행은 유니크 인덱스이고, 진 쪽의 스레드는 되돌려진다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const base = consumerDeps(pool, newObjectStore());
    // 최적화 경로(existingAgentIds)를 없앤다 — 남는 방어는 DB 뿐이다.
    const receipts: InboundStore = { ...base.receipts, existingAgentIds: () => Promise.resolve(new Set<string>()) };
    const deps = { ...base, receipts };
    const sesMessageId = newSesMessageId();
    const raw = eml({ from: 'a@example.com' });
    await deps.rawMail.put(sesMessageId, raw);
    const options = { sesMessageId, recipients: [fixture.address] };

    const outcomes = await Promise.all([deliver(deps, null, options), deliver(deps, null, options), deliver(deps, null, options)]);
    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(2);
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(1);
    const threads = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM threads WHERE agent_id = $1 AND started_by = 'external'`,
      [fixture.agentId],
    );
    expect(threads.rows[0]?.count).toBe('1');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('에이전트는 봉투 수신자로 정한다 — 헤더 To 가 아니다', () => {
  it('헤더 To = 에이전트 B, 봉투 = 에이전트 A → A 에만 행', async () => {
    const pool = testPool();
    const a = await seedFixture(pool);
    const b = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();

    await deliver(deps, eml({ from: 'x@example.com', to: b.address }), { sesMessageId, recipients: [a.address] });

    expect(await inboundRows(a.agentId, sesMessageId)).toHaveLength(1);
    expect(await inboundRows(b.agentId, sesMessageId)).toHaveLength(0);
    expect((await inboundRows(a.agentId, sesMessageId))[0]?.envelope_recipient).toBe(a.address);
  });

  it('Bcc 수신(헤더에 에이전트 주소 없음)도 받는다 · 봉투에 둘이면 둘 다', async () => {
    const pool = testPool();
    const a = await seedFixture(pool);
    const b = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();

    const outcome = await deliver(deps, eml({ from: 'x@example.com', to: 'undisclosed@example.org' }), {
      sesMessageId,
      recipients: [a.address, b.address.toUpperCase()],
    });
    expect(outcome).toBe('stored');
    expect(await inboundRows(a.agentId, sesMessageId)).toHaveLength(1);
    expect(await inboundRows(b.agentId, sesMessageId)).toHaveLength(1);
  });

  it('모르는 주소만 → rejected(unknown_recipient) · 일부만 모르면 받은 몫은 저장하고 나머지만 결말로', async () => {
    const pool = testPool();
    const a = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());

    const lonely = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId: lonely, recipients: ['nobody@atmark.ai'] })).toBe(
      'rejected',
    );
    expect((await rejections(lonely)).map((row) => [row.reason, row.envelope_recipients])).toEqual([
      ['unknown_recipient', ['nobody@atmark.ai']],
    ]);

    const mixed = newSesMessageId();
    expect(
      await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId: mixed, recipients: [a.address, 'ghost@atmark.ai'] }),
    ).toBe('stored');
    expect(await inboundRows(a.agentId, mixed)).toHaveLength(1);
    expect((await rejections(mixed)).map((row) => row.envelope_recipients)).toEqual([['ghost@atmark.ai']]);
  });

  it('시끄러운 수신(알람 41) — 고객 도메인의 모르는 수신자만 센다 · atmark.ai(하위 포함)는 0 · SQS 재전달(duplicate)은 다시 세지 않는다', async () => {
    const pool = testPool();
    const deps = consumerDeps(pool, newObjectStore());
    const noisy = (): number[] =>
      logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => METRIC_NAMES.inboundUnknownCustomDomain in entry)
        .map((entry) => entry[METRIC_NAMES.inboundUnknownCustomDomain] as number);

    const before = noisy().length;
    const platformOnly = newSesMessageId();
    await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId: platformOnly, recipients: ['nobody@atmark.ai', 'ghost@mail.atmark.ai'] });
    expect(noisy()).toHaveLength(before);

    const custom = newSesMessageId();
    const recipients = ['a@acme-noisy.example', 'B@Acme-Noisy.Example', 'nobody@atmark.ai'];
    expect(await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId: custom, recipients })).toBe('rejected');
    expect(noisy().slice(before)).toEqual([2]);
    await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId: custom, recipients });
    expect(noisy().slice(before)).toEqual([2]);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('from_authenticated 는 DMARC 에서만 온다', () => {
  it('SPF·DKIM pass + DMARC fail → false / DMARC pass → true / SES 가 본 From 이 다르면 false', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const from = 'ceo@bank.example';

    const cases = [
      { dmarc: 'FAIL', spf: 'PASS', dkim: 'PASS', commonFrom: [from], expected: false },
      { dmarc: 'PASS', spf: 'FAIL', dkim: 'FAIL', commonFrom: [from], expected: true },
      { dmarc: 'PASS', spf: 'PASS', dkim: 'PASS', commonFrom: ['attacker@evil.example'], expected: false },
    ];
    for (const testCase of cases) {
      const sesMessageId = newSesMessageId();
      await deliver(deps, eml({ from }), { sesMessageId, recipients: [fixture.address], ...testCase });
      const [row] = await inboundRows(fixture.agentId, sesMessageId);
      expect(row?.from_authenticated, JSON.stringify(testCase)).toBe(testCase.expected);
    }
  });

  it('DB CHECK — dmarc_verdict ≠ pass 인 행에 from_authenticated=true 를 쓸 수 없다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    await deliver(deps, eml({ from: 'a@example.com' }), { sesMessageId, recipients: [fixture.address], dmarc: 'FAIL' });
    const [row] = await inboundRows(fixture.agentId, sesMessageId);
    const second = newSesMessageId();
    await expect(
      pool.query(
        `INSERT INTO inbound_messages
           SELECT (r).* FROM (SELECT jsonb_populate_record(NULL::inbound_messages,
             to_jsonb(i) || jsonb_build_object('id', gen_random_uuid(), 'ses_message_id', $2::text,
               'raw_storage_key', 'inbound/raw/' || $2, 'parsed_storage_key', 'inbound/parsed/' || $2 || '.json',
               'from_authenticated', true)) AS r
             FROM inbound_messages i WHERE i.id = $1) s`,
        [row?.id, second],
      ),
    ).rejects.toThrow(/inbound_messages_authentication_is_dmarc/);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('스레드 — 권한은 강한 증거로만', () => {
  it('우리 발신의 수신자가 인증된 From 으로 SES Message-ID 에 회신 → 같은 스레드(ses_message_id · outbound)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const out = await sentOutbound(fixture, ['Bob@Example.com']);

    const sesMessageId = newSesMessageId();
    await deliver(
      deps,
      eml({ from: 'bob@example.com', subject: 'Re: 견적 요청', inReplyTo: `<${out.sesMessageId}@ap-northeast-2.amazonses.com>` }),
      { sesMessageId, recipients: [fixture.address], commonFrom: ['bob@example.com'] },
    );
    const [row] = await inboundRows(fixture.agentId, sesMessageId);
    expect(row).toMatchObject({
      thread_id: out.threadId,
      display_thread_id: out.threadId,
      matched_by: 'ses_message_id',
      matched_message_id: out.messageId,
      matched_direction: 'outbound',
      new_thread_reason: null,
    });

    // 같은 사람이 자기 수신 메일에 이어 쓴다 → 같은 스레드(message_id_header · inbound).
    const next = newSesMessageId();
    await deliver(deps, eml({ from: 'bob@example.com', inReplyTo: row?.message_id_header ?? '' }), {
      sesMessageId: next,
      recipients: [fixture.address],
      commonFrom: ['bob@example.com'],
    });
    const [followUp] = await inboundRows(fixture.agentId, next);
    expect(followUp).toMatchObject({ thread_id: out.threadId, matched_by: 'message_id_header', matched_direction: 'inbound' });
  });

  it('id 를 아는 제3자 · 인증 없는 수신자 → 새 스레드(권한 없음), 표시만 묶인다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const out = await sentOutbound(fixture, ['bob@example.com']);
    const inReplyTo = out.messageIdHeader;

    const carol = newSesMessageId();
    await deliver(deps, eml({ from: 'carol@example.com', inReplyTo }), {
      sesMessageId: carol,
      recipients: [fixture.address],
      commonFrom: ['carol@example.com'],
    });
    const [carolRow] = await inboundRows(fixture.agentId, carol);
    expect(carolRow?.thread_id).not.toBe(out.threadId);
    expect(carolRow).toMatchObject({ new_thread_reason: 'sender_not_participant', display_thread_id: out.threadId, matched_by: null });

    const spoof = newSesMessageId();
    await deliver(deps, eml({ from: 'bob@example.com', inReplyTo }), {
      sesMessageId: spoof,
      recipients: [fixture.address],
      dmarc: 'FAIL',
      commonFrom: ['bob@example.com'],
    });
    const [spoofRow] = await inboundRows(fixture.agentId, spoof);
    expect(spoofRow?.thread_id).not.toBe(out.threadId);
    expect(spoofRow).toMatchObject({ new_thread_reason: 'sender_unauthenticated', display_thread_id: out.threadId });
  });

  it('헤더 없이 제목만 같다 → 권한은 새 스레드, 표시는 참여자일 때만 묶인다(제목 폴백은 표시 전용)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const out = await sentOutbound(fixture, ['bob@example.com'], '분기 보고서');

    const bob = newSesMessageId();
    await deliver(deps, eml({ from: 'bob@example.com', subject: 'RE: 분기 보고서' }), {
      sesMessageId: bob,
      recipients: [fixture.address],
      commonFrom: ['bob@example.com'],
    });
    const [bobRow] = await inboundRows(fixture.agentId, bob);
    expect(bobRow?.thread_id).not.toBe(out.threadId);
    expect(bobRow).toMatchObject({ new_thread_reason: 'no_header_ids', display_thread_id: out.threadId, matched_by: null });

    const stranger = newSesMessageId();
    await deliver(deps, eml({ from: 'stranger@example.com', subject: 'Re: 분기 보고서' }), {
      sesMessageId: stranger,
      recipients: [fixture.address],
      commonFrom: ['stranger@example.com'],
    });
    expect((await inboundRows(fixture.agentId, stranger))[0]?.display_thread_id).toBeNull();
  });

  it('다른 에이전트의 발신 id 에 회신해도 이 에이전트의 스레드에는 잇지 않는다', async () => {
    const pool = testPool();
    const mine = await seedFixture(pool);
    const other = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const out = await sentOutbound(other, ['bob@example.com']);

    const sesMessageId = newSesMessageId();
    await deliver(deps, eml({ from: 'bob@example.com', inReplyTo: out.messageIdHeader }), {
      sesMessageId,
      recipients: [mine.address],
      commonFrom: ['bob@example.com'],
    });
    const [row] = await inboundRows(mine.agentId, sesMessageId);
    expect(row).toMatchObject({ new_thread_reason: 'no_known_message', display_thread_id: null });
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('poison pill — 입력 때문에는 던지지 않는다', () => {
  it('알림이 JSON 이 아님 → unparsable (던지지 않는다)', async () => {
    const deps = consumerDeps(testPool(), newObjectStore());
    await expect(consumeInboundMail(deps, { receiptId: null, body: '}{' })).resolves.toBe('unparsable');
  });

  it('SNS 구독 확인 → ignored', async () => {
    const deps = consumerDeps(testPool(), newObjectStore());
    await expect(
      consumeInboundMail(deps, { receiptId: null, body: JSON.stringify({ Type: 'SubscriptionConfirmation', Message: 'x' }) }),
    ).resolves.toBe('ignored');
  });

  it('알림의 objectKey 가 inbound/raw/{messageId} 가 아니면 → unparsable, 그 객체를 읽지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const other = newSesMessageId();
    await deps.rawMail.put(other, eml({ from: 'a@example.com' }));
    const sesMessageId = newSesMessageId();
    expect(
      await deliver(deps, null, { sesMessageId, recipients: [fixture.address], objectKey: `inbound/raw/${other}` }),
    ).toBe('unparsable');
    expect(await inboundRows(fixture.agentId)).toHaveLength(0);
  });

  it('MIME 거부(From 두 개) → rejected(mime_rejected, 사유 코드만) · 행 없음 · 재전달도 같은 결말', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    const raw = eml({ from: 'a@example.com', extraHeaders: ['From: b@example.com'] });
    const options = { sesMessageId, recipients: [fixture.address] };

    expect(await deliver(deps, raw, options)).toBe('rejected');
    expect(await deliver(deps, raw, options)).toBe('rejected');
    expect((await rejections(sesMessageId)).map((row) => [row.reason, row.detail])).toEqual([
      ['mime_rejected', 'ambiguous_from'],
    ]);
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(0);
  });

  it('바이러스 FAIL → rejected(virus) · 파싱하지 않는다(파싱 결과·첨부 객체 없음) · 행 없음', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const objects = newObjectStore();
    const deps = consumerDeps(pool, objects);
    const sesMessageId = newSesMessageId();

    const outcome = await deliver(
      deps,
      eml({ from: 'a@example.com', attachment: { filename: 'x.exe', contentType: 'application/octet-stream', bytes: new Uint8Array([77, 90]) } }),
      { sesMessageId, recipients: [fixture.address], virus: 'FAIL' },
    );
    expect(outcome).toBe('rejected');
    expect((await rejections(sesMessageId)).map((row) => [row.reason, row.virus_verdict])).toEqual([['virus', 'fail']]);
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(0);
    expect(await objectExists(objects, deps.artifacts.parsedKeyFor(sesMessageId))).toBe(false);
    expect(await objectExists(objects, deps.artifacts.attachmentKeyFor(sesMessageId, 0))).toBe(false);
  });

  it('스팸 FAIL 은 저장한다(판정 기록) — 가입 확인 메일은 스팸 판정을 자주 받는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'a@example.com' }), { sesMessageId, recipients: [fixture.address], spam: 'FAIL' })).toBe(
      'stored',
    );
    expect((await inboundRows(fixture.agentId, sesMessageId))[0]?.spam_verdict).toBe('fail');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('배치 — 한 건의 결말이 나머지를 막지 않는다', () => {
  it('파싱 불가 · 저장 · 모르는 수신자가 한 배치에 섞여도 건마다 결말', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const good = newSesMessageId();
    const ghost = newSesMessageId();
    await deps.rawMail.put(good, eml({ from: 'a@example.com' }));
    await deps.rawMail.put(ghost, eml({ from: 'a@example.com' }));
    const outcomes = await consumeInboundMailBatch(deps, [
      { receiptId: null, body: 'garbage' },
      { receiptId: null, body: notification({ sesMessageId: good, recipients: [fixture.address] }) },
      { receiptId: null, body: notification({ sesMessageId: ghost, recipients: ['ghost@atmark.ai'] }) },
    ]);
    expect(outcomes).toEqual(['unparsable', 'stored', 'rejected']);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('일시 장애만 failed — 재시도가 복구한다', () => {
  it('원문이 아직 없다 → failed(재전달 대상)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    expect(await deliver(deps, null, { sesMessageId: newSesMessageId(), recipients: [fixture.address] })).toBe('failed');
  });

  it('첨부 쓰기가 한 번 실패 → failed, 행 없음 → 재시도 → stored (이미 쓴 객체는 재사용)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const healthy = newObjectStore();
    let failNext = true;
    const flaky: ObjectStore = {
      kind: healthy.kind,
      get: (key, max) => healthy.get(key, max),
      async putIfAbsent(key, bytes, contentType) {
        await healthy.putIfAbsent(key, bytes, contentType);
        // 쓴 **뒤에** 실패를 낸다 — "S3 는 받았는데 응답을 잃었다" 의 모양. 재시도는 같은 키를 다시 쓴다.
        if (key.includes('/attachments/') && failNext) {
          failNext = false;
          throw new Error('S3 503 SlowDown');
        }
      },
    };
    const deps = consumerDeps(pool, flaky);
    const sesMessageId = newSesMessageId();
    const raw = eml({
      from: 'a@example.com',
      attachment: { filename: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
    });
    const options = { sesMessageId, recipients: [fixture.address] };

    expect(await deliver(deps, raw, options)).toBe('failed');
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(0);
    expect(await deliver(deps, raw, options)).toBe('stored');
    expect(await inboundRows(fixture.agentId, sesMessageId)).toHaveLength(1);
  });

  it('DB 가 던지면 failed — 소비자는 던지지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const base = consumerDeps(pool, newObjectStore());
    const receipts: InboundStore = { ...base.receipts, recordMessage: () => Promise.reject(new Error('connection reset')) };
    expect(
      await deliver({ ...base, receipts }, eml({ from: 'a@example.com' }), {
        sesMessageId: newSesMessageId(),
        recipients: [fixture.address],
      }),
    ).toBe('failed');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('GATE B2③ 원자료 · 자동 응답', () => {
  it('Gmail 전달: 봉투 발신자(재작성) · 원 From · X-Forwarded-* 가 그대로 남는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();

    await deliver(deps, eml({ from: 'Vendor <sales@vendor.example>' }), {
      sesMessageId,
      recipients: [fixture.address],
      source: `Founder+caf_=${fixture.address.replace('@', '=')}@gmail.com`,
      commonFrom: ['Vendor <sales@vendor.example>'],
      headers: [
        { name: 'X-Forwarded-For', value: `founder@gmail.com ${fixture.address}` },
        { name: 'X-Forwarded-To', value: fixture.address },
      ],
    });
    const [row] = await inboundRows(fixture.agentId, sesMessageId);
    expect(row).toMatchObject({
      envelope_sender: `Founder+caf_=${fixture.address.replace('@', '=')}@gmail.com`,
      from_address: 'sales@vendor.example',
      forwarded_for_header: `founder@gmail.com ${fixture.address}`,
      forwarded_to_header: fixture.address,
      auto_submitted: false,
    });
  });

  it('Auto-Submitted: auto-replied → auto_submitted = true (턴에서 빠진다)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    await deliver(deps, eml({ from: 'ooo@example.com' }), {
      sesMessageId,
      recipients: [fixture.address],
      headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
    });
    expect((await inboundRows(fixture.agentId, sesMessageId))[0]?.auto_submitted).toBe(true);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('로그에 메일 내용이 없다', () => {
  it('지금까지의 모든 소비 로그에 제목·본문이 실리지 않았다', () => {
    const joined = logs.join('\n');
    expect(joined).toContain('inbound.consumed');
    expect(joined).not.toContain('본문입니다');
    expect(joined).not.toContain('안녕하세요');
  });
});
