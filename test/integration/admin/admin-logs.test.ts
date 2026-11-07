/**
 * **콘솔 로그 API**(`GET /api/logs` · `GET /api/logs/{type}/{id}` — 계약 v2 §2, `src/admin/routes/logs.ts`).
 *
 * 전부 **`atmark_admin` 롤 풀**로 라우터를 돈다(운영 admin Lambda 와 같은 롤) — 202609241100 의 컬럼 단위 GRANT 가 모자라면
 * `permission denied` 로 빨개진다. 행 심기·검사는 소유자 롤. 실메일 0 · AWS 호출 0.
 *
 *   - 조직 격리: 다른 조직의 발신·수신·거부·콘솔 행이 목록에 없다 · 다른 조직 에이전트 필터 → 404 · 다른 조직 id 상세 → 404 ·
 *     여러 조직에 걸친 거부 메일은 각 조직에 자기 주소만 보인다 · 어느 조직 것도 아닌 거부(unknown_recipient)는 안 보인다 ·
 *     주소가 생기기 전의 거부와 unknown_recipient(봉투에 이 조직 주소가 함께 있어도)는 안 보인다(2026-09-24 검증).
 *   - 커서: 같은 시각(마이크로초까지)의 행이 여럿이어도 쪽을 넘기며 중복·누락이 없다 · 순서 = (시각 DESC, id DESC).
 *   - 정화: 제목·보낸 사람의 양방향·제어 문자가 응답에 없다.
 *   - 격리: 소유자에게는 격리 메일(스캐너 격리 · 정책 격리 `policy_blocked` — T1 202609241010)이 사유와 함께 보인다 ·
 *     본문·저장 키는 어떤 응답에도 없다.
 *   - 필터(decision·verdict·agent) · limit 경계 · 커서 위조(실재하지 않는 시각 포함 → 400, 500 아님) · Authorization 헤더 → 401 ·
 *     세션 없음 → 401 · GET 만.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';
import type { AdminDependencies } from '../../../src/admin/context';

/** 보이면 안 되는 문자 — C0/C1 제어 · 양방향 조작 · 폭 없는 문자. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

interface Fixture {
  readonly org: { id: string; ownerEmail: string };
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
  readonly policyVersionId: string;
}

interface Listed {
  readonly items: Array<Record<string, unknown> & { id: string }>;
  readonly next: string | null;
}

describe.skipIf(!AVAILABLE)('콘솔 로그 API — atmark_admin 롤 (계약 v2 §2)', () => {
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
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'logs', localPart: `logs-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    const version = await owner.query<{ id: string }>('SELECT id FROM policy_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1', [agent.id]);
    return { org, session, agentId: agent.id, address: agent.address, policyVersionId: version.rows[0]?.id ?? '' };
  }

  async function secondAgent(f: Fixture): Promise<{ id: string; address: string }> {
    const created = await call(deps, 'POST', '/api/agents', authed(f.session, { body: { name: 'logs-2', localPart: `logs2-${suffix()}` } }));
    return (created.json() as { agent: { id: string; address: string } }).agent;
  }

  type OutboundState = 'sent' | 'failed' | 'denied' | 'pending_approval' | 'dispatching' | 'queued' | 'ungated';

  /** 발신 시도 1건: 스레드 · 메시지 · 수신자 · (판정). 상태는 최종값으로 바로 심는다(전이 트리거는 UPDATE 만 본다). */
  async function outbound(
    f: { agentId: string; address: string; policyVersionId: string },
    state: OutboundState,
    options: { at?: Date; subject?: string; recipients?: string[]; reasons?: string[] } = {},
  ): Promise<string> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [f.agentId]);
    const status = state === 'pending_approval' || state === 'queued' || state === 'ungated' ? 'pending' : state;
    const recipients = options.recipients ?? ['to@example.com'];
    const message = await owner.query<{ id: string }>(
      `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, subject, status, message_id_header,
                             idempotency_key, request_hash, recipient_count, created_at,
                             ses_message_id, sent_at, failure_reason, failed_at, lease_id, lease_expires_at)
       VALUES ($1, $2, 'outbound', $3, split_part($4, '@', 2), $5, $6::message_status, $7, $8, $9, $10, $11,
               CASE WHEN $6 = 'sent' THEN $12 END, CASE WHEN $6 = 'sent' THEN now() END,
               CASE WHEN $6 = 'failed' THEN 'ses_rejected' END, CASE WHEN $6 = 'failed' THEN now() END,
               CASE WHEN $6 = 'dispatching' THEN gen_random_uuid() END, CASE WHEN $6 = 'dispatching' THEN now() + interval '1 minute' END)
       RETURNING id`,
      [
        f.agentId,
        thread.rows[0]?.id,
        createHash('sha256').update(f.address, 'utf8').digest('hex'),
        f.address,
        options.subject ?? `subject ${state}`,
        status,
        `<${randomUUID()}@atmark.test>`,
        `idem-${randomUUID()}`,
        createHash('sha256').update(randomUUID()).digest('hex'),
        recipients.length,
        options.at ?? new Date(),
        `ses-${randomUUID()}`,
      ],
    );
    const messageId = message.rows[0]?.id ?? '';
    await owner.query('INSERT INTO outbound_recipients (message_id, address) SELECT $1, unnest($2::text[])', [messageId, recipients]);
    if (state !== 'ungated') {
      const decision = state === 'denied' ? 'denied' : state === 'pending_approval' ? 'pending_approval' : 'allowed';
      await owner.query(
        `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version)
         VALUES ($1, $2, $3::audit_decision, $4::text[], $5, 1)`,
        [f.agentId, messageId, decision, options.reasons ?? (decision === 'denied' ? ['recipient_not_allowlisted'] : []), f.policyVersionId],
      );
    }
    return messageId;
  }

  async function inbound(
    f: { agentId: string; address: string },
    options: { at?: Date; from?: string; subject?: string; quarantined?: boolean; policyBlocked?: string } = {},
  ): Promise<string> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const policyBlocked = options.policyBlocked ?? null;
    // 정책 격리(T1, 202609241010)는 스캔은 깨끗한데 격리 — 사유 칸이 둘. 레거시 격리(injection)는 사유 칸 없이 high.
    const quarantined = options.quarantined === true || policyBlocked !== null;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust, quarantine_reason, policy_reason)
       VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), false, $6, false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, $7,
               'test-v0', $8::injection_risk, $9, 'unknown', CASE WHEN $10::text IS NOT NULL THEN 'policy_blocked' END, $10)
       RETURNING id`,
      [f.agentId, f.address, ses, thread.rows[0]?.id, options.from ?? 'sender@partner.example', options.subject ?? 'hello', options.at ?? new Date(),
        quarantined && policyBlocked === null ? 'high' : 'none', quarantined, policyBlocked],
    );
    return row.rows[0]?.id ?? '';
  }

  async function rejection(recipients: string[], reason = 'virus', at: Date = new Date()): Promise<string> {
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_rejections (ses_message_id, reason, detail, envelope_recipients, virus_verdict, spam_verdict, raw_storage_key, received_at)
       VALUES ($1, $2, 'internal detail sentinel', $3::text[], 'fail', 'pass', 'inbound/raw/' || $1, $4) RETURNING id`,
      [ses, reason, recipients, at],
    );
    return row.rows[0]?.id ?? '';
  }

  async function list(session: Session, query: string): Promise<Listed> {
    const result = await call(deps, 'GET', '/api/logs', authed(session, { query }));
    expect(result.statusCode, `${query} → ${result.body}`).toBe(200);
    return result.json() as Listed;
  }

  async function all(session: Session, query: string, limit: number): Promise<Listed['items']> {
    const items: Listed['items'] = [];
    let before: string | null = null;
    for (let pages = 0; pages < 100; pages += 1) {
      const page: Listed = await list(session, `${query}&limit=${String(limit)}${before === null ? '' : `&before=${before}`}`);
      expect(page.items.length).toBeLessThanOrEqual(limit);
      items.push(...page.items);
      if (page.next === null) return items;
      before = page.next;
    }
    throw new Error('쪽이 끝나지 않는다');
  }

  it('풀은 정말 atmark_admin 이다 — 이 파일의 GRANT 단언이 공허하지 않다', async () => {
    const who = await admin.query<{ user: string }>('SELECT current_user AS user');
    expect(who.rows[0]?.user).toBe('atmark_admin');
    // 허용 밖 칸은 여전히 못 읽는다(컬럼 단위 GRANT).
    for (const sql of ['SELECT trace_id FROM audit_logs LIMIT 1', 'SELECT session_id FROM owner_actions LIMIT 1', 'SELECT raw_storage_key FROM inbound_rejections LIMIT 1']) {
      await expect(admin.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('조직 격리 — 다른 조직의 발신·수신·거부·콘솔 행이 안 보이고, 다른 조직 에이전트 필터·상세는 404', async () => {
    const a = await fixture();
    const b = await fixture();
    const mine = { outbound: await outbound(a, 'sent'), inbound: await inbound(a), rejected: await rejection([a.address]) };
    const theirs = { outbound: await outbound(b, 'sent'), inbound: await inbound(b, { quarantined: true }), rejected: await rejection([b.address]) };
    const nobody = await rejection([`nobody-${suffix()}@atmark.ai`], 'unknown_recipient');

    const outA = await list(a.session, 'type=outbound');
    expect(outA.items.map((item) => item.id)).toEqual([mine.outbound]);
    const inA = await list(a.session, 'type=inbound');
    expect(inA.items.map((item) => item.id).sort()).toEqual([mine.inbound, mine.rejected].sort());
    expect(inA.items.map((item) => item.id)).not.toContain(nobody);
    const consoleA = await list(a.session, 'type=console');
    const consoleB = await list(b.session, 'type=console');
    expect(consoleA.items.length).toBeGreaterThan(0);
    expect(consoleA.items.map((item) => item.id).filter((id) => consoleB.items.some((other) => other.id === id))).toEqual([]);
    expect(consoleA.items.map((item) => item.targetId)).toContain(a.agentId);
    expect(consoleA.items.map((item) => item.targetId)).not.toContain(b.agentId);

    for (const type of ['outbound', 'inbound', 'console']) {
      const probe = await call(deps, 'GET', '/api/logs', authed(a.session, { query: `type=${type}&agent=${b.agentId}` }));
      expect([probe.statusCode, (probe.json() as { error: string }).error], type).toEqual([404, 'agent_not_found']);
    }
    for (const [type, id] of [
      ['outbound', theirs.outbound],
      ['inbound', theirs.inbound],
      ['inbound', theirs.rejected],
      ['inbound', nobody],
      ['console', consoleB.items[0]?.id ?? ''],
    ] as const) {
      const probe = await call(deps, 'GET', `/api/logs/${type}/${id}`, authed(a.session));
      expect([probe.statusCode, (probe.json() as { error: string }).error], `${type} ${id}`).toEqual([404, 'log_not_found']);
    }
    // 같은 id 를 제 조직으로는 볼 수 있다(비공허).
    expect((await call(deps, 'GET', `/api/logs/outbound/${theirs.outbound}`, authed(b.session))).statusCode).toBe(200);

    // 두 조직에 걸친 거부: 각 조직은 자기 주소만 본다.
    const shared = await rejection([a.address, b.address], 'raw_too_large');
    const sharedA = (await call(deps, 'GET', `/api/logs/inbound/${shared}`, authed(a.session))).json() as { to: string[]; agentId: string };
    const sharedB = (await call(deps, 'GET', `/api/logs/inbound/${shared}`, authed(b.session))).json() as { to: string[]; agentId: string };
    expect([sharedA.to, sharedA.agentId]).toEqual([[a.address], a.agentId]);
    expect([sharedB.to, sharedB.agentId]).toEqual([[b.address], b.agentId]);
  });

  it('커서 — 같은 시각(µs 동률 · 1µs 차이)의 행이 섞여도 쪽을 넘기며 중복·누락 없이 (시각 DESC, id DESC) 순서', async () => {
    const f = await fixture();
    const other = await secondAgent(f);
    const otherF = { ...f, agentId: other.id, address: other.address };
    const t = new Date(Date.now() - 60_000);
    // 거부 행은 주소가 생긴 뒤의 것만 보인다(아래 "거부 행의 주인" 테스트) — t(1분 전)가 주소 생성 뒤가 되게 주소를 하루 앞당긴다.
    // created_at 은 불변(202609291120 agent_addresses_identity_immutable) — 테스트 소유자 세션에서 트리거를 끄고 앞당긴다.
    const backdate = await owner.connect();
    try {
      await backdate.query('BEGIN');
      await backdate.query('SET LOCAL session_replication_role = replica');
      await backdate.query("UPDATE agent_addresses SET created_at = created_at - interval '1 day' WHERE agent_id = ANY ($1::text[])", [[f.agentId, other.id]]);
      await backdate.query('COMMIT');
    } finally {
      backdate.release();
    }
    const outIds: string[] = [];
    for (let i = 0; i < 5; i += 1) outIds.push(await outbound(f, 'sent', { at: t }));
    for (let i = 0; i < 4; i += 1) outIds.push(await outbound(otherF, 'queued', { at: t }));
    outIds.push(await outbound(f, 'denied', { at: new Date(t.getTime() + 1) }));
    const microId = await outbound(f, 'sent', { at: t });
    outIds.push(microId);
    // t + 1µs 인 행 둘 — id 가 가장 큰 것(ffffffff-…)과 가장 작은 것(00000000-…). 커서 시각을 밀리초로 자르면(JS Date 식)
    // 커서가 둘 중 어느 것에 걸려도 **결정적으로** 행을 건너뛴다: 큰 id 에 걸리면 작은 id 의 µs 행을, 작은 id 에 걸리면 t 행 전부를.
    for (const prefix of ['ffffffff', '00000000']) {
      const plusMicro = await owner.query<{ id: string }>(
        `INSERT INTO messages (id, agent_id, thread_id, direction, from_address_hash, from_domain, subject, status, message_id_header,
                               idempotency_key, request_hash, recipient_count, created_at)
         SELECT ($3 || substr(gen_random_uuid()::text, 9))::uuid, agent_id, thread_id, 'outbound', from_address_hash, from_domain, 'micro',
                'pending', '<' || gen_random_uuid() || '@atmark.test>', 'idem-' || gen_random_uuid(), request_hash, 1,
                $2::timestamptz + interval '1 microsecond'
           FROM messages WHERE id = $1 RETURNING id`,
        [microId, t, prefix],
      );
      await owner.query(`INSERT INTO outbound_recipients (message_id, address) VALUES ($1, 'to@example.com')`, [plusMicro.rows[0]?.id]);
      outIds.push(plusMicro.rows[0]?.id ?? '');
    }

    const expected = await owner.query<{ id: string }>(
      `SELECT m.id FROM messages m JOIN agents ag ON ag.id = m.agent_id
        WHERE ag.organization_id = $1 AND m.direction = 'outbound' ORDER BY m.created_at DESC, m.id DESC`,
      [f.org.id],
    );
    expect(expected.rows).toHaveLength(outIds.length);
    for (const limit of [1, 2, 3, 7]) {
      const paged = await all(f.session, 'type=outbound', limit);
      expect(paged.map((item) => item.id), `limit=${String(limit)}`).toEqual(expected.rows.map((row) => row.id));
    }
    // 에이전트 필터도 같은 규율.
    const onlyOther = await all(f.session, `type=outbound&agent=${other.id}`, 3);
    expect(onlyOther.map((item) => item.id).sort()).toEqual(outIds.slice(5, 9).sort());

    // 수신: 메시지 + 거부가 같은 시각에 섞인다.
    const inIds = [
      await inbound(f, { at: t }),
      await inbound(f, { at: t, quarantined: true }),
      await inbound(otherF, { at: t }),
      await rejection([f.address], 'virus', t),
      await rejection([other.address], 'mime_rejected', t),
      await inbound(f, { at: new Date(t.getTime() - 5) }),
    ];
    const inbound3 = await all(f.session, 'type=inbound', 2);
    expect(inbound3.map((item) => item.id).sort()).toEqual([...inIds].sort());
    expect(new Set(inbound3.map((item) => item.id)).size).toBe(inIds.length);
    const order = inbound3.map((item) => `${String(item.at)}|${item.id}`);
    expect(order).toEqual([...order].sort().reverse());

    // 콘솔: 같은 시각의 감사 행 여럿.
    const sessionId = await owner.query<{ id: string }>('SELECT id FROM owner_sessions WHERE organization_id = $1 LIMIT 1', [f.org.id]);
    await owner.query(
      `INSERT INTO owner_actions (session_id, organization_id, action, target_id, created_at)
       SELECT $1, $2, 'probe.same_time', NULL, $3 FROM generate_series(1, 6)`,
      [sessionId.rows[0]?.id, f.org.id, t],
    );
    const consoleExpected = await owner.query<{ id: string }>(
      'SELECT id FROM owner_actions WHERE organization_id = $1 ORDER BY created_at DESC, id DESC',
      [f.org.id],
    );
    const consolePaged = await all(f.session, 'type=console', 4);
    expect(consolePaged.map((item) => item.id)).toEqual(consoleExpected.rows.map((row) => row.id));
  });

  it('거부 행의 주인 — 주소가 생기기 전에 받은 거부 · unknown_recipient 는 (봉투에 이 조직 주소가 있어도) 목록·상세에 없다', async () => {
    const f = await fixture();
    const created = await owner.query<{ at: Date }>('SELECT created_at AS at FROM agent_addresses WHERE address = $1', [f.address]);
    const addressCreated = created.rows[0]?.at ?? new Date();
    // 이 주소가 이 조직 것이 되기 전(= 다른 누군가 앞으로 왔을 수 있는) 거부.
    const before = await rejection([f.address], 'virus', new Date(addressCreated.getTime() - 60 * 60_000));
    // 여러 수신자 메일 — 사유는 **다른**(없는) 주소에 대한 것이다.
    const unknown = await rejection([f.address, `nobody-${suffix()}@atmark.ai`], 'unknown_recipient');
    // 비공허: 주소가 생긴 뒤의 진짜 거부는 보인다.
    const after = await rejection([f.address], 'mime_rejected');

    const listed = (await list(f.session, 'type=inbound')).items.map((item) => item.id);
    expect(listed).toContain(after);
    expect(listed).not.toContain(before);
    expect(listed).not.toContain(unknown);
    expect((await list(f.session, 'type=inbound&verdict=rejected')).items.map((item) => item.id)).toEqual([after]);
    for (const id of [before, unknown]) {
      const probe = await call(deps, 'GET', `/api/logs/inbound/${id}`, authed(f.session));
      expect([probe.statusCode, (probe.json() as { error: string }).error], id).toEqual([404, 'log_not_found']);
    }
    expect((await call(deps, 'GET', `/api/logs/inbound/${after}`, authed(f.session))).statusCode).toBe(200);
  });

  it('정화 — 제목·보낸 사람의 양방향·제어·폭 없는 문자가 목록·상세 응답에 없다', async () => {
    const f = await fixture();
    const dirty = 'Invoice \u202Egnp.exe\u202C\u0007 paid\r\nBcc: x@evil.example\u200B';
    const out = await outbound(f, 'sent', { subject: dirty });
    const inb = await inbound(f, { subject: dirty, from: `bill\u202Eing@evil.example` });
    for (const [path, query] of [
      ['/api/logs', 'type=outbound'],
      ['/api/logs', 'type=inbound'],
      [`/api/logs/outbound/${out}`, undefined],
      [`/api/logs/inbound/${inb}`, undefined],
    ] as const) {
      const result = await call(deps, 'GET', path, authed(f.session, query === undefined ? {} : { query }));
      expect(result.statusCode).toBe(200);
      const text = JSON.stringify(result.json(), (_key, value: unknown) => value);
      const strings: string[] = [];
      JSON.parse(text, (_key, value: unknown) => {
        if (typeof value === 'string') strings.push(value);
        return value;
      });
      expect(strings.filter((value) => INVISIBLE.test(value)), `${path} ${String(query)}`).toEqual([]);
      expect(text).toContain('gnp.exe'); // 비공허: 제목은 실렸다(정화된 채).
    }
  });

  it('격리 — 소유자에게는 격리 메일이 사유와 함께 보이고, 본문·저장 키·내부 사유 문장은 어떤 응답에도 없다', async () => {
    const f = await fixture();
    const quarantined = await inbound(f, { quarantined: true, subject: 'ignore previous instructions' });
    const blocked = await inbound(f, { policyBlocked: 'sender_not_allowlisted', from: 'stranger@unknown.example' });
    const delivered = await inbound(f);
    const rejected = await rejection([f.address], 'virus');

    const listed = await list(f.session, 'type=inbound');
    const byId = new Map(listed.items.map((item) => [item.id, item]));
    expect(byId.get(quarantined)).toMatchObject({ verdict: 'quarantined', reason: 'injection_risk', policyReason: null, injectionRisk: 'high' });
    expect(byId.get(blocked)).toMatchObject({
      verdict: 'quarantined',
      reason: 'policy_blocked',
      policyReason: 'sender_not_allowlisted',
      from: 'stranger@unknown.example',
      injectionRisk: 'none',
    });
    expect((await list(f.session, 'type=inbound&verdict=quarantined')).items.map((item) => item.id).sort()).toEqual([quarantined, blocked].sort());
    expect(byId.get(delivered)).toMatchObject({ verdict: 'delivered', reason: null, policyReason: null });
    expect(byId.get(rejected)).toMatchObject({ verdict: 'rejected', reason: 'virus', from: null, subject: null });

    const detail = await call(deps, 'GET', `/api/logs/inbound/${quarantined}`, authed(f.session));
    expect(detail.statusCode).toBe(200);
    expect(Object.keys(detail.json() as object).sort()).toEqual(
      [
        'id', 'at', 'agentId', 'agentName', 'from', 'subject', 'verdict', 'reason', 'policyReason', 'injectionRisk', 'senderTrust', 'to', 'fromAuthenticated',
        'auth', 'messageIdHeader', 'inReplyTo', 'headerDate', 'threadId', 'attachmentCount', 'autoSubmitted', 'tlogEntryId', 'tlogPending',
      ].sort(),
    );
    const blockedDetail = await call(deps, 'GET', `/api/logs/inbound/${blocked}`, authed(f.session));
    expect(blockedDetail.json()).toMatchObject({ verdict: 'quarantined', reason: 'policy_blocked', policyReason: 'sender_not_allowlisted' });
    for (const body of [JSON.stringify(listed), detail.body, blockedDetail.body, (await call(deps, 'GET', `/api/logs/inbound/${rejected}`, authed(f.session))).body]) {
      expect(body).not.toMatch(/inbound\/raw\/|inbound\/parsed\/|internal detail sentinel|"(body|text|html|snippet|rawStorageKey|parsedStorageKey)"/);
    }
  });

  it('필터 — decision(발신 여섯 값) · verdict(수신 셋) · agent · 값 밖은 400', async () => {
    const f = await fixture();
    const other = await secondAgent(f);
    const ids = {
      sent: await outbound(f, 'sent'),
      failed: await outbound(f, 'failed'),
      denied: await outbound(f, 'denied', { reasons: ['recipient_not_allowlisted'] }),
      pending: await outbound(f, 'pending_approval'),
      sending: await outbound(f, 'dispatching'),
      queued: await outbound(f, 'queued'),
      ungated: await outbound(f, 'ungated'),
      otherAgent: await outbound({ ...f, agentId: other.id, address: other.address }, 'sent', { recipients: ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'e@x.example', 'f@x.example', 'g@x.example'] }),
    };
    const byDecision = async (decision: string): Promise<string[]> => (await list(f.session, `type=outbound&decision=${decision}`)).items.map((item) => item.id).sort();
    expect(await byDecision('sent')).toEqual([ids.sent, ids.otherAgent].sort());
    expect(await byDecision('failed')).toEqual([ids.failed]);
    expect(await byDecision('denied')).toEqual([ids.denied]);
    expect(await byDecision('pending')).toEqual([ids.pending]);
    expect(await byDecision('sending')).toEqual([ids.sending]);
    expect(await byDecision('queued')).toEqual([ids.queued, ids.ungated].sort());
    expect((await list(f.session, `type=outbound&agent=${other.id}`)).items.map((item) => item.id)).toEqual([ids.otherAgent]);

    const denied = (await list(f.session, 'type=outbound&decision=denied')).items[0];
    expect(denied).toMatchObject({ reasons: ['recipient_not_allowlisted'], policyVersion: 1, from: f.address, agentId: f.agentId });
    const wide = (await list(f.session, `type=outbound&agent=${other.id}`)).items[0];
    expect(wide).toMatchObject({ recipientCount: 7, recipients: ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'e@x.example'] });
    const wideDetail = (await call(deps, 'GET', `/api/logs/outbound/${ids.otherAgent}`, authed(f.session))).json() as { recipients: string[] };
    expect(wideDetail.recipients).toHaveLength(7);
    const failedDetail = (await call(deps, 'GET', `/api/logs/outbound/${ids.failed}`, authed(f.session))).json() as Record<string, unknown>;
    expect(failedDetail).toMatchObject({ decision: 'failed', failureReason: 'ses_rejected', policyVersion: 1 });

    const quarantined = await inbound(f, { quarantined: true });
    const delivered = await inbound(f);
    const rejected = await rejection([f.address]);
    expect((await list(f.session, 'type=inbound&verdict=quarantined')).items.map((item) => item.id)).toEqual([quarantined]);
    expect((await list(f.session, 'type=inbound&decision=delivered')).items.map((item) => item.id)).toEqual([delivered]);
    expect((await list(f.session, 'type=inbound&verdict=rejected')).items.map((item) => item.id)).toEqual([rejected]);
    expect((await list(f.session, `type=inbound&agent=${other.id}`)).items).toEqual([]);

    for (const query of [
      'type=outbound&decision=delivered',
      'type=inbound&verdict=sent',
      'type=outbound&verdict=sent',
      'type=inbound&decision=delivered&verdict=delivered',
      'type=console&decision=sent',
      'type=outbound&agent=not-an-id',
      'type=nope',
      '',
    ]) {
      const result = await call(deps, 'GET', '/api/logs', authed(f.session, { query }));
      expect(result.statusCode, query).toBe(400);
    }
  });

  it('limit 경계 — 기본 50 · 최대 100 · 0/101/문자/음수는 400 · 커서 위조·다른 type 커서는 400', async () => {
    const f = await fixture();
    const sessionId = await owner.query<{ id: string }>('SELECT id FROM owner_sessions WHERE organization_id = $1 LIMIT 1', [f.org.id]);
    await owner.query(
      `INSERT INTO owner_actions (session_id, organization_id, action, created_at)
       SELECT $1, $2, 'probe.bulk', now() - make_interval(secs => n) FROM generate_series(1, 120) AS n`,
      [sessionId.rows[0]?.id, f.org.id],
    );
    const first = await list(f.session, 'type=console');
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    expect((await list(f.session, 'type=console&limit=100')).items).toHaveLength(100);
    expect((await list(f.session, 'type=console&limit=1')).items).toHaveLength(1);
    for (const limit of ['0', '101', '1000', 'abc', '-1', '1.5', '']) {
      const result = await call(deps, 'GET', '/api/logs', authed(f.session, { query: `type=console&limit=${limit}` }));
      expect([result.statusCode, (result.json() as { error: string }).error], limit).toEqual([400, 'invalid_limit']);
    }
    const forged = [
      Buffer.from(JSON.stringify({ k: 'console', t: '2026-01-01T00:00:00Z', i: randomUUID() })).toString('base64url'),
      // 모양은 맞지만 실재하지 않는 시각 — 예전 판은 `::timestamptz` 캐스트가 500 을 냈다(2026-09-24 검증).
      Buffer.from(JSON.stringify({ k: 'console', t: '2026-13-45T99:99:99.000000Z', i: randomUUID() })).toString('base64url'),
      Buffer.from(JSON.stringify({ k: 'console', t: '0000-01-01T00:00:00.000000Z', i: randomUUID() })).toString('base64url'),
      Buffer.from(JSON.stringify({ k: 'console', t: '2026-02-30T00:00:00.000000Z', i: randomUUID() })).toString('base64url'),
      Buffer.from(JSON.stringify({ k: 'console', t: "2026-01-01T00:00:00.000000Z'; --", i: randomUUID() })).toString('base64url'),
      Buffer.from('not json').toString('base64url'),
      'a+b/c=',
      first.next ?? '',
    ];
    for (const [index, before] of forged.entries()) {
      const type = index === forged.length - 1 ? 'outbound' : 'console'; // 마지막: console 커서를 outbound 에
      const result = await call(deps, 'GET', '/api/logs', authed(f.session, { query: `type=${type}&before=${encodeURIComponent(before)}` }));
      expect([result.statusCode, (result.json() as { error: string }).error], before).toEqual([400, 'invalid_cursor']);
    }
    const badId = await call(deps, 'GET', '/api/logs/outbound/not-a-uuid', authed(f.session));
    expect([badId.statusCode, (badId.json() as { error: string }).error]).toEqual([400, 'invalid_log_id']);
    const badType = await call(deps, 'GET', `/api/logs/nope/${randomUUID()}`, authed(f.session));
    expect([badType.statusCode, (badType.json() as { error: string }).error]).toEqual([400, 'invalid_log_type']);
  });

  it('인증 — 세션 없음 401 · Authorization 헤더가 있으면 세션이 있어도 401 · GET 전용(CSRF 없이 읽힌다) · POST 는 405', async () => {
    const f = await fixture();
    const id = await outbound(f, 'sent');
    expect((await call(deps, 'GET', '/api/logs', { query: 'type=outbound' })).statusCode).toBe(401);
    expect((await call(deps, 'GET', `/api/logs/outbound/${id}`)).statusCode).toBe(401);
    for (const path of ['/api/logs', `/api/logs/outbound/${id}`]) {
      const bearer = await call(deps, 'GET', path, authed(f.session, { query: 'type=outbound', headers: { authorization: 'Bearer atk_live_x' } }));
      expect([bearer.statusCode, (bearer.json() as { error: string }).error], path).toEqual([401, 'unauthenticated']);
    }
    // CSRF 헤더 없이 쿠키만으로 읽힌다(GET).
    const plain = await call(deps, 'GET', '/api/logs', { query: 'type=outbound', cookies: f.session.cookies });
    expect(plain.statusCode).toBe(200);
    expect((await call(deps, 'POST', '/api/logs', authed(f.session, { body: {} }))).statusCode).toBe(405);
  });
});
