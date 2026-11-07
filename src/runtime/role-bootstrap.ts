/**
 * src/runtime/role-bootstrap.ts — **소유자 롤·앱 롤 만들기.** migrate 핸들러의 `bootstrap-roles` 가 RDS 마스터로 돈다.
 *
 * 왜 러너(`db/migrate.ts`)가 아니라 여기인가: 러너는 롤을 만들지 **않는다** — 앱 롤이 마이그레이션이 도는 세션에서
 * 태어나면 "앱 롤은 소유자가 아니다" 단언이 자기가 만든 것을 검사하게 된다(그 파일 머리말). 그래서 롤은 **다른
 * 자격증명(마스터)으로 먼저** 만들고, 마이그레이션은 그 뒤에 소유자 롤로 돈다. RDS 가 프라이빗이라 이 일을 할
 * 수 있는 곳이 VPC 안의 migrate Lambda 뿐이다.
 *
 * 만드는 것:
 *   - `atmark_owner` — LOGIN, 슈퍼유저·CREATEROLE·CREATEDB·BYPASSRLS 없음. **DB `atmark` 의 소유자**가 된다
 *     (PG15+ 의 `public` 스키마는 `pg_database_owner` 소유 — DB 소유자가 곧 스키마 소유자라 마이그레이션 4 의
 *     `REVOKE CREATE ON SCHEMA public FROM PUBLIC` 이 선다).
 *   - `atmark_app` — LOGIN, 같은 속성 없음 + **NOINHERIT**. 어떤 롤의 멤버로도 만들지 않는다. 테이블 권한은
 *     마이그레이션이 준다.
 *   - `atmark_admin` · `atmark_login_mailer` (ADR-0006) — 앱 롤과 같은 모양(NOINHERIT · 멤버십 없음 · 아무것도 소유하지
 *     않음). 권한은 마이그레이션 202609230720 이 **컬럼 단위까지** 준다. admin Lambda 는 소유자 롤 대신 앞의 것으로, 로그인 메일
 *     Lambda 는 뒤의 것으로 붙는다. 허용 목록은 아래 `RESTRICTED_ROLE_GRANTS` 이고 migrate `status` 가 실제 ACL 과 대조한다.
 *   - `atmark_passport_signer` · `atmark_tlog` · `atmark_tlog_anchor` · `atmark_billing` · `atmark_billing_operator` — 같은 모양. 권한은 각자의
 *     마이그레이션(202609241200 · 202609241600 · 202609250400)이 준다. 결제 롤 둘은 sync λ 와 운영자 `admin:plan` 의 롤이다(ADR-0012).
 *   - `atmark_ops` — 호스팅 운영자 콘솔 λ(ops.atmark.ai, `.omc/plans/ops-console.md` §3.2). 같은 모양 + `CONNECTION LIMIT 3` · 타임아웃 셋.
 *     권한은 202609290500·0510(읽기 · 정의 함수 EXECUTE, 쓰기 0). `ops_settings.hard_locked` 면 LOGIN 을 되돌리지 않는다(`lockOpsRole`).
 *
 * **멱등이고 회전하지 않는다.** 롤이 있고 그 비밀이 이미 채워져 있으면 손대지 않는다 — 돌고 있는 Lambda 가 캐시한
 * 비밀번호를 무효로 만들지 않기 위해서다. 비밀이 아직 placeholder 면(첫 부트스트랩, 또는 커밋 뒤 비밀 쓰기가 실패했던
 * 재시도) 새 비밀번호를 정해 롤에 걸고, **커밋 뒤에** 비밀에 쓴다.
 *
 * **비밀번호 평문이 SQL 에 실리지 않는다.** SCRAM-SHA-256 검증자를 여기서 계산해 `PASSWORD '<verifier>'` 로 넘긴다 —
 * `log_statement=ddl` 이 켜진 파라미터 그룹에서도 로그에 남는 것은 검증자뿐이다(검증자로는 로그인할 수 없다).
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  ADMIN_ROLE_NAME,
  AI_WATCH_ROLE_NAME,
  APP_ROLE,
  BILLING_OPERATOR_ROLE_NAME,
  BILLING_ROLE_NAME,
  DOMAIN_TICK_ROLE_NAME,
  LOGIN_MAILER_ROLE_NAME,
  OPS_ROLE_NAME,
  PASSPORT_SIGNER_ROLE_NAME,
  TLOG_ANCHOR_ROLE_NAME,
  TLOG_ROLE_NAME,
} from '../db/migrate';
import { DOMAIN_TICK_ROLE_CONNECTION_LIMIT } from '../domains/contract';
import { OPS_ROLE_CONNECTION_LIMIT } from '../ops/contract';

/**
 * 고객 도메인 확인 틱의 DB 롤(ADR-0014 · 보안 M2) — `custom_domains` 상태·확인·사가 칸의 유일한 쓰기 롤. 마이그레이션 202609291100 의 GRANT 가
 * 이 롤을 요구하므로 `bootstrap-roles` 가 늘 만든다. 단계 0 에서는 NOLOGIN(비밀 없음)이었고 **단계 2(2026-10) 부터 다른 제한 롤과 같은 모양**이다 —
 * 비밀(`atmark/db/domain-tick`, AtmarkCompute 소유)이 자리표시면 LOGIN + 새 비밀번호(이미 있던 NOLOGIN 롤은 `ALTER ROLE … LOGIN`), 채워져 있으면
 * 건드리지 않는다. 그 비밀을 읽는 쪽(admin λ 안의 틱 풀)은 단계 4 다.
 */
export const DOMAIN_TICK_ROLE = DOMAIN_TICK_ROLE_NAME;

/** 정책 변경 요청(202610131201) — 앱 롤이 읽는 칸. 이유(`reason`) · 토큰 · 지문 · 오염 칸은 읽지 않는다(콘솔 = admin 롤만). */
export const POLICY_REQUEST_APP_READ_COLUMNS = [
  'id',
  'agent_id',
  'organization_id',
  'action',
  'direction',
  'list',
  'value',
  'mode',
  'status',
  'created_at',
  'expires_at',
  'decided_at',
  'applied_version',
  'stale_reason',
  'notice_id',
] as const;

/**
 * AI 의심 메일 감시 결과 λ 의 DB 롤(ADR-0017 초안 · 202610061100) — `atmark/db/ai-watch`(AtmarkCompute 소유). 정의 함수 둘 EXECUTE + schema USAGE 만,
 * 표 권한 0. 다른 제한 롤과 같은 모양(NOINHERIT · 멤버십·소유 0) + `CONNECTION LIMIT 2(예약 1 × 풀 1 + 재배포 여유 1 — 동결된 옛 실행 환경은 유휴 타이머가 돌지 않아 연결을 쥔 채 남는다. 1 이면 새 환경이 53300 → 결과·하트비트가 DLQ)`.
 * 마이그레이션은 이 롤을 요구하지 않는다(소유자 롤엔 CREATEROLE 이 없다 — 보안 리뷰 H1). 롤의 GRANT 는 마이그레이션의 `ai_watch_apply_role_grants()`
 * 에 있고, 여기서 롤을 만든 뒤 소유자로 잠시 SET ROLE 해 부른다(`applyAiWatchRoleGrants`).
 */
export const AI_WATCH_ROLE = AI_WATCH_ROLE_NAME;

/** `atmark_ai_watch` 의 연결 한도 — 계약 `AI_WATCH_DB_ROLE_CONNECTION_LIMIT` 과 같다(단위 테스트가 대조 — 판정 쪽 폐포 때문에 import 하지 않는다). */
export const AI_WATCH_ROLE_CONNECTION_LIMIT = 2;

/** 소유자 롤 이름. 마이그레이션은 이 롤로 돈다(`atmark/db/owner` 비밀의 `username`). */
export const OWNER_ROLE = 'atmark_owner';

/** 앱 롤 이름 — 마이그레이션 4 가 GRANT 하는 대상(`db/migrate.ts` `APP_ROLE`). */
export const APP_ROLE_NAME = APP_ROLE;

/** admin Lambda(console.atmark.ai) 의 DB 롤 — `atmark/db/admin`. 소유자 롤이 아니다(ADR-0006). */
export const ADMIN_ROLE = ADMIN_ROLE_NAME;

/** 로그인 메일 Lambda 의 DB 롤 — `atmark/db/login-mailer`. `owner_login_links` 발송 컬럼 + 수신자 한 칸. */
export const LOGIN_MAILER_ROLE = LOGIN_MAILER_ROLE_NAME;

/**
 * passport 서명 Lambda 의 DB 롤 — `atmark/db/passport-signer`(계약 §3 T4). 문서를 만드는 데 필요한 칸만 읽고, passport 버전·문서·게시
 * outbox 에만 쓴다(202609241200 ④). 조직·토큰·메시지 본문·정책은 못 읽는다. 에이전트 개인키를 복호할 수 있는 런타임 주체의 DB 면.
 */
export const PASSPORT_SIGNER_ROLE = PASSPORT_SIGNER_ROLE_NAME;

/**
 * 투명성 로그 서열기·에폭·게시 Lambda 의 DB 롤 — `atmark/db/tlog`(ADR-0008, US-010). outbox 처리 표시 · 잎·에폭·헤드 INSERT · 원천 테이블의
 * **잎에 필요한 칸만** SELECT(202609241600 ⑦). 본문·제목·토큰·조직 행은 못 읽는다. 체크포인트 KMS 서명 키를 쓰는 런타임 주체의 DB 면.
 */
export const TLOG_ROLE = TLOG_ROLE_NAME;

/** 투명성 로그 외부 앵커 Lambda 의 DB 롤 — `atmark/db/tlog-anchor`. 에폭의 체크포인트 읽기 · 앵커 행 쓰기뿐(잎·원천·솔트 0). */
export const TLOG_ANCHOR_ROLE = TLOG_ANCHOR_ROLE_NAME;

/**
 * 결제 동기화 Lambda(billing-sync)의 DB 롤 — `atmark/db/billing`(WP-2, ADR-0012). 이벤트 원장 · 결속 · 구독 · 체크아웃 완료 표시 · reconcile 커서 ·
 * 엔타이틀먼트 **provider 출처** 쓰기(가드 `org_entitlements_source_by_role`) · 감사 INSERT(읽기 없음). 조직은 id 한 칸, 이메일·본문은 0.
 */
export const BILLING_ROLE = BILLING_ROLE_NAME;

/**
 * 결제 운영자 CLI(`pnpm admin:plan`)의 DB 롤 — `atmark/db/billing-operator`(WP-2, D-7). 요금제 보기(`planUsageOp` 의 칸) · **operator 출처** 쓰기 ·
 * 감사 INSERT · 샌드박스 공급자 행 찾기(구독 세 칸). 이벤트·체크아웃·고객은 0. Lambda 가 아니라 운영자 터널에서 붙는다.
 */
export const BILLING_OPERATOR_ROLE = BILLING_OPERATOR_ROLE_NAME;

/**
 * 호스팅 운영자 콘솔 λ 의 DB 롤 — `atmark/db/ops`(`.omc/plans/ops-console.md` §3.2). 읽기(칸 단위)와 정의 함수 EXECUTE 만 — **쓰기 GRANT 0**.
 * 특권 전이는 소유자 소유 정의 함수(티켓 → 코어)로만 한다(202609290500·0510). 모양은 다른 제한 롤과 같고(NOINHERIT · 멤버십·소유 0),
 * 더해서 `CONNECTION LIMIT 3`(예약 2 + 여유 1 — 연결 예산 72/75, I-5)과 짧은 타임아웃 셋(`OPS_ROLE_SETTINGS`)을 롤에 건다.
 * `ops_settings.hard_locked` 가 참이면 부트스트랩이 LOGIN 을 되돌리지 않는다(하드 킬 스위치 — migrate `ops-role-lock`).
 */
export const OPS_ROLE = OPS_ROLE_NAME;

/**
 * `atmark_ops` 의 `rolconfig` — 정의 함수 하나가 세션을 오래 쥐지 못하게. migrate `status` 검사 4 가 같은 값을 본다.
 * `idle_session_timeout`(PG14+) — 얼어 있는 옛 Lambda 환경의 소켓을 서버가 2분 뒤 닫는다(CONNECTION LIMIT 3 이 재배포 뒤 53300 으로 막히지 않게 —
 * 런북 ops-console §5). 대가: 오래 쉰 뒤 첫 쿼리가 끊긴 소켓을 한 번 만난다(풀이 버리고 새로 붙는다).
 */
export const OPS_ROLE_SETTINGS: Readonly<Record<string, string>> = {
  statement_timeout: '5s',
  lock_timeout: '2s',
  idle_in_transaction_session_timeout: '10s',
  idle_session_timeout: '120s',
};

/** 칸 단위 SELECT 표기 여러 줄. */
function selectColumns(table: string, columns: readonly string[]): string[] {
  return columns.map((column) => `${table}.${column}:SELECT`);
}

/** `org_entitlements` 쓰기 칸 — billing·billing-operator 롤이 같은 칸을 받는다(한도 열한 · 요금제 · 출처 · 원인 · 유예 · 버전 · 제어 칸). */
const ENTITLEMENT_WRITE_COLUMNS = [
  'plan_code',
  'source',
  'cause',
  'max_agents',
  'org_daily_recipients',
  'agent_per_day_max',
  'agent_per_minute_max',
  'recipients_per_message_max',
  'tokens_per_agent_max',
  'webhook_endpoints_per_agent_max',
  'org_api_keys_max',
  'inbound_storage_bytes',
  // 메일 기본기 2차(202609270105, ADR-0013 D6).
  'aliases_per_agent_max',
  'attachment_bytes_total_max',
  'grace_until',
  'version',
  'provider_override_allowed',
] as const;

const ENTITLEMENT_WRITE_GRANTS = [
  'org_entitlements:SELECT',
  'org_entitlements.organization_id:INSERT',
  ...ENTITLEMENT_WRITE_COLUMNS.map((column) => `org_entitlements.${column}:INSERT`),
  ...ENTITLEMENT_WRITE_COLUMNS.map((column) => `org_entitlements.${column}:UPDATE`),
];

/**
 * **제한 롤의 권한 허용 목록** — 마이그레이션 202609230720 과 같은 내용을 한 번 더 적는다. 표기:
 *   - `schema:<이름>:<권한>` — 스키마 권한
 *   - `<테이블>:<권한>` — 테이블 단위
 *   - `<테이블>.<컬럼>:<권한>` — 컬럼 단위
 * migrate `status` 는 실제 권한이 이 목록을 **넘으면** 실패로 보고한다(모자란 것은 기능 테스트가 잡는다 — 넘치는 것은
 * 아무 테스트도 빨개지지 않으므로 여기서 본다). 목록과 마이그레이션의 **일치**는 통합 테스트가 본다.
 *
 * **앱 롤(`atmark_app`)도 여기 있다**(202609230750, ADR-0006 보강 — 2차 검증 H-A·H-B). 앱 롤이 프로비저닝 테이블의
 * INSERT·정책 UPDATE·토큰 `revoked_at` UPDATE 등을 **다시 얻으면** 이 목록 밖 권한으로 `status` 가 ok=false 가 된다.
 * 목록은 앱 코드(`src/**` 에서 `src/admin/**` 제외)가 실제로 보내는 쓰기에서 뽑았다 — 표는 그 마이그레이션 머리말.
 *
 * **셀프 가입(202609240800)** 이 admin·login-mailer 에 가입 테이블 권한과 SECURITY DEFINER 함수 EXECUTE 하나씩을 더했다. 앱 롤은
 * 가입 테이블·함수 권한이 0 이다(`APP_FORBIDDEN_LOGIN_TABLES` · `unsafeSecurityDefiners`).
 */
/** 앱 롤이 읽는 `custom_domains` 칸(202609291100) — 정책 로더 스냅샷(`policy-source.ts`)과 수신 판정(단계 3)이 쓰는 것뿐. */
const CUSTOM_DOMAIN_APP_READ_COLUMNS = ['id', 'organization_id', 'domain', 'status', 'suspended_reason', 'sending_started_at', 'removed_at', 'created_at'] as const;
/** admin 이 새 도메인 행에 넣는 칸(식별 칸 + 첫 확인 시각). 상태·사가 칸은 기본값(트리거가 pending 만 받는다). */
const CUSTOM_DOMAIN_ADMIN_INSERT_COLUMNS = ['organization_id', 'domain', 'registrable_domain', 'challenge_token', 'created_by_user_id', 'next_check_at'] as const;
/** admin(콘솔·조직 API)이 고치는 칸 — 수동 확인 · 제거 요청뿐(보안 M2). 상태·확인·사가 칸은 틱 롤이다. */
const CUSTOM_DOMAIN_ADMIN_UPDATE_COLUMNS = ['last_manual_check_at', 'next_check_at', 'removal_requested_at'] as const;
/** 틱 롤이 고치는 칸 — `sending_started_at`(DEFINER 1회 쓰기) · `removal_requested_at`(소유자 요청) · 수동 확인 시각은 없다. */
const CUSTOM_DOMAIN_TICK_UPDATE_COLUMNS = [
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
  // identity 관리자(202610061000 · one-shot) — 클레임 · 놓기 · 넘겨받는 행. admin 은 없다.
  'identity_claimed_at',
  'identity_released_at',
  'identity_handover_to',
] as const;
/** 앱 롤(알림 배출)이 읽고 고치는 `domain_notices` 칸. */
const DOMAIN_NOTICE_APP_READ_COLUMNS = ['id', 'domain_id', 'organization_id', 'kind', 'event_key', 'created_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at'] as const;
/** 임대(`claimed_at`)와 시도 수는 집기 함수(`atmark_claim_domain_notice`)만 쓴다(재리뷰 L5). */
const DOMAIN_NOTICE_APP_UPDATE_COLUMNS = ['status', 'next_attempt_at', 'last_error', 'ses_message_id', 'sent_at'] as const;

/** 앱 롤이 고치는 `drafts` 칸(202610081200 — 묶음 B). 정체성 · 시각 칸은 없다(트리거가 적는다). */
export const DRAFT_APP_UPDATE_COLUMNS = [
  'revision',
  'from_address',
  'recipients',
  'subject',
  'in_reply_to',
  'attachment_ids',
  'content_storage_key',
  'content_bytes',
  'discarded_at',
  'send_idempotency_key',
  'send_claimed_at',
  'sent_message_id',
  'sent_at',
] as const;

/** 앱 롤(격리 알림 배출 — 202610071000)이 읽는 `quarantine_notices` 칸. 행은 수신 트리거(정의자)만 적는다 — INSERT 0. */
const QUARANTINE_NOTICE_APP_READ_COLUMNS = ['id', 'agent_id', 'organization_id', 'first_at', 'last_at', 'message_count', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'kind'] as const;
/** 결말 칸만 — 임대 · 시도 수 · 창의 수는 정의자 함수만 쓴다. */
const QUARANTINE_NOTICE_APP_UPDATE_COLUMNS = ['status', 'next_attempt_at', 'last_error', 'ses_message_id', 'sent_at'] as const;

/** admin 롤이 읽는 전달 칸 — `body` 만 뺀 전부(202609301410 ⑨ · 재검토 L-3). 마이그레이션의 칸 목록과 같아야 한다. */
const ADMIN_WEBHOOK_DELIVERY_READ_COLUMNS = [
  'id',
  'event_id',
  'endpoint_id',
  'event_type',
  'dedupe_key',
  'status',
  'attempt_count',
  'next_attempt_at',
  'last_error',
  'last_http_status',
  'delivered_at',
  'dead_at',
  'created_at',
  'redelivery_of',
  'last_attempt_at',
] as const;

export const RESTRICTED_ROLE_GRANTS: Readonly<
  Record<
    | typeof APP_ROLE_NAME
    | typeof ADMIN_ROLE
    | typeof LOGIN_MAILER_ROLE
    | typeof PASSPORT_SIGNER_ROLE
    | typeof TLOG_ROLE
    | typeof TLOG_ANCHOR_ROLE
    | typeof BILLING_ROLE
    | typeof BILLING_OPERATOR_ROLE
    | typeof OPS_ROLE
    | typeof DOMAIN_TICK_ROLE
    | typeof AI_WATCH_ROLE,
    readonly string[]
  >
> = {
  [APP_ROLE_NAME]: [
    // --- 메일 기본기 2차 A2(202609270130) — 발신 첨부 업로드·결속. 읽기·적기만(불변 — 고치기·지우기 트리거 거부).
    'outbound_attachments:SELECT',
    'outbound_attachments:INSERT',
    'message_attachments:SELECT',
    'message_attachments:INSERT',
    // --- 과금 P0(202609250300, ADR-0011) — 요금제 한도 **읽기만**(정책 로더 Stage 4 · 웹훅 상한). 쓰기가 열리면 api 탈취가 스스로 요금제를
    //   올린다(`APP_FORBIDDEN_PRIVILEGES`). billing_audit 은 0.
    'org_entitlements:SELECT',
    'ac0_gate_events:INSERT',
    'ac0_gate_events:SELECT',
    'ac0_gates:INSERT',
    'ac0_gates:SELECT',
    'agent_addresses:SELECT',
    // 토큰 마지막 사용 시각(202609241400, US-007) — 인증 성공마다 `last_used_at` 만 갱신(분 단위 코얼레싱). 다른 칸은
    //   여전히 0(revoked_at 포함) — 컬럼 단위 GRANT 가 그 칸만 허용한다.
    'agent_api_keys.last_used_at:UPDATE',
    'agent_api_keys:SELECT',
    // 정책 v2 연락처 목록(202609241010) — 관문·수신 소비자·신뢰 사실이 **읽기만**. 쓰기가 열리면 api 탈취가 자기 allow 목록을 늘린다.
    'agent_contact_rules:SELECT',
    'agent_keypairs:SELECT',
    'agent_policies:SELECT',
    'agents:SELECT',
    'approval_link_uses:INSERT',
    'approval_link_uses:SELECT',
    'approval_notifications.attempt_count:UPDATE',
    'approval_notifications.claimed_at:UPDATE',
    'approval_notifications.last_error:UPDATE',
    'approval_notifications.next_attempt_at:UPDATE',
    'approval_notifications.sent_at:UPDATE',
    'approval_notifications.ses_message_id:UPDATE',
    'approval_notifications.settled_at:UPDATE',
    'approval_notifications.status:UPDATE',
    'approval_notifications:SELECT',
    'approval_releases.claim_count:UPDATE',
    'approval_releases.last_deferral_reason:UPDATE',
    'approval_releases.next_release_at:UPDATE',
    'approval_releases.settled_at:UPDATE',
    'approval_releases.settled_outcome:UPDATE',
    'approval_releases.status:UPDATE',
    'approval_releases:SELECT',
    'approval_request_items:INSERT',
    'approval_request_items:SELECT',
    'approval_requests.agent_id:INSERT',
    'approval_requests.created_at:INSERT',
    'approval_requests.decided_at:UPDATE',
    'approval_requests.decided_by:UPDATE',
    'approval_requests.expires_at:INSERT',
    'approval_requests.granted_scope:UPDATE',
    'approval_requests.id:INSERT',
    'approval_requests.status:UPDATE',
    'approval_requests.subject:INSERT',
    'approval_requests:SELECT',
    'audit_logs.approved_by:UPDATE',
    'audit_logs.decision:UPDATE',
    'audit_logs.resolution_reason:UPDATE',
    'audit_logs.resolved_at:UPDATE',
    'audit_logs:INSERT',
    'audit_logs:SELECT',
    // 문의 전달 outbox(202609241500, US-009) — 수신 소비자가 행을 적고(INSERT 넷 + 차선 `lane`, 202610021000) 전달 워커가 결말 칸을 바꾼다. 수신자 칸은 없다.
    'contact_forwards.attempt_count:UPDATE',
    'contact_forwards.claimed_at:UPDATE',
    'contact_forwards.forward_ses_message_id:UPDATE',
    'contact_forwards.lane:INSERT',
    'contact_forwards.last_error:UPDATE',
    'contact_forwards.next_attempt_at:INSERT',
    'contact_forwards.next_attempt_at:UPDATE',
    'contact_forwards.received_at:INSERT',
    'contact_forwards.sender_hash:INSERT',
    'contact_forwards.sent_at:UPDATE',
    'contact_forwards.ses_message_id:INSERT',
    'contact_forwards.settled_at:UPDATE',
    'contact_forwards.status:UPDATE',
    'contact_forwards:SELECT',
    'function:audit_pending_overdue:EXECUTE',
    'human_mailbox_interventions:INSERT',
    'human_mailbox_interventions:SELECT',
    'inbound_attachments:INSERT',
    'inbound_attachments:SELECT',
    'inbound_messages:INSERT',
    'inbound_messages:SELECT',
    'inbound_rejections:INSERT',
    'inbound_rejections:SELECT',
    'messages.attempt:UPDATE',
    'messages.failed_at:UPDATE',
    'messages.failure_reason:UPDATE',
    'messages.lease_expires_at:UPDATE',
    'messages.lease_id:UPDATE',
    'messages.sent_at:UPDATE',
    'messages.ses_message_id:UPDATE',
    // 발신 스니펫 보존 스윕(202609241700, 검증 F3) — TTL 스위퍼가 365일 넘은 행의 스니펫을 NULL 로만(트리거
    //   `messages_snippet_retention_only` 가 모든 롤에 "NULL 로만 · 365일 넘은 행만" 을 강제한다 — 위조·조기 삭제 불가).
    'messages.snippet:UPDATE',
    'messages.status:UPDATE',
    'messages:INSERT',
    'messages:SELECT',
    'organizations.sending_started_at:UPDATE',
    'organizations:SELECT',
    'outbound_prepare_claims.claimed_until:UPDATE',
    'outbound_prepare_claims.generation:UPDATE',
    'outbound_prepare_claims.updated_at:UPDATE',
    'outbound_prepare_claims:INSERT',
    'outbound_prepare_claims:SELECT',
    'outbound_recipients:INSERT',
    'outbound_recipients:SELECT',
    // 공개 신원 API(202609241200, `GET /v1/identity/{address}`) — 서명된 문서(공개 전제)만 읽는다.
    'passport_documents:SELECT',
    'passports:SELECT',
    'policy_versions:SELECT',
    'scheduled_sends.attempt_count:UPDATE',
    'scheduled_sends.dispatch_outcome:UPDATE',
    'scheduled_sends.dispatched_at:UPDATE',
    'scheduled_sends.lease_expires_at:UPDATE',
    'scheduled_sends.message_id:UPDATE',
    'scheduled_sends.status:UPDATE',
    'scheduled_sends:INSERT',
    'scheduled_sends:SELECT',
    // --- 메일 기본기 1차 · W2 표지(202609260105) — 예약 취소 칼럼의 앱 롤 UPDATE 권한 줄은 이 표지 바로 아래에 둔다.
    'scheduled_sends.cancel_note:UPDATE',
    'scheduled_sends.cancel_reason_code:UPDATE',
    'scheduled_sends.cancelled_at:UPDATE',
    'scheduled_sends.cancelled_via:UPDATE',
    'schema:public:USAGE',
    'security_findings:INSERT',
    'security_findings:SELECT',
    'sender_marks:SELECT',
    'sender_relationships:INSERT',
    'sender_relationships:SELECT',
    'ses_events:INSERT',
    'ses_events:SELECT',
    'suppression_entries:SELECT',
    // 시스템 메일 억제(202609240900, 보안 검증 H2) — SES 이벤트 소비자가 하드 바운스·불만 주소를 **적기만** 한다(읽기·고치기·지우기 없음).
    'system_mail_suppressions.address:INSERT',
    'system_mail_suppressions.reason:INSERT',
    'threads.last_message_at:UPDATE',
    'threads:INSERT',
    'threads:SELECT',
    'webhook_deliveries.attempt_count:UPDATE',
    'webhook_deliveries.dead_at:UPDATE',
    'webhook_deliveries.delivered_at:UPDATE',
    'webhook_deliveries.last_error:UPDATE',
    'webhook_deliveries.last_http_status:UPDATE',
    'webhook_deliveries.next_attempt_at:UPDATE',
    'webhook_deliveries.status:UPDATE',
    'webhook_deliveries:INSERT',
    'webhook_deliveries:SELECT',
    'webhook_endpoints:INSERT',
    'webhook_endpoints:SELECT',
    // --- 메일 기본기 1차 · W3 표지(202609260115) — 웹훅 v2(구독·소프트 삭제·재전송)의 앱 롤 권한 줄은 이 표지 바로 아래에 둔다.
    //   소프트 삭제는 SECURITY DEFINER 함수 하나(켜진 행을 now() 로 끄기만) — 표 UPDATE 는 여전히 0(`APP_FORBIDDEN_PRIVILEGES`).
    'function:disable_webhook_endpoint:EXECUTE',
    // --- W4 표지(202609301410, 2026-09-30) — 웹훅 정의자 함수 넷(등록 · 회전 · 재전송 · 콘솔 시크릿 발급 확인 — 표 UPDATE 는 여전히 0) ·
    //   전달의 마지막 시도 시각(디스패처). 회전 원장·감사 상세 표 권한은 0.
    'function:register_webhook_endpoint:EXECUTE',
    'function:rotate_webhook_endpoint_secret:EXECUTE',
    'function:redeliver_webhook_delivery:EXECUTE',
    'function:console_webhook_secret_ref:EXECUTE',
    'webhook_deliveries.last_attempt_at:UPDATE',
    // --- 웹훅 인증 헤더(202610141400) — 디스패처가 봉인값을 읽고(평문 없음) 목록이 힌트를 읽는다 · 등록과 같은 트랜잭션의 설정 함수 하나
    //   (기존 엔드포인트의 값은 바꾸지 못한다 — 함수가 `not_allowed`). 표 INSERT·UPDATE·DELETE 0 · 지우기 함수 0.
    'webhook_endpoint_authorizations:SELECT',
    'function:set_webhook_endpoint_authorization:EXECUTE',
    // --- L5: /org-api 창 보존(202609250200, ADR-0010 후속 L5) — TTL 스위퍼가 7일 넘은 창 행을 지우는 함수 하나(인자 없음).
    //   표 권한은 0(`APP_FORBIDDEN_LOGIN_TABLES`) · DELETE 는 아무 롤에도 없다.
    'function:purge_org_api_request_windows:EXECUTE',
    // --- L7: 초대만 받은 사용자 주소 지우기(202609250220, ADR-0010 후속 L7) — TTL 스위퍼가 하루 한 번 부르는 배치 함수 하나. 사용자를
    //   고를 수 없고(후보·조건은 함수 안) 크기는 1–500 으로 잘린다. 한 사용자용 `erase_invited_only_user` 는 아무 롤에도 없다.
    'function:erase_invited_only_users:EXECUTE',
    // 시스템 메일 언어(202610101000) — 받는 사람의 언어만 돌려주는 정의자 둘(조직 멤버 · 주 소유자 / 활성 운영자). users·memberships 권한 0 그대로.
    'function:atmark_org_mail_locales:EXECUTE',
    'function:atmark_operator_mail_locale:EXECUTE',
    //   같은 과제가 하루 한 번 내는 밀린 수(약속 30일 + 7일을 넘긴 행 — 알람 `atmark-privacy-erasure-backlog`). 수 하나만 돌려준다.
    'function:invited_user_erasure_backlog:EXECUTE',
    // --- M2: 쓰이지 않은 가입 링크 보존(202609250240) — 발송이 끝났고 만료 30일이 지난 행만 지우는 함수(인자 없음). 표 권한은 0 그대로.
    'function:purge_expired_signup_links:EXECUTE',
    // 로그인·가입 코드 시도 원장 보존(202609280102) — 하루 넘은 행만 지우는 함수(인자 없음). 표 권한은 0(`APP_FORBIDDEN_LOGIN_TABLES`).
    'function:purge_login_code_attempts:EXECUTE',
    // --- 호스팅 운영자 콘솔(202609290500, I-6 · H13) — 보존·만료·census 함수 셋만 이름으로. ops 표 권한은 0(`APP_FORBIDDEN_LOGIN_TABLES`).
    'function:purge_ops_login_records:EXECUTE',
    'function:expire_ops_requests:EXECUTE',
    'function:ops_operator_census:EXECUTE',
    // --- 고객 도메인(202609291100, ADR-0014) — 관문 스냅샷·수신 판정이 읽는 칸만 · 도메인 워밍업 시계(DEFINER, 칼럼 UPDATE 0) · 도메인 알림 배출
    //   (outbox 결말 칸 · 수신자는 DEFINER 함수 — users·memberships 권한 0 그대로).
    ...CUSTOM_DOMAIN_APP_READ_COLUMNS.map((column) => `custom_domains.${column}:SELECT`),
    'function:atmark_mark_domain_sending_started:EXECUTE',
    ...DOMAIN_NOTICE_APP_READ_COLUMNS.map((column) => `domain_notices.${column}:SELECT`),
    ...DOMAIN_NOTICE_APP_UPDATE_COLUMNS.map((column) => `domain_notices.${column}:UPDATE`),
    'function:atmark_claim_domain_notice:EXECUTE',
    // --- 격리 알림(202610071000, ADR-0016 2026-10-07) — 알림 배출(읽기 칸 · 결말 칸 · 묶인 메일의 검사한 도메인 · 사유). 수신자는 DEFINER 집기 함수
    //   (모듈 SQL 은 owner_email 을 읽지 않는다). 두 표 INSERT · DELETE 0 — 행은 수신 트리거(정의자)만 적는다.
    ...QUARANTINE_NOTICE_APP_READ_COLUMNS.map((column) => `quarantine_notices.${column}:SELECT`),
    ...QUARANTINE_NOTICE_APP_UPDATE_COLUMNS.map((column) => `quarantine_notices.${column}:UPDATE`),
    ...(['inbound_message_id', 'notice_id', 'sender_domain', 'sender_authenticated', 'reason'] as const).map((column) => `quarantine_notice_items.${column}:SELECT`),
    'function:atmark_claim_quarantine_notice:EXECUTE',
    //   틱 대조의 하한(트리거가 생긴 시각 — 202610071000 적용 시각을 굳힌 상수 함수).
    'function:quarantine_notice_started_at:EXECUTE',
    // --- 받기 등급(202610081000, ADR-0016 2026-10-08) — 수신 소비자가 감시 탭 설정을 읽는다(위험 처리 · 위험 알림 · 조직 신뢰 발신자). 쓰기 0 —
    //   설정은 콘솔의 정의자 함수만 바꾼다(앱 롤이 쓸 수 있으면 api 탈취가 자기 조직 신뢰 목록에 공격자를 넣어 탐지를 끈다).
    ...(['agent_id', 'risk_handling', 'risk_notify'] as const).map((column) => `agent_watch_settings.${column}:SELECT`),
    ...(['organization_id', 'kind', 'value', 'removed_at'] as const).map((column) => `org_trusted_senders.${column}:SELECT`),
    // --- 묶음 D(202610081101, ADR-0016 2026-10-08) — 바깥 가입 감지 기록(정의자 — 표 쓰기 0) · 알림기가 자가 등록 창을 그릴 때 읽는 두 칸.
    'function:atmark_record_agent_signup:EXECUTE',
    //   자가 등록 앞 거르개(202610081105 — admin 을 부르기 전 설정 · 하루 상한 · 에이전트당 분당 3). 표 권한 0(정의자).
    'function:atmark_enroll_precheck:EXECUTE',
    ...(['notice_id', 'child_agent_id', 'organization_id', 'created_at'] as const).map((column) => `agent_enrollments.${column}:SELECT`),
    //   발견이 자가 등록 가능 여부를 말한다(조직 설정 두 칸 읽기 — 쓰기 0).
    ...(['organization_id', 'agent_self_enroll', 'enroll_daily_cap'] as const).map((column) => `org_watch_settings.${column}:SELECT`),
    // --- 정책 변경 요청(202610131201, ADR-0007 2026-10-13) — 만들기는 정의자 하나(표 쓰기 0) · 자기 요청 조회 · 알림기가 창을 그릴 때 읽는 칸.
    'function:atmark_policy_request_create:EXECUTE',
    // --- 공유 도메인 조직 평판 자동 동결(202610131620) — SES 이벤트 소비자가 bounce · complaint 뒤 부르는 정의자 하나(판정 · 동결 · 감사, 표 권한 0).
    'function:atmark_platform_reputation_check:EXECUTE',
    //   신고자 해시 보존(202610131612 · 재검증 I-1) — TTL 스위퍼가 8일 넘은 행의 해시를 NULL 로(정의자 하나 · ses_events UPDATE 0).
    'function:atmark_purge_complaint_hashes:EXECUTE',
    ...POLICY_REQUEST_APP_READ_COLUMNS.map((column) => `policy_change_requests.${column}:SELECT`),
    // --- 개발자 표면(202610081200, 묶음 B) — 초안(읽기 · 만들기 · 고칠 칸 · 보내기 표지 — 본문은 S3) · 받은 메일 상태(라벨 · 처음 읽은 시각).
    //   DELETE 0(트리거도 막는다 — 버리기는 discarded_at). 시각 칸(created_at · updated_at)은 트리거가 적는다.
    'drafts:SELECT',
    'drafts:INSERT',
    ...DRAFT_APP_UPDATE_COLUMNS.map((column) => `drafts.${column}:UPDATE`),
    'inbound_message_state:SELECT',
    'inbound_message_state:INSERT',
    'inbound_message_state.labels:UPDATE',
    'inbound_message_state.first_read_at:UPDATE',
    // --- 인젝션 구조 방어(202610041000, ADR-0016) — 노출(읽기 라우트 UPSERT · 위험 신호 로더) · 복사 지문(수신 소비자 INSERT · 발송 DLP SELECT) ·
    //   코드 지문(읽기 라우트 UPSERT · 발송 DLP SELECT). DELETE 0 — 보존은 함수 하나(인자 없음). 등급·시각은 트리거가 앞으로만 민다.
    'agent_exposures:SELECT',
    'agent_exposures:INSERT',
    'agent_exposures.level:UPDATE',
    'agent_exposures.families:UPDATE',
    'agent_exposures.surface:UPDATE',
    'agent_exposures.last_at:UPDATE',
    'agent_exposures.reply_to:UPDATE',
    'inbound_fingerprints:SELECT',
    'inbound_fingerprints:INSERT',
    'agent_code_fingerprints:SELECT',
    'agent_code_fingerprints:INSERT',
    'agent_code_fingerprints.created_at:UPDATE',
    'function:purge_injection_signals:EXECUTE',
    // --- AI 의심 메일 감시(202610061100, ADR-0017 초안 · 경고 전용) — 작업 만들기(식별 칸 셋 — 시각·상태는 기본값) · 읽기(provenance · 같은 작업 찾기).
    //   UPDATE·DELETE 0 — 전송 실패의 skip · 승격 사실(허용 목록 · 토글 · 1시간 수) · 워커 상태는 정의 함수(org_features·ai_watch_runtime 권한 0).
    //   보존은 결과 λ 롤(`atmark_ai_watch`)의 몫.
    'ai_watch_jobs:SELECT',
    ...(['organization_id', 'ses_message_id', 'shadow'] as const).map((column) => `ai_watch_jobs.${column}:INSERT`),
    'function:ai_watch_org_context:EXECUTE',
    'function:ai_watch_worker_healthy:EXECUTE',
    'function:ai_watch_skip_job:EXECUTE',
    // --- 실시간 WebSocket(202610081300, 묶음 E) — 정의 함수만(표 권한 0): 연결 · 끊김 · 핑(실시간 λ) · 받은 메일 대상(수신 소비자) · 승인 대상(승인 링크) ·
    //   스윕(approval-expiry). 대상 함수가 "보이는 메일 · 그 에이전트의 살아 있는 연결" 을 정한다 — 앱 롤이 연결 표를 읽거나 고칠 길은 없다.
    'function:atmark_realtime_connect:EXECUTE',
    'function:atmark_realtime_disconnect:EXECUTE',
    'function:atmark_realtime_seen:EXECUTE',
    'function:atmark_realtime_inbound_targets:EXECUTE',
    'function:atmark_realtime_approval_targets:EXECUTE',
    'function:atmark_realtime_sweep:EXECUTE',
    // --- 대표 주소 포인터 모델(202610021100, ADR-0014 2026-10 개정) — 정책 소스 `usable` · 수신 조회의 잠든 앵커 술어가 마지막 선택을 고르는 칸만.
    ...(['id', 'agent_id', 'address_id', 'created_at'] as const).map((column) => `agent_primary_changes.${column}:SELECT`),
  ],
  [ADMIN_ROLE]: [
    'schema:public:USAGE',
    'owner_login_requests:SELECT',
    'owner_login_requests:INSERT',
    'owner_login_links:SELECT',
    'owner_login_links.organization_id:INSERT',
    'owner_login_links.browser_binding:INSERT',
    'owner_login_links.client_key:INSERT',
    'owner_login_links.expires_at:INSERT',
    'owner_login_links.next_attempt_at:INSERT',
    'owner_login_links.used_at:UPDATE',
    // 로그인 코드(202609280100) — 틀린 코드 수 한 칸(+1 씩만 · 가드 트리거). 코드는 저장하지 않는다(로그인 키로 파생).
    'owner_login_links.code_failures:UPDATE',
    // 틀린 코드 원장(202609280102 · 202610101100) — IP 당 시간당 30회 계수(SELECT) · 한 칸 INSERT(시각은 DB). DELETE 없음(보존은 앱 롤의 정의자 함수).
    'login_code_attempts:SELECT',
    'login_code_attempts.client_key:INSERT',
    // 쌍 키(202609290700, L-N1) — 2026-10-10 부터 새 코드는 쓰지 않는다(쌍 상한을 IP 당 틀린 코드 상한으로 바꿨다). 앞 커밋으로 되돌릴 때를 위해 남긴다.
    'login_code_attempts.pair_key:INSERT',
    'owner_sessions:SELECT',
    'owner_sessions.organization_id:INSERT',
    'owner_sessions.login_link_id:INSERT',
    'owner_sessions.token_hash:INSERT',
    'owner_sessions.expires_at:INSERT',
    // 가입 verify 세션(202609240810) — 가입 링크 하나 = 세션 하나.
    'owner_sessions.signup_link_id:INSERT',
    'owner_sessions.revoked_at:UPDATE',
    'owner_actions:INSERT',
    'organizations:SELECT',
    'organizations.owner_paused:UPDATE',
    'agents:SELECT',
    'agents:INSERT',
    'agents.status:UPDATE',
    'agents.suspended_by:UPDATE',
    'agent_keypairs:SELECT',
    'agent_keypairs:INSERT',
    'passports:SELECT',
    'passports:INSERT',
    // 신원 게시 요청(202609241200) — outbox INSERT 세 칸 · 요청·문서 조회(상태 화면). 서명·버전 쓰기 없음.
    'passport_publish_requests:SELECT',
    'passport_publish_requests.agent_id:INSERT',
    'passport_publish_requests.kind:INSERT',
    'passport_publish_requests.requested_by:INSERT',
    'passport_documents:SELECT',
    'agent_addresses:SELECT',
    'agent_addresses:INSERT',
    // --- 메일 기본기 2차 A6(202609270110) — 콘솔 별칭 폐기: 폐기 시각 한 칸(쓰기 1회 · 대표 불가 · DB 가 시각을 적는다 — 가드 트리거).
    'agent_addresses.retired_at:UPDATE',
    'agent_api_keys:SELECT',
    'agent_api_keys:INSERT',
    'agent_api_keys.revoked_at:UPDATE',
    // 토큰 이름 바꾸기(202609250010, 콘솔 v4 D7) — `label` 한 칸. `hint`·`capabilities`·`expires_at` 은 불변(트리거).
    'agent_api_keys.label:UPDATE',
    // 토큰 한 개 폐기·이름 바꾸기 감사 상세(202609250010 ⑤) — 어느 토큰인가 · 이름 전·후. 적기만(append-only).
    'agent_api_key_events:INSERT',
    'agent_policies:SELECT',
    'agent_policies:INSERT',
    'agent_policies.outbound_mode:UPDATE',
    'agent_policies.limits:UPDATE',
    'agent_policies.config_json:UPDATE',
    'agent_policies.current_version:UPDATE',
    // 정책 v2(202609241010·1020) — 수신 모드 · 연락처 목록 편집(`admin/ops/rules.ts`). INSERT 는 칸 단위(id·created_at 은 DB).
    'agent_policies.inbound_mode:UPDATE',
    'agent_contact_rules:SELECT',
    'agent_contact_rules.agent_id:INSERT',
    'agent_contact_rules.direction:INSERT',
    'agent_contact_rules.list:INSERT',
    'agent_contact_rules.kind:INSERT',
    'agent_contact_rules.value:INSERT',
    'agent_contact_rules.created_by:INSERT',
    // 지우기는 표시(202609241020) — DELETE 0(ADR-0006). 두 칸 한 번만(트리거).
    'agent_contact_rules.removed_at:UPDATE',
    'agent_contact_rules.removed_by:UPDATE',
    'policy_versions:SELECT',
    'policy_versions:INSERT',
    'sender_relationships:SELECT',
    'sender_relationships:INSERT',
    'sender_marks:SELECT',
    'sender_marks:INSERT',
    'approval_requests:SELECT',
    'approval_request_items:SELECT',
    'messages:SELECT',
    'ac0_gates:SELECT',
    'ac0_gates:INSERT',
    'ac0_gate_events:SELECT',
    'ac0_gate_events:INSERT',
    'human_mailbox_interventions:SELECT',
    'human_mailbox_interventions:INSERT',
    'inbound_messages:SELECT',
    'outbound_recipients:SELECT',
    'ses_events:SELECT',
    // --- 메일 기본기 1차 · W1 표지(202609260120) — 콘솔 예약 로그(`GET /api/logs?type=scheduled`)가 보여 주는 칸만 SELECT.
    ...['id', 'agent_id', 'status', 'send_at', 'recipients', 'from_address', 'created_at', 'dispatched_at', 'dispatch_outcome', 'message_id', 'cancelled_at', 'cancel_reason_code', 'cancel_note', 'cancelled_via', 'agent_cancellable'].map((column) => `scheduled_sends.${column}:SELECT`),
    // --- 메일 기본기 1차 2회차 · Y2(202609260125) — 콘솔 예약 취소. 표 쓰기 권한은 0 그대로, 정의자 함수 하나(경로 리터럴 `console` ·
    //   `scheduled → cancelled` 만 · 세션 조직의 예약만). 칼럼 UPDATE 를 주면 경로 위조(`http`·`mcp`)와 에이전트 상한 소모가 열린다.
    'function:console_cancel_scheduled_send:EXECUTE',
    // 에이전트 삭제(202610131000) — 삭제한(disabled) 에이전트의 대기 예약을 한 번에 취소하는 정의자 함수(같은 경로 리터럴 `console`).
    'function:console_cancel_agent_scheduled_sends:EXECUTE',
    // 콘솔 로그 API(202609241100, `admin/routes/logs.ts`) — 화면이 보여 줄 칸만. 추적 id·승인자·세션 id·원문 위치·내부 오류 문장 없음.
    'audit_logs.id:SELECT',
    'audit_logs.message_id:SELECT',
    'audit_logs.decision:SELECT',
    'audit_logs.reasons:SELECT',
    'audit_logs.policy_version:SELECT',
    'audit_logs.evaluated_at:SELECT',
    'audit_logs.resolved_at:SELECT',
    'audit_logs.resolution_reason:SELECT',
    'audit_logs.approval_id:SELECT',
    'audit_logs.created_at:SELECT',
    'owner_actions.id:SELECT',
    'owner_actions.organization_id:SELECT',
    'owner_actions.action:SELECT',
    'owner_actions.target_id:SELECT',
    'owner_actions.created_at:SELECT',
    'inbound_rejections.id:SELECT',
    'inbound_rejections.reason:SELECT',
    'inbound_rejections.envelope_recipients:SELECT',
    'inbound_rejections.spam_verdict:SELECT',
    'inbound_rejections.virus_verdict:SELECT',
    'inbound_rejections.received_at:SELECT',
    // 셀프 가입(202609240800) — 요청 원장 · 링크 INSERT(요청 행 여섯 칸) · 읽기(결속·outbox 제외) · 조직 생성은 함수로만.
    //   `organizations` INSERT 는 여전히 없다 — `create_signup_organization`(SECURITY DEFINER)이 링크를 소비하면서만 만든다.
    'signup_requests:SELECT',
    'signup_requests:INSERT',
    'signup_links.email:INSERT',
    'signup_links.organization_name:INSERT',
    'signup_links.browser_binding:INSERT',
    'signup_links.client_key:INSERT',
    'signup_links.expires_at:INSERT',
    'signup_links.next_attempt_at:INSERT',
    // 가입 언어(202609301510) — 환영 메일의 언어. 요청 행과 함께 적기만 한다.
    'signup_links.lang:INSERT',
    'signup_links.id:SELECT',
    'signup_links.email:SELECT',
    'signup_links.organization_name:SELECT',
    'signup_links.client_key:SELECT',
    'signup_links.created_at:SELECT',
    'signup_links.expires_at:SELECT',
    'signup_links.used_at:SELECT',
    'signup_links.organization_id:SELECT',
    // 가입 코드(202609280100) — 결속으로 후보 링크를 찾는다(결속 · 발송 상태 · 틀린 수) · 틀린 수 한 칸 UPDATE(+1 씩만).
    'signup_links.browser_binding:SELECT',
    'signup_links.status:SELECT',
    'signup_links.code_failures:SELECT',
    'signup_links.code_failures:UPDATE',
    'function:create_signup_organization:EXECUTE',
    // 대기자 명단(202609301520) — 등록(멱등 · 무엇을 했는지 돌려주지 않는다)과 "초대가 살아 있나" 참/거짓 하나. 표 권한 0.
    'function:waitlist_join:EXECUTE',
    'function:waitlist_invite_live:EXECUTE',
    // 투명성 로그(202609241600, ADR-0008) — 무결성 패널·증명·번들. 읽기만(쓰기 0). 솔트 키는 번들에 소유자 조직 것만 싣는다(코드의 조직 범위).
    'tlog_logs:SELECT',
    'tlog_leaves:SELECT',
    'tlog_epochs:SELECT',
    'tlog_org_heads:SELECT',
    'tlog_anchors:SELECT',
    'tlog_keys:SELECT',
    'tlog_salt_keys.org_log_id:SELECT',
    'tlog_salt_keys.salt_key:SELECT',
    'tlog_salt_keys.shredded_at:SELECT',
    // 번들의 원천 대조 — 메시지 행이 없는 감사 행(Stage 0 거부)도 조직으로 고른다.
    'audit_logs.agent_id:SELECT',
    // 신원 잎 보강(202609242300) — 번들의 identity_since(M2) · 블록 API 조직당 분당 상한 원장(L1, 적고 세기만 — DELETE 없음).
    'tlog_identity_since:SELECT',
    'tlog_identity_block_requests:SELECT',
    'tlog_identity_block_requests:INSERT',
    // 사용자·멤버십(202609250100, 확장성 P0 R-1) — 멤버십 INSERT 는 없다(SECURITY DEFINER 함수 셋만 만든다: 조직 INSERT 트리거 ·
    //   create_member_organization · accept_org_invite). 역할 변경·제거는 두 칸 UPDATE(마지막 owner·주 소유자 가드는 DB 트리거).
    'users:SELECT',
    'users.last_organization_id:UPDATE',
    // 시스템 메일 언어(202610101000) — 본인 설정 한 칸 · 가입 확정이 가입 언어를 한 번 옮긴다(가입 링크의 언어 읽기).
    'users.mail_locale:UPDATE',
    'signup_links.lang:SELECT',
    'memberships:SELECT',
    'memberships.role:UPDATE',
    'memberships.removed_at:UPDATE',
    // 세션·로그인 링크의 사용자 결속(202609250110) — 조직 전환 = 새 세션 행(부모 폐기) · 기존 사용자의 새 조직은 함수로만.
    'owner_sessions.user_id:INSERT',
    'owner_sessions.switched_from_session_id:INSERT',
    'owner_login_links.user_id:INSERT',
    'owner_login_links.invite_id:INSERT',
    'function:create_member_organization:EXECUTE',
    // 초대(202609250120, P1) — 요청 칸 INSERT · 발송 칸 제외 읽기 · 취소 한 칸 · 초대 대상 사용자 행(주소 하나) · 수락은 함수로만.
    'org_invites.organization_id:INSERT',
    'org_invites.user_id:INSERT',
    'org_invites.role:INSERT',
    'org_invites.invited_by_user_id:INSERT',
    'org_invites.expires_at:INSERT',
    'org_invites.next_attempt_at:INSERT',
    'org_invites.id:SELECT',
    'org_invites.organization_id:SELECT',
    'org_invites.user_id:SELECT',
    'org_invites.role:SELECT',
    'org_invites.invited_by_user_id:SELECT',
    'org_invites.created_at:SELECT',
    'org_invites.expires_at:SELECT',
    'org_invites.accepted_at:SELECT',
    'org_invites.revoked_at:SELECT',
    'org_invites.revoked_at:UPDATE',
    'membership_events:SELECT',
    'membership_events:INSERT',
    'users.email:INSERT',
    'function:accept_org_invite:EXECUTE',
    // --- WP-B: 조직 API 키(202609250150·0160, 확장성 P1 R-6) — 인증은 해시로 조회(SELECT) · 발급 칸 INSERT · 이름·마지막 사용·폐기 UPDATE.
    //   감사 행위자 종류(세션|키)는 org_api_key_id 한 칸으로 가른다(콘솔 로그·검증 번들). 세션 행위의 사용자 주소는 함수로만(0170 —
    //   admin 은 owner_actions.session_id 를 읽지 않는다).
    'org_api_keys:SELECT',
    'org_api_keys.organization_id:INSERT',
    'org_api_keys.label:INSERT',
    'org_api_keys.hint:INSERT',
    'org_api_keys.token_hash:INSERT',
    'org_api_keys.capabilities:INSERT',
    'org_api_keys.created_by_user_id:INSERT',
    'org_api_keys.expires_at:INSERT',
    'org_api_keys.rotated_from_id:INSERT',
    'org_api_keys.label:UPDATE',
    'org_api_keys.last_used_at:UPDATE',
    'org_api_keys.revoked_at:UPDATE',
    'owner_actions.org_api_key_id:SELECT',
    // 운영자 · 시스템 행위자(202610131610) — 콘솔 로그가 행위자 종류(운영자 · 자동 보호)만 가른다(문자열은 화면에 보내지 않는다).
    'owner_actions.operator_actor:SELECT',
    'function:owner_action_actor_emails:EXECUTE',
    // --- L5: /org-api 조직별 요청 상한(202609250200, ADR-0010 후속 L5) — 키 × 분 창 upsert(INSERT 네 칸 · UPDATE n) + 같은 문장의
    //   조직 합·RETURNING(SELECT). 가드 트리거가 "지금 창 · 1 씩만" 을 강제한다. DELETE 없음(보존은 SECURITY DEFINER 함수).
    'org_api_request_windows:SELECT',
    'org_api_request_windows.org_api_key_id:INSERT',
    'org_api_request_windows.organization_id:INSERT',
    'org_api_request_windows.window_start:INSERT',
    'org_api_request_windows.n:INSERT',
    'org_api_request_windows.n:UPDATE',
    // --- 과금 P0(202609250300, ADR-0011) — 콘솔 요금제 화면 · 에이전트·토큰·조직 키 상한 · 검증 번들의 원천 행. **읽기만** — 콘솔은
    //   요금제를 바꾸지 못한다(운영자 CLI · WP-2 billing 롤만). billing_audit 은 0.
    'org_entitlements:SELECT',
    // --- WP-2 결제(202609250400, ADR-0012) — 결제 개요(고객 · 구독의 표시 칸 — 구독 id·가격 id·공급자 시각 없음) · 포털 판단(구독의 공급자·고객
    //   칸 — 공유 고객의 다른 조직 구독이 살아 있는가, H-1) · 체크아웃 기록(INSERT 여섯 칸) · 옛 거래 superseded(status 한 칸 — completed 는
    //   completed_at 이 필요해 admin 이 적지 못한다). 이벤트 원장·reconcile 커서는 0.
    'billing_customers.organization_id:SELECT',
    'billing_customers.provider:SELECT',
    'billing_customers.provider_customer_id:SELECT',
    'billing_customers.environment:SELECT',
    'billing_subscriptions.organization_id:SELECT',
    'billing_subscriptions.environment:SELECT',
    'billing_subscriptions.status:SELECT',
    'billing_subscriptions.plan_code:SELECT',
    'billing_subscriptions.current_period_end:SELECT',
    'billing_subscriptions.scheduled_change_action:SELECT',
    'billing_subscriptions.scheduled_change_at:SELECT',
    'billing_subscriptions.past_due_since:SELECT',
    'billing_subscriptions.provider:SELECT',
    'billing_subscriptions.provider_customer_id:SELECT',
    'billing_checkouts:SELECT',
    'billing_checkouts.organization_id:INSERT',
    'billing_checkouts.provider:INSERT',
    'billing_checkouts.environment:INSERT',
    'billing_checkouts.transaction_id:INSERT',
    'billing_checkouts.plan_code:INSERT',
    'billing_checkouts.created_by_user_id:INSERT',
    'billing_checkouts.status:UPDATE',
    // --- 고객 도메인(202609291100, ADR-0014) — 읽기 · 행 만들기(식별 칸만) · 수동 확인 칸 · 제거 요청. 상태·확인·사가 칸은 틱 롤(보안 M2).
    //   기능 허용 목록·알림은 읽기만. DELETE 는 어디에도 없다.
    'custom_domains:SELECT',
    ...CUSTOM_DOMAIN_ADMIN_INSERT_COLUMNS.map((column) => `custom_domains.${column}:INSERT`),
    ...CUSTOM_DOMAIN_ADMIN_UPDATE_COLUMNS.map((column) => `custom_domains.${column}:UPDATE`),
    'org_features:SELECT',
    'domain_notices:SELECT',
    // --- 격리 알림(202610071000) — 읽기만(도메인 알림과 같은 모양 — 지금 쓰는 화면은 없다).
    'quarantine_notices:SELECT',
    // --- AI 의심 메일 감시(202610061100) — 소유자 토글 한 칸(켜기는 org_features 가드 트리거 · 감사는 owner_actions) · 수신 로그 배지 읽기.
    'organizations.ai_mail_watch_enabled:UPDATE',
    'ai_watch_jobs:SELECT',
    // --- 감시 탭 받기 등급(202610081000, ADR-0016 2026-10-08) — 설정 세 표 읽기 · 보류 목록의 적중 계열(본문 없음) · 쓰기는 정의자 함수 셋뿐(표 쓰기 0):
    //   에이전트 설정 · 신뢰 발신자 목록 · 풀어 주기(+ message.received 웹훅 — 본문은 함수가 이 메일의 것인지 확인한다, 웹훅 표 쓰기 0 그대로).
    'agent_watch_settings:SELECT',
    'org_watch_settings:SELECT',
    'org_trusted_senders:SELECT',
    ...(['inbound_message_id', 'scanner_version', 'family', 'damped'] as const).map((column) => `security_findings.${column}:SELECT`),
    'function:atmark_watch_set_agent:EXECUTE',
    'function:atmark_watch_set_trusted_senders:EXECUTE',
    'function:atmark_watch_release_inbound:EXECUTE',
    // --- 묶음 D(202610081101, ADR-0016 2026-10-08) — 발신 승인(정책 한 칸 — 새 버전과 함께 · 감사는 policy_versions) · 조직 감시 설정(정의자) ·
    //   자가 등록(슬롯 INSERT 칸 셋 · 끝내기 UPDATE 칸 둘 — 판정은 트리거가 다시 본다) · 가입 목록 읽기.
    'agent_policies.require_approval:UPDATE',
    'function:atmark_watch_set_org:EXECUTE',
    'agent_enrollments:SELECT',
    //   요청 id(202610081103 — 재생 방지, UNIQUE).
    ...(['organization_id', 'parent_agent_id', 'parent_token_id', 'request_id'] as const).map((column) => `agent_enrollments.${column}:INSERT`),
    ...(['outcome', 'child_agent_id'] as const).map((column) => `agent_enrollments.${column}:UPDATE`),
    'agent_signups:SELECT',
    // --- 정책 변경 요청(202610131201, ADR-0007 2026-10-13) — 콘솔 목록 · 결정 칸(전이는 트리거). INSERT · DELETE 0 — 만드는 것은 에이전트(앱 롤 정의자)뿐.
    'policy_change_requests:SELECT',
    ...(['status', 'decided_by', 'decided_user_id', 'applied_version', 'stale_reason'] as const).map((column) => `policy_change_requests.${column}:UPDATE`),
    //   위험 경고를 승인 순간의 사실로(적대 검증 G07 · G08) — 마지막 T2 노출 시각 하나(정의자 — 노출 표 권한 0).
    'function:atmark_agent_last_risk_exposure:EXECUTE',
    // 실시간 힌트(202610081300, 묶음 E) — 풀기 뒤 `message.received` 대상 · 410 닫기. 표 권한 0.
    'function:atmark_realtime_inbound_targets:EXECUTE',
    'function:atmark_realtime_disconnect:EXECUTE',
    // --- 대표 주소 포인터 모델(202610021100 · 1101, ADR-0014 2026-10 개정) — 선택 읽기(증명 묶음 · 신원 블록) · 원인 `owner` 선택 세 칸(주소·시각은
    //   트리거가 적는다) · 고객 도메인 대표 프로비저닝(정의자 — `ax--` 앵커를 넣는 유일한 앱 경로).
    'agent_primary_changes:SELECT',
    ...(['agent_id', 'address_id', 'cause'] as const).map((column) => `agent_primary_changes.${column}:INSERT`),
    'function:atmark_provision_custom_primary:EXECUTE',
    // --- W4 표지(202609301410, 2026-09-30) — 콘솔 웹훅 화면. 두 표 읽기 · 쓰기는 정의자 함수 넷(등록 · 회전 · 재전송 · 삭제)뿐 — 두 표 INSERT·
    //   UPDATE·DELETE 0(보안 M2 — admin 이 outbox 에 임의 본문을 넣으면 디스패처가 서명해 보낸다; 가드 트리거가 직접 쓰기를 한 번 더 막는다) ·
    //   회전 원장 0 · 콘솔 시크릿 발급 확인 함수 0(그것은 api λ 몫 — 보안 M1) · 발급 원장(`webhook_console_secret_issues`) 0 · 감사 상세
    //   INSERT(칸 단위, 보안 L2). 전달은 `body` 를 뺀 칸만 읽는다(재검토 L-3 — 이벤트 원문은 콘솔에 나가지 않는다; 재전송 정의자 함수가 소유자로 복사한다).
    'webhook_endpoints:SELECT',
    ...ADMIN_WEBHOOK_DELIVERY_READ_COLUMNS.map((column) => `webhook_deliveries.${column}:SELECT`),
    'function:register_webhook_endpoint:EXECUTE',
    'function:disable_webhook_endpoint:EXECUTE',
    'function:rotate_webhook_endpoint_secret:EXECUTE',
    'function:redeliver_webhook_delivery:EXECUTE',
    ...['owner_action_id', 'endpoint_id', 'url_host', 'delivery_id', 'new_delivery_id'].map(
      (column) => `webhook_owner_action_details.${column}:INSERT`,
    ),
    // 웹훅 인증 헤더(202610141400) — 콘솔 목록의 힌트(칸 셋 — **봉인값은 읽지 못한다**) · 설정·지우기 정의자 함수 둘. 표 쓰기 0.
    ...(['endpoint_id', 'hint', 'set_at'] as const).map((column) => `webhook_endpoint_authorizations.${column}:SELECT`),
    'function:set_webhook_endpoint_authorization:EXECUTE',
    'function:clear_webhook_endpoint_authorization:EXECUTE',
  ],
  [LOGIN_MAILER_ROLE]: [
    'schema:public:USAGE',
    'owner_login_links.id:SELECT',
    'owner_login_links.organization_id:SELECT',
    'owner_login_links.created_at:SELECT',
    'owner_login_links.expires_at:SELECT',
    'owner_login_links.status:SELECT',
    'owner_login_links.attempt_count:SELECT',
    'owner_login_links.next_attempt_at:SELECT',
    'owner_login_links.claimed_at:SELECT',
    'owner_login_links.status:UPDATE',
    'owner_login_links.attempt_count:UPDATE',
    'owner_login_links.next_attempt_at:UPDATE',
    'owner_login_links.claimed_at:UPDATE',
    'owner_login_links.last_error:UPDATE',
    'owner_login_links.ses_message_id:UPDATE',
    'owner_login_links.sent_at:UPDATE',
    'owner_login_links.settled_at:UPDATE',
    // organizations(id, owner_email) SELECT 는 202609250190 이 거뒀다 — 로그인 메일 수신자는 users.email(ADR-0006 최소 권한).
    // 가입 확인 메일(202609240800) — 발송 컬럼 + 수신자·만료·id. 조직 이름·결속·소비 칸·요청자 키는 읽지 않는다. 억제 목록은
    //   주소 하나의 참/거짓으로만(`signup_email_suppressed`) — 억제 테이블 SELECT 없음.
    'signup_links.id:SELECT',
    'signup_links.email:SELECT',
    'signup_links.created_at:SELECT',
    'signup_links.expires_at:SELECT',
    'signup_links.status:SELECT',
    'signup_links.attempt_count:SELECT',
    'signup_links.next_attempt_at:SELECT',
    'signup_links.claimed_at:SELECT',
    'signup_links.status:UPDATE',
    'signup_links.attempt_count:UPDATE',
    'signup_links.next_attempt_at:UPDATE',
    'signup_links.claimed_at:UPDATE',
    'signup_links.last_error:UPDATE',
    'signup_links.ses_message_id:UPDATE',
    'signup_links.sent_at:UPDATE',
    'signup_links.settled_at:UPDATE',
    'function:signup_email_suppressed:EXECUTE',
    // 시스템 메일 억제(202609240900, 보안 검증 H2) — 로그인 링크 메일도 하드 바운스·불만 주소로는 보내지 않는다(주소 칸 하나).
    'system_mail_suppressions.address:SELECT',
    // 사용자 결속(202609250100·0110) — 로그인 링크 수신자는 링크 → 사용자(`users.email`). 멤버십은 읽지 않는다.
    'users.id:SELECT',
    'users.email:SELECT',
    'owner_login_links.user_id:SELECT',
    // 시스템 메일 언어(202610101000) — 받는 사람의 설정 · 아직 사용자가 없는 가입 확인 메일은 가입 양식 언어.
    'users.mail_locale:SELECT',
    'signup_links.lang:SELECT',
    // 초대 메일(202609250120) — 발송 칸 + 수신자·초대자·만료·id. 조직·역할·수락·취소는 읽지 않는다.
    'org_invites.id:SELECT',
    'org_invites.user_id:SELECT',
    'org_invites.invited_by_user_id:SELECT',
    'org_invites.created_at:SELECT',
    'org_invites.expires_at:SELECT',
    'org_invites.status:SELECT',
    'org_invites.attempt_count:SELECT',
    'org_invites.next_attempt_at:SELECT',
    'org_invites.claimed_at:SELECT',
    'org_invites.status:UPDATE',
    'org_invites.attempt_count:UPDATE',
    'org_invites.next_attempt_at:UPDATE',
    'org_invites.claimed_at:UPDATE',
    'org_invites.last_error:UPDATE',
    'org_invites.ses_message_id:UPDATE',
    'org_invites.sent_at:UPDATE',
    'org_invites.settled_at:UPDATE',
    // 발송 직전 확인(202609250180, 적대적 검토 M3) — 조직 active·미동결 · 초대자 살아 있는 owner 를 참/거짓으로만 묻는다(조직·멤버십 칸은 열지 않는다).
    'function:org_invite_sendable:EXECUTE',
    // 환영 메일(202609301510) — 발송 칸(+ last_error: 'sending' 표식) + 수신자(user_id)·언어·생성 시각·id. 조직 id 는 읽지 않는다. 수신 주소는 위 users(id, email).
    ...selectColumns('welcome_mails', ['id', 'user_id', 'lang', 'created_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error']),
    ...(['status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at'] as const).map(
      (column) => `welcome_mails.${column}:UPDATE`,
    ),
    // --- 호스팅 운영자 콘솔 코드 메일(202609290500) — 도전 outbox 칸 · 수신자(운영자 id·주소·상태) · 다이제스트는 정의 함수로만 한 번(칸 권한 0).
    ...selectColumns('ops_login_challenges', [
      'id',
      'purpose',
      'email',
      'operator_id',
      'action',
      'organization_id',
      'target_operator_id',
      'target_ref',
      'lang',
      'created_at',
      'expires_at',
      'used_at',
      'invalidated_at',
      'status',
      'attempt_count',
      'next_attempt_at',
      'claimed_at',
    ]),
    ...(['status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at'] as const).map(
      (column) => `ops_login_challenges.${column}:UPDATE`,
    ),
    ...selectColumns('ops_operators', ['id', 'email', 'status']),
    'function:ops_mailer_set_digest:EXECUTE',
    // 대기 확인 · 초대 메일(202609301520) — 발송 칸 + 수신 항목의 주소·상태·초대 만료(메모·출처는 읽지 않는다).
    ...selectColumns('waitlist_mails', ['id', 'entry_id', 'kind', 'lang', 'invite_expires_at', 'created_at', 'status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error']),
    ...(['status', 'attempt_count', 'next_attempt_at', 'claimed_at', 'last_error', 'ses_message_id', 'sent_at', 'settled_at'] as const).map(
      (column) => `waitlist_mails.${column}:UPDATE`,
    ),
    ...selectColumns('waitlist_entries', ['id', 'email', 'status', 'invite_expires_at']),
    // 신청서 용도(202609301530) — 확인 메일의 보류 조건부 문단(outreach)만 고른다. 메모·알게 된 곳·ref 는 읽지 않는다.
    'waitlist_entries.use_case:SELECT',
  ],
  // passport 서명(202609241200 ④) — 컬럼 단위. 조직·토큰·메시지 제목/본문·정책은 없다.
  [PASSPORT_SIGNER_ROLE]: [
    'schema:public:USAGE',
    'agents.id:SELECT',
    'agents.name:SELECT',
    'agents.status:SELECT',
    'agents.created_at:SELECT',
    'agent_addresses.agent_id:SELECT',
    'agent_addresses.address:SELECT',
    'agent_addresses.is_primary:SELECT',
    'agent_keypairs.agent_id:SELECT',
    'agent_keypairs.public_key:SELECT',
    'agent_keypairs.algorithm:SELECT',
    'agent_keypairs.key_ref:SELECT',
    'audit_logs.agent_id:SELECT',
    'audit_logs.decision:SELECT',
    'audit_logs.reasons:SELECT',
    // no_policy_violations 의 90일 창(202609241210 ①).
    'audit_logs.created_at:SELECT',
    // 게시 전제 — 조직 검토 판정 불리언 하나(202609241210 ②). 조직 행은 여전히 못 읽는다.
    'function:passport_agent_organization_active:EXECUTE',
    // 여권 주소 = 유효 대표 + domain_verified(202610021202, ADR-0014 2026-10 개정 · F-7) — 결과 두 칸만 주는 정의자 함수. 선택 표 · 도메인 행은 여전히 못 읽는다.
    'function:atmark_agent_primary_view:EXECUTE',
    'messages.agent_id:SELECT',
    'messages.thread_id:SELECT',
    'messages.direction:SELECT',
    'messages.status:SELECT',
    'inbound_messages.agent_id:SELECT',
    'inbound_messages.thread_id:SELECT',
    'passports:SELECT',
    'passports.id:INSERT',
    'passports.agent_id:INSERT',
    'passports.did:INSERT',
    'passports.status:INSERT',
    'passports.controller:INSERT',
    'passports.metadata_uri:INSERT',
    'passports.content_hash:INSERT',
    'passports.version:INSERT',
    'passports.issued_at:INSERT',
    'passports.status:UPDATE',
    'passports.metadata_uri:UPDATE',
    'passports.content_hash:UPDATE',
    'passports.superseded_at:UPDATE',
    'passport_documents:SELECT',
    'passport_documents:INSERT',
    'passport_publish_requests:SELECT',
    'passport_publish_requests.agent_id:INSERT',
    'passport_publish_requests.kind:INSERT',
    'passport_publish_requests.requested_by:INSERT',
    'passport_publish_requests.status:UPDATE',
    'passport_publish_requests.next_attempt_at:UPDATE',
    'passport_publish_requests.attempt_count:UPDATE',
    'passport_publish_requests.last_error:UPDATE',
    'passport_publish_requests.passport_id:UPDATE',
    'passport_publish_requests.outcome:UPDATE',
    'passport_publish_requests.outcome_reason:UPDATE',
    'passport_publish_requests.signed_at:UPDATE',
    'passport_publish_requests.completed_at:UPDATE',
  ],
  // 투명성 로그 서열기·에폭·게시(202609241600 ⑦) — 컬럼 단위. 원천은 잎에 필요한 칸만(주소·Message-ID·세션·스냅샷은 커밋으로만 잎에 간다).
  [TLOG_ROLE]: [
    'schema:public:USAGE',
    'tlog_outbox:SELECT',
    'tlog_outbox.processed_at:UPDATE',
    'tlog_outbox.snapshot:UPDATE',
    'tlog_logs:SELECT',
    'tlog_logs:INSERT',
    'tlog_salt_keys:SELECT',
    'tlog_salt_keys.org_log_id:INSERT',
    'tlog_salt_keys.salt_key:INSERT',
    'tlog_leaves:SELECT',
    'tlog_leaves.org_log_id:INSERT',
    'tlog_leaves.seq:INSERT',
    'tlog_leaves.kind:INSERT',
    'tlog_leaves.source_table:INSERT',
    'tlog_leaves.source_id:INSERT',
    'tlog_leaves.event:INSERT',
    'tlog_leaves.rev:INSERT',
    'tlog_leaves.outbox_id:INSERT',
    'tlog_leaves.leaf_json:INSERT',
    'tlog_leaves.leaf_hash:INSERT',
    'tlog_keys:SELECT',
    'tlog_keys.key_id:INSERT',
    'tlog_keys.purpose:INSERT',
    'tlog_keys.public_key:INSERT',
    'tlog_epochs:SELECT',
    'tlog_epochs.epoch:INSERT',
    'tlog_epochs.closed_at:INSERT',
    'tlog_epochs.epoch_root:INSERT',
    'tlog_epochs.org_count:INSERT',
    'tlog_epochs.global_leaf:INSERT',
    'tlog_epochs.global_leaf_hash:INSERT',
    'tlog_epochs.global_root:INSERT',
    'tlog_epochs.checkpoint:INSERT',
    'tlog_epochs.key_id:INSERT',
    'tlog_epochs.published_at:UPDATE',
    'tlog_org_heads:SELECT',
    'tlog_org_heads:INSERT',
    'audit_logs.id:SELECT',
    'audit_logs.agent_id:SELECT',
    'audit_logs.message_id:SELECT',
    'audit_logs.reasons:SELECT',
    'audit_logs.policy_version:SELECT',
    'audit_logs.approval_id:SELECT',
    'audit_logs.evaluated_at:SELECT',
    'messages.id:SELECT',
    'messages.message_id_header:SELECT',
    'outbound_recipients.message_id:SELECT',
    'outbound_recipients.address:SELECT',
    'owner_actions.id:SELECT',
    'owner_actions.session_id:SELECT',
    'owner_actions.action:SELECT',
    'owner_actions.target_id:SELECT',
    'owner_actions.created_at:SELECT',
    'policy_versions.id:SELECT',
    'policy_versions.agent_id:SELECT',
    'policy_versions.version:SELECT',
    'policy_versions.outbound_mode:SELECT',
    'policy_versions.inbound_mode:SELECT',
    'policy_versions.snapshot:SELECT',
    'policy_versions.created_at:SELECT',
    'inbound_messages.id:SELECT',
    'inbound_messages.agent_id:SELECT',
    'inbound_messages.quarantined:SELECT',
    'inbound_messages.quarantine_reason:SELECT',
    'inbound_messages.policy_reason:SELECT',
    'inbound_messages.from_authenticated:SELECT',
    'inbound_messages.from_address:SELECT',
    'inbound_messages.message_id_header:SELECT',
    'inbound_messages.received_at:SELECT',
    // 신원 잎(202609242200, US-013) — 잎에 필요한 칸만. 이름은 outbox 스냅샷으로 온다(agents.name 없음) · 주소는 커밋으로만 잎에 간다.
    'agents.id:SELECT',
    'agents.created_at:SELECT',
    'agent_addresses.id:SELECT',
    'agent_addresses.agent_id:SELECT',
    'agent_addresses.address:SELECT',
    'agent_addresses.is_primary:SELECT',
    'agent_addresses.created_at:SELECT',
    // --- 메일 기본기 2차 tlog v4(202609270115) — identity.address_retired 잎의 at.
    'agent_addresses.retired_at:SELECT',
    'agent_keypairs.agent_id:SELECT',
    'agent_keypairs.public_key:SELECT',
    'agent_keypairs.algorithm:SELECT',
    'agent_keypairs.created_at:SELECT',
    'passport_documents.passport_id:SELECT',
    'passport_documents.created_at:SELECT',
    'passports.id:SELECT',
    'passports.agent_id:SELECT',
    'passports.version:SELECT',
    'passports.status:SELECT',
    'passports.content_hash:SELECT',
    // --- WP-B: 감사 행위자 종류(202609250160) — 조직 키 행위는 잎에 c.api_key 커밋(세션 행위는 c.session).
    'owner_actions.org_api_key_id:SELECT',
    // --- 운영자 · 시스템 행위자(202610131610) — 잎의 c.operator 커밋 재료(평문 없음).
    'owner_actions.operator_actor:SELECT',
    'owner_actions.operator_reason:SELECT',
    //   서열기 능력 기록(적대 검토 M-1) — 틱마다 정의자 하나(표 권한 0). DB 는 이 능력이 적힌 뒤에만 운영자 행위자 행을 받는다.
    'function:atmark_tlog_record_capabilities:EXECUTE',
    // --- 과금 P0(202609250300) — billing.entitlement 잎: 원천 행이 있는지만(값은 outbox 스냅샷).
    'org_entitlements.organization_id:SELECT',
    // --- 고객 도메인(202609291130, ADR-0014) — domain.status 잎: 행이 있는지 · 도메인 이름(커밋 재료). 상태 값은 outbox 스냅샷.
    'custom_domains.id:SELECT',
    'custom_domains.domain:SELECT',
    // --- 대표 주소 선택(202610021110, ADR-0014 2026-10 개정) — identity.primary_set 잎: 에이전트 · 원인 · 주소(커밋 재료) · 시각.
    ...(['id', 'agent_id', 'address', 'cause', 'created_at'] as const).map((column) => `agent_primary_changes.${column}:SELECT`),
  ],
  // 외부 앵커(202609241600 ⑦) — 체크포인트를 읽고 앵커 행만 쓴다. 잎·원천·솔트 0.
  [TLOG_ANCHOR_ROLE]: [
    'schema:public:USAGE',
    'tlog_epochs.epoch:SELECT',
    'tlog_epochs.closed_at:SELECT',
    'tlog_epochs.checkpoint:SELECT',
    'tlog_epochs.published_at:SELECT',
    'tlog_anchors:SELECT',
    'tlog_anchors.epoch:INSERT',
    'tlog_anchors.target:INSERT',
    'tlog_anchors.endpoint:INSERT',
    'tlog_anchors.digest:INSERT',
    'tlog_anchors.state:UPDATE',
    'tlog_anchors.attempt_count:UPDATE',
    'tlog_anchors.next_attempt_at:UPDATE',
    'tlog_anchors.last_error:UPDATE',
    'tlog_anchors.receipt:UPDATE',
    'tlog_anchors.receipt_at:UPDATE',
    'tlog_anchors.upgraded:UPDATE',
    'tlog_anchors.confirmed_at:UPDATE',
    'tlog_keys:SELECT',
    'tlog_keys.key_id:INSERT',
    'tlog_keys.purpose:INSERT',
    'tlog_keys.public_key:INSERT',
  ],
  // 결제 동기화(202609250400 ⑦) — 컬럼 단위. `billing_audit` 은 INSERT 만(SELECT 없음 — 감사 짝 검사는 definer 트리거) · `tlog_outbox` 0(잎은
  //   definer `tlog_enqueue`) · `organizations.billing_status` UPDATE 없음(유예는 엔타이틀먼트 grace_until 로만, 계획 §3-4).
  [BILLING_ROLE]: [
    'schema:public:USAGE',
    'billing_events:SELECT',
    ...(['provider', 'event_id', 'event_type', 'occurred_at', 'notification_id', 'environment', 'payload_sha256', 'subscription_id', 'transaction_id'] as const).map(
      (column) => `billing_events.${column}:INSERT`,
    ),
    ...(['status', 'attempts', 'last_error', 'processed_at'] as const).map((column) => `billing_events.${column}:UPDATE`),
    'billing_customers:SELECT',
    ...(['organization_id', 'provider', 'provider_customer_id', 'environment'] as const).map((column) => `billing_customers.${column}:INSERT`),
    'billing_subscriptions:SELECT',
    ...(['provider', 'provider_subscription_id', 'environment', 'organization_id', 'provider_customer_id', 'origin_transaction_id'] as const).map(
      (column) => `billing_subscriptions.${column}:INSERT`,
    ),
    ...(
      [
        'status',
        'plan_code',
        'price_id',
        'current_period_end',
        'scheduled_change_action',
        'scheduled_change_at',
        'past_due_since',
        'provider_updated_at',
        'synced_at',
      ] as const
    ).flatMap((column) => [`billing_subscriptions.${column}:INSERT`, `billing_subscriptions.${column}:UPDATE`]),
    ...(['organization_id', 'environment', 'transaction_id', 'status'] as const).map((column) => `billing_checkouts.${column}:SELECT`),
    'billing_checkouts.status:UPDATE',
    'billing_checkouts.completed_at:UPDATE',
    'billing_reconcile_state:SELECT',
    'billing_reconcile_state:INSERT',
    ...(['run_id', 'phase', 'paddle_cursor', 'org_cursor', 'started_at', 'updated_at', 'completed_at'] as const).map(
      (column) => `billing_reconcile_state.${column}:UPDATE`,
    ),
    ...ENTITLEMENT_WRITE_GRANTS,
    ...(['organization_id', 'from_plan', 'to_plan', 'cause', 'actor', 'provider_event_id', 'note', 'entitlement_version'] as const).map(
      (column) => `billing_audit.${column}:INSERT`,
    ),
    'organizations.id:SELECT',
    // --- 고객 도메인(202609291110, ADR-0014 §3.15) — Paddle 청구 이메일이 에이전트 주소인가(해시 대조 불리언) · 조직 표시 한 칸.
    'function:atmark_is_agent_mail_identity:EXECUTE',
    'organizations.billing_email_is_agent:UPDATE',
  ],
  // 결제 운영자 CLI(202609250400 ⑦) — `admin:plan` 의 보기(`planUsageOp`: 에이전트 수 · 활성 토큰 · 활성 조직 키 · 24시간 수신자 · 워밍업 기준일 ·
  //   엔타이틀먼트 행) · operator 행 쓰기 · 감사 INSERT(provider_event_id 없음) · 샌드박스 공급자 행 찾기. 이메일·본문·해시 칸 0.
  [BILLING_OPERATOR_ROLE]: [
    'schema:public:USAGE',
    'organizations.id:SELECT',
    'organizations.sending_started_at:SELECT',
    ...ENTITLEMENT_WRITE_GRANTS,
    ...(['organization_id', 'from_plan', 'to_plan', 'cause', 'actor', 'note', 'entitlement_version'] as const).map((column) => `billing_audit.${column}:INSERT`),
    'agents.id:SELECT',
    'agents.organization_id:SELECT',
    'agents.status:SELECT',
    'agent_api_keys.agent_id:SELECT',
    'agent_api_keys.revoked_at:SELECT',
    'agent_api_keys.expires_at:SELECT',
    // 메일 기본기 2차 A6(202609270110) — 요금제 화면의 별칭 초과 수(`countAgentsOverAliasLimit`). 주소 원문은 0.
    'agent_addresses.agent_id:SELECT',
    'agent_addresses.is_primary:SELECT',
    'agent_addresses.retired_at:SELECT',
    'org_api_keys.organization_id:SELECT',
    'org_api_keys.revoked_at:SELECT',
    'org_api_keys.expires_at:SELECT',
    ...(['agent_id', 'direction', 'status', 'recipient_count', 'sent_at', 'created_at'] as const).map((column) => `messages.${column}:SELECT`),
    'billing_subscriptions.organization_id:SELECT',
    'billing_subscriptions.environment:SELECT',
    'billing_subscriptions.status:SELECT',
  ],
  // 호스팅 운영자 콘솔(202609290500·0510) — 읽기는 칸 단위(토큰·UA 해시 · 요청자 키 · 다이제스트 · 결속 · 솔트 0), 쓰기 0, EXECUTE 는 계약의
  //   인증·행위 정의 함수뿐(코어·티켓·내부 함수 0 — status 검사 3).
  [OPS_ROLE]: [
    'schema:public:USAGE',
    ...[
      'ops_request_code',
      'ops_login_verify',
      'ops_session_touch',
      'ops_session_revoke',
      'ops_request_stepup',
      'ops_stepup_verify',
      'ops_decide_request',
      'ops_revoke_operator',
      'ops_record_failure',
      'ops_org_activate',
      'ops_org_reject',
      // 대기자 명단(202609301520) — 초대 · N 명 초대 · 지우기(콘솔 열림 → 세션 → 소유자 코어).
      'ops_waitlist_invite',
      'ops_waitlist_invite_oldest',
      'ops_waitlist_remove',
      // 주간 운영판(202610010900) — 읽기 전용 집계(건수 · 조직 id). 개인 정보 칸은 GRANT 하지 않고 이 함수로만 센다.
      'ops_weekly_board',
    ].map((name) => `function:${name}:EXECUTE`),
    // 긴급 정지 목록의 에이전트 주소 = 유효 대표(202610021202, ADR-0014 2026-10 개정) — 결과 두 칸만 주는 정의자 함수(선택 표 · 도메인 행 권한 0).
    'function:atmark_agent_primary_view:EXECUTE',
    // ops 표 — 호스팅 읽기(감사 · 운영자 탭)가 보내는 칸만. 세션·설정·사건 원장은 0(세션 확인은 정의 함수로만).
    ...selectColumns('ops_operators', ['id', 'email', 'status', 'origin', 'requested_at', 'decided_at', 'created_at']),
    ...selectColumns('ops_actions', ['id', 'kind', 'result', 'operator_id', 'action', 'organization_id', 'agent_id', 'target_operator_id', 'code', 'created_at']),
    ...selectColumns('ops_action_effects', ['action_id', 'table_name', 'op']),
    ...selectColumns('organizations', [
      'id',
      'name',
      'owner_email',
      'review_status',
      'signup_source',
      'reviewed_at',
      'abuse_freeze',
      'owner_paused',
      'billing_status',
      'sending_started_at',
      'created_at',
      'updated_at',
    ]),
    ...selectColumns('agents', ['id', 'organization_id', 'name', 'status', 'suspended_by', 'created_at', 'updated_at']),
    ...selectColumns('agent_addresses', ['agent_id', 'address', 'is_primary', 'retired_at']),
    ...selectColumns('agent_api_keys', ['agent_id', 'revoked_at', 'expires_at', 'last_used_at']),
    ...selectColumns('passports', ['agent_id', 'status', 'superseded_at']),
    ...selectColumns('agent_keypairs', ['agent_id', 'public_key']),
    ...selectColumns('agent_policies', ['agent_id', 'current_version']),
    ...selectColumns('policy_versions', ['agent_id', 'version', 'outbound_mode', 'inbound_mode']),
    'org_entitlements:SELECT',
    ...selectColumns('org_api_keys', ['id', 'organization_id', 'label', 'revoked_at', 'expires_at']),
    ...selectColumns('memberships', ['id', 'organization_id', 'user_id', 'role', 'joined_via', 'created_at', 'removed_at']),
    ...selectColumns('users', ['id', 'email']),
    ...selectColumns('billing_subscriptions', [
      'organization_id',
      'environment',
      'status',
      'plan_code',
      'current_period_end',
      'scheduled_change_action',
      'scheduled_change_at',
      'past_due_since',
      'synced_at',
    ]),
    ...selectColumns('billing_audit', ['id', 'organization_id', 'from_plan', 'to_plan', 'cause', 'actor', 'note', 'entitlement_version', 'created_at']),
    ...selectColumns('owner_actions', ['id', 'organization_id', 'session_id', 'org_api_key_id', 'action', 'target_id', 'created_at', 'operator_actor', 'operator_reason']),
    ...selectColumns('owner_sessions', ['id', 'user_id']),
    ...selectColumns('messages', ['agent_id', 'created_at', 'direction', 'status', 'recipient_count', 'sent_at']),
    // 대기자 명단(202609301520) — `readWaitlist` 가 보내는 칸만(마지막 확인 메일 시각은 읽지 않는다).
    ...selectColumns('waitlist_entries', ['id', 'email', 'lang', 'note', 'source', 'status', 'created_at', 'invited_at', 'invite_expires_at', 'joined_at', 'invited_by']),
    // 신청서 세 칸(202609301530) — 용도 · 알게 된 곳 · ref(등급 후보 표시).
    ...selectColumns('waitlist_entries', ['use_case', 'heard_from', 'ref']),
    ...selectColumns('waitlist_events', ['id', 'entry_id', 'action', 'actor', 'created_at']),
  ],
  // 고객 도메인 확인 틱(202609291100, ADR-0014 · 보안 M2) — 상태·확인·사가 칸 · 알림 적기 · 정책 주소·요금제·조직 상태 읽기. 단계 0 에서는 NOLOGIN.
  [DOMAIN_TICK_ROLE]: [
    'schema:public:USAGE',
    'custom_domains:SELECT',
    ...CUSTOM_DOMAIN_TICK_UPDATE_COLUMNS.map((column) => `custom_domains.${column}:UPDATE`),
    'org_features:SELECT',
    'domain_notices:SELECT',
    ...(['domain_id', 'organization_id', 'kind', 'event_key'] as const).map((column) => `domain_notices.${column}:INSERT`),
    ...(['agent_id', 'address', 'domain', 'is_primary', 'retired_at'] as const).map((column) => `agent_addresses.${column}:SELECT`),
    'agents.id:SELECT',
    'agents.organization_id:SELECT',
    'organizations.id:SELECT',
    'organizations.review_status:SELECT',
    ...(['organization_id', 'plan_code', 'grace_until'] as const).map((column) => `org_entitlements.${column}:SELECT`),
    // 평판 동결 집계(202610021103, ADR-0014 결정 14 — `src/domains/reputation.ts`): 도메인별 전달 시도·bounce·complaint · 계정 전체 전달 시도.
    ...(['message_id', 'event_type', 'received_at', 'bounce_type'] as const).map((column) => `ses_events.${column}:SELECT`),
    ...(['id', 'agent_id', 'from_domain'] as const).map((column) => `messages.${column}:SELECT`),
  ],
  // AI 의심 메일 감시 결과 λ(202610061100, ADR-0017 초안) — 판정·하트비트 정의 함수 둘뿐. 표 권한 0 — Mac 이 탈취돼도 결과 큐 → 이 롤이 닿는 곳은
  //   "pending 작업에 판정 하나" 와 "하트비트 한 행" 이다(설계 §1.3).
  [AI_WATCH_ROLE]: [
    'schema:public:USAGE',
    'function:ai_watch_record_verdict:EXECUTE',
    'function:ai_watch_record_heartbeat:EXECUTE',
    // 보존(90일) — 하트비트마다. 판정 쪽 TTL 스위퍼(approval-expiry)에 감시 SQL 을 들이지 않으려고 여기 둔다(arch ai-watch-boundary ①).
    'function:purge_ai_watch_jobs:EXECUTE',
    // 실시간 힌트(202610081300, 묶음 E) — 판정이 보류를 풀면 그 작업의 메일 대상 · 410 닫기(`ai_watch_apply_role_grants()` 가 준다). 표 권한 0.
    'function:atmark_realtime_job_targets:EXECUTE',
    'function:atmark_realtime_disconnect:EXECUTE',
  ],
};

/** 제한 롤 하나의 실제 권한·소유·속성. `problems` 가 비어 있어야 한다. */
export interface RestrictedRoleReport {
  readonly role: string;
  readonly exists: boolean;
  /** 실제 권한(허용 목록과 같은 표기, 정렬). */
  readonly grants: readonly string[];
  /** 위반 항목 — 허용 목록 밖 권한·소유 객체·멤버십·위험 속성. 값(비밀)은 없다. */
  readonly problems: readonly string[];
}

/**
 * 제한 롤의 실제 권한을 카탈로그(ACL)에서 읽어 허용 목록과 대조한다. **읽기만 한다.**
 * 본다: 스키마·테이블·컬럼·시퀀스 ACL(PUBLIC 경유 제외 — 롤 이름으로 받은 것), 함수 EXECUTE(직접 부여만), 소유한 객체
 * (릴레이션·함수·타입·스키마), 다른 롤의 멤버십, 슈퍼유저·CREATEROLE·CREATEDB·BYPASSRLS·REPLICATION.
 */
export async function inspectRestrictedRole(
  client: Pick<PoolClient, 'query'>,
  role: keyof typeof RESTRICTED_ROLE_GRANTS,
): Promise<RestrictedRoleReport> {
  const found = await client.query<{
    oid: number;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolconnlimit: number;
  }>(
    'SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolconnlimit FROM pg_roles WHERE rolname = $1',
    [role],
  );
  const attributes = found.rows[0];
  if (attributes === undefined) return { role, exists: false, grants: [], problems: [`롤 ${role} 이 없다`] };

  const grants = await client.query<{ grant: string }>(
    `SELECT 'schema:' || n.nspname || ':' || a.privilege_type AS grant
       FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = $1
     UNION
     SELECT c.relname || ':' || a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE a.grantee = $1 AND c.relnamespace = 'public'::regnamespace
     UNION
     SELECT c.relname || '.' || att.attname || ':' || a.privilege_type
       FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
      WHERE a.grantee = $1 AND c.relnamespace = 'public'::regnamespace AND att.attnum > 0 AND NOT att.attisdropped
     UNION
     SELECT 'function:' || p.proname || ':' || a.privilege_type
       FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = $1`,
    [attributes.oid],
  );
  const owned = await client.query<{ what: string }>(
    `SELECT 'relation ' || relname AS what FROM pg_class WHERE relowner = $1
     UNION ALL SELECT 'function ' || proname FROM pg_proc WHERE proowner = $1
     UNION ALL SELECT 'type ' || typname FROM pg_type WHERE typowner = $1
     UNION ALL SELECT 'schema ' || nspname FROM pg_namespace WHERE nspowner = $1
     UNION ALL SELECT 'database ' || datname FROM pg_database WHERE datdba = $1`,
    [attributes.oid],
  );
  const memberships = await client.query<{ name: string }>(
    'SELECT pg_get_userbyid(roleid) AS name FROM pg_auth_members WHERE member = $1',
    [attributes.oid],
  );

  const actual = grants.rows.map((row) => row.grant).sort();
  const allowed = new Set(RESTRICTED_ROLE_GRANTS[role]);
  const problems = [
    ...actual.filter((grant) => !allowed.has(grant)).map((grant) => `허용 목록 밖 권한 ${grant}`),
    ...owned.rows.map((row) => `소유: ${row.what}`),
    ...memberships.rows.map((row) => `멤버십: ${row.name}`),
    ...(['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolreplication'] as const)
      .filter((attribute) => attributes[attribute])
      .map((attribute) => `속성: ${attribute}`),
    // 틱 롤은 연결 한도가 풀 크기와 같아야 한다(#13 L4 — 연결 예산 · 틱 상호 배제).
    ...(role === DOMAIN_TICK_ROLE && attributes.rolconnlimit !== DOMAIN_TICK_ROLE_CONNECTION_LIMIT ? [`연결 한도: ${String(attributes.rolconnlimit)}`] : []),
    ...(role === AI_WATCH_ROLE && attributes.rolconnlimit !== AI_WATCH_ROLE_CONNECTION_LIMIT ? [`연결 한도: ${String(attributes.rolconnlimit)}`] : []),
  ];
  return { role, exists: true, grants: actual, problems };
}

/** Postgres 기본 `scram_iterations`. */
const SCRAM_ITERATIONS = 4096;

/**
 * SCRAM-SHA-256 검증자(`pg_authid.rolpassword` 형식, RFC 5802 / RFC 7677).
 * 비밀번호는 base64url 이라 SASLprep 가 항등이다(ASCII 만).
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** 새 비밀번호 — 256비트, base64url(43자). URL 인코딩이 필요 없고 SQL 리터럴에 따옴표가 없다. */
export function generateRolePassword(): string {
  return randomBytes(32).toString('base64url');
}

export type RoleAction = 'created' | 'password_set' | 'unchanged';

export interface RolePlan {
  /** 그 롤의 비밀이 이미 유효한 자격증명으로 채워져 있는가. */
  readonly secretFilled: boolean;
}

export interface RoleOutcome {
  readonly action: RoleAction;
  /** 새로 정한 비밀번호 — 커밋 뒤 비밀에 써야 한다. `unchanged` 면 `null`. */
  readonly password: string | null;
}

export interface RoleBootstrapResult {
  readonly owner: RoleOutcome;
  readonly app: RoleOutcome;
  readonly admin: RoleOutcome;
  readonly loginMailer: RoleOutcome;
  readonly passportSigner: RoleOutcome;
  readonly tlog: RoleOutcome;
  readonly tlogAnchor: RoleOutcome;
  readonly billing: RoleOutcome;
  readonly billingOperator: RoleOutcome;
  readonly ops: RoleOutcome;
  /** 고객 도메인 틱 롤(ADR-0014) — 단계 2 부터 비밀 계획을 따른다(단계 0 의 NOLOGIN 롤은 자리표시 비밀이면 LOGIN 으로 바뀐다). */
  readonly domainTick: RoleOutcome;
  /** AI 감시 결과 λ 롤(ADR-0017 초안 · 202610061100). */
  readonly aiWatch: RoleOutcome;
  /** 부트스트랩 뒤 DB 소유자. */
  readonly databaseOwner: string;
}

const ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

async function ensureRole(
  client: PoolClient,
  role: string,
  extra: string,
  plan: RolePlan,
  newPassword: () => string,
): Promise<RoleOutcome> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount !== 0 && plan.secretFilled) return { action: 'unchanged', password: null };

  const password = newPassword();
  const verifier = client.escapeLiteral(scramSha256Verifier(password));
  const name = client.escapeIdentifier(role);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${name} WITH ${ROLE_ATTRIBUTES}${extra} PASSWORD ${verifier}`);
    return { action: 'created', password };
  }
  await client.query(`ALTER ROLE ${name} WITH LOGIN PASSWORD ${verifier}`);
  return { action: 'password_set', password };
}

/**
 * 한 트랜잭션 안에서 부른다(호출자가 BEGIN/COMMIT). 비밀 쓰기는 **커밋 뒤** 호출자가 한다 — 여기서 쓰면 롤백된
 * 비밀번호가 비밀에 남는다.
 */
export async function bootstrapRoles(
  client: PoolClient,
  database: string,
  plans: {
    readonly owner: RolePlan;
    readonly app: RolePlan;
    readonly admin: RolePlan;
    readonly loginMailer: RolePlan;
    readonly passportSigner: RolePlan;
    readonly tlog: RolePlan;
    readonly tlogAnchor: RolePlan;
    readonly billing: RolePlan;
    readonly billingOperator: RolePlan;
    readonly ops: RolePlan;
    readonly domainTick: RolePlan;
    readonly aiWatch: RolePlan;
  },
  newPassword: () => string = generateRolePassword,
): Promise<RoleBootstrapResult> {
  const owner = await ensureRole(client, OWNER_ROLE, '', plans.owner, newPassword);
  const app = await ensureRole(client, APP_ROLE_NAME, ' NOINHERIT', plans.app, newPassword);
  // 제한 롤 둘 — 앱 롤과 같은 속성. 테이블 권한은 마이그레이션 202609230720 이 준다(그 파일은 이 둘이 없으면 멈춘다).
  const admin = await ensureRole(client, ADMIN_ROLE, ' NOINHERIT', plans.admin, newPassword);
  const loginMailer = await ensureRole(client, LOGIN_MAILER_ROLE, ' NOINHERIT', plans.loginMailer, newPassword);
  // 서명 롤(202609241200) — 같은 모양. 테이블 권한은 그 마이그레이션이 준다(없으면 멈춘다).
  const passportSigner = await ensureRole(client, PASSPORT_SIGNER_ROLE, ' NOINHERIT', plans.passportSigner, newPassword);
  // 투명성 로그 롤 둘(202609241600) — 같은 모양. 테이블 권한은 그 마이그레이션이 준다(없으면 멈춘다).
  const tlog = await ensureRole(client, TLOG_ROLE, ' NOINHERIT', plans.tlog, newPassword);
  const tlogAnchor = await ensureRole(client, TLOG_ANCHOR_ROLE, ' NOINHERIT', plans.tlogAnchor, newPassword);
  // 결제 롤 둘(202609250400, WP-2) — 같은 모양. 테이블 권한은 그 마이그레이션이 준다(없으면 멈춘다).
  const billing = await ensureRole(client, BILLING_ROLE, ' NOINHERIT', plans.billing, newPassword);
  const billingOperator = await ensureRole(client, BILLING_OPERATOR_ROLE, ' NOINHERIT', plans.billingOperator, newPassword);
  // 호스팅 운영자 콘솔 롤(202609290500) — 같은 모양 + 연결 한도 · 타임아웃 셋 · 하드 잠금이면 NOLOGIN 유지.
  const ops = await ensureOpsRole(client, plans.ops, newPassword);
  // 고객 도메인 틱 롤(ADR-0014 · 202609291100) — 단계 2 부터 같은 모양(NOINHERIT · 비밀 계획). 단계 0 의 NOLOGIN 롤은 `ensureRole` 의
  //   ALTER 경로(LOGIN + 새 비밀번호)로 바뀐다. 권한은 그 마이그레이션의 GRANT 그대로다(로그인할 수 있게 될 뿐 넓어지지 않는다).
  const domainTick = await ensureRole(
    client,
    DOMAIN_TICK_ROLE,
    ` NOINHERIT CONNECTION LIMIT ${String(DOMAIN_TICK_ROLE_CONNECTION_LIMIT)}`,
    plans.domainTick,
    newPassword,
  );
  // 이미 있던 롤(단계 0 의 NOLOGIN · 옛 부트스트랩)도 한도를 맞춘다 — 다를 때만(멱등).
  const tickLimit = await client.query<{ rolconnlimit: number }>('SELECT rolconnlimit FROM pg_roles WHERE rolname = $1', [DOMAIN_TICK_ROLE]);
  if (tickLimit.rows[0] !== undefined && tickLimit.rows[0].rolconnlimit !== DOMAIN_TICK_ROLE_CONNECTION_LIMIT) {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(DOMAIN_TICK_ROLE)} WITH CONNECTION LIMIT ${String(DOMAIN_TICK_ROLE_CONNECTION_LIMIT)}`);
  }
  // AI 감시 결과 λ 롤(202610061100) — 같은 모양 + 연결 한도 2. 권한은 마이그레이션의 `ai_watch_apply_role_grants()` 가 준다(아래 — 롤이 생긴 뒤).
  const aiWatch = await ensureRole(
    client,
    AI_WATCH_ROLE,
    ` NOINHERIT CONNECTION LIMIT ${String(AI_WATCH_ROLE_CONNECTION_LIMIT)}`,
    plans.aiWatch,
    newPassword,
  );
  const aiWatchLimit = await client.query<{ rolconnlimit: number }>('SELECT rolconnlimit FROM pg_roles WHERE rolname = $1', [AI_WATCH_ROLE]);
  if (aiWatchLimit.rows[0] !== undefined && aiWatchLimit.rows[0].rolconnlimit !== AI_WATCH_ROLE_CONNECTION_LIMIT) {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(AI_WATCH_ROLE)} WITH CONNECTION LIMIT ${String(AI_WATCH_ROLE_CONNECTION_LIMIT)}`);
  }
  await applyAiWatchRoleGrants(client);

  const current = await client.query<{ owner: string }>(
    'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
    [database],
  );
  const currentOwner = current.rows[0]?.owner;
  if (currentOwner === undefined) throw new Error(`데이터베이스 ${database} 가 없다.`);

  if (currentOwner !== OWNER_ROLE) {
    // DB 소유권을 넘기려면 새 소유자로 SET ROLE 할 수 있어야 한다(PG16+). 마스터는 롤을 만든 쪽이라 ADMIN 을 갖고,
    // 그 권한으로 자기에게 SET 만 잠시 준 뒤 거둔다 — INHERIT 는 주지 않는다(마스터가 소유자 권한을 상시로 쥐지 않게).
    const ownerName = client.escapeIdentifier(OWNER_ROLE);
    await client.query(`GRANT ${ownerName} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
    await client.query(`ALTER DATABASE ${client.escapeIdentifier(database)} OWNER TO ${ownerName}`);
    await client.query(`REVOKE ${ownerName} FROM CURRENT_USER`);
  }

  return {
    owner,
    app,
    admin,
    loginMailer,
    passportSigner,
    tlog,
    tlogAnchor,
    billing,
    billingOperator,
    ops,
    domainTick,
    aiWatch,
    databaseOwner: OWNER_ROLE,
  };
}

/**
 * AI 감시 결과 λ 롤의 GRANT(202610061100 `ai_watch_apply_role_grants()` — 정의자 아님 · EXECUTE 0)를 **소유자로** 건다. 함수가 없거나(마이그레이션 전)
 * 소유자가 `atmark_owner` 가 아니면(로컬 — 마이그레이션이 이미 걸었다) 아무것도 하지 않는다. DB 소유권 이전과 같은 절차: 소유자에게 SET 만 잠시
 * (INHERIT 없이) 받아 SET LOCAL ROLE → 함수 → RESET → 거둔다. 멱등(GRANT 는 겹쳐도 같다).
 */
export async function applyAiWatchRoleGrants(client: Pick<PoolClient, 'query' | 'escapeIdentifier'>): Promise<boolean> {
  const found = await client.query<{ owner: string }>(
    `SELECT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = to_regprocedure('public.ai_watch_apply_role_grants()')`,
  );
  if (found.rows[0]?.owner !== OWNER_ROLE) return false;
  const owner = client.escapeIdentifier(OWNER_ROLE);
  await client.query(`GRANT ${owner} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
  try {
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query('SELECT public.ai_watch_apply_role_grants()');
  } catch (error) {
    // 원래 오류를 보존한다(재검증 진단): 실패한 문장 뒤의 트랜잭션은 aborted 라 RESET·REVOKE 도 실패하는데, finally 로 두면 그 오류(25P02)가 원인을
    //   가린다. 되돌리기는 호출자의 ROLLBACK 이 한다(멤버십 · SET LOCAL 모두 트랜잭션과 함께 사라진다) — 여기서는 시도만 하고 그 실패는 삼킨다.
    await client.query('RESET ROLE').catch(() => undefined);
    await client.query(`REVOKE ${owner} FROM CURRENT_USER`).catch(() => undefined);
    throw error;
  }
  await client.query('RESET ROLE');
  await client.query(`REVOKE ${owner} FROM CURRENT_USER`);
  return true;
}

/**
 * `ops_settings.hard_locked`(202609290500) — 표가 없으면(마이그레이션 전) **잠기지 않은 것**이다(I-5). 마스터는 그 표를 읽을 권한이 없을 수 있다 —
 * 그러면 DB 소유권 이전과 같은 절차로(표 소유자에게 SET 만 잠시, INHERIT 없이) 한 번 읽고 되돌린다. 읽기만 한다.
 */
export async function readOpsHardLocked(client: Pick<PoolClient, 'query' | 'escapeIdentifier'>): Promise<boolean> {
  const table = await client.query<{ owner: string; readable: boolean }>(
    `SELECT pg_get_userbyid(c.relowner) AS owner, has_column_privilege(current_user, c.oid, 'hard_locked', 'SELECT') AS readable
       FROM pg_class c WHERE c.oid = to_regclass('public.ops_settings')`,
  );
  const row = table.rows[0];
  if (row === undefined) return false;
  const read = async (): Promise<boolean> =>
    (await client.query<{ locked: boolean }>('SELECT coalesce(bool_or(hard_locked), false) AS locked FROM public.ops_settings')).rows[0]?.locked ?? false;
  if (row.readable) return read();
  const owner = client.escapeIdentifier(row.owner);
  await client.query(`GRANT ${owner} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
  try {
    await client.query(`SET LOCAL ROLE ${owner}`);
    return await read();
  } finally {
    await client.query('RESET ROLE');
    await client.query(`REVOKE ${owner} FROM CURRENT_USER`);
  }
}

/**
 * `atmark_ops` — 다른 제한 롤과 같은 모양 + `CONNECTION LIMIT 3` + `OPS_ROLE_SETTINGS`. LOGIN 을 **새로 거는** 경우(롤 생성 · 비밀 재설정)에만
 * `hard_locked` 를 읽고, 잠겨 있으면 NOLOGIN 으로 만든다(재부트스트랩이 하드 킬 스위치를 풀지 않는다). 이미 있고 비밀이 채워진 롤은 LOGIN 을
 * 건드리지 않는다(잠금으로 NOLOGIN 이면 그대로다). 한도·설정은 **다를 때만** 고친다(멱등 · 같으면 ALTER 0).
 */
async function ensureOpsRole(client: PoolClient, plan: RolePlan, newPassword: () => string): Promise<RoleOutcome> {
  const name = client.escapeIdentifier(OPS_ROLE);
  const current = await client.query<{ rolconnlimit: number; rolconfig: string[] | null; rolinherit: boolean }>(
    'SELECT rolconnlimit, rolconfig, rolinherit FROM pg_roles WHERE rolname = $1',
    [OPS_ROLE],
  );
  const existing = current.rows[0];
  let outcome: RoleOutcome = { action: 'unchanged', password: null };
  if (existing === undefined || !plan.secretFilled) {
    const locked = await readOpsHardLocked(client);
    const login = locked ? 'NOLOGIN' : 'LOGIN';
    const password = newPassword();
    const verifier = client.escapeLiteral(scramSha256Verifier(password));
    if (existing === undefined) {
      await client.query(
        `CREATE ROLE ${name} WITH ${login} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT ` +
          `CONNECTION LIMIT ${String(OPS_ROLE_CONNECTION_LIMIT)} PASSWORD ${verifier}`,
      );
      outcome = { action: 'created', password };
    } else {
      await client.query(`ALTER ROLE ${name} WITH ${login} PASSWORD ${verifier}`);
      outcome = { action: 'password_set', password };
    }
  }
  if (existing !== undefined && (existing.rolconnlimit !== OPS_ROLE_CONNECTION_LIMIT || existing.rolinherit)) {
    await client.query(`ALTER ROLE ${name} WITH NOINHERIT CONNECTION LIMIT ${String(OPS_ROLE_CONNECTION_LIMIT)}`);
  }
  const settings = new Set(existing?.rolconfig ?? []);
  for (const [setting, value] of Object.entries(OPS_ROLE_SETTINGS)) {
    if (!settings.has(`${setting}=${value}`)) await client.query(`ALTER ROLE ${name} SET ${setting} = ${client.escapeLiteral(value)}`);
  }
  return outcome;
}

/** `ops-role-lock` · `ops-role-unlock` 의 결과(migrate 핸들러가 그대로 돌려준다). 비밀·주소 없음. */
export interface OpsRoleLockOutcome {
  /** 끝난 뒤 카탈로그의 `rolcanlogin`(커밋된 값). */
  readonly canLogin: boolean;
  /** 끊은 `atmark_ops` 백엔드 수(잠금만). */
  readonly terminated: number;
  /** 다시 본 뒤에도 남은 `atmark_ops` 백엔드 수(잠금만 — 0 이어야 한다). */
  readonly remaining: number;
  /** `ops_settings.hard_locked` — 잠그기 **전에** 참이어야 한다(재부트스트랩이 LOGIN 을 되돌리지 않게). 읽지 못하면 `null`. */
  readonly hardLocked: boolean | null;
}

/** 트랜잭션 하나로(실패하면 롤백하고 던진다). */
async function inTransaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await run();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function hardLockedOrNull(client: PoolClient): Promise<boolean | null> {
  try {
    return await inTransaction(client, () => readOpsHardLocked(client));
  } catch {
    return null;
  }
}

async function requireOpsRole(client: PoolClient): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [OPS_ROLE]);
  if (exists.rowCount === 0) throw new Error(`롤 ${OPS_ROLE} 이 없다 — bootstrap-roles 를 먼저 돌려라.`);
}

async function canLoginOf(client: PoolClient): Promise<boolean> {
  return (await client.query<{ rolcanlogin: boolean }>('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [OPS_ROLE])).rows[0]?.rolcanlogin ?? false;
}

/** `atmark_ops` 백엔드를 끊고 끊은 수. 트랜잭션 밖에서(자동 커밋) 부른다. */
async function terminateOpsBackends(client: PoolClient): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`,
    [OPS_ROLE],
  );
  return result.rows[0]?.n ?? 0;
}

async function opsBackendCount(client: PoolClient): Promise<number> {
  return (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1', [OPS_ROLE])).rows[0]?.n ?? 0;
}

/** 다시 보기의 대기 — 끊기 신호 뒤 백엔드가 실제로 나가기까지(최대 20 × 100ms). */
const RECHECK_ROUNDS = 20;
const RECHECK_INTERVAL_MS = 100;

/**
 * **하드 킬 스위치**(§5 I-5) — RDS 마스터로. 호출자는 트랜잭션을 열지 않는다(이 함수가 단계마다 따로 커밋한다):
 *   ① `ALTER ROLE atmark_ops NOLOGIN` 을 **먼저 커밋**한다 — 그 뒤로 새 로그인은 거부된다(끊긴 λ 가 다시 붙으려 해도).
 *   ② 커밋 **뒤에**(트랜잭션 밖에서) 그 롤의 백엔드를 끊는다. 끊기를 NOLOGIN 커밋 전에 하면, 그 사이에 다시 붙은 연결이 살아남는다.
 *   ③ 다시 본다 — 남은 백엔드(끊기 직전에 인증을 마친 연결)가 있으면 또 끊는다. 결과의 `remaining` 은 0 이어야 한다.
 * 순서(런북 ops-console): 소유자 롤로 `hard_locked = true` 를 **먼저** 영속하고(CLI `admin:ops-operator --hard-lock`), 이것을 부르고,
 * `atmark:opsLocked=true` 로 Compute 를 재배포한다.
 */
export async function lockOpsRole(client: PoolClient): Promise<OpsRoleLockOutcome> {
  await requireOpsRole(client);
  await inTransaction(client, async () => {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(OPS_ROLE)} WITH NOLOGIN`);
  });
  let terminated = await terminateOpsBackends(client);
  let remaining = await opsBackendCount(client);
  for (let round = 0; remaining > 0 && round < RECHECK_ROUNDS; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, RECHECK_INTERVAL_MS));
    terminated += await terminateOpsBackends(client);
    remaining = await opsBackendCount(client);
  }
  return { canLogin: await canLoginOf(client), terminated, remaining, hardLocked: await hardLockedOrNull(client) };
}

/** 하드 킬 스위치 해제 — `ALTER ROLE atmark_ops LOGIN`(커밋). 순서: 이것 → `admin:ops-operator --hard-unlock` → `opsLocked=false` 재배포. */
export async function unlockOpsRole(client: PoolClient): Promise<OpsRoleLockOutcome> {
  await requireOpsRole(client);
  await inTransaction(client, async () => {
    await client.query(`ALTER ROLE ${client.escapeIdentifier(OPS_ROLE)} WITH LOGIN`);
  });
  return { canLogin: await canLoginOf(client), terminated: 0, remaining: await opsBackendCount(client), hardLocked: await hardLockedOrNull(client) };
}
