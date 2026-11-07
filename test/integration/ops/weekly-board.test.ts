/**
 * 주간 운영판(202610010900) — 정의 함수 `ops_weekly_board` 와 `readWeeklyBoard` 를 **심은 데이터**로 본다(진짜 로컬 Postgres · 쓰기 0 · 메일 0).
 *
 * 격리: 테스트마다 **롤백되는 한 트랜잭션**(REPEATABLE READ — 앞뒤 비교가 같은 스냅샷)에서 심고 읽는다. 기준 시각은 **과거의 무작위 주**(1975~2010 ·
 * 금요일 10:00 KST)라 다른 테스트가 커밋한 행(지금 시각)은 창 밖이다. 과거인 이유: `agent_api_keys.first_used_at` 은 트리거가 `least(last_used_at, now())`
 * 로 적는다 — 미래 시각이면 진짜 지금으로 접힌다. 운영판은 같은 트랜잭션에서 `SET LOCAL SESSION AUTHORIZATION atmark_ops` 로 읽는다(`inRolledBackOps` 와 같은 길).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 사다리: 하한(14일 외부 발신 200통) 미달 + 신호 0 = 판정 불가 · 하한 이상 + 신호 0 = L0 · 조직 신호 넷(전체 모드 전환 · 하루 외부 수신자 20 ·
 *     수신 발신 도메인 30 · 대기자 하드 바운스 3) = L1 · 불만 2 · 하드 바운스 2% · 신규 조직 비중 30% · Gmail 일 최대 > 1,000 = 그 단계.
 *   - 외부 발신량은 에이전트 주소로 간 메일을 세지 않는다 · 상태 sent 만 · 창 밖은 세지 않는다.
 *   - 코호트: 초대 수 = 항목별 마지막 초대의 주 · 가입 = signup_invite_week · 7일 단계(밖은 세지 않는다 · 소유자 주소에서 온 메일 · 격리 메일은 외부 수신이
 *     아니다) · 2주차 유지 · Beta 따로 · 내부 조직 제외 · 분모 20 미만은 퍼센트 없음 · 열린 주는 창 미종료.
 *   - 북극성: 외부 수신 뒤 토큰 사용만 · 내부 조직 제외 · Beta 따로.
 *   - 대기자: A 후보 7일 초과 대기 = SLA 초과.
 *   - `atmark_ops` 롤로 돈다(정의 함수 EXECUTE + 대기자 명단 칸 GRANT) · 개인 정보(주소)가 응답에 없다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readWeeklyBoard } from '../../../src/ops/console/board';
import { INTERNAL_ORG_IDS, isoWeekStartKst } from '../../../src/ops/console/board-rules';
import { grantPlan } from '../../support/entitlements';
import { AVAILABLE, opsPool, ownerPool } from './db-support';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const pad = (n: number): string => String(n).padStart(2, '0');

interface Window {
  readonly now: Date;
  readonly year: number;
  readonly week: number;
  /** 같은 해의 ISO 주 열쇠. */
  readonly key: (weeksBack: number) => string;
  readonly at: (daysBack: number) => Date;
}

/** 과거의 무작위 주 — 금요일 10:00 KST. 주 번호는 8~48 이라 5주 전도 같은 해다. */
function randomWindow(): Window {
  const year = 1975 + Math.floor(Math.random() * 36);
  const week = 8 + Math.floor(Math.random() * 41);
  const monday = isoWeekStartKst(`${String(year)}-W${pad(week)}`);
  if (monday === null) throw new Error('week');
  const now = new Date(monday.getTime() + 4 * DAY + 10 * HOUR);
  return { now, year, week, key: (back) => `${String(year)}-W${pad(week - back)}`, at: (back) => new Date(now.getTime() - back * DAY) };
}

interface Raw {
  readonly guard: Record<string, unknown> & { externalSends: Record<string, number> };
  readonly north: { global: number; beta: number };
  readonly cohorts: { week: string; invited: number; open7: number; open14: number; global: Record<string, number>; beta: Record<string, number> }[];
}

function startOf(key: string): number {
  const start = isoWeekStartKst(key);
  if (start === null) throw new Error(key);
  return start.getTime();
}

describe.skipIf(!AVAILABLE)('주간 운영판 — ops_weekly_board · readWeeklyBoard', () => {
  let owner: Pool;
  let ops: Pool;
  /** 지금 테스트의 트랜잭션(소유자 롤 · 끝나면 롤백). */
  let db: PoolClient;

  beforeAll(() => {
    owner = ownerPool(4);
    ops = opsPool();
  });
  afterAll(async () => {
    await owner.end();
    await ops.end();
  });

  async function inTx(run: () => Promise<void>): Promise<void> {
    db = await owner.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await run();
    } finally {
      await db.query('ROLLBACK').catch(() => undefined);
      db.release();
    }
  }

  // ---- 심기 ----

  async function org(createdAt: Date, options: { inviteWeek?: string; beta?: boolean; ownerEmail?: string } = {}): Promise<{ id: string; ownerEmail: string }> {
    const ownerEmail = options.ownerEmail ?? `wb-owner-${hex(4)}@example.com`;
    const row = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, owner_email, review_status, signup_source, created_at, signup_invite_week)
       VALUES ($1, $2, 'active', 'self_signup', $3, $4) RETURNING id`,
      [`운영판 ${hex(3)}`, ownerEmail, createdAt, options.inviteWeek ?? null],
    );
    const id = row.rows[0]?.id ?? '';
    if (options.beta === true) await grantPlan(db, id, 'beta');
    return { id, ownerEmail };
  }

  async function agent(organizationId: string, createdAt: Date): Promise<{ id: string; address: string; policyVersionId: string }> {
    const id = hex(16);
    const address = `wb${hex(5)}@atmark.ai`;
    await db.query(
      `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents, created_at) VALUES ($1, $2, $3, 'active', 'free', 1000, $4)`,
      [id, organizationId, `wb-${hex(3)}`, createdAt],
    );
    await db.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [id, address]);
    const version = await db.query<{ id: string }>(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot, created_at) VALUES ($1, 1, 'allowlist_only', '{}'::jsonb, $2) RETURNING id`,
      [id, createdAt],
    );
    return { id, address, policyVersionId: version.rows[0]?.id ?? '' };
  }

  async function policyVersion(agentId: string, version: number, mode: string, at: Date): Promise<void> {
    await db.query(`INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot, created_at) VALUES ($1, $2, $3::outbound_mode, '{}'::jsonb, $4)`, [
      agentId,
      version,
      mode,
      at,
    ]);
  }

  /** 토큰 — `last_used_at` 을 차례로 적는다(첫 값이 `first_used_at` 이 된다 — 과거 시각이라 트리거의 least(…, now()) 가 그 값이다). */
  async function token(agentId: string, uses: readonly Date[]): Promise<void> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO agent_api_keys (agent_id, token_hash, capabilities) VALUES ($1, $2, ARRAY['messages:send']::agent_token_capability[]) RETURNING id`,
      [agentId, hex(32)],
    );
    for (const at of uses) await db.query('UPDATE agent_api_keys SET last_used_at = $2 WHERE id = $1', [row.rows[0]?.id, at]);
  }

  async function thread(agentId: string, startedBy: 'agent' | 'external'): Promise<string> {
    const row = await db.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, $2::thread_starter) RETURNING id`, [agentId, startedBy]);
    return row.rows[0]?.id ?? '';
  }

  /** 발신 n 통(한 스레드) — 메시지마다 수신자 하나 `<prefix><i>@<domain>`(또는 고정 주소). */
  async function sends(
    agentId: string,
    at: Date,
    n: number,
    options: { domain?: string; prefix?: string; fixed?: string; status?: 'sent' | 'denied'; startedBy?: 'agent' | 'external' } = {},
  ): Promise<void> {
    const threadId = await thread(agentId, options.startedBy ?? 'agent');
    const sent = (options.status ?? 'sent') === 'sent';
    await db.query(
      `WITH m AS (
         INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key, request_hash,
                               recipient_count, created_at, ses_message_id, sent_at)
         SELECT $1, $2, 'outbound', repeat('a', 64), 'atmark.ai', $4::message_status, '<' || gen_random_uuid() || '@wb.test>', 'idem-' || gen_random_uuid(),
                repeat('b', 64), 1, $3::timestamptz + g * interval '1 second',
                CASE WHEN $8 THEN 'wb-' || gen_random_uuid() END, CASE WHEN $8 THEN $3::timestamptz + g * interval '1 second' END
           FROM generate_series(1, $5::int) g
         RETURNING id)
       INSERT INTO outbound_recipients (message_id, address)
       SELECT id, coalesce($7, $6 || row_number() OVER () || '@' || $9) FROM m`,
      [agentId, threadId, at, sent ? 'sent' : 'denied', n, options.prefix ?? `r${hex(3)}-`, options.fixed ?? null, sent, options.domain ?? 'partner.example'],
    );
  }

  async function inbound(agentId: string, at: Date, from: string, options: { quarantined?: boolean } = {}): Promise<void> {
    const threadId = await thread(agentId, 'external');
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const quarantined = options.quarantined === true;
    await db.query(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, 'x@atmark.ai', $2, $3, 'no_header_ids', $4, split_part($4, '@', 2), false, 'hi', false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $2, 'inbound/parsed/' || $2 || '.json', 'plain', false, 0, $5, 'test-v0', $6::injection_risk, $7, 'unknown')`,
      [agentId, ses, threadId, from, at, quarantined ? 'high' : 'none', quarantined],
    );
  }

  async function deny(a: { id: string; policyVersionId: string }, at: Date): Promise<void> {
    await db.query(
      `INSERT INTO audit_logs (agent_id, decision, reasons, policy_version_id, policy_version, created_at)
       VALUES ($1, 'denied', ARRAY['recipient_not_allowlisted'], $2, 1, $3)`,
      [a.id, a.policyVersionId, at],
    );
  }

  async function sesEvent(type: 'complaint' | 'bounce', at: Date): Promise<void> {
    await db.query(`INSERT INTO ses_events (event_type, event_at, received_at, dedupe_key) VALUES ($1::ses_event_type, $2, $2, $3)`, [type, at, hex(32)]);
  }

  async function suppression(address: string, reason: 'hard_bounce' | 'complaint', at: Date): Promise<void> {
    await db.query('INSERT INTO system_mail_suppressions (address, reason, created_at) VALUES ($1, $2, $3)', [address, reason, at]);
  }

  async function entry(options: { status: 'waiting' | 'invited'; createdAt: Date; invitedAt?: Date; useCase?: string; note?: string }): Promise<{ id: string; email: string }> {
    const email = `wb-wait-${hex(5)}@example.com`;
    const invited = options.status === 'invited' ? (options.invitedAt ?? options.createdAt) : null;
    const row = await db.query<{ id: string }>(
      `INSERT INTO waitlist_entries (email, lang, note, source, status, created_at, invited_at, invite_expires_at, invited_by, use_case)
       VALUES ($1, 'ko', $2, 'site', $3, $4, $5::timestamptz, $5::timestamptz + interval '14 days', CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'test' END, $6) RETURNING id`,
      [email, options.note ?? null, options.status, options.createdAt, invited, options.useCase ?? null],
    );
    const id = row.rows[0]?.id ?? '';
    if (invited !== null) await inviteEvent(id, invited);
    return { id, email };
  }

  async function inviteEvent(entryId: string, at: Date): Promise<void> {
    await db.query(`INSERT INTO waitlist_events (entry_id, action, actor, created_at) VALUES ($1, 'invite', 'test', $2)`, [entryId, at]);
  }

  async function raw(w: Window, internal: readonly string[] = INTERNAL_ORG_IDS): Promise<Raw> {
    const row = await db.query<{ board: Raw }>('SELECT ops_weekly_board($1, $2::uuid[]) AS board', [w.now, [...internal]]);
    return row.rows[0]?.board as Raw;
  }

  /** 운영판 — 같은 트랜잭션에서 `atmark_ops` 로(정의 함수 EXECUTE + 대기자 명단 칸 GRANT 만으로 돈다). */
  async function board(w: Window): Promise<Record<string, any>> {
    await db.query('SET LOCAL SESSION AUTHORIZATION atmark_ops');
    try {
      return (await readWeeklyBoard(db, w.now)).body as Record<string, any>;
    } finally {
      await db.query('RESET SESSION AUTHORIZATION').catch(() => undefined);
    }
  }

  // ---- 사다리 ----

  it('하한 미달 + 신호 0 → 판정 불가(초록 아님) · 외부 발신량은 sent · 외부 주소 · 창 안만 센다', async () => {
    await inTx(async () => {
      const w = randomWindow();
      const o = await org(w.at(60));
      const a = await agent(o.id, w.at(60));
      const peer = await agent(o.id, w.at(60));
      await sends(a.id, w.at(2), 5); // 셈 — 7일
      await sends(a.id, w.at(10), 4); // 셈 — 14일
      await sends(a.id, w.at(20), 3); // 셈 — 28일
      await sends(a.id, w.at(40), 50); // 창 밖
      await sends(a.id, w.at(1), 7, { fixed: peer.address }); // 에이전트 주소 — 외부 아님
      await sends(a.id, w.at(1), 6, { status: 'denied' }); // 보내지 않음
      expect((await raw(w)).guard.externalSends).toEqual({ d7: 5, d14: 9, d28: 12, newOrgD7: 0 });
      const b = await board(w);
      expect(b.guardrail).toMatchObject({ level: 'L0', verdict: 'insufficient', belowFloor: true, volume: { d7: 5, d14: 9, d28: 12, floor14d: 200, launchFloorMet: false } });
      expect(b.guardrail.signals.find((s: { key: string }) => s.key === 'complaints').status).toBe('insufficient');
      // 수동 확인 셋(Postmaster · Spamhaus · SES)은 계산하지 않는다 — 링크로만.
      expect(b.guardrail.manual.map((m: { key: string }) => m.key)).toEqual(['postmaster', 'spamhaus', 'ses', 'abuse', 'subdomain']);
    });
  });

  it('하한 이상 + 신호 0 → L0 · 불만 2건 → L2 · 반송 2% → L2 · 신규 조직 비중 30% → L1', async () => {
    await inTx(async () => {
      const w = randomWindow();
      const old = await org(w.at(90));
      const a = await agent(old.id, w.at(90));
      await sends(a.id, w.at(3), 150, { fixed: 'ops@partner.example' }); // 수신자 하나 — 조직 신호(하루 20명)를 켜지 않게
      await sends(a.id, w.at(10), 60, { fixed: 'ops@partner.example' });
      expect((await board(w)).guardrail).toMatchObject({ level: 'L0', verdict: 'L0', belowFloor: false });

      await sesEvent('bounce', w.at(1));
      await sesEvent('bounce', w.at(1));
      await sesEvent('bounce', w.at(1)); // 3/150 = 2%
      await sesEvent('bounce', w.at(9)); // 창 밖(7일)
      const bounced = await board(w);
      expect(bounced.guardrail.level).toBe('L2');
      expect(bounced.guardrail.signals.find((s: { key: string }) => s.key === 'hard_bounce_rate')).toMatchObject({ status: 'fired', value: expect.stringContaining('3/150 (2.0%)') });

      const w2 = randomWindow();
      const old2 = await org(w2.at(90));
      const a2 = await agent(old2.id, w2.at(90));
      await sends(a2.id, w2.at(3), 140, { fixed: 'ops@partner.example' });
      const fresh = await org(w2.at(5));
      const f = await agent(fresh.id, w2.at(5));
      await sends(f.id, w2.at(2), 60, { fixed: 'ops@partner.example' }); // 60/200 = 30% — 가입 7일 이내 조직
      await sesEvent('complaint', w2.at(2));
      await suppression(`wb-sys-${hex(4)}@example.com`, 'complaint', w2.at(2));
      const b = await board(w2);
      expect((await raw(w2)).guard).toMatchObject({ externalSends: { d7: 200, newOrgD7: 60 }, sesComplaints: 1, systemComplaints: 1 });
      expect(b.guardrail.level).toBe('L2');
      const statuses = Object.fromEntries(b.guardrail.signals.map((s: { key: string; status: string }) => [s.key, s.status]));
      expect(statuses).toMatchObject({ complaints: 'fired', new_org_share: 'fired', hard_bounce_rate: 'clear', harvest_code_calls: 'unobserved' });
      expect(b.guardrail.signals.find((s: { key: string }) => s.key === 'complaints')).toMatchObject({ level: 'L2', value: expect.stringContaining('관측된 불만 2건(SES FBL 기준, Gmail 미포함') });
    });
  });

  it('조직 신호 넷 → L1(id 만) · 대기자 하드 바운스 3건 · Gmail 일 최대 > 1,000 → L2', async () => {
    await inTx(async () => {
      const w = randomWindow();
      // ① 가입 14일 안에 전체 모드로 — 가입 3일 전 · 전환 2일 전. 가입 30일 뒤 전환한 조직은 아니다.
      const young = await org(w.at(3));
      const ya = await agent(young.id, w.at(3));
      await policyVersion(ya.id, 2, 'unrestricted', w.at(2));
      const late = await org(w.at(40));
      const la = await agent(late.id, w.at(40));
      await policyVersion(la.id, 2, 'unrestricted', w.at(2));
      // ② 하루 서로 다른 외부 수신자 20(같은 KST 날) · 19 는 아니다.
      const wide = await org(w.at(90));
      const wa = await agent(wide.id, w.at(90));
      await sends(wa.id, new Date(w.at(2).getTime() - 2 * HOUR), 20);
      const narrow = await org(w.at(90));
      const na = await agent(narrow.id, w.at(90));
      await sends(na.id, new Date(w.at(2).getTime() - 2 * HOUR), 19);
      // ③ 7일 수신 발신 도메인 30곳.
      const harvester = await org(w.at(90));
      const ha = await agent(harvester.id, w.at(90));
      for (let i = 0; i < 30; i += 1) await inbound(ha.id, w.at(1), `code@svc${String(i)}-${hex(2)}.example`);
      // ④ 대기자 주소 하드 바운스 3 + 대기자가 아닌 시스템 하드 바운스 1.
      for (let i = 0; i < 3; i += 1) {
        const e = await entry({ status: 'waiting', createdAt: w.at(3) });
        await suppression(e.email, 'hard_bounce', w.at(2));
      }
      await suppression(`wb-other-${hex(4)}@example.com`, 'hard_bounce', w.at(2));

      const r = await raw(w);
      expect(r.guard).toMatchObject({ allModeCount: 1, allModeOrgs: [young.id], systemHardBounces: 4, waitlistHardBounces: 3 });
      const b = await board(w);
      expect(b.guardrail.level).toBe('L1');
      const signal = (key: string): { status: string; organizations: string[] } => b.guardrail.signals.find((s: { key: string }) => s.key === key);
      expect(signal('all_mode_switch')).toMatchObject({ status: 'fired', organizations: [young.id] });
      expect(signal('org_daily_recipients')).toMatchObject({ status: 'fired', organizations: [wide.id] });
      expect(signal('harvest_domains')).toMatchObject({ status: 'fired', organizations: [harvester.id] });
      expect(signal('waitlist_hard_bounces').status).toBe('fired');
      // 응답에 주소가 없다(조직 id 와 건수뿐).
      expect(JSON.stringify(b)).not.toMatch(/@example\.com|@atmark\.ai|\.example"/);

      // Gmail 수신자 하루 1,001 → L2.
      await sends(wa.id, w.at(1), 1001, { domain: 'gmail.com' });
      const g = await board(w);
      expect((await raw(w)).guard['gmailDailyPeak']).toBe(1001);
      expect(g.guardrail.level).toBe('L2');
    });
  });

  // ---- 코호트 · 북극성 ----

  it('코호트 — 초대 · 가입 · 7일 단계 · 2주차 · Beta 따로 · 내부 제외 · 분모 20 미만 퍼센트 없음 · 창 미종료', async () => {
    await inTx(async () => {
      const w = randomWindow();
      const closedWeek = w.key(5);
      const openWeek = w.key(0);
      const signup = new Date(startOf(closedWeek) + 2 * DAY);
      const s = (days: number): Date => new Date(signup.getTime() + days * DAY + HOUR);
      // 초대 25(닫힌 주). 그중 하나는 이번 주에 다시 초대 — 마지막 초대의 주(이번 주)로 센다.
      const closedInvite = new Date(startOf(closedWeek) + DAY);
      const entries = [];
      for (let i = 0; i < 26; i += 1) entries.push(await entry({ status: 'invited', createdAt: closedInvite, invitedAt: closedInvite }));
      await inviteEvent(entries[0]?.id ?? '', w.at(1));
      await entry({ status: 'invited', createdAt: w.at(2), invitedAt: w.at(2) });
      await entry({ status: 'invited', createdAt: w.at(2), invitedAt: w.at(2) });

      // 가입 — 비 Beta 21 · Beta 1 · 내부 1.
      const full = await org(signup, { inviteWeek: closedWeek });
      const fa = await agent(full.id, s(1));
      await token(fa.id, [s(2), s(4)]); // 첫 MCP 2일 · 마지막 4일(첫 외부 수신 3일 뒤) → 읽기
      await inbound(fa.id, s(0.5), full.ownerEmail); // 소유자 주소 — 외부 아님
      await inbound(fa.id, s(1), 'boss@partner.example', { quarantined: true }); // 격리 — 아님
      await inbound(fa.id, s(3), 'alerts@monitor.example'); // 첫 외부 수신
      await deny(fa, s(3));
      await sends(fa.id, s(5), 1, { startedBy: 'external' }); // 첫 답장 성공
      await sends(fa.id, s(9), 1); // 2주차 활동

      const late = await org(signup, { inviteWeek: closedWeek });
      const lta = await agent(late.id, s(1));
      await token(lta.id, [s(8)]); // 첫 MCP 8일 — 7일 밖
      await inbound(lta.id, s(8), 'alerts@monitor.example'); // 7일 밖
      await deny(lta, s(8)); // 7일 밖 — 대신 2주차 활동(8~14일)이다
      // 외부가 아닌 수신만 받은 조직 — 소유자 주소 · 자기 에이전트 주소 · 격리 메일. 외부 수신 · 읽기로 세지 않는다.
      const noisy = await org(signup, { inviteWeek: closedWeek });
      const nsa = await agent(noisy.id, s(1));
      const nsb = await agent(noisy.id, s(1));
      await token(nsa.id, [s(2), s(5)]);
      await inbound(nsa.id, s(2), noisy.ownerEmail);
      await inbound(nsa.id, s(2), nsb.address);
      await inbound(nsa.id, s(3), 'alerts@monitor.example', { quarantined: true });
      for (let i = 0; i < 18; i += 1) await org(signup, { inviteWeek: closedWeek });

      const beta = await org(signup, { inviteWeek: closedWeek, beta: true });
      await agent(beta.id, s(1));
      const internal = await org(signup, { inviteWeek: closedWeek });
      await agent(internal.id, s(1));

      // 열린 주 — 1일 전 가입.
      await org(w.at(1), { inviteWeek: openWeek });

      const rows = (await raw(w, [internal.id])).cohorts;
      const closed = rows.find((row) => row.week === closedWeek);
      expect(closed).toMatchObject({
        invited: 25,
        open7: 0,
        global: { signedUp: 21, agent: 3, mcp: 2, inbound: 1, read: 1, deny: 1, reply: 1, retained: 2 },
        beta: { signedUp: 1, agent: 1, mcp: 0, inbound: 0, read: 0, deny: 0, reply: 0, retained: 0 },
      });
      // 내부 조직을 빼지 않으면 하나 더(에이전트 포함).
      const withInternal = (await raw(w, [])).cohorts.find((row) => row.week === closedWeek);
      expect(withInternal?.global).toMatchObject({ signedUp: 22, agent: 4 });

      // TS — 분모 · 퍼센트 · 창.
      const b = await board(w);
      expect(b.cohorts.internalExcluded).toBe(INTERNAL_ORG_IDS.length);
      const viaConstant = b.cohorts.rows.find((row: { week: string }) => row.week === closedWeek);
      // 상수 목록에는 이 테스트의 내부 조직이 없다 — 22 곳(상수가 정말 넘어가는지는 위의 raw 비교가 본다).
      expect(viaConstant.global.signedUp).toEqual({ n: 22, d: 25, pct: 88 });
      expect(viaConstant.global.agent).toEqual({ n: 4, d: 22, pct: 18 });
      expect(viaConstant.beta.signedUp).toEqual({ n: 1, d: 1, pct: null });
      expect([viaConstant.windowOpen, viaConstant.retentionOpen]).toEqual([false, false]);
      const open = b.cohorts.rows.find((row: { week: string }) => row.week === openWeek);
      expect(open).toMatchObject({ invited: 3, windowOpen: true, openOrgs: 1 });
      expect(open.global.signedUp).toEqual({ n: 1, d: 3, pct: null });
    });
  });

  it('북극성 — 외부 수신 뒤 토큰 사용만 · 멤버 · 소유자 메일은 아니다 · 내부 제외 · Beta 따로', async () => {
    await inTx(async () => {
      const w = randomWindow();
      const yes = await org(w.at(60));
      const ya = await agent(yes.id, w.at(60));
      await inbound(ya.id, w.at(3), 'alerts@monitor.example');
      await token(ya.id, [w.at(2)]);
      const before = await org(w.at(60));
      const ba = await agent(before.id, w.at(60));
      await token(ba.id, [w.at(4)]); // 토큰은 수신 전에만
      await inbound(ba.id, w.at(3), 'alerts@monitor.example');
      const self = await org(w.at(60));
      const sa = await agent(self.id, w.at(60));
      await inbound(sa.id, w.at(3), self.ownerEmail);
      await token(sa.id, [w.at(2)]);
      const betaOrg = await org(w.at(60), { beta: true });
      const bta = await agent(betaOrg.id, w.at(60));
      await inbound(bta.id, w.at(3), 'news@feed.example');
      await token(bta.id, [w.at(2)]);
      const internal = await org(w.at(60));
      const ia = await agent(internal.id, w.at(60));
      await inbound(ia.id, w.at(3), 'alerts@monitor.example');
      await token(ia.id, [w.at(2)]);

      expect((await raw(w, [internal.id])).north).toEqual({ global: 1, beta: 1 });
      expect((await raw(w, [])).north).toEqual({ global: 2, beta: 1 });
    });
  });

  it('대기자 명단 — A 후보 7일 초과 대기 = SLA 초과 · 등급 후보 분포', async () => {
    await inTx(async () => {
      const w = randomWindow();
      const before = (await board(w)).waitlist;
      await entry({ status: 'waiting', createdAt: w.at(10), useCase: 'alerts', note: '배포 알림을 받는다' }); // A · 초과
      await entry({ status: 'waiting', createdAt: w.at(3), useCase: 'replies', note: '고객 답장' }); // A · 아직
      await entry({ status: 'waiting', createdAt: w.at(10), useCase: 'codes' }); // B
      await entry({ status: 'waiting', createdAt: w.at(10), useCase: 'outreach' }); // 보류
      const after = (await board(w)).waitlist;
      expect(after.gradeASlaBreaches - before.gradeASlaBreaches).toBe(1);
      expect(after.grades.A - before.grades.A).toBeGreaterThanOrEqual(2);
      expect(after.grades.hold - before.grades.hold).toBeGreaterThanOrEqual(1);
      expect(after.waiting - before.waiting).toBeGreaterThanOrEqual(4);
    });
  });

  it('atmark_ops 는 정의 함수만 부른다 — 수신 · 발신 수신자 표를 직접 읽지 못한다 · 술어는 소유자만', async () => {
    for (const sql of ['SELECT from_address FROM inbound_messages LIMIT 1', 'SELECT address FROM outbound_recipients LIMIT 1', 'SELECT address FROM system_mail_suppressions LIMIT 1']) {
      await expect(ops.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    await expect(ops.query(`SELECT ops_board_external_sender(gen_random_uuid(), 'a@b.example', 'c@d.example')`)).rejects.toMatchObject({ code: '42501' });
    const w = randomWindow();
    const row = await ops.query<{ board: Raw }>('SELECT ops_weekly_board($1, $2::uuid[]) AS board', [w.now, [...INTERNAL_ORG_IDS]]);
    expect(row.rows[0]?.board.guard.externalSends).toEqual({ d7: 0, d14: 0, d28: 0, newOrgD7: 0 });
    // 읽기 전용 — STABLE 정의 함수(쓰기를 시도하면 실행기가 막는다).
    const volatility = await owner.query<{ v: string; definer: boolean }>(`SELECT provolatile::text AS v, prosecdef AS definer FROM pg_proc WHERE proname = 'ops_weekly_board'`);
    expect(volatility.rows).toEqual([{ v: 's', definer: true }]);
  });
});
