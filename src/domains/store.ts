/**
 * src/domains/store.ts — 고객 도메인 **저장소**(ADR-0014 단계 4). 질의는 롤로 나뉜다(결정 12 · 보안 M2):
 *
 *   - **admin 롤**(콘솔 · 조직 API): 행 만들기(식별 칸 + 첫 확인 시각) · 수동 확인 칸 · 제거 요청 · 목록. 상태 칸은 쓰지 못한다(GRANT).
 *   - **틱 롤**(`atmark_domain_tick` — admin λ 의 `{task:'domain-recheck'}` 가 연 풀 하나): 확인 대상 고르기 · 행 잠금 아래의 전이(계획 시점과
 *     `updated_at` 이 같을 때만 — 그 사이 누가 바꿨으면 이번 결과는 버리고 다음 틱이 다시 계획한다) · 알림 적기(조직 하루 상한) · 정책 주소 ·
 *     양도 대상 · 요금제 강등 재료 · 밀린 수.
 *   - **advisory 잠금 키**: 조직 도메인 수 `custom_domains_org:<org>`(DB 천장 트리거와 같다) · 도메인 진입 `custom_domain:<domain>`(같은 도메인의
 *     verifying 진입 · 양도를 한 줄로 — 계획 §3.3 ③ ⑨). apex 점유는 DB 트리거가 `custom_domain_registrable:<apex>` 로 잡는다.
 *
 * 칸 이름은 `TICK_PATCH_COLUMNS`(= 틱 롤의 UPDATE GRANT, `role-bootstrap.ts` `CUSTOM_DOMAIN_TICK_UPDATE_COLUMNS`) 밖으로 나가지 않는다.
 */

import { randomBytes } from 'node:crypto';

import {
  DOMAIN_NOTICES_PER_ORG_PER_DAY,
  DUE_BACKLOG_STALE_AFTER_MS,
  type CustomDomainPendingReason,
  type CustomDomainRemovalStep,
  type CustomDomainSagaStep,
  type CustomDomainSesStatus,
  type CustomDomainStatus,
  type CustomDomainSuspendedReason,
  type DomainNoticeKind,
  type InboundMxStatus,
} from './contract';

/** `pg` 의 `query` 하나(풀 · 클라이언트). */
export interface DomainDb {
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: R[]; readonly rowCount?: number | null }>;
}

/** 트랜잭션을 여는 쪽(풀) — `connect()` 로 클라이언트 하나를 빌린다. */
export interface DomainPool extends DomainDb {
  connect(): Promise<DomainDb & { release(): void }>;
}

export interface DomainRow {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
  readonly registrable: string;
  readonly status: CustomDomainStatus;
  readonly suspendedReason: CustomDomainSuspendedReason | null;
  readonly pendingReason: CustomDomainPendingReason | null;
  readonly challengeToken: string;
  readonly txtVerifiedAt: Date | null;
  readonly sagaStep: CustomDomainSagaStep;
  readonly sagaAttempts: number;
  readonly removalStep: CustomDomainRemovalStep;
  readonly lastError: string | null;
  readonly sesIdentityRowTag: string | null;
  readonly supersededBy: string | null;
  readonly dkimStatus: CustomDomainSesStatus;
  readonly dkimTokens: readonly string[];
  readonly mailFromStatus: CustomDomainSesStatus;
  readonly inboundMxStatus: InboundMxStatus;
  readonly policyDigest: string | null;
  readonly policySyncRequestedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly nextCheckAt: Date;
  readonly consecutiveDefinitiveFailures: number;
  readonly registrationExpiresAt: Date | null;
  readonly registrationCheckedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly removedAt: Date | null;
  readonly removalDueAt: Date | null;
  readonly identityDeletedAt: Date | null;
  /** identity 관리자 축(202610061000 · one-shot) — `identityStewardshipOf`(계약)로 접는다. */
  readonly identityClaimedAt: Date | null;
  readonly identityReleasedAt: Date | null;
  readonly identityHandoverTo: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const ROW_COLUMNS = `id::text AS id, organization_id::text AS "organizationId", domain, registrable_domain AS registrable, status,
  suspended_reason AS "suspendedReason", pending_reason AS "pendingReason", challenge_token AS "challengeToken", txt_verified_at AS "txtVerifiedAt",
  saga_step AS "sagaStep", saga_attempts AS "sagaAttempts", removal_step AS "removalStep", last_error AS "lastError",
  ses_identity_row_tag::text AS "sesIdentityRowTag", superseded_by::text AS "supersededBy", dkim_status AS "dkimStatus", dkim_tokens AS "dkimTokens",
  mail_from_status AS "mailFromStatus", inbound_mx_status AS "inboundMxStatus", policy_digest AS "policyDigest",
  policy_sync_requested_at AS "policySyncRequestedAt", last_checked_at AS "lastCheckedAt", next_check_at AS "nextCheckAt",
  consecutive_definitive_failures AS "consecutiveDefinitiveFailures", registration_expires_at AS "registrationExpiresAt",
  registration_checked_at AS "registrationCheckedAt", verified_at AS "verifiedAt", suspended_at AS "suspendedAt", removed_at AS "removedAt",
  removal_due_at AS "removalDueAt", identity_deleted_at AS "identityDeletedAt", identity_claimed_at AS "identityClaimedAt",
  identity_released_at AS "identityReleasedAt", identity_handover_to::text AS "identityHandoverTo", created_at AS "createdAt", updated_at AS "updatedAt"`;

/** 틱 롤이 고치는 칸(= 202609291100 의 틱 UPDATE GRANT). 패치의 키는 이 이름(snake)이다. */
const TICK_PATCH_COLUMNS = [
  'status',
  'suspended_reason',
  'pending_reason',
  'txt_verified_at',
  'saga_step',
  'saga_attempts',
  'removal_step',
  'last_error',
  'ses_identity_row_tag',
  'superseded_by',
  'dkim_status',
  'dkim_tokens',
  'mail_from_status',
  'inbound_mx_status',
  'policy_digest',
  'policy_sync_requested_at',
  'last_checked_at',
  'next_check_at',
  'consecutive_definitive_failures',
  'registration_expires_at',
  'registration_checked_at',
  'verified_at',
  'suspended_at',
  'removed_at',
  'removal_due_at',
  'identity_deleted_at',
  'identity_claimed_at',
  'identity_released_at',
  'identity_handover_to',
] as const;
type TickPatchColumn = (typeof TICK_PATCH_COLUMNS)[number];
export type TickPatch = Partial<Record<TickPatchColumn, unknown>>;
const TICK_PATCH_COLUMN_SET: ReadonlySet<string> = new Set(TICK_PATCH_COLUMNS);

/**
 * 틱의 범위 — 운영은 `null`(전부). 통합 테스트만 조직을 좁힌다(같은 DB 를 쓰는 다른 테스트 파일의 행을 건드리지 않게 — `enqueueResignScan` 의
 * `PublisherScope` 와 같은 자리).
 */
export interface TickScope {
  readonly organizationIds: readonly string[];
}

const scopeIds = (scope: TickScope | null): string[] | null => (scope === null ? null : [...scope.organizationIds]);

export interface NoticeSpec {
  readonly kind: DomainNoticeKind;
  readonly eventKey: string;
}

/** 알림 적기의 결말 — `capped` = 조직 하루 상한(그 종류의 칸)에 걸려 적지 않았다 · `duplicate` = 같은 사건이 이미 있다. */
type NoticeInsertOutcome = 'inserted' | 'duplicate' | 'capped';

// ---------------------------------------------------------------------------
// 틱 롤
// ---------------------------------------------------------------------------

/** 확인할 행 — 기한이 된 살아 있는 행 · 정책 동기화가 밀린 verified·suspended · 제거 사가가 남은 removed. next_check_at 순. */
export async function selectDueRows(db: DomainDb, now: Date, limit: number, scope: TickScope | null = null): Promise<DomainRow[]> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains
      WHERE ((status <> 'removed' AND next_check_at <= $1)
             OR (status IN ('verified', 'suspended') AND policy_sync_requested_at IS NOT NULL)
             -- 제거 사가는 곧바로 — 단, 후속 행의 채택을 기다리는 대체 행(wait)은 틱이 next_check_at 을 다음 주기로 미뤄 상한 슬롯을 차지하지 않는다.
             OR (status = 'removed' AND removal_step <> 'done' AND (superseded_by IS NULL OR next_check_at <= $1)))
        AND ($3::uuid[] IS NULL OR organization_id = ANY ($3::uuid[]))
      ORDER BY next_check_at, id
      LIMIT $2`,
    [now, limit, scopeIds(scope)],
  );
  return result.rows;
}

/** 클레임 후보 — 기한이 된 pending 행 중 클레임한 적 없는 것(next_check_at 순). 틱의 클레임 단계(③ 앞)가 쓴다. */
export async function selectClaimCandidates(db: DomainDb, now: Date, limit: number, scope: TickScope | null = null): Promise<DomainRow[]> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains
      WHERE status = 'pending' AND identity_claimed_at IS NULL AND next_check_at <= $1
        AND ($3::uuid[] IS NULL OR organization_id = ANY ($3::uuid[]))
      ORDER BY next_check_at, id
      LIMIT $2`,
    [now, limit, scopeIds(scope)],
  );
  return result.rows;
}

export async function selectRow(db: DomainDb, id: string, lock = false): Promise<DomainRow | null> {
  const result = await db.query<DomainRow>(`SELECT ${ROW_COLUMNS} FROM custom_domains WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return result.rows[0] ?? null;
}

/** 시간이 지나 DB 만으로 결정되는 행(72시간 만료 · 14일 제거 · 제거 예고) — 틱이 SES 호출 없이 바꾼다. */
export async function selectExpiringRows(
  db: DomainDb,
  now: Date,
  windows: { readonly pendingExpiryMs: number; readonly noticeBeforeMs: number },
  scope: TickScope | null = null,
): Promise<DomainRow[]> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains
      WHERE ((status = 'pending' AND created_at <= $1)
             OR (status = 'verifying' AND txt_verified_at <= $1)
             OR (status = 'suspended' AND suspended_reason = 'ownership_lost' AND removal_due_at IS NOT NULL AND removal_due_at <= $2))
        AND ($3::uuid[] IS NULL OR organization_id = ANY ($3::uuid[]))
      ORDER BY id`,
    [new Date(now.getTime() - windows.pendingExpiryMs), new Date(now.getTime() + windows.noticeBeforeMs), scopeIds(scope)],
  );
  return result.rows;
}

/**
 * **비활성 조직**(운영자가 거절 · 비활성화한 조직 — `review_status = 'rejected'`)의 살아 있는 행 — 틱이 removed 로 보낸다(계획 §3.3 표 "조직 비활성·삭제 →
 * 틱이 removed 처리" · 알림 없음 — 조직 절차). identity 가 있던 행은 제거 사가(정책 → identity)가 잇는다. 주소는 남는다(조직이 이미 발송 · 수신 0).
 */
export async function selectInactiveOrganizationRows(db: DomainDb, scope: TickScope | null = null): Promise<DomainRow[]> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains d
      WHERE d.status <> 'removed'
        AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = d.organization_id AND o.review_status = 'rejected')
        AND ($1::uuid[] IS NULL OR d.organization_id = ANY ($1::uuid[]))
      ORDER BY d.id`,
    [scopeIds(scope)],
  );
  return result.rows;
}

/** 그 도메인에서 이 행의 조직이 가진 살아 있는 발급 주소(정책 동기화 · 감사 입력). 다른 조직의 주소는 넣지 않는다(critic minor 4). */
export async function liveAddressesFor(db: DomainDb, row: Pick<DomainRow, 'organizationId' | 'domain'>): Promise<string[]> {
  const result = await db.query<{ address: string }>(
    `SELECT x.address FROM agent_addresses x JOIN agents a ON a.id = x.agent_id
      WHERE a.organization_id = $1 AND x.domain = $2 AND x.retired_at IS NULL
      ORDER BY x.address`,
    [row.organizationId, row.domain],
  );
  return result.rows.map((r) => r.address);
}

/**
 * 양도로 채택해도 되는 옛 행(`supersededRowId`) — **조회 한 번으로 DB 불변식을 다시 본다**(#12 보안 리뷰): 옛 행이 이 행을 `superseded_by` 로 가리키고
 * removed 이고 같은 도메인 · 다른 조직이며, 이 행은 TXT 를 통과했다. 쓰는 쪽은 `custom_domains_supersede_guard`(202610021102)가 같은 조건으로 막는다.
 */
export async function supersededRowFor(db: DomainDb, rowId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT o.id::text AS id
       FROM custom_domains o JOIN custom_domains n ON n.id = o.superseded_by
      WHERE n.id = $1 AND o.status = 'removed' AND o.domain = n.domain AND o.organization_id <> n.organization_id
        AND n.txt_verified_at IS NOT NULL AND n.status IN ('pending', 'verifying')
      ORDER BY o.removed_at DESC, o.id
      LIMIT 1`,
    [rowId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * **활성 identity 관리자** 술어(202610061001 부분 UNIQUE `custom_domains_identity_claim_key` 와 같은 식). 별칭 `d` 기준.
 */
const STEWARD_PREDICATE = `d.identity_claimed_at IS NOT NULL AND d.identity_released_at IS NULL AND d.identity_deleted_at IS NULL`;

/** 그 도메인의 활성 관리자 행(있으면 하나 — 색인). */
export async function activeStewardFor(db: DomainDb, domain: string): Promise<DomainRow | null> {
  const result = await db.query<DomainRow>(`SELECT ${ROW_COLUMNS} FROM custom_domains d WHERE d.domain = $1 AND ${STEWARD_PREDICATE} LIMIT 1`, [domain]);
  return result.rows[0] ?? null;
}

/**
 * 클레임(DB 먼저 · SES 나중 — one-shot §2.3 ①) — **트랜잭션 안에서**(도메인 진입 잠금 아래) 부른다. 색인 23505 면 진 쪽(`taken`), 그 밖의 오류는
 * 위로. 세이브포인트로 감싸 실패해도 트랜잭션은 이어진다.
 */
export async function claimIdentity(tx: DomainDb, rowId: string): Promise<'claimed' | 'taken'> {
  await tx.query('SAVEPOINT claim_identity');
  try {
    const result = await tx.query(`UPDATE custom_domains SET identity_claimed_at = now() WHERE id = $1 AND identity_claimed_at IS NULL AND status = 'pending'`, [rowId]);
    await tx.query('RELEASE SAVEPOINT claim_identity');
    return (result.rowCount ?? 0) > 0 ? 'claimed' : 'taken';
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT claim_identity');
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') return 'taken';
    throw error;
  }
}

/**
 * 같은 apex(또는 위아래로 겹치는 도메인)를 **다른 조직**이 verifying · verified · suspended 로 쥐고 있는가(one-shot §2.2) — 클레임하지 않고
 * `registrable_taken` 을 적는다. `suspended(ownership_lost)` 는 양도 후보라 예외. 술어는 `custom_domains_registrable_guard` 와 같다.
 */
export async function registrableHeldElsewhere(db: DomainDb, row: Pick<DomainRow, 'id' | 'organizationId' | 'domain' | 'registrable'>): Promise<boolean> {
  const result = await db.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM custom_domains d
        WHERE d.organization_id <> $1 AND d.id <> $2
          AND d.status IN ('verifying', 'verified', 'suspended')
          AND NOT (d.status = 'suspended' AND d.suspended_reason = 'ownership_lost')
          AND (d.registrable_domain = $4 OR d.domain = $3
               OR right($3, length(d.domain) + 1) = '.' || d.domain
               OR right(d.domain, length($3) + 1) = '.' || $3)
     ) AS held`,
    [row.organizationId, row.id, row.domain, row.registrable],
  );
  return result.rows[0]?.held ?? false;
}

/**
 * **채택해도 되는 직전 관리자 행**(`supersededRowId` — one-shot §2.4). 넘겨주기 사슬(`identity_handover_to`)을 거슬러 올라가, identity 태그를
 * 실제로 쥔 행(`ses_identity_row_tag = id` — identity 를 만들었거나 채택한 행)을 고른다. 사슬에 그런 행이 없으면 바로 앞 행(태그 기록이 늦은 경우).
 * 사슬이 없으면 옛 양도 관계(`supersededRowFor` — 202610061000 이전의 대체 행)를 본다. 사슬의 칸은 DB 가드(`custom_domains_identity_claim_guard`)가
 * 지킨다 — 같은 도메인 · 놓는 UPDATE 에서만 · 클레임한 적 없는 행에게만.
 */
export async function adoptableRowFor(db: DomainDb, rowId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE chain(id, tag, depth) AS (
       SELECT o.id, o.ses_identity_row_tag, 1
         FROM custom_domains o JOIN custom_domains n ON n.id = $1
        WHERE o.identity_handover_to = n.id AND o.identity_released_at IS NOT NULL AND o.domain = n.domain AND o.identity_deleted_at IS NULL
       UNION ALL
       SELECT o.id, o.ses_identity_row_tag, c.depth + 1
         FROM custom_domains o JOIN chain c ON o.identity_handover_to = c.id
        WHERE c.tag IS DISTINCT FROM c.id AND o.identity_released_at IS NOT NULL AND o.identity_deleted_at IS NULL AND c.depth < 32
     )
     SELECT id::text AS id FROM chain ORDER BY (tag = id) IS NOT TRUE, depth LIMIT 1`,
    [rowId],
  );
  return result.rows[0]?.id ?? (await supersededRowFor(db, rowId));
}

/**
 * 제거 사가의 **넘겨주기 대상**(one-shot §2.5) — 같은 도메인의 살아 있는(removed 아님) **클레임한 적 없는** 다른 행 중 가장 오래된 것. 받는 행은 같은
 * 트랜잭션에서 클레임하고 다음 틱에 채택한다 — 토큰이 바뀌지 않는다.
 */
export async function handoverTargetFor(db: DomainDb, row: Pick<DomainRow, 'id' | 'domain'>): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM custom_domains
      WHERE domain = $1 AND id <> $2 AND status <> 'removed' AND identity_claimed_at IS NULL
      ORDER BY created_at, id
      LIMIT 1`,
    [row.domain, row.id],
  );
  return result.rows[0]?.id ?? null;
}

/** 활성 identity 관리자 수(`domain.identities_held` — SES 할당량 감시). 범위가 있으면 그 조직만. */
export async function identitiesHeld(db: DomainDb, scope: TickScope | null = null): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM custom_domains d WHERE ${STEWARD_PREDICATE} AND ($1::uuid[] IS NULL OR d.organization_id = ANY ($1::uuid[]))`,
    [scopeIds(scope)],
  );
  return result.rows[0]?.n ?? 0;
}

/** 후속 행(이 행을 대체한 행)의 지금 상태 — 옛 행의 제거 사가 정산(`supersededRemovalAction`). */
export interface SuccessorState {
  readonly id: string;
  readonly status: DomainRow['status'];
  readonly sagaStep: DomainRow['sagaStep'];
  readonly sesIdentityRowTag: string | null;
}

/** 대체한 행(후속 행)의 상태. 없으면 null. */
export async function successorState(db: DomainDb, id: string): Promise<SuccessorState | null> {
  const result = await db.query<SuccessorState>(
    `SELECT id::text AS id, status, saga_step AS "sagaStep", ses_identity_row_tag::text AS "sesIdentityRowTag" FROM custom_domains WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** 이 행의 도메인을 쥔 다른 조직의 `suspended(ownership_lost)` 행 — 양도 후보(계획 §3.3 ⑨). */
export async function transferSourceFor(db: DomainDb, row: Pick<DomainRow, 'id' | 'organizationId' | 'domain'>): Promise<DomainRow | null> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains
      WHERE domain = $1 AND organization_id <> $2 AND id <> $3 AND status = 'suspended' AND suspended_reason = 'ownership_lost'
      LIMIT 1`,
    [row.domain, row.organizationId, row.id],
  );
  return result.rows[0] ?? null;
}

/** 칸 이름이 틱 GRANT 안인지 — 밖이면 프로그래밍 오류다(DB 도 42501 로 막는다). */
function assertPatch(patch: TickPatch): [string[], unknown[]] {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(patch)) {
    if (!TICK_PATCH_COLUMN_SET.has(column)) throw new Error(`틱이 고칠 수 없는 칸: ${column}`);
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  return [columns, values];
}

export async function updateRow(db: DomainDb, id: string, patch: TickPatch): Promise<void> {
  const [columns, values] = assertPatch(patch);
  if (columns.length === 0) return;
  const set = columns.map((column, i) => `${column} = $${String(i + 2)}`).join(', ');
  await db.query(`UPDATE custom_domains SET ${set} WHERE id = $1`, [id, ...values]);
}

/** 알림 하나(같은 사건이면 한 번 — UNIQUE(domain_id, kind, event_key)). 조직 하루 상한(종류 칸마다 10)을 넘으면 적지 않는다(`capped`). */
export async function insertNotice(db: DomainDb, row: Pick<DomainRow, 'id' | 'organizationId'>, notice: NoticeSpec): Promise<NoticeInsertOutcome> {
  // 조직 하루 상한은 **두 칸으로 나눈다** — 확인 완료(verified)가 정지 · 제거 · 만료 계열의 몫을 먹지 않게(리뷰 MEDIUM). 각 칸 DOMAIN_NOTICES_PER_ORG_PER_DAY.
  const today = await db.query<{ n: number }>(
    notice.kind === 'verified'
      ? `SELECT count(*)::int AS n FROM domain_notices WHERE organization_id = $1 AND created_at > now() - interval '24 hours' AND kind = 'verified'`
      : `SELECT count(*)::int AS n FROM domain_notices WHERE organization_id = $1 AND created_at > now() - interval '24 hours' AND kind <> 'verified'`,
    [row.organizationId],
  );
  if ((today.rows[0]?.n ?? 0) >= DOMAIN_NOTICES_PER_ORG_PER_DAY) return 'capped';
  const inserted = await db.query(
    `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain_id, kind, event_key) DO NOTHING`,
    [row.id, row.organizationId, notice.kind, notice.eventKey],
  );
  return (inserted.rowCount ?? 0) > 0 ? 'inserted' : 'duplicate';
}

/** 한 트랜잭션(틱 풀의 클라이언트 하나). 던지면 되돌린다. */
export async function inTickTransaction<T>(pool: DomainPool, run: (client: DomainDb) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 도메인 진입 잠금(같은 도메인의 verifying 진입 · 양도가 한 줄로). */
export async function lockDomainEntry(db: DomainDb, domain: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom_domain:' || $1::text, 0))`, [domain]);
}

/** 밀린 확인 — next_check_at 이 1시간 넘게 지난 살아 있는 행 수(틱마다 0 이어도 낸다). */
export async function dueBacklog(db: DomainDb, now: Date, scope: TickScope | null = null): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM custom_domains
      WHERE status <> 'removed' AND next_check_at < $1 AND ($2::uuid[] IS NULL OR organization_id = ANY ($2::uuid[]))`,
    [new Date(now.getTime() - DUE_BACKLOG_STALE_AFTER_MS), scopeIds(scope)],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * **고아 identity 후보**(0 이 정상) — 둘을 더한다:
 *   ① 옛 양도(#13 재검증): 대체된 옛 행이 제거 사가를 끝냈는데(done) 후속 행은 채택 전(saga_step none · 태그가 자기 것이 아님)에 removed 가 됐고, 어느 쪽도
 *      identity 를 지우지 않은 쌍(관리자 축 이전의 행 — 놓지 않은 대체 행만).
 *   ② 관리자 사슬(one-shot §2.5): 관리권을 놓았는데(released) 받은 행이 없거나 · 받은 행이 클레임하지 못한 채 removed 가 됐거나 · 받은 행도 관리자가 아닌데
 *      그 도메인에 활성 관리자가 없고 누구도 identity 를 지우지 않았다. removed 행의 포기(handover 없음)도 같은 조건이면 센다.
 */
export async function orphanCandidates(db: DomainDb, scope: TickScope | null = null): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT (
       SELECT count(*)::int
         FROM custom_domains o JOIN custom_domains n ON n.id = o.superseded_by
        WHERE o.status = 'removed' AND o.removal_step = 'done' AND o.identity_released_at IS NULL
          AND n.status = 'removed' AND n.saga_step = 'none' AND n.ses_identity_row_tag IS DISTINCT FROM n.id
          -- 어느 쪽 제거 사가도 identity 를 지우지 않았다(옛 행의 정상 제거 사가 · 후속 행의 사가가 지웠으면 고아가 아니다).
          AND o.identity_deleted_at IS NULL AND n.identity_deleted_at IS NULL
          AND ($1::uuid[] IS NULL OR o.organization_id = ANY ($1::uuid[]) OR n.organization_id = ANY ($1::uuid[]))
     ) + (
       SELECT count(DISTINCT o.domain)::int
         FROM custom_domains o
        WHERE o.identity_released_at IS NOT NULL AND o.identity_deleted_at IS NULL
          -- 그 도메인에 지금 활성 관리자가 없다(사슬이 끊겼다).
          AND NOT EXISTS (SELECT 1 FROM custom_domains d WHERE d.domain = o.domain AND ${STEWARD_PREDICATE})
          -- 그 도메인의 어느 행도 identity 를 지우지 않았다(놓은 뒤에).
          AND NOT EXISTS (SELECT 1 FROM custom_domains x WHERE x.domain = o.domain AND x.identity_deleted_at IS NOT NULL AND x.identity_deleted_at >= o.identity_released_at)
          AND ($1::uuid[] IS NULL OR o.organization_id = ANY ($1::uuid[]))
     ) AS n`,
    [scopeIds(scope)],
  );
  return result.rows[0]?.n ?? 0;
}

/** 요금제 강등 재료 — verified · suspended 행이 있는 조직의 요금제(행이 없으면 null → Free)와 유예 끝, 그 조직의 verified·suspended 행. */
export async function planLimitInputs(db: DomainDb, scope: TickScope | null = null): Promise<
  { readonly organizationId: string; readonly planCode: string | null; readonly graceUntil: Date | null; readonly rows: readonly DomainRow[] }[]
> {
  const rows = await db.query<DomainRow & { planCode: string | null; graceUntil: Date | null }>(
    `SELECT r.*, e.plan_code AS "planCode", e.grace_until AS "graceUntil"
       FROM (SELECT ${ROW_COLUMNS} FROM custom_domains
              WHERE status IN ('verified', 'suspended') AND ($1::uuid[] IS NULL OR organization_id = ANY ($1::uuid[]))) AS r
       LEFT JOIN org_entitlements e ON e.organization_id::text = r."organizationId"
      ORDER BY r."organizationId", r."verifiedAt", r.id`,
    [scopeIds(scope)],
  );
  const byOrg = new Map<string, { organizationId: string; planCode: string | null; graceUntil: Date | null; rows: DomainRow[] }>();
  for (const row of rows.rows) {
    const entry = byOrg.get(row.organizationId) ?? { organizationId: row.organizationId, planCode: row.planCode, graceUntil: row.graceUntil, rows: [] };
    entry.rows.push(row);
    byOrg.set(row.organizationId, entry);
  }
  return [...byOrg.values()];
}

// ---------------------------------------------------------------------------
// admin 롤(콘솔 · 조직 API)
// ---------------------------------------------------------------------------

/** 조직 도메인 수 잠금 — DB 천장 트리거(`custom_domains_limits_guard`)와 같은 키. 요금제 한도를 이 잠금 아래에서 센다. */
export async function lockOrganizationDomains(db: DomainDb, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom_domains_org:' || $1::text, 0))`, [organizationId]);
}

/** 소유 증명 토큰 — 32바이트 base64url(43자, DB CHECK). */
function newChallengeToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 새 pending 행(식별 칸 + 첫 확인 시각 = 지금). 이름 판정(`judgeCustomDomain`)과 요금제 한도는 호출자가 이 앞에서 한다. */
export async function insertPendingDomain(
  db: DomainDb,
  input: { readonly organizationId: string; readonly domain: string; readonly registrable: string; readonly createdByUserId: string | null },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token, created_by_user_id, next_check_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::text AS id`,
    [input.organizationId, input.domain, input.registrable, newChallengeToken(), input.createdByUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('custom_domains INSERT 가 id 를 돌려주지 않았다');
  return id;
}

/** 조직의 도메인 목록(removed 포함 — 최근 것 먼저). */
export async function listOrganizationDomains(db: DomainDb, organizationId: string): Promise<DomainRow[]> {
  const result = await db.query<DomainRow>(
    `SELECT ${ROW_COLUMNS} FROM custom_domains WHERE organization_id = $1 ORDER BY created_at DESC, id`,
    [organizationId],
  );
  return result.rows;
}

/**
 * 지금 확인(202 — 확인은 틱이 한다). 같은 도메인 60초에 1회(`last_manual_check_at`). 조직 시간당 상한은 라우트가 감사 행위로 센다.
 * `rate_limited` · `not_found`(다른 조직 · removed) · `requested`.
 */
export async function requestManualCheck(db: DomainDb, organizationId: string, domainId: string, minIntervalMs: number): Promise<'requested' | 'rate_limited' | 'not_found'> {
  const result = await db.query<{ outcome: string }>(
    `WITH target AS (
       SELECT id, last_manual_check_at FROM custom_domains
        WHERE id = $1 AND organization_id = $2 AND status <> 'removed' FOR UPDATE
     ), updated AS (
       UPDATE custom_domains d SET last_manual_check_at = now(), next_check_at = now()
         FROM target t
        WHERE d.id = t.id AND (t.last_manual_check_at IS NULL OR t.last_manual_check_at <= now() - make_interval(secs => $3::double precision / 1000))
       RETURNING d.id
     )
     SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'requested' WHEN EXISTS (SELECT 1 FROM target) THEN 'rate_limited' ELSE 'not_found' END AS outcome`,
    [domainId, organizationId, minIntervalMs],
  );
  return (result.rows[0]?.outcome ?? 'not_found') as 'requested' | 'rate_limited' | 'not_found';
}

/** 제거 요청(쓰기 1회 — 트리거가 그 자리에서 removed 로). 주소는 남는다(자발적 제거 · D-H). */
export async function requestRemoval(db: DomainDb, organizationId: string, domainId: string): Promise<'removed' | 'not_found'> {
  const result = await db.query(
    `UPDATE custom_domains SET removal_requested_at = now()
      WHERE id = $1 AND organization_id = $2 AND status <> 'removed' AND removal_requested_at IS NULL`,
    [domainId, organizationId],
  );
  return (result.rowCount ?? 0) > 0 ? 'removed' : 'not_found';
}
