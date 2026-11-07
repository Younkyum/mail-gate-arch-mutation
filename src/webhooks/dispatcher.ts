/**
 * src/webhooks/dispatcher.ts — outbox 에서 웹훅을 꺼내 보낸다. **at-least-once.**
 *
 * 웹훅은 실패한다(수신측 배포 중, 5xx, 타임아웃, DNS). 그래서 이벤트는 **발생한 트랜잭션
 * 안에서 outbox(`webhook_deliveries`)에 적히고**(approval 전이와 같이 커밋되거나 같이
 * 롤백된다), 이 모듈이 따로 꺼내 보낸다. 요청 경로에서 직접 HTTP 를 쏘면
 * ① 수신측 지연이 승인 POST 를 붙잡고 ② 커밋 직전 실패하면 "보냈는데 일어나지 않은
 * 사건" 이 생긴다 — 둘 다 이 저장소의 규율(AC-d1 비블로킹, audit 우선)과 어긋난다.
 *
 * ---------------------------------------------------------------------------
 * ## 재시도 정책
 * ---------------------------------------------------------------------------
 *
 * 시도 1 은 즉시, 이후 실패마다 `RETRY_SCHEDULE_MS` 만큼 뒤에 다시. 총 10회, 첫 시도부터
 * 마지막 시도까지 약 31시간 40분. 근거:
 *   - 승인 TTL 기본이 24시간이다. 그 안에 수신측이 복구하면 `approval.*` 가 도착한다.
 *     그 뒤는 `GET /v1/approvals/{id}`(§3.4 1조, 웹훅 유실 대비)가 받는다.
 *   - 지수 백오프(×~3)는 장애 난 수신측을 두드리지 않는다. Stripe(최대 3일)보다 짧은 것은
 *     이 이벤트들의 가치가 짧기 때문이다 — 하루 지난 `approval.resolved` 는 폴링이 이미 답했다.
 *   - 지터는 넣지 않는다(결정적 스케줄이 테스트로 고정 가능). 대량 동시 실패가 문제가 되면
 *     그때 넣는다 — 스케줄은 한 배열이다.
 *
 * **영구 실패(`dead`)** — 재시도하지 않고 행에 사유를 남긴다(삭제하지 않는다; 재전송은 새 행이다 —
 * `POST /v1/agents/{id}/webhook-deliveries/{deliveryId}/redeliver`, 메일 기본기 A4). 다음은 **첫 시도에서 바로** dead 다:
 *   - `blocked_destination` — SSRF 차단. 재시도는 내부망 탐침을 반복해 줄 뿐이다.
 *   - `invalid_url` · `endpoint_disabled`.
 * 나머지(HTTP 비-2xx, 네트워크, 타임아웃, DNS 실패, 서명 키 부재, 인증 헤더를 열지 못함)는 재시도한다. 3xx 도
 * 실패다 — **리다이렉트를 따라가지 않는다**(따라가면 SSRF 검사를 지난 뒤 목적지가 바뀐다 — 그리고 인증 헤더가 다른 곳으로 따라간다).
 *
 * **인증 헤더(선택, 202610141400 — `authorization.ts`).** 엔드포인트에 봉인값이 있으면 집는 순간의 값을 열어 `authorization` 헤더로 싣는다(재시도 ·
 * 재전송도 그때의 지금 값 — 지웠으면 싣지 않는다). 열지 못하면(키 없음 · 엔드포인트 · URL 이 봉인 때와 다름 · 값 변조) **보내지 않는다** —
 * `authorization_unavailable` 로 재시도한다(헤더 없이 보내면 게이트웨이가 401 을 줄 뿐이고, URL 이 바뀐 행이면 값이 다른 곳으로 가지 않아야 한다).
 * 값은 보고서 · 로그 · 오류 어디에도 싣지 않는다 — 전송단은 오류 코드만 돌려준다.
 *
 * ---------------------------------------------------------------------------
 * ## 크래시와 펜싱
 * ---------------------------------------------------------------------------
 *
 * `claimDue` 는 시도 횟수를 **먼저** 올리고 `next_attempt_at` 을 임대 만료 시각으로 민다.
 * 보내는 도중 죽으면 임대가 풀린 뒤 다시 집히고, 그 시도는 이미 센 것이다(무한 크래시
 * 루프도 `MAX_ATTEMPTS` 에서 멈춘다). 결과 기록은 `(id, attempt)` 로 펜싱한다 — 임대가
 * 만료돼 다른 워커가 집어 간 행을 늦게 끝난 워커가 덮어쓰지 않는다.
 */

import { countMetric, METRIC_NAMES } from '../observability/metrics';
import type { HmacKeyring } from '../security/hmac-keyring';
import { openWebhookAuthorization } from './authorization';
import { resolveDestination, type HostResolver } from './destination';
import { deriveWebhookSecret, signWebhook } from './signing';

// ---------------------------------------------------------------------------
// 포트
// ---------------------------------------------------------------------------

/** 전송단이 받는 것. **`address` 로 연결하고** `hostname` 은 SNI·Host 에만 쓴다. */
export interface WebhookHttpRequest {
  readonly url: URL;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type WebhookTransportResult =
  | { readonly kind: 'response'; readonly status: number }
  | { readonly kind: 'network_error'; readonly code: string }
  | { readonly kind: 'timeout' };

export interface WebhookTransport {
  post(request: WebhookHttpRequest): Promise<WebhookTransportResult>;
}

/** outbox 에서 집어 온 한 건. `attempt` 는 **이번 시도의 번호**(집을 때 이미 올라가 있다). */
export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly body: string;
  readonly attempt: number;
  readonly endpoint: {
    readonly id: string;
    readonly url: string;
    readonly secretKid: string;
    readonly secretVersion: number;
    /** 회전 직전 시크릿과 유예 끝(`graceSecret`). 회전한 적 없으면 `null`, 이 칸을 모르는 테스트 더블은 생략(= 하나로 서명). */
    readonly previousSecret?: { readonly kid: string; readonly version: number; readonly validUntil: Date } | null;
    /** 엔드포인트의 에이전트 — 인증 헤더 봉인의 AAD. 인증 헤더가 없으면 쓰지 않는다. */
    readonly agentId?: string;
    /** 인증 헤더 봉인값(202610141400). 없으면 `null` · 이 칸을 모르는 테스트 더블은 생략(= 없음). */
    readonly authorization?: { readonly kid: string; readonly sealed: string; readonly generation: number } | null;
    readonly disabled: boolean;
  };
}

export type DeliveryErrorKind =
  | 'http_status'
  | 'network_error'
  | 'timeout'
  | 'dns_failure'
  | 'blocked_destination'
  | 'invalid_url'
  | 'endpoint_disabled'
  | 'signing_key_unavailable'
  | 'authorization_unavailable'
  | 'max_attempts_exceeded';

export interface WebhookOutboxPort {
  claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]>;
  /** 펜싱: `(deliveryId, attempt)` 가 여전히 이 시도의 것일 때만 `true`. */
  markDelivered(deliveryId: string, attempt: number, now: Date, httpStatus: number): Promise<boolean>;
  scheduleRetry(
    deliveryId: string,
    attempt: number,
    nextAttemptAt: Date,
    errorKind: DeliveryErrorKind,
    httpStatus: number | null,
  ): Promise<boolean>;
  markDead(
    deliveryId: string,
    attempt: number,
    now: Date,
    errorKind: DeliveryErrorKind,
    httpStatus: number | null,
  ): Promise<boolean>;
}

export interface WebhookDispatchDependencies {
  readonly outbox: WebhookOutboxPort;
  readonly resolve: HostResolver;
  readonly transport: WebhookTransport;
  /** 웹훅 시크릿 마스터 키 묶음(`WEBHOOK_SECRET_KEYS_ENV`). */
  readonly keyring: HmacKeyring;
}

// ---------------------------------------------------------------------------
// 정책
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** 시도 n 이 실패한 뒤 시도 n+1 까지의 대기. 길이 + 1 이 최대 시도 횟수다. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  4 * HOUR,
  8 * HOUR,
  16 * HOUR,
];

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/** 기본 임대. 전송 타임아웃(10초)보다 넉넉히 길어야 정상 시도가 임대 만료로 중복되지 않는다. */
export const DEFAULT_LEASE_MS = 60 * SECOND;

/** 시도 `attempt` 가 실패했을 때 다음까지의 대기. `null` 이면 더 없다(dead). */
function retryDelayAfter(attempt: number): number | null {
  return RETRY_SCHEDULE_MS[attempt - 1] ?? null;
}

const PERMANENT: ReadonlySet<DeliveryErrorKind> = new Set<DeliveryErrorKind>([
  'blocked_destination',
  'invalid_url',
  'endpoint_disabled',
  'max_attempts_exceeded',
]);

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export type DeliveryOutcome = 'delivered' | 'retry_scheduled' | 'dead' | 'lease_lost';

export interface DeliveryReport {
  readonly deliveryId: string;
  readonly outcome: DeliveryOutcome;
  readonly errorKind: DeliveryErrorKind | null;
  readonly httpStatus: number | null;
}

type Attempt =
  | { readonly kind: 'delivered'; readonly status: number }
  | { readonly kind: 'failed'; readonly error: DeliveryErrorKind; readonly status: number | null };

async function attempt(deps: WebhookDispatchDependencies, claimed: ClaimedDelivery, now: Date): Promise<Attempt> {
  if (claimed.attempt > MAX_ATTEMPTS) return { kind: 'failed', error: 'max_attempts_exceeded', status: null };
  if (claimed.endpoint.disabled) return { kind: 'failed', error: 'endpoint_disabled', status: null };

  // **리졸버는 여기서 한 번만** 불린다. 전송단은 DNS 를 부르지 않고 `address` 로 연결한다.
  const destination = await resolveDestination(claimed.endpoint.url, deps.resolve);
  if (destination.kind === 'dns_failure') return { kind: 'failed', error: 'dns_failure', status: null };
  if (destination.kind === 'rejected') {
    return {
      kind: 'failed',
      error: destination.reason === 'blocked_address' || destination.reason === 'internal_hostname'
        ? 'blocked_destination'
        : 'invalid_url',
      status: null,
    };
  }

  let secret: string;
  try {
    secret = deriveWebhookSecret(deps.keyring, {
      endpointId: claimed.endpoint.id,
      kid: claimed.endpoint.secretKid,
      version: claimed.endpoint.secretVersion,
    });
  } catch {
    return { kind: 'failed', error: 'signing_key_unavailable', status: null };
  }

  const authorization = openAuthorization(deps, claimed);
  if (authorization === 'unavailable') return { kind: 'failed', error: 'authorization_unavailable', status: null };

  const headers = {
    ...signWebhook([secret, ...graceSecret(deps, claimed, now)], claimed.eventId, claimed.body, now),
    'content-type': 'application/json',
    'user-agent': 'Atmark-Webhooks/1',
    // 서명을 대신하지 않는다 — 수신측 게이트웨이 통과용(머리말). 이름은 고정이고 값은 봉인을 연 뒤 규칙을 다시 지난 것이다.
    ...(authorization === null ? {} : { authorization }),
  };

  let result: WebhookTransportResult;
  try {
    result = await deps.transport.post({
      url: destination.url,
      hostname: destination.hostname,
      address: destination.address,
      family: destination.family,
      headers,
      body: claimed.body,
    });
  } catch {
    // 전송단은 던지지 않기로 돼 있지만, 던지면 **실패로 센다** — 삼키고 성공으로 두면 유실이다.
    return { kind: 'failed', error: 'network_error', status: null };
  }

  if (result.kind === 'timeout') return { kind: 'failed', error: 'timeout', status: null };
  if (result.kind === 'network_error') return { kind: 'failed', error: 'network_error', status: null };
  if (result.status >= 200 && result.status < 300) return { kind: 'delivered', status: result.status };
  return { kind: 'failed', error: 'http_status', status: result.status };
}

/** 인증 헤더 — 없으면 `null`, 열지 못하면 `'unavailable'`(오류 내용은 버린다 — 값이 실릴 여지를 두지 않는다). */
function openAuthorization(deps: WebhookDispatchDependencies, claimed: ClaimedDelivery): string | null | 'unavailable' {
  const stored = claimed.endpoint.authorization;
  if (stored === undefined || stored === null) return null;
  const agentId = claimed.endpoint.agentId;
  if (agentId === undefined) return 'unavailable';
  try {
    return openWebhookAuthorization(
      deps.keyring,
      { agentId, endpointId: claimed.endpoint.id, generation: stored.generation, url: claimed.endpoint.url },
      stored,
    );
  } catch {
    return 'unavailable';
  }
}

/**
 * 회전 유예 중인 직전 시크릿(있으면 하나) — 수신측이 시크릿을 바꿔 끼우는 동안 이벤트를 잃지 않게 `v1,<새> v1,<옛>` 로 둘 다 싣는다.
 * 유예가 끝났거나 옛 kid 가 묶음에서 빠졌으면 새 시크릿 하나로만 서명한다 — 옛 것이 없다고 전달을 실패시키지 않는다.
 */
function graceSecret(deps: WebhookDispatchDependencies, claimed: ClaimedDelivery, now: Date): readonly string[] {
  const previous = claimed.endpoint.previousSecret;
  if (previous === undefined || previous === null || now.getTime() >= previous.validUntil.getTime()) return [];
  try {
    return [deriveWebhookSecret(deps.keyring, { endpointId: claimed.endpoint.id, kid: previous.kid, version: previous.version })];
  } catch {
    return [];
  }
}

async function deliverOne(
  deps: WebhookDispatchDependencies,
  claimed: ClaimedDelivery,
  now: Date,
): Promise<DeliveryReport> {
  const result = await attempt(deps, claimed, now);
  const { deliveryId } = claimed;

  // 메트릭은 **펜싱을 통과한 결말만** 센다(메일 기본기 A4 — 알람 `atmark-webhook-dead-ratio` 의 분자·분모). 임대를 잃은 늦은 시도는 다른 워커가
  //   같은 행의 결말을 셀 것이므로 세지 않는다 — 세면 한 전달이 두 번 잡힌다.
  if (result.kind === 'delivered') {
    const fenced = await deps.outbox.markDelivered(deliveryId, claimed.attempt, now, result.status);
    if (fenced) countMetric(METRIC_NAMES.webhookDelivered);
    return { deliveryId, outcome: fenced ? 'delivered' : 'lease_lost', errorKind: null, httpStatus: result.status };
  }

  const delay = PERMANENT.has(result.error) ? null : retryDelayAfter(claimed.attempt);
  if (delay === null) {
    const fenced = await deps.outbox.markDead(deliveryId, claimed.attempt, now, result.error, result.status);
    // `endpoint_disabled` 는 `webhookDead` 에서 뺀다 — 소유자가 엔드포인트를 지운 뒤 남은 pending 이 dead 가 되는 것은 전달 장애가 아니라
    //   소유자의 선택이다(분자에 넣으면 삭제 한 번이 운영자 알람을 울린다). 그 건은 워커 로그 `webhook.delivery` 가 센다.
    if (fenced && result.error !== 'endpoint_disabled') countMetric(METRIC_NAMES.webhookDead);
    return { deliveryId, outcome: fenced ? 'dead' : 'lease_lost', errorKind: result.error, httpStatus: result.status };
  }
  const fenced = await deps.outbox.scheduleRetry(
    deliveryId,
    claimed.attempt,
    new Date(now.getTime() + delay),
    result.error,
    result.status,
  );
  return {
    deliveryId,
    outcome: fenced ? 'retry_scheduled' : 'lease_lost',
    errorKind: result.error,
    httpStatus: result.status,
  };
}

/** 기한이 된 전달을 최대 `limit` 건 보낸다(워커가 주기적으로 부른다). 한 건의 실패가 다른 건을 막지 않는다 — 결과는 행마다 따로 기록된다. */
export async function dispatchDueWebhooks(
  deps: WebhookDispatchDependencies,
  now: Date,
  options: { readonly limit?: number; readonly leaseMs?: number } = {},
): Promise<readonly DeliveryReport[]> {
  const claimed = await deps.outbox.claimDue(now, options.limit ?? 20, options.leaseMs ?? DEFAULT_LEASE_MS);
  const reports: DeliveryReport[] = [];
  for (const delivery of claimed) {
    reports.push(await deliverOne(deps, delivery, now));
  }
  return reports;
}
