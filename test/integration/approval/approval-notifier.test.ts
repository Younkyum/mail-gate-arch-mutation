/**
 * **소유자 승인 알림 — 실제 Postgres 위에서** (P2, §3.4 5조, 리드 결정 (b)).
 *
 * 여기서 보는 것은 DB 가 있어야만 참인 것들이다:
 *   - outbox 행이 요청과 **같은 트랜잭션**에서 생긴다(트리거) — 요청은 있는데 알림이 없는 상태가 없다.
 *   - 요청당 정확히 1행·1통 — 유니크 인덱스·종단 동결·조건부 집기.
 *   - 수신자는 `organizations.owner_email` 이다 — 다른 어디서도 오지 않는다.
 *   - `owner_email IS NULL` 은 조용히 삼켜지지 않는다(undeliverable + error 로그).
 *   - 조직당 속도 상한(시간당 10통) — 초과분은 큐에 남고 다른 조직은 영향받지 않는다.
 *
 * **실제 메일은 나가지 않는다.** SES 호출면은 호출을 기록만 하는 가짜다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { createPostgresProvisioningStore } from '../../../src/api/provisioning-store';
import { verifyApprovalLinkToken } from '../../../src/approval/magic-link';
import { rejectRequest } from '../../../src/approval/service';
import { createPostgresApprovalLinkPorts } from '../../../src/db/repositories/approval-link-use-store';
import { createPostgresApprovalStore } from '../../../src/db/repositories/approval-store';
import { provisionAgent } from '../../../src/identity/provisioning';
import {
  APPROVAL_NOTIFY_FROM_ADDRESS,
  APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG,
  createApprovalNotifier,
  type ApprovalNotifierDependencies,
} from '../../../src/notify/approval-notifier';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { runApprovalNotifier } from '../../../src/workers/approval-notifier';
import { testKeyCustody } from '../../unit/identity/fixtures';
import {
  closeTestPool,
  DATABASE_AVAILABLE,
  type Fixture,
  newIndependentPool,
  provisioningPool,
  seedFixture,
  seedMessage,
  testPool,
} from '../db/support/harness';

const RING = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST');
const HOUR_MS = 60 * 60 * 1000;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});
afterEach(() => {
  resetLogSink();
});

// ---------------------------------------------------------------------------
// 지반
// ---------------------------------------------------------------------------

interface SentCall {
  readonly from: string | undefined;
  readonly to: readonly string[];
  readonly configurationSet: string | undefined;
  readonly tags: readonly { Name?: string | undefined; Value?: string | undefined }[];
  readonly raw: string;
}

/**
 * 원문 MIME 에서 한 파트(base64)를 푼다 — 승인 알림은 2026-10-10 부터 `multipart/alternative`(text/plain → text/html, 공용 틀)다.
 * 파트 머리를 찾아 그 파트의 몸만 푼다.
 */
function mimePart(raw: string, type: 'text/plain' | 'text/html'): string {
  const at = raw.indexOf(`Content-Type: ${type}; charset=UTF-8`);
  if (at < 0) throw new Error(`메일에 ${type} 파트가 없다`);
  const body = (raw.slice(at).split('\r\n\r\n')[1] ?? '').split('\r\n--')[0] ?? '';
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

/** SES 호출면 가짜 — **호출을 기록만 한다.** `fail` 이면 던진다(전송 실패). */
function fakeClient(options: { fail?: boolean } = {}): {
  readonly client: ApprovalNotifierDependencies['client'];
  readonly calls: SentCall[];
} {
  const calls: SentCall[] = [];
  return {
    calls,
    client: {
      send(command) {
        if (options.fail === true) return Promise.reject(new Error('Throttling: rate exceeded for owner@example.com'));
        const input = command.input;
        calls.push({
          from: input.FromEmailAddress,
          to: input.Destination?.ToAddresses ?? [],
          configurationSet: input.ConfigurationSetName,
          tags: input.EmailTags ?? [],
          raw: Buffer.from(input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8'),
        });
        return Promise.resolve({ MessageId: `ses-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

/**
 * 소유자 주소를 바꾼다 — **소유자 롤로**. 앱 롤은 `owner_email` 을 UPDATE 할 수 없다(202609230730 — api 탈취가 로그인 링크를
 * 자기 메일함으로 돌리는 길을 닫았다). 첫 인자는 호출 모양을 지키려고 받기만 한다.
 */
async function setOwnerEmail(_appPool: Pool, organizationId: string, email: string | null): Promise<void> {
  await provisioningPool().query(`UPDATE organizations SET owner_email = $2 WHERE id = $1`, [organizationId, email]);
}

interface OpenOptions {
  readonly recipients?: readonly string[];
  readonly subject?: string | null;
  readonly createdAt?: Date;
  readonly ttlMs?: number;
}

/**
 * 관문이 여는 것과 같은 모양의 승인 요청 하나 — 요청 → audit 행 → 항목을 **한 트랜잭션**에서
 * (`audit-sink.ts` 의 `insertPendingWithApproval` 과 같은 순서). 알림 행은 여기서 만들지 않는다 — 트리거가 만든다.
 */
async function openApproval(pool: Pool, fixture: Fixture, options: OpenOptions = {}): Promise<{ approvalId: string; expiresAt: Date }> {
  const messageId = await seedMessage(pool, fixture.agentId);
  if (options.subject !== undefined) {
    await provisioningPool().query(`UPDATE messages SET subject = $2 WHERE id = $1`, [messageId, options.subject]);
  }
  const approvalId = randomUUID();
  const createdAt = options.createdAt ?? new Date(Date.now() - 1000);
  const expiresAt = new Date(createdAt.getTime() + (options.ttlMs ?? 24 * HOUR_MS));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertRequestAndItem(client, fixture, { approvalId, messageId, createdAt, expiresAt, recipients: options.recipients ?? ['bob@example.com'] });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { approvalId, expiresAt };
}

async function insertRequestAndItem(
  client: PoolClient,
  fixture: Fixture,
  input: { approvalId: string; messageId: string; createdAt: Date; expiresAt: Date; recipients: readonly string[] },
): Promise<void> {
  await client.query(
    `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at) VALUES ($1, $2, 'message', $3, $4)`,
    [input.approvalId, fixture.agentId, input.createdAt, input.expiresAt],
  );
  const audit = await client.query<{ id: string }>(
    `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version, approval_id)
     VALUES ($1, $2, 'pending_approval', ARRAY['approval_required'], $3, 1, $4) RETURNING id`,
    [fixture.agentId, input.messageId, fixture.policyVersionId, input.approvalId],
  );
  await client.query(
    `INSERT INTO approval_request_items (approval_id, message_id, audit_id, from_address, recipients, is_thread_reply, thread_id, cost_cents)
     VALUES ($1, $2, $3, $4, $5::text[], false, NULL, 0)`,
    [input.approvalId, input.messageId, audit.rows[0]?.id, fixture.address, [...input.recipients]],
  );
}

async function notificationRows(pool: Pool, approvalId: string): Promise<{ status: string; attempt_count: number; next_attempt_at: Date; last_error: string | null }[]> {
  const result = await pool.query<{ status: string; attempt_count: number; next_attempt_at: Date; last_error: string | null }>(
    `SELECT status::text AS status, attempt_count, next_attempt_at, last_error FROM approval_notifications WHERE approval_id = $1`,
    [approvalId],
  );
  return result.rows;
}

function notifierWith(client: ApprovalNotifierDependencies['client'], now: () => Date = () => new Date()) {
  return createApprovalNotifier({ pool: testPool(), client, keyring: RING, now });
}

// ---------------------------------------------------------------------------
// outbox 원자성 · 요청당 1행
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('outbox — 요청과 같은 트랜잭션, 요청당 정확히 1행', () => {
  it('요청 INSERT 와 같은 트랜잭션 안에서 알림 행이 이미 보인다 (커밋 전)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const messageId = await seedMessage(pool, fixture.agentId);
    const approvalId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const createdAt = new Date();
      await insertRequestAndItem(client, fixture, {
        approvalId, messageId, createdAt, expiresAt: new Date(createdAt.getTime() + HOUR_MS), recipients: ['bob@example.com'],
      });
      const inside = await client.query(`SELECT count(*)::int AS n FROM approval_notifications WHERE approval_id = $1`, [approvalId]);
      expect(inside.rows[0]?.n).toBe(1);
      // 다른 커넥션에서는 아직 안 보인다 — 트랜잭션 **안**의 행이라는 증거.
      expect(await notificationRows(pool, approvalId)).toEqual([]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const rows = await notificationRows(pool, approvalId);
    expect(rows.map((row) => row.status)).toEqual(['pending']);
  });

  it('요청 트랜잭션이 실패하면(항목 INSERT 실패) 요청도 알림도 남지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const approvalId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        insertRequestAndItem(client, fixture, {
          approvalId,
          messageId: randomUUID(), // 존재하지 않는 messages 행 — audit FK 가 거부한다.
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + HOUR_MS),
          recipients: ['bob@example.com'],
        }),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await notificationRows(pool, approvalId)).toEqual([]);
    const request = await pool.query(`SELECT 1 FROM approval_requests WHERE id = $1`, [approvalId]);
    expect(request.rowCount).toBe(0);
  });

  it('어느 경로로 열든(직접 INSERT·배치 합류의 ON CONFLICT) 요청당 알림 행은 1개다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const approvalId = randomUUID();
    const createdAt = new Date();
    const insert = `INSERT INTO approval_requests (id, agent_id, subject, created_at, expires_at)
                    VALUES ($1, $2, 'batch', $3, $4) ON CONFLICT (id) DO NOTHING`;
    const values = [approvalId, fixture.agentId, createdAt, new Date(createdAt.getTime() + HOUR_MS)];
    await pool.query(insert, values);
    await pool.query(insert, values); // 배치 합류 — 행을 만들지 않으므로 트리거도 발화하지 않는다.
    const rows = await notificationRows(pool, approvalId);
    expect(rows).toHaveLength(1);
    // 배치는 합류를 기다려 2분 늦게 집는다.
    expect(rows[0]?.next_attempt_at.getTime()).toBe(createdAt.getTime() + 2 * 60 * 1000);
  });

  it('같은 요청의 두 번째 알림 행은 유니크 인덱스가 거부한다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const { approvalId } = await openApproval(pool, fixture);
    const second = [
      `INSERT INTO approval_notifications (approval_id, organization_id, next_attempt_at) VALUES ($1, $2, now())`,
      [approvalId, fixture.organizationId],
    ] as const;
    // 앱 롤은 알림 행을 직접 만들지 못한다 — 승인 요청 트리거(SECURITY DEFINER)만 만든다(202609230750).
    await expect(pool.query(second[0], [...second[1]])).rejects.toThrow(/permission denied/);
    await expect(provisioningPool().query(second[0], [...second[1]])).rejects.toThrow(/approval_notifications_approval_id_key/);
  });

  it('종단 행은 pending 으로 돌아가지 못한다 — 두 번째 알림의 입구가 닫혀 있다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    expect(await notifierWith(fakeClient().client).notify(approvalId)).toBe('sent');
    await expect(
      pool.query(`UPDATE approval_notifications SET status = 'pending', sent_at = NULL, ses_message_id = NULL WHERE approval_id = $1`, [approvalId]),
    ).rejects.toThrow(/terminal/);
  });

  it('알림 행의 조직은 바꿀 수 없다 — UPDATE 한 줄로 다른 조직의 소유자에게 가지 못한다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const other = await seedFixture(pool);
    const { approvalId } = await openApproval(pool, fixture);
    // 앱 롤은 outbox 칸만 UPDATE 한다(202609230750 — 컬럼 단위). 권한을 가진 롤(소유자)은 트리거가 막는다.
    await expect(
      pool.query(`UPDATE approval_notifications SET organization_id = $2 WHERE approval_id = $1`, [approvalId, other.organizationId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      provisioningPool().query(`UPDATE approval_notifications SET organization_id = $2 WHERE approval_id = $1`, [approvalId, other.organizationId]),
    ).rejects.toThrow(/immutable/);
  });
});

// ---------------------------------------------------------------------------
// 수신자 · 본문 · 멱등
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('알림 발송 — 수신자는 owner_email 하나, 요청당 1통', () => {
  it('수신자는 organizations.owner_email 이고, 발신자·태그·Configuration Set 은 고정이다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    // 에이전트가 정한 수신자·제목에 주소가 있어도 그 주소로는 가지 않는다.
    const { approvalId } = await openApproval(pool, fixture, { recipients: ['victim@evil.example'], subject: 'cc: attacker@evil.example' });
    const { client, calls } = fakeClient();

    expect(await notifierWith(client).notify(approvalId)).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toEqual(['owner@example.com']);
    expect(calls[0]?.from).toBe(APPROVAL_NOTIFY_FROM_ADDRESS);
    expect(calls[0]?.raw).toMatch(/^From: "Atmark" <notify@atmark\.ai>\r?$/m);
    expect(calls[0]?.configurationSet).toBe('atmark-default');
    const notification = await pool.query<{ id: string }>(`SELECT id FROM approval_notifications WHERE approval_id = $1`, [approvalId]);
    // 에이전트 메일의 조인 태그(atmark_message_id)는 싣지 않는다 — 실으면 이벤트 소비자가 FK 에 걸린다.
    expect(calls[0]?.tags).toEqual([{ Name: 'atmark_notification_id', Value: notification.rows[0]?.id }]);
    // 헤더의 To 도 소유자 하나다.
    expect(calls[0]?.raw).toMatch(/^To: owner@example\.com\r$/m);
  });

  it('owner_email 을 바꾸면 다음 알림은 새 주소로 간다 — 수신자를 복사해 두지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'first@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    await setOwnerEmail(pool, fixture.organizationId, 'second@example.com');
    const { client, calls } = fakeClient();
    await notifierWith(client).notify(approvalId);
    expect(calls[0]?.to).toEqual(['second@example.com']);
  });

  it('링크 토큰은 DB 의 expires_at 으로 서명되고 승인 페이지 fragment 에 실린다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId, expiresAt } = await openApproval(pool, fixture, { ttlMs: 2 * HOUR_MS });
    const { client, calls } = fakeClient();
    await notifierWith(client).notify(approvalId);

    const body = mimePart(calls[0]?.raw ?? '', 'text/plain');
    const link = /https:\/\/api\.atmark\.ai\/approve#(atk_link_\S+)/.exec(body);
    expect(link).not.toBeNull();
    const verified = verifyApprovalLinkToken(RING, link?.[1] ?? '', new Date());
    expect(verified.kind).toBe('valid');
    if (verified.kind === 'valid') {
      expect(verified.claims.approvalId).toBe(approvalId);
      expect(verified.claims.expiresAt.getTime()).toBe(expiresAt.getTime());
    }
    // 본문의 URL 은 맨 위의 둘뿐이다 — 승인 페이지(주 링크) 다음 콘솔 딥 링크(그 에이전트 발신 로그의 첫 메시지). 받는 사람의 설정이 없으면 영어 한 통.
    const urls = body.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(link?.[0]);
    const first = await provisioningPool().query<{ message_id: string }>(
      'SELECT message_id::text AS message_id FROM approval_request_items WHERE approval_id = $1 ORDER BY created_at, message_id LIMIT 1',
      [approvalId],
    );
    expect(urls[1]).toBe(`https://console.atmark.ai/app#/agents/${fixture.agentId}/logs/outbound/${first.rows[0]?.message_id ?? ''}`);
    expect(body).toContain('is waiting for your approval to send an email.');
    expect(body).toContain(`Send anyway (api.atmark.ai):\n${link?.[0] ?? ''}`);
    // 조직 이름 — 피싱 구별 표지(2026-10-10 8차).
    expect(body).toMatch(/Your agent \S+ \([^)]+\) is waiting for your approval/);
    // HTML 파트 — 주 버튼(승인 확인 페이지 — 버튼 + 호스트 이름)과 버금 링크(콘솔 — 글자 링크 하나)만.
    const html = mimePart(calls[0]?.raw ?? '', 'text/html');
    const hrefs = [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([urls[0], urls[1]]);
    expect(html).toContain('>Send anyway</a>');
    expect(body.split('\n').filter((line) => !line.startsWith('│') && /[가-힣]/.test(line))).toEqual([]);
  });

  it('두 번 불러도(재전달) 두 번째는 not_due — 요청당 1통', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    const { client, calls } = fakeClient();
    const notifier = notifierWith(client);
    expect(await notifier.notify(approvalId)).toBe('sent');
    expect(await notifier.notify(approvalId)).toBe('not_due');
    expect(await Promise.all([notifier.notify(approvalId), notifier.notify(approvalId)])).toEqual(['not_due', 'not_due']);
    // 임대(5분)가 지난 뒤의 재전달도 — 막는 것은 임대가 아니라 **종단 상태**여야 한다.
    expect(await notifierWith(client, () => new Date(Date.now() + 10 * 60_000)).notify(approvalId)).toBe('not_due');
    expect(calls).toHaveLength(1);
    expect((await notificationRows(pool, approvalId)).map((row) => row.status)).toEqual(['sent']);
  });

  it('동시에 두 워커가 같은 요청을 집어도 한 통이다 (SKIP LOCKED)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    const { client, calls } = fakeClient();
    const outcomes = await Promise.all([notifierWith(client).notify(approvalId), notifierWith(client).notify(approvalId)]);
    expect(outcomes.sort()).toEqual(['not_due', 'sent']);
    expect(calls).toHaveLength(1);
  });

  it('임대를 잃은 워커의 늦은 sent 기록은 0행이다 — 결말은 다시 집은 워커가 쓴다 (markSent 펜싱, N6)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);

    /** SES 호출을 붙잡아 두는 가짜 — `release()` 전까지 응답하지 않는다. */
    const held = (messageId: string) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const client: ApprovalNotifierDependencies['client'] = {
        async send() {
          entered();
          await gate;
          return { MessageId: messageId, $metadata: {} };
        },
      };
      return { client, release, started };
    };

    const start = Date.now();
    const a = held('ses-worker-a');
    const b = held('ses-worker-b');
    // A 가 집고(시도 1) SES 에서 멈춘다. 임대(5분)가 지난 시각에 B 가 다시 집는다(시도 2) — 역시 멈춘다.
    const first = notifierWith(a.client, () => new Date(start)).notify(approvalId);
    await a.started;
    const second = notifierWith(b.client, () => new Date(start + 10 * 60_000)).notify(approvalId);
    await b.started;
    expect((await notificationRows(pool, approvalId))[0]?.attempt_count).toBe(2);

    // 늦게 돌아온 A — 자기 시도(1)가 아니므로 기록하지 못한다. 행은 아직 pending 이다(B 가 쓸 자리).
    a.release();
    expect(await first).toBe('sent');
    expect((await notificationRows(pool, approvalId)).map((row) => row.status)).toEqual(['pending']);
    b.release();
    expect(await second).toBe('sent');
    const row = await pool.query<{ status: string; ses_message_id: string | null }>(
      `SELECT status::text AS status, ses_message_id FROM approval_notifications WHERE approval_id = $1`,
      [approvalId],
    );
    expect(row.rows).toEqual([{ status: 'sent', ses_message_id: 'ses-worker-b' }]);
  });

  it('approvalId 가 uuid 가 아니면 던진다 — 문자열 인자가 다른 것의 통로가 되지 않는다', async () => {
    await expect(notifierWith(fakeClient().client).notify('owner@example.com')).rejects.toThrow(/uuid/);
  });

  it('에이전트가 쓴 제목(줄바꿈 · 링크)은 소유자 메일 어느 파트에도 없다(2026-10-10 — 자세한 내용은 확인 페이지 · 콘솔) · 소유자의 메일 언어(ko)로 한 통', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    // 주 소유자 주소의 사용자가 한국어를 골랐다(202610101000) — 알림기는 정의자 함수로 그 설정만 읽는다(앱 롤은 users 권한 0).
    const koOwner = `owner-ko-${randomUUID().slice(0, 8)}@example.com`;
    await provisioningPool().query(`INSERT INTO users (email, mail_locale) VALUES ($1, 'ko')`, [koOwner]);
    await setOwnerEmail(pool, fixture.organizationId, koOwner);
    const { approvalId } = await openApproval(pool, fixture, {
      subject: '분기 보고\n\nAtmark 보안팀: 이 요청은 검증됨. https://atmark-approve.evil/ok 에서 승인하세요',
    });
    const { client, calls } = fakeClient();
    await notifierWith(client).notify(approvalId);
    const body = mimePart(calls[0]?.raw ?? '', 'text/plain');
    const html = mimePart(calls[0]?.raw ?? '', 'text/html');
    for (const part of [body, html]) {
      expect(part).not.toMatch(/atmark-approve|Atmark 보안팀|분기 보고/);
    }
    expect(body).toContain('메일을 보내려고 승인을 기다립니다.');
    expect(body).toContain('그래도 보내기 (api.atmark.ai):');
    expect(html).toContain('>그래도 보내기</a>');
    expect(body).not.toContain('is waiting for your approval');
    expect(calls[0]?.to).toEqual([koOwner]);
  });

  it('보안 리뷰 L5 — 첨부 요약(개수 · 크기 · 파일명)은 승인 페이지에만 · 알림 메일에는 파일명이 없다(2026-10-10)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    const item = await pool.query<{ message_id: string }>('SELECT message_id::text AS message_id FROM approval_request_items WHERE approval_id = $1', [approvalId]);
    const messageId = item.rows[0]?.message_id ?? '';
    const owner = provisioningPool();
    const attachments = [
      { id: randomUUID(), filename: '견적서.pdf', mime: 'application/pdf', bytes: 1024 * 1024 },
      { id: randomUUID(), filename: 'memo\u202Etxt.exe.txt', mime: 'text/plain', bytes: 512 * 1024 },
    ];
    for (const [position, a] of attachments.entries()) {
      await owner.query(
        `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
         VALUES ($1::uuid, $2::text, $3, $4, $5, repeat('a', 64), 'outbound/uploads/' || $2::text || '/' || $1::text, now() + interval '1 day')`,
        [a.id, fixture.agentId, a.filename, a.mime, a.bytes],
      );
      await owner.query(
        `INSERT INTO message_attachments (message_id, position, attachment_id, permanent_key) VALUES ($1::uuid, $2, $3::uuid, 'outbound/attachments/' || $3::text)`,
        [messageId, position, a.id],
      );
    }
    const { client, calls } = fakeClient();
    expect(await notifierWith(client).notify(approvalId)).toBe('sent');
    const body = mimePart(calls[0]?.raw ?? '', 'text/plain');
    // 받는 사람의 설정이 없다 — 영어 한 통. 파일명(에이전트가 정한 값)은 메일에 없다.
    expect(body).not.toMatch(/견적서|memo|txt\.exe/);
    expect(body).not.toContain('\u202E');
    expect(body).toContain('is waiting for your approval to send an email.');

    const ports = createPostgresApprovalLinkPorts(pool, { keyring: RING, onApproved: () => Promise.resolve() });
    const summary = await ports.findApprovalSummary(approvalId);
    expect(summary?.attachments).toEqual({ count: 2, bytes: 1536 * 1024, names: ['견적서.pdf', 'memo\u202Etxt.exe.txt'] });
    const bare = await openApproval(pool, fixture);
    expect((await ports.findApprovalSummary(bare.approvalId))?.attachments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 조용히 삼키지 않는다 — owner_email 없음 · 결정된 요청 · 전송 실패
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('보낼 수 없는 알림은 드러난다', () => {
  it('owner_email 이 NULL 이면 undeliverable 로 닫고 error 로그를 낸다 — 보내지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool); // 기존 행과 같은 상태: owner_email NULL
    const { approvalId } = await openApproval(pool, fixture);
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const { client, calls } = fakeClient();

    expect(await notifierWith(client).notify(approvalId)).toBe('undeliverable');
    expect(calls).toEqual([]);
    const rows = await notificationRows(pool, approvalId);
    expect(rows.map((row) => [row.status, row.last_error])).toEqual([['undeliverable', 'owner_email_missing']]);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.some((entry) => entry['level'] === 'error' && entry['event'] === 'approval_notify.undeliverable')).toBe(true);
    expect(logged.some((entry) => entry['atmark.approval.notification_undeliverable'] === 1)).toBe(true);
  });

  it('보내기 전에 요청이 결정됐으면 obsolete — 결정할 수 없는 링크는 보내지 않는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    // **정상 경로(서비스)로 거절한다** — SQL 로 요청만 `rejected` 로 바꾸면 audit 행이 `pending_approval` 로 남아
    // §4.3 보조 불변식(`audit_pending_overdue`)의 거짓 위반이 공유 DB 에 쌓인다(V1 실측 132행).
    expect(await rejectRequest(createPostgresApprovalStore(pool), { approvalId, decidedBy: 'owner', now: new Date() })).toBe(true);
    const { client, calls } = fakeClient();
    expect(await notifierWith(client).notify(approvalId)).toBe('obsolete');
    expect(calls).toEqual([]);
    const overdue = await pool.query(`SELECT 1 FROM audit_pending_overdue(now()) WHERE approval_id = $1`, [approvalId]);
    expect(overdue.rowCount).toBe(0);
  });

  it('만료 시각을 넘긴 요청도 obsolete 다(스위퍼가 아직 안 돌았어도)', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId, expiresAt } = await openApproval(pool, fixture, { ttlMs: HOUR_MS });
    const { client, calls } = fakeClient();
    expect(await notifierWith(client, () => new Date(expiresAt.getTime() + 1)).notify(approvalId)).toBe('obsolete');
    expect(calls).toEqual([]);
  });

  it('전송이 실패하면 뒤로 미루고, 시도를 다 쓰면 dead 로 닫는다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    const { client } = fakeClient({ fail: true });
    let clock = Date.now();
    const notifier = notifierWith(client, () => new Date(clock));

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcomes.push(await notifier.notify(approvalId));
      // 다음 시도 시각까지 시계를 민다(속도 상한 창과 무관하게 같은 요청 하나다).
      const [row] = await notificationRows(pool, approvalId);
      clock = (row?.next_attempt_at.getTime() ?? clock) + 1;
    }
    expect(outcomes).toEqual(['retry', 'retry', 'retry', 'retry', 'dead']);
    const [row] = await notificationRows(pool, approvalId);
    expect([row?.status, row?.last_error, row?.attempt_count]).toEqual(['dead', 'send_failed', 5]);
  });
});

// ---------------------------------------------------------------------------
// 조직당 속도 상한
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('조직당 속도 상한 — 워밍업 캡과 별개의 스팸 방어', () => {
  it(`한 조직이 요청 ${String(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG + 3)}개를 만들어도 한 시간에 ${String(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG)}통 — 나머지는 큐에 남는다`, async () => {
    const pool = testPool();
    const flooding = await seedFixture(pool);
    await setOwnerEmail(pool, flooding.organizationId, 'flooded@example.com');
    const quiet = await seedFixture(pool);
    await setOwnerEmail(pool, quiet.organizationId, 'quiet@example.com');

    const floodIds: string[] = [];
    for (let index = 0; index < APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG + 3; index += 1) {
      floodIds.push((await openApproval(pool, flooding)).approvalId);
    }
    const quietId = (await openApproval(pool, quiet)).approvalId;

    const { client, calls } = fakeClient();
    const notifier = notifierWith(client);
    const outcomes = await Promise.all([...floodIds, quietId].map((id) => notifier.notify(id)));

    const toFlooded = calls.filter((call) => call.to[0] === 'flooded@example.com');
    expect(toFlooded).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG);
    expect(outcomes.filter((outcome) => outcome === 'deferred')).toHaveLength(3);
    // 다른 조직은 영향받지 않는다.
    expect(calls.filter((call) => call.to[0] === 'quiet@example.com')).toHaveLength(1);

    // 미뤄진 알림은 한 시간 창이 풀리기 전에는 다시 집히지 않는다.
    const deferred = await pool.query<{ next_attempt_at: Date }>(
      `SELECT next_attempt_at FROM approval_notifications WHERE approval_id = ANY($1::uuid[]) AND status = 'pending'`,
      [floodIds],
    );
    expect(deferred.rows).toHaveLength(3);
    for (const row of deferred.rows) expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + HOUR_MS - 60_000);

    // 창이 지나면 나간다. (워커가 아니라 notify 로 직접 — 공유 DB 의 다른 행이 워커 배치를 채우지 않게.)
    const later = notifierWith(client, () => new Date(Date.now() + HOUR_MS + 60_000));
    const drained = await Promise.all(floodIds.map((id) => later.notify(id)));
    expect(drained.filter((outcome) => outcome === 'sent')).toHaveLength(3);
    expect(calls.filter((call) => call.to[0] === 'flooded@example.com')).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG + 3);
  });

  it('워커는 기한이 된 것만 집고, 두 번 돌아도 추가 발송이 없다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner@example.com');
    const { approvalId } = await openApproval(pool, fixture);
    // 기한이 안 된 행 — 워커가 집으면 안 된다(배치 합류 대기처럼 미래의 next_attempt_at).
    const notYet = await openApproval(pool, fixture);
    await pool.query(`UPDATE approval_notifications SET next_attempt_at = now() + interval '10 minutes' WHERE approval_id = $1`, [
      notYet.approvalId,
    ]);
    // 다른 조직의 기한 된 행 — 범위를 준 배출은 건드리지 않는다.
    const other = await seedFixture(pool);
    await setOwnerEmail(pool, other.organizationId, 'other@example.com');
    const outsider = await openApproval(pool, other);

    const notificationId = (
      await pool.query<{ id: string }>(`SELECT id FROM approval_notifications WHERE approval_id = $1`, [approvalId])
    ).rows[0]?.id;
    const { client, calls } = fakeClient();
    const notifier = notifierWith(client);
    const mine = (): SentCall[] => calls.filter((call) => call.tags.some((tag) => tag.Value === notificationId));
    const scope = { organizationId: fixture.organizationId };

    // **이 조직의 행만 배출한다.** 전역 큐를 비우며 자기 행을 기다리던 구조는 병렬 부하에서 간헐 실패했다(V1 5회) —
    // 다른 테스트의 기한 된 행이 배치(50)를 채우면 이 행이 그 배출에 들지 못한다.
    const first = await runApprovalNotifier({ db: pool, notifier, now: () => new Date() }, scope);
    expect(first.sent).toBe(1);
    expect(calls.every((call) => call.to[0] === 'owner@example.com')).toBe(true);
    // **판정은 이 프로세스의 가짜 클라이언트가 아니라 DB 로 한다.** 같은 테스트 DB 를 쓰는
    // 다른 vitest 프로세스(병렬 에이전트·CI 재시도)도 알림기를 돌린다. 그쪽 클라이언트가 이
    // 행을 먼저 보내면 `mine()` 은 0 이지만 알림은 정확히 한 번 나갔다 — 2026-09-23 실제로
    // 9회 중 1회 그렇게 실패했다. "정확히 한 번" 의 증거는 행 자신이다: `sent` 는 종단
    // 동결되고(트리거), `ses_message_id` 는 발송 때 한 번만 채워진다.
    const [afterFirst] = await pool.query<{ status: string; ses_message_id: string | null; attempt_count: number }>(
      `SELECT status::text AS status, ses_message_id, attempt_count FROM approval_notifications WHERE approval_id = $1`,
      [approvalId],
    ).then((result) => result.rows);
    expect(afterFirst?.status).toBe('sent');
    expect(afterFirst?.ses_message_id).not.toBeNull();
    // 이 프로세스가 보냈다면 정확히 1통이다(0 = 다른 프로세스가 보냄, 2 = 중복 발송).
    expect(mine().length).toBeLessThanOrEqual(1);
    const sentHere = mine().length;
    expect((await notificationRows(pool, notYet.approvalId)).map((row) => row.status)).toEqual(['pending']);
    expect((await notificationRows(pool, outsider.approvalId)).map((row) => [row.status, row.attempt_count])).toEqual([['pending', 0]]);

    // 한 번 더 돌아도(재실행·재전달) 이 요청에 두 번째 알림은 없다.
    await runApprovalNotifier({ db: pool, notifier, now: () => new Date() }, scope);
    expect(mine()).toHaveLength(sentHere);
    const [afterSecond] = await pool.query<{ status: string; ses_message_id: string | null; attempt_count: number }>(
      `SELECT status::text AS status, ses_message_id, attempt_count FROM approval_notifications WHERE approval_id = $1`,
      [approvalId],
    ).then((result) => result.rows);
    expect(afterSecond).toEqual(afterFirst);
  });

  it(`상한은 **독립 풀 여럿**이 동시에 집어도 ${String(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG)}통이다 — 조직 잠금이 계수와 집기를 줄 세운다`, async () => {
    // 같은 풀 하나로 돌리면 커넥션 수가 동시성을 깎아 다른 층이 대신 막을 수 있다(P1b 경쟁 테스트의 교훈).
    // 워커 넷이 각자 풀을 쥔 운영 모양 그대로다. V1 실측: 잠금이 없으면 20건 중 13~15통이 나갔다.
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'raced@example.com');
    const ids: string[] = [];
    for (let index = 0; index < 2 * APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG; index += 1) {
      ids.push((await openApproval(pool, fixture)).approvalId);
    }

    const workers = Array.from({ length: 4 }, () => newIndependentPool({ max: 5 }));
    try {
      const { client, calls } = fakeClient();
      const notifiers = workers.map((workerPool) => createApprovalNotifier({ pool: workerPool, client, keyring: RING, now: () => new Date() }));
      const outcomes = await Promise.all(ids.map((id, index) => (notifiers[index % notifiers.length] as (typeof notifiers)[number]).notify(id)));

      expect(calls.filter((call) => call.to[0] === 'raced@example.com')).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG);
      expect(outcomes.filter((outcome) => outcome === 'sent')).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG);
      expect(outcomes.filter((outcome) => outcome === 'deferred')).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG);
      const claimed = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM approval_notifications WHERE approval_id = ANY($1::uuid[]) AND claimed_at IS NOT NULL`,
        [ids],
      );
      expect(claimed.rows[0]?.n).toBe(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG);
    } finally {
      await Promise.all(workers.map((workerPool) => workerPool.end()));
    }
  });

  it('상한은 행이 아니라 **시도**를 센다 — 한 요청의 재시도 3회는 3통으로 센다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'retried@example.com');
    const { approvalId: flaky } = await openApproval(pool, fixture);

    // 전송 실패 3회(각각 SES 에 닿았을 수 있다). 재시도 간격(1·2분)을 건너뛰도록 시계를 민다 — 창(1시간) 안이다.
    let clock = Date.now();
    const failing = notifierWith(fakeClient({ fail: true }).client, () => new Date(clock));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await failing.notify(flaky)).toBe('retry');
      const [row] = await notificationRows(pool, flaky);
      clock = (row?.next_attempt_at.getTime() ?? clock) + 1;
    }
    expect((await notificationRows(pool, flaky))[0]?.attempt_count).toBe(3);

    // 남은 몫은 10 - 3 = 7. 행으로 세면(1행) 9개가 전부 나간다.
    const rest: string[] = [];
    for (let index = 0; index < APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG - 1; index += 1) {
      rest.push((await openApproval(pool, fixture)).approvalId);
    }
    const { client, calls } = fakeClient();
    const notifier = notifierWith(client, () => new Date(clock));
    const outcomes: string[] = [];
    for (const id of rest) outcomes.push(await notifier.notify(id));
    expect(outcomes.filter((outcome) => outcome === 'sent')).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG - 3);
    expect(outcomes.filter((outcome) => outcome === 'deferred')).toHaveLength(2);
    expect(calls).toHaveLength(APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG - 3);
  });
});

// ---------------------------------------------------------------------------
// owner_email 형태 CHECK — 앱 검증이 빠져도 바닥
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_AVAILABLE)('organizations.owner_email CHECK', () => {
  it.each([
    ['에이전트 도메인', 'owner@atmark.ai'],
    ['에이전트 하위 도메인', 'owner@id.atmark.ai'],
    ['대문자', 'Owner@example.com'],
    ['CRLF(헤더 인젝션)', 'owner@example.com\r\nBcc: x@y.com'],
    ['두 주소', 'a@example.com, b@example.com'],
    ['표시 이름', 'Owner <owner@example.com>'],
  ])('%s 은 저장할 수 없다: %j', async (_label, email) => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await expect(setOwnerEmail(pool, fixture.organizationId, email)).rejects.toThrow(/organizations_owner_email_shape/);
  });

  it('정상형과 NULL(기존 행)은 저장된다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    await setOwnerEmail(pool, fixture.organizationId, 'owner+ops@sub.example.co.kr');
    await setOwnerEmail(pool, fixture.organizationId, null);
    const row = await pool.query<{ owner_email: string | null }>(`SELECT owner_email FROM organizations WHERE id = $1`, [fixture.organizationId]);
    expect(row.rows[0]?.owner_email).toBeNull();
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('프로비저닝이 owner_email 을 받는다', () => {
  it('새 조직은 정규화된 owner_email 로 태어나고, 그 조직의 승인 알림은 그 주소로 간다', async () => {
    const pool = testPool();
    const suffix = randomBytes(4).toString('hex');
    const provisioned = await provisionAgent(
      createPostgresProvisioningStore(provisioningPool()),
      {
        organization: { kind: 'create', name: `t2-owner-${suffix}`, ownerEmail: ' Boss@Example.com ' },
        agentName: `t2-${suffix}`,
        addressLocalPart: `t2-${suffix}`,
        seedContacts: [],
        monthlyBudgetCents: 1000,
        createdBy: 'test:t2',
        tokenCapabilities: null,
        outboundMode: null,
      },
      testKeyCustody(),
    );
    const stored = await pool.query<{ owner_email: string | null }>(`SELECT owner_email FROM organizations WHERE id = $1`, [
      provisioned.organization.id,
    ]);
    expect(stored.rows[0]?.owner_email).toBe('boss@example.com');
  });
});
