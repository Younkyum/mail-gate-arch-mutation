/**
 * P3b — **실제 Postgres 에서** 스레드 회신 판정이 무엇을 읽는가.
 *
 * 수신은 운영과 같은 소비자(`consumeInboundMail`)가 만든다 — 스레드 해석(권한용/표시용)·스캔·신뢰 스탬프가 전부
 * 진짜다. 발송은 운영과 같은 라우트·서비스·관문·Postgres 소스이고, 가짜는 전송단(SES 호출 수를 센다)과 본문
 * 저장소(메모리)뿐이다.
 *
 * 되돌려서 빨개져야 하는 것(★):
 *   - 외부인이 시작한 스레드의 회신이 `auto_approve_reply_within_thread` 로 나간다.
 *   - 남의 에이전트 스레드 id 를 주장해 그 스레드의 회신 면제를 빌린다.
 *   - 표시용(`display_thread_id`)으로만 묶인 발신자가 그 스레드의 참여자가 된다.
 *   - DMARC 불통과 발신자에게의 회신이 스레드 회신이 된다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundServiceDependencies,
} from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { handleReply, type ReplyRouteDependencies } from '../../../src/api/routes/reply';
import { createPool } from '../../../src/db/client';
import { createPostgresGateStores, createPostgresPolicySource } from '../../../src/db/repositories';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { recordSenderMark } from '../../../src/db/repositories/sender-marks-store';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { dispatch } from '../../../src/policy/gate';
import { loadEvaluationInput } from '../../../src/policy/policy-loader';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from '../inbound/support';
import { countingTransport, issuedToken, type CountingTransport } from './support/fakes';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';
import { forwardSource } from './support/forward-fakes';

const ownerUrl = process.env['TEST_MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_MIGRATION_URL'] ?? '';
const OWNER_AVAILABLE = DATABASE_AVAILABLE && ownerUrl.trim() !== '';

let ownerPool: Pool | undefined;
function owner(): Pool {
  ownerPool ??= createPool(ownerUrl, { max: 2 });
  return ownerPool;
}

afterAll(async () => {
  await ownerPool?.end();
  if (DATABASE_AVAILABLE) await closeTestPool();
});

interface Agent {
  readonly agentId: AgentId;
  readonly address: string;
  readonly token: ReturnType<typeof issuedToken>;
}

async function seedAgent(pool: Pool, config: Record<string, unknown> = {}): Promise<Agent> {
  const agentId = toAgentId(randomBytes(16).toString('hex'));
  const address = `p3b-${agentId.slice(0, 16)}@atmark.ai`;
  const org = await provisioningPool().query<{ id: string }>(
    `INSERT INTO organizations (name, billing_status) VALUES ($1, 'active') RETURNING id`,
    [`p3b-org-${agentId.slice(0, 8)}`],
  );
  await provisioningPool().query(
    `INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 100000)`,
    [agentId, org.rows[0]?.id, `p3b-agent-${agentId.slice(0, 8)}`],
  );
  await provisioningPool().query(
    `INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`,
    [agentId, address],
  );
  const limits = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
  const full = { allowlist: [], blocklist: [], max_attachment_bytes_total: 10_000_000, allowed_mime_types: ['text/plain'], ...config };
  await provisioningPool().query(
    `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version)
     VALUES ($1, 'approval_required', $2::jsonb, $3::jsonb, 1)`,
    [agentId, JSON.stringify(limits), JSON.stringify(full)],
  );
  await provisioningPool().query(
    `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot) VALUES ($1, 1, 'approval_required', $2::jsonb)`,
    [agentId, JSON.stringify({ outbound_mode: 'approval_required', limits, config_json: full })],
  );
  return { agentId, address, token: issuedToken(agentId) };
}

function service(pool: Pool): OutboundServiceDependencies {
  const stores = createPostgresGateStores(pool);
  return {
    source: stores.source,
    audit: stores.audit,
    dispatchStore: stores.leases,
    serializer: stores.serializer,
    sendEvidence: stores.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content: createInMemoryContentStore(),
    leaseTtlSeconds: 300,
    riskSignals: inertRiskSignals(),
    dlp: inertDlp(),
    now: () => new Date(),
  };
}

function partner(): string {
  return `p-${randomBytes(4).toString('hex')}@partner.example`;
}

interface Inbound {
  readonly id: string;
  readonly threadId: string;
  readonly displayThreadId: string | null;
  readonly messageIdHeader: string | null;
}

async function receive(
  pool: Pool,
  agent: Agent,
  from: string,
  options: { readonly inReplyTo?: string; readonly dmarc?: string; readonly text?: string } = {},
): Promise<Inbound> {
  const sesMessageId = newSesMessageId();
  const outcome = await deliver(
    consumerDeps(pool, newObjectStore()),
    eml({
      from,
      to: agent.address,
      subject: '견적 문의',
      text: options.text ?? '안녕하세요, 견적 부탁드립니다.',
      ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
    }),
    {
      sesMessageId,
      recipients: [agent.address],
      commonFrom: [from],
      // 지금 받은 것으로 — 확인 메일 자동 승인은 수신 뒤 창(VERIFICATION_REPLY_WINDOW_MS) 안에서만 열린다.
      // 픽스처의 고정 수신 시각을 쓰면 그 날짜가 지난 뒤 이 파일이 날짜 때문에 빨개진다(2026-09-24 실측).
      receivedAt: new Date().toISOString(),
      ...(options.dmarc === undefined ? {} : { dmarc: options.dmarc }),
    },
  );
  expect(outcome).toBe('stored');
  const row = await pool.query<{ id: string; thread_id: string; display_thread_id: string | null; message_id_header: string | null }>(
    'SELECT id, thread_id, display_thread_id, message_id_header FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2',
    [agent.agentId, sesMessageId],
  );
  const inbound = row.rows[0];
  if (inbound === undefined) throw new Error('수신 행이 없다');
  return {
    id: inbound.id,
    threadId: inbound.thread_id,
    displayThreadId: inbound.display_thread_id,
    messageIdHeader: inbound.message_id_header,
  };
}

/** 에이전트가 먼저 보낸다(seed 상대 — 승인 없이 나간다). 돌려주는 것은 우리 `Message-ID`. */
async function sendFirst(pool: Pool, agent: Agent, to: string, transport: CountingTransport): Promise<string> {
  await provisioningPool().query(
    `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by)
     VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
    [agent.agentId, to],
  );
  const deps = service(pool);
  const prepared = await prepareOutbound(deps, {
    routeId: 'send',
    agentId: agent.agentId,
    idempotencyKey: randomUUID(),
    fromAddress: agent.address,
    recipients: [to],
    subject: '견적 문의',
    text: '첫 연락',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  });
  if (prepared.kind !== 'ready') throw new Error(`ready 여야 한다: ${prepared.outcome.kind}`);
  const outcome = await dispatch(gateDependenciesFor(deps, transport), prepared.dispatchRequest);
  const final = await finalizeOutbound(deps, prepared, outcome);
  if (final.kind !== 'sent') throw new Error(`첫 발송이 나가지 않았다: ${final.kind}`);
  return final.messageIdHeader;
}

function replyDeps(pool: Pool, agent: Agent, transport: CountingTransport): ReplyRouteDependencies {
  return { tokens: agent.token.store, service: service(pool), transport, replyTargets: createPostgresReplyTargetLookup(pool), artifacts: forwardSource().artifacts };
}

async function reply(
  pool: Pool,
  agent: Agent,
  inbound: Inbound,
  transport: CountingTransport,
  body: Record<string, unknown> = {},
): Promise<{ readonly status: number; readonly reasons: readonly string[]; readonly messageId: string }> {
  const response = await handleReply(
    replyDeps(pool, agent, transport),
    {
      headers: { authorization: `Bearer ${agent.token.plaintext}`, 'idempotency-key': randomUUID() },
      query: {},
      body: { agent_id: agent.agentId, from: agent.address, in_reply_to: inbound.id, text: '회신 드립니다', ...body },
    },
    { threadId: inbound.threadId },
  );
  const decision = response.body['decision'] as { reasons?: string[] } | undefined;
  return { status: response.status, reasons: decision?.reasons ?? [], messageId: String(response.body['message_id']) };
}

async function threadOf(pool: Pool, messageId: string): Promise<{ thread_id: string; started_by: string }> {
  const row = await pool.query<{ thread_id: string; started_by: string }>(
    `SELECT m.thread_id, t.started_by::text AS started_by FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1`,
    [messageId],
  );
  if (row.rows[0] === undefined) throw new Error('messages 행이 없다');
  return row.rows[0];
}

describe.skipIf(!DATABASE_AVAILABLE)('P3b — 스레드 회신 판정 (실제 Postgres)', () => {
  it('에이전트가 시작한 스레드: 상대의 인증 회신에 답하면 승인 없이 나간다 — 같은 스레드에 붙는다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, agent, bob, transport);

    const inbound = await receive(pool, agent, bob, { inReplyTo: ours });
    const result = await reply(pool, agent, inbound, transport);

    expect(result.status).toBe(200);
    expect(result.reasons).toEqual(['auto_approve_reply_within_thread']);
    expect(transport.calls()).toBe(2);
    // 회신은 **그 스레드**에 붙었고, 스레드를 연 쪽은 그대로다.
    expect(await threadOf(pool, result.messageId)).toEqual({ thread_id: inbound.threadId, started_by: 'agent' });
    const recipients = await pool.query('SELECT address FROM outbound_recipients WHERE message_id = $1', [result.messageId]);
    expect(recipients.rows).toEqual([{ address: bob }]);
  });

  it('★ 외부인이 시작한 스레드: 인증된 공격자 메일에 답해도 `auto_approve_reply_within_thread` 로 나가지 않는다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const attacker = `a-${randomBytes(4).toString('hex')}@evil.example`;

    const inbound = await receive(pool, agent, attacker);
    const result = await reply(pool, agent, inbound, transport);

    expect(result.status).toBe(202);
    expect(result.reasons).toEqual(['new_recipient']);
    expect(transport.calls()).toBe(0);
    // 회신 행도 그 외부 스레드에 붙는다 — 그리고 그 스레드는 여전히 `external` 이다.
    expect(await threadOf(pool, result.messageId)).toEqual({ thread_id: inbound.threadId, started_by: 'external' });
  });

  it('★ DMARC 불통과 발신자에게의 회신은 스레드 회신이 아니다(인증 수신이 없는 스레드)', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, agent, bob, transport);

    // 같은 주소로 사칭 — 헤더는 우리 메일을 가리키지만 DMARC 가 실패한다 → 권한용은 새 외부 스레드.
    const spoofed = await receive(pool, agent, bob, { inReplyTo: ours, dmarc: 'FAIL' });
    const input = await loadEvaluationInput(createPostgresPolicySource(pool), {
      agentId: agent.agentId,
      attempt: { routeId: 'reply', fromAddress: agent.address, recipients: [bob], attachments: [], threadId: spoofed.threadId, contentShape: 'other', dlp: [], pinnedTaint: false },
      now: new Date(),
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
    });
    expect(spoofed.threadId).not.toBe(spoofed.displayThreadId);
    expect(input.ctx.approval.thread).toBeNull();
  });

  it('★ 권한용 스레드 **안의** DMARC 불통과 발신자도 참여자가 아니다(소스의 `from_authenticated` 필터)', async () => {
    // 해석기는 불통과 메일을 기존 스레드에 잇지 않는다 — 그래서 이 상태는 소비자로는 만들 수 없고, 소스의 필터는
    // 그 해석기 규칙이 깨진 날의 두 번째 층이다. 행을 직접 만들어 그 층만 본다(인증 행을 복제해 발신자만 바꾼다).
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, agent, bob, transport);
    const legit = await receive(pool, agent, bob, { inReplyTo: ours });
    const eve = partner();
    const ses = newSesMessageId();
    await pool.query(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, display_thread_id, matched_by, matched_message_id,
          matched_direction, new_thread_reason, message_id_header, in_reply_to, from_address, from_domain,
          from_authenticated, subject, header_date, auto_submitted, envelope_sender, forwarded_for_header,
          forwarded_to_header, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust, sender_trust_decided_by)
       SELECT agent_id, envelope_recipient, $2, thread_id, NULL, NULL, NULL,
              NULL, 'sender_unauthenticated', NULL, NULL, $3, split_part($3, '@', 2),
              false, subject, header_date, auto_submitted, envelope_sender, NULL,
              NULL, spf_verdict, dkim_verdict, 'fail', spam_verdict, virus_verdict, headers_truncated,
              'inbound/raw/' || $2, 'inbound/parsed/' || $2 || '.json', text_source, has_html_text, 0, now(),
              scanner_version, injection_risk, quarantined, 'unknown', NULL
         FROM inbound_messages WHERE id = $1`,
      [legit.id, ses, eve],
    );

    const input = await loadEvaluationInput(createPostgresPolicySource(pool), {
      agentId: agent.agentId,
      attempt: { routeId: 'reply', fromAddress: agent.address, recipients: [eve], attachments: [], threadId: legit.threadId, contentShape: 'other', dlp: [], pinnedTaint: false },
      now: new Date(),
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
    });
    expect(input.ctx.approval.thread).toBeNull();
  });

  it('★ 남의 에이전트 스레드 id 를 주장해도 그 스레드의 사실은 실리지 않는다', async () => {
    const pool = testPool();
    const owner1 = await seedAgent(pool);
    const intruder = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, owner1, bob, transport);
    const inbound = await receive(pool, owner1, bob, { inReplyTo: ours });

    const load = (agentId: AgentId) =>
      loadEvaluationInput(createPostgresPolicySource(pool), {
        agentId,
        attempt: { routeId: 'reply', fromAddress: 'x@atmark.ai', recipients: [bob], attachments: [], threadId: inbound.threadId, contentShape: 'other', dlp: [], pinnedTaint: false },
        now: new Date(),
        traceId: null,
        thisAttemptCostCents: 0,
        release: null,
      });
    // 통제군 — 주인에게는 사실이 실린다.
    expect((await load(owner1.agentId)).ctx.approval.thread?.startedBy).toBe('agent');
    expect((await load(intruder.agentId)).ctx.approval.thread).toBeNull();
    // 라우트도 남의 수신 메일 id 를 모른다.
    expect(await createPostgresReplyTargetLookup(pool).find(intruder.agentId, inbound.id)).toBeNull();
  });

  it('★ 표시용으로만 묶인 발신자(`display_thread_id`)는 그 스레드의 참여자가 아니다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, agent, bob, transport);
    const legit = await receive(pool, agent, bob, { inReplyTo: ours });

    // mallory 는 인증되지만 원 메일의 수신자가 아니다 → 권한용은 새 스레드, **표시용은 에이전트 스레드**.
    const mallory = partner();
    const intruding = await receive(pool, agent, mallory, { inReplyTo: ours });
    expect(intruding.displayThreadId).toBe(legit.threadId);
    expect(intruding.threadId).not.toBe(legit.threadId);

    const input = await loadEvaluationInput(createPostgresPolicySource(pool), {
      agentId: agent.agentId,
      attempt: { routeId: 'reply', fromAddress: agent.address, recipients: [mallory], attachments: [], threadId: legit.threadId, contentShape: 'other', dlp: [], pinnedTaint: false },
      now: new Date(),
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
    });
    expect(input.ctx.approval.thread).toBeNull();

    // Reply-To 우회와 같은 모양 — 에이전트 스레드의 메일에 답하되 수신자를 스레드 밖 주소로.
    const redirected = await reply(pool, agent, legit, transport, { to: [mallory] });
    expect(redirected.status).toBe(202);
    expect(transport.calls()).toBe(1);
  });

  it('회신 헤더는 받은 메일의 Message-ID 를 가리킨다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool);
    const transport = countingTransport();
    const bob = partner();
    const ours = await sendFirst(pool, agent, bob, transport);
    const inbound = await receive(pool, agent, bob, { inReplyTo: ours });

    const deps = replyDeps(pool, agent, transport);
    const response = await handleReply(
      deps,
      {
        headers: { authorization: `Bearer ${agent.token.plaintext}`, 'idempotency-key': randomUUID() },
        query: {},
        body: { agent_id: agent.agentId, from: agent.address, in_reply_to: inbound.id, text: '네' },
      },
      { threadId: inbound.threadId },
    );
    const content = await deps.service.content.load(String(response.body['message_id']));
    expect(content.subject).toBe('Re: 견적 문의');
    expect(content.threading).toEqual({ inReplyTo: inbound.messageIdHeader, references: [ours, inbound.messageIdHeader] });
  });
});

describe.skipIf(!OWNER_AVAILABLE)('P3b — `auto_approve_verification_senders` ON (실제 Postgres + 소유자 표시)', () => {
  it('확인 메일 발신자(seen)에게의 코드 회신만 승인 없이 나간다 — 문장 회신은 승인 대기', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool, { auto_approve_verification_senders: true });
    const transport = countingTransport();
    const noreply = `noreply-${randomBytes(4).toString('hex')}@service.example`;
    await recordSenderMark(owner(), { agentId: agent.agentId, scope: 'address', address: noreply, mark: 'seen', markedBy: 'test' });

    const inbound = await receive(pool, agent, noreply, { text: '안녕하세요' });
    const trust = await pool.query<{ sender_trust: string; injection_risk: string | null; quarantined: boolean }>(
      'SELECT sender_trust, injection_risk, quarantined FROM inbound_messages WHERE id = $1',
      [inbound.id],
    );
    expect(trust.rows[0]).toEqual({ sender_trust: 'seen', injection_risk: 'none', quarantined: false });

    const code = await reply(pool, agent, inbound, transport, { text: '482913' });
    expect(code.status).toBe(200);
    expect(code.reasons).toEqual(['auto_approve_verification_sender']);

    const sentence = await reply(pool, agent, inbound, transport, { text: '네 확인했습니다. 코드는 482913 입니다' });
    expect(sentence.status).toBe(202);
    expect(transport.calls()).toBe(1);
  });

  it('★ 표시 없는(unknown) 발신자에게는 코드 회신도 승인 대기 — sender_trust >= seen 이 전제다', async () => {
    const pool = testPool();
    const agent = await seedAgent(pool, { auto_approve_verification_senders: true });
    const transport = countingTransport();
    const inbound = await receive(pool, agent, `noreply-${randomBytes(4).toString('hex')}@service.example`);

    const code = await reply(pool, agent, inbound, transport, { text: '482913' });
    expect(code.status).toBe(202);
    expect(transport.calls()).toBe(0);
  });
});
