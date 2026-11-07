/**
 * src/runtime/internal-api-event.ts — api λ 의 **내부 이벤트**(HTTP 가 아니다). 콘솔(admin λ)이 웹훅 시크릿을 받는 유일한 길이다(보안 M1 —
 * ADR-0013 2026-09-30 개정). admin λ 는 웹훅 키링을 갖지 않는다: 등록·회전을 커밋한 뒤 api λ 를 `lambda:InvokeFunction`(RequestResponse)으로
 * 부르고, api λ 는 그 행이 **60초 안에 콘솔에서** 등록·회전됐는지 DB 에서 다시 확인한 뒤에만 파생한다(`issueConsoleWebhookSecret`).
 *
 * **모양을 엄격하게 가른다.** API Gateway HTTP API(payload v2)는 언제나 `version`·`routeKey`·`rawPath`·`requestContext` … 를 싣는다 — 이 파일의
 * 이벤트는 **정확히** 아래 키 집합의 평범한 객체만이다(키 하나라도 더 있거나 빠지면 `null` → HTTP 경로로 가고, HTTP 경로는 `requestContext` 가
 * 없으면 처리하지 않는다). 그러므로 인터넷에서 온 요청이 이 경로를 탈 수 없다 — 본문은 이벤트의 `body` 문자열 안에 있을 뿐 이벤트 자체가 아니다.
 * 이 이벤트를 보낼 수 있는 주체는 api 함수에 대한 `lambda:InvokeFunction` IAM 권한을 가진 쪽(admin 역할 하나)뿐이다.
 *
 * 세 종류:
 *   - `webhook.activeKid` → `{ok:true, kid}` — 콘솔이 새 행에 적을 활성 kid(비밀이 아니다 — 키 묶음의 이름).
 *   - `webhook.issueSecret` `{agentId, endpointId}` → `{ok:true, secret}` | `{ok:false, error:'not_eligible'}`.
 *   - `webhook.sealAuthorization` `{agentId, organizationId, endpointId, url, purpose, authorization}` → `{ok:true, url, kid, sealed, hint, generation}` |
 *     `{ok:false, error:'invalid_authorization'|'invalid_url'|'not_eligible'}` — 콘솔이 받은 인증 헤더 값을 **봉인만** 한다(202610141400 — 콘솔 λ 는
 *     키 묶음이 없다). 봉인 전에 api λ 가 DB 에서 대상을 다시 본다(보안 리뷰 L3): 에이전트가 그 조직의 것이고 삭제되지 않았는가 · `purpose`
 *     `replace` 면 엔드포인트가 있고 켜져 있고 그 에이전트 · 그 URL 의 것인가, `register` 면 그 id 가 아직 없는가. `url` 은 봉인에 쓴 정규화 URL 이다
 *     (콘솔이 등록할 URL 과 대조한다). 여는 길은 없다 — 이 이벤트로는 봉인값을 평문으로 되돌릴 수 없다. 값은 로그에 싣지 않는다.
 *
 * 이 파일은 **모양만** 안다(가져오는 것은 `db/schema` 의 id 판정 하나) — 부르는 쪽(admin λ 의 `lambda-invoke.ts`)이 DB·키 코드를 끌어오지 않게.
 * 처리는 `internal-api-handler.ts`(api λ 번들만).
 */

import { isAgentId } from '../db/schema';

export const INTERNAL_EVENT_SOURCE = 'atmark.internal';

export type InternalApiEvent =
  | { readonly source: typeof INTERNAL_EVENT_SOURCE; readonly kind: 'webhook.activeKid' }
  | { readonly source: typeof INTERNAL_EVENT_SOURCE; readonly kind: 'webhook.issueSecret'; readonly agentId: string; readonly endpointId: string }
  | {
      readonly source: typeof INTERNAL_EVENT_SOURCE;
      readonly kind: 'webhook.sealAuthorization';
      readonly agentId: string;
      readonly organizationId: string;
      readonly endpointId: string;
      readonly url: string;
      /** `register` = 아직 없는 새 id(콘솔 등록) · `replace` = 켜진 기존 엔드포인트(콘솔 설정·교체). */
      readonly purpose: 'register' | 'replace';
      readonly authorization: string;
    };

export type InternalApiResult =
  | { readonly ok: true; readonly kid: string }
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: true; readonly url: string; readonly kid: string; readonly sealed: string; readonly hint: string; readonly generation: number }
  | { readonly ok: false; readonly error: 'not_eligible' | 'unavailable' | 'invalid_authorization' | 'invalid_url' };

/** 봉인 이벤트의 문자열 상한 — 규칙(2048자 · URL 상한)보다 넉넉하다. 판정은 처리기가 한다. */
const MAX_SEAL_FIELD_LENGTH = 8192;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, i) => own[i] === key);
}

/** 이벤트가 내부 이벤트인가 — 정확한 키 집합 · 값 모양. 아니면 `null`(HTTP 로 처리). */
export function parseInternalApiEvent(event: unknown): InternalApiEvent | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  if (Object.getPrototypeOf(event) !== Object.prototype) return null;
  const value = event as Record<string, unknown>;
  if (value['source'] !== INTERNAL_EVENT_SOURCE) return null;
  if (value['kind'] === 'webhook.activeKid' && sameKeys(value, ['source', 'kind'])) {
    return { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' };
  }
  if (value['kind'] === 'webhook.issueSecret' && sameKeys(value, ['source', 'kind', 'agentId', 'endpointId'])) {
    const agentId = value['agentId'];
    const endpointId = value['endpointId'];
    if (typeof agentId !== 'string' || !isAgentId(agentId) || typeof endpointId !== 'string' || !UUID.test(endpointId)) return null;
    return { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.issueSecret', agentId, endpointId };
  }
  if (
    value['kind'] === 'webhook.sealAuthorization' &&
    sameKeys(value, ['source', 'kind', 'agentId', 'organizationId', 'endpointId', 'url', 'purpose', 'authorization'])
  ) {
    const { agentId, organizationId, endpointId, url, purpose, authorization } = value;
    if (typeof agentId !== 'string' || !isAgentId(agentId)) return null;
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return null;
    if (typeof endpointId !== 'string' || !UUID.test(endpointId)) return null;
    if (purpose !== 'register' && purpose !== 'replace') return null;
    if (typeof url !== 'string' || url.length > MAX_SEAL_FIELD_LENGTH) return null;
    if (typeof authorization !== 'string' || authorization.length > MAX_SEAL_FIELD_LENGTH) return null;
    return { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.sealAuthorization', agentId, organizationId, endpointId, url, purpose, authorization };
  }
  return null;
}
