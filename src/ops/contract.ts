/**
 * src/ops/contract.ts — 호스팅 운영자 콘솔(ops.atmark.ai, ADR-0015 초안 · `.omc/plans/ops-console.md` §4.0) 의 **계약**.
 *
 * 리드가 작업자(W-DB · W-INFRA · W-APP)를 띄우기 전에 한 번에 정한다. 동작은 없다(상수와 타입뿐). 이름·한도·SQL 시그니처를 바꾸려면
 * 리드에게 요청한다 — 리드가 계약 커밋을 다시 한다. W-INFRA 는 여기 상수를 import 해서 쓰고 문자열로 다시 적지 않는다.
 * SQL 시그니처는 `docs/contracts/ops-sql.md` 와 같다 — W-DB 의 계약 테스트가 `pg_get_function_identity_arguments` 로 정확히 대조한다.
 */

export const OPS_HANDLER_NAME = 'ops' as const;
export const OPS_FUNCTION_NAME = 'atmark-ops';
export const OPS_POOL_MAX = 1;
export const OPS_RESERVED_CONCURRENCY = 2;
export const OPS_ROLE_CONNECTION_LIMIT = 3;
export const OPS_DOMAIN_NAME = 'ops.atmark.ai';
export const OPS_ORIGIN = 'https://ops.atmark.ai';

export const OPS_SECRET_NAMES = { db: 'atmark/db/ops', opsKeys: 'atmark/ops-keys', loginKeys: 'atmark/ops-login-keys' } as const;

export const OPS_ENV = {
  dbSecretArn: 'ATMARK_DB_OPS_SECRET_ARN',
  opsKeysSecretArn: 'ATMARK_OPS_KEYS_SECRET_ARN',
  /** login-mailer 만 가진다(코드 파생 키 — ops λ 에는 없다, C2). */
  opsLoginKeysSecretArn: 'ATMARK_OPS_LOGIN_KEYS_SECRET_ARN',
  /** 기존 키 재사용 — ops λ 가 요청 뒤 login-mailer 를 깨운다. */
  loginMailerFunctionArn: 'ATMARK_LOGIN_MAILER_FUNCTION_ARN',
} as const;

export const OPS_COOKIES = { session: '__Host-atmark_ops', login: '__Host-atmark_ops_login' } as const;
export const OPS_CSRF_HEADER = 'x-atmark-ops-csrf';

export const OPS_CONTEXTS = {
  browser: 'atmark.ops-browser.v1',
  csrf: 'atmark.ops-csrf.v1',
  code: 'atmark.ops-login-code.v1',
  ua: 'atmark.ops-ua.v1',
  client: 'atmark.ops-client.v1',
} as const;

export const OPS_ROUTES = {
  request: '/api/auth/request',
  verify: '/api/auth/verify',
  stepUp: '/api/auth/step-up',
  stepUpVerify: '/api/auth/step-up/verify',
} as const;

export const OPS_ACTIONS = [
  'org.activate',
  'org.reject',
  'org.freeze_on',
  'agent.suspend',
  'operator.approve',
  'operator.deny',
  'operator.revoke',
] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

/** `window` = 행위+조직에 묶인 10분 창 · `once` = 대상에 묶인 1회용 · `none` = 안전한 방향(P2). */
export const OPS_STEP_UP: Readonly<Record<OpsAction, 'window' | 'once' | 'none'>> = {
  'org.activate': 'window',
  'org.reject': 'once',
  'org.freeze_on': 'none',
  'agent.suspend': 'none',
  'operator.approve': 'once',
  'operator.deny': 'once',
  'operator.revoke': 'once',
};

export const OPS_LIMITS = {
  sessionIdleMin: 30,
  sessionAbsoluteH: 8,
  stepUpWindowMin: 10,
  challengeTtlMin: 10,
  codeFailuresMax: 5,
  requestPerClient15m: 10,
  verifyPerClient15m: 30,
  perAddressClientHour: 3,
  perAddressDay: 30,
  accessRequestGlobalHour: 5,
  pendingRequestsMax: 5,
  addressClientDailyFailures: 20,
  addressDailyFailureLock: 50,
  addressLockHours: 24,
  ticketsPerSession10m: 20,
  rejectPerSessionHour: 3,
  rejectGlobalDay: 10,
  killSwitchPerSessionHour: 10,
  /** 세션 하나에서 틀린 step-up 코드 누계 — 넘으면 DB 가 그 세션을 폐기한다(보안 검토 L2). */
  stepUpFailuresPerSession: 10,
  failuresPerKey10m: 30,
  cooldownDays: 7,
  requestExpiryDays: 7,
} as const;

/** 정의 함수가 던지는 SQLSTATE → HTTP 상태. 세부 코드는 DETAIL 에 싣는다(래퍼가 기존 AdminInputError 코드로 옮긴다). */
export const OPS_SQLSTATE = { AT401: 401, AT403: 403, AT404: 404, AT409: 409, AT429: 429, AT503: 503 } as const;

/** SQL 계약 — 이름 → `pg_get_function_identity_arguments` 문자열. `docs/contracts/ops-sql.md` 와 같다. */
export const OPS_SQL_FUNCTIONS = {
  ops_request_code: 'p_email text, p_binding text, p_client_key text, p_lang text',
  ops_login_verify: 'p_binding text, p_client_key text, p_code text, p_session_hash text, p_ua_hash text',
  ops_session_touch: 'p_session_hash text, p_ua_hash text, p_client_key text',
  ops_session_revoke: 'p_session_hash text, p_all boolean',
  ops_request_stepup: 'p_session_hash text, p_client_key text, p_action text, p_org uuid, p_target_operator uuid',
  ops_stepup_verify: 'p_session_hash text, p_client_key text, p_code text',
  ops_decide_request: 'p_session_hash text, p_operator_id uuid, p_decision text',
  ops_revoke_operator: 'p_session_hash text, p_operator_id uuid',
  ops_record_failure: 'p_session_hash text, p_client_key text, p_action text, p_org uuid, p_agent text, p_code text',
  ops_org_activate: 'p_session_hash text, p_org uuid',
  ops_org_reject: 'p_session_hash text, p_org uuid',
  // 대기자 명단(202609301520) — 콘솔 열림 → 세션 → 소유자 코어. 티켓·step-up 없음(감사는 waitlist_events).
  ops_waitlist_invite: 'p_session_hash text, p_entry uuid',
  ops_waitlist_invite_oldest: 'p_session_hash text, p_n integer',
  ops_waitlist_remove: 'p_session_hash text, p_entry uuid',
  // 주간 운영판(202610010900) — 읽기 전용 집계(건수 · 조직 id). 세션은 앱이 먼저 touch 로 본다(다른 읽기와 같다).
  ops_weekly_board: 'p_now timestamp with time zone, p_internal uuid[]',
  ops_org_freeze_on: 'p_session_hash text, p_org uuid',
  ops_agent_suspend: 'p_session_hash text, p_agent text',
  ops_mailer_set_digest: 'p_challenge uuid, p_digest text',
  ops_org_activate_core: 'p_org uuid, p_actor text',
  ops_org_reject_core: 'p_org uuid',
  ops_org_freeze_core: 'p_org uuid, p_on boolean',
  ops_agent_suspend_core: 'p_agent text',
  ops_activation_beta_enabled: '',
  ops_beta_catalog: '',
  purge_ops_login_records: '',
  expire_ops_requests: '',
  ops_operator_census: '',
} as const;
export type OpsSqlFunction = keyof typeof OPS_SQL_FUNCTIONS;

/** P2 에 들어오는 함수(P1 마이그레이션에는 없다). */
export const OPS_SQL_FUNCTIONS_P2: readonly OpsSqlFunction[] = [
  'ops_org_freeze_on',
  'ops_agent_suspend',
  'ops_org_freeze_core',
  'ops_agent_suspend_core',
];
