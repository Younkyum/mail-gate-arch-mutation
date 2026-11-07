/**
 * src/api/http.ts — API 표면의 **형태만** 정의한다. 서버는 여기 없다.
 *
 * 라우트는 `(deps, ApiRequest) => Promise<ApiResponse>` 다. 앞에 붙는 어댑터(API Gateway proxy event 등)가 이 두 타입으로
 * 번역한다 — 프레임워크 선택이 관문의 인터페이스를 끌고 가지 않게(§1.4 Option C 기각 이유). **번역이 라우트 안으로 들어오지 않는 것이 요점이다.**
 *
 * 워커(`kind: 'worker'`)는 HTTP 가 아니므로 `ApiResponse` 를 쓰지 않는다 —
 * 도메인 결과 타입(`OutboundOutcome`, `outbound-service.ts`)을 그대로 돌려주고,
 * HTTP 라우트만 여기서 그 결과를 응답으로 번역한다.
 */

/** 헤더 이름은 **소문자로 정규화해 비교한다** — HTTP 헤더는 대소문자를 구분하지 않는다. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const AUTHORIZATION_HEADER = 'authorization';

/** 소문자 정규형 uuid — 경로·본문의 id 를 DB 에 묻기 전에 거른다(형 변환 오류가 500 이 되지 않게). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** JSON 본문. `unknown` 인 이유는 파싱된 값이 신뢰 대상이 아니기 때문이다. */
export interface ApiRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** JSON 객체(배열·null 이 아닌 object)인가 — 본문 파서들의 첫 검사. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 대소문자 무관 헤더 조회. 없으면 `null` — `undefined` 와 섞지 않는다(§ schema.ts 규약). */
export function headerOf(request: ApiRequest, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) {
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }
  }
  return null;
}

export function queryOf(request: ApiRequest, name: string): string | null {
  const value = request.query[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function jsonResponse(
  status: number,
  body: Readonly<Record<string, unknown>>,
): ApiResponse {
  return { status, body };
}

/** 쿼리 `limit` — 없으면 기본값, 1~`max` 정수가 아니면 400. 목록 라우트가 같은 문장을 쓴다. */
export function pageLimitOf(
  request: ApiRequest,
  defaultSize: number,
  max: number,
): { readonly kind: 'ok'; readonly limit: number } | { readonly kind: 'error'; readonly response: ApiResponse } {
  const raw = queryOf(request, 'limit');
  const limit = raw === null ? defaultSize : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    return { kind: 'error', response: errorResponse(400, 'invalid_request', `limit must be an integer from 1 to ${String(max)}.`) };
  }
  return { kind: 'ok', limit };
}

/** `limit + 1` 행을 읽은 결과 → 쪽과 다음 커서. 한 행 더 읽어 "다음 쪽이 있는가" 를 안다(빈 마지막 쪽 요청을 없앤다). */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => string,
): { readonly page: T[]; readonly nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

/**
 * 오류 응답. **`error` 코드가 기계가 읽는 유일한 필드다.**
 * `detail` 은 사람을 위한 문장이며, 분기 조건으로 쓰면 문구 수정이 동작 변경이 된다.
 */
export function errorResponse(status: number, error: string, detail: string): ApiResponse {
  return { status, body: { error, detail } };
}

/** `Idempotency-Key` 누락 응답 코드. Layer D 가 매니페스트 순회로 이 케이스를 자동 생성한다. */
const IDEMPOTENCY_KEY_REQUIRED = 'idempotency_key_required';

export type IdempotencyKeyOutcome =
  | { readonly kind: 'ok'; readonly key: string }
  | { readonly kind: 'error'; readonly response: ApiResponse };

/**
 * `kind: 'http'` 경로 **전부**가 통과해야 하는 문(門) (§4.5-1).
 *
 * 매니페스트의 리터럴 타입(`requiresIdempotencyKey: true`)이 "요구한다"를 선언하고,
 * 이 함수가 그 선언을 실제 400 으로 만든다. 둘 중 하나만 있으면 선언은 주석이 되거나
 * 집행은 우연이 된다 — Layer D 가 두 쪽을 매니페스트 하나로 묶어 순회한다.
 *
 * **미구현 스텁(501)도 이 검사를 먼저 지난다.** 순서를 뒤집으면 "아직 구현 안 됐으니
 * 헤더도 안 봐도 된다" 가 되고, P3 에서 구현이 붙는 날 그 경로만 규칙 밖에 서 있게 된다.
 */
export function requireIdempotencyKey(request: ApiRequest): IdempotencyKeyOutcome {
  const key = headerOf(request, IDEMPOTENCY_KEY_HEADER);
  if (key === null) {
    return {
      kind: 'error',
      response: errorResponse(
        400,
        IDEMPOTENCY_KEY_REQUIRED,
        `The ${IDEMPOTENCY_KEY_HEADER} header is required. Retrying with the same key returns the first result instead of sending again.`,
      ),
    };
  }
  if (key.length > 255) {
    return {
      kind: 'error',
      response: errorResponse(
        400,
        IDEMPOTENCY_KEY_REQUIRED,
        `${IDEMPOTENCY_KEY_HEADER} must be 1 to 255 characters.`,
      ),
    };
  }
  return { kind: 'ok', key };
}
