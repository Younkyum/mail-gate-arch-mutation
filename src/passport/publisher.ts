/**
 * src/passport/publisher.ts — **게시 요청 처리 + 재서명 워커** (계획 §4B.1b · §4B.2 PP-B, 계약 §3). 서명 Lambda(`atmark-passport-signer`,
 * DB 롤 `atmark_passport_signer`)가 1분마다 한 틱을 돈다(`src/workers/passport-signer.ts`).
 *
 * ## 한 틱
 *   ⓪ **재서명 스캔** — 현재 버전이 published·suspended 인데 24시간 동안 요청이 없던 에이전트에 `resign` 요청을 넣는다(최대 20).
 *      버킷 경계(30일·180일·대화 수)·위반 발생·만료 임박(30일)을 이 스캔이 잡는다 — 이벤트 구동 트리거(§4B.1b 표)의 Phase 1 근사다.
 *      지연 상한은 24시간 + 1분이고, 그 사이의 창은 ADR-0003 에 적었다. `status` 전이(정지·게시)는 콘솔 요청이라 **즉시**다.
 *   ① **서명(pending → signed)** — 요청 하나를 `FOR UPDATE SKIP LOCKED` 로 잡고, **한 트랜잭션 안에서** 새 버전(또는 draft 의 최초 게시)을
 *      만들고 서명해 `passport_documents` 에 넣는다. 트랜잭션이 커밋되면 요청은 `signed`(업로드 대기). 서명이 실패하면 롤백되고 요청은
 *      재시도 대기(`next_attempt_at`)로 — **버전 행은 하나도 생기지 않는다.**
 *   ② **업로드(signed → done)** — 에이전트의 **현재** 버전 문서를 S3 에 쓰고(did.json · passport.json · passport.jws) CloudFront 를 무효화한다.
 *      전부 멱등이다: 같은 바이트를 다시 쓰고, 무효화는 요청 id 를 CallerReference 로 쓴다. 실패하면 `signed` 로 남아 다음 틱이 다시 한다.
 *      `unchanged`(내용이 같고 만료가 멀다)도 이 단계를 지난다 — 매일 한 번 S3 가 DB 와 수렴한다.
 *
 * ## 멱등성 (계약 "signer idempotency")
 *   - 같은 요청은 **최대 한 번** 버전을 만든다: `pending → signed` 가 버전 행과 같은 트랜잭션에서 일어나고, 종단 상태는 트리거가 되돌리지
 *     못하게 한다(`passport_publish_requests_reject_terminal_change`). 두 워커가 같은 요청을 잡지 못한다(SKIP LOCKED + 현재 버전 행 잠금).
 *   - 같은 **내용**은 새 버전이 되지 않는다(`substanceOf` 비교) — publish 를 두 번 눌러도 버전이 늘지 않는다.
 *
 * ## 우선 요청 — 정지·폐기가 대기 중인 게시·재서명을 이긴다 (`202609241210`)
 *   에이전트당 대기(pending) 칸은 둘이다: **일반**(publish·resign) 하나 + **우선**(suspend·revoke) 하나. 정지는 비상 경로라, 백오프 중인
 *   게시·재서명 뒤에 줄 서면 안 된다.
 *   - 잡는 순서는 그대로(오래된 것부터)다 — 순서가 아니라 아래 두 규칙이 우선을 보장한다(옛 게시가 먼저 잡혀도 거부된다).
 *   - 우선 요청이 서명되면 같은 에이전트의 대기 중 일반 요청을 `rejected`(`superseded_by_<kind>`)로 닫는다(잠긴 행은 건너뛴다 — 교착 없음).
 *   - 일반 요청을 처리할 때 **그보다 나중(같거나 늦게)에 들어온 우선 요청**(대기·서명·완료)이 있으면 같은 사유로 거부한다 — 위의
 *     건너뛴 행과 경쟁을 덮는다. 정지 **뒤에** 들어온 게시는 거부되지 않는다(사람이 다시 게시한 것이다).
 *   - `signed`(버전은 커밋됐고 업로드만 남음) 요청은 칸을 차지하지 않는다 — 업로드는 요청과 무관하게 **현재 버전**을 올리므로 둘이어도 수렴한다.
 *
 * ## 조직 검토
 *   `review_status = 'active'` 가 아닌 조직의 에이전트는 **게시할 수 없다**(`org_not_active`) — publish, 그리고 published 상태를 이어 가는
 *   resign 도. 정지·폐기는 조직 상태와 무관하게 된다(내리는 쪽은 언제나 열려 있다). 서명 롤은 조직 행을 읽지 못하고, 불리언 하나를 주는
 *   SECURITY DEFINER 함수 `passport_agent_organization_active` 만 부른다.
 *
 * ## 이 파일이 읽지 않는 것
 * 조직(소유자 메일·이름) · 토큰 · 메시지 제목·본문 · 정책(모드·목록·수치). DB 롤이 애초에 못 읽는다(`202609241200` ④).
 */

import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { toAgentId, type AgentId } from '../db/schema';
import { computeAttestations, POLICY_VIOLATION_REASONS, POLICY_VIOLATION_WINDOW_DAYS } from './attestations';
import { canonicalize, contentHashOf } from './jcs';
import {
  buildDidDocument,
  buildPassportDocument,
  buildRevokedDidDocument,
  IDENTITY_CONTENT_TYPES,
  identityFileUrl,
  identityInvalidationPath,
  identityObjectKey,
  jwsHeaderFor,
  secondsOf,
  substanceOf,
  type PassportDocument,
  type SignedPassportStatus,
} from './document';
import { PassportSigningError, type PassportSigner } from './signing';

/** 신원 문서 쓰기 면(S3) — `src/storage/s3-object-store.ts` `createS3IdentityDocumentWriter` 와 같은 모양. */
export interface IdentityDocumentTarget {
  put(key: string, body: string, contentType: string): Promise<void>;
}

/** CDN 무효화 면 — `src/runtime/cloudfront.ts` `createCloudFrontInvalidator` 와 같은 모양. */
export interface IdentityCacheInvalidator {
  invalidate(paths: readonly string[], callerReference: string): Promise<void>;
}

export interface PassportPublisherDependencies {
  /** `atmark_passport_signer` 롤 풀. */
  readonly db: Pool;
  readonly signer: PassportSigner;
  readonly documents: IdentityDocumentTarget;
  readonly cdn: IdentityCacheInvalidator;
  readonly now: () => Date;
}

/** 한 틱에 처리하는 요청 수(서명·업로드 각각). 스케줄 1분 · 타임아웃 50초 안에 끝나는 크기. */
const PUBLISH_BATCH_SIZE = 10;
/** 재서명 스캔이 한 틱에 넣는 요청 수. */
const RESIGN_SCAN_LIMIT = 20;
/** 재서명 스캔 주기 — 에이전트마다 이 시간에 한 번 이하. */
const RESIGN_SCAN_INTERVAL_HOURS = 24;
/** 만료가 이보다 가까우면 내용이 같아도 새 버전을 낸다(90일 중 60일 시점). */
const RESIGN_BEFORE_EXPIRY_DAYS = 30;
/** 이 횟수를 넘으면 `failed`(종단) — 그 뒤는 다음 재서명 스캔이 새 요청으로 수렴시킨다. */
export const MAX_ATTEMPTS = 12;

/** 재서명 스캔 요청자. */
const RESIGN_REQUESTER = 'system:resign';

const DAY_MS = 24 * 60 * 60 * 1000;

export type PublishOutcome = 'published' | 'suspended' | 'revoked' | 'unchanged';

/** 우선 요청 — 대기 중인 일반 요청(publish·resign)을 대체한다. `202609241210` 의 대기 칸 둘과 같은 구분. */
const PRIORITY_REQUEST_KINDS = ['suspend', 'revoke'] as const;

/**
 * 범위 — 에이전트를 주면 그 에이전트의 요청·재서명만(공유 DB 테스트가 남의 행을 집지 않게). **좁히기만 한다** — 운영(스케줄 핸들러)은
 * 범위 없이 부른다(`runOwnerLoginNotifier` 의 조직 범위와 같은 규율).
 */
export interface PublisherScope {
  readonly agentIds: readonly AgentId[];
}
export type RequestKind = 'publish' | 'suspend' | 'revoke' | 'resign';

interface RequestRow {
  id: string;
  agent_id: string;
  kind: RequestKind;
  attempt_count: number;
  created_at: Date;
}

interface CurrentPassportRow {
  id: string;
  did: string;
  status: 'draft' | SignedPassportStatus;
  version: number;
  controller: string;
  document: string | null;
  valid_until: Date | null;
}

/**
 * 요청 → 결정. 거부면 사유. `organizationActive` = 조직 `review_status = 'active'` — 게시(published 를 새로 내는 것)의 전제다.
 * 정지·폐기는 조직 상태와 무관하다(내리는 쪽은 언제나 열려 있다).
 */
export function decide(
  kind: RequestKind,
  current: CurrentPassportRow['status'],
  organizationActive: boolean,
): SignedPassportStatus | { readonly reject: string } {
  if (current === 'revoked') return { reject: 'revoked' };
  switch (kind) {
    case 'publish':
      return organizationActive ? 'published' : { reject: 'org_not_active' };
    case 'suspend':
      return current === 'published' ? 'suspended' : { reject: 'not_published' };
    case 'revoke':
      return current === 'draft' ? { reject: 'not_published' } : 'revoked';
    case 'resign':
      if (current === 'draft') return { reject: 'not_published' };
      // published 를 이어 가는 재서명은 새 published 버전이다 — 게시와 같은 전제. suspended 는 그대로 이어 간다.
      if (current === 'published' && !organizationActive) return { reject: 'org_not_active' };
      return current;
  }
}

/**
 * 삭제한 에이전트(202610131000)의 요청 → 실제로 할 일. 살아 있는 에이전트는 요청 그대로. 삭제했으면: 공개된 적 있는 여권(published · suspended)은
 * **어떤 요청이든 폐기**(게시 · 재서명 · 정지가 대기 중이어도 — 삭제 트리거의 폐기 요청이 우선 칸의 정지에 막혔을 때도 여기서 폐기된다), 공개된
 * 적 없는 여권(draft)은 `null`(거부 `agent_deleted` — 삭제한 에이전트를 처음 게시하지 않는다). 이미 폐기면 `decide` 가 `revoked` 로 거부한다.
 */
export function effectiveKind(kind: RequestKind, current: CurrentPassportRow['status'], agentDeleted: boolean): RequestKind | null {
  if (!agentDeleted) return kind;
  if (current === 'draft') return null;
  return 'revoke';
}

/** outbox `last_error` 모양(`^[a-z0-9_:.-]{1,120}$`) — 단계 + 코드. 메시지 원문은 싣지 않는다. */
function errorCode(phase: 'sign' | 'upload', error: unknown): string {
  const raw = error instanceof PassportSigningError ? error.code : error instanceof Error ? error.name : 'unknown';
  const code = raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 100) || 'unknown';
  return `${phase}:${code}`;
}

/** SQL `$n::text[]` 범위 인자 — 범위가 없으면 `NULL`(전체). */
function scopeParam(scope: PublisherScope | undefined): string[] | null {
  return scope === undefined ? null : [...scope.agentIds];
}

function isPriority(kind: RequestKind): boolean {
  return (PRIORITY_REQUEST_KINDS as readonly string[]).includes(kind);
}

function backoffMinutes(attempt: number): number {
  return Math.min(2 ** attempt, 60);
}

// ---------------------------------------------------------------------------
// ⓪ 재서명 스캔
// ---------------------------------------------------------------------------

export async function enqueueResignScan(db: Pool, now: Date, scope?: PublisherScope): Promise<number> {
  const result = await db.query(
    `INSERT INTO passport_publish_requests (agent_id, kind, requested_by)
     SELECT p.agent_id, 'resign', $2
       FROM passports p
      WHERE p.superseded_at IS NULL
        AND p.status IN ('published', 'suspended')
        AND ($5::text[] IS NULL OR p.agent_id = ANY ($5::text[]))
        AND NOT EXISTS (
              SELECT 1 FROM passport_publish_requests r
               WHERE r.agent_id = p.agent_id
                 AND (r.status IN ('pending', 'signed') OR r.created_at > $1::timestamptz - make_interval(hours => $3)))
      ORDER BY p.agent_id
      LIMIT $4
     ON CONFLICT (agent_id) WHERE status = 'pending' AND kind IN ('publish', 'resign') DO NOTHING`,
    [now, RESIGN_REQUESTER, RESIGN_SCAN_INTERVAL_HOURS, RESIGN_SCAN_LIMIT, scopeParam(scope)],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// ① 서명
// ---------------------------------------------------------------------------

interface AgentFacts {
  readonly organizationActive: boolean;
  /** 삭제한 에이전트(`agents.status = 'disabled'`, 202610131000) — 어떤 요청이든 게시하지 않고, 공개된 여권은 폐기로 몬다(`effectiveKind`). */
  readonly agentDeleted: boolean;
  readonly name: string;
  readonly createdAt: Date;
  /** 유효 대표 주소(무효면 `null` — "주소 없음"). */
  readonly address: string | null;
  /** 그 주소의 도메인을 Atmark 가 지금 확인했는가(atmark.ai · 같은 조직 verified · suspended(plan_limit)). */
  readonly domainVerified: boolean;
  readonly publicKey: string;
  readonly keyRef: string;
  readonly violations: number;
  readonly conversations: number;
}

async function loadFacts(client: PoolClient, agentId: AgentId, now: Date): Promise<AgentFacts | { readonly reject: string }> {
  const agent = await client.query<{ name: string; created_at: Date; status: string }>('SELECT name, created_at, status::text AS status FROM agents WHERE id = $1', [agentId]);
  // 여권 주소 = **유효 대표**(ADR-0014 2026-10 개정 · F-7) — 정의자 함수의 두 칸(주소 · domain_verified)만. 잠든 앵커(`ax--`)는 여기 나오지 않는다.
  // 서명 롤은 선택 표 · 도메인 행을 읽지 못한다(202610021202).
  const address = await client.query<{ address: string | null; domain_verified: boolean }>(
    'SELECT address, domain_verified FROM atmark_agent_primary_view($1)',
    [agentId],
  );
  const keypair = await client.query<{ public_key: string; key_ref: string }>(
    'SELECT public_key, key_ref FROM agent_keypairs WHERE agent_id = $1',
    [agentId],
  );
  const agentRow = agent.rows[0];
  const addressRow = address.rows[0];
  const keypairRow = keypair.rows[0];
  if (agentRow === undefined) return { reject: 'agent_missing' };
  if (addressRow === undefined) return { reject: 'no_address' };
  // 앵커가 없는 에이전트(있을 수 없는 상태 — 주소 행이 하나도 없다)는 예전처럼 거부한다. 고객 도메인 선택이 무효가 된 "주소 없음" 은 서명한다(주소 null).
  if (addressRow.address === null) {
    const any = await client.query('SELECT 1 FROM agent_addresses WHERE agent_id = $1 LIMIT 1', [agentId]);
    if ((any.rowCount ?? 0) === 0) return { reject: 'no_address' };
  }
  if (keypairRow === undefined) return { reject: 'no_keypair' };
  // 진짜 위반만 · 최근 90일(attestations.ts `POLICY_VIOLATION_REASONS` 주석 — 소유자 정책이 막은 것은 위반이 아니다).
  const violations = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
      WHERE agent_id = $1 AND decision = 'denied' AND reasons && $2::text[]
        AND created_at > $3::timestamptz - make_interval(days => $4)`,
    [agentId, [...POLICY_VIOLATION_REASONS], now, POLICY_VIOLATION_WINDOW_DAYS],
  );
  // 조직 행은 읽지 못한다(202609241200 ④) — 불리언 하나를 주는 SECURITY DEFINER 함수(202609241210).
  const organization = await client.query<{ active: boolean | null }>('SELECT passport_agent_organization_active($1) AS active', [agentId]);
  const conversations = await client.query<{ n: string }>(
    `SELECT count(DISTINCT m.thread_id)::text AS n
       FROM messages m
      WHERE m.agent_id = $1 AND m.direction = 'outbound' AND m.status = 'sent' AND m.thread_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM inbound_messages i WHERE i.agent_id = $1 AND i.thread_id = m.thread_id)`,
    [agentId],
  );
  return {
    organizationActive: organization.rows[0]?.active === true,
    agentDeleted: agentRow.status === 'disabled',
    name: agentRow.name,
    createdAt: agentRow.created_at,
    address: addressRow.address,
    domainVerified: addressRow.domain_verified,
    publicKey: keypairRow.public_key,
    keyRef: keypairRow.key_ref,
    violations: Number(violations.rows[0]?.n ?? '0'),
    conversations: Number(conversations.rows[0]?.n ?? '0'),
  };
}

type SignResult =
  | { readonly kind: 'signed'; readonly outcome: PublishOutcome }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'idle' };

async function reject(client: PoolClient, requestId: string, reason: string, now: Date): Promise<SignResult> {
  await client.query(
    `UPDATE passport_publish_requests
        SET status = 'rejected', outcome = 'rejected', outcome_reason = $2, completed_at = $3
      WHERE id = $1`,
    [requestId, reason, now],
  );
  return { kind: 'rejected', reason };
}

/** 요청 하나를 잡아 서명까지(한 트랜잭션). 잡을 것이 없으면 `idle`. */
async function signOne(deps: PassportPublisherDependencies, scope: PublisherScope | undefined): Promise<SignResult> {
  const now = deps.now();
  let claimed: RequestRow | undefined;
  try {
    return await withTransaction(deps.db, async (client) => {
      const request = await client.query<RequestRow>(
        `SELECT id, agent_id, kind, attempt_count, created_at FROM passport_publish_requests
          WHERE status = 'pending' AND next_attempt_at <= $1
            AND ($2::text[] IS NULL OR agent_id = ANY ($2::text[]))
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [now, scopeParam(scope)],
      );
      claimed = request.rows[0];
      if (claimed === undefined) return { kind: 'idle' };
      const agentId = toAgentId(claimed.agent_id);

      const currentResult = await client.query<CurrentPassportRow>(
        `SELECT p.id, p.did, p.status, p.version, p.controller, d.document, d.valid_until
           FROM passports p LEFT JOIN passport_documents d ON d.passport_id = p.id
          WHERE p.agent_id = $1 AND p.superseded_at IS NULL
          FOR UPDATE OF p`,
        [agentId],
      );
      const current = currentResult.rows[0];
      if (current === undefined) return reject(client, claimed.id, 'no_passport', now);

      // 일반 요청보다 나중(같거나 늦게)에 들어온 우선 요청이 있으면 그것이 이긴다 — 정지 뒤에 옛 게시가 되살아나지 않게.
      if (!isPriority(claimed.kind)) {
        const newer = await client.query<{ kind: RequestKind }>(
          `SELECT kind FROM passport_publish_requests
            WHERE agent_id = $1 AND id <> $2 AND kind IN ('suspend', 'revoke')
              AND status IN ('pending', 'signed', 'done') AND created_at >= $3
            ORDER BY created_at LIMIT 1`,
          [agentId, claimed.id, claimed.created_at],
        );
        const winner = newer.rows[0];
        if (winner !== undefined) return reject(client, claimed.id, `superseded_by_${winner.kind}`, now);
      }

      const facts = await loadFacts(client, agentId, now);
      if ('reject' in facts) return reject(client, claimed.id, facts.reject, now);

      const kind = effectiveKind(claimed.kind, current.status, facts.agentDeleted);
      if (kind === null) return reject(client, claimed.id, 'agent_deleted', now);
      const decision = decide(kind, current.status, facts.organizationActive);
      if (typeof decision !== 'string') return reject(client, claimed.id, decision.reject, now);

      // 초 단위로 내린다 — 문서의 iat 와 DB 의 issued_at 이 같은 초다.
      const issuedAt = new Date(secondsOf(now) * 1000);
      // 처음 게시(draft)에 대표 주소가 없으면 게시하지 않는다 — "주소 없음" 여권은 이미 게시된 신원의 재서명에만 생긴다.
      if (facts.address === null && current.status === 'draft') return reject(client, claimed.id, 'no_address', now);
      const attestations = computeAttestations({
        addressDomain: facts.address === null ? null : (facts.address.split('@')[1] ?? ''),
        domainVerified: facts.domainVerified,
        agentCreatedAt: facts.createdAt,
        policyViolationCount: facts.violations,
        conversationCount: facts.conversations,
        now: issuedAt,
      });

      const inPlace = current.status === 'draft';
      const passportId = inPlace ? current.id : randomUUID();
      const version = inPlace ? current.version : current.version + 1;
      const document: PassportDocument = buildPassportDocument({
        agentId,
        did: current.did,
        passportId,
        version,
        status: decision,
        issuedAt,
        name: facts.name,
        address: facts.address,
        agentCreatedAt: facts.createdAt,
        attestations,
      });

      // 같은 상태의 재서명인데 내용이 같고 만료가 멀면 새 버전을 내지 않는다(업로드만 — 수렴).
      if (!inPlace && decision === current.status && current.document !== null && current.valid_until !== null) {
        const previous = JSON.parse(current.document) as PassportDocument;
        const sameSubstance = canonicalize(substanceOf(previous)) === canonicalize(substanceOf(document));
        const farFromExpiry = current.valid_until.getTime() - now.getTime() > RESIGN_BEFORE_EXPIRY_DAYS * DAY_MS;
        if (sameSubstance && farFromExpiry) {
          await client.query(
            `UPDATE passport_publish_requests
                SET status = 'signed', outcome = 'unchanged', passport_id = $2, signed_at = $3, last_error = NULL
              WHERE id = $1`,
            [claimed.id, current.id, now],
          );
          return { kind: 'signed', outcome: 'unchanged' };
        }
      }

      const canonical = canonicalize(document);
      const contentHash = contentHashOf(canonical);
      const jws = await deps.signer.signCompact({
        agentId,
        keyRef: facts.keyRef,
        expectedPublicKey: facts.publicKey,
        header: jwsHeaderFor(current.did),
        payload: canonical,
      });
      const metadataUri = identityFileUrl(agentId, 'passport.json');

      if (inPlace) {
        await client.query(
          `UPDATE passports SET status = 'published', metadata_uri = $2, content_hash = $3 WHERE id = $1`,
          [current.id, metadataUri, contentHash],
        );
      } else {
        // GREATEST: v1 의 issued_at 은 DB 의 now()(밀리초)이고 issuedAt 은 초 단위로 내린 값이다 — 같은 초 안이면 CHECK
        //   (superseded_at >= issued_at)에 걸린다.
        await client.query('UPDATE passports SET superseded_at = GREATEST($2::timestamptz, issued_at) WHERE id = $1', [current.id, now]);
        await client.query(
          `INSERT INTO passports (id, agent_id, did, status, controller, metadata_uri, content_hash, version, issued_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [passportId, agentId, current.did, decision, current.controller, metadataUri, contentHash, version, issuedAt],
        );
      }
      await client.query(
        `INSERT INTO passport_documents (passport_id, document, jws, valid_from, valid_until) VALUES ($1, $2, $3, $4, $5)`,
        [passportId, canonical, jws, new Date(document.nbf * 1000), new Date(document.exp * 1000)],
      );
      await client.query(
        `UPDATE passport_publish_requests
            SET status = 'signed', outcome = $2, passport_id = $3, signed_at = $4, last_error = NULL
          WHERE id = $1`,
        [claimed.id, decision, passportId, now],
      );
      if (isPriority(claimed.kind)) {
        // 대기 중인 일반 요청을 닫는다. 다른 워커가 잡고 있는 행은 건너뛴다(교착 없음) — 그 행은 위의 "나중 우선 요청" 검사가 거부한다.
        await client.query(
          `UPDATE passport_publish_requests
              SET status = 'rejected', outcome = 'rejected', outcome_reason = $2, completed_at = $3
            WHERE id IN (SELECT id FROM passport_publish_requests
                          WHERE agent_id = $1 AND status = 'pending' AND kind IN ('publish', 'resign')
                          FOR UPDATE SKIP LOCKED)`,
          [agentId, `superseded_by_${claimed.kind}`, now],
        );
      }
      return { kind: 'signed', outcome: decision };
    });
  } catch (error) {
    // 트랜잭션은 롤백됐다(버전 행 0). 요청을 재시도 대기로 — 별도 문장이라 위 롤백과 무관하게 남는다.
    if (claimed === undefined) throw error;
    await recordFailure(deps.db, claimed, 'sign', error, now);
    return { kind: 'rejected', reason: errorCode('sign', error) };
  }
}

async function recordFailure(db: Pool, request: RequestRow, phase: 'sign' | 'upload', error: unknown, now: Date): Promise<void> {
  const attempt = request.attempt_count + 1;
  const code = errorCode(phase, error);
  if (attempt >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE passport_publish_requests SET status = 'failed', attempt_count = $2, last_error = $3, completed_at = $4 WHERE id = $1`,
      [request.id, attempt, code, now],
    );
    return;
  }
  await db.query(
    `UPDATE passport_publish_requests
        SET attempt_count = $2, last_error = $3, next_attempt_at = $4::timestamptz + make_interval(mins => $5)
      WHERE id = $1`,
    [request.id, attempt, code, now, backoffMinutes(attempt)],
  );
}

// ---------------------------------------------------------------------------
// ② 업로드
// ---------------------------------------------------------------------------

interface UploadSource {
  id: string;
  agent_id: string;
  did: string;
  status: CurrentPassportRow['status'];
  document: string;
  jws: string;
  public_key: string;
}

/**
 * 공개 API(CloudFront 뒤 `id.atmark.ai/v1/identity/{address}`)의 무효화 경로 — **와일드카드 하나**. 주소를 나열하면 `@`·`%40` 두 표기와
 * 주소 개수를 다 따라가야 한다. 비정규 주소는 오리진이 존재와 무관한 404 를 주므로(`normalizePublicAddress`) 낡을 캐시가 없다.
 * CloudFront 는 와일드카드를 경로 1개로 세고, 공개 API 캐시 전체가 비는 비용은 오리진 요청 몇 개다(캐시 수명 300초).
 */
const IDENTITY_API_INVALIDATION_PATH = '/v1/identity/*';

async function uploadOne(deps: PassportPublisherDependencies, request: RequestRow): Promise<void> {
  const agentId = toAgentId(request.agent_id);
  const source = await deps.db.query<UploadSource>(
    `SELECT p.id, p.agent_id, p.did, p.status, d.document, d.jws, k.public_key
       FROM passports p
       JOIN passport_documents d ON d.passport_id = p.id
       JOIN agent_keypairs k ON k.agent_id = p.agent_id
      WHERE p.agent_id = $1 AND p.superseded_at IS NULL`,
    [agentId],
  );
  const row = source.rows[0];
  if (row === undefined) throw new PassportSigningError('upload_source_missing');

  // 폐기면 검증 수단을 내린 did.json(`buildRevokedDidDocument`) — 이전 JWS·침해된 키로 새로 만든 JWS 가 did.json 으로는 검증되지 않는다.
  const didDocument =
    row.status === 'revoked' ? buildRevokedDidDocument({ did: row.did, agentId }) : buildDidDocument({ did: row.did, agentId, publicKey: row.public_key });
  // passport.json 은 **서명된 JCS 바이트 그대로** — 받은 쪽이 SHA-256 을 다시 계산하면 content_hash 가 나온다.
  // 세 PUT 은 서로 독립이고 멱등이다 — 나란히 쓴다. 무효화는 셋이 다 끝난 뒤.
  await Promise.all([
    deps.documents.put(identityObjectKey(agentId, 'did.json'), `${JSON.stringify(didDocument, null, 2)}\n`, IDENTITY_CONTENT_TYPES['did.json']),
    deps.documents.put(identityObjectKey(agentId, 'passport.json'), row.document, IDENTITY_CONTENT_TYPES['passport.json']),
    deps.documents.put(identityObjectKey(agentId, 'passport.jws'), row.jws, IDENTITY_CONTENT_TYPES['passport.jws']),
  ]);
  await deps.cdn.invalidate([identityInvalidationPath(agentId), IDENTITY_API_INVALIDATION_PATH], `passport-request-${request.id}`);
}

// ---------------------------------------------------------------------------
// 한 틱
// ---------------------------------------------------------------------------

export type TickCounts = Readonly<Record<string, number>>;

export async function runPassportPublisherTick(deps: PassportPublisherDependencies, scope?: PublisherScope): Promise<TickCounts> {
  const counts: Record<string, number> = {};
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  counts['resign_enqueued'] = await enqueueResignScan(deps.db, deps.now(), scope);

  for (let index = 0; index < PUBLISH_BATCH_SIZE; index += 1) {
    const result = await signOne(deps, scope);
    if (result.kind === 'idle') break;
    bump(result.kind === 'signed' ? `signed.${result.outcome}` : result.reason.startsWith('sign:') ? 'sign_retry' : 'rejected');
  }

  const due = await deps.db.query<RequestRow>(
    `SELECT id, agent_id, kind, attempt_count, created_at FROM passport_publish_requests
      WHERE status = 'signed' AND next_attempt_at <= $1
        AND ($3::text[] IS NULL OR agent_id = ANY ($3::text[]))
      ORDER BY signed_at, id
      LIMIT $2`,
    [deps.now(), PUBLISH_BATCH_SIZE, scopeParam(scope)],
  );
  for (const request of due.rows) {
    try {
      await uploadOne(deps, request);
      await deps.db.query(
        `UPDATE passport_publish_requests SET status = 'done', completed_at = $2, last_error = NULL WHERE id = $1 AND status = 'signed'`,
        [request.id, deps.now()],
      );
      bump('uploaded');
    } catch (error) {
      await recordFailure(deps.db, request, 'upload', error, deps.now());
      bump('upload_retry');
    }
  }
  return counts;
}
