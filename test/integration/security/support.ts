/**
 * test/integration/security/support.ts — 인젝션 구조 방어(ADR-0016)를 **운영과 같은 구현**으로 끝에서 끝까지 돌리는 지반.
 *
 * 수신 소비자(복사 지문) → 읽기 라우트(노출 · 코드 지문) → 발송 라우트(발신 DLP) → 관문(위험 신호 로더 → Stage 7 위험 보류) → 승인(once) → 릴리스.
 * 가짜는 객체 저장소(디스크)·전송단(세기만)·시계 오프셋뿐이다 — 위험 신호·DLP·노출은 Postgres 구현(`*-store.ts`)이다.
 */

import { createPostgresMessageStateStore } from '../../../src/db/repositories/message-state-store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { expect } from 'vitest';

import { createInMemoryContentStore, type MessageContentStore } from '../../../src/api/content-store';
import type { ApiRequest, ApiResponse } from '../../../src/api/http';
import type { AttachmentRouteDependencies } from '../../../src/api/inbound-view';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { handleForward } from '../../../src/api/routes/forward';
import { handleGetInboundMessage } from '../../../src/api/routes/inbound-messages';
import { handleReply } from '../../../src/api/routes/reply';
import { handleSend } from '../../../src/api/routes/send';
import { handleGetVerificationCode } from '../../../src/api/routes/verification-code';
import { handleCreateScheduledMessage } from '../../../src/api/routes/scheduled-messages';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { runScheduledSenderTick, type ScheduledTickResult } from '../../../src/workers/scheduled-sender';
import { createPostgresAgentTokenStore, createPostgresApprovalStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresDlpSignalStore } from '../../../src/db/repositories/dlp-signal-store';
import { createPostgresExposureRecorder, type ExposureRecorder } from '../../../src/db/repositories/exposure-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresPdfParseSlots } from '../../../src/db/repositories/pdf-parse-slots';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { createPostgresRiskSignalSource } from '../../../src/db/repositories/risk-signal-store';
import type { ApprovalStore } from '../../../src/approval/service';
import type { InboundMessageRow, OutboundMode } from '../../../src/db/schema';
import { issueAgentToken } from '../../../src/identity/agent-token';
import type { RiskHoldMode } from '../../../src/policy/risk-signals';
import { RISK_HOLD_REASONS } from '../../../src/policy/rules/risk-hold';
import { createInboundArtifactReader, createInboundAttachmentReader } from '../../../src/storage/inbound-artifact-store';
import { createLocalDownloadSigner, createLocalObjectStore } from '../../../src/storage/local-object-store';
import type { ObjectStore } from '../../../src/storage/object-store';
import type { InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import { provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, deliver, eml, newSesMessageId } from '../inbound/support';
import { countingTransport, type CountingTransport } from '../outbound/support/fakes';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export interface World {
  readonly pool: Pool;
  readonly fixture: Fixture;
  readonly token: string;
  readonly transport: CountingTransport;
  readonly content: MessageContentStore;
  readonly objects: ObjectStore;
  readonly consumer: InboundConsumerDependencies;
  readonly read: AttachmentRouteDependencies;
  readonly service: OutboundServiceDependencies;
  readonly approvals: ApprovalStore;
  /** 발송 시계 오프셋(ms) — 노출 시각은 DB `now()` 이고, 창은 관문의 `request.now` 로 센다. */
  readonly clock: { offsetMs: number };
}

export interface WorldOptions {
  readonly mode?: OutboundMode;
  readonly allowlist?: readonly string[];
  readonly riskMode?: RiskHoldMode;
  /** 읽기 라우트의 노출 기록기 — 기본은 Postgres 구현. fail closed 시험이 던지는 것으로 바꾼다. */
  readonly exposures?: ExposureRecorder;
}

/** 정책 모드 바꾸기 — 새 버전 행(목록은 버전 1 스냅샷 그대로) + current_version 전진. 소유자 롤. */
export async function setOutboundMode(agentId: string, mode: OutboundMode): Promise<void> {
  const owner = provisioningPool();
  const current = await owner.query<{ limits: unknown; config_json: unknown; current_version: number }>(
    'SELECT limits, config_json, current_version FROM agent_policies WHERE agent_id = $1',
    [agentId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new Error('정책 없음');
  const next = row.current_version + 1;
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
       SELECT $1, $2, $3, $4::jsonb || jsonb_build_object('contact_rules', v.snapshot -> 'contact_rules')
         FROM policy_versions v WHERE v.agent_id = $1 AND v.version = $5`,
      [agentId, next, mode, JSON.stringify({ outbound_mode: mode, limits: row.limits, config_json: row.config_json }), row.current_version],
    );
    await client.query('UPDATE agent_policies SET outbound_mode = $2, current_version = $3 WHERE agent_id = $1', [agentId, mode, next]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: options.allowlist ?? ['partner@partner.example'] });
  if (options.mode !== undefined && options.mode !== 'allowlist_only') await setOutboundMode(fixture.agentId, options.mode);
  const issued = issueAgentToken(fixture.agentId);
  const tokens = createPostgresAgentTokenStore(pool);
  await createPostgresAgentTokenStore(provisioningPool()).insert({
    agentId: fixture.agentId,
    tokenHash: issued.tokenHash,
    capabilities: issued.capabilities,
    expiresAt: null,
  });
  const directory = mkdtempSync(join(tmpdir(), 'atmark-inj-'));
  const objects = createLocalObjectStore({ directory, env: {} });
  const gate = createPostgresGateStores(pool);
  const content = createInMemoryContentStore();
  const clock = { offsetMs: 0 };
  const riskMode = options.riskMode ?? 'enforce';
  const service: OutboundServiceDependencies = {
    source: gate.source,
    audit: gate.audit,
    dispatchStore: gate.leases,
    serializer: gate.serializer,
    sendEvidence: gate.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content,
    leaseTtlSeconds: 300,
    riskSignals: createPostgresRiskSignalSource(pool, { mode: riskMode }),
    dlp: { keyring: TEST_DLP_KEYRING, signals: createPostgresDlpSignalStore(pool) },
    now: () => new Date(Date.now() + clock.offsetMs),
  };
  return {
    pool,
    fixture,
    token: issued.plaintext,
    transport: countingTransport(),
    content,
    objects,
    consumer: consumerDeps(pool, objects),
    read: {
      tokens,
      inbound: createPostgresInboundReadStore(pool),
      artifacts: createInboundArtifactReader(objects),
      now: () => new Date(),
      exposures: options.exposures ?? createPostgresExposureRecorder(pool, { keyring: TEST_DLP_KEYRING }),
      riskHoldMode: riskMode,
      messageState: createPostgresMessageStateStore(pool),
      signer: createLocalDownloadSigner({ directory, env: {} }),
      contents: createInboundAttachmentReader(objects),
      pdfSlots: createPostgresPdfParseSlots(pool),
    },
    service,
    approvals: createPostgresApprovalStore(pool),
    clock,
  };
}

export interface MailOptions {
  readonly from: string;
  readonly subject?: string;
  readonly text: string;
  readonly html?: string;
  /** 기본 true — DMARC PASS + 그 From 이 SES 가 판정한 From. false 면 DMARC FAIL. */
  readonly authenticated?: boolean;
  readonly cc?: readonly string[];
  readonly to?: readonly string[];
  readonly inReplyTo?: string;
  readonly attachment?: { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array };
  readonly replyTo?: string;
  readonly messageId?: string;
}

/** 받은 메일 한 통(실제 수신 소비자). 행을 돌려준다. */
export async function receive(w: World, options: MailOptions): Promise<InboundMessageRow> {
  const sesMessageId = newSesMessageId();
  const authenticated = options.authenticated ?? true;
  const to = options.to ?? [w.fixture.address];
  await deliver(
    w.consumer,
    eml({
      from: options.from,
      to: to.join(', '),
      subject: options.subject ?? 'hello',
      text: options.text,
      ...(options.html === undefined ? {} : { html: options.html }),
      ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
      ...(options.attachment === undefined ? {} : { attachment: options.attachment }),
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      extraHeaders: [...(options.cc === undefined ? [] : [`Cc: ${options.cc.join(', ')}`]), ...(options.replyTo === undefined ? [] : [`Reply-To: ${options.replyTo}`])],
    }),
    {
      sesMessageId,
      recipients: [w.fixture.address],
      commonFrom: [options.from],
      dmarc: authenticated ? 'PASS' : 'FAIL',
      receivedAt: new Date().toISOString(),
    },
  );
  const result = await w.pool.query<InboundMessageRow>('SELECT * FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [
    w.fixture.agentId,
    sesMessageId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('행이 없다');
  expect(row.from_authenticated).toBe(authenticated);
  return row;
}

export function auth(w: World, query: Record<string, string> = {}): ApiRequest {
  return { headers: { authorization: `Bearer ${w.token}` }, query, body: null };
}

/** 받은 메일 상세를 읽는다(노출 기록). */
export async function readDetail(w: World, inboundMessageId: string): Promise<ApiResponse> {
  return handleGetInboundMessage(w.read, auth(w), { inboundMessageId });
}

/** 인증 코드 조회(확정 모드) — 코드 지문이 남는다. */
export async function readCode(w: World, senderDomain: string): Promise<ApiResponse> {
  return handleGetVerificationCode(w.read, auth(w, { agent_id: w.fixture.agentId, sender_domain: senderDomain }));
}

let keySeq = 0;
function key(prefix: string): string {
  keySeq += 1;
  return `${prefix}-${String(Date.now())}-${String(keySeq)}`;
}

export interface SendOptions {
  readonly to: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
}

export async function send(w: World, options: SendOptions): Promise<ApiResponse> {
  return handleSend(
    { tokens: w.read.tokens, service: w.service, transport: w.transport },
    {
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': key('send') },
      query: {},
      body: {
        agent_id: w.fixture.agentId,
        from: w.fixture.address,
        to: [...options.to],
        subject: options.subject ?? '안부',
        text: options.text ?? '안녕하세요.',
        ...(options.html === undefined ? {} : { html: options.html }),
      },
    },
  );
}

export async function reply(w: World, inbound: InboundMessageRow, options: { readonly text: string; readonly to?: readonly string[] }): Promise<ApiResponse> {
  return handleReply(
    { tokens: w.read.tokens, service: w.service, transport: w.transport, replyTargets: createPostgresReplyTargetLookup(w.pool), artifacts: w.read.artifacts },
    {
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': key('reply') },
      query: {},
      body: {
        agent_id: w.fixture.agentId,
        in_reply_to: inbound.id,
        text: options.text,
        ...(options.to === undefined ? {} : { to: [...options.to] }),
      },
    },
    { threadId: inbound.thread_id },
  );
}

export async function forward(w: World, inbound: InboundMessageRow, to: readonly string[]): Promise<ApiResponse> {
  return handleForward(
    { tokens: w.read.tokens, service: w.service, transport: w.transport, inbound: w.read.inbound, artifacts: w.read.artifacts },
    {
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': key('fwd') },
      query: {},
      body: { agent_id: w.fixture.agentId, from: w.fixture.address, to: [...to], text: '참고하세요.' },
    },
    { inboundMessageId: inbound.id },
  );
}

/** 응답의 발송 행 → 그 audit 행의 판정·사유(내부 사유 — 공개 코드가 아니다). */
export async function auditOf(w: World, response: ApiResponse): Promise<{ readonly decision: string; readonly reasons: string[] }> {
  const messageId = response.body['message_id'];
  expect(typeof messageId, JSON.stringify(response.body)).toBe('string');
  const rows = await w.pool.query<{ decision: string; reasons: string[] }>(
    'SELECT decision, reasons FROM audit_logs WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1',
    [messageId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('audit 행이 없다');
  return row;
}

/** `messages.outbound_dlp`. */
export async function outboundDlpOf(w: World, response: ApiResponse): Promise<string[] | null> {
  const rows = await w.pool.query<{ outbound_dlp: string[] | null }>('SELECT outbound_dlp FROM messages WHERE id = $1', [response.body['message_id']]);
  return rows.rows[0]?.outbound_dlp ?? null;
}

/** 위험 보류 사유(내부) — audit 사유 중 `RISK_HOLD_REASONS`(tainted_context · dlp_*) + reply_only_risk_hold. */
const RISK_REASONS: ReadonlySet<string> = new Set<string>([...RISK_HOLD_REASONS, 'reply_only_risk_hold']);

export function riskReasonsOf(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => RISK_REASONS.has(reason));
}

/** 예약 발송 만들기(ADR-0016 리뷰 H1 — 만들 때 위험을 고정한다). 라우트의 시계는 발송 서비스 시계와 같다. */
export async function schedule(w: World, options: SendOptions & { readonly sendAt: Date }): Promise<ApiResponse> {
  return handleCreateScheduledMessage(
    {
      tokens: w.read.tokens,
      schedules: createPostgresScheduledSendStore(w.pool),
      content: createScheduledContentStore(w.objects),
      now: w.service.now,
      risk: w.service,
    },
    {
      headers: { authorization: `Bearer ${w.token}`, 'idempotency-key': key('sched') },
      query: {},
      body: {
        agent_id: w.fixture.agentId,
        from: w.fixture.address,
        to: [...options.to],
        subject: options.subject ?? '예약',
        text: options.text ?? '안녕하세요.',
        send_at: options.sendAt.toISOString(),
      },
    },
  );
}

/** 예약 발송 틱 — 이 에이전트의 예약만. 시계는 발송 서비스 시계. */
export function tick(w: World): Promise<readonly ScheduledTickResult[]> {
  return runScheduledSenderTick({
    service: w.service,
    transport: w.transport,
    schedules: createPostgresScheduledSendStore(w.pool),
    content: createScheduledContentStore(w.objects),
    leaseSeconds: 60,
    onlyAgentId: w.fixture.agentId,
  });
}
