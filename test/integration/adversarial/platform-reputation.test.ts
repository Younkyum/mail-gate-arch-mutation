/**
 * **공유 도메인(`atmark.ai`) 조직 평판 자동 동결 — 적대 검증**(202610131610 · 1620, 2026-10-13 보안 후속 Medium). 실제 Postgres · 운영과 같은 롤 ·
 * 실제 SES 이벤트 소비자 · 실제 관문.
 *
 *   ① 판정 식 — DB 정의자 `atmark_platform_reputation_judge` = TS `judgePlatformReputation`(경계 · 무작위 격자).
 *   ② 끝에서 끝 — 메일 발송 → SES complaint 이벤트 셋(소비자) → 조직 `abuse_freeze` · 감사 1행(`system:platform_reputation` · 사유) · 투명성 로그
 *      outbox · 다음 발송은 Stage 0 `org_abuse_freeze` 로 거부(전송 0).
 *   ③ 우회 시도 — 에이전트 여럿에 나누기 · 별칭 주소 · 삭제한 에이전트 · 정지한 에이전트 · 일시(transient) bounce 로 위장 · 다른 조직의 메시지 id 로
 *      남을 얼리기 · 앱 롤로 직접 동결 · admin 롤로 운영자 감사 행 사칭 · 동시 판정 경합.
 *   ④ 얼리지 않는 것 — 최소 건수 아래 · 고객 도메인 발신 · 다른 조직의 사건 · 7일 밖 · 운영자 예약 주소 조직(`freeze_exempt`).
 *   ⑤ 해제 — `admin:kill-switch --org … off` 는 `--reason` 필수 · 감사 1행(`org.abuse_unfreeze`) · 해제 뒤에는 그 뒤의 사건만 센다(옛 반송으로 다시 얼지
 *      않는다) · 새 사건이 선을 넘으면 다시 언다.
 *
 * 실메일 0 · AWS 0.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminIo } from '../../../scripts/admin/common';
import { killSwitch } from '../../../scripts/admin/kill-switch';
import { complaintHashes, createPostgresSesEventStore } from '../../../src/db/repositories/ses-event-store';
import { ATMARK_MESSAGE_ID_TAG } from '../../../src/mail/events/tag';
import {
  canonicalComplainant,
  COMPLAINT_HASH_RETENTION_DAYS,
  complaintDomainFamily,
  judgePlatformReputation,
  PLATFORM_REPUTATION_ACTOR,
  PLATFORM_REPUTATION_THRESHOLDS,
  type PlatformReputationCounts,
} from '../../../src/mail/events/platform-reputation';
import { consumeSesEvent } from '../../../src/workers/ses-event-consumer';
import { adminRolePool, appPool, AVAILABLE, newOrganization, OWNER_URL, ownerPool, userIdOf } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, recordTlogCapabilities, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { setOrganizationFreezeAuditedOp } from '../../../src/admin/ops/agents';
import { createPostgresComplaintHashRetention } from '../../../src/db/repositories/complaint-hash-retention';
import { transactionPool } from '../../../src/admin/ops/transaction';
import { TLOG_SEQUENCER_CAPABILITIES } from '../../../src/tlog/sequencer';
import { send, world } from '../security/support';

const silentIo: AdminIo = { out: () => undefined, err: () => undefined, interactive: false, ask: () => Promise.resolve('') };

describe.skipIf(!AVAILABLE || !DATABASE_AVAILABLE)('공유 도메인 조직 평판 자동 동결 — 적대 검증', { timeout: 300_000 }, () => {
  let owner: Pool;
  let app: Pool;
  let admin: Pool;

  beforeAll(async () => {
    owner = ownerPool();
    app = appPool();
    admin = adminRolePool();
    await recordTlogCapabilities();
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), admin.end()]);
    await closeTestPool();
  });

  // ------------------------------------------------------------------------------------------------ 도우미

  async function newAgent(organizationId: string, status: 'active' | 'disabled' | 'suspended' = 'active'): Promise<string> {
    const id = randomUUID().replace(/-/g, '');
    await provisioningPool().query(
      `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents, suspended_by)
       VALUES ($1, $2, $3, $4, 'free', 100000, $5)`,
      [id, organizationId, `rep-${id.slice(0, 8)}`, status, status === 'suspended' ? 'operator' : null],
    );
    return id;
  }

  /** 발신 메시지 한 행(관문을 지난 것과 같은 칸). `fromDomain` 이 고객 도메인이면 그 도메인. */
  async function message(agentId: string, fromDomain = 'atmark.ai'): Promise<string> {
    const row = await provisioningPool().query<{ id: string }>(
      `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
       INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                             recipient_count, sent_at, ses_message_id, thread_id)
       VALUES ($1, 'outbound', $2, $3, 'sent', $4, $5, $2, 1, now(), $6, (SELECT id FROM thread)) RETURNING id::text AS id`,
      [agentId, 'a'.repeat(64), fromDomain, `<${randomUUID()}@${fromDomain}>`, randomUUID(), `ses-${randomUUID()}`],
    );
    return row.rows[0]?.id ?? '';
  }

  let complainerSeq = 0;
  /**
   * SES 이벤트 한 행을 직접(소비자를 거치지 않는 배경 이력 — 저장소가 적는 것과 같은 칸). `agoHours` 만큼 전에 받은 것으로. complaint 는 기본으로
   * **매번 다른 신고자**(도메인 둘을 번갈아)다 — 같은 사람을 쓰려면 `complainer`.
   */
  async function event(
    messageId: string,
    type: 'delivery' | 'bounce' | 'complaint',
    options: { bounceType?: string; agoHours?: number; recipients?: number; subType?: string; complainer?: string } = {},
  ): Promise<void> {
    complainerSeq += 1;
    const hashes = type === 'complaint' ? complaintHashes([options.complainer ?? `c${String(complainerSeq)}@d${String(complainerSeq % 2)}.example`]) : null;
    await provisioningPool().query(
      `INSERT INTO ses_events (message_id, event_type, event_at, received_at, dedupe_key, bounce_type, recipient_count, bounce_subtype,
                               complaint_recipient_hashes, complaint_domain_hashes)
       VALUES ($1, $2, now() - make_interval(hours => $5), now() - make_interval(hours => $5), encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4, $6, $7, $8, $9)`,
      [
        messageId,
        type,
        randomUUID(),
        type === 'bounce' ? (options.bounceType ?? 'permanent') : null,
        options.agoHours ?? 0,
        options.recipients ?? 1,
        type === 'bounce' ? (options.subType ?? null) : null,
        hashes?.recipients ?? null,
        hashes?.domains ?? null,
      ],
    );
  }

  /** 앱 롤 저장소의 판정(소비자가 부르는 것과 같은 경로). */
  async function check(messageId: string) {
    return createPostgresSesEventStore(app).checkPlatformReputation(messageId);
  }

  async function frozen(organizationId: string): Promise<boolean> {
    const row = await owner.query<{ abuse_freeze: boolean }>('SELECT abuse_freeze FROM organizations WHERE id = $1', [organizationId]);
    return row.rows[0]?.abuse_freeze === true;
  }

  async function freezeAudits(organizationId: string): Promise<{ action: string; operator_actor: string; operator_reason: string; id: string }[]> {
    const rows = await owner.query<{ action: string; operator_actor: string; operator_reason: string; id: string }>(
      `SELECT id::text AS id, action, operator_actor, operator_reason FROM owner_actions
        WHERE organization_id = $1 AND action IN ('org.abuse_freeze', 'org.abuse_unfreeze') ORDER BY created_at, id`,
      [organizationId],
    );
    return rows.rows;
  }

  /** SES 가 보내는 모양의 이벤트 본문(소비자 · 파서가 읽는 그대로). `nonce` 가 본문을 바꿔 서로 다른 사건이 된다. */
  function sesBody(messageId: string, type: 'Complaint' | 'Bounce' | 'Delivery', nonce: string, bounceType = 'Permanent', complainer?: string): string {
    const at = new Date().toISOString();
    const detail =
      type === 'Complaint'
        ? { complaint: { timestamp: at, feedbackId: nonce, complainedRecipients: [{ emailAddress: complainer ?? `c-${nonce.slice(0, 8)}@d${nonce.slice(0, 1)}.example` }] } }
        : type === 'Bounce'
          ? { bounce: { timestamp: at, feedbackId: nonce, bounceType, bouncedRecipients: [{ emailAddress: 'someone@example.com' }] } }
          : { delivery: { timestamp: at, recipients: Array.from({ length: 50 }, (_, i) => `r${String(i)}@example.com`), processingTimeMillis: Number.parseInt(nonce.slice(0, 4), 16) } };
    return JSON.stringify({ eventType: type, mail: { timestamp: at, messageId: `ses-${nonce}`, tags: { [ATMARK_MESSAGE_ID_TAG]: [messageId] } }, ...detail });
  }

  let consumeSeq = 0;
  async function consume(messageId: string, type: 'Complaint' | 'Bounce' | 'Delivery', options: { bounceType?: string; complainer?: string } = {}) {
    consumeSeq += 1;
    // 기본 신고자는 매번 다른 사람 · 도메인 둘을 번갈아(서로 다른 신고자 · 도메인으로 센다).
    const complainer = options.complainer ?? `c${String(consumeSeq)}@d${String(consumeSeq % 2)}.example`;
    return consumeSesEvent(
      { events: createPostgresSesEventStore(app), now: () => new Date() },
      { receiptId: randomUUID(), body: sesBody(messageId, type, randomUUID(), options.bounceType, complainer) },
    );
  }

  // ------------------------------------------------------------------------------------------------ ① 판정 식

  describe('① 판정 식 — SQL = TS', () => {
    async function sqlJudge(week: PlatformReputationCounts, day: PlatformReputationCounts, account: number) {
      const row = await owner.query<{ action: string; reasons: string[] }>(
        'SELECT action, reasons FROM atmark_platform_reputation_judge($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [week.attempts, week.bounces, week.complaints, week.complaintDomains, day.attempts, day.bounces, day.complaints, day.complaintDomains, account],
      );
      return { action: row.rows[0]?.action, reasons: row.rows[0]?.reasons };
    }

    it('경계 · 손으로 고른 표 — 도메인 둘 · bounce 볼륨 바닥 50 · 계정 기여분 조직 바닥 200', async () => {
      const zero = { attempts: 0, bounces: 0, complaints: 0, complaintDomains: 0 };
      const c = (attempts: number, bounces: number, complaints: number, complaintDomains = complaints >= 2 ? 2 : complaints) => ({ attempts, bounces, complaints, complaintDomains });
      const cases: [PlatformReputationCounts, PlatformReputationCounts, number][] = [
        [zero, zero, 0],
        [c(1000, 0, 2), zero, 1_000_000],
        [c(1000, 0, 3), zero, 1_000_000],
        [c(1000, 0, 3, 1), zero, 1_000_000],
        [c(3750, 0, 3), zero, 1_000_000],
        [c(3751, 0, 3), zero, 1_000_000],
        [c(9, 9, 0), zero, 1_000_000],
        [c(10, 10, 0), zero, 1_000_000],
        [c(49, 10, 0), zero, 1_000_000],
        [c(50, 10, 0), zero, 1_000_000],
        [c(200, 10, 0), zero, 1_000_000],
        [c(150, 10, 0), zero, 1_000_000],
        [c(100_000, 10, 0), zero, 1000],
        [c(100_000, 10, 0), zero, 1001],
        [c(199, 0, 3), zero, 15_000],
        [c(100_000, 0, 3), zero, 15_000],
        [c(100_000, 0, 3, 1), zero, 15_000],
        [c(100_000, 0, 3), zero, 15_001],
        [c(199, 10, 0), zero, 1000],
        [zero, c(100, 0, 3), 0],
        [zero, c(100, 0, 3, 1), 0],
        [c(50, 5, 0), zero, 1_000_000],
      ];
      for (const [week, day, account] of cases) {
        const ts = judgePlatformReputation({ week, day, accountAttemptsWeek: account });
        expect(await sqlJudge(week, day, account), JSON.stringify({ week, day, account })).toEqual({ action: ts.action, reasons: [...ts.reasons] });
      }
      const judge = (week: PlatformReputationCounts, account = 1_000_000) => judgePlatformReputation({ week, day: zero, accountAttemptsWeek: account });
      // 최소 건수 · 도메인 둘 · 볼륨 바닥.
      expect(judge(c(2, 0, 2)).action).toBe('warn');
      expect(judge(c(49, 0, 3, 2)).action).toBe('warn'); // 신고 경로 볼륨 바닥(R-1)
      expect(judge(c(100, 0, 3, 1)).action).toBe('warn'); // 한 도메인의 셋 — 얼리지 않는다(M-3)
      expect(judge(c(100, 0, 3, 2)).action).toBe('freeze');
      expect(judge(c(49, 20, 0)).action).toBe('warn'); // bounce 볼륨 바닥(M-3)
      expect(judge(c(50, 20, 0)).action).toBe('freeze');
      // 계정 기여분은 조직 7일 전달 ≥ 200 일 때만(M-3) — 계정이 작아도 소량 조직은 이 경로로 얼지 않는다.
      expect(judge(c(199, 10, 0), 1000).action).not.toBe('freeze');
      expect(judge(c(200, 10, 0), 1000).reasons).toEqual(['7d:account_bounce_contribution']);
      expect(PLATFORM_REPUTATION_THRESHOLDS.freezeComplaintMinCount).toBe(3);
      expect(PLATFORM_REPUTATION_THRESHOLDS.freezeComplaintMinDomains).toBe(2);
      expect(PLATFORM_REPUTATION_THRESHOLDS.freezeBounceMinCount).toBe(10);
      expect(PLATFORM_REPUTATION_THRESHOLDS.freezeBounceMinAttempts).toBe(50);
      expect(PLATFORM_REPUTATION_THRESHOLDS.freezeAccountMinOrgAttempts).toBe(200);
    });

    it('무작위 격자 400 — 결정 · 사유 모두 같다', async () => {
      let seed = 20261013;
      const rand = (n: number): number => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      for (let i = 0; i < 400; i += 1) {
        const weekAttempts = rand(5000);
        // bounce 가 시도를 넘는 비현실적 입력도 섞는다(자르기 — SQL 이 던지지 않는다).
        const complaints = rand(8);
        const week = { attempts: weekAttempts, bounces: rand(Math.max(1, Math.floor(weekAttempts / 8) + 15)), complaints, complaintDomains: Math.min(complaints, rand(4)) };
        const dayAttempts = rand(weekAttempts + 1);
        const dayComplaints = Math.min(week.complaints, rand(5));
        const day = { attempts: dayAttempts, bounces: Math.min(week.bounces, rand(20)), complaints: dayComplaints, complaintDomains: Math.min(dayComplaints, week.complaintDomains, rand(3)) };
        const account = weekAttempts + rand(200_000);
        const ts = judgePlatformReputation({ week, day, accountAttemptsWeek: account });
        expect(await sqlJudge(week, day, account), JSON.stringify({ week, day, account })).toEqual({ action: ts.action, reasons: [...ts.reasons] });
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ ② 끝에서 끝

  it('★ ② 발송 → complaint 셋(실제 소비자) → 조직 동결 · 감사 · 투명성 로그 outbox · 다음 발송은 Stage 0 거부(전송 0)', async () => {
    const w = await world({ mode: 'unrestricted' });
    const first = await send(w, { to: ['someone@example.com'] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const sent = await owner.query<{ id: string }>(`SELECT id::text AS id FROM messages WHERE agent_id = $1 AND direction = 'outbound'`, [w.fixture.agentId]);
    const messageId = sent.rows[0]?.id ?? '';
    expect(await consume(messageId, 'Delivery')).toBe('recorded');
    expect(await consume(messageId, 'Complaint')).toBe('recorded');
    expect(await consume(messageId, 'Complaint')).toBe('recorded');
    expect(await frozen(w.fixture.organizationId)).toBe(false);
    expect(await consume(messageId, 'Complaint')).toBe('recorded');
    expect(await frozen(w.fixture.organizationId)).toBe(true);

    const audits = await freezeAudits(w.fixture.organizationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'org.abuse_freeze', operator_actor: PLATFORM_REPUTATION_ACTOR });
    expect(audits[0]?.operator_reason).toMatch(/complaint/);
    expect(audits[0]?.operator_reason).toContain('complainers=3 complaint_domains=2');
    // 사유에 주소 · 본문이 없다.
    expect(audits[0]?.operator_reason).not.toContain('@');
    const outbox = await owner.query("SELECT 1 FROM tlog_outbox WHERE source_table = 'owner_actions' AND source_id = $1", [audits[0]?.id]);
    expect(outbox.rowCount).toBe(1);

    const before = w.transport.calls();
    const blocked = await send(w, { to: ['someone@example.com'] });
    expect(blocked.status).not.toBe(200);
    expect(JSON.stringify(blocked.body)).toContain('org_abuse_freeze');
    expect(w.transport.calls()).toBe(before);

    // 같은 사건의 재전달 · 넷째 complaint — 이미 동결이라 감사 행이 늘지 않는다.
    expect(await consume(messageId, 'Complaint')).toBe('recorded');
    expect(await freezeAudits(w.fixture.organizationId)).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ ③ 우회 시도

  describe('③ 우회 시도', () => {
    it('★ 에이전트 셋에 complaint 하나씩 나누기 — 조직 합으로 언다', async () => {
      const f = await seedFixture(testPool());
      const agents = [f.agentId, await newAgent(f.organizationId), await newAgent(f.organizationId)];
      const ids: string[] = [];
      for (const agent of agents) {
        const id = await message(agent);
        ids.push(id);
        await event(id, 'delivery', { recipients: 50 });
      }
      await event(ids[0] ?? '', 'complaint');
      await event(ids[1] ?? '', 'complaint');
      expect((await check(ids[1] ?? ''))?.outcome).not.toBe('frozen');
      await event(ids[2] ?? '', 'complaint');
      expect(await check(ids[2] ?? '')).toMatchObject({ organizationId: f.organizationId, outcome: 'frozen' });
      expect(await frozen(f.organizationId)).toBe(true);
    });

    it('★ 삭제한 에이전트 · 운영자 정지 에이전트의 사건도 센다(지워서 지표를 비우지 못한다)', async () => {
      const f = await seedFixture(testPool());
      const deleted = await newAgent(f.organizationId, 'disabled');
      const suspended = await newAgent(f.organizationId, 'suspended');
      const a = await message(deleted);
      const b = await message(suspended);
      await event(a, 'delivery', { recipients: 50 });
      await event(b, 'delivery', { recipients: 50 });
      await event(a, 'complaint');
      await event(a, 'complaint');
      await event(b, 'complaint');
      expect(await check(b)).toMatchObject({ outcome: 'frozen' });
    });

    it('★ 별칭 주소(atmark.ai)로 보낸 메일도 같은 조직 합 — 주소가 아니라 도메인 · 조직으로 센다', async () => {
      const f = await seedFixture(testPool());
      // 별칭 발신도 `messages.from_domain = 'atmark.ai'` 다(주소 해시만 다르다).
      const alias = await provisioningPool().query<{ id: string }>(
        `WITH thread AS (INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id)
         INSERT INTO messages (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, sent_at, ses_message_id, thread_id)
         VALUES ($1, 'outbound', $2, 'atmark.ai', 'sent', $3, $4, $2, 1, now(), $5, (SELECT id FROM thread)) RETURNING id::text AS id`,
        [f.agentId, 'b'.repeat(64), `<${randomUUID()}@atmark.ai>`, randomUUID(), `ses-${randomUUID()}`],
      );
      const primary = await message(f.agentId);
      await event(primary, 'delivery', { recipients: 50 });
      await event(primary, 'complaint');
      await event(primary, 'complaint');
      await event(alias.rows[0]?.id ?? '', 'complaint');
      expect(await check(alias.rows[0]?.id ?? '')).toMatchObject({ outcome: 'frozen' });
    });

    it('★ 영구 bounce 10건이면 언다 · 일시(transient) bounce 로는 세지 않는다(위장해도 분자가 아니다 — 분모에만)', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      for (let i = 0; i < 30; i += 1) await event(id, 'bounce', { bounceType: 'transient' });
      for (let i = 0; i < 20; i += 1) await event(id, 'delivery', { recipients: 1 });
      expect(await check(id)).toMatchObject({ outcome: 'ok' });
      for (let i = 0; i < 9; i += 1) await event(id, 'bounce');
      expect((await check(id))?.outcome).not.toBe('frozen');
      await event(id, 'bounce');
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
      expect((await freezeAudits(f.organizationId))[0]?.operator_reason).toMatch(/bounce/);
    });

    it('★ 다른 조직의 메시지 id 로 불러도 그 조직 자신의 지표로만 판정한다 — 깨끗한 조직은 얼지 않는다 · 앱 롤은 직접 동결하지 못한다', async () => {
      const clean = await seedFixture(testPool());
      const cleanMessage = await message(clean.agentId);
      await event(cleanMessage, 'delivery', { recipients: 50 });
      const dirty = await seedFixture(testPool());
      const dirtyMessage = await message(dirty.agentId);
      for (let i = 0; i < 3; i += 1) await event(dirtyMessage, 'complaint');
      // 깨끗한 조직의 메시지로 몇 번을 불러도 그 조직은 ok.
      for (let i = 0; i < 3; i += 1) expect(await check(cleanMessage)).toMatchObject({ organizationId: clean.organizationId, outcome: 'ok' });
      expect(await frozen(clean.organizationId)).toBe(false);
      // 앱 롤은 동결 칸 · 감사 표에 직접 쓰지 못한다.
      await expect(app.query('UPDATE organizations SET abuse_freeze = true WHERE id = $1', [clean.organizationId])).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'org.abuse_unfreeze', NULL, 'system:x', 'r')`, [
          dirty.organizationId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      // 없는 메시지 · 판정 행 없음.
      expect(await check(randomUUID())).toBeNull();
    });

    it('★ admin 롤(표 INSERT 권한)은 운영자 · 시스템 행위자 감사 행을 사칭하지 못한다 — 가드 트리거 42501 · 셋 다 비거나 둘 이상이면 CHECK', async () => {
      const f = await seedFixture(testPool());
      await expect(
        admin.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'org.abuse_unfreeze', NULL, $2, 'r')`, [
          f.organizationId,
          PLATFORM_REPUTATION_ACTOR,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      // 소유자 롤이라도 모양은 지켜야 한다.
      await expect(
        owner.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'org.abuse_freeze', NULL, $2, NULL)`, [
          f.organizationId,
          PLATFORM_REPUTATION_ACTOR,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'org.abuse_freeze', NULL, 'root', 'r')`, [
          f.organizationId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        owner.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'org.abuse_freeze', NULL, 'admin:x:y', E'line\\nbreak')`, [
          f.organizationId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(owner.query(`INSERT INTO owner_actions (organization_id, action, target_id) VALUES ($1, 'org.abuse_freeze', NULL)`, [f.organizationId])).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('★ 콘솔 세션 행위자로 적은 `org.abuse_unfreeze` 는 창을 지우지 못한다 — 운영자 행위자 행만 센다', async () => {
      const organization = await newOrganization(owner);
      const user = await userIdOf(owner, organization.ownerEmail);
      const link = await owner.query<{ id: string }>(
        `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, expires_at, next_attempt_at)
         VALUES ($1, $2, $3, date_trunc('milliseconds', now() + interval '10 minutes'), now()) RETURNING id`,
        [organization.id, user, 'e'.repeat(64)],
      );
      const session = await owner.query<{ id: string }>(
        `INSERT INTO owner_sessions (organization_id, user_id, login_link_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id::text AS id`,
        [organization.id, user, link.rows[0]?.id, randomBytes(32).toString('hex')],
      );
      const agent = await newAgent(organization.id);
      const id = await message(agent);
      await event(id, 'delivery', { recipients: 50 });
      await event(id, 'complaint');
      await event(id, 'complaint');
      // admin 롤(콘솔)은 세션 행위자로 아무 행위 코드나 적을 수 있다 — 그 행으로 창을 지우려는 시도.
      await admin.query(`INSERT INTO owner_actions (session_id, organization_id, action, target_id) VALUES ($1, $2, 'org.abuse_unfreeze', NULL)`, [
        session.rows[0]?.id,
        organization.id,
      ]);
      await event(id, 'complaint');
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    });

    it('★ 동시 판정 여덟 — 동결은 한 번 · 감사 1행', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 4; i += 1) await event(id, 'complaint');
      const results = await Promise.all(Array.from({ length: 8 }, () => check(id)));
      expect(results.filter((r) => r?.outcome === 'frozen')).toHaveLength(1);
      expect(results.filter((r) => r?.outcome === 'already_frozen')).toHaveLength(7);
      expect(await freezeAudits(f.organizationId)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------ ④ 얼리지 않는 것

  describe('④ 얼리지 않는 것', () => {
    it('complaint 2건(최소 건수 아래) — 비율이 높아도 경고만', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      await event(id, 'complaint');
      await event(id, 'complaint');
      expect(await check(id)).toMatchObject({ outcome: 'warn' });
      expect(await frozen(f.organizationId)).toBe(false);
    });

    it('고객 도메인 발신은 not_platform(도메인 평판이 본다) · 같은 조직의 고객 도메인 사건은 atmark.ai 지표에 들지 않는다', async () => {
      const f = await seedFixture(testPool());
      const custom = await message(f.agentId, `agents.${randomUUID().slice(0, 8)}.example`);
      for (let i = 0; i < 5; i += 1) await event(custom, 'complaint');
      expect(await check(custom)).toMatchObject({ outcome: 'not_platform' });
      const platform = await message(f.agentId);
      await event(platform, 'delivery', { recipients: 50 });
      expect(await check(platform)).toMatchObject({ outcome: 'ok' });
      expect(await frozen(f.organizationId)).toBe(false);
    });

    it('7일 밖의 사건은 세지 않는다 · 24시간 밖 7일 안은 7일 창에 든다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { agoHours: 24 * 8, recipients: 50 });
      for (let i = 0; i < 5; i += 1) await event(id, 'complaint', { agoHours: 24 * 8 });
      expect(await check(id)).toMatchObject({ outcome: 'ok' });
      await event(id, 'delivery', { agoHours: 48, recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint', { agoHours: 48 });
      const result = await check(id);
      expect(result?.outcome).toBe('frozen');
      expect(result?.reasons.some((reason) => reason.startsWith('7d:'))).toBe(true);
      expect(result?.reasons.some((reason) => reason.startsWith('24h:'))).toBe(false);
    });

    it('★ 운영자 예약 주소 조직 — 동결선을 넘어도 freeze_exempt(쓰기 0 · 알람만) — 되돌림 픽스처', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ('onve@atmark.ai', $1, 'test', 'rep test')`, [
          f.organizationId,
        ]);
        const row = await client.query<{ outcome: string }>('SELECT outcome FROM atmark_platform_reputation_check($1::uuid)', [id]);
        expect(row.rows[0]?.outcome).toBe('freeze_exempt');
        const state = await client.query<{ abuse_freeze: boolean }>('SELECT abuse_freeze FROM organizations WHERE id = $1', [f.organizationId]);
        expect(state.rows[0]?.abuse_freeze).toBe(false);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await freezeAudits(f.organizationId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------ ⑥ 적대 검토(PR #94) 후속

  describe('⑥ 적대 검토 후속 — M-1 서열기 능력 · M-2 감사된 해제 · M-3 신고 DoS · M-4 수신자 단위 · L-1 경합', () => {
    it('★ M-4 수신자 단위 — 수신자 100명 delivery 알림 하나 + 영구 bounce 10명 알림 하나 = 시도 110 · bounce 10 → 동결(알림 단위였다면 2 · 1)', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 100 });
      await event(id, 'bounce', { recipients: 9 });
      expect((await check(id))?.outcome).not.toBe('frozen');
      await event(id, 'bounce', { recipients: 1 });
      const result = await check(id);
      expect(result?.outcome).toBe('frozen');
      expect((await freezeAudits(f.organizationId))[0]?.operator_reason).toContain('7d attempts=110 bounces=10');
    });

    it('★ M-4 계정 억제 목록(OnAccountSuppressionList) bounce 는 분자에서 뺀다 · 다른 하위 종류는 센다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 60 });
      await event(id, 'bounce', { recipients: 20, subType: 'OnAccountSuppressionList' });
      expect(await check(id)).toMatchObject({ outcome: 'ok' });
      await event(id, 'bounce', { recipients: 10, subType: 'General' });
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    });

    it('★ M-4 소비자가 수신자 수 · bounce 하위 종류 · 신고자 해시를 적는다 — 주소 평문은 없다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      const store = createPostgresSesEventStore(app);
      const deliver = JSON.stringify({
        eventType: 'Delivery',
        mail: { timestamp: new Date().toISOString(), messageId: `ses-${randomUUID()}`, tags: { [ATMARK_MESSAGE_ID_TAG]: [id] } },
        delivery: { timestamp: new Date().toISOString(), recipients: Array.from({ length: 60 }, (_, i) => `r${String(i)}@x.example`) },
      });
      expect(await consumeSesEvent({ events: store, now: () => new Date() }, { receiptId: 'd', body: deliver })).toBe('recorded');
      expect(await consume(id, 'Bounce', { bounceType: 'Permanent' })).toBe('recorded');
      expect(await consume(id, 'Complaint', { complainer: 'Victim.Reporter@Mail.Example' })).toBe('recorded');
      const rows = await owner.query<{ event_type: string; recipient_count: number; bounce_subtype: string | null; complaint_recipient_hashes: string[] | null; complaint_domain_hashes: string[] | null }>(
        'SELECT event_type::text AS event_type, recipient_count, bounce_subtype, complaint_recipient_hashes, complaint_domain_hashes FROM ses_events WHERE message_id = $1 ORDER BY received_at',
        [id],
      );
      expect(rows.rows.find((r) => r.event_type === 'delivery')?.recipient_count).toBe(60);
      const complaint = rows.rows.find((r) => r.event_type === 'complaint');
      expect(complaint?.complaint_recipient_hashes).toEqual(complaintHashes(['victim.reporter@mail.example'])?.recipients);
      expect(complaint?.complaint_domain_hashes).toEqual(complaintHashes(['victim.reporter@mail.example'])?.domains);
      expect(JSON.stringify(rows.rows)).not.toContain('@');
    });

    it('★ M-3 같은 사람이 다섯 번 신고해도 한 명 — 얼지 않는다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 5; i += 1) await event(id, 'complaint', { complainer: 'same@attacker.example' });
      expect((await check(id))?.outcome).toBe('ok');
      expect(await frozen(f.organizationId)).toBe(false);
    });

    it('★ M-3 한 도메인의 메일함 여럿(공격자 도메인 하나)으로는 얼지 않는다 — 경고만 · 둘째 도메인이 더해지면 언다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 6; i += 1) await event(id, 'complaint', { complainer: `box${String(i)}@attacker.example` });
      expect(await check(id)).toMatchObject({ outcome: 'warn' });
      expect(await frozen(f.organizationId)).toBe(false);
      await event(id, 'complaint', { complainer: 'someone@other.example' });
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    });

    it('★ M-3 계정 기여분은 조직 7일 전달 ≥ 200 일 때만 — 비율이 낮은 소량 조직은 그 경로로 얼지 않는다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      // 전달 199 수신자 · bounce 9(윌슨 경로 미달 — 최소 10) → 계정 기여분 경로만 남지만 조직 바닥 미달.
      await event(id, 'delivery', { recipients: 100 });
      await event(id, 'delivery', { recipients: 90 });
      await event(id, 'bounce', { recipients: 9 });
      expect((await check(id))?.outcome).not.toBe('frozen');
    });

    it('★ R-1 같은 메일함의 +tag 셋은 한 명 — 신고자 수가 늘지 않는다(저장소 정규형 → 해시)', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (const tag of ['1', '2', '3', 'x']) await event(id, 'complaint', { complainer: `victim+${tag}@a.example` });
      await event(id, 'complaint', { complainer: 'Victim@A.example' });
      await event(id, 'complaint', { complainer: 'other@b.example' });
      // 신고자 = victim@a.example · other@b.example = 2 → 경고만.
      expect(await check(id)).toMatchObject({ outcome: 'warn' });
      await event(id, 'complaint', { complainer: 'third+zz@b.example' });
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
      // 소비자 경로도 같은 정규형(+tag 절단)으로 해시한다.
      expect(complaintHashes(['x+1@d.example'])).toEqual(complaintHashes(['X@D.example']));
    });

    it('★ R-1 한 메일 서비스의 별칭 도메인은 한 계열 — outlook/hotmail/live/msn · yahoo.* · gmail/googlemail', async () => {
      expect(complaintDomainFamily('Hotmail.co.uk')).toBe(complaintDomainFamily('outlook.com'));
      expect(complaintDomainFamily('live.com')).toBe(complaintDomainFamily('msn.com'));
      expect(complaintDomainFamily('yahoo.co.jp')).toBe(complaintDomainFamily('ymail.com'));
      expect(complaintDomainFamily('googlemail.com')).toBe(complaintDomainFamily('gmail.com'));
      expect(complaintDomainFamily('notgmail.com')).toBe('notgmail.com');
      // 최종 검증 I-1 — 알려진 공개 접미사 모양에만. 남의 도메인 · 하위 도메인 · 접미사 뒤에 붙인 도메인은 계열이 아니다.
      for (const foreign of ['live.nation.com', 'outlook.acme.com', 'msn.com.evil.io', 'hotmail.evil-site.com', 'yahoo.mail.attacker.net', 'mail.outlook.com']) {
        expect(complaintDomainFamily(foreign), foreign).toBe(foreign);
      }
      for (const [domain, family] of [
        ['hotmail.co.uk', 'family:microsoft'],
        ['outlook.com.au', 'family:microsoft'],
        ['live.fr', 'family:microsoft'],
        ['MSN.com.', 'family:microsoft'],
        ['yahoo.co.jp', 'family:yahoo'],
        ['yahoo.com.br', 'family:yahoo'],
        ['icloud.com', 'family:apple'],
        ['me.com', 'family:apple'],
        ['mac.com', 'family:apple'],
      ] as const) {
        expect(complaintDomainFamily(domain), domain).toBe(family);
      }
      expect(complaintDomainFamily('outlook.com')).not.toBe(complaintDomainFamily('gmail.com'));
      expect(canonicalComplainant(' A+b@X.com ')).toBe('a@x.com');
      expect(canonicalComplainant('+only@x.com')).toBeNull();
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (const address of ['a@hotmail.com', 'b@outlook.com', 'c@live.co.uk', 'd@msn.com']) await event(id, 'complaint', { complainer: address });
      expect(await check(id)).toMatchObject({ outcome: 'warn' });
      await event(id, 'complaint', { complainer: 'e@yahoo.com' });
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
      const g = await seedFixture(testPool());
      const gid = await message(g.agentId);
      await event(gid, 'delivery', { recipients: 50 });
      for (const address of ['a@gmail.com', 'b@googlemail.com', 'c@gmail.com']) await event(gid, 'complaint', { complainer: address });
      expect(await check(gid)).toMatchObject({ outcome: 'warn' });
    });

    it('★ R-1 소량 조직(창 전달 < 50)은 신고 비율 경로로 얼지 않는다 — 50 이 되면 언다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 49 });
      for (let i = 0; i < 5; i += 1) await event(id, 'complaint');
      expect(await check(id)).toMatchObject({ outcome: 'warn' });
      expect(await frozen(f.organizationId)).toBe(false);
      await event(id, 'delivery', { recipients: 1 });
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    });

    it('★ I-1 신고자 해시는 받은 지 8일 넘으면 스위퍼가 지운다 · 창 안의 행은 남는다 · 앱 롤은 ses_events 를 직접 고치지 못한다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'complaint', { agoHours: 24 * 9 });
      await event(id, 'complaint', { agoHours: 24 * 6 });
      const purged = await createPostgresComplaintHashRetention(app).purge();
      expect(purged).toBeGreaterThanOrEqual(1);
      const rows = await owner.query<{ old: boolean; h: string[] | null; d: string[] | null }>(
        `SELECT received_at < now() - interval '8 days' AS old, complaint_recipient_hashes AS h, complaint_domain_hashes AS d FROM ses_events WHERE message_id = $1 ORDER BY received_at`,
        [id],
      );
      expect(rows.rows.map((r) => [r.old, r.h === null, r.d === null])).toEqual([
        [true, true, true],
        [false, false, false],
      ]);
      await expect(app.query('UPDATE ses_events SET complaint_recipient_hashes = NULL WHERE message_id = $1', [id])).rejects.toMatchObject({ code: '42501' });
      expect(COMPLAINT_HASH_RETENTION_DAYS).toBe(8);
    });

    it('★ R-2 능력을 거두면(revoked_at) 서열기 기록이 되살리지 못한다 · 가드 55000 · 자동 동결 freeze_deferred · 운영자 UPDATE 로만 다시 켜진다 — 되돌림 트랜잭션', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE tlog_capabilities SET revoked_at = now() WHERE capability = 'owner_action_operator_actor'`);
        // 새 서열기의 다음 틱이 와도 되살아나지 않는다.
        await client.query(`SELECT atmark_tlog_record_capabilities($1::text[])`, [[...TLOG_SEQUENCER_CAPABILITIES]]);
        const after = await client.query<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM tlog_capabilities WHERE capability = 'owner_action_operator_actor'`);
        expect(after.rows).toEqual([{ revoked: true }]);
        await client.query('SAVEPOINT s');
        await expect(
          client.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'agent.delete', NULL, 'admin:agent-delete:x', 'r')`, [f.organizationId]),
        ).rejects.toMatchObject({ code: '55000' });
        await client.query('ROLLBACK TO SAVEPOINT s');
        expect((await client.query<{ outcome: string }>('SELECT outcome FROM atmark_platform_reputation_check($1::uuid)', [id])).rows[0]?.outcome).toBe('freeze_deferred');
        // 운영자의 의도된 다시 켜기.
        await client.query(`UPDATE tlog_capabilities SET revoked_at = NULL WHERE capability = 'owner_action_operator_actor'`);
        expect((await client.query<{ outcome: string }>('SELECT outcome FROM atmark_platform_reputation_check($1::uuid)', [id])).rows[0]?.outcome).toBe('frozen');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await frozen(f.organizationId)).toBe(false);
    });

    it('★ F-1 운영자 행 INSERT 가 진행 중이면 능력 거두기(UPDATE revoked_at)는 그 트랜잭션이 끝날 때까지 기다린다(가드 FOR SHARE)', async () => {
      const f = await seedFixture(testPool());
      const writer = await owner.connect();
      const revoker = await owner.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'agent.delete', NULL, 'admin:agent-delete:f1', 'r')`,
          [f.organizationId],
        );
        await revoker.query('BEGIN');
        await revoker.query(`SET LOCAL lock_timeout = '300ms'`);
        await expect(
          revoker.query(`UPDATE tlog_capabilities SET revoked_at = now() WHERE capability = 'owner_action_operator_actor'`),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await revoker.query('ROLLBACK').catch(() => undefined);
        await writer.query('ROLLBACK').catch(() => undefined);
        writer.release();
        revoker.release();
      }
      // 끝난 뒤에는 거두기가 곧바로 된다(되돌림 트랜잭션 — 능력은 그대로 남긴다).
      const after = await owner.connect();
      try {
        await after.query('BEGIN');
        await after.query(`SET LOCAL lock_timeout = '300ms'`);
        const updated = await after.query(`UPDATE tlog_capabilities SET revoked_at = now() WHERE capability = 'owner_action_operator_actor'`);
        expect(updated.rowCount).toBe(1);
      } finally {
        await after.query('ROLLBACK').catch(() => undefined);
        after.release();
      }
    });

    it('★ M-1 서열기 능력이 없으면 운영자 행위자 감사 행은 55000 · 자동 동결은 freeze_deferred(쓰기 0) — 되돌림 트랜잭션', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tlog_capabilities');
        await client.query('SAVEPOINT s');
        await expect(
          client.query(`INSERT INTO owner_actions (organization_id, action, target_id, operator_actor, operator_reason) VALUES ($1, 'agent.delete', NULL, 'admin:agent-delete:x', 'r')`, [f.organizationId]),
        ).rejects.toMatchObject({ code: '55000' });
        await client.query('ROLLBACK TO SAVEPOINT s');
        const row = await client.query<{ outcome: string }>('SELECT outcome FROM atmark_platform_reputation_check($1::uuid)', [id]);
        expect(row.rows[0]?.outcome).toBe('freeze_deferred');
        const state = await client.query<{ abuse_freeze: boolean }>('SELECT abuse_freeze FROM organizations WHERE id = $1', [f.organizationId]);
        expect(state.rows[0]?.abuse_freeze).toBe(false);
        // CLI 경로도 같은 거부(동결 · 감사 한 트랜잭션 — 둘 다 되돌아간다).
        await client.query('SAVEPOINT t');
        await expect(
          setOrganizationFreezeAuditedOp(transactionPool(client), { organizationId: f.organizationId, on: true, actor: 'admin:kill-switch:x', reason: null }),
        ).rejects.toMatchObject({ code: '55000' });
        await client.query('ROLLBACK TO SAVEPOINT t');
        // 새 서열기가 적는 능력은 정의자 하나 · 닫힌 목록(모르는 이름은 버린다) · 서열기 롤만 EXECUTE.
        await client.query(`SELECT atmark_tlog_record_capabilities(ARRAY['bogus', 'owner_action_operator_actor'])`);
        expect((await client.query('SELECT capability FROM tlog_capabilities')).rows).toEqual([{ capability: 'owner_action_operator_actor' }]);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect([...TLOG_SEQUENCER_CAPABILITIES]).toEqual(['owner_action_operator_actor']);
      const privileges = await owner.query<{ role: string; ok: boolean }>(
        `SELECT r AS role, has_function_privilege(r, 'atmark_tlog_record_capabilities(text[])', 'EXECUTE') AS ok
           FROM unnest(ARRAY['atmark_tlog', 'atmark_app', 'atmark_admin', 'atmark_ops']) AS r`,
      );
      expect(Object.fromEntries(privileges.rows.map((r) => [r.role, r.ok]))).toEqual({ atmark_tlog: true, atmark_app: false, atmark_admin: false, atmark_ops: false });
      await expect(app.query('SELECT capability FROM tlog_capabilities')).rejects.toMatchObject({ code: '42501' });
    });

    it('★ M-2 운영자 웹과 CLI 가 같은 감사된 함수 — 해제는 사유 필수 · 감사 1행 · 해제 뒤 사건만 센다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
      await expect(setOrganizationFreezeAuditedOp(owner, { organizationId: f.organizationId, on: false, actor: 'admin:web:jin', reason: '  ' })).rejects.toMatchObject({
        code: 'reason_required',
      });
      await expect(
        setOrganizationFreezeAuditedOp(owner, { organizationId: f.organizationId, on: false, actor: 'admin:web:jin', reason: 'bad\u0007bell' }),
      ).rejects.toMatchObject({ code: 'invalid_reason' });
      expect(await frozen(f.organizationId)).toBe(true);
      expect(await setOrganizationFreezeAuditedOp(owner, { organizationId: f.organizationId, on: false, actor: 'admin:web:jin', reason: 'owner cleaned list' })).toEqual({ changed: true });
      expect(await setOrganizationFreezeAuditedOp(owner, { organizationId: f.organizationId, on: false, actor: 'admin:web:jin', reason: 'again' })).toEqual({ changed: false });
      expect((await freezeAudits(f.organizationId)).map((r) => [r.action, r.operator_actor])).toEqual([
        ['org.abuse_freeze', PLATFORM_REPUTATION_ACTOR],
        ['org.abuse_unfreeze', 'admin:web:jin'],
      ]);
      await event(id, 'complaint');
      expect((await check(id))?.outcome).not.toBe('frozen');
    });

    it('★ L-1 해제 트랜잭션이 열린 동안 판정은 조직 행 잠금에서 기다리고, 해제가 커밋된 뒤 해제 시각 이후만 센다 — 다시 얼지 않는다', async () => {
      const f = await seedFixture(testPool());
      const id = await message(f.agentId);
      await event(id, 'delivery', { recipients: 50 });
      for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
      expect(await check(id)).toMatchObject({ outcome: 'frozen' });
      const client = await owner.connect();
      let settled = false;
      try {
        await client.query('BEGIN');
        expect(
          await setOrganizationFreezeAuditedOp(transactionPool(client), { organizationId: f.organizationId, on: false, actor: 'admin:kill-switch:jin', reason: 'race test' }),
        ).toEqual({ changed: true });
        const pending = check(id).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        await client.query('COMMIT');
        const result = await pending;
        expect(result?.outcome).toBe('ok');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      expect(await frozen(f.organizationId)).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------------ ⑤ 해제

  it('★ ⑤ 해제 — --reason 필수 · 감사 1행 · 해제 뒤의 사건만 센다 · 새 사건이 선을 넘으면 다시 언다', async () => {
    const f: Fixture = await seedFixture(testPool());
    const id = await message(f.agentId);
    await event(id, 'delivery', { recipients: 50 });
    for (let i = 0; i < 3; i += 1) await event(id, 'complaint');
    expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    const env = { DATABASE_MIGRATION_URL: OWNER_URL, USER: 'ops-test' };

    await expect(killSwitch(['--org', f.organizationId, 'off', '--yes'], { env, io: silentIo })).rejects.toThrow(/--reason/);
    expect(await frozen(f.organizationId)).toBe(true);
    expect(await killSwitch(['--org', f.organizationId, 'off', '--reason', 'customer cleaned list #44', '--by', 'jin', '--yes'], { env, io: silentIo })).toBe(0);
    expect(await frozen(f.organizationId)).toBe(false);
    const audits = await freezeAudits(f.organizationId);
    expect(audits.map((row) => [row.action, row.operator_actor, row.operator_reason])).toEqual([
      ['org.abuse_freeze', PLATFORM_REPUTATION_ACTOR, expect.stringContaining('complaint') as unknown as string],
      ['org.abuse_unfreeze', 'admin:kill-switch:jin', 'customer cleaned list #44'],
    ]);

    // 해제 뒤 — 창 안에 남은 옛 complaint 셋으로는 다시 얼지 않는다. 새 complaint 하나도.
    await event(id, 'delivery', { recipients: 50 });
    await event(id, 'complaint');
    expect((await check(id))?.outcome).not.toBe('frozen');
    expect(await frozen(f.organizationId)).toBe(false);
    // 새 사건이 선을 넘으면 다시 언다.
    await event(id, 'complaint');
    await event(id, 'complaint');
    expect(await check(id)).toMatchObject({ outcome: 'frozen' });
    expect((await freezeAudits(f.organizationId)).map((row) => row.action)).toEqual(['org.abuse_freeze', 'org.abuse_unfreeze', 'org.abuse_freeze']);

    // 운영자 손 동결 — 이미 동결이면 감사 행 없음 · 켜기는 사유 없이도(비상 경로).
    expect(await killSwitch(['--org', f.organizationId, 'on', '--yes'], { env, io: silentIo })).toBe(0);
    expect(await freezeAudits(f.organizationId)).toHaveLength(3);
  });
});
