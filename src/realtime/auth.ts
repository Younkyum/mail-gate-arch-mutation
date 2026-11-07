/**
 * src/realtime/auth.ts — `$connect` 의 **자격 증명 읽기**(순수 — I/O 없음). 판정(형식 · 해시 · 폐기 · 만료 · 권한)은 `src/identity/agent-token.ts` 하나다.
 *
 * 받는 곳은 둘뿐이다:
 *   ① `Authorization: Bearer atk_agent_…`(서버 쪽 클라이언트 — 우선).
 *   ② `Sec-WebSocket-Protocol: atmark.v1, bearer.atk_agent_…`(브라우저 — `WebSocket` 생성자는 헤더를 붙이지 못한다). 서버는 `atmark.v1` **만** 돌려준다
 *      (토큰을 되돌려 보내지 않는다 — 응답 머리는 프록시 · 브라우저 개발 도구에 남는다).
 *
 * **쿼리 문자열의 토큰은 거부한다**(받지도 무시하지도 않는다 — 거부). URL 은 API Gateway 접근 로그 · 프록시 로그 · 브라우저 기록에 남고 그 셋은 우리가
 * 지울 수 없다. 무시하면 "되는 줄 알고" 계속 쓰는 클라이언트가 생긴다 — 거부해야 고친다. 조직 키(`atk_org_`)도 거부한다(이 표면의 토큰이 아니다).
 */

import { REALTIME_BEARER_SUBPROTOCOL_PREFIX, REALTIME_SUBPROTOCOL } from './contract';

type RealtimeCredentialRejection =
  | 'missing_token'
  | 'token_in_query'
  | 'org_key'
  | 'subprotocol_required'
  | 'conflicting_tokens';

type RealtimeCredential =
  | {
      readonly kind: 'presented';
      readonly token: string;
      readonly via: 'authorization' | 'subprotocol';
      /** 응답 `Sec-WebSocket-Protocol` 에 넣을 값 — 클라이언트가 `atmark.v1` 을 제안했을 때만. */
      readonly echoProtocol: typeof REALTIME_SUBPROTOCOL | null;
    }
  | { readonly kind: 'rejected'; readonly reason: RealtimeCredentialRejection };

interface RealtimeConnectRequest {
  readonly headers?: Readonly<Record<string, string | undefined>> | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
}

const BEARER = 'bearer ';
/** 토큰처럼 보이는 쿼리 키(대소문자 무시) — 값이 무엇이든 거부한다. */
const TOKEN_QUERY_KEYS = new Set(['token', 'access_token', 'accesstoken', 'auth', 'authorization', 'bearer', 'api_key', 'apikey', 'key', 'atk']);
/** 값 어디에든 토큰 접두사가 있으면 거부(`?x=atk_agent_…`). */
const TOKEN_PREFIX_IN_VALUE = /atk_/i;

function header(request: RealtimeConnectRequest, name: string): string | null {
  const headers = request.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

/**
 * 퍼센트 인코딩을 풀어 본 모양들(원문 + 최대 세 번 디코딩) — `atk%5Fagent_…` · `%2561tk_…`(이중) 같은 우회를 잡는다(적대 검증 E1-Q-024). 잘못된 인코딩은 그
 * 자리에서 멈춘다(원문은 그대로 본다). 대소문자는 정규식이 무시한다.
 */
function decodedForms(value: string): string[] {
  const forms = [value];
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/** 쿼리에 토큰 같은 것이 있는가. 키 · 값 둘 다 · 퍼센트 인코딩을 푼 모양까지 본다. */
export function queryCarriesToken(query: RealtimeConnectRequest['queryStringParameters']): boolean {
  if (query === null || query === undefined) return false;
  return Object.entries(query).some(([key, value]) => {
    const keys = decodedForms(key);
    const values = typeof value === 'string' ? decodedForms(value) : [];
    return keys.some((form) => TOKEN_QUERY_KEYS.has(form.toLowerCase()) || TOKEN_PREFIX_IN_VALUE.test(form)) || values.some((form) => TOKEN_PREFIX_IN_VALUE.test(form));
  });
}

/** `Sec-WebSocket-Protocol` → 제안 목록(쉼표 · 공백 정리, 빈 칸 없음). */
export function offeredSubprotocols(value: string | null): string[] {
  if (value === null) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readRealtimeCredential(request: RealtimeConnectRequest): RealtimeCredential {
  if (queryCarriesToken(request.queryStringParameters)) return { kind: 'rejected', reason: 'token_in_query' };

  const offered = offeredSubprotocols(header(request, 'sec-websocket-protocol'));
  const wantsAtmark = offered.includes(REALTIME_SUBPROTOCOL);
  const bearerEntries = offered.filter((entry) => entry.startsWith(REALTIME_BEARER_SUBPROTOCOL_PREFIX));
  const echoProtocol = wantsAtmark ? REALTIME_SUBPROTOCOL : null;

  const authorization = header(request, 'authorization');
  const fromHeader =
    authorization !== null && authorization.toLowerCase().startsWith(BEARER) ? authorization.slice(BEARER.length).trim() : null;
  const fromProtocol = bearerEntries.length === 1 ? (bearerEntries[0] ?? '').slice(REALTIME_BEARER_SUBPROTOCOL_PREFIX.length) : null;

  // 하위 프로토콜 토큰이 둘 이상이면 어느 쪽인지 고르지 않는다.
  if (bearerEntries.length > 1) return { kind: 'rejected', reason: 'conflicting_tokens' };
  // 하위 프로토콜로 토큰을 보냈다면 `atmark.v1` 도 함께여야 한다 — 돌려줄 프로토콜이 없으면 브라우저가 연결을 끊는다(그리고 서버가 고른 것이 없다는
  //   것은 클라이언트가 이 계약을 모른다는 뜻이다).
  if (fromProtocol !== null && !wantsAtmark) return { kind: 'rejected', reason: 'subprotocol_required' };
  if (fromHeader !== null && fromProtocol !== null && fromHeader !== fromProtocol) return { kind: 'rejected', reason: 'conflicting_tokens' };

  const token = fromHeader ?? fromProtocol;
  if (token === null || token.length === 0) return { kind: 'rejected', reason: 'missing_token' };
  if (token.startsWith('atk_org_')) return { kind: 'rejected', reason: 'org_key' };
  return { kind: 'presented', token, via: fromHeader !== null ? 'authorization' : 'subprotocol', echoProtocol };
}
