/**
 * `pnpm demo:p1c` — 계획 §6 P1c 의 demo.
 *
 *   ***"같은 요청은 한 번만 나간다. 신분은 태어날 때 붙고 두 번 다시 바뀌지 않는다.
 *      그리고 모르면 보내지 않는다."***
 *
 * 세 문장이 P1c 가 산 것의 전부다. 각 장면이 그중 하나를 **명제로 세우고, 그 명제가
 * 거짓이면 이 스크립트는 exit 1 이다** (`demo-p1a`·`demo-p1b` 와 같은 규율 — demo 가
 * 빨간불을 보여 주고도 0으로 끝나면 그 demo 는 계획 §9 시나리오 5의 실행본이다).
 *
 * 다섯 장면:
 *   ① 멱등성   — 같은 `Idempotency-Key` 3회 → SES 1회 **·** messages 1행 **·** audit 1행
 *   ② 프로비저닝 — 에이전트·keypair·draft passport 가 **한 트랜잭션**에서 태어난다 (PP-A)
 *   ③ 불변성   — §4B.1 의 네 구멍 전부가 **DB 에서** 거부된다. 방어는 두 층이다
 *   ④ ADR-0004 — lease 만료 재전송 **전에** 증거를 조회한다. *조회 실패는 "안 나갔다" 가 아니다*
 *   ⑤ 알람     — `cdk synth` 산출물을 파싱해 알람 전부(개수는 `ALARM_ORDER` 에서 파생)와 임계값, 그리고 그 근거를 낸다
 *
 * ---
 *
 * **왜 계획이 적은 셋이 아니라 다섯인가.** 계획 §6 P1c 의 demo 문장은 ①②③⑤ 를 적었고
 * ADR-0004 는 **P1c 착수 시에 내린 결정**이라 그 문장에 없다. 그것이 demo 에 없으면
 * **가장 최근에 내린 결정이 실연되지 않은 채 남는다** — 그래서 ④ 가 있다. ④ 가 없으면
 * 중복 발송의 원인이 *"DB 가 잠깐 느렸다"* 인 상태를 아무도 보지 못한다.
 *
 * ---
 *
 * **실발송 경로가 없다.** `demo:p1b` 에는 `ATMARK_DEMO_REAL_SEND` 옵트인이 있지만 이
 * 파일에는 그 분기가 아예 없고, 장면 ① 이 전송단이 정말로 드라이런인지를 **단언**한다.
 * P1c 가 보이려는 것은 "몇 통이 나가는가" 가 아니라 "**두 번 나가지 않는가**" 이므로
 * 진짜 메일이 필요 없고, 필요 없는 위험은 두지 않는다(R22 — 계정 한도 50,000통/일).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import type { Pool } from 'pg';

import type { ApiRequest, ApiResponse } from '../src/api/http';
import { createInMemoryContentStore } from '../src/api/content-store';
import {
  finalizeOutbound,
  gateDependenciesFor,
  prepareOutbound,
  type OutboundServiceDependencies,
} from '../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../src/api/outbound-store';
import { createPostgresProvisioningStore } from '../src/api/provisioning-store';
import { handleSend } from '../src/api/routes/send';
import { createAppPool, createPool } from '../src/db/client';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../src/db/repositories';
import { createPostgresSesEventStore } from '../src/db/repositories/ses-event-store';
import type { AgentId } from '../src/db/schema';
import {
  provisionAgent,
  type ProvisionedAgent,
  type ProvisioningStore,
  type ProvisioningTransaction,
} from '../src/identity/provisioning';
import { P1B_DEMO_SEED_CONTACT } from '../src/identity/seed-contacts';
import { CONSUMER_STALE_AFTER_SECONDS, evaluateConsumerHealth } from '../src/mail/events/health';
import { parseSesEvent } from '../src/mail/events/ses-event';
import { ATMARK_MESSAGE_ID_TAG } from '../src/mail/events/tag';
import { setLogSink } from '../src/observability/logger';
import { METRIC_NAMESPACE } from '../src/observability/metrics';
import { createLocalDevKeyCustody } from '../src/passport/custody-local';
import { ATMARK_CONTROLLER_DID, DID_WEB_PREFIX, didForAgent, externalDidOf } from '../src/passport/did';
import { INITIAL_PASSPORT_VERSION } from '../src/passport/keypair';
import {
  dispatch,
  type DispatchRequest,
  type GateDependencies,
  type SendEvidenceLookup,
} from '../src/policy/gate';
// 전송단 조립은 `test/` 아래에 있다. 이유는 그 파일 머리말에 적혀 있다 — Layer B 가
// 전송단 참조를 `gate.ts` 와 허용목록의 파일들로만 닫아 두었고, 그 목록을 늘리는 것은
// `test/arch/**` 변경이라 리드의 판단이다. `demo:p1b` 와 같은 경로를 쓴다.
import { createDemoTransport } from '../test/integration/outbound/support/transport';
// 알람 스택은 **배포하지 않는다**(P1c 는 `cdk synth` 까지다). 장면 ⑤ 는 이 스택을
// 여기서 직접 synth 해 산출물 JSON 을 파싱한다 — `test/arch/observability-alarms`
// 와 같은 방식이며, 이유도 같다: 컴파일된다는 사실은 리소스가 산출됐다는 증거가 아니다.
import {
  ALARM_TOPIC_NAME,
  BOUNCE_ALARM_RATE,
  COMPLAINT_ALARM_RATE,
  ObservabilityStack,
  RECONCILE_STALE_SECONDS,
  SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD,
  SERIALIZATION_FAILURE_THRESHOLD,
  SES_BOUNCE_REVIEW_RATE,
  SES_EVENTS_LAG_SECONDS,
  VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD,
  WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS,
  WEBHOOK_DEAD_RATIO_THRESHOLD,
} from '../infra/cdk/stacks/observability-stack';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT } from '../src/db/schema';
import { WARMUP_STEADY_STATE_DAILY_CAP } from '../src/policy/rules/limits';
import { createPostgresDlpSignalStore } from '../src/db/repositories/dlp-signal-store';
import { createPostgresRiskSignalSource } from '../src/db/repositories/risk-signal-store';
import { parseHmacKeyring } from '../src/security/hmac-keyring';

/** 데모 전용 발신 DLP 지문 키(ADR-0016 — 운영 키와 무관). */
const DEMO_DLP_KEYS = parseHmacKeyring(`d1:${Buffer.alloc(32, 5).toString('base64url')}`, 'DEMO_DLP_KEYS');


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `.env` 가 있으면 읽는다. 없으면 환경변수를 그대로 쓴다 — 기본 접속 문자열을 여기서
// 만들어 넣지 않는다(`db/client.ts` 가 같은 이유로 기본값을 거부한다).
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // 파일이 없다. 정상 경로다.
}

/** `GateDependencies.leaseTtlSeconds` 의 프로덕션 값. 장면 ④ 의 시간 계산이 여기 걸려 있다. */
const LEASE_TTL_SECONDS = 300;

/** 수신자. **나가지 않는다** — 이 demo 에는 실발송 경로가 없다. */
const RECIPIENT = process.env['ATMARK_DEMO_RECIPIENT']?.trim() || P1B_DEMO_SEED_CONTACT;

/**
 * 소유자 롤 접속. 장면 ③ 의 **2차 방어선(트리거)** 게이트다.
 * 없으면 그 층은 돌지 않고, **돌지 않았다고 출력한다** (조용히 생략하지 않는다).
 */
const OWNER_URL =
  process.env['TEST_MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_MIGRATION_URL'] ?? '';

const failures: string[] = [];
const skipped: string[] = [];

function section(title: string): void {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

function note(text: string): void {
  console.log(`  │ ${text}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function skip(label: string, why: string): void {
  console.log(`  ⊘ ${label} — 건너뛴다: ${why}`);
  skipped.push(label);
}

function field(response: ApiResponse, key: string): unknown {
  return response.body[key];
}

function short(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 식별자는 앞뒤만 보인다. 장면 ② 의 B5 규율이 이 파일 전체에 걸려 있다(아래 참조). */
function elide(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * DB 가 돌려준 오류 문자열에서 `agentId` 를 가린다.
 *
 * 트리거의 `RAISE EXCEPTION` 은 옛 값과 새 값을 메시지에 싣는다 — 즉 **우리가 고르지
 * 않은 자리에서 식별자가 출력으로 샌다.** `did:web:…:agents:{agentId}` 이므로 그 값을
 * 그대로 내면 이 파일이 장면 ② 에서 안 낸 것을 여기서 내는 셈이 된다. B5 는 "DID 를
 * 안 찍는다" 가 아니라 **"게시 전 DID 가 외부 표면에 나가지 않는다"** 이고, 출력 경로가
 * 하나라도 열려 있으면 그 명제는 거짓이다.
 */
function redactAgentIds(message: string): string {
  return message.replace(/[0-9a-f]{32}/g, (id) => elide(id));
}

async function countOf(pool: Pool, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await pool.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? '-1');
}

// ---------------------------------------------------------------------------
// SQL 거부의 판정 — **메시지가 아니라 SQLSTATE 로 읽는다**
// ---------------------------------------------------------------------------

/**
 * 거부의 지문은 문자열이 아니라 **SQLSTATE** 다.
 *
 * `lc_messages` 는 서버 설정이고 기계마다 다를 수 있다. 메시지 정규식으로 판정하면
 * 로캘이 다른 기계에서 이 장면이 **거짓으로 초록**이 된다 — 거부는 실제로 일어났는데
 * 우리 정규식이 그것을 못 읽고, 반대로 정규식이 느슨하면 통과를 거부로 읽는다.
 * 코드는 표준이다: `42501` = insufficient_privilege, `23514` = check_violation
 * (트리거의 `RAISE ... USING ERRCODE`), `23505` = unique_violation.
 */
const SQLSTATE = {
  insufficientPrivilege: '42501',
  checkViolation: '23514',
  uniqueViolation: '23505',
} as const;

interface Rejection {
  readonly code: string | null;
  readonly message: string;
}

function sqlstateOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** 쿼리를 던지고 **거부되기를 기대한다**. 통과하면 `null` — 그것이 곧 장면의 실패다. */
async function rejected(pool: Pool, text: string, values: readonly unknown[] = []): Promise<Rejection | null> {
  try {
    await pool.query(text, [...values]);
    return null;
  } catch (error) {
    return {
      code: sqlstateOf(error),
      message: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// 장면 ① 멱등성
// ---------------------------------------------------------------------------

interface SendOptions {
  readonly token: string;
  readonly agentId: string;
  readonly from: string;
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
      to: [RECIPIENT],
      subject: options.subject,
      text: 'Atmark P1c demo — 같은 키로 세 번 불러도 이 본문은 한 번만 조립된다.\n',
      html: null,
      cost_cents: 0,
      trace_id: 'demo:p1c',
    },
  };
}

interface SceneOneInput {
  readonly pool: Pool;
  readonly tokens: ReturnType<typeof createPostgresAgentTokenStore>;
  readonly service: OutboundServiceDependencies;
  readonly transport: ReturnType<typeof createDemoTransport>;
  readonly provisioned: ProvisionedAgent;
  readonly suffix: string;
}

async function sceneIdempotency(input: SceneOneInput): Promise<void> {
  section('① 멱등성 — 같은 Idempotency-Key 로 3회 (§4.5-1 · AC-i1)');

  note('주장은 "재호출이 200 을 돌려준다" 가 아니다. 셋이 **동시에** 유지되는 것이다:');
  note('  SES 1회 · messages 1행 · audit 1행.');
  note('셋 중 하나만 보면 아무것도 증명되지 않는다 —');
  note('  • messages 1행만 보면: 한 행을 놓고 SES 를 세 번 부르는 구현이 통과한다(메일 3통).');
  note('  • SES 1회만 보면: 행을 3개 만들고 둘을 조용히 버리는 구현이 통과한다(기록이 어긋난다).');
  note('  • audit 1행만 보면: 기록을 남기지 않은 발송 2건이 통과한다(Principle P3 의 반대편).');
  note('그래서 판정은 셋을 한꺼번에 센다.');

  const { pool, tokens, service, transport, provisioned, suffix } = input;
  const agentId = provisioned.agent.id;
  const address = provisioned.address.address;
  const token = provisioned.token.plaintext;

  check(
    '전송단이 드라이런이다 — 이 demo 에는 실발송 분기가 없다',
    transport.mode() === 'dry_run',
    transport.mode(),
  );

  const key = `demo-p1c-idem-${suffix}`;
  const callsBefore = transport.sesSendCalls();

  const responses: ApiResponse[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // **순차 3회다.** 동시 100회는 `test/integration/outbound/idempotency.test.ts` 의
    // AC-i1 이 본다. 여기서 보려는 것은 경합이 아니라 **재호출의 결말**이다 — 첫 호출이
    // 이미 종단으로 끝난 뒤에 같은 키가 다시 오는 경로.
    const response = await handleSend(
      { tokens, service, transport },
      sendRequest({
        token,
        agentId,
        from: address,
        idempotencyKey: key,
        subject: `Atmark P1c demo (${suffix})`,
      }),
    );
    responses.push(response);
    console.log(
      `  호출 ${String(attempt)}: ${String(response.status)} replayed=${short(field(response, 'replayed'))} ` +
        `message_id=${elide(short(field(response, 'message_id')))}`,
    );
  }

  const messageIds = new Set(responses.map((response) => short(field(response, 'message_id'))));
  const messageId = [...messageIds][0] ?? '';

  check('3회 모두 200 이다', responses.every((response) => response.status === 200));
  check('3회의 message_id 가 하나다', messageIds.size === 1, `${String(messageIds.size)}개`);
  check(
    '2·3회차는 replayed 로 표시된다 — 새 평가도 새 발송도 없었다',
    responses[1] !== undefined &&
      responses[2] !== undefined &&
      field(responses[1], 'replayed') === true &&
      field(responses[2], 'replayed') === true,
  );

  const sesCalls = transport.sesSendCalls() - callsBefore;
  const messageRows = await countOf(
    pool,
    'SELECT count(*)::text AS count FROM messages WHERE agent_id = $1 AND idempotency_key = $2',
    [agentId, key],
  );
  const auditRows = await countOf(
    pool,
    'SELECT count(*)::text AS count FROM audit_logs WHERE message_id = $1',
    [messageId],
  );

  console.log(`  판정 셋: SES ${String(sesCalls)}회 · messages ${String(messageRows)}행 · audit ${String(auditRows)}행`);
  check('★ SES 1회 · messages 1행 · audit 1행이 **동시에** 성립한다',
    sesCalls === 1 && messageRows === 1 && auditRows === 1,
    `SES=${String(sesCalls)} messages=${String(messageRows)} audit=${String(auditRows)}`,
  );
}

// ---------------------------------------------------------------------------
// 장면 ② 프로비저닝 — 원자성이 주장이다
// ---------------------------------------------------------------------------

interface IdentityRow {
  readonly public_key: string;
  readonly algorithm: string;
  readonly key_ref: string;
  /**
   * **세 타임스탬프의 일치는 Postgres 안에서 판정한다.** JS 로 끌고 와서 비교하면
   * 안 된다 — `node-pg` 는 `timestamptz` 를 `Date` 로 파싱하고 `Date` 의 해상도는
   * **밀리초**라서, `now()` 의 마이크로초가 잘린다. 잘린 값으로 비교하면 서로 다른
   * 세 트랜잭션이 같은 밀리초에 떨어지기만 해도 이 단언이 통과한다 —
   * 실측으로 300회 중 264회가 그랬다. 즉 ms 비교는 원자성을 **거의 항상 통과시킨다.**
   */
  readonly same_transaction: boolean;
  /** 출력용. 비교에는 쓰지 않는다(위 주석 참조). µs 까지 보이도록 텍스트로 받는다. */
  readonly agent_created_at_text: string;
  readonly did: string;
  readonly status: string;
  readonly controller: string;
  readonly metadata_uri: string | null;
  readonly content_hash: string | null;
  readonly version: number;
}

/**
 * `insertPassport` 만 던지게 만든 저장소 — **원자성의 반대쪽을 보기 위한 주입**이다.
 *
 * 실패 지점을 keypair INSERT **뒤**에 두는 것이 요점이다. custody 단계에서 던지면
 * "키를 못 만들었으니 에이전트도 없다" 라는 시시한 결론만 나온다. 여기서 던지면
 * `agents` 행도 `agent_keypairs` 행도 **이미 INSERT 된 상태**이고, 그 둘이 사라지는지를
 * 본다. 그것이 §4B.1 의 *"같은 트랜잭션에서 생성되거나, 둘 다 생성되지 않는다"* 다.
 */
class InjectedProvisioningFailure extends Error {
  constructor() {
    super('주입된 실패 — passports INSERT 직전에 던진다 (demo:p1c 장면 ②)');
    this.name = 'InjectedProvisioningFailure';
  }
}

function failsAtPassportInsert(
  inner: ProvisioningStore,
  captureAgentId: (agentId: AgentId) => void,
): ProvisioningStore {
  return {
    withTransaction<T>(run: (tx: ProvisioningTransaction) => Promise<T>): Promise<T> {
      return inner.withTransaction((tx) =>
        run({
          ...tx,
          async insertAgent(agentInput) {
            // 롤백된 뒤에 그 id 로 행을 세려면 id 를 알아야 한다. 프로비저닝은 id 를
            // **트랜잭션 안에서** 만들고(§11B B5 와 같은 이유) 실패 시 돌려주지 않는다.
            captureAgentId(agentInput.id);
            return tx.insertAgent(agentInput);
          },
          insertPassport() {
            return Promise.reject(new InjectedProvisioningFailure());
          },
        }),
      );
    },
  };
}

async function sceneProvisioning(
  pool: Pool,
  ownerPool: Pool,
  provisioned: ProvisionedAgent,
  custodyKind: string,
  suffix: string,
): Promise<void> {
  section('② 프로비저닝 — DID·keypair 가 **같은 트랜잭션에서** 붙는다 (PP-A, §4B.1)');

  const agentId = provisioned.agent.id as AgentId;

  note('주장은 "keypair 가 생긴다" 가 아니라 **원자성**이다 — 둘 다 생기거나 둘 다 안 생긴다.');
  note(`키 보관소: ${custodyKind} (운영 경로는 KMS envelope → Secrets Manager 다)`);

  const row = await pool.query<IdentityRow>(
    `SELECT k.public_key, k.algorithm, k.key_ref,
            (a.created_at = k.created_at AND k.created_at = p.issued_at) AS same_transaction,
            a.created_at::text AS agent_created_at_text,
            p.did, p.status, p.controller, p.metadata_uri, p.content_hash, p.version
       FROM agents a
       JOIN agent_keypairs k ON k.agent_id = a.id
       JOIN passports p      ON p.agent_id = a.id
      WHERE a.id = $1`,
    [agentId],
  );
  const identity = row.rows[0];

  check('agent · keypair · passport 가 각각 1행씩 존재한다', row.rowCount === 1, `${String(row.rowCount)}행`);
  if (identity === undefined) return;

  // ── 같은 트랜잭션이었다는 **직접 증거** ───────────────────────────────────────
  //
  // Postgres 의 `now()` 는 `transaction_timestamp()` 다 — 한 트랜잭션 안에서 몇 번을
  // 불러도 같은 값이고, 트랜잭션이 다르면 (문장 사이에 시간이 흐르므로) 다르다.
  // 세 컬럼이 전부 DEFAULT now() 이므로 **값이 정확히 같다는 것이 곧 "한 트랜잭션"** 이다.
  // 행이 존재한다는 사실만으로는 이 명제가 나오지 않는다(나중에 붙였어도 존재한다).
  //
  // **"정확히" 가 하중을 받는 자리다.** 비교를 JS 로 가져오면 `Date` 가 µs 를 잘라
  // 이 단언이 사실상 아무것도 막지 못한다(`IdentityRow.same_transaction` 주석의 실측).
  // 그래서 비교는 µs 가 살아 있는 쪽 — Postgres — 에서 하고 불리언만 받아 온다.
  check(
    '★ agents.created_at = agent_keypairs.created_at = passports.issued_at — now() 는 트랜잭션 상수다 (µs 비교)',
    identity.same_transaction,
    identity.agent_created_at_text,
  );

  check(
    'public_key 가 base64url 43자다 — ed25519 원시 32바이트 = JWK 의 x 그대로',
    /^[A-Za-z0-9_-]{43}$/.test(identity.public_key),
    `${identity.public_key.slice(0, 8)}…(${String(identity.public_key.length)}자)`,
  );
  check('algorithm 이 ed25519 다 (§3.5 — AC-11 의 외부 라이브러리 호환성)', identity.algorithm === 'ed25519');
  check(
    'key_ref 는 **참조뿐**이다 — 개인키도 암호문도 DB 에 없다 (AC-e1)',
    /^(awssm|devfile):\/\//.test(identity.key_ref),
    identity.key_ref.split('://')[0] + '://…',
  );
  check('passport 가 draft 다 — PP-A 는 게시하지 않는다 (§4B.2)', identity.status === 'draft', identity.status);
  check(`passport.version = ${String(INITIAL_PASSPORT_VERSION)}`, identity.version === INITIAL_PASSPORT_VERSION);
  check('controller 가 Atmark 조직 DID 다', identity.controller === ATMARK_CONTROLLER_DID, identity.controller);
  check(
    'content_hash · metadata_uri 는 아직 비어 있다 — 채우는 것은 P6 의 게시다',
    identity.content_hash === null && identity.metadata_uri === null,
  );

  // ── B5 — 게시 전 DID 는 출력하지 않는다 ──────────────────────────────────────
  //
  // **데모 출력도 외부 표면이다.** ADR-0002 B5 는 `status != 'published'` 인 passport 의
  // `did` 를 "어떤 외부 표면에도 직렬화하지 않는다" 고 쓴다 — 대시보드도 로그도 그
  // 목록에 있고, 사람이 읽는 터미널 출력은 스크린샷이 되어 티켓에 붙는다.
  //
  // 이유는 그 DID 가 **P6 까지 7~10개월간 404** 이기 때문이다. 받은 쪽은 그것을 검증하려
  // 시도하고 실패하며, 그 실패를 "이 에이전트는 가짜" 로 읽는다. 해석되지 않는 DID 는
  // DID 가 없는 것보다 나쁘다.
  //
  // 그래서 이 장면은 **존재 사실과 형태만** 낸다. 값의 정합성은 출력하지 않고 **대조만**
  // 한다 — `didForAgent(agentId)` 와 같은지는 불리언으로 답할 수 있고, 그 불리언은
  // 외부 표면이 아니다.
  note('B5 — 아래 세 줄에 DID 문자열은 없다. 게시 전 DID 는 출력하지 않는다 (ADR-0002).');
  check(
    'DID 가 존재한다 — 형태만 낸다',
    identity.did.startsWith(DID_WEB_PREFIX),
    `접두사 "${DID_WEB_PREFIX}" + ${String(identity.did.length - DID_WEB_PREFIX.length)}자, 총 ${String(identity.did.length)}자`,
  );
  check(
    'DB 의 DID 가 did.ts 의 조립과 일치한다 — **값이 아니라 일치 여부만** 낸다',
    identity.did === didForAgent(agentId),
  );
  check(
    '★ externalDidOf 가 null 이다 — draft 의 DID 는 외부 표면으로 나가지 않는다 (B5 집행점)',
    externalDidOf({ did: identity.did, status: 'draft' }) === null,
  );
  check(
    'ProvisionedAgent 에 passport 자리가 없다 — 타입이 유출 경로를 지운다',
    !Object.prototype.hasOwnProperty.call(provisioned, 'passport'),
    `필드: ${Object.keys(provisioned).join(', ')}`,
  );

  // ── 원자성의 반대쪽 — 실패 주입 ──────────────────────────────────────────────
  //
  // **원자성 주장의 하중은 여기에 쏠려 있다.** 위의 타임스탬프 일치는 µs 비교로 고친 뒤에도
  // *필요조건*일 뿐이다 — "같은 순간에 태어났다" 는 "하나가 실패하면 나머지도 사라진다" 를
  // 함의하지 않는다. 전부-또는-전무를 실제로 판정하는 것은 실패를 주입하는 이쪽 반이다.
  // 둘 중 하나를 지워야 한다면 위가 아니라 **이쪽이 남아야 한다.**
  section('②-b 원자성의 반대쪽 — passports INSERT 를 던지게 하면 **아무것도 남지 않는다**');

  note('keypair INSERT 는 이미 성공한 뒤다. 그 행까지 사라져야 "전부 또는 전무" 가 참이다.');

  let rolledBackAgentId: AgentId | null = null;
  const orgName = `atmark-demo-p1c-rollback-${suffix}`;
  let thrown: unknown = null;
  try {
    await provisionAgent(
      failsAtPassportInsert(createPostgresProvisioningStore(ownerPool), (id) => {
        rolledBackAgentId = id;
      }),
      {
        organization: { kind: 'create', name: orgName, ownerEmail: 'owner@example.com' },
        agentName: `demo-agent-rollback-${suffix}`,
        addressLocalPart: `demo-rollback-${suffix}`,
        seedContacts: [RECIPIENT],
        monthlyBudgetCents: 10_000,
        createdBy: 'demo:p1c',
        tokenCapabilities: null,
        // P1 데모의 모드를 명시한다(정책 v2 의 기본값과 같지만 — ADR-0007 — 이 데모의 거부 장면이 그 모드에 달려 있다).
        outboundMode: 'allowlist_only',
      },
      createLocalDevKeyCustody(),
    );
  } catch (error) {
    thrown = error;
  }

  check(
    '프로비저닝이 던졌다 — 주입한 실패가 실제로 경로 위에 있었다',
    thrown instanceof InjectedProvisioningFailure,
    thrown instanceof Error ? thrown.name : String(thrown),
  );
  check('실패 지점보다 앞에서 agents 행이 실제로 만들어졌다', rolledBackAgentId !== null);

  if (rolledBackAgentId !== null) {
    const ghost: AgentId = rolledBackAgentId;
    const agents = await countOf(pool, 'SELECT count(*)::text AS count FROM agents WHERE id = $1', [ghost]);
    const keypairs = await countOf(
      pool,
      'SELECT count(*)::text AS count FROM agent_keypairs WHERE agent_id = $1',
      [ghost],
    );
    const passports = await countOf(pool, 'SELECT count(*)::text AS count FROM passports WHERE agent_id = $1', [
      ghost,
    ]);
    const orgs = await countOf(pool, 'SELECT count(*)::text AS count FROM organizations WHERE name = $1', [
      orgName,
    ]);

    check(
      '★ agents 0행 · agent_keypairs 0행 · passports 0행 — 둘 다 안 생겼다',
      agents === 0 && keypairs === 0 && passports === 0,
      `agents=${String(agents)} keypairs=${String(keypairs)} passports=${String(passports)}`,
    );
    check('조직 행도 남지 않았다 — 경계는 프로비저닝 전체다', orgs === 0, `${String(orgs)}행`);
    note(
      '남은 것은 custody 에 보관된 **아무도 참조하지 않는 개인키 파일 하나**다. ' +
        'keypair.ts 가 그 순서를 고른 이유이고(참조 없는 비밀 < 비밀 없는 참조), 그 비용이 여기 보인다.',
    );
  }
}

// ---------------------------------------------------------------------------
// 장면 ③ 키 불변성 — 네 구멍, 두 층
// ---------------------------------------------------------------------------

interface Hole {
  /** §4B.1 표의 행 번호. */
  readonly id: string;
  readonly label: string;
  /** 이 구멍이 왜 위험한가. 한 줄. */
  readonly why: string;
  readonly emphasis: boolean;
  readonly sql: string;
  readonly values: (agentId: AgentId, spareKey: string) => readonly unknown[];
  /** 앱 롤에서 기대하는 SQLSTATE. `42501` = 권한(1차), `23514` = 트리거(2차), `23505` = 유니크. */
  readonly appState: string;
  /** 앱 롤에서 무엇이 막았는가(출력용). */
  readonly appLayer: string;
  /** 소유자 롤에서 기대하는 SQLSTATE. 권한을 건너뛰므로 트리거가 유일한 방어선이다. */
  readonly ownerState: string;
}

const HOLES: readonly Hole[] = [
  {
    id: '②',
    label: 'key_ref UPDATE',
    why:
      '공개키는 그대로 두고 Secrets Manager 포인터만 바꾼다. 침해 대응 시 **가장 자연스러운 동작**이고, ' +
      '결과는 발급된 전 서명의 조용한 무효화다 — 겉보기엔 아무것도 안 바뀌었는데 검증이 전부 깨진다.',
    emphasis: true,
    sql: 'UPDATE agent_keypairs SET key_ref = $2 WHERE agent_id = $1',
    values: (agentId) => [agentId, 'awssm://arn:aws:secretsmanager:ap-northeast-2:0:secret:rotated'],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
  {
    id: '—',
    label: 'public_key UPDATE',
    why: '키 자체의 교체. 가장 눈에 띄는 형태이고, 그래서 가장 덜 위험하다.',
    emphasis: false,
    sql: 'UPDATE agent_keypairs SET public_key = $2 WHERE agent_id = $1',
    values: (_agentId, spareKey) => [_agentId, spareKey],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
  {
    id: '③',
    label: 'algorithm UPDATE (**값이 같아도**)',
    why:
      '검증 경로 불일치. 행 전체 불변이라 "바뀐 컬럼이 없는 UPDATE" 도 거부된다 — 컬럼 열거(deny-list) ' +
      '방식이었다면 이 경로가 통과하고, 그 통과가 곧 나중에 추가되는 컬럼의 구멍이 된다.',
    emphasis: false,
    sql: `UPDATE agent_keypairs SET algorithm = 'ed25519' WHERE agent_id = $1`,
    values: (agentId) => [agentId],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
  {
    id: '①',
    label: 'DELETE',
    why: 'UPDATE 거부를 우회해 키 교체와 **같은 효과**를 낸다. DELETE + INSERT 는 한 쌍이다.',
    emphasis: false,
    sql: 'DELETE FROM agent_keypairs WHERE agent_id = $1',
    values: (agentId) => [agentId],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
  {
    id: '①',
    label: 'DELETE 뒤의 재INSERT (두 번째 keypair)',
    why:
      'DELETE 가 막혀도 "그냥 하나 더 넣는" 경로가 남으면 회전은 성립한다. ' +
      '**202609230750(2차 검증 H-B)이 앱 롤의 keypair INSERT 를 거뒀다**(프로비저닝은 CLI·admin 만) — 그래서 앱 롤은 ' +
      '권한(1차)에서 막히고, 권한을 가진 롤(소유자)은 agent_id PK(**키 설계**)가 막는다.',
    emphasis: false,
    sql: `INSERT INTO agent_keypairs (agent_id, public_key, algorithm, key_ref)
          VALUES ($1, $2, 'ed25519', $3)`,
    values: (agentId, spareKey) => [agentId, spareKey, `devfile://${agentId}-2`],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.uniqueViolation,
  },
  {
    id: '④',
    label: 'agents.id UPDATE',
    why:
      '키를 그대로 두고 **식별자 쪽을 움직인다.** 예전엔 이 구멍만 1차 방어선이 없었다 — 앱이 status 전이로 ' +
      'agents 를 갱신했기 때문이다. **202609230730(ADR-0006 보강)이 앱 롤의 agents UPDATE 를 0으로 좁혔다** ' +
      '(활성화는 프로비저닝 소유자 롤이, 정지·kill-switch 는 admin 롤·CLI 소유자 롤이 한다) — 그래서 이제는 ' +
      '이 구멍도 나머지와 같이 권한(1차)에서 막힌다.',
    emphasis: false,
    sql: 'UPDATE agents SET id = $2 WHERE id = $1',
    values: (agentId) => [agentId, 'ffffffffffffffffffffffffffffffff'],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
  {
    id: '—',
    label: 'TRUNCATE (행 트리거가 보지 못하는 경로)',
    why: '행 트리거는 TRUNCATE 에 발화하지 않는다. 문장 트리거만이 이 경로를 막는다.',
    emphasis: false,
    sql: 'TRUNCATE agent_keypairs',
    values: () => [],
    appState: SQLSTATE.insufficientPrivilege,
    appLayer: '권한(1차)',
    ownerState: SQLSTATE.checkViolation,
  },
];

/** 공개키 자리에 들어갈 수 있는 값(base64url 43자). 내용은 의미 없다 — 형식만 맞으면 된다. */
function spareKeyMaterial(): string {
  return randomBytes(32).toString('base64url');
}

async function sceneKeyImmutability(appPool: Pool, agentId: AgentId): Promise<void> {
  section('③ 키·식별자 불변 — §4B.1 의 네 구멍 전부가 DB 에서 거부된다');

  note('이 장면이 존재하는 이유는 **key_ref** 다(아래 ★). 나머지 셋은 눈에 띄는 형태의 같은 사고다.');
  note('방어는 두 층이다:');
  note('  1차 — 권한. 앱 롤(atmark_app)에 UPDATE·DELETE·TRUNCATE 가 없다 → 트리거에 **도달조차 안 한다**(42501).');
  note('  2차 — 트리거. 권한이 GRANT ALL 로 넓어져도 막는다(23514). 그 한 줄은 "권한 오류를 고치려고" 실제로 일어난다.');
  note('1차만 있으면 GRANT 한 줄이 보증을 지우고, 2차만 있으면 앱이 트리거까지 도달하는 경로가 열려 있다는 뜻이다.');

  const spareKey = spareKeyMaterial();

  console.log('\n  [1차 — 앱 롤 atmark_app]');
  for (const hole of HOLES) {
    const outcome = await rejected(appPool, hole.sql, hole.values(agentId, spareKey));
    const ok = outcome !== null && outcome.code === hole.appState;
    check(
      `${hole.emphasis ? '★ ' : ''}${hole.id} ${hole.label}`,
      ok,
      outcome === null
        ? '**통과했다** — 구멍이 열려 있다'
        : `SQLSTATE ${String(outcome.code)} / ${hole.appLayer}`,
    );
    if (hole.emphasis) note(hole.why);
  }

  console.log('\n  [2차 — 소유자 롤 (권한을 건너뛰고 트리거만 남긴다)]');
  if (OWNER_URL.trim() === '') {
    skip(
      '2차 방어선(트리거) 전건',
      'TEST_MIGRATION_DATABASE_URL 이 없다. **트리거가 없다는 뜻이 아니라, 이 실행이 그것을 보지 않았다는 뜻이다.** ' +
        '켜려면: TEST_MIGRATION_DATABASE_URL=postgres://<owner>@localhost:5432/atmark',
    );
    note('1차만 본 상태에서는 "GRANT ALL 한 줄이 보증을 지우는가" 에 이 실행이 답하지 못한다.');
  } else {
    const ownerPool = createPool(OWNER_URL, { max: 2 });
    try {
      const ownerSpare = spareKeyMaterial();
      for (const hole of HOLES) {
        const outcome = await rejected(ownerPool, hole.sql, hole.values(agentId, ownerSpare));
        const ok = outcome !== null && outcome.code === hole.ownerState;
        check(
          `${hole.emphasis ? '★ ' : ''}${hole.id} ${hole.label}`,
          ok,
          outcome === null
            ? '**통과했다** — 트리거가 자고 있다'
            : `SQLSTATE ${String(outcome.code)} / ${redactAgentIds(outcome.message)}`,
        );
      }

      // passports 쪽도 같은 규율이다 — 삭제는 "이 DID 는 존재한 적 없다" 로 읽히고,
      // §4B.1b 는 그것을 사칭보다 나쁜 실패 모드라고 부른다.
      const passportDelete = await rejected(ownerPool, 'DELETE FROM passports WHERE agent_id = $1', [agentId]);
      check(
        'passports DELETE 도 거부된다 — 삭제는 사칭보다 나쁜 실패 모드다 (§4B.1b)',
        passportDelete !== null && passportDelete.code === SQLSTATE.checkViolation,
        passportDelete === null ? '**통과했다**' : `SQLSTATE ${String(passportDelete.code)}`,
      );
      const didUpdate = await rejected(ownerPool, 'UPDATE passports SET did = $2 WHERE agent_id = $1', [
        agentId,
        'did:web:evil.example:agents:deadbeefdeadbeefdeadbeefdeadbeef',
      ]);
      check(
        'passports.did UPDATE 도 거부된다 — 경로 스킴 동결의 마지막 집행점 (ADR-0002)',
        didUpdate !== null && didUpdate.code === SQLSTATE.checkViolation,
        didUpdate === null ? '**통과했다**' : `SQLSTATE ${String(didUpdate.code)}`,
      );
    } finally {
      await ownerPool.end();
    }
  }
}

// ---------------------------------------------------------------------------
// 장면 ④ ADR-0004 — "그 메일은 나갔는가"
// ---------------------------------------------------------------------------

interface EvidenceHarness {
  readonly pool: Pool;
  readonly service: OutboundServiceDependencies;
  readonly provisioned: ProvisionedAgent;
  readonly suffix: string;
}

/**
 * **"transport 직후 프로세스 사망" 을 재현한다.**
 *
 * `dispatch` 는 전송을 마치고 결과를 **반환**하지만, 그 결과를 `messages` 행에 확정하는
 * 것은 `finalizeOutbound` 다(관문은 저장하지 않는다). 그러므로 `finalizeOutbound` 를
 * 부르지 않는 것이 정확히 그 시나리오다 — 메일은 나갔고, 행은 `dispatching` 이며,
 * `ses_message_id` 는 **비어 있다**. ADR-0004 가 다루는 유일한 경로다.
 */
async function sendThenDie(
  harness: EvidenceHarness,
  deps: GateDependencies,
  idempotencyKey: string,
): Promise<DispatchRequest> {
  const prepared = await prepareOutbound(harness.service, {
    routeId: 'send',
    agentId: harness.provisioned.agent.id,
    idempotencyKey,
    fromAddress: harness.provisioned.address.address,
    recipients: [RECIPIENT],
    subject: `Atmark P1c demo — 전송 직후 사망 (${idempotencyKey})`,
    text: 'transport 는 성공했고 그 결과를 기록하기 전에 프로세스가 죽는다.\n',
    html: null,
    isThreadReply: false,
    traceId: 'demo:p1c',
    costCents: 0,
  });
  if (prepared.kind !== 'ready') {
    throw new Error(`prepareOutbound 가 ready 가 아니다: ${JSON.stringify(prepared.outcome)}`);
  }
  const outcome = await dispatch(deps, prepared.dispatchRequest);
  if (outcome.kind !== 'sent') {
    throw new Error(`첫 발송이 sent 가 아니다: ${outcome.kind}`);
  }
  // **여기서 죽는다.** finalizeOutbound 를 부르지 않는다.
  return prepared.dispatchRequest;
}

async function statusOf(pool: Pool, messageId: string): Promise<{ status: string; ses: string | null }> {
  const result = await pool.query<{ status: string; ses_message_id: string | null }>(
    'SELECT status, ses_message_id FROM messages WHERE id = $1',
    [messageId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`messages 행이 없다 (id=${messageId})`);
  return { status: row.status, ses: row.ses_message_id };
}

/** SES 가 실제로 발행하는 모양의 `Send` 이벤트 한 건. **우리 헤더는 어디에도 없다.** */
function sesSendEventPayload(ourMessageId: string, sesMessageId: string, at: Date): string {
  return JSON.stringify({
    eventType: 'Send',
    mail: {
      timestamp: at.toISOString(),
      // **SES 가 부여한 값이다.** 우리가 전송 전에 정한 `Message-ID` 헤더는 여기 없다 —
      // SES 가 덮어썼기 때문이고, 그 사실이 ADR-0004 의 출발점이다.
      messageId: sesMessageId,
      source: 'agent@atmark.ai',
      tags: {
        'ses:configuration-set': ['atmark'],
        // ★ 우리가 **보내기 전에** 실은 값. SES 가 무엇을 덮어쓰든 이것은 돌아온다.
        [ATMARK_MESSAGE_ID_TAG]: [ourMessageId],
      },
    },
    send: {},
  });
}

async function sceneSendEvidence(harness: EvidenceHarness): Promise<void> {
  section('④ ADR-0004 — lease 만료 재전송 **전에** 증거를 조회한다');

  note('계획 §6 P1c 의 demo 문장에 이 장면은 없다. ADR-0004 가 P1c **착수 시**의 결정이기 때문이다.');
  note('없으면 가장 최근에 내린 결정이 실연되지 않은 채 남고, 중복 발송의 원인이 "DB 가 잠깐 느렸다" 가 된다.');

  const { pool, service, suffix } = harness;
  const events = createPostgresSesEventStore(pool);

  // ── ④-a 조인 키 ────────────────────────────────────────────────────────────
  console.log('\n  ④-a 조인 키 — SES 가 Message-ID 를 덮어써도 우리 행으로 돌아온다');

  const tagTransport = createDemoTransport({ content: service.content, realSend: false, pool: null });
  const tagDeps = gateDependenciesFor(service, tagTransport);
  const evidenceRequest = await sendThenDie(harness, tagDeps, `demo-p1c-evidence-${suffix}`);
  const evidenceMessageId = evidenceRequest.messageId ?? '';

  const before = await statusOf(pool, evidenceMessageId);
  check(
    '전송 직후 사망: 행은 dispatching 이고 ses_message_id 는 **비어 있다**',
    before.status === 'dispatching' && before.ses === null,
    `${before.status} / ses_message_id=${String(before.ses)}`,
  );
  note('이 상태가 ADR-0004 의 전부다 — "그 메일은 나갔는가" 에 우리 손에 있는 것으로는 답할 수 없다.');

  const sesMessageId = `0100${randomUUID().replace(/-/g, '')}-demo@ap-northeast-2.amazonses.com`;
  const payload = sesSendEventPayload(evidenceMessageId, sesMessageId, new Date());
  const parsed = parseSesEvent(payload, ATMARK_MESSAGE_ID_TAG);

  check(
    '우리 Message-ID 헤더는 이벤트 어디에도 없다 — SES 가 덮어썼다',
    !payload.includes(evidenceRequest.messageIdHeader.replace(/[<>]/g, '')),
    evidenceRequest.messageIdHeader,
  );
  check('이벤트가 파싱된다', parsed.kind === 'event', parsed.kind);
  if (parsed.kind !== 'event') return;
  check(
    `★ ${ATMARK_MESSAGE_ID_TAG} 태그가 우리 message_id 를 그대로 돌려준다`,
    parsed.event.messageId === evidenceMessageId,
    `${elide(short(parsed.event.messageId))} ← ${elide(evidenceMessageId)}`,
  );

  check('소비자가 그 이벤트를 기록한다', (await events.record(parsed.event)) === 'recorded');
  check(
    '같은 이벤트의 재전달은 duplicate 다 — 멱등성의 집행은 유니크 인덱스다 (SNS/SQS 는 at-least-once)',
    (await events.record(parsed.event)) === 'duplicate',
  );

  // ── ④-b 증거가 있으면 재전송하지 않는다 ─────────────────────────────────────
  console.log('\n  ④-b 증거가 있다 → 재전송하지 않고 sent 로 확정한다');

  const afterExpiry = new Date(evidenceRequest.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000);
  const retryRequest: DispatchRequest = { ...evidenceRequest, now: afterExpiry, leaseId: randomUUID() };
  const retry = await dispatch(tagDeps, retryRequest);

  check(
    '★ SES 호출이 늘지 않았다 — lease 는 만료됐는데 재전송하지 않았다',
    tagTransport.sesSendCalls() === 1,
    `${String(tagTransport.sesSendCalls())}회`,
  );
  check('결말이 sent 다', retry.kind === 'sent', retry.kind);
  if (retry.kind === 'sent') {
    check('확정에 쓰인 ses_message_id 가 이벤트의 것이다', retry.sesMessageId === sesMessageId);
    await finalizeOutbound(service, { dispatchRequest: retryRequest }, retry);
    const settled = await statusOf(pool, evidenceMessageId);
    check(
      '행이 종단으로 확정됐다 — dispatching 으로 영원히 남지 않는다',
      settled.status === 'sent' && settled.ses === sesMessageId,
      settled.status,
    );
  }

  // ── ④-c 증거가 없으면 재전송한다 ────────────────────────────────────────────
  console.log('\n  ④-c 증거가 **없다** → 만료 후 같은 Message-ID 로 재전송한다 (AC-i3 의 나머지 절반)');
  note('조회가 무조건 막는 장치라면 AC-i3 의 절반이 죽는다. 조회는 답을 얻는 장치이지 제동장치가 아니다.');

  const noneTransport = createDemoTransport({ content: service.content, realSend: false, pool: null });
  const noneDeps = gateDependenciesFor(service, noneTransport);
  const noneRequest = await sendThenDie(harness, noneDeps, `demo-p1c-none-${suffix}`);
  const noneRetry = await dispatch(noneDeps, {
    ...noneRequest,
    now: new Date(noneRequest.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000),
    leaseId: randomUUID(),
  });

  check('재전송됐다 — SES 호출 2회', noneTransport.sesSendCalls() === 2, `${String(noneTransport.sesSendCalls())}회`);
  check('결말이 sent 다', noneRetry.kind === 'sent', noneRetry.kind);
  const headerRow = await pool.query<{ message_id_header: string }>(
    'SELECT message_id_header FROM messages WHERE id = $1',
    [noneRequest.messageId],
  );
  check(
    '같은 Message-ID 헤더로 나갔다 — 그 컬럼은 트리거가 불변으로 잠근다',
    headerRow.rows[0]?.message_id_header === noneRequest.messageIdHeader,
  );

  // ── ④-d 핵심 명제 ──────────────────────────────────────────────────────────
  console.log('\n  ④-d ★ 조회가 **던지면** 재전송을 유보한다 — 조회 실패를 "안 나갔다" 로 읽지 않는다');
  note('`null`(조회 성공 · 증거 없음)과 예외(답을 못 얻음)는 다른 값이고, 관문은 둘을 다르게 다룬다.');
  note('둘을 같게 다루면 **중복 발송의 원인이 "DB 가 잠깐 느렸다"** 가 된다 — 수신자가 겪는 일은 오발송과 같다.');

  const brokenTransport = createDemoTransport({ content: service.content, realSend: false, pool: null });
  const healthyDeps = gateDependenciesFor(service, brokenTransport);
  const brokenRequest = await sendThenDie(harness, healthyDeps, `demo-p1c-lookup-fail-${suffix}`);

  const broken: SendEvidenceLookup = {
    findSendEvidence: () => Promise.reject(new Error('db down (demo:p1c 주입)')),
  };
  const brokenRetry = await dispatch(
    { ...healthyDeps, sendEvidence: broken },
    {
      ...brokenRequest,
      now: new Date(brokenRequest.now.getTime() + (LEASE_TTL_SECONDS + 60) * 1000),
      leaseId: randomUUID(),
    },
  );

  check(
    '★ SES 호출이 늘지 않았다 — 조회 실패가 두 번째 메일을 만들지 않는다',
    brokenTransport.sesSendCalls() === 1,
    `${String(brokenTransport.sesSendCalls())}회`,
  );
  check('결말이 duplicate_suppressed 다 — 판단을 유보했다', brokenRetry.kind === 'duplicate_suppressed', brokenRetry.kind);
  const unresolved = await statusOf(pool, brokenRequest.messageId ?? '');
  check(
    '행은 dispatching 으로 남는다 — 그 상태가 곧 "아직 모른다" 다',
    unresolved.status === 'dispatching',
    unresolved.status,
  );
  note('새 lease 를 쥐었으므로 TTL 만큼 다시 잠긴다. 그 시간이 소비자가 따라잡을 시간을 산다.');

  // 미배선도 같은 방향으로 실패한다 — 느슨해지는 쪽이 아니라 막히는 쪽.
  const { sendEvidence: _omitted, ...unwired } = healthyDeps;
  const unwiredRetry = await dispatch(unwired, {
    ...brokenRequest,
    now: new Date(brokenRequest.now.getTime() + 2 * (LEASE_TTL_SECONDS + 60) * 1000),
    leaseId: randomUUID(),
  });
  check(
    '이벤트 평면 **미배선**도 같은 방향으로 실패한다 (fail closed)',
    unwiredRetry.kind === 'duplicate_suppressed' && brokenTransport.sesSendCalls() === 1,
    `${unwiredRetry.kind} / SES ${String(brokenTransport.sesSendCalls())}회`,
  );

  // ── ④-e 소비자 정지 ────────────────────────────────────────────────────────
  console.log('\n  ④-e 소비자가 죽으면 조회는 **영원히 비고**, 우리는 그것을 "안 나갔다" 로 읽는다');
  note('ADR-0004 Consequences 가 닫지 못한 채 남긴 창이다. 정지는 아무것도 만들지 않으므로 조용하다 —');
  note('보이는 것은 ses_events 가 늘지 않는다는 사실뿐이고, 그것은 **트래픽이 없을 때와 정확히 같은 모양**이다.');
  note(`그래서 절대 시각이 아니라 **대조**로 판정한다(유예 ${String(CONSUMER_STALE_AFTER_SECONDS)}초).`);

  const now = new Date();
  const live = evaluateConsumerHealth(await events.freshness(), now);
  check(
    '이 실행의 실제 판정 — 방금 이벤트를 기록했으므로 ok 여야 한다',
    live.kind === 'ok',
    live.kind === 'stalled' ? `stalled(${String(live.staleSeconds)}초)` : live.kind,
  );

  const idle = evaluateConsumerHealth({ lastSentAt: null, lastEventAt: null }, now);
  const stalled = evaluateConsumerHealth(
    {
      lastSentAt: new Date(now.getTime() - 3 * CONSUMER_STALE_AFTER_SECONDS * 1000),
      lastEventAt: new Date(now.getTime() - 9 * CONSUMER_STALE_AFTER_SECONDS * 1000),
    },
    now,
  );
  check('한 통도 안 나갔으면 idle 이다 — **정지가 아니다**(신규 배포 첫날 알람 금지)', idle.kind === 'idle', idle.kind);
  check(
    '나간 메일이 있는데 그 뒤로 이벤트가 없으면 stalled 다',
    stalled.kind === 'stalled',
    stalled.kind === 'stalled' ? `${String(stalled.staleSeconds)}초 경과` : stalled.kind,
  );
  note('셋이 구별되지 않으면 조회 결과의 "비어 있음" 두 원인이 한 값으로 접힌다 — 대응이 정반대인 둘이다.');
}

// ---------------------------------------------------------------------------
// 장면 ⑤ 알람 대시보드
// ---------------------------------------------------------------------------

interface CfnResource {
  readonly Type?: string;
  readonly Properties?: Record<string, unknown>;
}

interface CfnTemplate {
  readonly Resources?: Record<string, CfnResource>;
}

/**
 * 스택을 실제로 synth 해 템플릿 JSON 을 **디스크에서 읽는다.**
 *
 * `productionTrafficExpected` 는 `infra/cdk/app.ts` 가 넘기는 값과 같은 `false` 다 —
 * 지금 배포한다면 나올 산출물을 보이는 것이 이 장면의 목적이기 때문이다.
 * (P1c 는 배포하지 않는다. `cdk synth` 까지다.)
 */
function synthAlarms(productionTrafficExpected: boolean): CfnTemplate {
  const outdir = mkdtempSync(join(tmpdir(), 'atmark-demo-p1c-synth-'));
  const app = new cdk.App({ outdir });
  new ObservabilityStack(app, 'AtmarkObservability', {
    env: { account: '000000000000', region: 'ap-northeast-2' },
    productionTrafficExpected,
  });
  const assembly = app.synth();
  return JSON.parse(
    readFileSync(join(assembly.directory, 'AtmarkObservability.template.json'), 'utf8'),
  ) as CfnTemplate;
}

interface AlarmFacts {
  readonly namespace: string;
  readonly metric: string;
  readonly statistic: string;
  readonly period: number;
  readonly comparison: string;
  readonly threshold: number;
  readonly missing: string;
  readonly actionsEnabled: boolean;
}

/**
 * 식 알람(24·26·27 — metric math)은 `MetricName` 대신 `Metrics` 배열을 갖는다. 반환 식(`ReturnData` 가 false 가 아닌 항목)의 라벨·기간을 읽는다 —
 * 읽지 않으면 표에 `undefined:undefined` 와 `NaN` 이 찍힌다.
 */
function returnedExpression(properties: Record<string, unknown>): { readonly label: string; readonly period: number } | null {
  const metrics = properties['Metrics'];
  if (!Array.isArray(metrics)) return null;
  const returned = (metrics as Record<string, unknown>[]).find((item) => item['ReturnData'] !== false && 'Expression' in item);
  if (returned === undefined) return null;
  // 입력 메트릭이 있는 식(24)은 식에 `Period` 가 없고 입력의 `MetricStat.Period` 가 기간이다.
  const inputPeriod = (metrics as Record<string, unknown>[])
    .map((item) => (item['MetricStat'] as { Period?: unknown } | undefined)?.Period)
    .find((period) => period !== undefined);
  return { label: String(returned['Label'] ?? returned['Expression']), period: Number(returned['Period'] ?? inputPeriod) };
}

function alarmsOf(template: CfnTemplate): Map<string, AlarmFacts> {
  const out = new Map<string, AlarmFacts>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource.Type !== 'AWS::CloudWatch::Alarm') continue;
    const properties = resource.Properties ?? {};
    const name = properties['AlarmName'];
    const enabled = properties['ActionsEnabled'];
    const expression = returnedExpression(properties);
    out.set(typeof name === 'string' ? name : logicalId, {
      namespace: expression === null ? String(properties['Namespace']) : 'math',
      metric: expression === null ? String(properties['MetricName']) : expression.label,
      statistic: expression === null ? String(properties['Statistic']) : 'expression',
      period: expression === null ? Number(properties['Period']) : expression.period,
      comparison: String(properties['ComparisonOperator']),
      threshold: Number(properties['Threshold']),
      missing: String(properties['TreatMissingData']),
      // CDK 는 기본값(true)이면 속성을 아예 내보내지 않는다.
      actionsEnabled: typeof enabled === 'boolean' ? enabled : true,
    });
  }
  return out;
}

const COMPARISON_SYMBOL: Readonly<Record<string, string>> = {
  GreaterThanOrEqualToThreshold: '>=',
  GreaterThanThreshold: '>',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '<=',
};

function periodLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)}일`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}시간`;
  return `${String(seconds / 60)}분`;
}

/**
 * 임계값의 **근거**. 숫자만 내면 다음 사람은 그게 왜 그 숫자인지 모르고,
 * 모르는 숫자는 "조금 완화" 되기 쉽다 — 알람이 죽는 가장 흔한 방식이다.
 */
const ALARM_ORDER: readonly { readonly name: string; readonly what: string; readonly basis: string }[] = [
  {
    name: 'atmark-audit-resolve-failure',
    what: '메일은 나갔는데 법적 기록에 구멍이 났다',
    basis: '§4.3 은 "시도당 **정확히** 1행". 등식이므로 1건이 곧 위반이다 — 임계값이 1인 이유.',
  },
  {
    name: 'atmark-warmup-cap-breached',
    what: '워밍업 캡이 뚫렸다 (R22 의 마지막 제동장치)',
    basis:
      `추정이 아니라 **코드 상수** WARMUP_STEADY_STATE_DAILY_CAP(${String(WARMUP_STEADY_STATE_DAILY_CAP)}) 을 ` +
      'import 한다. 캡이 집행되는 한 구조적으로 도달 불가 — 울렸다 = 제동장치가 없었다. ' +
      'SES 계정 한도는 50,000/day 다. 눈금은 메일 수가 아니라 **수신자 수**.',
  },
  {
    name: 'atmark-dispatch-serialization-unavailable',
    what: '평가~lease 구간을 못 잠근다 → fail-closed 전건 차단',
    basis:
      'advisory lock 경합·풀 회수 지연으로 1건은 회복 가능한 정상 범위다. ' +
      `${String(SERIALIZATION_FAILURE_THRESHOLD)}건/5분은 그 설명이 더는 통하지 않는 지점.`,
  },
  {
    name: 'atmark-ses-bounce-rate',
    what: 'bounce 율 — SES 계정 정지로 직결',
    basis:
      `AWS SES 가 계정을 **검토 대상**에 올리는 선이 ${String(SES_BOUNCE_REVIEW_RATE * 100)}% 다. ` +
      `임계값은 그 80%(${String(BOUNCE_ALARM_RATE * 100)}%) — AWS 가 우리를 보기 **전에** 우리가 본다.`,
  },
  {
    name: 'atmark-ses-complaint-rate',
    what: 'complaint 율 — 같은 축, 더 가파르다',
    basis:
      `AWS 의 검토 개시선 ${String(COMPLAINT_ALARM_RATE * 100)}% **그 자체**를 쓴다. ` +
      '계획 §3.3 의 위험선 0.2% 는 AWS 가 이미 보기 시작한 뒤라 늦다 — 계정을 정지시키는 쪽이 AWS 다.',
  },
  {
    name: 'atmark-gate-silence',
    what: '관문이 침묵했다 — **알람 스위트 자신의 생사 신호**',
    basis: '아래 "왜 결측을 위반으로 읽는 알람이 있는가" 참조.',
  },
  {
    name: 'atmark-approval-pending-overdue',
    what: '승인 대기 행이 기한을 넘겨 방치됐다 — §4.3 보조 불변식(P2, 2026-09-23 추가)',
    basis:
      '`audit_pending_overdue(now − 30분)` 의 행 수. TTL 스위퍼와 릴리스 스윕 **둘 다** 방출하므로 한쪽이 멈추면 다른 쪽이 본다. ' +
      '둘 다 멈추면 방출이 끊긴다 — 그래서 이 알람도 결측을 위반으로 읽는다.',
  },
  {
    name: 'atmark-contact-rate-global',
    what: '문의(support@)가 전역 시간당 상한에 걸렸다 — US-009 검증 F6',
    basis: '상한에 걸린 문의는 전달되지 않는다. 폭주든 공격이든 운영자가 모르는 채 문의가 사라지면 안 된다.',
  },
  {
    name: 'atmark-contact-forward-blocked',
    what: '문의 전달이 막혔다 — 전달 주소 비밀이 비었거나 모양이 틀렸다 (US-009 검증 F6)',
    basis: '전달이 막히면 문의는 S3 에만 쌓이고 아무도 읽지 않는다. 조용한 실패의 전형이다.',
  },
  {
    name: 'atmark-ses-from-mismatch',
    what: 'SES 이벤트의 헤더 From 이 발신 주소와 다르거나 예약 주소(login@·support@)를 쓴다 — 최종 검증 M3b',
    basis: 'IAM 이 raw 헤더 From 을 어느 값으로 평가하는지 AWS 문서에 없다(ADR-0006). 사전 차단이 새면 사후에 1건부터 운다.',
  },
  {
    name: 'atmark-snippet-retention-stuck',
    what: '본문 미리보기 1년 보존 스윕이 비우지 못한 행이 있다 — 최종 검증 L2',
    basis: '개인정보 처리 안내의 "1년" 이 사실과 어긋나는 순간이다. 행 하나가 스윕을 영원히 멈추지 못하게 건너뛰고, 건너뛴 사실은 여기서 운다.',
  },
  {
    name: 'atmark-ses-events-dlq-depth',
    what: 'SES 이벤트 DLQ 에 메시지가 쌓였다 — 최종 검증 L6',
    basis: '반송·불만 이벤트를 잃으면 억제 목록이 빠져 평판이 깎인다. 예약 동시성 1 이 SQS 최소 동시성 2 보다 작아 스로틀 재시도가 DLQ 로 갈 수 있다.',
  },
  {
    name: 'atmark-privacy-erasure-backlog',
    what: '초대만 받고 들어오지 않은 주소 가운데, 마지막 초대가 끝난 지 37일이 넘었는데 아직 지우지 못한 것이 있다 — ADR-0010 L7',
    basis: '개인정보 처리 안내가 "30일 뒤 지운다" 고 약속한다. 하루 보존 창을 한 번 놓치면(7일 여유) 약속이 깨지기 전에 사람이 본다.',
  },
  {
    name: 'atmark-inbound-mail-dlq-depth',
    what: '수신 메일 DLQ 에 메시지가 쌓였다 — 최종 검증 L6',
    basis: 'DLQ 에 간 수신 메일은 에이전트에게 닿지 않는다. 적체 1건부터 사람이 본다.',
  },
  // ── 15~23 — 결제(WP-2, Paddle). 결제의 실패는 양쪽 모두 조용하다: 고객은 결제 완료 화면을 봤고 우리는 웹훅이 안 온 것을 모른다.
  //   막는 장치는 전부 "요금제를 바꾸지 않는 쪽" 으로 실패하므로 noop 이유마다 알람 하나를 둔다. 결제는 드물다 — 1건이 곧 신호다.
  {
    name: 'atmark-billing-dlq-depth',
    what: '결제 이벤트 DLQ 에 메시지가 있다 — sync 가 10번 받고도(약 1시간) 처리하지 못했다',
    basis: 'FIFO 는 그룹이 막힌다. DLQ 에 간 이벤트의 구독은 요금제가 결제와 어긋나 있을 수 있다 — 1건부터 사람이 본다(redrive 또는 sync-org).',
  },
  {
    name: 'atmark-billing-webhook-rejected',
    what: '결제 웹훅 거부(서명·타임스탬프 창·헤더·크기)가 몰린다',
    basis: '인터넷에 열린 엔드포인트라 스캐너 한두 건은 정상이다. 5분 5건은 비밀 오입력(모든 웹훅 거부)이거나 두드림 — 이 알람만 임계값이 5다.',
  },
  {
    name: 'atmark-billing-sync-failed',
    what: '결제 sync 가 메시지·reconcile 처리에 실패했다(던짐 — SQS 가 재시도)',
    basis: '재시도가 풀면 조용히 지나가고, 못 풀면 DLQ 로 간다. 1건이 곧 원인(DB·키·Paddle·NAT)을 가를 때다.',
  },
  {
    name: 'atmark-billing-provider-auth-failed',
    what: 'Paddle API 가 401/403 — 키가 자리표시·만료·권한 부족',
    basis: '스위치가 켜진 뒤 키가 틀리면 체크아웃·재조회가 전부 멈춘다. 결제가 드물어 고객 문의보다 먼저 알아야 한다.',
  },
  {
    name: 'atmark-billing-unknown-price',
    what: '우리가 모르는 가격 id 의 구독 — 요금제를 바꾸지 않았다(noop)',
    basis: '돈은 받았는데 요금제가 안 올랐을 수 있다. 가격 표(prices.ts)와 Paddle 이 어긋난 순간이다.',
  },
  {
    name: 'atmark-billing-unbound-subscription',
    what: '원 거래가 우리 billing_checkouts 에 없는 구독 — 결속하지 않았다',
    basis: '공개 클라이언트 토큰으로 연 체크아웃이거나 조직 불일치다. 결속을 거부하는 것이 옳지만, 거부했다는 사실은 사람이 봐야 한다.',
  },
  {
    name: 'atmark-billing-entitlement-held',
    what: '운영자·백필 요금제 행이 결제 결과를 막았다(D-3 칸별 지배 실패)',
    basis: '결제한 조직의 한도가 오르지 않았다. 운영자 행이 이기는 것은 설계지만, 이긴 사실이 조용하면 결제 고객이 손해를 본다.',
  },
  {
    name: 'atmark-billing-webhook-missed',
    what: 'reconcile 이 본 Paddle 구독 변화에 2시간 안에 웹훅이 오지 않았다',
    basis: 'reconcile 이 상태는 맞췄다 — 그래도 웹훅 경로(알림 목적지 URL·구독 이벤트·웹훅 λ)가 끊겼다는 신호라 1건부터 본다.',
  },
  {
    name: 'atmark-billing-reconcile-org-failed',
    what: 'reconcile 이 한 조직의 요금제 재계산에 실패해 그 조직만 건너뛰었다',
    basis: '한 조직이 틱 전체를 막지 않게 건너뛰는 대가로, 실패가 틱 성공 뒤에 숨는다(Lambda Errors·sync_failed 없음). 같은 조직이 매 틱 새면 영영 어긋난다.',
  },
  // ── 24~27 — 메일 기본기 1차(A1·A3·A4). 24·26·27 은 식 알람(metric math · Contributor Insights), 25 는 AWS/SQS.
  {
    name: 'atmark-webhook-dead-ratio',
    what: '웹훅 전달의 dead 비율이 높다 — 에이전트는 폴링하지 않으므로 dead 는 조용한 유실이다',
    basis:
      `1시간 dead/(delivered+dead) > ${String(WEBHOOK_DEAD_RATIO_THRESHOLD * 100)}%, 분모 ${String(WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS)}건 미만은 0 으로 읽는다. ` +
      '소유자가 지운 엔드포인트의 dead(endpoint_disabled)는 분자에 없다. 전 테넌트 합산이라 먼저 한 엔드포인트에 몰렸는지 본다.',
  },
  {
    name: 'atmark-ses-events-lag',
    what: 'SES 이벤트 큐가 밀린다 — 반송·신고 기록, 억제 목록, 발송 결과 웹훅이 함께 늦는다',
    basis: `가장 오래된 메시지 > ${String(SES_EVENTS_LAG_SECONDS)}초가 5분 기간 3번 연속. 배치 재시도 한 번의 튐이 아니라 15분 내내 밀린 것만 본다.`,
  },
  {
    name: 'atmark-verification-lookups-agent-daily',
    what: '한 에이전트가 하루에 인증코드를 너무 많이 조회했다 (D10 — 관측만)',
    basis: `Contributor Insights 최대 기여자 > ${String(VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD)}/24시간. 메트릭 차원에 agent_id 를 둘 수 없어 로그 규칙이 센다.`,
  },
  {
    name: 'atmark-scheduled-cancels-agent-hourly',
    what: '한 에이전트의 예약 취소 시도가 1시간에 여러 번 막혔다 — 주입 메일이 취소를 조르는 모양(R5), http·mcp 합산',
    basis:
      `Contributor Insights 최대 기여자 >= ${String(SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD)}/1시간 — 거부(scheduled.cancel_rejected)만 센다. ` +
      `하드 상한(시간당 ${String(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT)}, 429)·agent_cancellable(403)에 막힌 시도다. 성공한 취소와 소유자 콘솔 취소는 세지 않는다.`,
  },
  // ── 28 — 재검토 N5. 결측 = 위반(틱 정지)이라 6·7번과 같은 액션 게이트.
  {
    name: 'atmark-billing-reconcile-stale',
    what: '결제 reconcile 이 하루 넘게 판을 끝내지 못했거나 틱이 멈췄다 — 웹훅이 놓친 해지·유예 만료가 반영되지 않는다',
    basis:
      `마지막 완료 나이 > ${String(RECONCILE_STALE_SECONDS / 3600)}시간(판 간격 24시간 + 여유 2시간), 1시간 방출이 없으면 위반. ` +
      '스위치 꺼짐·결제 표 전은 0 을 낸다(기대 없음 — 결측이 아니다).',
  },
];

function sceneAlarms(): void {
  section(`⑤ 알람 ${String(ALARM_ORDER.length)}종 — cdk synth 산출물을 파싱한다 (배포하지 않는다)`);

  note('CloudWatch 에 배포하지 않는다. 그래서 "스택 코드가 컴파일된다" 는 증거가 아니다 —');
  note('TypeScript 는 CloudFormation 템플릿을 보지 못한다. 여기서 synth 해 **JSON 을 읽는다**.');

  const template = synthAlarms(false); // infra/cdk/app.ts 가 넘기는 값과 같다.
  const found = alarmsOf(template);

  check(`알람이 정확히 ${String(ALARM_ORDER.length)}개다`, found.size === ALARM_ORDER.length, `${String(found.size)}개`);
  check(
    '이름 집합이 기대와 같다',
    [...found.keys()].sort().join(',') === ALARM_ORDER.map((a) => a.name).sort().join(','),
    [...found.keys()].sort().join(', '),
  );

  console.log('');
  // 컬럼 폭은 가장 긴 이름(`atmark-dispatch-serialization-unavailable`)과
  // 가장 긴 메트릭(`atmark.gate.serialization_unavailable`)에서 파생한다. 리터럴로
  // 박으면 이름이 하나 길어지는 날 표가 어긋나고, 어긋난 표는 읽히지 않는다.
  const nameWidth = Math.max(...ALARM_ORDER.map((spec) => spec.name.length)) + 2;
  const metricWidth =
    Math.max(...[...found.values()].map((facts) => `${facts.namespace}:${facts.metric}`.length)) + 2;

  console.log(
    `  ${'#'.padEnd(3)}${'alarm'.padEnd(nameWidth)}${'metric'.padEnd(metricWidth)}${'판정'.padEnd(20)}${'결측'.padEnd(14)}액션`,
  );
  console.log(`  ${'─'.repeat(nameWidth + metricWidth + 41)}`);

  for (const [index, spec] of ALARM_ORDER.entries()) {
    const facts = found.get(spec.name);
    if (facts === undefined) {
      check(`알람 ${String(index + 1)} ${spec.name} 이 산출물에 있다`, false, '없다');
      continue;
    }
    const symbol = COMPARISON_SYMBOL[facts.comparison] ?? facts.comparison;
    const verdict = `${symbol} ${String(facts.threshold)} / ${periodLabel(facts.period)}`;
    console.log(
      `  ${String(index + 1).padEnd(3)}${spec.name.padEnd(nameWidth)}` +
        `${`${facts.namespace}:${facts.metric}`.padEnd(metricWidth)}` +
        `${verdict.padEnd(20)}${facts.missing.padEnd(14)}${facts.actionsEnabled ? 'on' : 'off'}`,
    );
    console.log(`      ${spec.what}`);
    console.log(`      근거: ${spec.basis}`);
  }

  console.log('');

  // ── 임계값이 **코드에서 온 것**임을 산출물로 확인한다 ────────────────────────
  check(
    '워밍업 임계값이 코드 상수 그대로다 — 캡이 바뀌면 알람도 바뀐다',
    found.get('atmark-warmup-cap-breached')?.threshold === WARMUP_STEADY_STATE_DAILY_CAP,
    String(found.get('atmark-warmup-cap-breached')?.threshold),
  );
  check(
    `bounce 임계값이 AWS 검토 개시선(${String(SES_BOUNCE_REVIEW_RATE)})보다 낮다`,
    (found.get('atmark-ses-bounce-rate')?.threshold ?? 1) < SES_BOUNCE_REVIEW_RATE,
    String(found.get('atmark-ses-bounce-rate')?.threshold),
  );
  check(
    'complaint 임계값이 AWS 검토 개시선 그 자체다',
    found.get('atmark-ses-complaint-rate')?.threshold === COMPLAINT_ALARM_RATE,
    String(found.get('atmark-ses-complaint-rate')?.threshold),
  );
  check(
    '직렬화 임계값이 코드 상수 그대로다',
    found.get('atmark-dispatch-serialization-unavailable')?.threshold === SERIALIZATION_FAILURE_THRESHOLD,
    String(found.get('atmark-dispatch-serialization-unavailable')?.threshold),
  );

  const topicPresent = Object.values(template.Resources ?? {}).some(
    (resource) =>
      resource.Type === 'AWS::SNS::Topic' && resource.Properties?.['TopicName'] === ALARM_TOPIC_NAME,
  );
  check(`알람 토픽 ${ALARM_TOPIC_NAME} 이 산출물에 있다`, topicPresent);

  // ── 왜 6번인가 — 산문이 아니라 산출물에서 센다 ──────────────────────────────
  section('⑤-b 왜 결측을 위반으로 읽는 알람이 있는가 — 감시자를 감시한다');

  const ourNamespaceNotBreaching = [...found.entries()].filter(
    ([, facts]) => facts.namespace === METRIC_NAMESPACE && facts.missing === 'notBreaching',
  );
  const breaching = [...found.entries()].filter(([, facts]) => facts.missing === 'breaching');
  const allNotBreaching = [...found.values()].filter((facts) => facts.missing === 'notBreaching');

  note('카운터 알람의 결측은 notBreaching 으로 둘 수밖에 없다 — 트래픽이 없으면 실패도 0이다.');
  note(`그 결과 ${String(found.size)}개 중 ${String(allNotBreaching.length)}개가 결측을 "정상" 으로 읽고,`);
  note(
    `그중 ${String(ourNamespaceNotBreaching.length)}개는 **우리 네임스페이스(${METRIC_NAMESPACE})** 를 본다 — ` +
      `EMF 방출이 죽으면 그 ${String(ourNamespaceNotBreaching.length)}개가 동시에, 조용히, 영원히 초록이 된다.`,
  );
  note('배포 실수로 로그 그룹 권한이 빠지거나 EMF 파서가 이름을 못 찾으면 바로 그 상태다.');

  // 우리 네임스페이스의 카운터 알람 전부 — 새 알람이 늘면 이 목록도 같이 늘어야 한다(감시자 둘이 이들을 대신 본다).
  // DLQ 깊이 알람(SES 이벤트·수신 메일·결제)은 AWS/SQS 네임스페이스라 여기 들지 않는다.
  const EXPECTED_SILENT_COUNTERS = [
    'atmark-audit-resolve-failure',
    'atmark-billing-entitlement-held',
    'atmark-billing-provider-auth-failed',
    'atmark-billing-reconcile-org-failed',
    'atmark-billing-sync-failed',
    'atmark-billing-unbound-subscription',
    'atmark-billing-unknown-price',
    'atmark-billing-webhook-missed',
    'atmark-billing-webhook-rejected',
    'atmark-contact-forward-blocked',
    'atmark-contact-rate-global',
    'atmark-dispatch-serialization-unavailable',
    'atmark-privacy-erasure-backlog',
    'atmark-ses-from-mismatch',
    'atmark-snippet-retention-stuck',
    'atmark-warmup-cap-breached',
  ];
  check(
    `우리 네임스페이스를 보며 결측을 정상으로 읽는 알람이 ${String(ourNamespaceNotBreaching.length)}개 있다`,
    JSON.stringify(ourNamespaceNotBreaching.map(([name]) => name).sort()) === JSON.stringify(EXPECTED_SILENT_COUNTERS),
    ourNamespaceNotBreaching.map(([name]) => name).join(', '),
  );
  // 결측을 위반으로 읽는 알람은 **방출원의 생사를 겸해서 보는 것들**뿐이어야 한다. 각각이 다른 방출원을 본다:
  // 관문 침묵 = 발송 경로(관문이 시도마다 방출), 승인 방치 = 스윕 워커(TTL·릴리스가 주기마다 방출).
  // reconcile 정지 = 결제 sync λ(15분 틱마다 완료 나이를 방출, 재검토 N5).
  const EXPECTED_WATCHERS = ['atmark-approval-pending-overdue', 'atmark-billing-reconcile-stale', 'atmark-gate-silence'];
  const watcherNames = breaching.map(([name]) => name).sort();
  check(
    `★ 결측을 **위반**으로 읽는 알람은 정확히 ${String(EXPECTED_WATCHERS.length)}개 — 관문 침묵(발송 경로) · 승인 방치(스윕 워커) · reconcile 정지(결제 틱)`,
    JSON.stringify(watcherNames) === JSON.stringify(EXPECTED_WATCHERS),
    watcherNames.join(', ') || '없다',
  );
  note('이 셋이 나머지를 감시한다 — 방출이 멈추면 초록으로 조용해지는 알람들 대신 이 셋이 운다.');
  note('Layer F 가 arch 스위트에 대해 하는 일(층이 잠들었는가)을 알람 스위트에 대해 한다.');

  // ── 액션 게이트 ─────────────────────────────────────────────────────────────
  const silenceNow = found.get('atmark-gate-silence');
  const silenceLater = alarmsOf(synthAlarms(true)).get('atmark-gate-silence');
  check(
    '지금 배선(productionTrafficExpected=false)에서 관문 침묵 알람의 액션은 꺼져 있다',
    silenceNow?.actionsEnabled === false,
    String(silenceNow?.actionsEnabled),
  );
  check(
    '★ 그래도 **리소스는 존재한다** — 끄는 것과 만들지 않는 것은 다르다',
    silenceNow !== undefined && silenceLater?.actionsEnabled === true,
    '트래픽 개시 체크리스트가 이 플래그를 뒤집는다',
  );
  note('프로덕션 트래픽 개시 전에는 "24시간 0건" 이 정상이다. 그때 켜 두면 알람 피로가 생기고,');
  note('알람 피로는 계획 §4.2 가 승인 경로에 대해 이미 최대 실패 요인으로 지목한 것이다.');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    'demo:p1c — "같은 요청은 한 번만 나간다. 신분은 태어날 때 붙고 두 번 다시 바뀌지 않는다. 그리고 모르면 보내지 않는다."',
  );
  console.log('  모드: 드라이런 고정 — 이 demo 에는 실발송 분기가 없다 (ATMARK_DEMO_REAL_SEND 를 읽지 않는다).');

  // ── B5 — **로거 싱크도 이 출력의 일부다** ──────────────────────────────────
  //
  // 이 파일은 `elide()`·`redactAgentIds()` 로 자기가 찍는 줄에서 `agentId` 를 가린다.
  // 그런데 관문이 시도마다 내는 `gate.attempt` 는 **full 32-hex `agent_id`** 를 싣고,
  // 그 줄은 우리가 아니라 로거가 stdout 으로 내보낸다. 접두사는 공개돼 있으므로
  // (`DID_WEB_PREFIX` + `agent_id`) 그 한 줄이면 draft DID 원문이 재구성된다 —
  // 가려 둔 것을 잠재우지 않은 싱크가 그대로 되돌리는 것이다.
  //
  // **운영 로그에서는 이 값을 가리지 않는다.** 그쪽은 독자가 IAM 으로 한정된 운영자이고,
  // `agent_id` 는 AC-9 의 로그 쪽 경로가 서는 조인 키다. 여기서만 가리는 이유 —
  // 데모 출력은 스크린샷이 되어 독자가 정해지지 않은 곳으로 옮겨진다.
  // 그 경계와 근거는 `docs/adr/0002-did-web.md` 의 "B5 의 경계" 에 적혀 있다.
  const restoreLogSink = setLogSink((line) => {
    console.log(redactAgentIds(line));
  });

  if (OWNER_URL.trim() === '') {
    throw new Error(
      'TEST_MIGRATION_DATABASE_URL(또는 DATABASE_MIGRATION_URL) 이 없다 — 프로비저닝은 소유자 롤로만 한다(202609230730).',
    );
  }

  const pool = createAppPool();
  const ownerPool = createPool(OWNER_URL, { max: 4 });
  try {
    const suffix = randomBytes(4).toString('hex');
    const gateStores = createPostgresGateStores(pool);
    const tokens = createPostgresAgentTokenStore(pool);
    const content = createInMemoryContentStore();
    const transport = createDemoTransport({ content, realSend: false, pool: null });

    const service: OutboundServiceDependencies = {
      source: gateStores.source,
      audit: gateStores.audit,
      dispatchStore: gateStores.leases,
      serializer: gateStores.serializer,
      // 조립 루트에서는 **필수**다. 관문에서 optional 인 것과 다르다 — 미배선이 조용히
      // 통과하는 자리를 타입이 지운다(`outbound-service.ts` 의 근거 참조).
      sendEvidence: gateStores.sendEvidence,
      messages: createPostgresOutboundMessageStore(pool),
      content,
      leaseTtlSeconds: LEASE_TTL_SECONDS,
      // ADR-0016 — 운영과 같은 Postgres 구현(위험 신호 강제 · 발신 DLP). 워크로드 1 은 보류 0 이어야 한다.
      riskSignals: createPostgresRiskSignalSource(pool, { mode: 'enforce' }),
      dlp: { keyring: DEMO_DLP_KEYS, signals: createPostgresDlpSignalStore(pool) },
      now: () => new Date(),
    };

    // ── 준비 — 이 demo 가 쓰는 에이전트 하나 ──────────────────────────────────
    //
    // 장면 ② 가 **바로 이 프로비저닝의 산물**을 검사한다. 장면 ①③④ 도 같은 에이전트를
    // 쓴다 — demo 가 장면마다 새 에이전트를 만들면 ②의 "한 트랜잭션" 주장이 어느
    // 에이전트에 대한 것인지 흐려진다.
    const custody = createLocalDevKeyCustody();
    const provisioned = await provisionAgent(
      createPostgresProvisioningStore(ownerPool),
      {
        organization: { kind: 'create', name: `atmark-demo-p1c-${suffix}`, ownerEmail: 'owner@example.com' },
        agentName: `demo-agent-p1c-${suffix}`,
        addressLocalPart: `demo-p1c-${suffix}`,
        seedContacts: [RECIPIENT],
        monthlyBudgetCents: 10_000,
        createdBy: 'demo:p1c',
        tokenCapabilities: null,
        // P1 데모의 모드를 명시한다(정책 v2 의 기본값과 같지만 — ADR-0007 — 이 데모의 거부 장면이 그 모드에 달려 있다).
        outboundMode: 'allowlist_only',
      },
      custody,
    );
    const agentId = provisioned.agent.id as AgentId;
    console.log(
      `  에이전트: ${elide(agentId)} · ${provisioned.address.address} · 정책 ${provisioned.policyVersion.outbound_mode}`,
    );

    await sceneIdempotency({ pool, tokens, service, transport, provisioned, suffix });
    await sceneProvisioning(pool, ownerPool, provisioned, custody.kind, suffix);
    await sceneKeyImmutability(pool, agentId);
    await sceneSendEvidence({ pool, service, provisioned, suffix });
    sceneAlarms();

    // -----------------------------------------------------------------------
    section('판정');
    // -----------------------------------------------------------------------

    if (skipped.length > 0) {
      console.log(`  ⊘ 건너뛴 층 ${String(skipped.length)}건 — 이 실행이 보지 않은 것이다:`);
      for (const item of skipped) console.log(`    - ${item}`);
    }

    if (failures.length > 0) {
      console.error(`✗ demo:p1c 실패 ${String(failures.length)}건:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      '✓ P1c: 같은 키 3회 → SES 1회·messages 1행·audit 1행 · keypair+draft passport 가 한 트랜잭션(둘 다 또는 전무) · ' +
        `네 구멍 전건 거부 · lease 만료 재전송 전 증거 조회(조회 실패 → 유보) · 알람 ${String(ALARM_ORDER.length)}종 synth 확인.`,
    );
    console.log(
      '  게시 전 DID 문자열도, 그것을 재구성할 수 있는 full agent_id 도 이 출력 어디에도 없다 (ADR-0002 B5).',
    );
  } finally {
    restoreLogSink();
    await pool.end();
    await ownerPool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('✗ demo:p1c 가 예외로 끝났다:', error);
  process.exitCode = 1;
});
