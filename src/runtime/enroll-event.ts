/**
 * src/runtime/enroll-event.ts — **자가 등록 내부 이벤트**(api λ → admin λ, ADR-0016 2026-10-08 개정 "자가 등록"). HTTP 가 아니다. 모양만 안다 — 두 번들이 함께
 * import 한다(DB · 키 코드를 끌어오지 않는다).
 *
 * 왜 admin λ 인가: 에이전트 프로비저닝은 키 보관(KMS GenerateDataKey + Secrets Manager CreateSecret)과 admin 롤의 쓰기가 필요한데 둘 다 admin λ 에만 있다.
 * api λ 에 그 권한을 넓히지 않고, api 역할에 `lambda:InvokeFunction` on `atmark-admin` ARN **하나**만 준다(compute-stack). admin λ 는 이 이벤트를
 * **이 동작 하나로만** 받는다 — 다른 관리 연산은 이 입구로 닿지 않는다(`test/unit/runtime/enroll-event.test.ts`).
 *
 * **이벤트는 부른 에이전트의 토큰 원문을 싣는다**(리드 조건 1): admin λ 가 해시를 다시 만들어 DB 에서 처음부터 다시 판정한다(살아 있는 토큰 · `agents:enroll` ·
 * 에이전트 · 조직 활성 · 조직 설정 켜짐 · 하루 상한 · 요금제 한도). 그래서 api λ 하나가 탈취돼도 유효한 enroll 토큰 없이는 아무것도 만들지 못한다.
 * 토큰 원문 · 새 토큰은 어느 로그에도 싣지 않는다.
 *
 * 모양을 엄격하게 가른다: 정확한 키 집합 · 정확한 상수(`source` · `action` · `v`) · 값 모양. 하나라도 어긋나면 `null` 이고 admin 핸들러는 HTTP 이벤트로도 읽지
 * 않는다(던진다).
 */

export const ENROLL_EVENT_SOURCE = 'atmark.api';
export const ENROLL_EVENT_ACTION = 'agent.enroll';
export const ENROLL_EVENT_VERSION = 1;

/** 에이전트가 고르는 이름 상한(콘솔 · 프로비저닝 200 보다 좁다 — 알림 메일에 실린다). */
export const ENROLL_NAME_MAX = 80;

export interface EnrollEvent {
  readonly source: typeof ENROLL_EVENT_SOURCE;
  readonly action: typeof ENROLL_EVENT_ACTION;
  readonly v: typeof ENROLL_EVENT_VERSION;
  /** 부른 에이전트의 토큰 원문(`atk_agent_…`). */
  readonly token: string;
  readonly name: string;
  /** 없으면 admin 이 고른다(`agent-xxxxxxxx`). 모양 판정은 프로비저닝(`buildAgentAddress`)이 한다. */
  readonly localPart: string | null;
  /** api 요청 id — 로그를 잇는다. */
  readonly requestId: string;
}

/** 거절 코드 — api 라우트가 HTTP 상태 · 공개 오류로 바꾼다. */
export type EnrollRefusal =
  | 'unauthorized'
  | 'scope_missing'
  | 'not_active'
  | 'self_enroll_disabled'
  | 'enroll_daily_cap'
  | 'agent_limit'
  | 'address_taken'
  | 'invalid_local_part'
  | 'invalid_name'
  | 'chain_forbidden'
  /** 같은 요청 id 를 이미 처리했다(재생 — 새 에이전트 없음, 202610081103). */
  | 'replayed'
  | 'unavailable';

export type EnrollResult =
  | {
      readonly ok: true;
      readonly agent: { readonly id: string; readonly name: string; readonly address: string };
      /** 새 에이전트의 토큰 원문 — **이 응답 한 번뿐**(저장되는 것은 해시뿐). */
      readonly token: string;
      readonly scopes: readonly string[];
      readonly policyVersion: number;
    }
  | { readonly ok: false; readonly error: EnrollRefusal };

/** 호출 한 번의 결과 — 몸통(`parseEnrollResult` 가 읽는다) 또는 실패 이유(바쁨 · 시간 초과 · 그 밖). `runtime/lambda-invoke.ts` `createAgentEnroller` 가 만든다. */
export type AgentEnrollInvokeResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: 'busy' | 'timeout' | 'unavailable' };

/** api 라우트가 받는 호출 함수 — 조립 루트가 묶는다. */
export type AgentEnroller = (event: EnrollEvent) => Promise<AgentEnrollInvokeResult>;

const KEYS = ['source', 'action', 'v', 'token', 'name', 'localPart', 'requestId'].sort();
const TOKEN_SHAPE = /^atk_agent_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 자가 등록 이벤트인가 — 정확한 모양만. 아니면 `null`. */
export function parseEnrollEvent(event: unknown): EnrollEvent | null {
  if (!isRecord(event)) return null;
  const own = Object.keys(event).sort();
  if (own.length !== KEYS.length || own.some((key, index) => key !== KEYS[index])) return null;
  if (event['source'] !== ENROLL_EVENT_SOURCE || event['action'] !== ENROLL_EVENT_ACTION || event['v'] !== ENROLL_EVENT_VERSION) return null;
  const { token, name, localPart, requestId } = event;
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  if (typeof name !== 'string' || name.length < 1 || name.length > ENROLL_NAME_MAX * 4) return null;
  if (localPart !== null && (typeof localPart !== 'string' || localPart.length < 1 || localPart.length > 64)) return null;
  if (typeof requestId !== 'string' || !REQUEST_ID_SHAPE.test(requestId)) return null;
  return { source: ENROLL_EVENT_SOURCE, action: ENROLL_EVENT_ACTION, v: ENROLL_EVENT_VERSION, token, name, localPart, requestId };
}

const REFUSALS: ReadonlySet<string> = new Set<EnrollRefusal>([
  'unauthorized',
  'scope_missing',
  'not_active',
  'self_enroll_disabled',
  'enroll_daily_cap',
  'agent_limit',
  'address_taken',
  'invalid_local_part',
  'invalid_name',
  'chain_forbidden',
  'replayed',
  'unavailable',
]);

/** admin λ 의 응답 → 결과(모양이 틀리면 `unavailable`). */
export function parseEnrollResult(body: unknown): EnrollResult {
  if (!isRecord(body)) return { ok: false, error: 'unavailable' };
  if (body['ok'] === false) {
    const error = body['error'];
    return { ok: false, error: typeof error === 'string' && REFUSALS.has(error) ? (error as EnrollRefusal) : 'unavailable' };
  }
  const agent = body['agent'];
  const token = body['token'];
  const scopes = body['scopes'];
  const policyVersion = body['policyVersion'];
  if (
    body['ok'] !== true ||
    !isRecord(agent) ||
    typeof agent['id'] !== 'string' ||
    !/^[0-9a-f]{32}$/.test(agent['id']) ||
    typeof agent['name'] !== 'string' ||
    typeof agent['address'] !== 'string' ||
    typeof token !== 'string' ||
    !TOKEN_SHAPE.test(token) ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === 'string') ||
    typeof policyVersion !== 'number'
  ) {
    return { ok: false, error: 'unavailable' };
  }
  return {
    ok: true,
    agent: { id: agent['id'], name: agent['name'], address: agent['address'] },
    token,
    scopes: scopes as string[],
    policyVersion,
  };
}
