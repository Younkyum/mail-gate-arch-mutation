/**
 * migrate 함수 — 수동 invoke 또는 CDK 커스텀 리소스(`cr.Provider` 의 onEvent). **액션 셋, 순서대로:**
 *
 *   1. `{"action":"bootstrap-roles"}` — **RDS 마스터**로 소유자 롤(`atmark_owner`)·앱 롤(`atmark_app`)·제한 롤
 *      (`atmark_admin`·`atmark_login_mailer`, ADR-0006 · `atmark_passport_signer`, 계약 §3 · `atmark_tlog`·`atmark_tlog_anchor`, ADR-0008 ·
 *      `atmark_billing`·`atmark_billing_operator`, ADR-0012)을 만들고 DB 소유권을 소유자 롤로 넘긴 뒤, 새 비밀번호를
 *      `atmark/db/owner`·`atmark/db/app`·`atmark/db/admin`·`atmark/db/login-mailer` 에 쓴다(`role-bootstrap.ts`).
 *      멱등 — 이미 채워진 비밀의 롤은 건드리지 않는다(회전 없음).
 *   2. `{"action":"migrate"}` (또는 `{}` · 커스텀 리소스 Create/Update) — **소유자 롤**로 `db/migrate.ts` 의 `migrate`.
 *      적용 뒤 **앱 롤이 소유자가 아니다** 를 한 번 더 본다: 마이그레이션 4 의 `DO $$` 는 "`audit_logs` 의 소유자가
 *      `atmark_app` 이 아니다" 만 본다 — 앱 롤이 소유자 롤의 **멤버**이거나 superuser·`rds_superuser` 이면 그 단언은
 *      참인 채로 앱이 트리거를 DROP 할 수 있다. 거짓이면 던진다(커스텀 리소스면 배포 실패).
 *   3. `{"action":"status"}` — 소유자 롤로 읽기만: 적용 수/파일 수·미적용 목록·앱 롤 검사·`sender_marks` INSERT 권한 ·
 *      앱 롤의 로그인·세션 테이블 권한(0 이어야 한다) · 앱 롤의 금지 컬럼 UPDATE(`owner_email`·동결·정지 — 0 이어야 한다) ·
 *      앱 롤의 금지 권한(프로비저닝·정책·토큰·억제 목록 쓰기 등 — 202609230750, 0 이어야 한다) · 가드 트리거·CHECK 의 존재 ·
 *      DB `TEMPORARY` 를 가진 롤(0 이어야 한다) · **제한 롤 셋(앱·admin·login-mailer)이 아무것도 소유하지 않고 허용 목록
 *      (`RESTRICTED_ROLE_GRANTS`) 밖의 권한이 없다** · SECURITY DEFINER 함수가 PUBLIC 실행 불가·search_path 고정(셀프 가입) ·
 *      호스팅 운영자 콘솔 검사 일곱(`ops` — `.omc/plans/ops-console.md` §4 P1 "migrate status 편집").
 *   4. `{"action":"ops-role-lock"}` · `{"action":"ops-role-unlock"}` — **RDS 마스터**로 `atmark_ops` 의 LOGIN 을 끄고 그 롤의 백엔드를 끊는다(하드 킬
 *      스위치, §5 I-5) · 다시 켠다. `ops_settings.hard_locked` 는 소유자 롤 CLI(`admin:ops-operator --hard-lock`)가 **먼저** 영속한다.
 *
 * 커스텀 리소스 `Delete` 는 아무것도 하지 않는다(스키마를 되돌리는 경로는 없다 — append-only).
 * 풀은 호출마다 열고 닫는다(드문 호출이고, 소유자·마스터 자격증명을 쥔 커넥션을 따뜻한 실행 환경에 남기지 않는다).
 * 알 수 없는 `action` 은 던진다 — 오타가 "기본 동작(migrate)" 으로 조용히 흘러가지 않게.
 */

import type { Pool, PoolClient } from 'pg';

import { BETA_ON_ACTIVATION } from '../../billing/plans';
import { APP_ROLE, loadMigrations, migrate, type MigrationReport } from '../../db/migrate';
import { OPS_TABLES } from '../../db/schema';
import { OPS_ROLE_CONNECTION_LIMIT } from '../../ops/contract';
import { log } from '../../observability/logger';
import { composeMigration, composeRoleBootstrap, type Composed, type RoleBootstrapDependencies } from '../composition';
import { beginInvocation, platformOf, type LambdaContext } from '../lambda';
import {
  ADMIN_ROLE,
  APP_ROLE_NAME,
  BILLING_OPERATOR_ROLE,
  BILLING_ROLE,
  bootstrapRoles,
  DOMAIN_TICK_ROLE,
  AI_WATCH_ROLE,
  inspectRestrictedRole,
  LOGIN_MAILER_ROLE,
  lockOpsRole,
  OPS_ROLE,
  OPS_ROLE_SETTINGS,
  OWNER_ROLE,
  PASSPORT_SIGNER_ROLE,
  RESTRICTED_ROLE_GRANTS,
  TLOG_ANCHOR_ROLE,
  TLOG_ROLE,
  unlockOpsRole,
  type OpsRoleLockOutcome,
  type RestrictedRoleReport,
  type RoleAction,
} from '../role-bootstrap';

/** 커스텀 리소스의 물리 id. 하나뿐이다 — 스키마는 DB 하나에 하나. */
export const MIGRATION_RESOURCE_ID = 'atmark-db-migrations';

export type MigrateAction = 'migrate' | 'bootstrap-roles' | 'status' | 'ops-role-lock' | 'ops-role-unlock';

/** `ops-role-lock` · `ops-role-unlock` 의 결과. */
export interface OpsRoleLockResult extends OpsRoleLockOutcome {
  readonly action: 'ops-role-lock' | 'ops-role-unlock';
}

/** 수동 invoke 는 `{}` 또는 `{"action": …}`. 커스텀 리소스는 `RequestType` 을 싣는다(액션은 migrate 뿐). */
export interface MigrateEvent {
  readonly action?: string;
  readonly RequestType?: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
}

export interface MigrateResult {
  readonly PhysicalResourceId: string;
  /** 커스텀 리소스 `GetAtt` 로 읽히는 값. 개수만. */
  readonly Data: { readonly applied: number; readonly alreadyApplied: number };
  /** 이번에 적용한 파일 이름(수동 invoke 의 확인용). */
  readonly appliedFiles: readonly string[];
}

/** 앱 롤이 소유자·소유자의 멤버·superuser 계열이다. **배포를 멈춘다.** */
export class AppRoleOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppRoleOwnershipError';
  }
}

interface RoleRow {
  role_exists: boolean;
  rolsuper: boolean | null;
  rolcreaterole: boolean | null;
  rolbypassrls: boolean | null;
  owner_member: boolean | null;
  rds_superuser: boolean | null;
}

/** 운영 DB 에서 "앱 롤은 소유자가 아니다" 를 확인한다. 위반 항목의 **이름**만 싣는다. */
export async function verifyAppRoleIsNotOwner(client: PoolClient): Promise<void> {
  const result = await client.query<RoleRow>(
    `SELECT r.oid IS NOT NULL AS role_exists,
            r.rolsuper, r.rolcreaterole, r.rolbypassrls,
            pg_has_role(r.oid, c.relowner, 'MEMBER') AS owner_member,
            (SELECT bool_or(pg_has_role(r.oid, g.oid, 'MEMBER')) FROM pg_roles g WHERE g.rolname = 'rds_superuser') AS rds_superuser
       FROM pg_class c
       LEFT JOIN pg_roles r ON r.rolname = $1
      WHERE c.oid = 'public.audit_logs'::regclass`,
    [APP_ROLE],
  );
  const row = result.rows[0];
  if (row === undefined || !row.role_exists) throw new AppRoleOwnershipError(`롤 ${APP_ROLE} 이 없다.`);
  const violations = [
    row.rolsuper === true ? 'superuser' : null,
    row.rolcreaterole === true ? 'createrole' : null,
    row.rolbypassrls === true ? 'bypassrls' : null,
    row.owner_member === true ? 'audit_logs 소유자(또는 그 멤버)' : null,
    row.rds_superuser === true ? 'rds_superuser 멤버' : null,
  ].filter((violation): violation is string => violation !== null);
  if (violations.length > 0) {
    throw new AppRoleOwnershipError(
      `${APP_ROLE} 이 ${violations.join(', ')} 이다. 앱 롤은 테이블 소유자가 아니어야 한다 — audit 불변성 트리거를 DROP 할 수 있다.`,
    );
  }
}

export interface RoleBootstrapResult {
  readonly action: 'bootstrap-roles';
  readonly owner: RoleAction;
  readonly app: RoleAction;
  readonly admin: RoleAction;
  readonly loginMailer: RoleAction;
  readonly passportSigner: RoleAction;
  readonly tlog: RoleAction;
  readonly tlogAnchor: RoleAction;
  readonly billing: RoleAction;
  readonly billingOperator: RoleAction;
  readonly ops: RoleAction;
  /** 고객 도메인 틱 롤(ADR-0014) — 단계 2 부터 비밀 계획(`atmark/db/domain-tick`)을 따른다. */
  readonly domainTick: RoleAction;
  /** AI 감시 결과 λ 롤(ADR-0017 초안) — 비밀 `atmark/db/ai-watch`. */
  readonly aiWatch: RoleAction;
  readonly databaseOwner: string;
  /** 이번 호출이 값을 쓴 비밀(ARN). 비밀번호는 싣지 않는다. */
  readonly secretsWritten: readonly string[];
}

export interface MigrationStatus {
  readonly action: 'status';
  readonly ok: boolean;
  readonly migrationFiles: number;
  readonly migrationsApplied: number;
  readonly pending: readonly string[];
  readonly appRoleOk: boolean;
  /** 앱 롤 검사가 실패했으면 그 사유(위반 항목 이름). */
  readonly appRoleProblem: string | null;
  /** `false` 여야 한다 — 에이전트가 자기 신뢰를 올리지 못한다(202609230020). */
  readonly appCanInsertSenderMarks: boolean;
  /**
   * 앱 롤이 로그인·세션·감사 테이블에 가진 권한(ADR-0006 — 비어 있어야 한다). 앱 롤이 링크 id·만료를 읽으면 api Lambda
   * 탈취가 소유자 세션이 된다.
   */
  readonly appLoginPrivileges: readonly string[];
  /**
   * 앱 롤이 UPDATE 할 수 있는 금지 컬럼(202609230730 — 비어 있어야 한다). `owner_email` 을 바꿀 수 있으면 api 탈취가 로그인
   * 링크를 자기 메일함으로 돌린다(H1 우회). 동결·정지 컬럼을 바꿀 수 있으면 운영자·소유자의 정지를 푼다.
   */
  readonly appForbiddenColumnUpdates: readonly string[];
  /**
   * 앱 롤이 가진 금지 권한(202609230750 — 비어 있어야 한다). 프로비저닝 테이블 INSERT 는 영속 백도어 에이전트(H-B), 정책·토큰
   * UPDATE 는 정책 해제·폐기 토큰 부활(H-A), 억제 목록 쓰기는 신고한 수신자에게 다시 보내는 길이다.
   */
  readonly appForbiddenPrivileges: readonly string[];
  /** 없거나 꺼진 가드 트리거·CHECK(202609230750 — 비어 있어야 한다). 권한 축소가 닫지 못하는 쓰기를 이것들이 막는다. */
  readonly missingGuards: readonly string[];
  /**
   * 있지만 **`NOT VALID` 로 남은** 가드 CHECK·FK(재검토 N4-c — 비어 있어야 한다). 기존 행을 검증하지 않은 제약은 "표의 모든 행이 이 모양이다" 를
   * 말하지 못한다 — `NOT VALID` 로 더하고 다음 파일에서 `VALIDATE` 하는 쌍이 반쯤 적용된 상태다. 설계상 `NOT VALID` 로 남을 수 있는 가드
   * (`NOT_VALID_TOLERATED_GUARDS`)는 세지 않는다.
   */
  readonly unvalidatedGuards: readonly string[];
  /** 현재 DB 에 `TEMPORARY` 를 가진 앱·제한 롤(PUBLIC 경유 포함 — 비어 있어야 한다, L-D). */
  readonly databaseTempRoles: readonly string[];
  /**
   * 예약 로컬파트 CHECK 가 **기존 행까지** 검증됐는가(정보 — ok 에 넣지 않는다). `false` 면 예약 로컬파트 주소가 이미 있어
   * `NOT VALID` 로 남은 것이다(새 행은 검사된다). 운영에서는 `true` 여야 한다 — `docs/runbooks/deploy.md`.
   */
  readonly reservedLocalPartCheckValidated: boolean | null;
  /**
   * 운영자 예약 주소(`atmark_operator_assignable_addresses()`)를 **활성으로 쥔 행인데 그 조직의 허가 행(`operator_address_grants`)이 없는 주소**
   * (202609301500 — 배포 §29). 허가 없는 조직이 `support@`·`onve@` 를 쥐면 지원 메일함을 가로챈다 — 하나라도 있으면 ok=false 다. 예전에 용인하던
   * `claude@atmark.ai` 는 202610141200 에서 운영자 목록을 떠났다(진윤겸 2026-10-14 — 그 에이전트를 지울 수 있게 · 배포 §55) — 이제 이 목록에 나오지 않는다.
   * 표·함수가 아직 없으면(미적용) 빈 목록 — pending 이 이미 ok=false 로 만든다.
   */
  readonly operatorAddressesWithoutGrant: readonly string[];
  /** 제한 롤(앱·admin·login-mailer)의 실제 권한과 위반 항목. 위반이 하나라도 있으면 ok=false. */
  readonly restrictedRoles: readonly RestrictedRoleReport[];
  /**
   * `public` 의 SECURITY DEFINER 함수 중 **PUBLIC 이 실행할 수 있거나 search_path 가 고정되지 않은 것**(비어 있어야 한다).
   * 소유자 권한으로 도는 함수는 부를 수 있는 롤이 곧 권한이다 — `create_signup_organization`(조직 생성)을 PUBLIC 이 부르면 앱 롤이
   * 조직을 만든다. search_path 가 풀려 있으면 호출자가 `pg_temp`·자기 스키마의 같은 이름 객체로 함수 안의 이름을 가로챈다.
   */
  readonly unsafeSecurityDefiners: readonly string[];
  /**
   * 정책 v2 이전 결과(202609241010 — **정보**, ok 에 넣지 않는다). 레거시 모드는 소유자 롤이 일부러 만들 수 있다(데모·테스트) —
   * 운영에서는 `legacyOutboundModeAgents = 0`·`configListAgents = 0` 이어야 이전이 끝난 것이다(`docs/runbooks/deploy.md`).
   * 테이블·컬럼이 아직 없으면(미적용) `null` — pending 이 이미 ok=false 로 만든다.
   */
  readonly policyV2: {
    /** 현재 버전 스냅샷의 발신 모드가 `approval_required`·`reply_only` 인 에이전트 수. */
    readonly legacyOutboundModeAgents: number;
    /** `agent_policies.config_json` 에 옛 목록 키(`allowlist`·`blocklist`)가 남은 에이전트 수 — 엔진은 읽지 않지만 이전이 덜 된 흔적. */
    readonly configListAgents: number;
    /** 발신·수신 목록 규칙 수(방향·목록별). */
    readonly contactRules: Readonly<Record<string, number>>;
  } | null;
  /**
   * 투명성 로그(202609241600, ADR-0008 — **정보**, ok 에 넣지 않는다). 서열 밀림(처리 안 된 outbox · 가장 오래된 것의 나이) · 마지막 에폭의
   * 나이(1시간을 크게 넘으면 에폭 지연) · 게시 안 된 에폭 · 24시간 넘게 확정 안 된 앵커. 런북 `docs/runbooks/transparency-log.md` §7.
   */
  readonly transparency: {
    readonly pendingOutbox: number;
    readonly oldestPendingSeconds: number | null;
    readonly latestEpoch: number | null;
    readonly latestEpochAgeSeconds: number | null;
    readonly unpublishedEpochs: number;
    readonly staleAnchors: number;
  } | null;
  /**
   * 결제 공급자 연동(202609250400, ADR-0012 — **정보**, ok 에 넣지 않는다). 처리 안 된·실패한 웹훅 이벤트 · 가장 오래된 미처리 이벤트의 나이 ·
   * 비종단 구독 · 열린 체크아웃 · 마지막으로 끝난 reconcile. 표가 아직 없으면(미적용) `null` — pending 이 이미 ok=false 로 만든다.
   */
  readonly billing: {
    readonly pendingEvents: number;
    readonly failedEvents: number;
    readonly oldestPendingSeconds: number | null;
    readonly nonTerminalSubscriptions: number;
    readonly openCheckouts: number;
    readonly reconcileLastCompletedAt: string | null;
  } | null;
  /**
   * 호스팅 운영자 콘솔(202609290500·0510, `.omc/plans/ops-console.md` §4 P1) — 표가 아직 없으면(미적용) `null`(pending 이 이미 ok=false).
   * 검사 1~6 은 ok 에 들어가고, 7(스위치 쌍)은 **경고**다.
   */
  readonly ops: OpsStatus | null;
}

export interface OpsStatus {
  /** 1. `atmark_ops` 의 표 쓰기 권한(도메인 표 · ops 표 모두 — INSERT·UPDATE·DELETE·TRUNCATE·REFERENCES·TRIGGER). 비어 있어야 한다. */
  readonly opsRoleWrites: readonly string[];
  /** 2. 앱·admin·결제·서명·투명성 롤의 ops **표** 권한(`<롤>:<표>:<권한>`). 비어 있어야 한다(앱 롤은 함수 셋만 — `RESTRICTED_ROLE_GRANTS`). */
  readonly foreignOpsTablePrivileges: readonly string[];
  /** 3·5. ops 함수의 EXECUTE 가 허용된 롤 밖으로 샜거나(코어·티켓·내부 함수는 소유자만) 정의 함수가 ops 표 소유자의 것이 아니다. */
  readonly functionProblems: readonly string[];
  /** 4. `atmark_ops` 의 rolconfig 셋 · CONNECTION LIMIT 3 · NOINHERIT 이 어긋난 것. */
  readonly roleConfigProblems: readonly string[];
  /** 6. `hard_locked` 인데 `atmark_ops` 가 LOGIN 할 수 있다(하드 킬 스위치가 풀렸다). `true` 면 ok=false. */
  readonly hardLockedButCanLogin: boolean;
  /** 7. **경고** — `ops_activation_beta_enabled()` 와 빌드된 `BETA_ON_ACTIVATION` 이 다르다(베타 종료는 커밋 + 마이그레이션 한 쌍). */
  readonly betaSwitchMismatch: boolean;
  /** 정보 — 소프트·하드 킬 스위치의 지금 값. */
  readonly consoleEnabled: boolean;
  readonly hardLocked: boolean;
}

/**
 * 앱 롤이 **UPDATE 하면 안 되는** 컬럼(202609230730). 앱 코드가 쓰는 컬럼은 `organizations.sending_started_at` 하나뿐이다.
 * `agents.status` 도 넣는다 — 앱 코드는 바꾸지 않고(프로비저닝·정지는 CLI·admin), 바꿀 수 있으면 정지 우회의 절반이다.
 */
export const APP_FORBIDDEN_COLUMN_UPDATES = [
  ['organizations', 'owner_email'],
  ['organizations', 'abuse_freeze'],
  ['organizations', 'owner_paused'],
  ['agents', 'status'],
  ['agents', 'suspended_by'],
  // 셀프 가입(202609240800) — 운영자 검토 상태. 바꿀 수 있으면 api 탈취가 검토 전 조직의 외부 발송을 연다.
  ['organizations', 'review_status'],
  ['organizations', 'signup_source'],
  ['organizations', 'reviewed_at'],
  // 과금 P0(202609250300, ADR-0011 B6) — 결제 상태(Stage 0 킬 스위치). 바꿀 수 있으면 api 탈취가 연체 차단을 스스로 푼다.
  ['organizations', 'billing_status'],
] as const;

/**
 * 앱 롤이 **가지면 안 되는** 권한(202609230750). `[테이블, 권한]` 은 테이블 단위 **또는 어느 컬럼 하나라도**(INSERT·UPDATE)
 * 가지면 위반이고, `[테이블, 권한, 컬럼]` 은 그 컬럼만 본다. 앱 코드가 쓰는 권한은 여기 없다 — 그 목록은
 * `RESTRICTED_ROLE_GRANTS[atmark_app]` 이고, 이 목록은 "다시 열리면 무엇이 깨지는가" 를 이름으로 보이기 위한 것이다.
 */
export const APP_FORBIDDEN_PRIVILEGES: readonly (readonly [string, 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE', string?])[] = [
  // H-B — 영속 백도어 에이전트(조직·에이전트·주소·토큰·키·여권·정책·버전).
  ...(['organizations', 'agents', 'agent_addresses', 'agent_api_keys', 'agent_keypairs', 'passports', 'agent_policies', 'policy_versions'] as const).map(
    (table) => [table, 'INSERT'] as const,
  ),
  // H-B — 주소 가로채기 · H-A — 정책 해제 · 폐기 토큰 부활.
  ['agent_addresses', 'UPDATE'],
  ['agent_policies', 'UPDATE'],
  // 202609241400(US-007)이 `last_used_at` 한 칸만 열었다 — `revoked_at` 은 여전히 0이어야 한다(폐기 토큰 부활, H-A ③).
  ['agent_api_keys', 'UPDATE', 'revoked_at'],
  ['policy_versions', 'UPDATE'],
  // 정책 v2 연락처 목록(202609241010) — 앱 코드는 읽기만. 쓰기가 열리면 api 탈취가 자기 allow 목록을 늘린다(H-A ② 와 같은 길).
  ['agent_contact_rules', 'INSERT'],
  ['agent_contact_rules', 'UPDATE'],
  ['agent_contact_rules', 'DELETE'],
  ['agent_contact_rules', 'TRUNCATE'],
  // 억제 목록 — 앱 코드는 읽기만.
  ['suppression_entries', 'INSERT'],
  ['suppression_entries', 'UPDATE'],
  ['suppression_entries', 'DELETE'],
  // 릴리스 일정·승인 알림은 승인 요청 트리거(SECURITY DEFINER)만 만든다.
  ['approval_releases', 'INSERT'],
  ['approval_notifications', 'INSERT'],
  // 결정 칸을 INSERT 로 채우면 "처음부터 승인된 요청" 이 된다.
  ['approval_requests', 'INSERT', 'status'],
  ['approval_requests', 'INSERT', 'decided_at'],
  ['approval_requests', 'INSERT', 'decided_by'],
  ['approval_requests', 'INSERT', 'granted_scope'],
  // 앱 코드에 UPDATE 가 없다.
  ['webhook_endpoints', 'UPDATE'],
  ['inbound_messages', 'UPDATE'],
  // 웹훅 인증 헤더(202610141400) — 쓰기는 정의자 함수뿐. 표 쓰기가 열리면 api 탈취가 기존 엔드포인트에 다른 봉인값을 끼운다.
  ['webhook_endpoint_authorizations', 'INSERT'],
  ['webhook_endpoint_authorizations', 'UPDATE'],
  ['webhook_endpoint_authorizations', 'DELETE'],
  ['webhook_endpoint_authorizations', 'TRUNCATE'],
  // 시스템 메일 억제(202609240900) — 앱 롤은 적기만 한다. 고치거나 지울 수 있으면 api 탈취가 불만을 신고한 주소로 가입·로그인
  //   메일을 다시 흘려 SES 평판을 깎는다(보안 검증 H2).
  ['system_mail_suppressions', 'UPDATE'],
  ['system_mail_suppressions', 'DELETE'],
  ['system_mail_suppressions', 'TRUNCATE'],
  // 과금 P0(202609250300, ADR-0011 B6) — 요금제 한도·감사 원장은 앱이 읽기만(원장은 0). 쓸 수 있으면 api 탈취가 스스로 요금제를 올린다.
  ['org_entitlements', 'INSERT'],
  ['org_entitlements', 'UPDATE'],
  ['org_entitlements', 'DELETE'],
  ['org_entitlements', 'TRUNCATE'],
  ['billing_audit', 'INSERT'],
  ['billing_audit', 'UPDATE'],
  ['billing_audit', 'DELETE'],
  ['billing_audit', 'TRUNCATE'],
  // 감시 탭 받기 설정(202610081000) — 앱 롤은 읽기만. 쓸 수 있으면 api 탈취가 자기 조직 신뢰 목록에 공격자를 넣어 탐지 효과를 끄거나 보류를 끈다.
  ['agent_watch_settings', 'INSERT'],
  ['agent_watch_settings', 'UPDATE'],
  ['org_trusted_senders', 'INSERT'],
  ['org_trusted_senders', 'UPDATE'],
  ['org_trusted_senders', 'DELETE'],
  // 묶음 D(202610081101) — 앱 롤은 가입 감지를 정의자로만 적고, 자가 등록 · 조직 설정은 읽지도 쓰지도 않는다(알림기의 두 칸 읽기 빼고). 쓸 수 있으면 api 탈취가
  //   자가 등록 상한을 비우거나 스스로 켠다.
  ['agent_signups', 'INSERT'],
  ['agent_signups', 'UPDATE'],
  ['agent_enrollments', 'INSERT'],
  // 앞 거르개 계수는 정의자만 쓴다(앱 롤이 지우면 분당 상한이 풀린다).
  ['agent_enroll_attempts', 'INSERT'],
  ['agent_enroll_attempts', 'DELETE'],
  ['agent_enrollments', 'UPDATE'],
  ['org_watch_settings', 'INSERT'],
  ['org_watch_settings', 'UPDATE'],
  // 실시간 연결(202610081300) — 앱 롤은 정의 함수로만. 직접 쓸 수 있으면 api 탈취가 남의 에이전트 연결 행을 만들어 그 에이전트의 힌트를 받는다.
  ['realtime_connections', 'INSERT'],
  ['realtime_connections', 'UPDATE'],
  ['realtime_connections', 'DELETE'],
  // 정책 변경 요청(202610131201) — 앱 롤은 정의자로만 만든다. 직접 쓸 수 있으면 api 탈취가 요청을 "approved" 로 적거나 상한 없이 쌓는다.
  ['policy_change_requests', 'INSERT'],
  ['policy_change_requests', 'UPDATE'],
  ['policy_change_requests', 'DELETE'],
];

/**
 * 권한 축소가 닫지 못하는 쓰기를 막는 가드(202609230750). `trigger:<테이블>.<이름>` 은 켜진(`tgenabled <> 'D'`) 트리거,
 * `constraint:<테이블>.<이름>` 은 CHECK · FK · UNIQUE · PK 제약이다(WP-2 결속 FK·키가 CHECK 가 아니라서 넓혔다, 보안 검증 L-3).
 * `index:<테이블>.<이름>(<키 칼럼>)[ WHERE <술어>]` 는 유효·준비된 UNIQUE 색인이다(제약이 될 수 없는 부분 UNIQUE — 별칭 재발급 L4).
 * `lookup_index:` 는 같은 표기의 **UNIQUE 가 아닌** 유효·준비된 색인이다(ADR-0014 재리뷰 L2 — 비트랜잭션 `CONCURRENTLY` 빌드가 INVALID 로 남으면
 * 빨갛게).
 * CHECK·FK 는 **`convalidated = true`** 까지 본다(재검토 N4-c — `unvalidatedGuards`). 예외는 `NOT_VALID_TOLERATED_GUARDS` 뿐이다.
 */
export const REQUIRED_GUARDS = [
  'trigger:agent_api_keys.agent_api_keys_revoked_once',
  // 토큰 마지막 사용 시각(202609241400, US-007) — 뒤로 가지 않는다(모든 롤).
  'trigger:agent_api_keys.agent_api_keys_last_used_at_forward_only',
  // 콘솔 v4 토큰 목록(202609250010) — 불변 핵심(바꿀 수 있는 칸 = revoked_at · last_used_at · label, hint 불변) · 에이전트당 활성 5 ·
  //   이름·끝 4자 모양. 꺼지면 admin 롤의 label UPDATE 옆으로 권한·만료·끝 4자를 고쳐 쓰거나 상한 없이 토큰을 쌓을 수 있다.
  'trigger:agent_api_keys.agent_api_keys_immutable_core',
  'trigger:agent_api_keys.agent_api_keys_active_limit',
  // 첫 사용 시각(202609301530) — 처음 쓰인 분을 한 번 적는다(퍼널 "첫 MCP 호출" — 소급 불가). 꺼지면 새 토큰의 첫 사용이 기록되지 않는다.
  'trigger:agent_api_keys.agent_api_keys_stamp_first_used_at',
  // 첫 사용 시각 위조 방지(202609301530) — INSERT 는 first_used_at 을 NULL 로 만든다. 꺼지면 발급 쪽이 "이미 첫 사용" 값을 미리 채울 수 있다.
  'trigger:agent_api_keys.agent_api_keys_force_first_used_null',
  'constraint:agent_api_keys.agent_api_keys_label_check',
  'constraint:agent_api_keys.agent_api_keys_hint_check',
  // 토큰 감사 상세(202609250010 ⑤) — append-only. 꺼지면 admin 롤 밖에서 "어느 토큰을 폐기했나 · 이름 전·후" 를 고칠 수 있다.
  'trigger:agent_api_key_events.agent_api_key_events_no_update',
  'trigger:agent_api_key_events.agent_api_key_events_no_delete',
  // 토큰 한 개 교체 상세(202609270140·0141) — 새 토큰은 옛 토큰과 다르고 이름 칸이 비며(CHECK), 있는 토큰이다(FK). 꺼지면 교체 기록이
  //   없는 토큰이나 자기 자신을 "새 토큰" 으로 가리킬 수 있다.
  'constraint:agent_api_key_events.agent_api_key_events_new_key_check',
  'constraint:agent_api_key_events.agent_api_key_events_new_key_fkey',
  // 발신 스니펫 보존(202609241700, 검증 F3) — 스니펫은 NULL 로만 · 365일 넘은 행만(모든 롤). 꺼지면 앱 롤의 `snippet` UPDATE 로
  //   발신 로그 미리보기를 위조하거나 보존 기간 안에 지울 수 있다.
  'trigger:messages.messages_snippet_retention_only',
  'trigger:sender_relationships.sender_relationships_insert_guard',
  'trigger:audit_logs.audit_logs_allowed_requires_approval',
  'trigger:approval_requests.approval_requests_reject_approve_while_paused',
  'trigger:agents.agents_operator_suspension_guard',
  'trigger:owner_login_links.owner_login_links_reject_invalidated_use',
  'trigger:owner_login_links.owner_login_links_invalidated_once',
  // 로그인·가입 코드(202609280100) — 틀린 코드 수는 +1 씩만 · 5번 틀린 링크는 쓸 수 없다 · 0~5. 꺼지면 admin 롤이 틀린 수를 되돌려
  //   한 시도에서 코드를 끝없이 대 볼 수 있다.
  'trigger:owner_login_links.owner_login_links_code_failures_guard',
  'trigger:signup_links.signup_links_code_failures_guard',
  'constraint:owner_login_links.owner_login_links_code_failures_range',
  'constraint:signup_links.signup_links_code_failures_range',
  // 코드 verify 시도 원장(202609280102) — 고쳐 쓸 수 없다(요청자 상한의 분자). 지우기는 하루 넘은 행만 정의자 함수로.
  'trigger:login_code_attempts.login_code_attempts_no_update',
  'trigger:login_code_attempts.login_code_attempts_no_truncate',
  // 쌍 키 모양(202609290700 · 검증 0701) — HMAC hex 64자만 받는다(2026-10-10 부터 새 코드는 쓰지 않는다 — 옛 행 · 되돌리기용).
  'constraint:login_code_attempts.login_code_attempts_pair_key_shape',
  'trigger:organizations.organizations_owner_email_revokes_sessions',
  'constraint:agent_addresses.agent_addresses_not_reserved_local_part',
  // 역할 주소(202609301540) — abuse@ · postmaster@ 는 별칭으로만 붙는다. 꺼지면 대표 주소(발신 기본값 · passport 신원)가 수신 전용 주소가 될 수 있다.
  'constraint:agent_addresses.agent_addresses_role_address_not_primary',
  // 셀프 가입(202609240800) — 검토 상태는 소유자 롤만 · 검토 전 조직의 승인 불가 · 가입 링크 단일 사용·만료·outbox 종단.
  'trigger:organizations.organizations_review_guard',
  'trigger:approval_requests.approval_requests_reject_approve_while_unreviewed',
  'trigger:signup_links.signup_links_guard',
  'trigger:signup_links.signup_links_used_once',
  'trigger:signup_links.signup_links_immutable_core',
  // 가입 세션(202609240810) — 세션은 로그인 링크 또는 가입 링크 정확히 하나에서.
  'constraint:owner_sessions.owner_sessions_one_link',
  // 202609250190 contract — 세션·로그인 링크는 사용자에 묶인다(옛 코드 호환 자동 채움 제거).
  'constraint:owner_sessions.owner_sessions_user_required',
  'constraint:owner_login_links.owner_login_links_user_required',
  // 사용자·멤버십(202609250100) — 멤버십 불변 핵심·제거 1회·마지막 owner·주 소유자·천장 50 · 조직 INSERT → owner 멤버십 ·
  //   owner_email 이동 → 멤버십 이동(L5). 꺼지면 admin 롤이 마지막 owner 를 지우거나 주 소유자(승인 알림 수신자)를 쫓아낸다.
  'trigger:users.users_immutable_core',
  'trigger:memberships.memberships_immutable_core',
  'trigger:memberships.memberships_removed_once',
  'trigger:memberships.memberships_guard',
  'trigger:memberships.memberships_no_delete',
  // 적대적 검토 L8 — 사용자 행 DELETE·TRUNCATE 거부와 새 append-only 표의 TRUNCATE 거부(행 트리거는 TRUNCATE 에 서지 않는다).
  'trigger:users.users_no_delete',
  'trigger:users.users_no_truncate',
  'trigger:memberships.memberships_no_truncate',
  'trigger:org_invites.org_invites_no_truncate',
  'trigger:membership_events.membership_events_no_truncate',
  'trigger:org_api_keys.org_api_keys_no_truncate',
  'trigger:organizations.organizations_owner_membership',
  'trigger:organizations.organizations_owner_email_moves_membership',
  // 세션 사용자 결속(202609250110) — 세션·링크는 살아 있는 멤버에게만 · 전환은 살아 있는 부모에서, 연장 없이.
  'trigger:owner_sessions.owner_sessions_user_guard',
  'trigger:owner_login_links.owner_login_links_user_guard',
  // 초대(202609250120) — active 조직만 · 대기 10 · 수락/취소 1회 · 끝난 초대 메일 닫기 · 초대 링크는 초대받은 사람에게만.
  'trigger:org_invites.org_invites_guard',
  'trigger:org_invites.org_invites_immutable_core',
  'trigger:org_invites.org_invites_ended_once',
  'trigger:org_invites.org_invites_no_delete',
  'trigger:membership_events.membership_events_no_update',
  'trigger:membership_events.membership_events_no_delete',
  'trigger:owner_login_links.owner_login_links_invite_guard',
  // 환영 메일(202609301510) — 사용자당 한 통 · 정체성 칸 불변 · 종단 동결 · DELETE·TRUNCATE 거부 · 가입 언어 모양.
  'constraint:welcome_mails.welcome_mails_user_id_key',
  'constraint:welcome_mails.welcome_mails_sent_shape',
  'constraint:welcome_mails.welcome_mails_settled_shape',
  'trigger:welcome_mails.welcome_mails_immutable_core',
  'trigger:welcome_mails.welcome_mails_terminal_frozen',
  'trigger:welcome_mails.welcome_mails_no_delete',
  'trigger:welcome_mails.welcome_mails_no_truncate',
  'constraint:signup_links.signup_links_lang_check',
  // 대기자 명단(202609301520) — 가입한 항목엔 주소·메모가 없다 · 초대 14일 모양 · 정체성 칸 불변 · 운영 감사 append-only · 메일 outbox 종단 동결.
  'constraint:waitlist_entries.waitlist_entries_joined_shape',
  'constraint:waitlist_entries.waitlist_entries_joined_note',
  'constraint:waitlist_entries.waitlist_entries_invite_shape',
  'constraint:waitlist_entries.waitlist_entries_email_key',
  'trigger:waitlist_entries.waitlist_entries_immutable_core',
  'trigger:waitlist_entries.waitlist_entries_no_truncate',
  'trigger:waitlist_events.waitlist_events_no_update',
  'trigger:waitlist_events.waitlist_events_no_delete',
  'trigger:waitlist_events.waitlist_events_no_truncate',
  'constraint:waitlist_mails.waitlist_mails_invite_shape',
  'constraint:waitlist_mails.waitlist_mails_sent_shape',
  'constraint:waitlist_mails.waitlist_mails_settled_shape',
  'trigger:waitlist_mails.waitlist_mails_immutable_core',
  'trigger:waitlist_mails.waitlist_mails_terminal_frozen',
  'trigger:waitlist_mails.waitlist_mails_no_delete',
  'trigger:waitlist_mails.waitlist_mails_no_truncate',
  // 신청서 · 가입 계측(202609301530) — 닫힌 값 · 먼저 적은 답이 남는다 · 조직 행의 복사본(ref · 알게 된 곳 · 용도 · 초대 주)은 가입 때 한 번, 뒤로 불변.
  'constraint:waitlist_entries.waitlist_entries_use_case_check',
  'constraint:waitlist_entries.waitlist_entries_heard_from_check',
  'constraint:waitlist_entries.waitlist_entries_ref_check',
  'trigger:waitlist_entries.waitlist_entries_intake_once',
  'constraint:organizations.organizations_signup_ref_check',
  'constraint:organizations.organizations_signup_heard_from_check',
  'constraint:organizations.organizations_signup_use_case_check',
  'constraint:organizations.organizations_signup_invite_week_check',
  'trigger:organizations.organizations_signup_attribution_immutable',
  // 문의 전달 차선(202610021000·1001) — 차선은 닫힌 두 값(support|role). 불변은 종단 동결 트리거 함수가 맡는다.
  'constraint:contact_forwards.contact_forwards_lane_check',
  // 가입 보안 강화(202609240900) — 시스템 메일 억제 행은 바뀌지 않는다 · 가입 조직 이름의 보이지 않는 문자 금지.
  'trigger:system_mail_suppressions.system_mail_suppressions_no_update',
  'constraint:signup_links.signup_links_organization_name_check',
  // 정책 v2(202609241010·1020) — 목록은 고치지 않는다(지우기 표시 한 번 · 다시 넣기 = 새 행, 각각 새 버전) · DELETE 불가 ·
  //   방향·목록당 1000 · 값 모양 = 종류 · 정책 격리 ⇔ 정책 사유.
  'trigger:agent_contact_rules.agent_contact_rules_remove_once',
  'trigger:agent_contact_rules.agent_contact_rules_no_delete',
  'trigger:agent_contact_rules.agent_contact_rules_limit',
  'constraint:agent_contact_rules.agent_contact_rules_value_kind',
  'constraint:inbound_messages.inbound_messages_policy_reason_shape',
  // 정책 v2 보정(202609241040) — 목록 변경은 같은 트랜잭션의 새 버전과 함께(커밋 때 "현재 스냅샷의 목록 = 살아 있는 목록").
  'trigger:agent_contact_rules.agent_contact_rules_version_check',
  'trigger:agent_policies.agent_policies_rules_version_check',
  'trigger:policy_versions.policy_versions_rules_version_check',
  // passport 게시(202609241200, 계약 §3 T4) — 서명 문서 = 해시 = JWS 페이로드 · 버전 전이 · 게시 버전엔 서명 문서 · outbox 종단 불변.
  'trigger:passport_documents.passport_documents_match',
  'trigger:passports.passports_transition',
  'trigger:passports.passports_signed_document_required',
  'trigger:passport_publish_requests.passport_publish_requests_terminal',
  // 202609241210 ④ — 롤별 요청 모양(admin 은 publish·suspend 만 · 서명 롤은 resign 만). 없으면 콘솔 세션이 revoke 를 넣을 수 있다.
  'trigger:passport_publish_requests.passport_publish_requests_requester',
  // 투명성 로그(202609241600, ADR-0008) — 원천 → outbox 수집 트리거(꺼지면 잎 없는 행 = 완결성 붕괴) · 로그 테이블 append-only ·
  //   잎 연속성 · 에폭 완전성(모든 조직) · 앵커 영수증 한 번만.
  'trigger:audit_logs.audit_logs_tlog_enqueue_insert',
  'trigger:audit_logs.audit_logs_tlog_enqueue_update',
  'trigger:owner_actions.owner_actions_tlog_enqueue',
  'trigger:policy_versions.policy_versions_tlog_enqueue',
  'trigger:inbound_messages.inbound_messages_tlog_enqueue',
  // 신원 잎(202609242200, US-013).
  'trigger:agents.agents_tlog_enqueue_insert',
  'trigger:agents.agents_tlog_enqueue_update',
  'trigger:agent_addresses.agent_addresses_tlog_enqueue',
  'trigger:agent_keypairs.agent_keypairs_tlog_enqueue',
  'trigger:passport_documents.passport_documents_tlog_enqueue',
  'constraint:tlog_leaves.tlog_leaves_identity_source',
  // 202609242300 — 신원 잎 도입 시각은 고정(검증기 저장 상태가 고정하는 값 — M2).
  'trigger:tlog_identity_since.tlog_identity_since_frozen',
  'trigger:tlog_outbox.tlog_outbox_guard',
  'trigger:tlog_outbox.tlog_outbox_no_delete',
  'trigger:tlog_leaves.tlog_leaves_append',
  'trigger:tlog_leaves.tlog_leaves_no_update',
  'trigger:tlog_leaves.tlog_leaves_no_delete',
  'trigger:tlog_logs.tlog_logs_no_update',
  'trigger:tlog_salt_keys.tlog_salt_keys_guard',
  'trigger:tlog_epochs.tlog_epochs_append',
  'trigger:tlog_epochs.tlog_epochs_publish_once',
  'trigger:tlog_epochs.tlog_epochs_complete',
  'trigger:tlog_epochs.tlog_epochs_no_delete',
  'trigger:tlog_org_heads.tlog_org_heads_append',
  'trigger:tlog_org_heads.tlog_org_heads_no_update',
  'trigger:tlog_anchors.tlog_anchors_guard',
  'trigger:tlog_anchors.tlog_anchors_no_delete',
  'constraint:tlog_leaves.tlog_leaves_hash',
  'constraint:tlog_leaves.tlog_leaves_envelope',
  'constraint:tlog_epochs.tlog_epochs_checkpoint_shape',
  // 202609241800 — 키 행은 롤마다 한 목적(앵커 과제가 체크포인트 키 행을 넣지 못한다) · 키 행 모양을 DB 가 다시 계산 · OTS 끝 = bitcoin_claimed.
  'trigger:tlog_keys.tlog_keys_purpose_guard',
  'constraint:tlog_keys.tlog_keys_shape',
  'constraint:tlog_anchors.tlog_anchors_state_shape',
  // --- WP-B: 조직 API 키(202609250150) — 불변 핵심·폐기 1회·마지막 사용 앞으로만·조직당 활성 천장 20·삭제 거부 · 권한 집합 CHECK.
  //   감사 행위자(202609250160) — 세션|조직 키 정확히 하나(꺼지면 행위자 없는 감사 행 = 투명성 잎의 "누가" 가 빈다).
  'trigger:org_api_keys.org_api_keys_immutable_core',
  'trigger:org_api_keys.org_api_keys_revoked_once',
  'trigger:org_api_keys.org_api_keys_last_used_at_forward_only',
  'trigger:org_api_keys.org_api_keys_active_ceiling',
  'trigger:org_api_keys.org_api_keys_no_delete',
  'constraint:org_api_keys.org_api_keys_capabilities_check',
  'constraint:owner_actions.owner_actions_one_actor',
  // 운영자 · 시스템 행위자(202610131610) — 모양(둘 다 있거나 없다 · 행위자 문자열 · 한 줄 사유) · 소유자 롤 문장만 적는다(admin · 앱 롤의 사칭 차단).
  'constraint:owner_actions.owner_actions_operator_shape',
  'trigger:owner_actions.owner_actions_operator_actor_guard',
  // --- L5: /org-api 창 계수(202609250200, ADR-0010 후속 L5) — 지금 창에 n = 1 로만 · 1 씩만(소유자 롤 밖). 꺼지면 admin 롤이 계수를
  //   되감거나(상한 무력화) 미래 창을 미리 채워 남의 조직을 막을 수 있다.
  'trigger:org_api_request_windows.org_api_request_windows_guard',
  // --- L7: 초대만 받은 사용자 주소 지우기(202609250220, ADR-0010 후속 L7) — 주소·erased_at 은 소유자(지우기 함수)만 · 1회 · 자리표시로만 ·
  //   자리표시 도메인 INSERT 금지 / 지운 사용자 행에 초대가 붙지 않는다. 꺼지면 admin 롤 밖 경로가 주소를 고쳐 쓰거나 지운 행에 초대를 붙인다.
  'trigger:users.users_erasure_guard',
  'trigger:org_invites.org_invites_invitee_live',
  // --- 과금 P0(202609250300, ADR-0011) — 엔타이틀먼트 version 하나씩 앞으로만 · 지우기/비우기 거부 · 버전마다 감사 행(지연) · 감사 원장
  //   append-only · 투명성 잎 원천 트리거 둘 · 잎 종류 ↔ 원천 CHECK. 꺼지면 한도가 감사·잎 없이 바뀌거나 되감긴다.
  'trigger:org_entitlements.org_entitlements_version_forward_only',
  'trigger:org_entitlements.org_entitlements_no_delete',
  'trigger:org_entitlements.org_entitlements_no_truncate',
  'trigger:org_entitlements.org_entitlements_audited',
  'trigger:billing_audit.billing_audit_no_update',
  'trigger:billing_audit.billing_audit_no_delete',
  'trigger:billing_audit.billing_audit_no_truncate',
  'trigger:org_entitlements.org_entitlements_tlog_enqueue_insert',
  'trigger:org_entitlements.org_entitlements_tlog_enqueue_update',
  'constraint:tlog_leaves.tlog_leaves_billing_source',
  //   천장 트리거(심층 방어) — 에이전트당 활성 웹훅 10 · 조직당 에이전트 1000(비활성 포함). 꺼지면 동시 등록·앱 검사 누락으로 천장을 넘는다.
  'trigger:webhook_endpoints.webhook_endpoints_active_limit',
  'trigger:agents.agents_org_ceiling',
  // --- WP-2 결제(202609250400, ADR-0012) — 출처-롤 가드(billing 은 provider 만 · 넘기지 않은 운영자 행은 칸별 지배일 때만 · operator 롤은
  //   operator 만) · provider 출처 요금제(L9) · 제어 칸은 operator 에서만. 꺼지면 결제 경로가 운영자 보상 요금제를 깎거나 beta 를 만든다.
  'trigger:org_entitlements.org_entitlements_source_by_role',
  'constraint:org_entitlements.org_entitlements_provider_plan',
  'constraint:org_entitlements.org_entitlements_override_source',
  //   출처↔원인 짝(202609250300) — 꺼지면 provider 출처에 operator 원인 같은 거짓 짝이 들어가 출처-롤 가드의 전제가 흐려진다(보안 검증 L-3).
  'constraint:org_entitlements.org_entitlements_source_cause',
  //   billing 롤의 감사 행위자는 provider:paddle 뿐(L-4). 꺼지면 결제 경로가 운영자·검토 행위자를 사칭한다.
  'trigger:billing_audit.billing_audit_actor_by_role',
  //   이벤트 원장 — 봉투 불변 · done/ignored 종단 · 시도 앞으로만 · 지우기/비우기 거부 · id·종류·이유 코드 모양. 꺼지면 같은 이벤트를 두 번 적용한다.
  'trigger:billing_events.billing_events_guard',
  'trigger:billing_events.billing_events_no_delete',
  'trigger:billing_events.billing_events_no_truncate',
  'constraint:billing_events.billing_events_event_id_shape',
  'constraint:billing_events.billing_events_event_type_check',
  'constraint:billing_events.billing_events_status_check',
  'constraint:billing_events.billing_events_reason_check',
  'constraint:billing_events.billing_events_processed_shape',
  'constraint:billing_events.billing_events_provider_check',
  'constraint:billing_events.billing_events_environment_check',
  //   고객 결속 — 키 = (조직, 공급자, 환경)(한 고객은 여러 조직에 붙을 수 있다, H-1/M-4) · 고치기·지우기·비우기 거부 · id 모양.
  'constraint:billing_customers.billing_customers_pkey',
  'trigger:billing_customers.billing_customers_no_update',
  'trigger:billing_customers.billing_customers_no_delete',
  'trigger:billing_customers.billing_customers_no_truncate',
  'constraint:billing_customers.billing_customers_customer_id_shape',
  'constraint:billing_customers.billing_customers_provider_check',
  'constraint:billing_customers.billing_customers_environment_check',
  //   구독 — 조직·고객·원 거래·환경 불변 · provider_updated_at 앞으로만 · canceled 종단 · 요금제는 pro/team/scale/NULL. 꺼지면 옛 재조회가 새 상태를
  //   덮거나 해지된 구독이 되살아난다.
  'trigger:billing_subscriptions.billing_subscriptions_guard',
  'trigger:billing_subscriptions.billing_subscriptions_no_delete',
  'trigger:billing_subscriptions.billing_subscriptions_no_truncate',
  'constraint:billing_subscriptions.billing_subscriptions_id_shape',
  'constraint:billing_subscriptions.billing_subscriptions_status_check',
  'constraint:billing_subscriptions.billing_subscriptions_plan_check',
  'constraint:billing_subscriptions.billing_subscriptions_provider_check',
  'constraint:billing_subscriptions.billing_subscriptions_environment_check',
  'constraint:billing_subscriptions.billing_subscriptions_past_due_shape',
  //   결속 FK — 우리 거래·그 조직·같은 환경만(H2). 꺼지면 공개 클라이언트 토큰으로 만든 거래의 구독이 아무 조직에나 붙는다.
  'constraint:billing_subscriptions.billing_subscriptions_origin_checkout',
  //   체크아웃 — 거래 칸 불변 · open → completed|superseded 한 번 · completed 는 completed_at 과 함께만(admin 은 완료로 적지 못한다).
  'trigger:billing_checkouts.billing_checkouts_guard',
  'trigger:billing_checkouts.billing_checkouts_no_delete',
  'trigger:billing_checkouts.billing_checkouts_no_truncate',
  'constraint:billing_checkouts.billing_checkouts_transaction_id_shape',
  'constraint:billing_checkouts.billing_checkouts_plan_check',
  'constraint:billing_checkouts.billing_checkouts_completed_shape',
  'constraint:billing_checkouts.billing_checkouts_status_check',
  'constraint:billing_checkouts.billing_checkouts_binding_key',
  'constraint:billing_checkouts.billing_checkouts_provider_check',
  'constraint:billing_checkouts.billing_checkouts_environment_check',
  //   reconcile 커서 — 한 행 · 지우기 거부.
  'constraint:billing_reconcile_state.billing_reconcile_state_singleton',
  'trigger:billing_reconcile_state.billing_reconcile_state_no_delete',
  'trigger:billing_reconcile_state.billing_reconcile_state_no_truncate',
  // --- 메일 기본기 1차 · W2 표지(202609260100·0105, `.omc/plans/mail-basics.md` §5) — 예약 취소 가드(취소 칼럼 쓰기 1회 · `agent_cancellable`
  //   불변 · `cancelled` 종단 · 모양 CHECK)의 줄은 이 표지 바로 아래에 둔다(작업자별 구역 — 머지 충돌을 줄인다).
  //   꺼지면 앱 롤의 취소 칼럼 UPDATE 로 사유·경로를 고쳐 쓰거나(주입 유도 취소의 흔적 지우기) `agent_cancellable` 을 뒤집어 MCP 취소를 연다.
  'trigger:scheduled_sends.scheduled_sends_immutable_core',
  'trigger:scheduled_sends.scheduled_sends_terminal_guard',
  'trigger:scheduled_sends.scheduled_sends_cancel_write_once',
  'constraint:scheduled_sends.scheduled_sends_cancelled_shape',
  'constraint:scheduled_sends.scheduled_sends_cancel_reason_code_check',
  'constraint:scheduled_sends.scheduled_sends_cancel_note_check',
  'constraint:scheduled_sends.scheduled_sends_cancelled_via_check',
  // --- 메일 기본기 1차 · W3 표지(202609260110·0115) — 웹훅 v2 가드(`disabled_at` 쓰기 1회 · 재등록 상한 · `redelivery_of` 루트·천장)의 줄은
  //   이 표지 바로 아래에 둔다.
  'trigger:webhook_endpoints.webhook_endpoints_disabled_once',
  'trigger:webhook_endpoints.webhook_endpoints_registration_ceiling',
  'constraint:webhook_endpoints.webhook_endpoints_event_types_shape',
  'trigger:webhook_deliveries.webhook_deliveries_redelivery_guard',
  'constraint:webhook_deliveries.webhook_deliveries_redelivery_shape',
  'constraint:webhook_deliveries.webhook_deliveries_redelivery_of_fkey',
  //   1차 수정(코드 리뷰 L1) — 새 불변식이 기대는 옛 트리거 셋: `event_types`·`redelivery_of` 는 불변 핵심(allow-list 예외 목록 밖)이라서,
  //   "재전송 루트는 dead 로 남는다" 는 종단 가드라서 불변이다. 꺼지면 앱 롤의 UPDATE 로 구독을 바꾸거나 루트를 되살려 천장 3 을 다시 쓴다.
  //   `disable_webhook_endpoint`(SECURITY DEFINER)의 PUBLIC 실행 불가·search_path 고정은 따로 적지 않는다 — `unsafeSecurityDefiners` 가
  //   `public` 의 모든 prosecdef 함수를 이미 본다(보안 L4). 정의자 속성이 빠지면 앱 롤에 UPDATE 가 없어 삭제가 실패 쪽으로 닫힌다.
  'trigger:webhook_endpoints.webhook_endpoints_immutable_core',
  'trigger:webhook_deliveries.webhook_deliveries_immutable_core',
  'trigger:webhook_deliveries.webhook_deliveries_terminal_guard',
  // --- W4 표지(202609301410·1411, 2026-09-30) — 웹훅 시크릿 회전: 버전은 내려가지 않고 지운 엔드포인트는 회전하지 않는다 · 회전 칸 넷의 모양 ·
  //   회전 원장 append-only(엔드포인트당 24시간 10회의 분자). 꺼지면 옛 시크릿이 되살아나거나 원장을 지워 상한을 되돌린다. 불변 핵심 둘은 위 줄
  //   그대로다(같은 이름으로 다시 세웠다 — 예외 목록에 회전 칸·`last_attempt_at` 이 더해졌다).
  'trigger:webhook_endpoints.webhook_endpoints_secret_guard',
  'constraint:webhook_endpoints.webhook_endpoints_secret_rotation_shape',
  'constraint:webhook_secret_rotations.webhook_secret_rotations_version_step',
  'trigger:webhook_secret_rotations.webhook_secret_rotations_no_update',
  'trigger:webhook_secret_rotations.webhook_secret_rotations_no_delete',
  'trigger:webhook_secret_rotations.webhook_secret_rotations_no_truncate',
  //   보안 리뷰(2026-09-30) — admin 롤의 두 표 직접 쓰기 거부(M2 심층 방어) · 등록 표면 모양(M1 콘솔 시크릿 발급 확인의 입력) · 콘솔 감사 상세
  //   append-only(L2). 꺼지면 권한 실수 하나로 admin 이 outbox 에 임의 본문을 넣거나, 감사 상세를 고쳐 쓴다.
  'trigger:webhook_endpoints.webhook_endpoints_admin_write_guard',
  'trigger:webhook_deliveries.webhook_deliveries_admin_write_guard',
  'constraint:webhook_endpoints.webhook_endpoints_created_via_check',
  'trigger:webhook_owner_action_details.webhook_owner_action_details_no_update',
  'trigger:webhook_owner_action_details.webhook_owner_action_details_no_delete',
  'trigger:webhook_owner_action_details.webhook_owner_action_details_no_truncate',
  'constraint:webhook_owner_action_details.webhook_owner_action_details_delivery_pair',
  //   재검토 L-1 — 콘솔 시크릿 발급 원장 append-only. 꺼지면 선점 행을 지우거나 고쳐 같은 버전의 시크릿을 콘솔로 다시 받는다(60초 창 안 재조회).
  'trigger:webhook_console_secret_issues.webhook_console_secret_issues_no_update',
  'trigger:webhook_console_secret_issues.webhook_console_secret_issues_no_delete',
  'trigger:webhook_console_secret_issues.webhook_console_secret_issues_no_truncate',
  // --- 메일 기본기 2차 D6(202609270105·0106) — 엔타이틀먼트 두 칸의 상한 CHECK · 두 칸을 모르는 쓰기(옛 코드·롤백)를 카탈로그 값으로 채우는
  //   트리거. 꺼지면 천장 밖 한도가 들어가거나, 수축(NOT NULL, 0120) 뒤 옛 코드의 INSERT 가 실패한다.
  'trigger:org_entitlements.org_entitlements_fill_new_limits',
  'constraint:org_entitlements.org_entitlements_aliases_per_agent_max_check',
  'constraint:org_entitlements.org_entitlements_attachment_bytes_total_max_check',
  // --- 메일 기본기 2차 A6(202609270110·0111·0115) — 별칭 폐기 쓰기 1회(대표 불가 · 그 칸만) · 별칭 천장(활성 20 · 누적 20 · 조직 하루 20) ·
  //   폐기 잎 원천 트리거. 꺼지면 admin 롤이 폐기를 되돌려 폐기 주소가 다시 메일을 받거나, 잎 없이 폐기하거나, 천장 없이 주소를 태운다.
  'trigger:agent_addresses.agent_addresses_retire_guard',
  'trigger:agent_addresses.agent_addresses_alias_ceiling',
  'trigger:agent_addresses.agent_addresses_tlog_enqueue_retire',
  //   별칭 재발급(202609291002, ADR-0013 2026-09-29 개정) — 주소 잠금 아래에서 활성 행 · 다른 조직의 30일 안 폐기 행이 있으면 INSERT 거부 ·
  //   새 행은 활성으로만. 꺼지면 남의 조직이 막 지운 별칭을 곧바로 가져가(탈취) 예전 주인 앞으로 오던 메일을 받는다.
  'trigger:agent_addresses.agent_addresses_reissue_hold',
  //   에이전트 삭제(202610131000) — 대표 폐기는 삭제한(disabled) 에이전트만(옛 CHECK `agent_addresses_primary_not_retired` 를 폐기 가드가
  //   대신한다) · disabled 는 종단(되살리면 요금제 자리를 비운 채 다시 쓴다) · 삭제 → 공개 신원 폐기 요청 · 삭제한 에이전트의 승인은 승인되지 않는다 ·
  //   삭제한 에이전트에는 주소 · 토큰 · 웹훅을 새로 붙이지 않는다 · 운영자 예약 주소를 쥔 에이전트는 삭제하지 않는다.
  'trigger:agents.agents_disabled_terminal',
  'trigger:agents.agents_disabled_identity_revoke',
  'trigger:approval_requests.approval_requests_reject_approve_disabled_agent',
  'trigger:agent_addresses.agent_addresses_reject_disabled_agent',
  'trigger:agent_api_keys.agent_api_keys_reject_disabled_agent',
  'trigger:webhook_endpoints.webhook_endpoints_reject_disabled_agent',
  //   웹훅 인증 헤더(202610141400) — 봉인 칸 모양(평문 칸은 없다 · 봉인값 모양) · admin 롤 직접 쓰기 거부 · 지우기 금지 · 엔드포인트를 지우면 봉인값도
  //   지운다. 꺼지면 권한 실수 하나로 콘솔이 봉인값을 바꿔 끼우거나(다른 값이 수신측으로 간다), 지운 엔드포인트의 자격이 남는다.
  'constraint:webhook_endpoint_authorizations.webhook_endpoint_authorizations_shape',
  'constraint:webhook_endpoint_authorizations.webhook_endpoint_authorizations_sealed_check',
  'trigger:webhook_endpoint_authorizations.webhook_endpoint_authorizations_admin_write_guard',
  //   세대(재검증 L2) — 내려가지 않고 봉인이 바뀌면 반드시 오른다. 꺼지면 같은 엔드포인트에 옛 봉인값을 다시 넣어 지운 값을 되살린다.
  'trigger:webhook_endpoint_authorizations.webhook_endpoint_authorizations_generation_guard',
  'constraint:webhook_endpoint_authorizations.webhook_endpoint_authorizations_generation_check',
  'trigger:webhook_endpoint_authorizations.webhook_endpoint_authorizations_no_delete',
  'trigger:webhook_endpoint_authorizations.webhook_endpoint_authorizations_no_truncate',
  'trigger:webhook_endpoints.webhook_endpoints_clear_authorization_on_disable',
  //   created_at 은 DB 가 찍는다(202609291004, 재검토 LOW-3) — 꺼지면 과거 시각 INSERT 로 재발급 근거 컷오프와 하루 천장을 비껴간다.
  'trigger:agent_addresses.agent_addresses_created_at_stamp',
  //   AC-1 의 뿌리 — 한 주소의 활성 행은 하나(부분 UNIQUE, 202609291000). `index:` 줄은 **유효·준비된 UNIQUE 색인**만 나오고 키 칼럼과
  //   술어까지 이름에 담는다 — INVALID 로 남거나, 술어·칼럼이 바뀌거나, UNIQUE 가 아니면 이 줄이 없어 status 가 빨갛다(보안 리뷰 L4).
  'index:agent_addresses.agent_addresses_active_address_key(address) WHERE (retired_at IS NULL)',
  // --- 메일 기본기 2차 A2(202609270130) — 첨부 업로드·결속은 불변(고치기·지우기·비우기 거부) · 시각은 DB · 에이전트당 하루 100개·200 MiB ·
  //   같은 에이전트의 업로드만 결속 · MIME 서명표·크기·키 모양 CHECK. 꺼지면 선언값을 바꿔 검증을 우회하거나 남의 첨부를 내 메일에 싣는다.
  'trigger:outbound_attachments.outbound_attachments_stamp',
  'trigger:outbound_attachments.outbound_attachments_no_update',
  'trigger:outbound_attachments.outbound_attachments_no_delete',
  'trigger:outbound_attachments.outbound_attachments_no_truncate',
  'trigger:outbound_attachments.outbound_attachments_daily_ceiling',
  'constraint:outbound_attachments.outbound_attachments_mime_type_check',
  'constraint:outbound_attachments.outbound_attachments_bytes_check',
  'constraint:outbound_attachments.outbound_attachments_staging_key_check',
  'trigger:message_attachments.message_attachments_no_update',
  'trigger:message_attachments.message_attachments_no_delete',
  'trigger:message_attachments.message_attachments_no_truncate',
  'trigger:message_attachments.message_attachments_same_agent',
  'constraint:message_attachments.message_attachments_permanent_key_check',
  //   2차 보안 리뷰(202609270131) — 파일명 확장자 ↔ MIME · encoded-word 금지(M1) · 첨부 하나의 결속 ≤ 50(M2). 조직 하루 1 GiB(L7)는 위 하루
  //   천장 트리거 안이다.
  'constraint:outbound_attachments.outbound_attachments_filename_extension_check',
  'trigger:message_attachments.message_attachments_link_ceiling',
  // --- 호스팅 운영자 콘솔(202609290500·0510, `.omc/plans/ops-console.md` §4 P1) — 심층 방어 zz_ 트리거 둘 × 도메인 표 다섯(session_user =
  //   atmark_ops 일 때만 — 티켓 없는 도메인 쓰기 거부 · 효과 기록). 꺼지면 정의 함수 결함이 세션 없는 도메인 쓰기가 된다(사전 부검 1).
  ...(['organizations', 'agents', 'agent_api_keys', 'org_entitlements', 'billing_audit'] as const).flatMap(
    (table) => [`trigger:${table}.zz_ops_require_ticket`, `trigger:${table}.zz_ops_record_effect`] as const,
  ),
  //   효과 원장은 트리거 안에서만 INSERT(H3) · append-only. 행위 원장 H2(티켓 ⇔ xact_id · 티켓은 ok) · append-only.
  'trigger:ops_action_effects.ops_action_effects_insert_guard',
  'trigger:ops_action_effects.ops_action_effects_no_update',
  'trigger:ops_action_effects.ops_action_effects_no_delete',
  'trigger:ops_action_effects.ops_action_effects_no_truncate',
  'trigger:ops_actions.ops_actions_no_update',
  'trigger:ops_actions.ops_actions_no_delete',
  'trigger:ops_actions.ops_actions_no_truncate',
  'constraint:ops_actions.ops_actions_ticket_xact',
  'constraint:ops_actions.ops_actions_ticket_ok',
  'constraint:ops_actions.ops_actions_ticket_shape',
  'constraint:ops_actions.ops_actions_code_shape',
  'constraint:ops_actions.ops_actions_xact_id_key',
  //   운영자 — 상태 기계 · H1(session_user) · 대기 5 · 자기 결정 금지 · 사건 원장 · DELETE 거부.
  'trigger:ops_operators.ops_operators_guard',
  'trigger:ops_operators.ops_operators_record_event',
  'trigger:ops_operators.ops_operators_no_delete',
  'trigger:ops_operators.ops_operators_no_truncate',
  'constraint:ops_operators.ops_operators_not_self_decided',
  'constraint:ops_operators.ops_operators_email_shape',
  'constraint:ops_operators.ops_operators_requested_shape',
  'trigger:ops_operator_events.ops_operator_events_no_update',
  'trigger:ops_operator_events.ops_operator_events_no_delete',
  'trigger:ops_operator_events.ops_operator_events_no_truncate',
  //   세션 불변(해시·UA·운영자·수명) · last_seen 앞으로만 · 폐기 1회.
  'trigger:ops_sessions.ops_sessions_immutable_core',
  'trigger:ops_sessions.ops_sessions_guard',
  'trigger:ops_sessions.ops_sessions_no_delete',
  'trigger:ops_sessions.ops_sessions_no_truncate',
  'constraint:ops_sessions.ops_sessions_lifetime',
  'constraint:ops_sessions.ops_sessions_revoked_shape',
  //   틀린 step-up 코드 수는 +1 씩 · 0~10(10 이면 세션 폐기 — 보안 검토 L2).
  'constraint:ops_sessions.ops_sessions_step_up_failures_check',
  //   도전 — 틀린 수 +1 씩 · 사용·무효 1회 · 다이제스트 한 번 쓰고 NULL 로만(H11) · 다이제스트 없이 sent 불가 · 수명 ≤ 10분 · 목적별 모양.
  'trigger:ops_login_challenges.ops_login_challenges_immutable_core',
  'trigger:ops_login_challenges.ops_login_challenges_guard',
  'trigger:ops_login_challenges.ops_login_challenges_no_truncate',
  'constraint:ops_login_challenges.ops_login_challenges_ttl',
  'constraint:ops_login_challenges.ops_login_challenges_purpose_shape',
  'constraint:ops_login_challenges.ops_login_challenges_sent_shape',
  'constraint:ops_login_challenges.ops_login_challenges_code_failures_check',
  'trigger:ops_login_attempts.ops_login_attempts_no_update',
  'trigger:ops_login_attempts.ops_login_attempts_no_truncate',
  //   1회용 step-up — 사용 1회 · 핵심 불변 · 활성화만 window · 수명 ≤ 10분.
  'trigger:ops_step_up_grants.ops_step_up_grants_immutable_core',
  'trigger:ops_step_up_grants.ops_step_up_grants_guard',
  'trigger:ops_step_up_grants.ops_step_up_grants_no_truncate',
  'constraint:ops_step_up_grants.ops_step_up_grants_ttl',
  'constraint:ops_step_up_grants.ops_step_up_grants_mode',
  'constraint:ops_step_up_grants.ops_step_up_grants_target',
  'constraint:ops_step_up_grants.ops_step_up_grants_window_unused',
  //   설정 한 행 — 솔트 불변 · 지우기/비우기 거부.
  'trigger:ops_settings.ops_settings_salt_immutable',
  'trigger:ops_settings.ops_settings_no_delete',
  'trigger:ops_settings.ops_settings_no_truncate',
  // --- 고객 도메인(202609291100~1130, ADR-0014 · 보안 L4) — 꺼지면: 상태 기계를 건너뛰거나(pending → verified 직행) · 다른 조직의 apex·겹치는
  //   도메인을 점유하거나 · 허용 목록·천장 없이 행을 쌓거나 · 식별 칸을 바꾸거나 · 행·알림을 지우거나 · 소유권 상실 뒤 옛 주소가 살아남거나 ·
  //   verified 가 아닌(남의) 도메인·대표 주소로 발급하거나 · 에이전트 주소를 사람 이메일로(또는 그 반대로) 쓰거나 · 도메인 상태 잎이 빠진다.
  'trigger:custom_domains.custom_domains_limits_guard',
  'trigger:custom_domains.custom_domains_registrable_guard',
  'trigger:custom_domains.custom_domains_removal_request',
  'trigger:custom_domains.custom_domains_row_immutable',
  'trigger:custom_domains.custom_domains_transition_guard',
  'trigger:custom_domains.custom_domains_retire_on_loss',
  'trigger:custom_domains.custom_domains_no_delete',
  'trigger:custom_domains.custom_domains_no_truncate',
  'trigger:custom_domains.custom_domains_tlog_enqueue_insert',
  'trigger:custom_domains.custom_domains_tlog_enqueue_update',
  'constraint:custom_domains.custom_domains_domain_shape',
  'constraint:custom_domains.custom_domains_registrable_shape',
  'constraint:custom_domains.custom_domains_not_platform',
  'constraint:custom_domains.custom_domains_suspended_reason_shape',
  'constraint:custom_domains.custom_domains_pending_reason_shape',
  'constraint:custom_domains.custom_domains_txt_before_identity',
  'constraint:custom_domains.custom_domains_verified_at_shape',
  'constraint:custom_domains.custom_domains_suspended_at_shape',
  'constraint:custom_domains.custom_domains_removed_at_shape',
  'constraint:custom_domains.custom_domains_superseded_shape',
  'constraint:custom_domains.custom_domains_id_org_key',
  "index:custom_domains.custom_domains_identity_owner_key(domain) WHERE (status = ANY (ARRAY['verifying'::text, 'verified'::text, 'suspended'::text]))",
  "index:custom_domains.custom_domains_org_live_key(organization_id,domain) WHERE (status <> 'removed'::text)",
  // 비트랜잭션 CONCURRENTLY 색인 둘(202609291122 · 1123) — 빌드가 INVALID 로 남으면 status 가 빨갛다(재리뷰 L2).
  "lookup_index:messages.messages_custom_from_domain_created_idx(from_domain,created_at) WHERE (from_domain <> 'atmark.ai'::text)",
  "lookup_index:inbound_rejections.inbound_rejections_unknown_created_idx(created_at) WHERE (reason = 'unknown_recipient'::text)",
  // 주간 운영판(202610010900) — `ops_weekly_board` 의 시간 상한 훑기가 타는 색인 여섯. 빠지면 운영판이 표 전체를 훑는다(ops 롤 statement_timeout 5초).
  'lookup_index:messages.messages_agent_created_idx(agent_id,created_at)',
  'lookup_index:inbound_messages.inbound_messages_agent_received_idx(agent_id,received_at)',
  'lookup_index:audit_logs.audit_logs_agent_created_idx(agent_id,created_at)',
  'lookup_index:policy_versions.policy_versions_agent_created_idx(agent_id,created_at)',
  'lookup_index:ses_events.ses_events_received_at_idx(received_at)',
  'lookup_index:waitlist_events.waitlist_events_action_created_idx(action,created_at)',
  'trigger:agent_addresses.agent_addresses_identity_immutable',
  'constraint:custom_domains.custom_domains_frozen_tombstone_shape',
  'trigger:domain_notices.domain_notices_immutable_core',
  'trigger:domain_notices.domain_notices_terminal',
  'trigger:domain_notices.domain_notices_no_delete',
  'trigger:domain_notices.domain_notices_no_truncate',
  'constraint:domain_notices.domain_notices_domain_fk',
  'constraint:domain_notices.domain_notices_event_key',
  'constraint:domain_notices.domain_notices_sent_shape',
  'constraint:agent_addresses.agent_addresses_domain_matches_address',
  'trigger:agent_addresses.agent_addresses_verified_domain_guard',
  'trigger:agent_addresses.agent_addresses_custom_domain_policy_sync',
  'trigger:agent_addresses.agent_addresses_custom_domain_policy_sync_retire',
  'trigger:agent_addresses.agent_addresses_zz_mail_identity_claim',
  'trigger:users.users_mail_identity_claim',
  'trigger:memberships.memberships_mail_identity_claim',
  'trigger:organizations.organizations_mail_identity_claim',
  'trigger:org_invites.org_invites_mail_identity_claim',
  'trigger:mail_identity_claims.mail_identity_claims_agent_tombstone',
  'trigger:mail_identity_claims.mail_identity_claims_no_update',
  'trigger:mail_identity_claims.mail_identity_claims_no_truncate',
  'constraint:mail_identity_claims.mail_identity_claims_kind_source',
  'constraint:tlog_leaves.tlog_leaves_domain_source',
  // --- W1 표지(202609301500·1501, 2026-09-30) — 운영자 예약 주소(`support@`·`onve@`·`abuse@`·`postmaster@` — `claude@` 는 202610141200 에서 뺐다): 목록 안의 주소는 그 조직의 운영자 허가
  //   행이 있어야 INSERT 된다(42501). 꺼지면 예약 CHECK 가 목록을 통과시키므로 **아무 조직이나** `support@atmark.ai` 를 가져간다. 허가 표 주소 모양.
  'trigger:agent_addresses.agent_addresses_operator_grant_guard',
  'constraint:operator_address_grants.operator_address_grants_address_shape',
  // --- 202610141200(2026-10-14) — 주소 행은 지우지 않는다(모든 롤). 꺼지면 예약 이전 행(`atmark_reserved_grandfathered_address_keys()`)을 지우고
  //   다시 넣는 길이 열린다(PR #98 리뷰 L1) · 받은 메일 · 투명성 잎이 가리키는 주소가 사라진다.
  'trigger:agent_addresses.agent_addresses_no_delete',
  'trigger:agent_addresses.agent_addresses_no_truncate',
  // --- M3a 표지(202610021100~1111, ADR-0014 2026-10 개정) — 대표 주소 포인터 모델: 선택 표 append-only · 가드(원인별 롤 · 대상 = 앵커 또는 같은
  //   조직 verified 고객 별칭 · P0A08 · 운영자 예약 앵커 42501 · 속도 상한 P0A09) · 마지막 선택 색인 · 여권 재서명 요청 ⓐⓑⓒ · 투명성 잎.
  //   꺼지면 admin 이 남의 주소·atmark.ai 별칭·정지된 도메인 주소를 대표로 고르거나, 선택을 지워 잎과 행이 어긋난다.
  'trigger:agent_primary_changes.agent_primary_changes_guard',
  'trigger:agent_primary_changes.agent_primary_changes_no_update',
  'trigger:agent_primary_changes.agent_primary_changes_no_delete',
  'trigger:agent_primary_changes.agent_primary_changes_no_truncate',
  'trigger:agent_primary_changes.agent_primary_changes_resign_request',
  'trigger:agent_primary_changes.agent_primary_changes_tlog_enqueue',
  'trigger:agent_addresses.agent_addresses_primary_retired_resign',
  'trigger:custom_domains.custom_domains_primary_resign',
  'constraint:agent_primary_changes.agent_primary_changes_cause_check',
  'constraint:agent_primary_changes.agent_primary_changes_agent_id_fkey',
  'constraint:agent_primary_changes.agent_primary_changes_address_id_fkey',
  'lookup_index:agent_primary_changes.agent_primary_changes_agent_created_idx(agent_id,created_at,id)',
  //   앵커 이름 공간(202610021101) — `ax--` 는 소유자 롤(= 프로비저닝 정의자 함수)만, 그것도 대표 앵커 모양으로만. 꺼지면 사용자가 `ax--…` 를
  //   선점해 앵커 이름과 겹치거나 앵커처럼 보이는 별칭을 만든다.
  'trigger:agent_addresses.agent_addresses_anchor_namespace_guard',
  //   소유 변경(202610021102) — D-H(새 조직의 verifying 진입이 다른 조직의 잔여 별칭을 폐기) · 양도 채택 불변식(`superseded_by` 쓰기 1회 · 옛 행
  //   ownership_lost → removed · 새 행 같은 도메인 · 다른 조직 · TXT 통과). 꺼지면 틱이 넘기는 `supersededRowId` 를 domain-control 이 그대로
  //   믿고 남의 identity 를 채택한다.
  'trigger:custom_domains.custom_domains_retire_foreign_on_verifying',
  'trigger:custom_domains.custom_domains_supersede_guard',
  //   bounce 종류(202610021104 · 1105, #13 M3) — 평판은 영구 bounce 만 센다. 꺼지면 bounce 가 아닌 행에 종류가 붙거나 모르는 값이 들어가 분자가 흔들린다.
  'constraint:ses_events.ses_events_bounce_type_shape',
  // 수신자 단위 평판(202610131612) — 수 범위 · bounce 하위 종류 모양 · 신고자 해시 모양(complaint 만).
  'constraint:ses_events.ses_events_recipient_count_range',
  'constraint:ses_events.ses_events_bounce_subtype_shape',
  'constraint:ses_events.ses_events_complaint_hashes_shape',
  // 인젝션 구조 방어(202610041000 · 1001, ADR-0016). 노출 등급은 내려가지 않는다(꺼지면 재분류가 오염 창을 닫는다) · 지문은 불변 · DLP 계열은 닫힌 다섯 값 ·
  //   위험 보류 승인은 `once` 뿐이고 `once` 승인은 관계를 만들지 않는다(꺼지면 위험 보류 한 번의 승인이 상시 관계가 된다) · 오염 창 조회 색인.
  'trigger:agent_exposures.agent_exposures_monotonic',
  'trigger:inbound_fingerprints.inbound_fingerprints_no_update',
  'trigger:agent_code_fingerprints.agent_code_fingerprints_refresh_only',
  'constraint:agent_exposures.agent_exposures_level_check',
  'constraint:messages.messages_outbound_dlp_check',
  'constraint:approval_requests.approval_requests_granted_scope_check',
  'trigger:approval_requests.approval_requests_risk_hold_once',
  'trigger:sender_relationships.sender_relationships_reject_once_grant',
  'lookup_index:agent_exposures.agent_exposures_tainted_idx(agent_id,last_at) WHERE (level >= 2)',
  'lookup_index:inbound_fingerprints.inbound_fingerprints_agent_created_idx(agent_id,created_at)',
  'lookup_index:agent_code_fingerprints.agent_code_fingerprints_agent_created_idx(agent_id,created_at)',
  //   보안 리뷰(202610041002·1003) — 예약에 고정한 DLP 계열은 닫힌 다섯 값(H1) · Reply-To 창 모양(M4).
  'constraint:scheduled_sends.scheduled_sends_risk_dlp_check',
  'constraint:agent_exposures.agent_exposures_reply_to_check',
  //   재검증(202610041004·1005, N1) — 제목 면은 별도 행(`subject`)이다. 꺼지면 목록 폴링이 상세 행의 시각을 다시 민다.
  'constraint:agent_exposures.agent_exposures_part_check',
  // 고객 도메인 identity 관리자(202610061000~1002 · one-shot §2.3) — 도메인당 활성 관리자 하나(부분 UNIQUE) · 클레임/놓기 쓰기 1회 · 넘겨받는 행은 같은
  //   도메인의 클레임한 적 없는 살아 있는 행 · verifying+ 는 관리자. 꺼지면 증명 없는 선점 행과 증명한 행이 같은 SES identity 를 두고 다투거나, 틱이 넘기는
  //   `supersededRowId`(채택 대상)를 DB 가 지키지 못한다.
  'trigger:custom_domains.custom_domains_identity_claim_guard',
  'constraint:custom_domains.custom_domains_steward_shape',
  'constraint:custom_domains.custom_domains_identity_claim_shape',
  'constraint:custom_domains.custom_domains_identity_handover_to_fkey',
  "index:custom_domains.custom_domains_identity_claim_key(domain) WHERE ((identity_claimed_at IS NOT NULL) AND (identity_released_at IS NULL) AND (identity_deleted_at IS NULL))",
  // AI 의심 메일 감시(202610061100~1102, ADR-0017 초안 · 경고 전용) — 켜기는 허용 목록 행이 있어야 한다(꺼지면 소유자가 베타 관문을 건너뛴다) ·
  //   기능 이름 닫힌 목록 · 보류 30초 상한(꺼지면 Mac·코드 버그가 메일을 무한히 숨긴다) · 보류/연결은 NULL 로만(꺼지면 보류를 늘리거나 다른 작업에
  //   다시 묶는다) · 작업은 pending 에서 한 번만 나가고 판정·밴드 모양은 닫혀 있다 · 메일당 작업 하나 · 작업 → 메일 역조회 색인(보류 풀기).
  'trigger:organizations.organizations_ai_mail_watch_guard',
  'constraint:org_features.org_features_feature_check',
  'constraint:inbound_messages.inbound_messages_ai_hold_max_30s',
  'constraint:inbound_messages.inbound_messages_ai_watch_job_fkey',
  'trigger:inbound_messages.inbound_messages_ai_watch_release_only',
  'trigger:ai_watch_jobs.ai_watch_jobs_transition',
  'constraint:ai_watch_jobs.ai_watch_jobs_state_shape',
  'constraint:ai_watch_jobs.ai_watch_jobs_deadline_window',
  'constraint:ai_watch_jobs.ai_watch_jobs_org_ses_key',
  'lookup_index:inbound_messages.inbound_messages_ai_watch_job_idx(ai_watch_job_id) WHERE (ai_watch_job_id IS NOT NULL)',
  //   목록 since 겹침 가지(202610061103, 재검증 M3) — 꺼지면 겹침 가지가 에이전트의 모든 수신 행을 훑는다.
  'lookup_index:inbound_messages.inbound_messages_ai_watch_created_idx(agent_id,created_at) WHERE (ai_watch_job_id IS NOT NULL)',
  // 격리 알림(202610071000, ADR-0016 2026-10-07) — 격리 메일이 창에 묶이는 트리거(꺼지면 소유자가 격리를 모른다) · 에이전트당 열린 창 하나(꺼지면 한
  //   에이전트에 창이 여럿 — 15분 간격이 무너진다) · 끝난 알림 · 집힌 창의 수는 바뀌지 않는다 · 지우기 금지 · 메일 하나에 한 줄(꺼지면 계수 부풀리기) ·
  //   도메인 모양(꺼지면 공격자가 고른 글자가 본문으로 간다).
  'trigger:inbound_messages.inbound_messages_quarantine_notice',
  'trigger:quarantine_notices.quarantine_notices_immutable_core',
  'trigger:quarantine_notices.quarantine_notices_guard',
  'trigger:quarantine_notices.quarantine_notices_no_delete',
  'trigger:quarantine_notices.quarantine_notices_no_truncate',
  'constraint:quarantine_notices.quarantine_notices_sent_shape',
  //   202610081002·1003 — 열린 창은 에이전트 · 종류(block | risk)마다 하나(옛 `quarantine_notices_open_key (agent_id)` 를 대신한다).
  "index:quarantine_notices.quarantine_notices_open_kind_key(agent_id,kind) WHERE ((status = 'pending'::text) AND (claimed_at IS NULL))",
  'trigger:quarantine_notice_items.quarantine_notice_items_immutable',
  'trigger:quarantine_notice_items.quarantine_notice_items_no_delete',
  'trigger:quarantine_notice_items.quarantine_notice_items_no_truncate',
  'constraint:quarantine_notice_items.quarantine_notice_items_pkey',
  'constraint:quarantine_notice_items.quarantine_notice_items_sender_domain_check',
  //   대조 색인(202610071001, 보안 리뷰 L1) — 꺼지면 알림기 틱의 대조가 매분 수신 표 전체를 훑는다.
  "lookup_index:inbound_messages.inbound_messages_quarantine_created_idx(created_at) WHERE (quarantine_reason = ANY (ARRAY['injection_risk'::text, 'scanner_error'::text]))",
  // 받기 등급(202610081000~1003, ADR-0016 2026-10-08) — 풀기는 격리 → 보임 한 방향 한 번 · INSERT 는 풀린 칸을 못 채운다(꺼지면 앱 롤이 격리 메일을
  //   "풀린" 상태로 넣는다) · 풀린 행 모양(판정 없음은 풀 수 없다) · 우회는 DMARC 인증된 From 만(꺼지면 위조 From 이 우회를 받는다) · 등급 ⇔ 숨김 사유 ·
  //   사유 목록 · high ⇒ 격리(우회 · 풀린 행만 예외) · 신뢰 발신자 값 모양 · 지우기 한 번 · 200 상한 · 지우기 금지 · 알림 종류.
  'trigger:inbound_messages.inbound_messages_release_guard',
  'trigger:inbound_messages.inbound_messages_immutable_except_display',
  'constraint:inbound_messages.inbound_messages_release_shape',
  'constraint:inbound_messages.inbound_messages_trusted_bypass_shape',
  'constraint:inbound_messages.inbound_messages_watch_level_shape',
  'constraint:inbound_messages.inbound_messages_quarantine_reason_check',
  'constraint:inbound_messages.inbound_messages_high_is_quarantined',
  'constraint:org_trusted_senders.org_trusted_senders_value_kind',
  //   적대적 검증(202610081004~1006) — 도메인 항목은 공용 메일 도메인이 아니다 · 풀린 메일의 since 겹침 색인(꺼지면 셋째 가지가 에이전트의 수신 행을 훑는다).
  'constraint:org_trusted_senders.org_trusted_senders_not_freemail',
  'lookup_index:inbound_messages.inbound_messages_released_idx(agent_id,released_at) WHERE (released_at IS NOT NULL)',
  'trigger:org_trusted_senders.org_trusted_senders_immutable',
  'trigger:org_trusted_senders.org_trusted_senders_remove_once',
  'trigger:org_trusted_senders.org_trusted_senders_limit',
  'trigger:org_trusted_senders.org_trusted_senders_no_delete',
  'constraint:quarantine_notices.quarantine_notices_kind_check',
  'constraint:quarantine_notice_items.quarantine_notice_items_reason_check',
  // 묶음 D(202610081101~1102, ADR-0016 2026-10-08) — 자가 등록은 DB 가 다시 판정한다(토큰 · 상태 · 설정 · 하루 상한 — 꺼지면 admin 탈취 없이도 상한을 넘는다) ·
  //   한 방향 한 번 · 지우기 금지 · 연쇄 금지(자가 등록 에이전트에 agents:enroll 토큰 없음) · 가입 감지 행은 고칠 칸만 · 하루 상한 범위.
  'trigger:agent_enrollments.agent_enrollments_admit',
  'trigger:agent_enrollments.agent_enrollments_complete',
  'trigger:agent_enrollments.agent_enrollments_immutable',
  'trigger:agent_enrollments.agent_enrollments_no_delete',
  'trigger:agent_enrollments.agent_enrollments_no_truncate',
  'constraint:agent_enrollments.agent_enrollments_shape',
  'constraint:agent_enrollments.agent_enrollments_not_self',
  'trigger:agent_api_keys.agent_api_keys_no_enroll_chain',
  'trigger:agent_signups.agent_signups_immutable',
  'trigger:agent_signups.agent_signups_no_delete',
  'trigger:agent_signups.agent_signups_no_truncate',
  'constraint:agent_signups.agent_signups_service_domain_check',
  'constraint:org_watch_settings.org_watch_settings_enroll_daily_cap_check',
  //   202610081103·1104 — 자가 등록 요청 id 는 한 번(재생 방지 — 꺼지면 캡처한 이벤트 하나로 상한까지 에이전트를 만든다).
  'index:agent_enrollments.agent_enrollments_request_id_key(request_id) WHERE (request_id IS NOT NULL)',
  // 개발자 표면(202610081200~1202, 묶음 B) — 초안은 지우지 않고(소프트 버리기) 보냈거나 버린 뒤 · 보내는 중에는 굳는다(꺼지면 판정한 내용과 나가는
  //   내용이 갈라지거나 보낸 초안을 다시 보낸다) · 본문 키는 id·판에서 유도(꺼지면 다른 초안의 본문을 가리킨다) · 에이전트 상한 500(트리거) ·
  //   받은 메일 상태(라벨 · 처음 읽은 시각)는 그 에이전트의 메일만 · 라벨 모양 · 지우기 금지 · 첨부 업로드 중복 방지 키는 에이전트별 하나.
  'trigger:drafts.drafts_guard',
  //   202610081210 — 보내는 중 버리기 금지 · 같은 에이전트의 메일 · 첨부만 · 살아 있는 본문 합계 100 MiB.
  'trigger:drafts.drafts_integrity',
  'trigger:drafts.drafts_no_delete',
  'trigger:drafts.drafts_no_truncate',
  'constraint:drafts.drafts_content_key_shape',
  'constraint:drafts.drafts_claim_shape',
  'constraint:drafts.drafts_sent_shape',
  'constraint:drafts.drafts_sent_or_discarded',
  'trigger:inbound_message_state.inbound_message_state_guard',
  'trigger:inbound_message_state.inbound_message_state_no_delete',
  'trigger:inbound_message_state.inbound_message_state_no_truncate',
  'constraint:inbound_message_state.inbound_message_state_labels_check',
  'constraint:outbound_attachments.outbound_attachments_idempotency_shape',
  'index:outbound_attachments.outbound_attachments_agent_idempotency_key(agent_id,idempotency_key) WHERE (idempotency_key IS NOT NULL)',
  // 실시간 WebSocket(202610081300, 묶음 E) — 에이전트당 열린 연결 5 · 시각은 DB 가 · 닫힘은 한 번(꺼지면 상한 없이 연결을 쌓거나 닫힌 연결을 되살린다) ·
  //   지우기는 7일 넘게 닫힌 행만 · 만료 ≤ 2시간 · 닫힘 모양 · 대상 조회 색인(꺼지면 수신마다 연결 표를 훑는다).
  'trigger:realtime_connections.realtime_connections_guard',
  'trigger:realtime_connections.realtime_connections_delete_guard',
  'trigger:realtime_connections.realtime_connections_no_truncate',
  'constraint:realtime_connections.realtime_connections_ttl',
  'constraint:realtime_connections.realtime_connections_closed_shape',
  'constraint:realtime_connections.realtime_connections_close_reason_check',
  'lookup_index:realtime_connections.realtime_connections_open_agent_idx(agent_id) WHERE (closed_at IS NULL)',
  // 시스템 메일 언어(202610101000·1001) — 사용자의 언어는 등록된 언어만(FK — 꺼지면 모르는 값이 들어가 메일이 조용히 기본 언어로 간다) ·
  //   등록 표는 더하기만(지우기 · 고치기 · 비우기 금지 — 가리키는 사용자가 있다).
  'constraint:users.users_mail_locale_fkey',
  'trigger:mail_locales.mail_locales_immutable',
  'trigger:mail_locales.mail_locales_no_delete',
  'trigger:mail_locales.mail_locales_no_truncate',
  // 정책 변경 요청(202610131201~1202, ADR-0007 2026-10-13) — 결정은 pending 에서 한 번(꺼지면 승인된 요청을 되돌리거나 다시 결정한다) · 고칠 칸은 결정 칸만 ·
  //   지우기 금지 · 변경 모양(꺼지면 요청할 수 없는 칸이 실린다) · 결정 · 적용 모양 · 만료 ≤ 7일 · 같은 변경의 pending 하나(꺼지면 재생 대신 중복이 쌓인다).
  'trigger:policy_change_requests.policy_change_requests_transition',
  'trigger:policy_change_requests.policy_change_requests_immutable',
  'trigger:policy_change_requests.policy_change_requests_no_delete',
  'trigger:policy_change_requests.policy_change_requests_no_truncate',
  'constraint:policy_change_requests.policy_change_requests_change_shape',
  'constraint:policy_change_requests.policy_change_requests_decided_shape',
  'constraint:policy_change_requests.policy_change_requests_applied_shape',
  'constraint:policy_change_requests.policy_change_requests_expiry',
  "index:policy_change_requests.policy_change_requests_pending_key(agent_id,request_hash) WHERE (status = 'pending'::text)",
] as const;

/**
 * `NOT VALID` 로 남아도 되는 가드 — 마이그레이션이 **일부러** 기존 행 검증을 건너뛴다(새 행·갱신은 검사된다). 나머지 `constraint:` 가드는
 * 전부 `convalidated = true` 여야 status 가 ok 다(재검토 N4-c).
 *   - 예약 로컬파트 · 가입 조직 이름(202609230750·0900) — 걸리는 옛 행이 있으면 `NOT VALID` 로 다시 세운다(마이그레이션을 멈추지 않는다).
 *     예약 로컬파트는 `reservedLocalPartCheckValidated` 가 따로 보고한다 — 202609301501 뒤로는 운영자 목록이, 202610141201 뒤로는 예약 이전 행
 *     (`atmark_reserved_grandfathered_address_keys()` — `claude@atmark.ai` · 새 브랜드 이름 · 구분자 변형을 먼저 쥔 행의 (id, 주소) 쌍)이 통과하므로
 *     운영에서 `true` 여야 한다(deploy §29). 목록 밖의 옛 예약 주소가 새로 드러나도 status 를 빨갛게 만들지 않으려고 관용은 남긴다.
 *   - 세션·로그인 링크의 사용자 필수(202609250190) — 옛 코드 호환 자동 채움 이전의 행은 검증하지 않는다.
 *   - 앵커 상태 모양(202609241800) — 로컬 DB 의 옛 OTS `confirmed` 행 때문에 `NOT VALID` 다.
 */
export const NOT_VALID_TOLERATED_GUARDS: readonly (typeof REQUIRED_GUARDS)[number][] = [
  'constraint:agent_addresses.agent_addresses_not_reserved_local_part',
  'constraint:signup_links.signup_links_organization_name_check',
  'constraint:owner_sessions.owner_sessions_user_required',
  'constraint:owner_login_links.owner_login_links_user_required',
  'constraint:tlog_anchors.tlog_anchors_state_shape',
];

/** 앱 롤이 **아무 권한도 가지면 안 되는** 테이블(202609230700 · 202609230720 · 가입 202609240800). */
export const APP_FORBIDDEN_LOGIN_TABLES = [
  'owner_login_links',
  'owner_login_requests',
  'owner_sessions',
  'owner_actions',
  'agent_api_key_events',
  'signup_links',
  'signup_requests',
  // 로그인·가입 코드 시도 원장(202609280102) — 앱 롤이 쓰면 남의 요청자 상한을 채운다. 보존은 함수 EXECUTE 하나로만.
  'login_code_attempts',
  // 운영자 예약 주소 허가(202609301500) — 소유자 전용. 앱 롤이 쓰면 `support@atmark.ai` 를 아무 조직에나 허가한다.
  'operator_address_grants',
  // 사용자·멤버십·초대(202609250100·0120) — 앱 롤이 읽으면 전 테넌트의 콘솔 사용자 주소, 쓰면 남의 조직 멤버십이다.
  'users',
  'memberships',
  'org_invites',
  'membership_events',
  // 환영 메일 outbox(202609301510) — 앱 롤이 읽으면 가입 사용자 목록, 쓰면 환영 메일을 다시 보내게 하거나 막는다.
  'welcome_mails',
  // 대기자 명단(202609301520) — 앱 롤이 읽으면 대기자 주소·메모, 쓰면 초대·메일을 만든다. 보존은 함수 EXECUTE 하나로만.
  'waitlist_entries',
  'waitlist_events',
  'waitlist_mails',
  // --- WP-B: 조직 API 키(202609250150) — 앱 롤이 읽으면 전 조직 키 해시, 쓰면 CI 키 발급이다.
  'org_api_keys',
  // --- L5: /org-api 창 계수(202609250200) — 앱 롤이 쓰면 남의 조직 상한을 채운다. 보존은 함수 EXECUTE 하나로만.
  'org_api_request_windows',
  // --- WP-2 결제(202609250400) — 앱 롤이 읽으면 전 조직의 공급자 고객·구독, 쓰면 남의 조직을 결속하거나 이벤트를 "처리됨" 으로 막는다.
  'billing_events',
  'billing_customers',
  'billing_subscriptions',
  'billing_checkouts',
  'billing_reconcile_state',
  // --- 호스팅 운영자 콘솔(202609290500) — 앱 롤은 함수 셋(보존·만료·census)만. 표를 읽으면 운영자 주소·세션, 쓰면 운영자 신원이다.
  ...OPS_TABLES,
] as const;

/**
 * ops 함수의 EXECUTE 허용(소유자 말고). 여기 없는 `ops_%`·`zz_ops_%` 함수(코어 · 티켓 · 스위치 · 카탈로그 · 내부 함수)는 **소유자만** 부른다
 * (status 검사 3). 계약 `docs/contracts/ops-sql.md` 의 EXECUTE 칸과 같다.
 */
export const OPS_FUNCTION_EXECUTORS: Readonly<Record<string, readonly string[]>> = {
  ops_request_code: [OPS_ROLE],
  ops_login_verify: [OPS_ROLE],
  ops_session_touch: [OPS_ROLE],
  ops_session_revoke: [OPS_ROLE],
  ops_request_stepup: [OPS_ROLE],
  ops_stepup_verify: [OPS_ROLE],
  ops_decide_request: [OPS_ROLE],
  ops_revoke_operator: [OPS_ROLE],
  ops_record_failure: [OPS_ROLE],
  ops_org_activate: [OPS_ROLE],
  ops_org_reject: [OPS_ROLE],
  // 대기자 명단(202609301520) — 콘솔 열림 → 세션 → 소유자 코어(`waitlist_*_core`, 소유자만).
  ops_waitlist_invite: [OPS_ROLE],
  ops_waitlist_invite_oldest: [OPS_ROLE],
  ops_waitlist_remove: [OPS_ROLE],
  // 주간 운영판(202610010900) — 읽기 전용 집계. 내부 술어 `ops_board_external_sender` 는 소유자만(여기 없다).
  ops_weekly_board: [OPS_ROLE],
  ops_mailer_set_digest: [LOGIN_MAILER_ROLE],
  purge_ops_login_records: [APP_ROLE_NAME],
  expire_ops_requests: [APP_ROLE_NAME],
  ops_operator_census: [APP_ROLE_NAME],
};

/** 검사 2 — ops 표 권한이 0 이어야 하는 롤(login-mailer 는 도전 outbox 칸 · 운영자 세 칸이 있어 허용 목록이 본다). */
const OPS_TABLE_FORBIDDEN_ROLES = [APP_ROLE_NAME, ADMIN_ROLE, BILLING_ROLE, BILLING_OPERATOR_ROLE, PASSPORT_SIGNER_ROLE, TLOG_ROLE, TLOG_ANCHOR_ROLE] as const;

export type MigrateHandlerResult = MigrateResult | RoleBootstrapResult | MigrationStatus | OpsRoleLockResult;

export interface MigrateComposers {
  /** 소유자 롤 풀(migrate·status). */
  readonly owner: (context: LambdaContext) => Promise<Composed<null>>;
  /** 마스터 풀 + 롤 비밀들(bootstrap-roles). */
  readonly bootstrap: (context: LambdaContext) => Promise<Composed<RoleBootstrapDependencies>>;
}

async function withClient<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    const client = await pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function actionOf(event: MigrateEvent | null | undefined): MigrateAction {
  const action = event?.action ?? 'migrate';
  if (action === 'migrate' || action === 'bootstrap-roles' || action === 'status' || action === 'ops-role-lock' || action === 'ops-role-unlock') {
    return action;
  }
  throw new Error(
    `알 수 없는 action: ${JSON.stringify(action).slice(0, 40)} — migrate · bootstrap-roles · status · ops-role-lock · ops-role-unlock 중 하나.`,
  );
}

async function runBootstrap(composed: Composed<RoleBootstrapDependencies>): Promise<RoleBootstrapResult> {
  const { deps, pool } = composed;
  const result = await withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const outcome = await bootstrapRoles(client, deps.master.dbname, {
        owner: { secretFilled: deps.ownerFilled },
        app: { secretFilled: deps.appFilled },
        admin: { secretFilled: deps.adminFilled },
        loginMailer: { secretFilled: deps.loginMailerFilled },
        passportSigner: { secretFilled: deps.passportSignerFilled },
        tlog: { secretFilled: deps.tlogFilled },
        tlogAnchor: { secretFilled: deps.tlogAnchorFilled },
        billing: { secretFilled: deps.billingFilled },
        billingOperator: { secretFilled: deps.billingOperatorFilled },
        ops: { secretFilled: deps.opsFilled },
        domainTick: { secretFilled: deps.domainTickFilled },
        aiWatch: { secretFilled: deps.aiWatchFilled },
      });
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });

  // **커밋 뒤에** 쓴다. 쓰기가 실패하면 그 비밀은 placeholder 로 남고, 재실행이 새 비밀번호로 다시 건다(수렴한다).
  const written: string[] = [];
  const write = async (arn: string, username: string, password: string | null): Promise<void> => {
    if (password === null) return;
    // 형식은 파서(`config.ts` `parseDatabaseSecret`)가 받는 모양 그대로 — RDS 가 만드는 비밀과 같은 필드 이름.
    const credentials = { host: deps.master.host, port: deps.master.port, dbname: deps.master.dbname, username, password };
    await deps.writer.putSecretString(arn, JSON.stringify({ engine: 'postgres', ...credentials }));
    written.push(arn);
  };
  await write(deps.ownerSecretArn, OWNER_ROLE, result.owner.password);
  await write(deps.appSecretArn, APP_ROLE_NAME, result.app.password);
  await write(deps.adminSecretArn, ADMIN_ROLE, result.admin.password);
  await write(deps.loginMailerSecretArn, LOGIN_MAILER_ROLE, result.loginMailer.password);
  await write(deps.passportSignerSecretArn, PASSPORT_SIGNER_ROLE, result.passportSigner.password);
  await write(deps.tlogSecretArn, TLOG_ROLE, result.tlog.password);
  await write(deps.tlogAnchorSecretArn, TLOG_ANCHOR_ROLE, result.tlogAnchor.password);
  await write(deps.billingSecretArn, BILLING_ROLE, result.billing.password);
  await write(deps.billingOperatorSecretArn, BILLING_OPERATOR_ROLE, result.billingOperator.password);
  await write(deps.opsSecretArn, OPS_ROLE, result.ops.password);
  await write(deps.domainTickSecretArn, DOMAIN_TICK_ROLE, result.domainTick.password);
  await write(deps.aiWatchSecretArn, AI_WATCH_ROLE, result.aiWatch.password);

  log('info', 'runtime.roles_bootstrapped', {
    route_id: 'migrate',
    outcome: 'ok',
    detail:
      `owner=${result.owner.action} app=${result.app.action} admin=${result.admin.action} ` +
      `login_mailer=${result.loginMailer.action} passport_signer=${result.passportSigner.action} ` +
      `tlog=${result.tlog.action} tlog_anchor=${result.tlogAnchor.action} billing=${result.billing.action} ` +
      `billing_operator=${result.billingOperator.action} ops=${result.ops.action} domain_tick=${result.domainTick.action} ai_watch=${result.aiWatch.action} written=${String(written.length)}`,
  });
  return {
    action: 'bootstrap-roles',
    owner: result.owner.action,
    app: result.app.action,
    admin: result.admin.action,
    loginMailer: result.loginMailer.action,
    passportSigner: result.passportSigner.action,
    tlog: result.tlog.action,
    tlogAnchor: result.tlogAnchor.action,
    billing: result.billing.action,
    billingOperator: result.billingOperator.action,
    ops: result.ops.action,
    domainTick: result.domainTick.action,
    aiWatch: result.aiWatch.action,
    databaseOwner: result.databaseOwner,
    secretsWritten: written,
  };
}

async function runStatus(pool: Pool): Promise<MigrationStatus> {
  return withClient(pool, async (client) => {
    const files = loadMigrations().map((migration) => migration.filename);
    const applied = await client.query<{ filename: string }>(
      `SELECT filename FROM schema_migrations`,
    ).catch(() => ({ rows: [] as { filename: string }[] }));
    const appliedSet = new Set(applied.rows.map((row) => row.filename));
    let appRoleProblem: string | null = null;
    try {
      await verifyAppRoleIsNotOwner(client);
    } catch (error) {
      appRoleProblem = error instanceof Error ? error.message : String(error);
    }
    const privilege = await client
      .query<{ allowed: boolean }>(
        `SELECT has_table_privilege($1, 'public.sender_marks', 'INSERT') AS allowed`,
        [APP_ROLE],
      )
      .catch(() => ({ rows: [{ allowed: true }] }));
    const appCanInsertSenderMarks = privilege.rows[0]?.allowed ?? true;
    // 테이블이 아직 없으면(마이그레이션 미적용) 검사할 것이 없다 — pending 이 이미 ok=false 로 만든다.
    const loginPrivileges = await client
      .query<{ grant: string }>(
        `SELECT t.name || ':' || p.privilege AS grant
           FROM unnest($2::text[]) AS t(name)
           CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
          WHERE to_regclass('public.' || t.name) IS NOT NULL
            AND (has_table_privilege($1, 'public.' || t.name, p.privilege)
                 OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                     AND has_any_column_privilege($1, 'public.' || t.name, p.privilege)))
          ORDER BY 1`,
        [APP_ROLE, [...APP_FORBIDDEN_LOGIN_TABLES]],
      )
      .catch(() => ({ rows: [{ grant: '검사 실패' }] }));
    const appLoginPrivileges = loginPrivileges.rows.map((row) => row.grant);
    // 컬럼이 아직 없으면(마이그레이션 미적용) 건너뛴다 — pending 이 이미 ok=false 로 만든다.
    const forbiddenUpdates = await client
      .query<{ grant: string }>(
        `SELECT f.tbl || '.' || f.col AS grant
           FROM unnest($2::text[], $3::text[]) AS f(tbl, col)
          WHERE EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = f.tbl AND c.column_name = f.col)
            AND has_column_privilege($1, 'public.' || f.tbl, f.col, 'UPDATE')
          ORDER BY 1`,
        [APP_ROLE, APP_FORBIDDEN_COLUMN_UPDATES.map(([table]) => table), APP_FORBIDDEN_COLUMN_UPDATES.map(([, column]) => column)],
      )
      .catch(() => ({ rows: [{ grant: '검사 실패' }] }));
    const appForbiddenColumnUpdates = forbiddenUpdates.rows.map((row) => row.grant);
    // 202609230750 — 테이블이 아직 없으면 건너뛴다(pending 이 이미 ok=false 로 만든다).
    const forbiddenPrivileges = await client
      .query<{ grant: string }>(
        `SELECT f.tbl || CASE WHEN f.col = '' THEN '' ELSE '.' || f.col END || ':' || f.priv AS grant
           FROM unnest($2::text[], $3::text[], $4::text[]) AS f(tbl, priv, col)
          WHERE to_regclass('public.' || f.tbl) IS NOT NULL
            AND CASE
                  WHEN f.col <> '' THEN
                    EXISTS (SELECT 1 FROM information_schema.columns c
                             WHERE c.table_schema = 'public' AND c.table_name = f.tbl AND c.column_name = f.col)
                    AND has_column_privilege($1, 'public.' || f.tbl, f.col, f.priv)
                  WHEN f.priv IN ('INSERT', 'UPDATE') THEN
                    has_table_privilege($1, 'public.' || f.tbl, f.priv) OR has_any_column_privilege($1, 'public.' || f.tbl, f.priv)
                  ELSE has_table_privilege($1, 'public.' || f.tbl, f.priv)
                END
          ORDER BY 1`,
        [
          APP_ROLE,
          APP_FORBIDDEN_PRIVILEGES.map(([table]) => table),
          APP_FORBIDDEN_PRIVILEGES.map(([, privilege]) => privilege),
          APP_FORBIDDEN_PRIVILEGES.map(([, , column]) => column ?? ''),
        ],
      )
      .catch(() => ({ rows: [{ grant: '검사 실패' }] }));
    const appForbiddenPrivileges = forbiddenPrivileges.rows.map((row) => row.grant);
    const guards = await client
      .query<{ guard: string; validated: boolean | null }>(
        `SELECT 'trigger:' || c.relname || '.' || t.tgname AS guard, NULL::boolean AS validated
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'D'
         UNION ALL
         SELECT 'constraint:' || c.relname || '.' || k.conname, k.convalidated
           FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          WHERE c.relnamespace = 'public'::regnamespace AND k.contype IN ('c', 'f', 'u', 'p')
         UNION ALL
         SELECT 'index:' || t.relname || '.' || c.relname
                || '(' || (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, false), ',' ORDER BY n) FROM generate_series(1, i.indnkeyatts) AS n) || ')'
                || coalesce(' WHERE ' || pg_get_expr(i.indpred, i.indrelid), ''),
                NULL::boolean
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
          WHERE t.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indisvalid AND i.indisready
         UNION ALL
         SELECT 'lookup_index:' || t.relname || '.' || c.relname
                || '(' || (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, false), ',' ORDER BY n) FROM generate_series(1, i.indnkeyatts) AS n) || ')'
                || coalesce(' WHERE ' || pg_get_expr(i.indpred, i.indrelid), ''),
                NULL::boolean
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
          WHERE t.relnamespace = 'public'::regnamespace AND NOT i.indisunique AND i.indisvalid AND i.indisready`,
      )
      .catch(() => ({ rows: [] as { guard: string; validated: boolean | null }[] }));
    const presentGuards = new Map(guards.rows.map((row) => [row.guard, row.validated]));
    const missingGuards = REQUIRED_GUARDS.filter((guard) => !presentGuards.has(guard));
    const tolerated = new Set<string>(NOT_VALID_TOLERATED_GUARDS);
    const unvalidatedGuards = REQUIRED_GUARDS.filter((guard) => presentGuards.get(guard) === false && !tolerated.has(guard));
    const reservedLocalPartCheckValidated =
      presentGuards.get('constraint:agent_addresses.agent_addresses_not_reserved_local_part') ?? null;
    // 운영자 예약 주소를 활성으로 쥔 행 중 조직의 허가 행이 없는 것(202609301500). 표·함수가 없으면(미적용) 건너뛴다 — pending 이 ok=false 로 만든다.
    const operatorAddresses = await client
      .query<{ address: string }>(
        `SELECT DISTINCT a.address
           FROM agent_addresses a JOIN agents g ON g.id = a.agent_id
          WHERE a.retired_at IS NULL
            AND a.address = ANY (atmark_operator_assignable_addresses())
            AND NOT EXISTS (SELECT 1 FROM operator_address_grants o WHERE o.address = a.address AND o.organization_id = g.organization_id)
          ORDER BY 1`,
      )
      .catch((error: unknown) =>
        // 표·함수가 없으면(1500 전) 식별자 해석이 계획 단계에서 실패한다(`to_regclass` 는 그 앞을 못 막는다) — 미적용은 빈 목록, 그 밖의 실패는 '검사 실패'.
        ['42883', '42P01'].includes((error as { code?: string }).code ?? '') ? { rows: [] as { address: string }[] } : { rows: [{ address: '검사 실패' }] },
      );
    const operatorAddressesWithoutGrant = operatorAddresses.rows.map((row) => row.address);
    const tempRoles = await client
      .query<{ role: string }>(
        `SELECT r.rolname AS role FROM pg_roles r
          WHERE r.rolname = ANY ($1::text[]) AND has_database_privilege(r.oid, current_database(), 'TEMPORARY')
          ORDER BY 1`,
        [[APP_ROLE, ...Object.keys(RESTRICTED_ROLE_GRANTS).filter((role) => role !== APP_ROLE)]],
      )
      .catch(() => ({ rows: [{ role: '검사 실패' }] }));
    const databaseTempRoles = tempRoles.rows.map((row) => row.role);
    const restrictedRoles: RestrictedRoleReport[] = [];
    for (const role of Object.keys(RESTRICTED_ROLE_GRANTS) as (keyof typeof RESTRICTED_ROLE_GRANTS)[]) {
      restrictedRoles.push(await inspectRestrictedRole(client, role));
    }
    // 셀프 가입(202609240800) — SECURITY DEFINER 함수의 실행 권한·search_path. search_path 는 고정돼 있을 뿐 아니라 `pg_temp` 가
    //   **마지막**에 적혀 있어야 한다(적대적 검토 L1, 202609250240) — 적지 않으면 pg_temp 가 암묵으로 맨 앞에서 관계 이름을 먼저 찾는다.
    const definers = await client
      .query<{ problem: string }>(
        `SELECT p.proname || CASE WHEN has_function_privilege('public', p.oid, 'EXECUTE') THEN ':public_execute' ELSE ':search_path' END AS problem
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
            AND (has_function_privilege('public', p.oid, 'EXECUTE')
                 OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c(setting)
                                 WHERE c.setting ~ '^search_path=(.*,[[:space:]]*)?"?pg_temp"?$'))
          ORDER BY 1`,
      )
      .catch(() => ({ rows: [{ problem: '검사 실패' }] }));
    const unsafeSecurityDefiners = definers.rows.map((row) => row.problem);
    const policyV2 = await readPolicyV2Status(client);
    const transparency = await readTransparencyStatus(client);
    const billing = await readBillingStatus(client);
    const ops = await readOpsStatus(client);
    const pending = files.filter((file) => !appliedSet.has(file));
    return {
      action: 'status',
      ok:
        pending.length === 0 &&
        appRoleProblem === null &&
        !appCanInsertSenderMarks &&
        appLoginPrivileges.length === 0 &&
        appForbiddenColumnUpdates.length === 0 &&
        appForbiddenPrivileges.length === 0 &&
        missingGuards.length === 0 &&
        unvalidatedGuards.length === 0 &&
        databaseTempRoles.length === 0 &&
        restrictedRoles.every((report) => report.problems.length === 0) &&
        unsafeSecurityDefiners.length === 0 &&
        operatorAddressesWithoutGrant.length === 0 &&
        (ops === null ||
          (ops.opsRoleWrites.length === 0 &&
            ops.foreignOpsTablePrivileges.length === 0 &&
            ops.functionProblems.length === 0 &&
            ops.roleConfigProblems.length === 0 &&
            !ops.hardLockedButCanLogin)),
      migrationFiles: files.length,
      migrationsApplied: appliedSet.size,
      pending,
      appRoleOk: appRoleProblem === null,
      appRoleProblem,
      appCanInsertSenderMarks,
      appLoginPrivileges,
      appForbiddenColumnUpdates,
      appForbiddenPrivileges,
      missingGuards,
      unvalidatedGuards,
      databaseTempRoles,
      reservedLocalPartCheckValidated,
      operatorAddressesWithoutGrant,
      restrictedRoles,
      unsafeSecurityDefiners,
      policyV2,
      transparency,
      billing,
      ops,
    };
  });
}

/**
 * 호스팅 운영자 콘솔 검사(1~7). `ops_settings` 가 없으면(0500 전) `null`. 검사 쿼리가 실패하면 그 항목에 '검사 실패' 를 싣는다(ok=false).
 */
async function readOpsStatus(client: PoolClient): Promise<OpsStatus | null> {
  const present = await client
    .query<{ ok: boolean }>(`SELECT to_regclass('public.ops_settings') IS NOT NULL AS ok`)
    .catch(() => ({ rows: [{ ok: false }] }));
  if (present.rows[0]?.ok !== true) return null;
  const failed = ['검사 실패'];
  // 1. atmark_ops 의 표 쓰기(모든 public 표).
  const writes = await client
    .query<{ grant: string }>(
      `SELECT c.relname || ':' || p.privilege AS grant
         FROM pg_class c CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
          AND (has_table_privilege($1, c.oid, p.privilege)
               OR (p.privilege IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege($1, c.oid, p.privilege)))
        ORDER BY 1`,
      [OPS_ROLE],
    )
    .then((result) => result.rows.map((row) => row.grant))
    .catch(() => failed);
  // 2. 다른 롤의 ops 표 권한.
  const foreign = await client
    .query<{ grant: string }>(
      `SELECT r.rolname || ':' || t.name || ':' || p.privilege AS grant
         FROM pg_roles r
         CROSS JOIN unnest($2::text[]) AS t(name)
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
        WHERE r.rolname = ANY ($1::text[]) AND to_regclass('public.' || t.name) IS NOT NULL
          AND (has_table_privilege(r.oid, ('public.' || t.name)::regclass, p.privilege)
               OR (p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                   AND has_any_column_privilege(r.oid, ('public.' || t.name)::regclass, p.privilege)))
        ORDER BY 1`,
      [[...OPS_TABLE_FORBIDDEN_ROLES], [...OPS_TABLES]],
    )
    .then((result) => result.rows.map((row) => row.grant))
    .catch(() => failed);
  // 3·5. ops 함수의 EXECUTE 받은 롤(소유자 제외 · PUBLIC 포함) · 정의 함수 소유자 = ops 표 소유자.
  const functions = await client
    .query<{ name: string; grantees: string[]; definer: boolean; owned: boolean }>(
      `SELECT p.proname AS name,
              coalesce((SELECT array_agg((CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) ORDER BY 1)
                          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), ARRAY[]::text[]) AS grantees,
              p.prosecdef AS definer,
              p.proowner = (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.ops_settings'::regclass) AS owned
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND (p.proname LIKE 'ops\_%' OR p.proname LIKE 'zz\_ops\_%' OR p.proname IN ('purge_ops_login_records', 'expire_ops_requests'))
        ORDER BY 1`,
    )
    .then((result) =>
      result.rows.flatMap((row) => {
        const allowed = new Set(OPS_FUNCTION_EXECUTORS[row.name] ?? []);
        return [
          ...row.grantees.filter((grantee) => !allowed.has(grantee)).map((grantee) => `${row.name}:execute_by:${grantee}`),
          ...(row.definer && !row.owned ? [`${row.name}:definer_not_owned_by_table_owner`] : []),
        ];
      }),
    )
    .catch(() => failed);
  // 4·6. 롤 속성 · 하드 잠금.
  const role = await client
    .query<{ rolconnlimit: number; rolconfig: string[] | null; rolinherit: boolean; rolcanlogin: boolean }>(
      'SELECT rolconnlimit, rolconfig, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [OPS_ROLE],
    )
    .then((result) => result.rows[0] ?? null)
    .catch(() => null);
  const settings = await client
    .query<{ console_enabled: boolean; hard_locked: boolean }>('SELECT console_enabled, hard_locked FROM ops_settings WHERE id')
    .then((result) => result.rows[0] ?? null)
    .catch(() => null);
  const roleConfigProblems: string[] =
    role === null
      ? ['롤 없음']
      : [
          ...(role.rolconnlimit === OPS_ROLE_CONNECTION_LIMIT ? [] : [`connection_limit=${String(role.rolconnlimit)}`]),
          ...(role.rolinherit ? ['inherit'] : []),
          ...Object.entries(OPS_ROLE_SETTINGS)
            .filter(([setting, value]) => !(role.rolconfig ?? []).includes(`${setting}=${value}`))
            .map(([setting]) => `${setting} 없음`),
        ];
  // 7. 스위치 쌍(경고).
  const beta = await client
    .query<{ enabled: boolean }>('SELECT ops_activation_beta_enabled() AS enabled')
    .then((result) => result.rows[0]?.enabled ?? null)
    .catch(() => null);
  return {
    opsRoleWrites: writes,
    foreignOpsTablePrivileges: foreign,
    functionProblems: functions,
    roleConfigProblems,
    hardLockedButCanLogin: settings === null ? true : settings.hard_locked && role?.rolcanlogin === true,
    betaSwitchMismatch: beta !== null && beta !== BETA_ON_ACTIVATION,
    consoleEnabled: settings?.console_enabled ?? false,
    hardLocked: settings?.hard_locked ?? false,
  };
}

/** 하드 킬 스위치 — 마스터 풀. 트랜잭션은 lockOpsRole·unlockOpsRole 이 단계마다 연다(NOLOGIN 커밋 → 트랜잭션 밖에서 백엔드 종료 → 다시 보기). */
async function runOpsRoleLock(pool: Pool, action: 'ops-role-lock' | 'ops-role-unlock'): Promise<OpsRoleLockResult> {
  const outcome = await withClient(pool, (client) => (action === 'ops-role-lock' ? lockOpsRole(client) : unlockOpsRole(client)));
  log(action === 'ops-role-lock' && (outcome.hardLocked !== true || outcome.remaining > 0) ? 'warn' : 'info', 'runtime.ops_role_lock', {
    route_id: 'migrate',
    outcome: action,
    detail: `can_login=${String(outcome.canLogin)} terminated=${String(outcome.terminated)} remaining=${String(outcome.remaining)} hard_locked=${String(outcome.hardLocked)}`,
  });
  return { action, ...outcome };
}

/** 투명성 로그 상태(정보). 테이블이 없으면(미적용) `null`. */
async function readTransparencyStatus(client: PoolClient): Promise<MigrationStatus['transparency']> {
  try {
    const row = (
      await client.query<{
        pending: number;
        oldest: number | null;
        latest: string | null;
        age: number | null;
        unpublished: number;
        stale: number;
      }>(
        `SELECT (SELECT count(*)::int FROM tlog_outbox WHERE processed_at IS NULL) AS pending,
                (SELECT extract(epoch FROM now() - min(enqueued_at))::int FROM tlog_outbox WHERE processed_at IS NULL) AS oldest,
                (SELECT max(epoch)::text FROM tlog_epochs) AS latest,
                (SELECT extract(epoch FROM now() - max(closed_at))::int FROM tlog_epochs) AS age,
                (SELECT count(*)::int FROM tlog_epochs WHERE published_at IS NULL) AS unpublished,
                (SELECT count(*)::int FROM tlog_anchors WHERE state IN ('pending', 'submitted') AND created_at < now() - interval '24 hours') AS stale`,
      )
    ).rows[0];
    if (row === undefined) return null;
    return {
      pendingOutbox: row.pending,
      oldestPendingSeconds: row.oldest,
      latestEpoch: row.latest === null ? null : Number(row.latest),
      latestEpochAgeSeconds: row.age,
      unpublishedEpochs: row.unpublished,
      staleAnchors: row.stale,
    };
  } catch {
    return null;
  }
}

/** 결제 공급자 연동 상태(정보). 표가 없으면(미적용) `null`. */
async function readBillingStatus(client: PoolClient): Promise<MigrationStatus['billing']> {
  try {
    const row = (
      await client.query<{
        pending: number;
        failed: number;
        oldest: number | null;
        subscriptions: number;
        checkouts: number;
        reconciled: Date | null;
      }>(
        `SELECT (SELECT count(*)::int FROM billing_events WHERE status = 'pending') AS pending,
                (SELECT count(*)::int FROM billing_events WHERE status = 'failed') AS failed,
                (SELECT extract(epoch FROM now() - min(received_at))::int FROM billing_events WHERE status = 'pending') AS oldest,
                (SELECT count(*)::int FROM billing_subscriptions WHERE status <> 'canceled') AS subscriptions,
                (SELECT count(*)::int FROM billing_checkouts WHERE status = 'open') AS checkouts,
                (SELECT completed_at FROM billing_reconcile_state WHERE id = 1) AS reconciled`,
      )
    ).rows[0];
    if (row === undefined) return null;
    return {
      pendingEvents: row.pending,
      failedEvents: row.failed,
      oldestPendingSeconds: row.oldest,
      nonTerminalSubscriptions: row.subscriptions,
      openCheckouts: row.checkouts,
      reconcileLastCompletedAt: row.reconciled === null ? null : row.reconciled.toISOString(),
    };
  } catch {
    return null;
  }
}

/** 정책 v2 이전 결과(정보). 테이블이 없으면(미적용) `null`. */
async function readPolicyV2Status(client: PoolClient): Promise<MigrationStatus['policyV2']> {
  try {
    const legacy = await client.query<{ legacy: number; lists: number }>(
      `SELECT count(*) FILTER (WHERE v.outbound_mode IN ('approval_required', 'reply_only'))::int AS legacy,
              count(*) FILTER (WHERE p.config_json ? 'allowlist' OR p.config_json ? 'blocklist')::int AS lists
         FROM agent_policies p
         LEFT JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version`,
    );
    const rules = await client.query<{ key: string; n: number }>(
      `SELECT direction || ':' || list AS key, count(*)::int AS n FROM agent_contact_rules WHERE removed_at IS NULL GROUP BY 1 ORDER BY 1`,
    );
    return {
      legacyOutboundModeAgents: legacy.rows[0]?.legacy ?? 0,
      configListAgents: legacy.rows[0]?.lists ?? 0,
      contactRules: Object.fromEntries(rules.rows.map((row) => [row.key, row.n])),
    };
  } catch {
    return null;
  }
}

async function runMigrate(pool: Pool, physicalResourceId: string): Promise<MigrateResult> {
  const report: MigrationReport = await withClient(pool, async (client) => {
    const applied = await migrate(client);
    await verifyAppRoleIsNotOwner(client);
    return applied;
  });
  log('info', 'runtime.migrated', {
    route_id: 'migrate',
    outcome: 'ok',
    detail: `applied=${String(report.applied.length)} already=${String(report.alreadyApplied.length)}`,
  });
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { applied: report.applied.length, alreadyApplied: report.alreadyApplied.length },
    appliedFiles: report.applied,
  };
}

export function createMigrateHandler(composers: MigrateComposers) {
  return async (event: MigrateEvent | null | undefined, context: LambdaContext): Promise<MigrateHandlerResult> => {
    beginInvocation(context);
    const physicalResourceId = event?.PhysicalResourceId ?? MIGRATION_RESOURCE_ID;
    if (event?.RequestType !== undefined) {
      // 커스텀 리소스: Delete 는 무동작, Create/Update 는 migrate 만(부트스트랩은 마스터를 쥐는 수동 단계다).
      if (event.RequestType === 'Delete') {
        return { PhysicalResourceId: physicalResourceId, Data: { applied: 0, alreadyApplied: 0 }, appliedFiles: [] };
      }
      return runMigrate((await composers.owner(context)).pool, physicalResourceId);
    }
    const action = actionOf(event);
    if (action === 'bootstrap-roles') return runBootstrap(await composers.bootstrap(context));
    if (action === 'ops-role-lock' || action === 'ops-role-unlock') return runOpsRoleLock((await composers.bootstrap(context)).pool, action);
    if (action === 'status') return runStatus((await composers.owner(context)).pool);
    return runMigrate((await composers.owner(context)).pool, physicalResourceId);
  };
}

export const handler = createMigrateHandler({
  owner: (context) => composeMigration(platformOf(context)),
  bootstrap: (context) => composeRoleBootstrap(platformOf(context)),
});
