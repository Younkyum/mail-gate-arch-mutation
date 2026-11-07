/**
 * **별칭 재발급 — 주소에 묶인 신뢰는 새 주인에게 이어지지 않는다**(보안 리뷰 M3 · ADR-0013 2026-09-29 개정 · `src/db/repositories/hosted-evidence.ts`).
 *
 * 에이전트 V 가 Atmark 주소 X(조직 A 의 별칭)를 믿는다 — 소유자 분류 `seen` · 관계(승인 없이 보내는 상대) · 받은/보낸 이력 · X 와의 스레드.
 * X 가 폐기되고(보류 중 — 활성 행 없음) 30일 뒤 조직 B 의 에이전트 M 이 X 를 받으면, M 이 X 로 보내는 메일은 그 신뢰를 하나도 물려받지 않는다:
 *   - 수신 신뢰 사실(`trust-facts-store`) — 관계 0 · 분류 0 · 받은/보낸 이력 0(막는 사실은 그대로).
 *   - 스레드 권한(`thread-store` + `resolveThread`) — 예전 X 에게 보낸 메일의 id 로 회신해도 기존 스레드가 아니다(`new`).
 *   - 발신 관계·스레드 사실(`policy-source`) — V 가 X 로 보낼 때 예전 관계가 없고, 그 스레드의 인증 발신자에 X 가 없다.
 * 재발급 **뒤**에 새로 쌓은 근거는 센다. **같은 조직의 재발급도 새 행이라 초기화된다**(다른 에이전트일 수 있다 — ADR 결정).
 * Atmark 밖 상대(`partner.example`)의 신뢰는 그대로다.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { ALIAS_REISSUE_HOLD_DAYS } from '../../../src/admin/ops/addresses';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { recordSenderMark } from '../../../src/db/repositories/sender-marks-store';
import { createPostgresThreadLookup } from '../../../src/db/repositories/thread-store';
import { createPostgresTrustFacts } from '../../../src/db/repositories/trust-facts-store';
import type { AgentId } from '../../../src/db/schema';
import { resolveThread } from '../../../src/mail/thread/resolve';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

describe.skipIf(!AVAILABLE)('별칭 재발급 — 주소에 묶인 신뢰는 이어지지 않는다(M3)', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin, { features: { addressAliases: true } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end()]);
  });

  interface Org {
    readonly orgId: string;
    readonly session: Session;
    readonly agentId: string;
    readonly address: string;
  }

  async function org(): Promise<Org> {
    const o = await newOrganization(owner, 'beta');
    const session = await login(deps, mailer, o);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'trust', localPart: `tr-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { orgId: o.id, session, agentId: agent.id, address: agent.address };
  }

  async function addAlias(o: Org, agentId: string, localPart: string): Promise<{ id: string; address: string }> {
    const result = await call(deps, 'POST', `/api/agents/${agentId}/aliases`, authed(o.session, { body: { localPart } }));
    expect(result.statusCode, result.body).toBe(201);
    return (result.json() as { item: { id: string; address: string } }).item;
  }

  async function retire(o: Org, agentId: string, addressId: string): Promise<void> {
    const result = await call(deps, 'POST', `/api/agents/${agentId}/aliases/${addressId}/retire`, authed(o.session, { body: {} }));
    expect(result.statusCode, result.body).toBe(200);
  }

  /** 보류가 지난 것처럼 — 트리거를 끈 소유자 세션에서 `retired_at` 을 앞당긴다. */
  async function passHold(addressId: string): Promise<void> {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE agent_addresses SET retired_at = retired_at - make_interval(days => $2::int) WHERE id = $1', [addressId, ALIAS_REISSUE_HOLD_DAYS + 1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  interface Evidence {
    readonly threadId: string;
    readonly outboundHeader: string;
  }

  /** V 가 상대 `counterpart` 를 믿는 근거 전부 — 분류 seen · 관계(seed) · 받은 메일(인증) 1 · 보낸 메일 1 · 둘이 같은 스레드. */
  async function trust(v: Org, counterpart: string): Promise<Evidence> {
    await recordSenderMark(owner, { agentId: v.agentId, scope: 'address', address: counterpart, mark: 'seen', markedBy: 'test' });
    await owner.query(
      `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
      [v.agentId, counterpart],
    );
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [v.agentId]);
    const threadId = thread.rows[0]?.id ?? '';
    const outboundHeader = `<${randomUUID()}@atmark.ai>`;
    const message = await owner.query<{ id: string }>(
      `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, subject, status, message_id_header,
                             idempotency_key, request_hash, recipient_count, ses_message_id, sent_at)
       VALUES ($1, $2, 'outbound', $3, split_part($4, '@', 2), 'hello', 'sent', $5, $6, $7, 1, $8, now())
       RETURNING id`,
      [
        v.agentId,
        threadId,
        createHash('sha256').update(v.address, 'utf8').digest('hex'),
        v.address,
        outboundHeader,
        `idem-${randomUUID()}`,
        createHash('sha256').update(randomUUID()).digest('hex'),
        `ses-${randomUUID()}`,
      ],
    );
    await owner.query('INSERT INTO outbound_recipients (message_id, address) VALUES ($1, $2)', [message.rows[0]?.id, counterpart]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    await owner.query(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust, message_id_header)
       VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), true, 'Re: hello', false, 'pass', 'pass', 'pass', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(),
               'test-v0', 'none', false, 'unknown', $6)`,
      [v.agentId, v.address, ses, threadId, counterpart, `<${randomUUID()}@partner.example>`],
    );
    return { threadId, outboundHeader };
  }

  interface Seen {
    readonly relationships: number;
    readonly marks: number;
    readonly inbound: number;
    readonly outbound: number;
    readonly threadHits: number;
    readonly authority: 'existing' | 'new';
    readonly sendRelationships: number;
    readonly threadSender: boolean;
  }

  /** V 의 눈으로 본 상대 — 수신 신뢰 사실 · 스레드 해석 · 발신 관계·스레드 사실. */
  async function seen(v: Org, counterpart: string, evidence: Evidence): Promise<Seen> {
    const facts = await createPostgresTrustFacts(app).loadTrustFacts(v.agentId, counterpart);
    const lookup = createPostgresThreadLookup(app);
    const hits = await lookup.findByHeaderKeys(v.agentId, [{ kind: 'message_id_header', value: evidence.outboundHeader }], counterpart);
    const resolution = await resolveThread(
      {
        agentId: v.agentId,
        messageId: `<${randomUUID()}@partner.example>`,
        inReplyTo: evidence.outboundHeader,
        references: [],
        from: counterpart,
        fromAuthenticated: true,
        subject: 'Re: hello',
      },
      lookup,
    );
    const policy = await createPostgresPolicySource(app).load({
      agentId: v.agentId as AgentId,
      recipients: [counterpart],
      now: new Date(),
      threadId: evidence.threadId,
      releaseApprovalId: null,
    });
    return {
      relationships: facts.relationships.length,
      marks: facts.ownerClassifications.length,
      inbound: facts.inbound.count,
      outbound: facts.outbound.sentCount,
      threadHits: hits.length,
      authority: resolution.authority.kind,
      sendRelationships: policy.relationships.length,
      threadSender: policy.thread?.authenticatedSenders.includes(counterpart) ?? false,
    };
  }

  const TRUSTED: Seen = { relationships: 1, marks: 1, inbound: 1, outbound: 1, threadHits: 1, authority: 'existing', sendRelationships: 1, threadSender: true };
  const NOTHING: Seen = { relationships: 0, marks: 0, inbound: 0, outbound: 0, threadHits: 0, authority: 'new', sendRelationships: 0, threadSender: false };

  it('다른 조직의 재발급(보류 30일 뒤) — 새 주인은 seen · 관계 · 이력 · 스레드 권한을 물려받지 않는다 · 보류 중에도 없다 · 뒤의 근거는 센다 · Atmark 밖 상대는 그대로', async () => {
    const a = await org();
    const b = await org();
    const v = await org();
    const localPart = `trusted-${suffix()}`;
    const x = await addAlias(a, a.agentId, localPart);
    const evidence = await trust(v, x.address);
    const carol = `carol-${suffix()}@partner.example`;
    const carolEvidence = await trust(v, carol);

    // 비공허성 — X 가 A 의 활성 주소인 동안(근거가 행보다 뒤) 신뢰가 다 보인다.
    expect(await seen(v, x.address, evidence)).toEqual(TRUSTED);
    expect(await seen(v, carol, carolEvidence)).toEqual(TRUSTED);

    // 폐기 · 보류 중 — 활성 행이 없으니 아무 근거도 세지 않는다.
    await retire(a, a.agentId, x.id);
    expect(await seen(v, x.address, evidence)).toEqual(NOTHING);

    // 30일 뒤 B 의 M 이 X 를 받는다 — 여전히 0.
    await passHold(x.id);
    await addAlias(b, b.agentId, localPart);
    expect(await seen(v, x.address, evidence)).toEqual(NOTHING);

    // Atmark 밖 상대는 그대로.
    expect(await seen(v, carol, carolEvidence)).toEqual(TRUSTED);

    // 재발급 뒤에 새로 쌓은 근거(소유자가 새 주인을 다시 seen 으로)는 센다.
    await recordSenderMark(owner, { agentId: v.agentId, scope: 'address', address: x.address, mark: 'seen', markedBy: 'test' });
    expect((await createPostgresTrustFacts(app).loadTrustFacts(v.agentId, x.address)).ownerClassifications).toHaveLength(1);
  });

  /** V 의 스레드에 인증 수신 한 통을 넣는다 — `quarantined` 면 injection 격리. `minutesAgo` 로 순서를 정한다. */
  async function inboundIn(v: Org, threadId: string, from: string, quarantined: boolean, minutesAgo: number): Promise<string> {
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, quarantine_reason, sender_trust, message_id_header)
       VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), true, 'Re: hello', false, 'pass', 'pass', 'pass', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now() - make_interval(mins => $6::int),
               'test-v0', $7, $8, $9, 'unknown', $10)
       RETURNING id`,
      [v.agentId, v.address, ses, threadId, from, minutesAgo, quarantined ? 'high' : 'none', quarantined, quarantined ? 'injection_risk' : null, `<${randomUUID()}@x.example>`],
    );
    return row.rows[0]?.id ?? '';
  }

  it('재검토 LOW-1 — 격리된 최신 수신은 보낸 별칭을 폐기해도 최신으로 남는다(더 깨끗한 옛 행으로 되돌아가 막힘이 풀리지 않는다)', async () => {
    const a = await org();
    const v = await org();
    const h = await addAlias(a, a.agentId, `h-${suffix()}`);
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [v.agentId]);
    const threadId = thread.rows[0]?.id ?? '';
    const e = `e-${suffix()}@partner.example`;
    await inboundIn(v, threadId, e, false, 10);
    const bad = await inboundIn(v, threadId, h.address, true, 1);

    const load = async () =>
      (await createPostgresPolicySource(app).load({ agentId: v.agentId as AgentId, recipients: [e], now: new Date(), threadId, releaseApprovalId: null })).thread;
    const before = await load();
    expect(before?.latestAuthenticatedInbound?.id).toBe(bad);
    expect(before?.latestAuthenticatedInbound?.quarantined).toBe(true);

    await retire(a, a.agentId, h.id);
    const after = await load();
    expect(after?.latestAuthenticatedInbound?.id).toBe(bad);
    expect(after?.latestAuthenticatedInbound?.quarantined).toBe(true);
    // 권한(인증 발신자 집합)은 컷오프가 그대로 건다 — 폐기된 H 는 빠지고 E 는 남는다.
    expect(after?.authenticatedSenders).toEqual([e]);
  });

  it('재검토 LOW-3 — created_at 은 DB 가 찍는다(과거 시각을 넣어도 now)', async () => {
    const a = await org();
    const localPart = `stamp-${suffix()}`;
    const row = await owner.query<{ fresh: boolean }>(
      `INSERT INTO agent_addresses (agent_id, address, domain, is_primary, created_at)
       VALUES ($1, $2 || '@atmark.ai', 'atmark.ai', false, '2020-01-01T00:00:00Z')
       RETURNING created_at > now() - interval '1 minute' AS fresh`,
      [a.agentId, localPart],
    );
    expect(row.rows[0]?.fresh).toBe(true);
  });

  it('같은 조직의 재발급도 새 행이라 근거가 초기화된다(다른 에이전트 · 같은 에이전트 둘 다)', async () => {
    const a = await org();
    const v = await org();
    const localPart = `same-${suffix()}`;
    const x = await addAlias(a, a.agentId, localPart);
    const evidence = await trust(v, x.address);
    expect(await seen(v, x.address, evidence)).toEqual(TRUSTED);

    await retire(a, a.agentId, x.id);
    const sibling = await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'sibling', localPart: `sib-${suffix()}` } }));
    expect(sibling.statusCode, sibling.body).toBe(201);
    const siblingId = (sibling.json() as { agent: { id: string } }).agent.id;
    const moved = await addAlias(a, siblingId, localPart);
    expect(await seen(v, x.address, evidence)).toEqual(NOTHING);

    // 같은 에이전트로 되돌려도(폐기 → 원래 에이전트가 바로 다시) 새 행이다.
    await retire(a, siblingId, moved.id);
    await addAlias(a, a.agentId, localPart);
    expect(await seen(v, x.address, evidence)).toEqual(NOTHING);
  });
});
