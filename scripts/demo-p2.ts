/**
 * `pnpm demo:p2` — 계획 §6 P2 의 demo.
 *
 *   ***"신규 상대 첫 연락 → 소유자 메일함에 승인 링크 도착 → 클릭 → 발송 →
 *      같은 상대 2번째 발송은 승인 없이 통과."***
 *
 * 각 장면이 명제를 세우고, **명제가 거짓이면 exit 1** 이다(`demo-p1c`·`demo-p3` 와 같은 규율).
 *
 * **정책 v2(ADR-0007, 2026-09-24) 이후 이 데모의 승인 장면은 레거시다.** 새 에이전트의 기본은 발신 화이트리스트(빈 목록)·
 * 수신 전체이고, 목록 밖은 승인 없이 막힌다. 승인 흐름(엔진 분기·링크·릴리스)은 **동면 상태로 남았고** — 소유자 롤이 모드를
 * 명시해 만든 레거시 에이전트(`approval_required`)에서만 돈다. 장면 ②~⑩ 은 그 에이전트로 레거시 흐름이 여전히 옳게 도는지를
 * 보인다(회귀 방지). 콘솔·API·CLI 로는 이 모드를 고를 수 없다(`legacy_mode_rejected`).
 *
 * 장면:
 *   ①  AC-a1(v2 재정의) — 모드를 적지 않은 신규 에이전트는 발신 `allowlist_only`(빈 목록)·수신 `all` 이고, 목록 밖은 승인 없이 거부.
 *   ②  AC-a2(레거시) — seed 로의 첫 발송은 승인 없이 나간다(`seed_relationship`).
 *   ③  AC-d1 — 신규 상대 → `202 pending_approval` + `approval_id`, SES 0. 핸들러 응답 시간 p95 ≤ 200ms.
 *   ④  소유자 알림 — outbox 1행 → 1통, 본문에 매직링크, 에이전트가 제목에 심은 URL 은 무력화.
 *   ⑤  매직링크 — GET 은 아무것도 안 바꾼다 → 미리보기 → 결정 → 릴리스 → SES 1, audit 는 같은 행 갱신.
 *   ⑥  AC-d2 — 같은 상대 5턴 → ApprovalRequest 1개.
 *   ⑦  AC-d3 — TTL 만료 → `expired`, SES 0, `approval.expired` 웹훅 1개.
 *   ⑧  AC-d5 — `domain` 스코프는 `confirm_scope=domain` 없이 400.
 *   ⑨  AC-b1·b2 — 전환 공지 20명 → 요청 1개, 승인 후 **기본 한도(분당 5)** 로 시계를 흘려 20통 전부.
 *   ⑩  AC-d4 — 워크로드 1(가입 → 확인 메일 → 코드 회신). **현 설계에서 성립하지 않는다** — 장면이 그것을 보인다.
 *
 * ---
 *
 * **AC-d4 는 초록으로 세지 않는다.** 계획의 문장("ApprovalRequest 개수 = 0")은 r3 에서 스레드 회신
 * 자동 승인이 "에이전트가 시작한 스레드" 로 좁혀지기 **전**의 문장이다. 지금은 외부인(서비스)이 시작한
 * 스레드의 코드 회신이 `auto_approve_verification_senders`(기본 OFF, **GATE 중 OFF**) 없이는 승인을 탄다.
 * 장면 ⑩ 은 그 사실(요청 1개), 그 대가의 상한(서비스당 1회 — 두 번째 코드 회신은 standing approval),
 * 그리고 AC-d4 를 0 으로 만드는 유일한 문(스위치 ON + `sender:mark seen`)을 차례로 보인다. 판정 절은
 * AC-d4 를 **불성립(의도된 트레이드오프)** 으로 따로 적는다.
 *
 * ---
 *
 * **실제 SES·S3 를 부르지 않는다.** 에이전트 메일의 전송단은 이 파일의 드라이런(본문을 읽고 세기만 한다),
 * 소유자 알림의 SES 호출면은 호출을 기록만 하는 가짜, 객체 저장소는 로컬 디렉터리, SES 수신 알림은 합성
 * JSON 이다. 실발송 분기는 **없다.** 매직링크·웹훅 키는 실행마다 새로 만들고 출력하지 않는다.
 *
 * **전역 워커를 돌리지 않는다.** TTL 스위퍼(`sweepExpiredRequests`)·알림 배출(`runApprovalNotifier`)·
 * 릴리스 스윕은 테이블 전체를 집는다 — 같은 DB 의 다른 행(테스트·검증자)을 건드리지 않도록 항목 경로
 * (`expireRequest`·`notifier.notify(id)`·`runApprovalRelease(id)`)만 쓴다. 판정은 같은 코드다.
 *
 * 환경: `DATABASE_URL`(앱 롤). 장면 ⑩-c 는 `TEST_MIGRATION_DATABASE_URL`(또는 `DATABASE_MIGRATION_URL`,
 * 소유자 롤)이 있어야 돈다 — seen 표시를 **운영자 CLI `pnpm sender:mark` 를 그대로 실행해서** 만든다(그 CLI 가
 * `recordSenderMark` 의 유일한 호출자다 — `test/arch/sender-marks-surface.arch.test.ts`). 없으면 그 한 칸만 ⏸.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import type { Pool } from 'pg';

import { createPostgresContactIntake } from '../src/contact/contact-store';
import { createInMemoryContentStore, type MessageContentReader } from '../src/api/content-store';
import type { ApiRequest, ApiResponse } from '../src/api/http';
import type { OutboundServiceDependencies } from '../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../src/api/outbound-store';
import { createPostgresProvisioningStore } from '../src/api/provisioning-store';
import { handleGetAgentPolicy } from '../src/api/routes/agent-policy';
import { handleApprovalLink } from '../src/api/routes/approval-link';
import { handleGetApproval } from '../src/api/routes/approvals';
import { handleReply } from '../src/api/routes/reply';
import { handleSend } from '../src/api/routes/send';
import { handleTransitionAnnouncement } from '../src/api/routes/transition-announcement';
import { createPostgresSeedContactReader } from '../src/api/seed-contact-store';
import { verifyApprovalLinkToken, type ApprovalLinkPorts } from '../src/approval/magic-link';
import { expireRequest, rejectRequest, type ApprovalStore } from '../src/approval/service';
import { createAppPool, createPool } from '../src/db/client';
import { createPostgresInboundWatchSource } from '../src/db/repositories/watch-settings-store';
import { createPostgresAgentSignupStore } from '../src/db/repositories/agent-signup-store';
import {
  createPostgresAgentTokenStore,
  createPostgresApprovalStore,
  createPostgresGateStores,
  createPostgresInboundPolicySource,
  createPostgresInboundStore,
  createPostgresPolicySource,
  createPostgresReplyTargetLookup,
  createPostgresThreadLookup,
  createPostgresTrustFacts,
} from '../src/db/repositories';
import { createPostgresApprovalLinkPorts, magicLinkDecider } from '../src/db/repositories/approval-link-use-store';
import { insertWebhookEndpoint } from '../src/db/repositories/webhook-store';
import type { AgentId, OutboundMode } from '../src/db/schema';
import { provisionAgent } from '../src/identity/provisioning';
import { createApprovalNotifier, type ApprovalNotifier, type ApprovalNotifierDependencies } from '../src/notify/approval-notifier';
import { setLogSink } from '../src/observability/logger';
import { createLocalDevKeyCustody } from '../src/passport/custody-local';
import type { OutboundTransport, TransportRequest } from '../src/policy/gate';
import { parseHmacKeyring, type HmacKeyring } from '../src/security/hmac-keyring';
import { createInboundArtifactStore } from '../src/storage/inbound-artifact-store';
import { createLocalObjectStore } from '../src/storage/local-object-store';
import { createRawMailStore } from '../src/storage/raw-mail-store';
import { consumeInboundMail, type InboundConsumerDependencies } from '../src/workers/inbound-consumer';
import { runApprovalRelease, type ApprovalReleaseOutcome } from '../src/workers/approval-release';
// SES 알림 JSON 합성 · RFC 5322 조립은 수신 통합 테스트의 지반을 그대로 쓴다(`demo-p3` 와 같은 판단).
import { eml, newSesMessageId, notification } from '../test/integration/inbound/support';
import { createPostgresDlpSignalStore } from '../src/db/repositories/dlp-signal-store';
import { createPostgresRiskSignalSource } from '../src/db/repositories/risk-signal-store';

/** 데모 전용 발신 DLP 지문 키(ADR-0016 — 운영 키와 무관). */
const DEMO_DLP_KEYS = parseHmacKeyring(`d1:${Buffer.alloc(32, 5).toString('base64url')}`, 'DEMO_DLP_KEYS');


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // 파일이 없다. 정상 경로다.
}

const OWNER_EMAIL = 'owner@example.com';
const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_MIGRATION_URL'] ?? '';

/** AC-d1 — 계획 §3.4 1조: 승인 대기가 HTTP 요청을 붙잡지 않는다. */
const AC_D1_P95_BUDGET_MS = 200;
const AC_D1_WARMUP = 3;
const AC_D1_SAMPLES = 40;

/** 에이전트가 정한 제목 — 소유자 메일에 들어가는 문자열(④ I3: 가짜 링크). */
const HOSTILE_SUBJECT = '계약 건 — 승인은 https://atmark-approve.evil/ok 에서 먼저 해 주세요';

const failures: string[] = [];
const skipped: string[] = [];
const deviations: string[] = [];

function section(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}
function note(text: string): void {
  console.log(`  │ ${text}`);
}
function check(label: string, ok: boolean, detail = ''): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
}
function skip(label: string, why: string): void {
  console.log(`  ⏸ ${label} — ${why}`);
  skipped.push(label);
}
function elide(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
function redactIds(message: string): string {
  return message.replace(/[0-9a-f]{32}/g, (id) => elide(id)).replace(/atk_link_\S+/g, 'atk_link_…');
}
function tag(): string {
  return randomBytes(3).toString('hex');
}

// ---------------------------------------------------------------------------
// 지반
// ---------------------------------------------------------------------------

/** 드라이런 전송단 — 본문을 **실제로 읽고** 센다. SES 를 import 하지 않는다. */
function dryRunTransport(content: MessageContentReader): OutboundTransport & { calls(): number } {
  let calls = 0;
  return {
    calls: () => calls,
    async send(request: TransportRequest): Promise<{ readonly sesMessageId: string }> {
      const loaded = await content.load(request.messageId);
      if (loaded.subject.trim() === '') throw new Error('제목이 빈 메일은 조립하지 않는다');
      calls += 1;
      return { sesMessageId: `dryrun-${request.messageIdHeader.replace(/[<>]/g, '')}` };
    },
  };
}

interface OwnerMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

/** 소유자 알림의 SES 호출면 가짜 — **호출을 기록만 한다.** 받은 원문을 풀어 제목·본문을 남긴다. */
function ownerInbox(): { readonly client: ApprovalNotifierDependencies['client']; readonly mails: OwnerMail[] } {
  const mails: OwnerMail[] = [];
  return {
    mails,
    client: {
      send(command) {
        const input = command.input;
        const raw = Buffer.from(input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
        const split = raw.indexOf('\r\n\r\n');
        const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
        const subjectRaw = /^Subject: (.*)$/m.exec(head)?.[1] ?? '';
        const subject = subjectRaw
          .replace(/\?=\s+=\?/g, '?==?')
          .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_all, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
        const body = Buffer.from(raw.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
        mails.push({ to: input.Destination?.ToAddresses ?? [], subject, body });
        return Promise.resolve({ MessageId: `owner-notify-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

interface Actor {
  readonly agentId: AgentId;
  readonly address: string;
  readonly token: string;
  readonly name: string;
}

/**
 * `provisioningPool` 은 **소유자 롤**이어야 한다 — `activateAgent`(`UPDATE agents SET status='active'`)가
 * 앱 롤에는 없다(202609230730, ADR-0006 보강).
 */
async function provision(
  provisioningPool: Pool,
  label: string,
  seeds: readonly string[],
  // **레거시 승인 모드가 기본이다(이 데모 한정)** — 정책 v2 의 기본(`null` → allowlist_only)에서는 승인 장면이 생기지 않는다.
  outboundMode: OutboundMode | null = 'approval_required',
): Promise<Actor> {
  const suffix = randomBytes(4).toString('hex');
  const provisioned = await provisionAgent(
    createPostgresProvisioningStore(provisioningPool),
    {
      organization: { kind: 'create', name: `atmark-demo-p2-${label}-${suffix}`, ownerEmail: OWNER_EMAIL },
      agentName: `demo-p2-${label}-${suffix}`,
      addressLocalPart: `demo-p2-${label}-${suffix}`,
      seedContacts: [...seeds],
      monthlyBudgetCents: 10_000,
      createdBy: 'demo:p2',
      tokenCapabilities: null,
      // 레거시 장면은 모드를 명시한다(소유자 롤만 할 수 있다). `null` 은 v2 기본값(장면 ①).
      outboundMode,
    },
    createLocalDevKeyCustody(),
  );
  return {
    agentId: provisioned.agent.id as AgentId,
    address: provisioned.address.address,
    token: provisioned.token.plaintext,
    name: provisioned.agent.name,
  };
}

/**
 * 정책을 한 버전 올린다(`policy_versions` 새 행 + `agent_policies` 포인터). 운영에서 정책을 바꾸는 것과 같은 모양이다.
 * **소유자 롤 풀로 부른다** — 운영에서 정책을 바꾸는 것은 CLI(소유자 롤)·admin 이고, 앱 롤은 두 테이블에 쓰기가 없다
 * (202609230750 — 앱 롤이 정책을 바꿀 수 있으면 api 탈취가 `unrestricted` 로 푼다, 2차 검증 H-A).
 *
 * **TTL 을 상한(7일)으로 올리는 이유:** 같은 DB 를 쓰는 통합 테스트(검증자 실행 포함)가 **전역** TTL 스윕을
 * `now + 24h` 로 돌린다. 기본 TTL(24h)이면 그 스윕이 이 데모의 대기 요청을 장면 도중에 만료시킨다(실측).
 * 테스트 파일들이 같은 이유로 7일을 쓴다. 모드·한도·pre-approval 은 기본값 그대로다 — AC-a1 은 이 변경 **전에** 본다.
 */
const DEMO_TTL_SECONDS = 7 * 24 * 3600;

async function amendPolicy(pool: Pool, agentId: AgentId, patch: Record<string, unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ outbound_mode: string; limits: unknown; config_json: Record<string, unknown>; current_version: number }>(
      'SELECT outbound_mode, limits, config_json, current_version FROM agent_policies WHERE agent_id = $1 FOR UPDATE',
      [agentId],
    );
    const policy = current.rows[0];
    if (policy === undefined) throw new Error('정책 행이 없다');
    const config = { ...policy.config_json, ...patch };
    const version = policy.current_version + 1;
    // 목록은 현재 버전 스냅샷 그대로 싣는다 — 목록을 싣지 않은 버전으로 포인터를 옮기면 커밋되지 않는다(202609241040).
    await client.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot, created_by)
       SELECT $1, $2, $3, $4::jsonb || jsonb_build_object('contact_rules', coalesce(v.snapshot -> 'contact_rules', '[]'::jsonb)), 'demo:p2'
         FROM policy_versions v WHERE v.agent_id = $1 AND v.version = $5`,
      [agentId, version, policy.outbound_mode, JSON.stringify({ outbound_mode: policy.outbound_mode, limits: policy.limits, config_json: config }), policy.current_version],
    );
    await client.query('UPDATE agent_policies SET config_json = $2::jsonb, current_version = $3 WHERE agent_id = $1', [
      agentId,
      JSON.stringify(config),
      version,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 데모 시계 — **실시간 + 오프셋.** 앞으로만 간다. 고정 시각 시계는 DB `now()` 보다 뒤처져 outbox 행(기한 = 트리거의
 * `now()`)을 "아직 때가 아니다" 로 보게 만든다(실측). 한도(분당 5)를 넘기지 않으려고 턴 사이에 시간을 흘릴 때 쓴다.
 */
class DemoClock {
  private offsetMs = 0;
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  advanceTo(at: Date): void {
    this.offsetMs = Math.max(this.offsetMs, at.getTime() - Date.now());
  }
}

/** 한 에이전트의 발송 지반. 시계를 주입한다 — ⑨ 는 시계를 흘린다. */
interface Rig {
  readonly service: OutboundServiceDependencies;
  readonly transport: ReturnType<typeof dryRunTransport>;
  readonly approvals: ApprovalStore;
  readonly tokens: ReturnType<typeof createPostgresAgentTokenStore>;
  readonly now: () => Date;
}

function rigFor(pool: Pool, now: () => Date = () => new Date()): Rig {
  const gate = createPostgresGateStores(pool);
  const content = createInMemoryContentStore();
  return {
    now,
    transport: dryRunTransport(content),
    approvals: createPostgresApprovalStore(pool),
    tokens: createPostgresAgentTokenStore(pool),
    service: {
      source: gate.source,
      audit: gate.audit,
      dispatchStore: gate.leases,
      serializer: gate.serializer,
      sendEvidence: gate.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content,
      leaseTtlSeconds: 300,
      // ADR-0016 — 운영과 같은 Postgres 구현(위험 신호 강제 · 발신 DLP). 워크로드 1 은 보류 0 이어야 한다.
      riskSignals: createPostgresRiskSignalSource(pool, { mode: 'enforce' }),
      dlp: { keyring: DEMO_DLP_KEYS, signals: createPostgresDlpSignalStore(pool) },
      now,
    },
  };
}

function bearer(token: string, body: unknown = null, key: string | null = null): ApiRequest {
  return {
    headers: { authorization: `Bearer ${token}`, ...(key === null ? {} : { 'idempotency-key': key }) },
    query: {},
    body,
  };
}

function send(rig: Rig, actor: Actor, to: string, subject = '업무 연락', text = '안녕하세요.'): Promise<ApiResponse> {
  return handleSend(
    { tokens: rig.tokens, service: rig.service, transport: rig.transport },
    bearer(actor.token, { agent_id: actor.agentId, from: actor.address, to: [to], subject, text }, `demo-p2-${randomUUID()}`),
  );
}

function reasonsOf(response: ApiResponse): string {
  const decision = response.body['decision'] as { reasons?: unknown } | undefined;
  return Array.isArray(decision?.reasons) ? decision.reasons.join(',') : '';
}

async function count(pool: Pool, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await pool.query<{ n: number }>(sql, [...values]);
  return result.rows[0]?.n ?? -1;
}

const requestsOf = (pool: Pool, agentId: string): Promise<number> =>
  count(pool, 'SELECT count(*)::int AS n FROM approval_requests WHERE agent_id = $1', [agentId]);
const auditCountOf = (pool: Pool, agentId: string): Promise<number> =>
  count(pool, 'SELECT count(*)::int AS n FROM audit_logs WHERE agent_id = $1', [agentId]);
const linkUsesOf = (pool: Pool, approvalId: string): Promise<number> =>
  count(pool, 'SELECT count(*)::int AS n FROM approval_link_uses WHERE approval_id = $1', [approvalId]);

async function statusOf(pool: Pool, approvalId: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>('SELECT status FROM approval_requests WHERE id = $1', [approvalId]);
  return result.rows[0]?.status;
}

async function webhookEvents(pool: Pool, agentId: string, eventType: string, approvalId: string): Promise<number> {
  return count(
    pool,
    `SELECT count(*)::int AS n FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE e.agent_id = $1 AND d.event_type = $2 AND d.dedupe_key = $3`,
    [agentId, eventType, `${eventType}:${approvalId}`],
  );
}

/** 소유자 쪽 — 알림기(항목 경로) · 매직링크 포트 · 링크 착지점. 운영 조립과 같은 코드, SES 만 가짜. */
interface Owner {
  readonly inbox: ReturnType<typeof ownerInbox>;
  readonly notifier: ApprovalNotifier;
  readonly ports: ApprovalLinkPorts;
  readonly keyring: HmacKeyring;
  /** `onApproved`(커밋 뒤 깨우기)가 받은 id — 운영에서는 릴리스 잡이 들어가는 자리다. */
  readonly woken: string[];
}

function ownerFor(pool: Pool, keyring: HmacKeyring, now: () => Date = () => new Date()): Owner {
  const inbox = ownerInbox();
  const woken: string[] = [];
  return {
    inbox,
    keyring,
    woken,
    notifier: createApprovalNotifier({ pool, client: inbox.client, keyring, now }),
    ports: createPostgresApprovalLinkPorts(pool, {
      keyring,
      onApproved: (approvalId) => {
        woken.push(approvalId);
        return Promise.resolve();
      },
    }),
  };
}

/** 소유자 메일 본문에서 매직링크 토큰을 꺼낸다(링크는 `https://api.atmark.ai/approve#<token>`). */
function linkTokenIn(mail: OwnerMail | undefined): string | null {
  return /https:\/\/api\.atmark\.ai\/approve#(atk_link_\S+)/.exec(mail?.body ?? '')?.[1] ?? null;
}

function clickLink(owner: Owner, now: () => Date, method: string, form: Record<string, string>) {
  return handleApprovalLink(
    { ports: owner.ports, now },
    { method, contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(form).toString() },
  );
}

/** 알림을 보내게 하고(항목 경로) 그 메일의 링크 토큰을 돌려준다. */
async function notifyOwner(owner: Owner, approvalId: string): Promise<{ outcome: string; mail: OwnerMail | undefined; token: string | null }> {
  const before = owner.inbox.mails.length;
  const outcome = await owner.notifier.notify(approvalId);
  const mail = owner.inbox.mails.length > before ? owner.inbox.mails[owner.inbox.mails.length - 1] : undefined;
  return { outcome, mail, token: linkTokenIn(mail) };
}

function release(rig: Rig, approvalId: string): Promise<readonly ApprovalReleaseOutcome[]> {
  return runApprovalRelease({ service: rig.service, approvals: rig.approvals, transport: rig.transport }, { approvalId, traceId: null });
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

// ---------------------------------------------------------------------------
// 장면 ①② — 기본 모드와 seed
// ---------------------------------------------------------------------------

async function sceneDefaults(pool: Pool, rig: Rig, fresh: Actor, main: Actor, seed: string): Promise<void> {
  section('① AC-a1(정책 v2 재정의, ADR-0007) — 모드를 적지 않고 태어난 에이전트는 발신 화이트리스트(빈 목록) · 수신 전체');
  note('명제: 프로비저닝 요청에 outbound_mode 가 없다. 정책 조회 API 가 allowlist_only · inbound all · 빈 allow 목록을 돌려준다.');
  note('      목록 밖은 승인 요청이 아니라 **거부**다(진윤겸 결정 ①) — 소유자가 콘솔에서 목록을 채운다.');
  const policy = await handleGetAgentPolicy(
    { tokens: rig.tokens, policies: createPostgresPolicySource(pool), inboundPolicies: createPostgresInboundPolicySource(pool), now: rig.now },
    bearer(fresh.token),
    { agentId: fresh.agentId },
  );
  const outbound = policy.body['outbound'] as Record<string, unknown> | undefined;
  const limits = policy.body['limits'] as Record<string, unknown> | undefined;
  check('GET /v1/agents/{id}/policy 200 · outbound_mode = allowlist_only · inbound_mode = all',
    policy.status === 200 && policy.body['outbound_mode'] === 'allowlist_only' && policy.body['inbound_mode'] === 'all',
    `${String(policy.body['outbound_mode'])} / ${String(policy.body['inbound_mode'])}`);
  check('발신 allow 목록이 비었다(새 에이전트는 아무에게도 못 보낸다)',
    Array.isArray(outbound?.['allow']) && (outbound['allow'] as unknown[]).length === 0, JSON.stringify(outbound));
  console.log(`  기본 한도: 분당 ${String(limits?.['per_minute'])} · 시간당 ${String(limits?.['per_hour'])} · 일 ${String(limits?.['per_day'])}`);
  const beforeFresh = rig.transport.calls();
  const denied = await send(rig, fresh, seed, '안녕하세요');
  check('목록 밖 → 403 · reasons = [recipient_not_allowlisted] · 승인 요청 0 · SES 0',
    denied.status === 403 && reasonsOf(denied) === 'recipient_not_allowlisted' &&
      (await requestsOf(pool, fresh.agentId)) === 0 && rig.transport.calls() === beforeFresh,
    `${String(denied.status)} [${reasonsOf(denied)}]`);

  note('이하 ②~⑩ 은 **레거시 승인 모드**(`approval_required` — 소유자 롤로만 생긴다) 에이전트로 동면 중인 승인 흐름을 확인한다.');
  const legacy = await handleGetAgentPolicy(
    { tokens: rig.tokens, policies: createPostgresPolicySource(pool), inboundPolicies: createPostgresInboundPolicySource(pool), now: rig.now },
    bearer(main.token),
    { agentId: main.agentId },
  );
  const preApproval = legacy.body['pre_approval'] as Record<string, unknown> | undefined;
  check('레거시 에이전트: outbound_mode = approval_required · 콘솔 이름 legacy',
    legacy.body['outbound_mode'] === 'approval_required' && (legacy.body['outbound'] as Record<string, unknown> | undefined)?.['mode'] === 'legacy',
    String(legacy.body['outbound_mode']));
  check('auto_approve_verification_senders 기본 false', preApproval?.['auto_approve_verification_senders'] === false);

  section('② AC-a2 — seed 로의 첫 발송은 승인 없이 나간다');
  note('명제: 소유자가 프로비저닝 때 적은 상대(seed)는 같은 트랜잭션에서 관계가 됐다 — 첫 메일부터 묻지 않는다.');
  const before = rig.transport.calls();
  const sent = await send(rig, main, seed, '안녕하세요, 새 주소로 연락드립니다');
  check('200 sent · reasons ∋ seed_relationship', sent.status === 200 && reasonsOf(sent).includes('seed_relationship'),
    `${String(sent.status)} [${reasonsOf(sent)}]`);
  check('SES 1회 · 승인 요청 0개', rig.transport.calls() === before + 1 && (await requestsOf(pool, main.agentId)) === 0);
}

// ---------------------------------------------------------------------------
// 장면 ③ — AC-d1
// ---------------------------------------------------------------------------

async function sceneFirstContact(
  pool: Pool,
  provisioningPool: Pool,
  rig: Rig,
  owner: Owner,
  main: Actor,
  partner: string,
): Promise<{ approvalId: string; messageId: string } | null> {
  section('③ AC-d1 — 신규 상대 첫 연락은 202 로 즉시 돌아온다(승인은 요청을 붙잡지 않는다)');
  note('명제: 처음 보는 상대 → 202 pending_approval + approval_id, SES 0. 핸들러 응답 시간 p95 ≤ 200ms.');
  note('      측정 범위: 이 프로세스의 라우트 핸들러 + 로컬 Postgres. API Gateway·Lambda 콜드스타트·네트워크는 밖이다');
  note('      — 운영 수치는 배포 뒤 `pnpm smoke:prod` 가 본다. 여기서 보는 것은 "승인 대기가 요청 경로에 대기를 넣지 않는다" 이다.');

  const before = rig.transport.calls();
  const started = performance.now();
  const first = await send(rig, main, partner, HOSTILE_SUBJECT, '계약서 초안을 보내드립니다.');
  const elapsed = performance.now() - started;
  const approvalId = String(first.body['approval_id'] ?? '');
  check('202 pending_approval · approval_id 가 있다', first.status === 202 && first.body['status'] === 'pending_approval' && approvalId !== '',
    `${String(first.status)} ${elide(approvalId)} · ${elapsed.toFixed(1)}ms`);
  check('reasons = new_recipient · SES 0회', reasonsOf(first) === 'new_recipient' && rig.transport.calls() === before);
  if (approvalId === '') return null;

  // p95 — 별도 에이전트로 신규 상대 N명에게 한 통씩(같은 에이전트에 쌓으면 ⑥의 "요청 1개" 가 흐려진다).
  const probe = await provision(provisioningPool, 'latency', []);
  await amendPolicy(provisioningPool, probe.agentId, { approval_ttl_seconds: DEMO_TTL_SECONDS });
  const probeRig = rigFor(pool);
  const samples: number[] = [];
  const opened: string[] = [];
  let all202 = true;
  for (let i = 0; i < AC_D1_WARMUP + AC_D1_SAMPLES; i += 1) {
    const t0 = performance.now();
    const response = await send(probeRig, probe, `new-${String(i)}-${tag()}@stranger-${tag()}.example`);
    const ms = performance.now() - t0;
    if (response.status !== 202) all202 = false;
    if (typeof response.body['approval_id'] === 'string') opened.push(response.body['approval_id']);
    if (i >= AC_D1_WARMUP) samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const max = samples[samples.length - 1] ?? Number.NaN;
  console.log(`  측정: 표본 ${String(samples.length)}(워밍업 ${String(AC_D1_WARMUP)} 제외) · p50 ${p50.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms · max ${max.toFixed(1)}ms`);
  check(`AC-d1 p95 ≤ ${String(AC_D1_P95_BUDGET_MS)}ms`, p95 <= AC_D1_P95_BUDGET_MS, `${p95.toFixed(1)}ms`);
  check('표본 전부 202 · SES 0회', all202 && probeRig.transport.calls() === 0);
  // 정리 — 표본 요청을 거절하고 알림 행을 닫는다(거절된 요청의 알림은 `obsolete` 로 닫히고 메일은 없다). 남겨 두면
  // 같은 DB 의 알림 워커(테스트·검증자)가 기한 된 행 수십 개를 먼저 집는다. 발송은 없다.
  const mailsBefore = owner.inbox.mails.length;
  let settled = 0;
  for (const id of opened) {
    await rejectRequest(probeRig.approvals, { approvalId: id, decidedBy: 'demo:p2-cleanup', now: new Date() });
    if ((await owner.notifier.notify(id)) !== 'sent') settled += 1;
  }
  check('정리: 표본 요청 거절 · 알림 행은 메일 없이 닫힘', settled === opened.length && owner.inbox.mails.length === mailsBefore,
    `${String(settled)}/${String(opened.length)}`);

  const message = await pool.query<{ message_id: string }>('SELECT message_id FROM approval_request_items WHERE approval_id = $1', [approvalId]);
  return { approvalId, messageId: message.rows[0]?.message_id ?? '' };
}

// ---------------------------------------------------------------------------
// 장면 ④⑤ — 소유자 알림 · 매직링크 · 릴리스
// ---------------------------------------------------------------------------

async function sceneOwnerMail(pool: Pool, owner: Owner, approvalId: string): Promise<string | null> {
  section('④ 소유자 메일함에 승인 링크가 도착한다 — 에이전트가 쓴 문자열은 무력화된 채로');
  note('명제: 요청과 같은 트랜잭션에서 outbox 1행이 생겼고, 알림기가 소유자(organizations.owner_email)에게 1통 보낸다.');
  note('      본문의 누를 수 있는 URL 은 Atmark 링크 하나 — 에이전트가 제목에 심은 URL 은 hxxps[:]// 로 꺾인다.');

  const outbox = await count(pool, 'SELECT count(*)::int AS n FROM approval_notifications WHERE approval_id = $1', [approvalId]);
  check('outbox 에 알림 1행(요청 트랜잭션의 트리거)', outbox === 1, String(outbox));

  const { outcome, mail, token } = await notifyOwner(owner, approvalId);
  check('알림기 결말 sent · 소유자 메일 1통 · 수신자 = owner_email', outcome === 'sent' && mail !== undefined && mail.to.join() === OWNER_EMAIL,
    `${outcome} → ${mail?.to.join() ?? '—'}`);
  const again = await owner.notifier.notify(approvalId);
  check('같은 요청을 다시 알려도 두 번째 메일은 없다(요청당 1통)', again !== 'sent' && owner.inbox.mails.length === 1, again);
  if (mail === undefined) return null;

  console.log(`  제목: ${mail.subject}`);
  for (const line of mail.body.split('\n').filter((l) => l.startsWith('│') || l.startsWith('┌'))) console.log(`    ${redactIds(line)}`);
  check('본문에 매직링크(https://api.atmark.ai/approve#atk_link_…)가 있고 서명이 검증된다',
    token !== null && verifyApprovalLinkToken(owner.keyring, token, new Date()).kind === 'valid');
  check('에이전트가 심은 URL 은 무력화됐다(hxxps[:]//atmark-approve[.]evil)',
    mail.body.includes('hxxps[:]//atmark-approve[.]evil/ok') && !mail.body.includes('https://atmark-approve.evil'));
  const urls = mail.body.match(/https?:\/\/\S+/g) ?? [];
  check('본문의 살아 있는 URL 은 Atmark 링크 하나뿐', urls.length === 1 && urls[0]?.startsWith('https://api.atmark.ai/approve#') === true,
    `${String(urls.length)}개`);
  check('알림 제목에 에이전트 값이 없다(고정 문구 + 요청 id 앞 8자)',
    mail.subject === `[Atmark] 발송 승인 요청 · Approval request ${approvalId.slice(0, 8)}`, mail.subject);
  return token;
}

async function sceneClick(
  pool: Pool,
  rig: Rig,
  owner: Owner,
  main: Actor,
  partner: string,
  opened: { approvalId: string; messageId: string },
  token: string,
): Promise<void> {
  section('⑤ 클릭 → 발송 — GET 은 아무것도 안 바꾸고, 결정은 POST 한 번, 보내는 것은 릴리스(관문 재통과)');
  note('명제: 링크 GET·HEAD(메일 스캐너의 선조회 포함)는 사용 기록·요청 상태·웹훅 어느 것도 바꾸지 않는다.');
  note('      미리보기도 사용을 소비하지 않는다. 결정 POST 는 승인만 하고 보내지 않는다 — 보내는 것은 릴리스이고');
  note('      SES 는 그때 1회. audit 는 새 행을 만들지 않고 pending_approval 행 **그 자체**를 allowed/sent 로 갱신한다.');
  const { approvalId } = opened;
  const auditBefore = await auditCountOf(pool, main.agentId);
  const sesBefore = rig.transport.calls();

  const statuses: number[] = [];
  for (const method of ['GET', 'HEAD', 'GET']) statuses.push((await clickLink(owner, rig.now, method, { token, decision: 'approve' })).status);
  check('GET·HEAD·GET 전부 200 — 사용 0 · 상태 pending · approval.resolved 0',
    statuses.every((s) => s === 200) && (await linkUsesOf(pool, approvalId)) === 0 &&
      (await statusOf(pool, approvalId)) === 'pending' && (await webhookEvents(pool, main.agentId, 'approval.resolved', approvalId)) === 0,
    statuses.join('/'));

  const preview = await clickLink(owner, rig.now, 'POST', { intent: 'preview', token });
  const previewBody = preview.status === 200 ? (JSON.parse(preview.body) as { approval?: { recipients?: unknown } }) : {};
  check('미리보기 200 — 수신자가 보인다 · 사용 0 · 여전히 pending',
    preview.status === 200 && JSON.stringify(previewBody.approval?.recipients) === JSON.stringify([partner]) &&
      (await linkUsesOf(pool, approvalId)) === 0 && (await statusOf(pool, approvalId)) === 'pending');

  const decided = await clickLink(owner, rig.now, 'POST', { token, decision: 'approve' });
  check('결정 POST 200 → approved · 사용 1 · 이 시점 SES 는 아직 0',
    decided.status === 200 && (await statusOf(pool, approvalId)) === 'approved' && (await linkUsesOf(pool, approvalId)) === 1 &&
      rig.transport.calls() === sesBefore);
  const replay = await clickLink(owner, rig.now, 'POST', { token, decision: 'approve' });
  check('같은 링크의 두 번째 결정은 409 · 깨우기는 1회', replay.status === 409 && owner.woken.filter((id) => id === approvalId).length === 1,
    String(replay.status));

  const released = await release(rig, approvalId);
  check('릴리스(관문 재통과) → sent · SES 1회', released.map((o) => o.kind).join() === 'sent' && rig.transport.calls() === sesBefore + 1,
    released.map((o) => o.kind).join());

  const row = await pool.query<{ decision: string; reasons: string[]; approved_by: string | null; resolution_reason: string | null }>(
    'SELECT decision, reasons, approved_by, resolution_reason FROM audit_logs WHERE approval_id = $1',
    [approvalId],
  );
  check('audit 행 수 불변 — 같은 행이 갱신됐다', (await auditCountOf(pool, main.agentId)) === auditBefore && row.rowCount === 1,
    `${String(auditBefore)} → ${String(await auditCountOf(pool, main.agentId))}`);
  const r = row.rows[0];
  check('그 행: allowed · reasons=[new_recipient](불변) · approved_by=magic_link:k1 · resolution=sent',
    r?.decision === 'allowed' && r.reasons.join() === 'new_recipient' && r.approved_by === magicLinkDecider('k1') && r.resolution_reason === 'sent',
    `${String(r?.decision)} [${String(r?.reasons.join())}] ${String(r?.approved_by)} ${String(r?.resolution_reason)}`);
  check('approval.resolved 웹훅 1행(outbox)', (await webhookEvents(pool, main.agentId, 'approval.resolved', approvalId)) === 1);

  const view = await handleGetApproval({ tokens: rig.tokens, approvals: rig.approvals, now: rig.now }, bearer(main.token), { approvalId });
  check('GET /v1/approvals/{id} — approved · granted_scope=recipient · message_ids=[원래 그 메일]',
    view.status === 200 && view.body['status'] === 'approved' && view.body['granted_scope'] === 'recipient' &&
      JSON.stringify(view.body['message_ids']) === JSON.stringify([opened.messageId]));
}

// ---------------------------------------------------------------------------
// 장면 ⑥ — AC-d2
// ---------------------------------------------------------------------------

async function sceneSecondContact(pool: Pool, rig: Rig, clock: DemoClock, main: Actor, partner: string): Promise<void> {
  section('⑥ AC-d2 — 같은 상대의 2번째부터는 승인 없이 즉시 (5턴에 요청 1개)');
  note('명제: 승인은 메시지당이 아니라 상대방당 비용이다. 턴 2~5 는 standing approval 로 200.');
  note('      턴 사이에 시계를 61초 흘린다 — 기본 한도가 분당 5 이고(한 분에 6번째는 403 rate_limit_per_minute 이 정상),');
  note('      이 장면이 보는 것은 한도가 아니라 승인 횟수다.');
  const before = rig.transport.calls();
  const results: string[] = [];
  for (let turn = 2; turn <= 5; turn += 1) {
    clock.advance(61_000);
    const response = await send(rig, main, partner, `Re: 계약 건 (${String(turn)})`, `${String(turn)}번째 연락입니다.`);
    results.push(`${String(response.status)}[${reasonsOf(response)}]`);
  }
  check('턴 2~5 전부 200 · reasons=[standing_approval]', results.every((r) => r === '200[standing_approval]'), results.join(' '));
  check('SES +4', rig.transport.calls() === before + 4);
  const requests = await count(
    pool,
    `SELECT count(DISTINCT r.id)::int AS n FROM approval_requests r JOIN approval_request_items i ON i.approval_id = r.id
      WHERE r.agent_id = $1 AND $2 = ANY(i.recipients)`,
    [main.agentId, partner],
  );
  check('★ AC-d2 — 이 상대와의 5턴에 ApprovalRequest = 1', requests === 1, String(requests));
}

// ---------------------------------------------------------------------------
// 장면 ⑦ — AC-d3
// ---------------------------------------------------------------------------

async function sceneExpiry(pool: Pool, rig: Rig, clock: DemoClock, owner: Owner, main: Actor): Promise<void> {
  clock.advance(61_000);
  section('⑦ AC-d3 — 아무도 결정하지 않으면 만료되고, 만료는 절대 보내지 않는다');
  note('명제: TTL 이 지나면 expired · SES 0 · approval.expired 웹훅 정확히 1개(스위퍼가 두 번 돌아도).');
  note('      시계: 이 요청의 expires_at + 1초로 스위퍼의 **항목 경로**(expireRequest)를 부른다 — 전역 스윕은 같은 DB 의');
  note('      다른 대기 요청까지 만료시키므로 쓰지 않는다. 판정 코드는 같다.');
  const before = rig.transport.calls();
  const response = await send(rig, main, `nobody-${tag()}@late-${tag()}.example`, '회신 부탁드립니다');
  const approvalId = String(response.body['approval_id'] ?? '');
  const expiresAt = new Date(String(response.body['expires_at'] ?? ''));
  if (!check('202 pending_approval', response.status === 202 && approvalId !== '')) return;

  const early = await expireRequest(rig.approvals, approvalId, new Date(expiresAt.getTime() - 60_000));
  check('TTL 1분 전의 스윕은 만료시키지 않는다', !early && (await statusOf(pool, approvalId)) === 'pending');
  const late = new Date(expiresAt.getTime() + 1000);
  const first = await expireRequest(rig.approvals, approvalId, late);
  const second = await expireRequest(rig.approvals, approvalId, late);
  check('TTL 뒤 첫 스윕 true · 두 번째 false · 상태 expired', first && !second && (await statusOf(pool, approvalId)) === 'expired');
  check('★ approval.expired 웹훅 정확히 1행', (await webhookEvents(pool, main.agentId, 'approval.expired', approvalId)) === 1);

  const released = await release(rig, approvalId);
  const late2 = await owner.notifier.notify(approvalId);
  const row = await pool.query<{ decision: string; resolution_reason: string | null }>(
    'SELECT decision, resolution_reason FROM audit_logs WHERE approval_id = $1',
    [approvalId],
  );
  check('만료 뒤 릴리스는 아무것도 세우지 않는다 · 알림도 안 나간다 · ★ SES 0',
    released.length === 0 && late2 !== 'sent' && rig.transport.calls() === before, `release ${String(released.length)} · notify ${late2}`);
  check('audit: denied / approval_expired', row.rows[0]?.decision === 'denied' && row.rows[0]?.resolution_reason === 'approval_expired');
}

// ---------------------------------------------------------------------------
// 장면 ⑧ — AC-d5
// ---------------------------------------------------------------------------

async function sceneDomainScope(pool: Pool, rig: Rig, clock: DemoClock, owner: Owner, main: Actor): Promise<void> {
  clock.advance(61_000);
  section('⑧ AC-d5 — "이 도메인의 누구든" 은 소유자가 한 번 더 확인해야 한다');
  note('명제: scope=domain 결정이 confirm_scope=domain 없이 오면 400 이고 아무것도 바뀌지 않는다(링크는 산다).');
  const domain = `wide-${tag()}.example`;
  const response = await send(rig, main, `ceo@${domain}`, '제안서 전달');
  const approvalId = String(response.body['approval_id'] ?? '');
  if (!check('202 pending_approval', response.status === 202 && approvalId !== '')) return;
  const { token } = await notifyOwner(owner, approvalId);
  if (!check('소유자 메일에 링크가 왔다', token !== null) || token === null) return;

  const bare = await clickLink(owner, rig.now, 'POST', { token, decision: 'approve', scope: 'domain' });
  const wrong = await clickLink(owner, rig.now, 'POST', { token, decision: 'approve', scope: 'domain', confirm_scope: 'recipient' });
  check('★ confirm_scope 없음 400 · 틀린 confirm_scope 400', bare.status === 400 && wrong.status === 400, `${String(bare.status)}/${String(wrong.status)}`);
  check('아무것도 안 바뀌었다 — 사용 0 · pending · 도메인 관계 0',
    (await linkUsesOf(pool, approvalId)) === 0 && (await statusOf(pool, approvalId)) === 'pending' &&
      (await count(pool, `SELECT count(*)::int AS n FROM sender_relationships WHERE agent_id = $1 AND scope = 'domain'`, [main.agentId])) === 0);

  const confirmed = await clickLink(owner, rig.now, 'POST', { token, decision: 'approve', scope: 'domain', confirm_scope: 'domain' });
  await release(rig, approvalId);
  const other = await send(rig, main, `cfo@${domain}`, '제안서 전달(재무)');
  check('확인하면 200 → 같은 도메인의 다른 사람도 승인 없이 200', confirmed.status === 200 && other.status === 200,
    `${String(confirmed.status)} → ${String(other.status)}[${reasonsOf(other)}]`);
}

// ---------------------------------------------------------------------------
// 장면 ⑨ — AC-b1 · AC-b2
// ---------------------------------------------------------------------------

async function sceneAnnouncement(pool: Pool, provisioningPool: Pool, keyring: HmacKeyring): Promise<void> {
  section('⑨ AC-b1·b2 — 전환 공지 20명: 요청 1개 · 승인 1번 · 기본 한도(분당 5)로 흘러 20통');
  note('명제: seed 20명에게의 공지는 배치 승인 요청 1개(항목 20), 승인 전 SES 0. 소유자 메일은 1통.');
  note('      승인 뒤 릴리스는 에이전트 기본 한도(분당 5)에 걸린 15통을 닫지 않고 미룬다 — 시계를 흘리면 4라운드에 20통.');
  note('      audit 는 여전히 20행, 전부 allowed · transition_announcement · 같은 approval_id.');
  const seeds = Array.from({ length: 20 }, (_, i) => `contact${String(i + 1).padStart(2, '0')}-${tag()}@partner.example`);
  const actor = await provision(provisioningPool, 'announce', seeds);
  await amendPolicy(provisioningPool, actor.agentId, { approval_ttl_seconds: DEMO_TTL_SECONDS });
  const clock = new DemoClock();
  const now = clock.now;
  const rig = rigFor(pool, now);
  const owner = ownerFor(pool, keyring, now);

  const response = await handleTransitionAnnouncement(
    { tokens: rig.tokens, service: rig.service, seeds: createPostgresSeedContactReader(pool) },
    bearer(actor.token, { agent_id: actor.agentId, from: actor.address, owner_name: '진윤겸' }, `demo-p2-announce-${randomUUID()}`),
  );
  const approvalId = String(response.body['approval_id'] ?? '');
  const counts = response.body['counts'] as Record<string, unknown> | undefined;
  check('202 · 20명 전부 pending_approval', response.status === 202 && counts?.['pending_approval'] === 20,
    `${String(response.status)} ${JSON.stringify(counts)}`);
  const kinds = await pool.query<{ subject: string }>('SELECT subject FROM approval_requests WHERE agent_id = $1', [actor.agentId]);
  const items = await count(pool, 'SELECT count(*)::int AS n FROM approval_request_items WHERE approval_id = $1', [approvalId]);
  check('★ AC-b1 — ApprovalRequest 1개(batch) · 항목 20 · 승인 전 SES 0',
    kinds.rows.length === 1 && kinds.rows[0]?.subject === 'batch' && items === 20 && rig.transport.calls() === 0,
    `요청 ${String(kinds.rows.length)} · 항목 ${String(items)} · SES ${String(rig.transport.calls())}`);

  // 배치 알림은 **2분 늦게** 집힌다(트리거 — 나머지 19건이 각자의 트랜잭션에서 합류할 시간). 곧바로 집으면 "항목 1건"
  // 짜리 알림이 나간다.
  const early = await owner.notifier.notify(approvalId);
  check('공지 직후에는 알림이 아직 나가지 않는다(배치는 2분 뒤 — 합류가 끝난 뒤 1통)', early === 'not_due' && owner.inbox.mails.length === 0, early);
  clock.advance(2 * 60_000 + 1000);
  const { outcome, mail, token } = await notifyOwner(owner, approvalId);
  check('2분 뒤 소유자 메일 1통(20통이 아니다) · 본문 "항목: 20건" · 링크 있음',
    outcome === 'sent' && owner.inbox.mails.length === 1 && token !== null && (mail?.body.includes('■ 항목: 20건') ?? false),
    `${outcome} · ${String(owner.inbox.mails.length)}통`);
  if (token === null) return;

  const approvedAt = clock.now();
  const decided = await clickLink(owner, now, 'POST', { token, decision: 'approve' });
  check('매직링크 승인 1번 → approved', decided.status === 200 && (await statusOf(pool, approvalId)) === 'approved');

  const perRound: number[] = [];
  let rounds = 0;
  for (; rounds < 10; rounds += 1) {
    const outcomes = await release(rig, approvalId);
    perRound.push(outcomes.filter((o) => o.kind === 'sent').length);
    const next = await pool.query<{ next: Date | null }>(
      `SELECT min(next_release_at) AS next FROM approval_releases WHERE approval_id = $1 AND status = 'scheduled'`,
      [approvalId],
    );
    const due = next.rows[0]?.next ?? null;
    if (due === null) {
      rounds += 1;
      break;
    }
    clock.advanceTo(due);
  }
  console.log(`  라운드별 발송: ${perRound.join(' + ')} = ${String(rig.transport.calls())}통 · 흘린 시간 ${String(Math.round((clock.now().getTime() - approvedAt.getTime()) / 1000))}s`);
  check('★ AC-b2 — 20통 전부 나갔다 · 라운드당 ≤ 5(기본 한도)', rig.transport.calls() === 20 && perRound.every((n) => n <= 5),
    `${String(rounds)}라운드`);

  const audit = await pool.query<{ decision: string; reasons: string[]; approval_id: string | null; resolution_reason: string | null }>(
    'SELECT decision, reasons, approval_id, resolution_reason FROM audit_logs WHERE agent_id = $1',
    [actor.agentId],
  );
  check('★ AC-b2 — audit 20행 · 전부 allowed · transition_announcement · 같은 approval_id · sent',
    audit.rows.length === 20 &&
      audit.rows.every((r) => r.decision === 'allowed' && r.reasons.includes('transition_announcement') && r.approval_id === approvalId && r.resolution_reason === 'sent'),
    `${String(audit.rows.length)}행`);
}

// ---------------------------------------------------------------------------
// 장면 ⑩ — AC-d4 (정직한 결론)
// ---------------------------------------------------------------------------

interface Mailbox {
  readonly consumer: InboundConsumerDependencies;
}

function mailboxFor(pool: Pool): Mailbox {
  const objects = createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-demo-p2-')) });
  return {
    consumer: {
      receipts: createPostgresInboundStore(pool),
      threads: createPostgresThreadLookup(pool),
      rawMail: createRawMailStore(objects),
      artifacts: createInboundArtifactStore(objects),
      trust: createPostgresTrustFacts(pool),
      inboundPolicy: createPostgresInboundPolicySource(pool),
      watch: createPostgresInboundWatchSource(pool),
      signups: createPostgresAgentSignupStore(pool),
      contact: createPostgresContactIntake(pool, objects),
      dlpKeys: DEMO_DLP_KEYS,
    },
  };
}

/** 서비스의 확인 메일을 SES 수신처럼 흘려 넣고 수신 행을 돌려준다. */
async function receiveConfirmation(
  pool: Pool,
  box: Mailbox,
  actor: Actor,
  service: string,
  code: string,
): Promise<{ id: string; threadId: string; senderTrust: string | null; injectionRisk: string | null } | null> {
  const sesMessageId = newSesMessageId();
  await box.consumer.rawMail.put(
    sesMessageId,
    eml({ from: service, to: actor.address, subject: '[모아] 이메일 인증 코드 안내', text: `안녕하세요. 인증 코드: ${code}\n10분 안에 입력해 주세요.` }),
  );
  const envelope = JSON.parse(notification({ sesMessageId, recipients: [actor.address], commonFrom: [service] })) as { Message: string };
  const inner = JSON.parse(envelope.Message) as { mail: { timestamp: string }; receipt: { timestamp: string } };
  const now = new Date().toISOString();
  inner.mail.timestamp = now;
  inner.receipt.timestamp = now;
  const outcome = await consumeInboundMail(box.consumer, {
    receiptId: `demo-p2-${sesMessageId.slice(0, 8)}`,
    body: JSON.stringify({ ...envelope, Message: JSON.stringify(inner) }),
  });
  if (outcome !== 'stored') return null;
  const row = await pool.query<{ id: string; thread_id: string; sender_trust: string | null; injection_risk: string | null }>(
    'SELECT id, thread_id, sender_trust, injection_risk FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2',
    [actor.agentId, sesMessageId],
  );
  const r = row.rows[0];
  return r === undefined ? null : { id: r.id, threadId: r.thread_id, senderTrust: r.sender_trust, injectionRisk: r.injection_risk };
}

function replyWithCode(pool: Pool, rig: Rig, actor: Actor, inbound: { id: string; threadId: string }, code: string): Promise<ApiResponse> {
  return handleReply(
    {
      tokens: rig.tokens,
      service: rig.service,
      transport: rig.transport,
      replyTargets: createPostgresReplyTargetLookup(pool),
      // 원 발신자에게 하는 회신이라 원문을 읽지 않는다(재검증 N2 ① 은 수신자를 바꾼 회신만).
      artifacts: { readParsed: () => Promise.reject(new Error('demo-p2: 원문 읽기 없음')) },
    },
    bearer(actor.token, { agent_id: actor.agentId, from: actor.address, in_reply_to: inbound.id, text: code }, `demo-p2-reply-${randomUUID()}`),
    { threadId: inbound.threadId },
  );
}

async function sceneWorkloadOne(pool: Pool, provisioningPool: Pool, keyring: HmacKeyring): Promise<void> {
  section('⑩ AC-d4 — 워크로드 1(가입 → 확인 메일 → 코드 회신). 계획의 문장은 "요청 0개" 다. 현 설계에서는 성립하지 않는다');
  note('계획 §3.4: "확인 메일에 대한 응답은 기존 스레드 내 회신이므로 첫 연락 approval 을 타지 않는다." 이 문장은');
  note('r3 이전의 것이다. P3b 에서 `auto_approve_reply_within_thread` 를 **에이전트가 시작한 스레드**로 좁혔다 — 외부인이');
  note('시작한 스레드에서도 열리면 "공격자 메일 → 에이전트가 그 스레드에 회신 → 승인 없이 발송" 이 되기 때문이다.');
  note('확인 메일은 서비스가 시작한 스레드다. 그래서 코드 회신이 사람 없이 나가는 문은 `auto_approve_verification_senders`');
  note('하나뿐이고, 그 문은 기본 OFF 이며 **GATE 동안 켜지 않는다**(AC-7 판정 보류 — 그 문의 전제가 스캐너다).');
  const service = `noreply-${tag()}@moa-${tag()}.example`;

  // (a) 기본 설정 — 대표의 GATE 설정 그대로.
  console.log('\n  (a) 기본 설정(GATE 설정): 확인 메일에 코드로 회신한다');
  const actor = await provision(provisioningPool, 'workload1', []);
  await amendPolicy(provisioningPool, actor.agentId, { approval_ttl_seconds: DEMO_TTL_SECONDS });
  const rig = rigFor(pool);
  const owner = ownerFor(pool, keyring);
  const box = mailboxFor(pool);
  const first = await receiveConfirmation(pool, box, actor, service, '482913');
  if (!check('확인 메일 수신(stored) · injection_risk=none', first !== null && first.injectionRisk === 'none',
    `trust=${String(first?.senderTrust)} risk=${String(first?.injectionRisk)}`) || first === null) return;
  const answered = await replyWithCode(pool, rig, actor, first, '482913');
  const approvalId = String(answered.body['approval_id'] ?? '');
  check('코드 회신 → 202 pending_approval · SES 0', answered.status === 202 && approvalId !== '' && rig.transport.calls() === 0,
    `${String(answered.status)} [${reasonsOf(answered)}]`);
  const requests = await requestsOf(pool, actor.agentId);
  check('사실 확인 — 워크로드 1 한 바퀴에 ApprovalRequest = 1 (AC-d4 가 요구하는 0 이 아니다)', requests === 1, String(requests));
  deviations.push(
    `AC-d4 불성립 — 워크로드 1 시뮬레이션의 ApprovalRequest = ${String(requests)} (계획은 0). ` +
      '외부 스레드 자동 승인 구멍을 닫은 대가다(P3b). GATE 설정(auto_approve_verification_senders OFF)에서 의도된 값.',
  );

  // (b) 대가의 상한 — 서비스당 1회.
  console.log('\n  (b) 대가의 상한: 소유자가 한 번 승인하면 같은 서비스의 다음 코드 회신은 승인 없이 나간다');
  const { token } = await notifyOwner(owner, approvalId);
  if (token !== null) {
    await clickLink(owner, rig.now, 'POST', { token, decision: 'approve' });
    await release(rig, approvalId);
  }
  check('소유자 승인 → 릴리스 → 코드 회신 발송(SES 1)', token !== null && rig.transport.calls() === 1);
  const second = await receiveConfirmation(pool, box, actor, service, '731005');
  const again = second === null ? null : await replyWithCode(pool, rig, actor, second, '731005');
  check('같은 서비스의 두 번째 확인 메일(새 스레드) → 코드 회신 200 · standing_approval · 요청 여전히 1',
    again?.status === 200 && reasonsOf(again) === 'standing_approval' && (await requestsOf(pool, actor.agentId)) === 1,
    `${String(again?.status)} [${again === null ? '' : reasonsOf(again)}]`);
  note('→ 워크로드 1 의 승인 수 = **새 서비스 수**(가입당 1회). 메시지당이 아니다 — §3.4 의 "상대방당 비용" 과 같은 상한이다.');

  // (c) AC-d4 를 0 으로 만드는 유일한 문 — GATE 에서는 닫아 둔다.
  console.log('\n  (c) 반사실: AC-d4 를 0 으로 만드는 유일한 문 = auto_approve_verification_senders ON + 발신자 seen 표시');
  if (OWNER_URL.trim() === '') {
    skip('(c) 반사실', 'TEST_MIGRATION_DATABASE_URL(소유자 롤)이 없다 — `sender:mark` 가 쓰는 롤이 있어야 seen 을 만들 수 있다');
  } else {
    const other = await provision(provisioningPool, 'workload1-on', []);
    const otherRig = rigFor(pool);
    await amendPolicy(provisioningPool, other.agentId, { approval_ttl_seconds: DEMO_TTL_SECONDS, auto_approve_verification_senders: true });
    const otherService = `noreply-${tag()}@moa-${tag()}.example`;
    // 운영자 CLI 를 그대로 — 런북(gate-day0 §8)이 대표에게 시키는 명령과 같은 것.
    const marked = execFileSync(
      join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
      [join(REPO_ROOT, 'scripts', 'sender-mark.ts'), '--agent', other.agentId, '--address', otherService, '--by', 'demo:p2'],
      { env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL }, encoding: 'utf8' },
    );
    console.log(`  pnpm sender:mark → ${redactIds(marked.trim())}`);
    const inbound = await receiveConfirmation(pool, box, other, otherService, '550271');
    const code = inbound === null ? null : await replyWithCode(pool, otherRig, other, inbound, '550271');
    check('ON + seen → 코드 회신 200 · reasons=[auto_approve_verification_sender] · 요청 0',
      code?.status === 200 && reasonsOf(code) === 'auto_approve_verification_sender' && (await requestsOf(pool, other.agentId)) === 0,
      `trust=${String(inbound?.senderTrust)} · ${String(code?.status)} [${code === null ? '' : reasonsOf(code)}]`);
    note('→ 문은 동작한다. 그러나 그 전제(injection_risk=none)를 판정하는 스캐너가 봉인 홀드아웃에서 불합격했고(AC-7 보류),');
    note('  GATE 는 그 문을 닫은 채 진행한다. 대가는 (b) 의 "새 서비스마다 승인 1회" 이고, 그 대가를 받아들인다.');
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('demo:p2 — "신규 상대 첫 연락 → 소유자 메일함에 승인 링크 → 클릭 → 발송 → 같은 상대 2번째는 승인 없이."');
  console.log('  모드: 드라이런 고정 · 소유자 SES 가짜 · 로컬 객체 저장소 · SES 수신 알림 합성 — 실제 SES·S3 호출 없음.');
  // info 로그는 장면을 가린다 — warn·error 만 보인다(가린 채 넘어가지 않게).
  const restoreLogSink = setLogSink((line) => {
    if (/"level":"(warn|error)"/.test(line)) console.log(redactIds(line));
  });

  if (OWNER_URL.trim() === '') {
    throw new Error(
      'TEST_MIGRATION_DATABASE_URL(또는 DATABASE_MIGRATION_URL) 이 없다 — 프로비저닝은 소유자 롤로만 한다(202609230730).',
    );
  }

  const pool = createAppPool();
  const provisioningPool = createPool(OWNER_URL, { max: 4 });
  // 실행마다 새 키 — 출력하지 않는다. 운영 키는 `ATMARK_APPROVAL_LINK_KEYS`(Secrets Manager)다.
  const keyring = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'DEMO_APPROVAL_LINK_KEYS');
  try {
    const seed = `seed-${tag()}@partner.example`;
    const partner = `buyer-${tag()}@acme-${tag()}.example`;
    const fresh = await provision(provisioningPool, 'default', [], null);
    const main = await provision(provisioningPool, 'main', [seed]);
    await insertWebhookEndpoint(pool, { agentId: main.agentId, url: 'https://hooks.example.com/demo-p2', secretKid: 'w1' });
    console.log(`  에이전트: ${elide(main.agentId)} · ${main.address} · 소유자 ${OWNER_EMAIL}`);
    const clock = new DemoClock();
    const rig = rigFor(pool, clock.now);
    const owner = ownerFor(pool, keyring, clock.now);

    await sceneDefaults(pool, rig, fresh, main, seed);
    // ①이 기본값을 본 뒤에 TTL 만 상한으로 올린다(`amendPolicy` 주석 — 동시 실행되는 테스트의 전역 스윕).
    await amendPolicy(provisioningPool, main.agentId, { approval_ttl_seconds: DEMO_TTL_SECONDS });
    const opened = await sceneFirstContact(pool, provisioningPool, rig, owner, main, partner);
    if (opened !== null) {
      const token = await sceneOwnerMail(pool, owner, opened.approvalId);
      if (token !== null) {
        await sceneClick(pool, rig, owner, main, partner, opened, token);
        await sceneSecondContact(pool, rig, clock, main, partner);
      }
    }
    await sceneExpiry(pool, rig, clock, owner, main);
    await sceneDomainScope(pool, rig, clock, owner, main);
    await sceneAnnouncement(pool, provisioningPool, keyring);
    await sceneWorkloadOne(pool, provisioningPool, keyring);

    section('판정');
    if (skipped.length > 0) {
      console.log(`⏸ 건너뜀 ${String(skipped.length)}건 — 이 실행이 보지 않은 것:`);
      for (const item of skipped) console.log(`  - ${item}`);
    }
    if (deviations.length > 0) {
      console.log(`⚠ 계획과 다른 것 ${String(deviations.length)}건 — **통과로 세지 않는다**(계획 개정 대상):`);
      for (const item of deviations) console.log(`  - ${item}`);
    }
    if (failures.length > 0) {
      console.error(`✗ demo:p2 실패 ${String(failures.length)}건:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      '✓ P2: v2 기본 allowlist(목록 밖 거부) · [레거시] seed 무승인 · 신규 상대 202(p95 ≤ 200ms) · 소유자 링크 1통(무력화) · GET 무변경 → 결정 → 릴리스 ·',
    );
    console.log('      같은 상대 5턴에 요청 1 · 만료 SES 0 + 웹훅 1 · domain 확인 400 · 공지 20명 요청 1 → 분당 5로 20통.');
    console.log('  AC-d4 는 위 ⚠ 그대로다 — 워크로드 1 의 승인 비용은 0 이 아니라 "새 서비스당 1회" 다.');
  } finally {
    restoreLogSink();
    await pool.end();
    await provisioningPool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('✗ demo:p2 가 예외로 끝났다:', error);
  process.exitCode = 1;
});
