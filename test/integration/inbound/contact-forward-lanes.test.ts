/**
 * 문의 전달 차선(202610021000, 2026-10-02 안 A) — support@ 와 수신 전용 역할 주소(abuse@·postmaster@)가 **시간당 상한을 따로 쓴다**.
 * 실제 Postgres(앱 롤) + 로컬 객체 저장소 + 가짜 SES.
 *
 * 되돌리면 빨개져야 하는 것:
 *   ① 받아들이기: support 차선이 30 으로 차도 abuse@ 문의는 받는다(행 lane = role) · role 차선이 10 으로 차도 support@ 문의는 받는다 ·
 *      찬 차선에는 `rate_global` + 메트릭(차원 lane). support@+postmaster@ 함께 → role.
 *   ② 전달: support 차선 시도 30 이 차 있어도 role 행은 `sent` · 같은 차선 행은 `deferred`.
 *   ③ 차선 불변: 앱 롤은 lane UPDATE 권한이 없다(42501) · 소유자(마이그레이션 롤)로 바꿔도 종단 동결 트리거가 막는다.
 *   ④ 같은 발신자 상한은 차선을 가로지른다: support 3 + role 3 → 6번째 `rate_sender`.
 *   ⑤ 대칭 — role 차선 시도 10 이 차 있으면 role 행은 `deferred`, support 행은 `sent`.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { CONTACT_ADDRESS, CONTACT_FORWARD_LANE_HOURLY_CAP, type ContactLane } from '../../../src/contact/intake';
import { setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import type { ObjectStore } from '../../../src/storage/object-store';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, testPool } from '../db/support/harness';
import { consumerDeps, contactForwarder, deliver, eml, fakeSes, newObjectStore, newSesMessageId, uniqueWindow } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function forwardRow(sesMessageId: string): Promise<{ id: string; status: string; lane: string } | null> {
  const result = await testPool().query<{ id: string; status: string; lane: string }>(
    'SELECT id, status, lane FROM contact_forwards WHERE ses_message_id = $1',
    [sesMessageId],
  );
  return result.rows[0] ?? null;
}

async function rejectionCodes(sesMessageId: string): Promise<(string | null)[]> {
  const result = await testPool().query<{ detail: string | null }>(
    `SELECT detail FROM inbound_rejections WHERE ses_message_id = $1 AND reason = 'contact_not_forwarded'`,
    [sesMessageId],
  );
  return result.rows.map((row) => row.detail);
}

async function inquire(
  objects: ObjectStore,
  recipients: readonly string[],
  receivedAt: Date,
  from: string = `customer-${randomBytes(4).toString('hex')}@mail.example.com`,
): Promise<{ sesMessageId: string; outcome: string }> {
  const sesMessageId = newSesMessageId();
  const outcome = await deliver(consumerDeps(testPool(), objects), eml({ from, to: recipients[0] ?? CONTACT_ADDRESS, subject: '문의', text: '본문' }), {
    sesMessageId,
    recipients,
    source: 'bounce@mail.example.com',
    commonFrom: [from],
    receivedAt: receivedAt.toISOString(),
  });
  return { sesMessageId, outcome };
}

/** 앱 롤 INSERT 로 차선 하나를 `count` 행 채운다(수신 소비자와 같은 권한 · 발신자 모두 다름). */
async function fillLane(lane: ContactLane, count: number, window: Date): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await testPool().query(
      'INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane) VALUES ($1, $2, $3, $3, $4)',
      [newSesMessageId(), createHash('sha256').update(randomUUID()).digest('hex'), new Date(window.getTime() + i * 1000), lane],
    );
  }
}

/** 전달 쪽 시도 수를 차선 하나에 미리 채운다 — 행 `rows` 개 × 시도 `attempts`(칸 CHECK 는 행당 20 이하). */
async function seedAttempts(lane: ContactLane, rows: number, attempts: number, window: Date): Promise<void> {
  for (let i = 0; i < rows; i += 1) {
    const seeded = newSesMessageId();
    await testPool().query(
      `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane) VALUES ($1, $2, $3, $3, $4)`,
      [seeded, createHash('sha256').update(randomUUID()).digest('hex'), window, lane],
    );
    await testPool().query(
      `UPDATE contact_forwards SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE ses_message_id = $1`,
      [seeded, attempts, new Date(window.getTime() + 60_000), new Date(window.getTime() + 10 * 3_600_000)],
    );
  }
}

describe.skipIf(!DATABASE_AVAILABLE)('문의 전달 차선 — support 30 · role 10 (202610021000)', () => {
  it('① support 차선이 차도 abuse@ 는 받는다 · role 차선이 차도 support@ 는 받는다 · 찬 차선은 rate_global + 메트릭(lane)', async () => {
    const objects = newObjectStore();
    const lines: string[] = [];
    const restoreSink = setLogSink((line) => {
      lines.push(line);
    });
    try {
      // support 차선 가득.
      const supportFull = uniqueWindow(2033);
      await fillLane('support', CONTACT_FORWARD_LANE_HOURLY_CAP.support, supportFull);
      const blocked = await inquire(objects, [CONTACT_ADDRESS], new Date(supportFull.getTime() + 60_000));
      expect(blocked.outcome).toBe('rejected');
      expect(await rejectionCodes(blocked.sesMessageId)).toEqual(['rate_global']);
      const abuse = await inquire(objects, ['abuse@atmark.ai'], new Date(supportFull.getTime() + 61_000));
      expect(abuse.outcome).toBe('stored');
      expect(await forwardRow(abuse.sesMessageId)).toMatchObject({ status: 'pending', lane: 'role' });

      // role 차선 가득.
      const roleFull = uniqueWindow(2033);
      await fillLane('role', CONTACT_FORWARD_LANE_HOURLY_CAP.role, roleFull);
      const roleBlocked = await inquire(objects, ['postmaster@atmark.ai'], new Date(roleFull.getTime() + 60_000));
      expect(roleBlocked.outcome).toBe('rejected');
      expect(await rejectionCodes(roleBlocked.sesMessageId)).toEqual(['rate_global']);
      // support@ + postmaster@ 함께 → role 차선 — 역시 찼다.
      const mixed = await inquire(objects, [CONTACT_ADDRESS, 'postmaster@atmark.ai'], new Date(roleFull.getTime() + 61_000));
      expect(await rejectionCodes(mixed.sesMessageId)).toEqual(['rate_global']);
      const support = await inquire(objects, [CONTACT_ADDRESS], new Date(roleFull.getTime() + 62_000));
      expect(support.outcome).toBe('stored');
      expect(await forwardRow(support.sesMessageId)).toMatchObject({ status: 'pending', lane: 'support' });
    } finally {
      restoreSink();
    }
    // 메트릭 — 거부 셋, 각각 차원 없는 롤업(알람 8)과 lane 차원을 함께 싣는다.
    const metrics = lines
      .filter((line) => line.includes(`"${METRIC_NAMES.contactRateGlobal}":1`))
      .map((line) => JSON.parse(line) as { lane?: string; _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] } });
    expect(metrics.map((metric) => metric.lane)).toEqual(['support', 'role', 'role']);
    for (const metric of metrics) expect(metric._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['lane', 'route_id']]);
  });

  it('② 전달 — support 차선 시도 30 이 차 있어도 role 행은 sent · 같은 차선(support) 행은 deferred', async () => {
    const objects = newObjectStore();
    const window = uniqueWindow(2033);
    // support 차선 시도 30(행 둘 × 15).
    for (let i = 0; i < 2; i += 1) {
      const seeded = newSesMessageId();
      await testPool().query(
        `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane) VALUES ($1, $2, $3, $3, 'support')`,
        [seeded, createHash('sha256').update(randomUUID()).digest('hex'), window],
      );
      await testPool().query(
        `UPDATE contact_forwards SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE ses_message_id = $1`,
        [seeded, CONTACT_FORWARD_LANE_HOURLY_CAP.support / 2, new Date(window.getTime() + 60_000), new Date(window.getTime() + 10 * 3_600_000)],
      );
    }
    const role = await inquire(objects, ['abuse@atmark.ai'], new Date(window.getTime() + 60_000));
    const support = await inquire(objects, [CONTACT_ADDRESS], new Date(window.getTime() + 61_000));
    expect([role.outcome, support.outcome]).toEqual(['stored', 'stored']);

    const ses = fakeSes();
    const forwarder = contactForwarder(objects, ses.client, new Date(window.getTime() + 120_000));
    expect(await forwarder.forward((await forwardRow(support.sesMessageId))?.id ?? '')).toBe('deferred');
    expect(ses.sent).toEqual([]);
    expect(await forwarder.forward((await forwardRow(role.sesMessageId))?.id ?? '')).toBe('sent');
    expect(ses.sent).toHaveLength(1);
    expect(await forwardRow(role.sesMessageId)).toMatchObject({ status: 'sent', lane: 'role' });
    expect(await forwardRow(support.sesMessageId)).toMatchObject({ status: 'pending', lane: 'support' });
  });

  it('③ 차선 불변 — 앱 롤은 UPDATE 권한 없음(42501) · 소유자도 트리거가 막는다 · 닫힌 두 값(CHECK)', async () => {
    const window = uniqueWindow(2033);
    const sesMessageId = newSesMessageId();
    await testPool().query(
      `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane) VALUES ($1, $2, $3, $3, 'role')`,
      [sesMessageId, createHash('sha256').update(randomUUID()).digest('hex'), window],
    );
    await expect(testPool().query(`UPDATE contact_forwards SET lane = 'support' WHERE ses_message_id = $1`, [sesMessageId])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      testPool().query(
        `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at, lane) VALUES ($1, $2, $3, $3, 'vip')`,
        [newSesMessageId(), createHash('sha256').update(randomUUID()).digest('hex'), window],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 소유자 롤(권한 우회) — 트리거가 마지막 문이다.
    await expect(
      provisioningPool().query(`UPDATE contact_forwards SET lane = 'support' WHERE ses_message_id = $1`, [sesMessageId]),
    ).rejects.toThrow(/identity columns are immutable/);
    expect(await forwardRow(sesMessageId)).toMatchObject({ lane: 'role' });
  });

  it('④ 같은 발신자 상한은 차선을 가로지른다 — support 3 + role 3 이면 6번째가 rate_sender', async () => {
    const objects = newObjectStore();
    const window = uniqueWindow(2033);
    const from = `repeat-${randomBytes(4).toString('hex')}@mail.example.com`;
    const outcomes: string[] = [];
    const codes: (string | null)[][] = [];
    for (let i = 0; i < 6; i += 1) {
      const recipients = i < 3 ? [CONTACT_ADDRESS] : ['abuse@atmark.ai'];
      const result = await inquire(objects, recipients, new Date(window.getTime() + i * 60_000), from);
      outcomes.push(result.outcome);
      codes.push(await rejectionCodes(result.sesMessageId));
    }
    expect(outcomes).toEqual(['stored', 'stored', 'stored', 'stored', 'stored', 'rejected']);
    expect(codes[5]).toEqual(['rate_sender']);
  });

  it('⑤ 대칭 — role 차선 시도 10 이 차 있으면 role 행은 deferred · support 행은 sent', async () => {
    const objects = newObjectStore();
    const window = uniqueWindow(2033);
    await seedAttempts('role', 1, CONTACT_FORWARD_LANE_HOURLY_CAP.role, window);
    const role = await inquire(objects, ['postmaster@atmark.ai'], new Date(window.getTime() + 60_000));
    const support = await inquire(objects, [CONTACT_ADDRESS], new Date(window.getTime() + 61_000));
    expect([role.outcome, support.outcome]).toEqual(['stored', 'stored']);

    const ses = fakeSes();
    const forwarder = contactForwarder(objects, ses.client, new Date(window.getTime() + 120_000));
    expect(await forwarder.forward((await forwardRow(role.sesMessageId))?.id ?? '')).toBe('deferred');
    expect(ses.sent).toEqual([]);
    expect(await forwarder.forward((await forwardRow(support.sesMessageId))?.id ?? '')).toBe('sent');
    expect(ses.sent).toHaveLength(1);
    expect(await forwardRow(role.sesMessageId)).toMatchObject({ status: 'pending', lane: 'role' });
    expect(await forwardRow(support.sesMessageId)).toMatchObject({ status: 'sent', lane: 'support' });
  });
});
