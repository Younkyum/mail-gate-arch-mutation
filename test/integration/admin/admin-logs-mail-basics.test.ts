/**
 * 메일 기본기 1차 콘솔 로그 — **예약 로그**(`type=scheduled`, AC-A3-7)와 **수신 로그 필터**(`from`·`since`·`until`, AC-A5-5).
 *
 * 전부 **`atmark_admin` 롤 풀**로 라우터를 돈다(운영 admin Lambda 와 같은 롤) — 202609260120 의 `scheduled_sends` 칼럼 GRANT 가 모자라면
 * `permission denied` 로 빨개진다. 행 심기는 소유자 롤. 실메일 0 · AWS 호출 0.
 *
 *   - 예약 로그: 취소된 행의 사유·경로(mcp/http)·시각·메모가 보인다 · 메모는 표시 정화 · 상태 필터(`decision=cancelled`) · 다른 조직 404 ·
 *     멱등 키·본문 키 같은 GRANT 밖 칸은 admin 롤이 못 읽는다 · 커서로 쪽을 넘긴다.
 *   - 수신 필터: 보낸 주소(정확, 대소문자 무시) · 기간(반열림) · 주소 필터면 거부 행 없음 · 다른 type 에 주면 400 · 모양 400.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';
import type { AdminDependencies } from '../../../src/admin/context';

/** 보이면 안 되는 문자 — C0/C1 제어 · 양방향 조작 · 폭 없는 문자. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/u;

interface Fixture {
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
}

interface Listed {
  readonly items: Array<Record<string, unknown> & { id: string }>;
  readonly next: string | null;
}

describe.skipIf(!AVAILABLE)('콘솔 로그 — 메일 기본기 1차(예약 로그 · 수신 필터)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    deps = adminDeps(admin);
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
  });

  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'mb', localPart: `mb-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { session, agentId: agent.id, address: agent.address };
  }

  /** 예약 1건. `cancel` 이면 소유자 롤로 취소 칼럼을 채운다(W2 의 쓰기 1회 가드 아래 — 첫 기록). */
  async function schedule(
    f: Fixture,
    options: { sendAt: Date; recipients?: string[]; cancel?: { via: 'mcp' | 'http'; reason: string; note?: string } },
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO scheduled_sends (id, agent_id, idempotency_key, request_hash, from_address, recipients, send_at, content_storage_key, cost_cents)
       VALUES ($1::uuid, $2, $3, repeat('a', 64), $4, $5::text[], $6, 'outbound/scheduled/' || $1::text || '.json', 0)`,
      [id, f.agentId, `idem-${id}`, f.address, options.recipients ?? ['to@example.com'], options.sendAt],
    );
    if (options.cancel !== undefined) {
      await owner.query(
        `UPDATE scheduled_sends SET status = 'cancelled', cancelled_at = now(), cancel_reason_code = $2, cancel_note = $3, cancelled_via = $4
          WHERE id = $1`,
        [id, options.cancel.reason, options.cancel.note ?? null, options.cancel.via],
      );
    }
    return id;
  }

  async function inbound(f: Fixture, options: { at: Date; from: string }): Promise<string> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), false, 'hello', false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, $6, 'test-v0', 'none', false, 'unknown')
       RETURNING id`,
      [f.agentId, f.address, ses, thread.rows[0]?.id, options.from, options.at],
    );
    return row.rows[0]?.id ?? '';
  }

  async function rejection(recipients: string[], at: Date): Promise<string> {
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_rejections (ses_message_id, reason, detail, envelope_recipients, virus_verdict, spam_verdict, raw_storage_key, received_at)
       VALUES ($1, 'virus', 'x', $2::text[], 'fail', 'pass', 'inbound/raw/' || $1, $3) RETURNING id`,
      [ses, recipients, at],
    );
    return row.rows[0]?.id ?? '';
  }

  async function list(session: Session, query: string): Promise<Listed> {
    const result = await call(deps, 'GET', '/api/logs', authed(session, { query }));
    expect(result.statusCode, `${query} → ${result.body}`).toBe(200);
    return result.json() as Listed;
  }

  it('GRANT: admin 롤은 예약의 표시 칸만 읽는다(멱등 키·요청 해시·본문 키·추적 id·임대는 못 읽는다)', async () => {
    const who = await admin.query<{ user: string }>('SELECT current_user AS user');
    expect(who.rows[0]?.user).toBe('atmark_admin');
    await admin.query('SELECT id, status, cancel_note, cancelled_via, agent_cancellable FROM scheduled_sends LIMIT 1');
    for (const column of ['idempotency_key', 'request_hash', 'content_storage_key', 'trace_id', 'lease_expires_at', 'attempt_count']) {
      await expect(admin.query(`SELECT ${column} FROM scheduled_sends LIMIT 1`), column).rejects.toThrow(/permission denied/);
    }
  });

  it('★ AC-A3-7 취소된 예약의 사유·경로·시각·메모가 보인다 · 메모는 정화 · 상태 필터 · 보낼 시각 최신순', async () => {
    const f = await fixture();
    const later = await schedule(f, { sendAt: new Date('2026-10-02T00:00:00Z') });
    const cancelled = await schedule(f, {
      sendAt: new Date('2026-10-01T00:00:00Z'),
      recipients: ['a@example.com', 'b@example.com'],
      cancel: { via: 'mcp', reason: 'wrong_recipient', note: '받은 메일이 취소하래요 ‮evil' },
    });
    const byApi = await schedule(f, { sendAt: new Date('2026-09-30T00:00:00Z'), cancel: { via: 'http', reason: 'duplicate' } });

    const page = await list(f.session, 'type=scheduled');
    expect(page.items.map((item) => item.id)).toEqual([later, cancelled, byApi]);
    const row = page.items[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelReason: 'wrong_recipient',
      cancelledVia: 'mcp',
      agentCancellable: true,
      recipientCount: 2,
      recipients: ['a@example.com', 'b@example.com'],
      from: f.address,
      sendAt: '2026-10-01T00:00:00.000Z',
    });
    expect(row['cancelledAt']).toEqual(expect.any(String));
    expect(String(row['cancelNote'])).toContain('받은 메일이 취소하래요');
    expect(String(row['cancelNote'])).not.toMatch(INVISIBLE);
    expect(page.items[2]).toMatchObject({ cancelledVia: 'http', cancelReason: 'duplicate', cancelNote: null });
    expect(page.items[0]).toMatchObject({ status: 'scheduled', cancelledAt: null, cancelReason: null, cancelledVia: null });

    const onlyCancelled = await list(f.session, 'type=scheduled&decision=cancelled');
    expect(onlyCancelled.items.map((item) => item.id)).toEqual([cancelled, byApi]);
    const onlyScheduled = await list(f.session, `type=scheduled&decision=scheduled&agent=${f.agentId}`);
    expect(onlyScheduled.items.map((item) => item.id)).toEqual([later]);

    const detail = await call(deps, 'GET', `/api/logs/scheduled/${cancelled}`, authed(f.session));
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: cancelled, cancelledVia: 'mcp', cancelReason: 'wrong_recipient', tlogEntryId: null, tlogPending: false });
    // 본문 키·멱등 키 같은 칸은 응답에 없다.
    expect(detail.body).not.toContain('outbound/scheduled/');
    expect(detail.body).not.toContain('idem-');

    const paged: string[] = [];
    let before: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const next: Listed = await list(f.session, `type=scheduled&limit=1${before === null ? '' : `&before=${before}`}`);
      paged.push(...next.items.map((item) => item.id));
      if (next.next === null) break;
      before = next.next;
    }
    expect(paged).toEqual([later, cancelled, byApi]);
  });

  it('★ 다른 조직의 예약은 목록에 없고 상세는 404 · 상태 값 밖 400', async () => {
    const a = await fixture();
    const b = await fixture();
    const theirs = await schedule(b, { sendAt: new Date('2026-10-01T00:00:00Z'), cancel: { via: 'mcp', reason: 'other' } });
    expect((await list(a.session, 'type=scheduled')).items.map((item) => item.id)).not.toContain(theirs);
    const detail = await call(deps, 'GET', `/api/logs/scheduled/${theirs}`, authed(a.session));
    expect(detail.statusCode).toBe(404);
    const other = await call(deps, 'GET', '/api/logs', authed(a.session, { query: `type=scheduled&agent=${b.agentId}` }));
    expect(other.statusCode).toBe(404);
    const bad = await call(deps, 'GET', '/api/logs', authed(a.session, { query: 'type=scheduled&decision=sent' }));
    expect(bad.statusCode).toBe(400);
  });

  it('★ AC-A5-5 수신 필터 — 보낸 주소(정확·대소문자 무시) · 기간(반열림) · 주소 필터면 거부 행 없음', async () => {
    const f = await fixture();
    // 거부 행은 주소가 생긴 뒤의 것만 보인다(`REJECTION_VISIBLE_SQL`) — 시각은 지금 기준으로 잡는다.
    const hour = 60 * 60 * 1000;
    const base = Date.now() + hour;
    const at = (hours: number): Date => new Date(base + hours * hour);
    const iso = (hours: number): string => encodeURIComponent(at(hours).toISOString());
    const early = await inbound(f, { at: at(1), from: 'alice@x.example' });
    const mid = await inbound(f, { at: at(2), from: 'bob@x.example' });
    const late = await inbound(f, { at: at(3), from: 'alice@x.example' });
    const rejected = await rejection([f.address], at(2.5));

    const byFrom = await list(f.session, 'type=inbound&from=Alice@X.example');
    expect(byFrom.items.map((item) => item.id)).toEqual([late, early]);
    const period = await list(f.session, `type=inbound&since=${iso(2)}&until=${iso(3)}`);
    expect(period.items.map((item) => item.id)).toEqual([rejected, mid]);
    const both = await list(f.session, `type=inbound&from=alice@x.example&since=${iso(2)}`);
    expect(both.items.map((item) => item.id)).toEqual([late]);
    const rejectedOnly = await list(f.session, 'type=inbound&decision=rejected&from=alice@x.example');
    expect(rejectedOnly.items).toEqual([]);
    const rejectedPeriod = await list(f.session, `type=inbound&decision=rejected&until=${iso(2)}`);
    expect(rejectedPeriod.items).toEqual([]);

    for (const query of ['type=outbound&from=alice@x.example', 'type=scheduled&since=2026-09-23', 'type=inbound&from=nope', 'type=inbound&since=yesterday', 'type=inbound&since=2026-09-24&until=2026-09-23']) {
      const result = await call(deps, 'GET', '/api/logs', authed(f.session, { query }));
      expect(result.statusCode, query).toBe(400);
    }
  });
});
