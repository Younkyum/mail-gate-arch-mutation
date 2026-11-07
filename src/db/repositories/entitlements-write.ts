/**
 * src/db/repositories/entitlements-write.ts — `org_entitlements` **쓰기 한 곳**(202609250300 · 202609250400, ADR-0011 · ADR-0012).
 *
 * 쓰는 쪽은 셋이고 모두 이 함수를 부른다: 운영자 CLI(`pnpm admin:plan`, `atmark_billing_operator`) · 검토 활성화의 베타 부여
 * (`admin:org-review --activate`, 소유자 롤) · 결제 동기화(billing-sync λ, `atmark_billing`). 읽기(정책 로더·콘솔)는 `entitlements.ts` 에 그대로 있다 —
 * 그 파일은 마이그레이션 전에도 돌아야 해서 제어 칸을 읽지 않는다.
 *
 * 한 번의 쓰기 = 호출자의 트랜잭션 안에서: 조직 잠금(`org_entitlements:<조직>` advisory — 같은 세션은 다시 잡아도 된다) → 지금 행 →
 * **같으면 쓰지 않는다**(`changed: false` — 버전만 느는 빈 사건을 만들지 않는다) → 감사 행(같은 버전) → 행 INSERT(v1)/UPDATE(v+1).
 * "같다" = 요금제 · 한도 열한 칸(늦게 더한 두 칸은 스키마에 있을 때) · 유예 · **출처** · 제어 칸(`provider_override_allowed`)이 모두 같다. 출처만 바뀌어도(운영자 행과 같은 값을
 * 공급자가 원한다) 새 버전을 쓴다 — 그래야 그 행이 provider 행이 되어 뒤의 해지·만료 강등이 닿는다(코드 검토 M-1). 넘김 표시만 바뀌어도
 * 새 버전이다(`--release-to-provider`). 원인·행위자·메모는 비교하지 않는다 — 같은 상태를 다른 계기로 다시 적지 않는다.
 *
 * DB 가 다시 본다: version +1 · 버전마다 감사 짝(지연 트리거) · 출처↔원인 짝 · 출처-롤 가드(billing 은 provider 만, 넘기지 않은 운영자 행은 칸별
 * 지배일 때만 · operator 롤은 operator 만) · provider 출처 요금제(L9) · 제어 칸은 operator 출처에서만. 이 파일의 비교는 빈 버전을 피하려는 것이지
 * 권한 판단이 아니다 — 판단은 결정 함수(`src/billing/sync-decision.ts`)와 DB 트리거가 한다.
 *
 * **컬럼 단위 권한**: `atmark_billing_operator` 는 `billing_audit.provider_event_id` 를 INSERT 하지 못한다 — 그 칸은 값이 있을 때만 문장에 넣는다.
 */

import {
  ENTITLEMENTS_TABLE_MISSING,
  LATE_LIMIT_KEYS,
  LIMIT_COLUMNS,
  type EntitlementCause,
  type EntitlementLimits,
  type EntitlementSource,
  type PlanCode,
} from '../../billing/plans';
import type { Queryable } from '../client';
import type { OrgEntitlementsControlRow } from '../schema';
import { ORG_ENTITLEMENTS_COLUMNS } from './entitlements';
import { selectRow } from './rows';

/** 표(202609250300)가 없다 — 쓰지 않는다(런북 deploy §20: 마이그레이션이 먼저다). */
export class EntitlementsNotMigratedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementsNotMigratedError';
  }
}

/**
 * 조직 요금제 잠금 — 쓰는 모든 경로(CLI · 활성화 · sync)가 같은 키를 잡는다. 트랜잭션이 끝나면 풀린다.
 *
 * 잠금 순서는 한 방향이 **아니다** — `admin:org-review --activate` 는 조직 행을 먼저 잠그고 이것을 잡는데, 다른 경로는 이것을 쥔 채
 * `org_entitlements`·`billing_audit` INSERT/UPDATE 의 FK 검사로 같은 조직 행에 `FOR KEY SHARE` 를 건다. 교착하지 않는 이유는 순서가 아니라
 * 강도다: org-review 는 조직 행을 `FOR NO KEY UPDATE` 로 잡고(검토 상태 UPDATE 도 키가 아닌 칸만 바꾼다), 그 잠금은 `FOR KEY SHARE` 와 충돌하지
 * 않는다(코드 검토 L-2). 조직 행을 `FOR UPDATE` 로 잠그는 경로를 여기 더하면 교착한다.
 */
export async function lockOrgEntitlements(db: Queryable, organizationId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('org_entitlements:' || $1::text, 0))`, [organizationId]);
}

interface SchemaState {
  readonly table: boolean;
  /** 202609250400 의 제어 칸이 있는가 — 없으면(그 마이그레이션 전) 제어 칸 없이 읽고 쓴다(소유자 롤의 검토 활성화가 배포 순서에 묶이지 않게). */
  readonly control: boolean;
  /**
   * 메일 기본기 2차의 두 칸(202609270105)이 있는가 — 없으면(그 마이그레이션 전) 아홉 칸만 쓰고 비교한다. 있는데 이 쓰기가 두 칸을 모르면
   * DB 트리거 `org_entitlements_fill_new_limits` 가 카탈로그 값으로 채운다 — 이 코드는 늘 두 칸을 함께 쓴다.
   */
  readonly lateLimits: boolean;
}

async function schemaState(db: Queryable): Promise<SchemaState> {
  const row = await selectRow<{ has_table: boolean; has_control: boolean; has_late: boolean }>(
    db,
    `SELECT to_regclass('public.org_entitlements') IS NOT NULL AS has_table,
            EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = to_regclass('public.org_entitlements') AND attname = 'provider_override_allowed' AND NOT attisdropped) AS has_control,
            EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = to_regclass('public.org_entitlements') AND attname = 'attachment_bytes_total_max' AND NOT attisdropped) AS has_late`,
  );
  return { table: row?.has_table === true, control: row?.has_control === true, lateLimits: row?.has_late === true };
}

/**
 * 쓰는 쪽이 보는 지금 행(제어 칸 포함). 행이 없으면 `null`, 표가 없으면 `'table_missing'`. 잠금은 호출자가 잡는다(`lockOrgEntitlements`) —
 * sync 는 잠금 → 이 함수 → 결정 함수 → `writeEntitlementVersion` 순서로 부른다.
 */
export async function loadOrgEntitlementsControlRow(
  db: Queryable,
  organizationId: string,
): Promise<OrgEntitlementsControlRow | typeof ENTITLEMENTS_TABLE_MISSING | null> {
  const state = await schemaState(db);
  if (!state.table) return ENTITLEMENTS_TABLE_MISSING;
  return loadControlRow(db, organizationId, state);
}

async function loadControlRow(db: Queryable, organizationId: string, state: SchemaState): Promise<OrgEntitlementsControlRow | null> {
  const control = state.control ? 'provider_override_allowed' : 'false AS provider_override_allowed';
  return selectRow<OrgEntitlementsControlRow>(
    db,
    `SELECT ${ORG_ENTITLEMENTS_COLUMNS}, ${control} FROM org_entitlements WHERE organization_id = $1`,
    [organizationId],
  );
}

export interface EntitlementWriteInput {
  readonly organizationId: string;
  readonly plan: PlanCode;
  /** 쓸 한도(카탈로그 값 또는 운영자 덮어쓰기). 천장 넘는 값은 DB CHECK 가 거부한다. */
  readonly limits: EntitlementLimits;
  readonly graceUntil: Date | null;
  /** `default` 는 백필만 쓴다(202609250300) — 여기서는 받지 않는다. */
  readonly source: Exclude<EntitlementSource, 'default'>;
  readonly cause: EntitlementCause;
  /** operator 출처에서만 true(`--release-to-provider`). provider 출처로 쓰면 false 여야 한다(CHECK). */
  readonly providerOverrideAllowed: boolean;
  /** 감사 행위자 — `admin:plan:<운영자>` · `admin:org-review:<운영자>` · `provider:paddle`. 투명성 잎에는 싣지 않는다. */
  readonly actor: string;
  /** 공급자 이벤트 id(`evt_…`) — sync 의 `event` 계기만. 운영자 롤은 이 칸을 쓸 수 없다. */
  readonly providerEventId: string | null;
  readonly note: string | null;
}

export interface EntitlementWriteResult {
  readonly changed: boolean;
  /** 쓰기 전 요금제(행이 없었으면 `null`). */
  readonly fromPlan: string | null;
  /** 쓴 뒤(또는 그대로 둔) 버전. */
  readonly version: number;
}

/** 이 스키마가 가진 한도 칸(늦게 더한 두 칸은 있을 때만). */
function writableLimitColumns(state: SchemaState): typeof LIMIT_COLUMNS {
  return state.lateLimits ? LIMIT_COLUMNS : LIMIT_COLUMNS.filter(([key]) => !LATE_LIMIT_KEYS.has(key));
}

function sameAsRow(row: OrgEntitlementsControlRow, input: EntitlementWriteInput, state: SchemaState): boolean {
  const record = row as unknown as Record<string, unknown>;
  const control = state.control;
  return (
    row.plan_code === input.plan &&
    row.source === input.source &&
    // 백필 전 NULL 칸은 `Number(null) = 0` 이라 늘 "다르다" 가 된다 — 한 번 쓰면 채워진다.
    writableLimitColumns(state).every(([key, column]) => record[column] !== null && Number(record[column]) === input.limits[key]) &&
    (row.grace_until?.getTime() ?? null) === (input.graceUntil?.getTime() ?? null) &&
    (!control || row.provider_override_allowed === input.providerOverrideAllowed)
  );
}

/**
 * 엔타이틀먼트 새 버전 한 장(또는 같으면 아무것도). **호출자의 트랜잭션 안에서** 부른다 — 감사 짝 트리거가 커밋 때 본다.
 * 표가 없으면 `EntitlementsNotMigratedError`. 제어 칸이 아직 없는데(202609250400 전) 넘기기·provider 출처를 쓰려 하면 같은 오류.
 */
export async function writeEntitlementVersion(db: Queryable, input: EntitlementWriteInput): Promise<EntitlementWriteResult> {
  await lockOrgEntitlements(db, input.organizationId);
  const state = await schemaState(db);
  if (!state.table) {
    throw new EntitlementsNotMigratedError('org_entitlements 표가 없다 — 마이그레이션 202609250300 을 먼저 적용한다(런북 deploy §20).');
  }
  if (!state.control && (input.providerOverrideAllowed || input.source === 'provider')) {
    throw new EntitlementsNotMigratedError('org_entitlements.provider_override_allowed 가 없다 — 마이그레이션 202609250400 을 먼저 적용한다(런북 deploy §21).');
  }
  const current = await loadControlRow(db, input.organizationId, state);
  if (current !== null && sameAsRow(current, input, state)) {
    return { changed: false, fromPlan: current.plan_code, version: Number(current.version) };
  }

  const version = current === null ? 1 : Number(current.version) + 1;
  const auditColumns = ['organization_id', 'from_plan', 'to_plan', 'cause', 'actor', 'note', 'entitlement_version'];
  const auditValues: unknown[] = [input.organizationId, current?.plan_code ?? null, input.plan, input.cause, input.actor, input.note, version];
  if (input.providerEventId !== null) {
    auditColumns.push('provider_event_id');
    auditValues.push(input.providerEventId);
  }
  await db.query(
    `INSERT INTO billing_audit (${auditColumns.join(', ')}) VALUES (${auditValues.map((_value, index) => `$${String(index + 1)}`).join(', ')})`,
    auditValues,
  );

  const limits = writableLimitColumns(state);
  const limitColumns = limits.map(([, column]) => column);
  const columns = ['plan_code', 'source', 'cause', ...limitColumns, 'grace_until', ...(state.control ? ['provider_override_allowed'] : [])];
  const values: unknown[] = [
    input.plan,
    input.source,
    input.cause,
    ...limits.map(([key]) => input.limits[key]),
    input.graceUntil,
    ...(state.control ? [input.providerOverrideAllowed] : []),
  ];
  const placeholder = (index: number): string => `$${String(index + 2)}`;
  if (current === null) {
    await db.query(
      `INSERT INTO org_entitlements (organization_id, ${columns.join(', ')}, version)
       VALUES ($1, ${columns.map((_column, index) => placeholder(index)).join(', ')}, 1)`,
      [input.organizationId, ...values],
    );
  } else {
    await db.query(
      `UPDATE org_entitlements
          SET ${columns.map((column, index) => `${column} = ${placeholder(index)}`).join(', ')}, version = version + 1
        WHERE organization_id = $1`,
      [input.organizationId, ...values],
    );
  }
  return { changed: true, fromPlan: current?.plan_code ?? null, version };
}
