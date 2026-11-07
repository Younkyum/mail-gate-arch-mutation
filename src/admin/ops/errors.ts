/**
 * src/admin/ops/errors.ts — 관리 연산의 **거부**. CLI(`scripts/admin/**`·`scripts/sender-mark.ts`·`scripts/ac0-*.ts`)와
 * 관리 API(`src/admin/routes/**`)가 **같은 클래스**를 본다 — 같은 입력은 같은 `code` 로 거부된다(가드 일치 테스트:
 * `test/integration/admin/admin-guard-parity.test.ts`).
 *
 * CLI 는 이 예외를 exit 2(입력 오류)로, API 는 `{error: code, detail: message}` + `status` 로 바꾼다. 메시지에 비밀·토큰·
 * 비밀번호를 싣지 않는다 — CLI 는 stderr, API 는 응답 본문으로 나간다.
 */

export type AdminErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export class AdminInputError extends Error {
  /** 기계가 읽는 거부 코드(`[a-z_]+`). 두 표면에서 같아야 한다. */
  readonly code: string;
  readonly status: AdminErrorStatus;

  constructor(message: string, code = 'invalid_request', status: AdminErrorStatus = 400) {
    super(message);
    this.name = 'AdminInputError';
    this.code = code;
    this.status = status;
  }
}

/** 대상이 없다(또는 이 조직의 것이 아니다 — 두 경우를 구별해 주지 않는다). */
export function notFound(message: string, code = 'not_found'): AdminInputError {
  return new AdminInputError(message, code, 404);
}

/**
 * **고객 도메인 SQLSTATE → 관리 오류**(ADR-0014 단계 4 M3b) — 콘솔 라우터 · 조직 API 라우터의 마지막 그물. 연산이 먼저 자기 맥락으로 번역하지
 * 못한 도메인 계약 코드(`DOMAIN_SQLSTATES`)가 500 이 되지 않게 한다(`test/integration/admin/domain-sqlstates.test.ts` 가 전부 센다).
 * 메시지는 코드별 상수다 — DB 메시지(도메인 이름 · 주소)를 싣지 않는다. P0A01 은 어디서도 전용 코드로 답하지 않는다(발급 쪽 중립 409
 * `address_taken`, 계약 `DOMAIN_API_ERRORS` 주석). P0A10 은 앱이 재시도로 삼키는 코드라 여기 오면 같은 중립 409 다.
 */
export const DOMAIN_SQLSTATE_REJECTIONS: Readonly<Record<string, { readonly status: AdminErrorStatus; readonly code: string; readonly message: string }>> = {
  P0A01: { status: 409, code: 'address_taken', message: '이미 쓰이고 있거나 지금은 발급할 수 없는 주소다.' },
  P0A02: { status: 409, code: 'domain_registrable_taken', message: '이 등록 가능 도메인 아래는 지금 쓸 수 없다.' },
  P0A03: { status: 409, code: 'plan_custom_domains_exceeded', message: '조직의 도메인 한도에 닿았다.' },
  P0A04: { status: 409, code: 'domain_address_limit', message: '이 도메인의 주소 수 상한에 닿았다.' },
  P0A05: { status: 400, code: 'domain_not_verified', message: '조직이 확인(verified)한 고객 도메인이 아니다.' },
  P0A06: { status: 400, code: 'primary_on_custom_domain', message: '고객 도메인 주소는 앵커(대표 주소 행)가 될 수 없다.' },
  P0A07: { status: 403, code: 'feature_not_enabled', message: '이 조직에는 고객 도메인 기능이 켜져 있지 않다.' },
  P0A08: { status: 400, code: 'primary_not_eligible', message: '대표 주소가 될 수 없는 주소다(@atmark.ai 별칭 · 폐기 · 확인되지 않은 도메인).' },
  P0A09: { status: 429, code: 'primary_change_rate_limited', message: '대표 주소 변경이 24시간 상한에 닿았다.' },
  P0A10: { status: 409, code: 'address_taken', message: '이미 쓰이고 있거나 지금은 발급할 수 없는 주소다.' },
};

/** 소문자 정규형 uuid — 경로·본문의 id 를 DB 에 묻기 전에 거른다(형 변환 오류가 500 이 되지 않게). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sqlStateOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

/** 도메인 계약 SQLSTATE 면 그 관리 오류, 아니면 `null`. */
export function domainSqlStateRejection(error: unknown): AdminInputError | null {
  const state = sqlStateOf(error);
  const entry = state === undefined ? undefined : DOMAIN_SQLSTATE_REJECTIONS[state];
  return entry === undefined ? null : new AdminInputError(entry.message, entry.code, entry.status);
}
