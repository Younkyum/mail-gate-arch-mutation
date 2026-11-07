/**
 * `pnpm demo:p1b` — 계획 §6 P1b 의 demo.
 *
 *   ***"에이전트가 자기 @atmark.ai 로 시드 계정에 실제로 발송하고, allowlist 밖 수신자는
 *      SES 호출 0회로 막히고, 두 시도 모두 audit 에 남는다."***
 *
 * **Round 2 사고의 직접 재현 방지가 여기서 눈으로 증명된다** — "내가 생각지도 않은
 * 사람들에게 메일을 보냈어" 가 정책 한 줄이 아니라 **실행된 코드**로 막힌다.
 *
 * 다섯 장면:
 *   ① 프로비저닝 — 에이전트·주소·토큰이 한 트랜잭션에서 태어난다
 *   ② 발송      — 시드 계정으로. From 이 `@atmark.ai` 다
 *   ③ 차단      — allowlist 밖 수신자. **SES 호출 0회**
 *   ④ audit     — 두 시도 모두 행이 있고, 판정·사유·정책 버전을 답한다 (AC-9)
 *   ⑤ 멱등성    — 같은 키 재호출. SES 호출 1회 유지, messages 1행, audit 1행
 *
 * ---
 *
 * **실발송은 옵트인이다.** 기본은 드라이런(SES 를 부르지 않는 가짜 전송단)이고,
 * `ATMARK_DEMO_REAL_SEND=1` 일 때만 진짜로 나간다.
 *
 * 그 플래그가 있는 이유는 편의가 아니다 — **SES 계정 한도가 50,000통/일이고(R22,
 * 샌드박스가 2026-09-22 에 46초 만에 풀렸다) 남은 제동장치는 워밍업 캡뿐이다**
 * (`src/policy/rules/limits.ts`, Day 1 = 20 **수신자**). 이 스크립트가 기본값으로
 * 진짜 메일을 내보내면, 실수로 한 번 더 돌리는 일이 곧 평판 사건이 된다.
 */

import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppPool, createPool } from '../src/db/client';
import {
  createPostgresAgentTokenStore,
  createPostgresGateStores,
} from '../src/db/repositories';
import { createPostgresAuditReader } from '../src/api/audit-reader';
import { createInMemoryContentStore } from '../src/api/content-store';
import { createPostgresOutboundMessageStore } from '../src/api/outbound-store';
import { createPostgresProvisioningStore } from '../src/api/provisioning-store';
import type { OutboundServiceDependencies } from '../src/api/outbound-service';
import type { ApiRequest, ApiResponse } from '../src/api/http';
import { handleAuditQuery } from '../src/api/routes/audit';
import { handleSend } from '../src/api/routes/send';
import { provisionAgent, type ProvisionedAgent } from '../src/identity/provisioning';
import { createLocalDevKeyCustody } from '../src/passport/custody-local';
import { P1B_DEMO_SEED_CONTACT } from '../src/identity/seed-contacts';
import { warmupDailyCap } from '../src/policy/rules/limits';
// 전송단 조립은 `test/` 아래에 있다. 이유는 그 파일 머리말에 적혀 있다 —
// Layer B 가 전송단 참조를 `gate.ts` 와 `test/**` 로만 허용하고, 그 허용목록을 늘리는
// 것은 `test/arch/**` 변경이라 리드의 판단이기 때문이다.
import { createDemoTransport } from '../test/integration/outbound/support/transport';
import { createPostgresDlpSignalStore } from '../src/db/repositories/dlp-signal-store';
import { createPostgresRiskSignalSource } from '../src/db/repositories/risk-signal-store';
import { parseHmacKeyring } from '../src/security/hmac-keyring';

/** 데모 전용 발신 DLP 지문 키(ADR-0016 — 운영 키와 무관). */
const DEMO_DLP_KEYS = parseHmacKeyring(`d1:${Buffer.alloc(32, 5).toString('base64url')}`, 'DEMO_DLP_KEYS');


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `.env` 가 있으면 읽는다. 없으면 환경변수를 그대로 쓴다 — 여기서 기본 접속 문자열을
// 만들어 넣지 않는다(`db/client.ts` 가 같은 이유로 기본값을 거부한다).
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // 파일이 없다. 정상 경로다.
}

/** 성공 수신자 — 시드 contact 이자 allowlist 항목 (인계 문서에서 사용자가 확정). */
// `??` 를 쓰면 안 된다 — process.loadEnvFile 은 `KEY=` 를 **빈 문자열**로 바인딩하고
// `??` 는 null/undefined 에만 반응한다. .env.example 을 지시대로 복사하면 그 빈
// 문자열이 seedContacts 로 흘러 ADDRESS_SHAPE 불일치 → 장면 ① 이 죽는다.
const SEED_CONTACT = process.env['ATMARK_DEMO_RECIPIENT']?.trim() || P1B_DEMO_SEED_CONTACT;

/**
 * 차단 대상. **실존할 필요가 없다** — 증명 대상이 "SES 호출 0회" 이므로 이 주소로
 * 나가는 패킷은 애초에 없다.
 */
const BLOCKED_RECIPIENT = 'blocked-test@atmark.ai';

const REAL_SEND = process.env['ATMARK_DEMO_REAL_SEND'] === '1';

/**
 * 프로비저닝 전용 소유자 롤 접속. `activateAgent`(`UPDATE agents SET status='active'`)가
 * 앱 롤에는 없다(202609230730, ADR-0006 보강) — 앱 롤은 이제 `organizations.sending_started_at`
 * 하나만 UPDATE 할 수 있다. 없으면 던진다(앱 롤로 조용히 떨어지지 않는다 — harness 와 같은 규율).
 */
const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_MIGRATION_URL'] ?? '';

const failures: string[] = [];

function section(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function field(response: ApiResponse, key: string): unknown {
  return response.body[key];
}

function short(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ---------------------------------------------------------------------------

interface SendOptions {
  readonly token: string;
  readonly agentId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly idempotencyKey: string;
  readonly subject: string;
}

function sendRequest(options: SendOptions): ApiRequest {
  return {
    headers: {
      authorization: `Bearer ${options.token}`,
      'idempotency-key': options.idempotencyKey,
    },
    query: {},
    body: {
      agent_id: options.agentId,
      from: options.from,
      to: [...options.to],
      subject: options.subject,
      text:
        'Atmark P1b demo.\n\n' +
        '이 메일은 정책 관문(src/policy/gate.ts)을 지나 발송됐습니다. ' +
        '판정 근거는 audit_logs 에 남아 있습니다.\n',
      html: null,
      cost_cents: 0,
      trace_id: 'demo:p1b',
    },
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('demo:p1b — "보낼 수 있다. 그리고 보내면 안 되는 것은 SES 를 부르기 전에 막힌다."');
  console.log(
    `  모드: ${REAL_SEND ? '⚠  실발송 (ATMARK_DEMO_REAL_SEND=1)' : '드라이런 (SES 를 부르지 않는다)'}`,
  );
  if (REAL_SEND) {
    // 캡은 조직 단위이고 신규 조직의 `sending_started_at` 은 null 이므로 Day 0 구간이다.
    console.log(
      `  ⚠  진짜 메일이 ${SEED_CONTACT} 로 나간다. ` +
        `오늘 이 조직의 상한은 ${String(warmupDailyCap(new Date(), null))} 수신자다(워밍업 캡, R22).`,
    );
  }

  if (OWNER_URL.trim() === '') {
    throw new Error(
      'TEST_MIGRATION_DATABASE_URL(또는 DATABASE_MIGRATION_URL) 이 없다 — 프로비저닝은 소유자 롤로만 한다(202609230730).',
    );
  }

  const pool = createAppPool();
  const ownerPool = createPool(OWNER_URL, { max: 4 });
  try {
    const gateStores = createPostgresGateStores(pool);
    const tokens = createPostgresAgentTokenStore(pool);
    const content = createInMemoryContentStore();
    const transport = createDemoTransport({ content, realSend: REAL_SEND, pool });
    const auditReader = createPostgresAuditReader(pool);

    const service: OutboundServiceDependencies = {
      source: gateStores.source,
      audit: gateStores.audit,
      dispatchStore: gateStores.leases,
      serializer: gateStores.serializer,
      sendEvidence: gateStores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content,
      leaseTtlSeconds: 300,
      // ADR-0016 — 운영과 같은 Postgres 구현(위험 신호 강제 · 발신 DLP). 워크로드 1 은 보류 0 이어야 한다.
      riskSignals: createPostgresRiskSignalSource(pool, { mode: 'enforce' }),
      dlp: { keyring: DEMO_DLP_KEYS, signals: createPostgresDlpSignalStore(pool) },
      now: () => new Date(),
    };

    // -----------------------------------------------------------------------
    section('① 프로비저닝 — 에이전트·keypair·주소·토큰이 한 트랜잭션에서 태어난다');
    // -----------------------------------------------------------------------

    const suffix = randomBytes(4).toString('hex');
    let provisioned: ProvisionedAgent;
    try {
      provisioned = await provisionAgent(createPostgresProvisioningStore(ownerPool), {
        // 승인 알림 수신자(P2). 이 데모는 알림 워커를 돌리지 않는다 — 형식을 만족하는 예약 도메인이다.
        organization: { kind: 'create', name: `atmark-demo-${suffix}`, ownerEmail: 'owner@example.com' },
        agentName: `demo-agent-${suffix}`,
        addressLocalPart: `demo-${suffix}`,
        // **seed contacts 가 곧 allowlist 다** (§3.1 층 2). 장면 ③ 이 이 목록 하나에 달려 있다.
        seedContacts: [SEED_CONTACT],
        monthlyBudgetCents: 10_000,
        createdBy: 'demo:p1b',
        tokenCapabilities: null,
        // **P1 데모의 모드를 명시한다** (§4.4). 정책 v2 의 기본값도 `allowlist_only` 지만(ADR-0007), 장면 ③(allowlist 밖 →
        // 거부)이 그 모드에 달려 있으므로 기본값에 기대지 않고 적는다.
        outboundMode: 'allowlist_only',
        // PP-A(§4B.1) — 개발 전용 보관소. 운영에서 선택되면 `assertNotProduction` 이 던진다.
        // 운영 경로는 `createAwsKeyCustody`(KMS envelope → Secrets Manager)다.
      }, createLocalDevKeyCustody());
    } catch (error) {
      check('프로비저닝', false, error instanceof Error ? error.message : String(error));
      throw error;
    }

    const agentId = provisioned.agent.id;
    const address = provisioned.address.address;
    const token = provisioned.token.plaintext;

    check('agentId 는 소문자 hex 32자다 (§4B.1)', /^[0-9a-f]{32}$/.test(agentId), agentId);
    check('주소가 @atmark.ai 다', address.endsWith('@atmark.ai'), address);
    check('에이전트가 active 다', provisioned.agent.status === 'active', provisioned.agent.status);
    check(
      '토큰은 atk_agent_ 접두사이고 평문은 여기서 1회만 나온다',
      token.startsWith('atk_agent_'),
      `${token.slice(0, 14)}…(${String(token.length)}자)`,
    );
    check(
      `seed contact 가 발신 allow 목록이다(정책 v2 — agent_contact_rules, 버전 1 스냅샷에 실림) — ${SEED_CONTACT}`,
      JSON.stringify(provisioned.policyVersion.snapshot['contact_rules']).includes(SEED_CONTACT),
      JSON.stringify(provisioned.policyVersion.snapshot['contact_rules']),
    );
    check(
      '정책 모드가 allowlist_only 다 (§4.4)',
      provisioned.policyVersion.outbound_mode === 'allowlist_only',
      provisioned.policyVersion.outbound_mode,
    );

    // -----------------------------------------------------------------------
    section(`② 발송 — ${address} → ${SEED_CONTACT}`);
    // -----------------------------------------------------------------------

    const sendKey = `demo-p1b-send-${suffix}`;
    const sent = await handleSend(
      { tokens, service, transport },
      sendRequest({
        token,
        agentId,
        from: address,
        to: [SEED_CONTACT],
        idempotencyKey: sendKey,
        subject: `Atmark P1b demo (${suffix})`,
      }),
    );

    console.log(`  From:          ${address}   ← 에이전트 자신의 @atmark.ai 주소다`);
    console.log(`  To:            ${SEED_CONTACT}`);
    console.log(`  전송단:        ${transport.mode()}`);
    console.log(`  응답:          ${String(sent.status)} ${JSON.stringify(sent.body)}`);

    const sentMessageId = short(field(sent, 'message_id'));
    check('200 으로 발송됐다', sent.status === 200, JSON.stringify(sent.body));
    check(
      'provider_message_id(전송단 id)가 있다',
      typeof field(sent, 'provider_message_id') === 'string' && short(field(sent, 'provider_message_id')) !== '',
      short(field(sent, 'provider_message_id')),
    );
    check('messages 행이 sent 로 확정됐다', field(sent, 'settled') === true);
    check('SES 호출 1회', transport.sesSendCalls() === 1, `${String(transport.sesSendCalls())}회`);
    if (!REAL_SEND) {
      check(
        '드라이런이므로 provider_message_id 에 dryrun- 접두사가 붙는다',
        short(field(sent, 'provider_message_id')).startsWith('dryrun-'),
        short(field(sent, 'provider_message_id')),
      );
    }

    // -----------------------------------------------------------------------
    section(`③ 차단 — ${BLOCKED_RECIPIENT} 는 allowlist 밖이다`);
    // -----------------------------------------------------------------------

    const callsBeforeBlock = transport.sesSendCalls();
    const blocked = await handleSend(
      { tokens, service, transport },
      sendRequest({
        token,
        agentId,
        from: address,
        to: [BLOCKED_RECIPIENT],
        idempotencyKey: `demo-p1b-blocked-${suffix}`,
        subject: `Atmark P1b demo — 차단되어야 한다 (${suffix})`,
      }),
    );

    console.log(`  응답:          ${String(blocked.status)} ${JSON.stringify(blocked.body)}`);

    const blockedMessageId = short(field(blocked, 'message_id'));
    const blockedDecision = field(blocked, 'decision') as { reasons?: unknown } | undefined;
    const blockedReasons = Array.isArray(blockedDecision?.reasons) ? blockedDecision.reasons : [];
    check('403 policy_denied', blocked.status === 403 && field(blocked, 'error') === 'policy_denied');
    check(
      '사유가 recipient_not_allowlisted 다',
      blockedReasons.includes('recipient_not_allowlisted'),
      JSON.stringify(blockedReasons),
    );
    check(
      '★ SES 호출 0회 — 차단은 전송단에 닿기 전에 일어난다 (AC-5)',
      transport.sesSendCalls() === callsBeforeBlock,
      `차단 전 ${String(callsBeforeBlock)}회 → 차단 후 ${String(transport.sesSendCalls())}회`,
    );

    // -----------------------------------------------------------------------
    section('④ audit — 두 시도 모두 "왜" 에 답한다 (AC-9)');
    // -----------------------------------------------------------------------

    const auditDeps = { tokens, audit: auditReader, now: () => new Date() };
    const auditRequest = (messageId: string): ApiRequest => ({
      headers: { authorization: `Bearer ${token}` },
      query: { message_id: messageId },
      body: null,
    });

    const sentAudit = await handleAuditQuery(auditDeps, auditRequest(sentMessageId));
    const blockedAudit = await handleAuditQuery(auditDeps, auditRequest(blockedMessageId));

    interface AuditAttempt {
      readonly decision?: unknown;
      readonly reasons?: unknown;
      readonly policy_version?: unknown;
      readonly resolution_reason?: unknown;
    }
    const attemptsOf = (response: ApiResponse): readonly AuditAttempt[] => {
      const attempts = response.body['attempts'];
      return Array.isArray(attempts) ? (attempts as readonly AuditAttempt[]) : [];
    };

    const sentAttempts = attemptsOf(sentAudit);
    const blockedAttempts = attemptsOf(blockedAudit);
    console.log(`  GET /v1/audit?message_id=${sentMessageId}`);
    console.log(`    → ${JSON.stringify(sentAttempts)}`);
    console.log(`  GET /v1/audit?message_id=${blockedMessageId}`);
    console.log(`    → ${JSON.stringify(blockedAttempts)}`);

    check('발송 시도: audit 행 정확히 1개', sentAttempts.length === 1, `${String(sentAttempts.length)}행`);
    check('발송 시도: decision=allowed', sentAttempts[0]?.decision === 'allowed');
    check(
      '발송 시도: resolution_reason=sent (전송 결과가 같은 행에 확정됐다)',
      sentAttempts[0]?.resolution_reason === 'sent',
      short(sentAttempts[0]?.resolution_reason),
    );
    check(
      '발송 시도: policy_version 이 있다 — "어느 정책이 허용했는가"',
      typeof sentAttempts[0]?.policy_version === 'number',
      short(sentAttempts[0]?.policy_version),
    );
    check('차단 시도: audit 행 정확히 1개', blockedAttempts.length === 1, `${String(blockedAttempts.length)}행`);
    check('차단 시도: decision=denied', blockedAttempts[0]?.decision === 'denied');
    check(
      '차단 시도: 사유가 남아 있다',
      Array.isArray(blockedAttempts[0]?.reasons) &&
        (blockedAttempts[0].reasons as readonly unknown[]).includes('recipient_not_allowlisted'),
      JSON.stringify(blockedAttempts[0]?.reasons),
    );

    // -----------------------------------------------------------------------
    section('⑤ 멱등성 — 같은 Idempotency-Key 재호출 (§4.5-1)');
    // -----------------------------------------------------------------------

    const callsBeforeReplay = transport.sesSendCalls();
    const replayed = await handleSend(
      { tokens, service, transport },
      sendRequest({
        token,
        agentId,
        from: address,
        to: [SEED_CONTACT],
        // **장면 ② 와 같은 키, 같은 본문.**
        idempotencyKey: sendKey,
        subject: `Atmark P1b demo (${suffix})`,
      }),
    );

    console.log(`  응답:          ${String(replayed.status)} ${JSON.stringify(replayed.body)}`);

    const messageRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE agent_id = $1 AND idempotency_key = $2',
      [agentId, sendKey],
    );
    const auditRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE message_id = $1',
      [sentMessageId],
    );

    check('재호출이 최초 결과를 그대로 돌려준다', replayed.status === 200 && field(replayed, 'replayed') === true);
    check(
      '같은 message_id 다 — 새 메시지를 만들지 않는다',
      short(field(replayed, 'message_id')) === sentMessageId,
      short(field(replayed, 'message_id')),
    );
    check(
      '★ SES 호출 1회 유지 (AC-i1)',
      transport.sesSendCalls() === callsBeforeReplay,
      `${String(callsBeforeReplay)}회 → ${String(transport.sesSendCalls())}회`,
    );
    check('messages 행 1개', messageRows.rows[0]?.count === '1', `${short(messageRows.rows[0]?.count)}행`);
    check('audit 행 1개', auditRows.rows[0]?.count === '1', `${short(auditRows.rows[0]?.count)}행`);

    // -----------------------------------------------------------------------
    section('판정');
    // -----------------------------------------------------------------------

    if (failures.length > 0) {
      console.error(`✗ demo:p1b 실패 ${String(failures.length)}건:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `✓ P1b: 발송 1건(${transport.mode()}) · 차단 1건(SES 호출 0회) · audit 2행 · 멱등 재호출 0건 추가 발송.`,
    );
    if (!REAL_SEND) {
      console.log('  실제 메일을 보내려면 ATMARK_DEMO_REAL_SEND=1 로 다시 돌려라. 워밍업 캡을 먼저 확인할 것.');
    }
  } finally {
    await pool.end();
    await ownerPool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('✗ demo:p1b 가 예외로 끝났다:', error);
  process.exitCode = 1;
});
