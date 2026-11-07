/**
 * src/db/repositories/webhook-store.ts — `webhook_endpoints`·`webhook_deliveries` 의 Postgres 구현.
 *
 * 네 가지를 한다:
 *   ① `insertWebhookEndpoint` — 등록. URL 정적 검사를 **여기서도** 한다(라우트가 빠뜨려도 바닥).
 *      `listWebhookEndpoints` · `findWebhookEndpoint` — 조회. 시크릿을 담을 자리가 없다.
 *      `disableWebhookEndpoint` · `countRecentWebhookRegistrations` — 소프트 삭제 · 재등록 상한(메일 기본기 A4).
 *      `supersedeWebhookEndpointSecret` — 시크릿 회전(정의자 함수 하나, 202609301410). 규칙·파생은 `webhooks/management.ts`.
 *   ② `enqueueWebhookEvent`   — outbox 적재. **호출자의 트랜잭션 커넥션**을 받는다 — 사건과
 *      같이 커밋돼야 outbox 다. 구독(`event_types`)을 여기서 거른다.
 *   ③ `createPostgresWebhookOutbox` — 디스패처 포트(집기·결과 기록).
 *   ④ `listWebhookDeliveries` · `redeliverWebhookDelivery` — 전달 목록(본문·URL 없음) · 재전송(메일 기본기 A4).
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { AgentId, WebhookEndpointEventTypes } from '../schema';
import { withTransaction, type Queryable } from '../client';
import { checkWebhookUrl, type WebhookUrlRejection } from '../../webhooks/destination';
import type {
  ClaimedDelivery,
  DeliveryErrorKind,
  WebhookOutboxPort,
} from '../../webhooks/dispatcher';
import { LEGACY_EVENT_TYPES, type WebhookEvent, type WebhookEventType } from '../../webhooks/events';
import { selectRow, selectRows } from './rows';

export class WebhookEndpointRejectedError extends Error {
  constructor(readonly reason: WebhookUrlRejection) {
    super(`웹훅 URL 거부: ${reason}`);
    this.name = 'WebhookEndpointRejectedError';
  }
}

/**
 * 등록. 반환값은 엔드포인트 id — 시크릿 파생의 입력이다(`deriveWebhookSecret`). INSERT 는 정의자 함수 `register_webhook_endpoint` 하나로만
 * (202609301410 — admin 롤은 표 INSERT 가 없다). `via` 는 호출 롤과 맞아야 한다(앱 롤 = api · admin 롤 = console).
 */
export async function insertWebhookEndpoint(
  db: Queryable,
  endpoint: {
    readonly agentId: AgentId;
    readonly url: string;
    readonly secretKid: string;
    /** 구독(opt-in). 생략·`null` = 옛 4종(202609260115). 호출자가 중복을 없애고 순서를 정한다. */
    readonly eventTypes?: WebhookEndpointEventTypes;
    /** 등록 표면. 기본 `api`. */
    readonly via?: WebhookRotationVia;
    /**
     * 새 엔드포인트 id(202610141400 — 앱이 INSERT 전에 만든다: 인증 헤더 봉인의 AAD 에 들어간다, 보안 리뷰 L2). 생략하면 여기서 만든다.
     * 이미 있는 id 면 PK 위반으로 던진다(남의 행을 고를 수 없다).
     */
    readonly id?: string;
  },
): Promise<string> {
  const checked = checkWebhookUrl(endpoint.url);
  if (checked.kind === 'rejected') throw new WebhookEndpointRejectedError(checked.reason);

  const eventTypes = endpoint.eventTypes ?? null;
  const row = await selectRow<{ id: string }>(
    db,
    `SELECT register_webhook_endpoint($1::uuid, $2, $3, $4, $5::webhook_event_type[], $6) AS id`,
    [endpoint.id ?? randomUUID(), endpoint.agentId, checked.url.href, endpoint.secretKid, eventTypes === null ? null : [...eventTypes], endpoint.via ?? 'api'],
  );
  if (row === null) throw new Error('register_webhook_endpoint 가 행을 돌려주지 않았다');
  return row.id;
}

/**
 * 콘솔 시크릿 발급 선점(202609301410 ⑦ · 보안 M1 · 재검토 L-1) — 콘솔이 **60초 안에** 등록(버전 1)했거나 콘솔 회전으로 지금 버전이 된 켜진
 * 행이고 그 `(엔드포인트, 버전)` 을 **처음** 선점했으면 `(kid, version)`, 아니면 `null`. 부를 때마다 선점을 쓴다(VOLATILE) — 같은 버전의 두 번째
 * 호출은 `null` 이다. api λ 의 내부 이벤트만 부른다(앱 롤 EXECUTE).
 */
export async function consoleWebhookSecretRef(
  db: Queryable,
  agentId: AgentId,
  endpointId: string,
): Promise<{ readonly kid: string; readonly version: number } | null> {
  const row = await selectRow<{ r_secret_kid: string; r_secret_version: number }>(
    db,
    `SELECT * FROM console_webhook_secret_ref($1, $2::uuid)`,
    [agentId, endpointId],
  );
  return row === null ? null : { kid: row.r_secret_kid, version: row.r_secret_version };
}

/**
 * 등록된 엔드포인트 하나 — **시크릿이 없다.** 시크릿은 등록 응답에서 한 번만 나간다
 * (`api/routes/webhook-endpoints.ts`). 이 타입에 시크릿 자리가 없으므로 목록 응답이 그것을 실을 수 없다.
 */
export interface WebhookEndpointRecord {
  readonly id: string;
  readonly url: string;
  readonly secretKid: string;
  readonly secretVersion: number;
  /** 구독. `null` = 옛 4종. */
  readonly eventTypes: WebhookEndpointEventTypes;
  readonly createdAt: Date;
  /** 소프트 삭제 시각. 목록은 기본으로 켜진 것만 싣는다(`includeDeleted`). */
  readonly disabledAt: Date | null;
  /** 마지막 시크릿 회전 시각(202609301410). 회전한 적 없으면 `null`. */
  readonly secretRotatedAt: Date | null;
  /** 직전 시크릿의 유예 — 이 시각 전이면 디스패처가 옛 시크릿으로도 서명한다. 시크릿 자체는 없다(`(kid, version)` 만). */
  readonly previousSecret: { readonly kid: string; readonly version: number; readonly validUntil: Date } | null;
  /**
   * 인증 헤더(202610141400)의 **힌트**만 — 방식 + 끝 4글자(예 `Bearer …wxyz`). 없으면 `null`. 봉인값·평문은 이 타입에 자리가 없다
   * (목록 응답이 실을 수 없다 — 봉인값은 디스패처의 `claimDue` 만 읽는다).
   */
  readonly authorizationHint: string | null;
}

interface EndpointRow {
  id: string;
  url: string;
  secret_kid: string;
  secret_version: number;
  event_types: WebhookEventType[] | null;
  created_at: Date;
  disabled_at: Date | null;
  secret_rotated_at: Date | null;
  previous_secret_kid: string | null;
  previous_secret_version: number | null;
  previous_secret_valid_until: Date | null;
  authorization_hint: string | null;
}

// `event_types::text[]` — 사용자 정의 열거형 배열은 드라이버가 모르는 OID 라 문자열(`{a,b}`)로 온다. text[] 로 바꿔 배열로 받는다.
// 인증 헤더는 **힌트 한 칸**만 읽는다(스칼라 부분 질의 — admin 롤은 이 표의 `endpoint_id`·`hint`·`set_at` 만 SELECT 할 수 있다, 202610141400).
const ENDPOINT_COLUMNS = `id, url, secret_kid, secret_version, event_types::text[] AS event_types, created_at, disabled_at,
       secret_rotated_at, previous_secret_kid, previous_secret_version, previous_secret_valid_until,
       (SELECT a.hint FROM webhook_endpoint_authorizations a WHERE a.endpoint_id = webhook_endpoints.id) AS authorization_hint`;

function toEndpointRecord(row: EndpointRow): WebhookEndpointRecord {
  return {
    id: row.id,
    url: row.url,
    secretKid: row.secret_kid,
    secretVersion: row.secret_version,
    eventTypes: row.event_types,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    secretRotatedAt: row.secret_rotated_at,
    previousSecret:
      row.previous_secret_kid === null || row.previous_secret_version === null || row.previous_secret_valid_until === null
        ? null
        : { kid: row.previous_secret_kid, version: row.previous_secret_version, validUntil: row.previous_secret_valid_until },
    authorizationHint: row.authorization_hint,
  };
}

/**
 * 에이전트의 엔드포인트(생성순). 기본은 **활성**만 — 비활성(`disabled_at`)은 이벤트를 받지 않는다. `includeDeleted` 는 콘솔의 "전체" 보기
 * (지운 엔드포인트의 전달 기록을 읽는 데 쓴다).
 */
export async function listWebhookEndpoints(
  db: Queryable,
  agentId: AgentId,
  options: { readonly includeDeleted?: boolean } = {},
): Promise<readonly WebhookEndpointRecord[]> {
  const rows = await selectRows<EndpointRow>(
    db,
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints
      WHERE agent_id = $1 AND ($2::boolean OR disabled_at IS NULL) ORDER BY created_at, id`,
    [agentId, options.includeDeleted === true],
  );
  return rows.map(toEndpointRecord);
}

/** 엔드포인트 하나(지운 것 포함). 없거나 다른 에이전트의 것이면 `null`. */
export async function findWebhookEndpoint(db: Queryable, agentId: AgentId, endpointId: string): Promise<WebhookEndpointRecord | null> {
  const row = await selectRow<EndpointRow>(db, `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1::uuid AND agent_id = $2`, [
    endpointId,
    agentId,
  ]);
  return row === null ? null : toEndpointRecord(row);
}

/** 회전 경로 — 원장 `webhook_secret_rotations.via` 와 같은 어휘. MCP 는 에이전트 API 를 지나므로 `api` 다. */
export type WebhookRotationVia = 'api' | 'console';

export type WebhookRotationRow =
  | { readonly kind: 'rotated'; readonly kid: string; readonly version: number; readonly changedAt: Date; readonly previousValidUntil: Date }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rate_limited' };

/**
 * 시크릿 회전 — SECURITY DEFINER `rotate_webhook_endpoint_secret` 하나로만(앱·admin 롤은 이 표 UPDATE 가 없다, 202609301410). (에이전트,
 * 엔드포인트) 짝이 맞는 **켜진** 행만 · 엔드포인트당 24시간 10회 · 버전 +1 · 직전 (kid, 버전) 24시간 유예. `kid` 는 새 버전을 파생할 활성 kid.
 */
export async function supersedeWebhookEndpointSecret(
  db: Queryable,
  agentId: AgentId,
  endpointId: string,
  kid: string,
  via: WebhookRotationVia,
): Promise<WebhookRotationRow> {
  const row = await selectRow<{
    r_outcome: string;
    r_secret_kid: string | null;
    r_secret_version: number | null;
    r_rotated_at: Date | null;
    r_previous_valid_until: Date | null;
  }>(db, `SELECT * FROM rotate_webhook_endpoint_secret($1, $2::uuid, $3, $4)`, [agentId, endpointId, kid, via]);
  if (row?.r_outcome === 'rate_limited') return { kind: 'rate_limited' };
  if (
    row?.r_outcome !== 'rotated' ||
    row.r_secret_kid === null ||
    row.r_secret_version === null ||
    row.r_rotated_at === null ||
    row.r_previous_valid_until === null
  ) {
    return { kind: 'not_found' };
  }
  return {
    kind: 'rotated',
    kid: row.r_secret_kid,
    version: row.r_secret_version,
    changedAt: row.r_rotated_at,
    previousValidUntil: row.r_previous_valid_until,
  };
}

/** `stale` — 봉인한 세대가 지금 세대 + 1 이 아니다(그 사이 다른 설정 · 지우기가 있었다, 재검증 L2). */
export type WebhookAuthorizationWrite = 'set' | 'not_found' | 'not_allowed' | 'stale';

/**
 * 인증 헤더 봉인값 적기 — SECURITY DEFINER `set_webhook_endpoint_authorization` 하나로만(202610141400 — 앱·admin 롤은 표 쓰기 0). (에이전트,
 * 엔드포인트) 짝이 맞는 **켜진** 행만. 앱 롤은 **등록과 같은 트랜잭션**에서 처음 한 번만 된다(`not_allowed`). 봉인은 호출자가 한다
 * (`webhooks/authorization.ts` — 키 묶음은 api λ 에만 있다). 평문은 이 함수에 오지 않는다.
 */
export async function setWebhookEndpointAuthorization(
  db: Queryable,
  input: {
    readonly agentId: AgentId;
    readonly endpointId: string;
    readonly kid: string;
    readonly sealed: string;
    readonly hint: string;
    /** 봉인에 쓴 세대 — 지금 세대 + 1(행이 없으면 1)이어야 한다. */
    readonly generation: number;
    readonly via: WebhookRotationVia;
  },
): Promise<WebhookAuthorizationWrite> {
  const row = await selectRow<{ outcome: string }>(db, `SELECT set_webhook_endpoint_authorization($1, $2::uuid, $3, $4, $5, $6, $7) AS outcome`, [
    input.agentId,
    input.endpointId,
    input.kid,
    input.sealed,
    input.hint,
    input.generation,
    input.via,
  ]);
  const outcome = row?.outcome;
  if (outcome === 'set' || outcome === 'not_found' || outcome === 'not_allowed' || outcome === 'stale') return outcome;
  throw new Error('set_webhook_endpoint_authorization 가 알 수 없는 결과를 돌려주었다');
}

/** 엔드포인트의 다음 인증 헤더 세대(행이 없으면 1) — 봉인 전에 api λ 가 읽는다(앱 롤 SELECT). 설정 함수가 같은 값을 다시 확인한다. */
export async function nextWebhookAuthorizationGeneration(db: Queryable, endpointId: string): Promise<number> {
  const row = await selectRow<{ generation: number }>(db, 'SELECT generation FROM webhook_endpoint_authorizations WHERE endpoint_id = $1::uuid', [endpointId]);
  return (row?.generation ?? 0) + 1;
}

/** 인증 헤더 지우기 — 정의자 `clear_webhook_endpoint_authorization`(admin 롤만 EXECUTE). 지울 값이 없으면 `none`. */
export async function clearWebhookEndpointAuthorization(
  db: Queryable,
  agentId: AgentId,
  endpointId: string,
  via: WebhookRotationVia,
): Promise<'cleared' | 'none' | 'not_found'> {
  const row = await selectRow<{ outcome: string }>(db, `SELECT clear_webhook_endpoint_authorization($1, $2::uuid, $3) AS outcome`, [
    agentId,
    endpointId,
    via,
  ]);
  const outcome = row?.outcome;
  if (outcome === 'cleared' || outcome === 'none' || outcome === 'not_found') return outcome;
  throw new Error('clear_webhook_endpoint_authorization 가 알 수 없는 결과를 돌려주었다');
}

/**
 * 재등록 상한의 분자 — 에이전트가 **최근 24시간** 등록한 엔드포인트 수(비활성 포함, 202609260115 ③). 시각은 DB `now()` 다 — `created_at` 의
 * 기본값과 같은 시계여야 경계가 어긋나지 않는다. 호출자는 advisory 잠금(`webhook_endpoints_active:<agent>`) 아래에서 센다.
 */
export async function countRecentWebhookRegistrations(db: Queryable, agentId: AgentId): Promise<number> {
  const row = await selectRow<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM webhook_endpoints WHERE agent_id = $1 AND created_at > now() - interval '24 hours'`,
    [agentId],
  );
  return row?.n ?? 0;
}

/**
 * 소프트 삭제 — SECURITY DEFINER `disable_webhook_endpoint` 하나로만(앱 롤은 이 표 UPDATE 가 없다). (에이전트, 엔드포인트) 짝이 맞는 **켜진**
 * 행만 끄고 그 시각을 돌려준다. 없거나 남의 것이거나 이미 꺼졌으면 `null`. 되살리는 길은 없다(쓰기 1회 트리거).
 */
export async function disableWebhookEndpoint(db: Queryable, agentId: AgentId, endpointId: string): Promise<Date | null> {
  const row = await selectRow<{ disabled_at: Date | null }>(db, `SELECT disable_webhook_endpoint($1, $2::uuid) AS disabled_at`, [
    agentId,
    endpointId,
  ]);
  return row?.disabled_at ?? null;
}

/**
 * 이벤트 → 에이전트의 활성 엔드포인트 중 **그 종류를 구독한** 것마다 outbox 1행. 반환값은 **새로 적힌** 행 수.
 *
 * 구독(메일 기본기 A4): `event_types IS NULL` 인 엔드포인트는 옛 4종(`LEGACY_EVENT_TYPES`)만 받는다 — 새 종류는 적은 엔드포인트에만 간다
 * (opt-in, 기존 수신측이 모르는 `type` 을 받지 않게). 적은 엔드포인트는 적은 것만 받는다.
 *
 * 같은 `dedupeKey` 가 이미 적힌 엔드포인트는 건너뛴다(`ON CONFLICT DO NOTHING`) — 스위퍼가
 * 같은 approval 을 두 번 만료시켜도 수신측에는 1회다(AC-d3). 엔드포인트가 0개면 0행이고
 * 그것은 오류가 아니다(웹훅을 등록하지 않은 에이전트는 폴링한다).
 */
export async function enqueueWebhookEvent(db: Queryable, event: WebhookEvent, now: Date): Promise<number> {
  const result = await db.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at)
     SELECT $1, e.id, $2::webhook_event_type, $3, $4, $5
       FROM webhook_endpoints e
      WHERE e.agent_id = $6 AND e.disabled_at IS NULL
        AND $2::webhook_event_type = ANY (COALESCE(e.event_types, $7::webhook_event_type[]))
     ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING`,
    [event.eventId, event.type, event.dedupeKey, event.body, now, event.agentId, [...LEGACY_EVENT_TYPES]],
  );
  return result.rowCount ?? 0;
}

interface ClaimRow {
  id: string;
  event_id: string;
  body: string;
  attempt_count: number;
  endpoint_id: string;
  url: string;
  secret_kid: string;
  secret_version: number;
  previous_secret_kid: string | null;
  previous_secret_version: number | null;
  previous_secret_valid_until: Date | null;
  authorization_kid: string | null;
  authorization_sealed: string | null;
  authorization_generation: number | null;
  agent_id: string;
  disabled: boolean;
}

/** `last_http_status` CHECK(100–599) 밖의 값은 기록하지 않는다 — 상태 코드가 없던 것과 같다. */
function storableStatus(status: number | null): number | null {
  return status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function createPostgresWebhookOutbox(pool: Pool): WebhookOutboxPort {
  return {
    async claimDue(now: Date, limit: number, leaseMs: number): Promise<readonly ClaimedDelivery[]> {
      // `FOR UPDATE SKIP LOCKED` — 워커가 여럿이어도 같은 행을 동시에 집지 않는다.
      // 집는 순간 `attempt_count` 를 올리고 `next_attempt_at` 을 임대 만료로 민다: 보내다 죽으면
      // 임대가 풀린 뒤 다시 집히고, 그 시도는 이미 센 것이다(dispatcher.ts 머리말). `last_attempt_at` 은 콘솔 전달 목록의 "마지막 시도"다.
      // 직전 시크릿(회전 유예, 202609301410)도 함께 읽는다 — 유예 안이면 디스패처가 둘 다로 서명한다.
      // 인증 헤더 봉인값(202610141400)은 **지금 값**을 읽는다 — 재시도·재전송도 집는 순간의 값으로 나간다(지웠으면 싣지 않는다).
      const rows = await selectRows<ClaimRow>(
        pool,
        `WITH due AS (
           SELECT id FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= $1
            ORDER BY next_attempt_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE webhook_deliveries d
            SET attempt_count = d.attempt_count + 1,
                next_attempt_at = $1::timestamptz + ($3::integer * interval '1 millisecond'),
                last_attempt_at = $1
           FROM due, webhook_endpoints e
          WHERE d.id = due.id AND e.id = d.endpoint_id
         RETURNING d.id, d.event_id, d.body, d.attempt_count,
                   e.id AS endpoint_id, e.url, e.secret_kid, e.secret_version,
                   e.previous_secret_kid, e.previous_secret_version, e.previous_secret_valid_until,
                   e.agent_id::text AS agent_id,
                   (SELECT a.key_kid FROM webhook_endpoint_authorizations a WHERE a.endpoint_id = e.id) AS authorization_kid,
                   (SELECT a.sealed FROM webhook_endpoint_authorizations a WHERE a.endpoint_id = e.id) AS authorization_sealed,
                   (SELECT a.generation FROM webhook_endpoint_authorizations a WHERE a.endpoint_id = e.id) AS authorization_generation,
                   (e.disabled_at IS NOT NULL) AS disabled`,
        [now, limit, leaseMs],
      );
      return rows.map((row) => ({
        deliveryId: row.id,
        eventId: row.event_id,
        body: row.body,
        attempt: row.attempt_count,
        endpoint: {
          id: row.endpoint_id,
          url: row.url,
          secretKid: row.secret_kid,
          secretVersion: row.secret_version,
          previousSecret:
            row.previous_secret_kid === null || row.previous_secret_version === null || row.previous_secret_valid_until === null
              ? null
              : { kid: row.previous_secret_kid, version: row.previous_secret_version, validUntil: row.previous_secret_valid_until },
          agentId: row.agent_id,
          authorization:
            row.authorization_kid === null || row.authorization_sealed === null || row.authorization_generation === null
              ? null
              : { kid: row.authorization_kid, sealed: row.authorization_sealed, generation: row.authorization_generation },
          disabled: row.disabled,
        },
      }));
    },

    // 아래 셋의 `WHERE attempt_count = $2 AND status = 'pending'` 이 펜싱이다 — 임대가 만료돼
    // 다른 워커가 다시 집었다면 attempt_count 가 올라가 있어 0행이 되고, 늦게 끝난 쪽이
    // 결과를 덮어쓰지 않는다.
    async markDelivered(deliveryId: string, attempt: number, now: Date, httpStatus: number): Promise<boolean> {
      const result = await pool.query(
        `UPDATE webhook_deliveries
            SET status = 'delivered', delivered_at = $3, last_http_status = $4, last_error = NULL
          WHERE id = $1 AND attempt_count = $2 AND status = 'pending'`,
        [deliveryId, attempt, now, storableStatus(httpStatus)],
      );
      return result.rowCount === 1;
    },

    async scheduleRetry(
      deliveryId: string,
      attempt: number,
      nextAttemptAt: Date,
      errorKind: DeliveryErrorKind,
      httpStatus: number | null,
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE webhook_deliveries
            SET next_attempt_at = $3, last_error = $4, last_http_status = $5
          WHERE id = $1 AND attempt_count = $2 AND status = 'pending'`,
        [deliveryId, attempt, nextAttemptAt, errorKind, storableStatus(httpStatus)],
      );
      return result.rowCount === 1;
    },

    async markDead(
      deliveryId: string,
      attempt: number,
      now: Date,
      errorKind: DeliveryErrorKind,
      httpStatus: number | null,
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE webhook_deliveries
            SET status = 'dead', dead_at = $3, last_error = $4, last_http_status = $5
          WHERE id = $1 AND attempt_count = $2 AND status = 'pending'`,
        [deliveryId, attempt, now, errorKind, storableStatus(httpStatus)],
      );
      return result.rowCount === 1;
    },
  };
}

// ---------------------------------------------------------------------------
// ④ 전달 목록 · 재전송 (메일 기본기 1차 A4)
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'dead';

export const WEBHOOK_DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = ['pending', 'delivered', 'dead'];

/**
 * 전달 한 건의 **목록 모양** — 본문(`body`)·URL·dedupe 키가 **없다.** 본문은 이벤트 id 로 이미 받은(또는 받을) 것이고, URL 은 엔드포인트 목록에
 * 있다. 목록이 그것들을 다시 실을 이유가 없다 — 이 타입에 자리가 없으므로 응답이 실을 수 없다.
 */
export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly endpointId: string;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  /** 닫힌 어휘(`DeliveryErrorKind`). */
  readonly lastError: string | null;
  readonly lastHttpStatus: number | null;
  /** 재전송 행이면 루트 id. */
  readonly redeliveryOf: string | null;
  readonly createdAt: Date;
  readonly nextAttemptAt: Date;
  /** 마지막 시도를 집은 시각(202609301410). 그 전 행은 `null`. */
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly deadAt: Date | null;
  /** 커서용 — `created_at` 의 에포크 마이크로초(10진 문자열). `Date` 는 밀리초라 같은 밀리초 안의 행 순서를 잃는다. */
  readonly createdMicros: string;
}

/** 목록 커서 — (created_at 마이크로초, id). 최신순이므로 이 값보다 **작은** 행이 다음 쪽이다. */
export interface WebhookDeliveryCursor {
  readonly createdMicros: string;
  readonly id: string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  endpoint_id: string;
  status: WebhookDeliveryStatus;
  attempt_count: number;
  last_error: string | null;
  last_http_status: number | null;
  redelivery_of: string | null;
  created_at: Date;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  delivered_at: Date | null;
  dead_at: Date | null;
  created_micros: string;
}

/**
 * 목록 질의의 안쪽(LATERAL)이 읽는 칸 — `body` 가 **없다**. admin 롤은 전달 표를 `body` 를 뺀 칸 단위로만 읽는다(202609301410 ⑨ · 재검토 L-3)
 * — `SELECT *` 는 그 롤에서 권한 오류다. 콘솔과 에이전트 API 가 이 질의를 함께 쓴다.
 */
const DELIVERY_LIST_SOURCE_COLUMNS = `d.id, d.event_id, d.event_type, d.endpoint_id, d.status, d.attempt_count, d.last_error, d.last_http_status,
            d.redelivery_of, d.created_at, d.next_attempt_at, d.last_attempt_at, d.delivered_at, d.dead_at`;

/**
 * 에이전트의 전달(삭제된 엔드포인트의 것 포함 — 기록이다), 최신순. 호출자는 `limit + 1` 을 넘겨 다음 쪽 여부를 안다.
 *
 * **엔드포인트마다 색인으로 `limit` 행만 읽고 합친다**(코드 리뷰 M4). `JOIN … ORDER BY d.created_at DESC LIMIT` 는 엔드포인트별 색인
 * (`webhook_deliveries_endpoint_created_idx` — endpoint_id, created_at DESC, id DESC)으로 병합 순서를 만들 수 없어 페이지마다 에이전트의
 * 전달 전부를 읽고 정렬한다(전달 행은 지우지 않는다 — 삭제된 엔드포인트도 쌓인다). `webhook_endpoints e CROSS JOIN LATERAL (… LIMIT)` 은
 * 엔드포인트 E 개 × `limit` 행만 색인 순서로 읽고 바깥에서 E × limit 행만 정렬한다. 커서 조건은 안쪽에 있어야 색인 범위 조건이 된다.
 */
export async function listWebhookDeliveries(
  db: Queryable,
  agentId: AgentId,
  options: {
    readonly limit: number;
    readonly cursor: WebhookDeliveryCursor | null;
    readonly status: WebhookDeliveryStatus | null;
    /** 엔드포인트 하나로 좁힌다(콘솔 `webhookId`). 에이전트의 것이 아니면 0행이다(바깥 `e.agent_id` 조건). */
    readonly endpointId?: string | null;
  },
): Promise<readonly WebhookDeliveryRecord[]> {
  const rows = await selectRows<DeliveryRow>(
    db,
    `SELECT d.id, d.event_id, d.event_type::text AS event_type, d.endpoint_id, d.status::text AS status, d.attempt_count,
            d.last_error, d.last_http_status, d.redelivery_of, d.created_at, d.next_attempt_at, d.last_attempt_at, d.delivered_at, d.dead_at,
            floor(extract(epoch FROM d.created_at) * 1000000)::bigint::text AS created_micros
       FROM webhook_endpoints e
       CROSS JOIN LATERAL (
         SELECT ${DELIVERY_LIST_SOURCE_COLUMNS} FROM webhook_deliveries d
          WHERE d.endpoint_id = e.id
            AND ($2::webhook_delivery_status IS NULL OR d.status = $2::webhook_delivery_status)
            AND ($3::bigint IS NULL
                 OR (d.created_at, d.id) < (timestamptz 'epoch' + $3::bigint * interval '1 microsecond', $4::uuid))
          ORDER BY d.created_at DESC, d.id DESC
          LIMIT $5
       ) d
      WHERE e.agent_id = $1 AND ($6::uuid IS NULL OR e.id = $6::uuid)
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $5`,
    [agentId, options.status, options.cursor?.createdMicros ?? null, options.cursor?.id ?? null, options.limit, options.endpointId ?? null],
  );
  return rows.map(toDeliveryRecord);
}

function toDeliveryRecord(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    endpointId: row.endpoint_id,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    lastHttpStatus: row.last_http_status,
    redeliveryOf: row.redelivery_of,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    deadAt: row.dead_at,
    createdMicros: row.created_micros,
  };
}

/** 전달 하나(에이전트의 것만 — 삭제된 엔드포인트 포함). 없거나 다른 에이전트의 것이면 `null`. */
export async function findWebhookDelivery(db: Queryable, agentId: AgentId, deliveryId: string): Promise<WebhookDeliveryRecord | null> {
  const row = await selectRow<DeliveryRow>(
    db,
    `SELECT d.id, d.event_id, d.event_type::text AS event_type, d.endpoint_id, d.status::text AS status, d.attempt_count,
            d.last_error, d.last_http_status, d.redelivery_of, d.created_at, d.next_attempt_at, d.last_attempt_at, d.delivered_at, d.dead_at,
            floor(extract(epoch FROM d.created_at) * 1000000)::bigint::text AS created_micros
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.id = $1::uuid AND e.agent_id = $2`,
    [deliveryId, agentId],
  );
  return row === null ? null : toDeliveryRecord(row);
}

/**
 * 엔드포인트마다 **가장 최근 전달 하나**(콘솔 웹훅 목록의 "마지막 전달"). 지운 엔드포인트 포함. 엔드포인트별 색인
 * (`webhook_deliveries_endpoint_created_idx`)으로 한 행씩만 읽는다. 전달이 없는 엔드포인트는 결과에 없다.
 */
export async function latestWebhookDeliveries(db: Queryable, agentId: AgentId): Promise<ReadonlyMap<string, WebhookDeliveryRecord>> {
  const rows = await selectRows<DeliveryRow>(
    db,
    `SELECT d.id, d.event_id, d.event_type::text AS event_type, d.endpoint_id, d.status::text AS status, d.attempt_count,
            d.last_error, d.last_http_status, d.redelivery_of, d.created_at, d.next_attempt_at, d.last_attempt_at, d.delivered_at, d.dead_at,
            floor(extract(epoch FROM d.created_at) * 1000000)::bigint::text AS created_micros
       FROM webhook_endpoints e
       CROSS JOIN LATERAL (
         SELECT ${DELIVERY_LIST_SOURCE_COLUMNS} FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1
       ) d
      WHERE e.agent_id = $1`,
    [agentId],
  );
  return new Map(rows.map((row) => [row.endpoint_id, toDeliveryRecord(row)]));
}

/** 루트 하나가 받을 수 있는 재전송 수의 천장. DB 모양 CHECK(`redelivery:<루트>:[1-3]`)·가드 트리거와 같은 값이다. */
export const MAX_REDELIVERIES_PER_ROOT = 3;

/**
 * 에이전트 하나가 1시간에 만들 수 있는 재전송 행 수(보안 L5). 루트당 3회 천장만으로는 dead 행이 많은 에이전트가 수신측(또는 SSRF 검사를 통과한
 * 임의 URL)을 재전송으로 두드릴 수 있다 — 에이전트 단위 바닥을 둔다. 창은 DB `now()` 기준 최근 1시간(`created_at` 기본값과 같은 시계).
 */
export const MAX_REDELIVERIES_PER_AGENT_HOURLY = 100;

export type RedeliveryResult =
  | {
      readonly kind: 'redelivered';
      readonly deliveryId: string;
      readonly redeliveryOf: string;
      readonly eventId: string;
      /** 이 루트의 몇 번째 재전송인가(1..3). */
      readonly ordinal: number;
    }
  /** 없거나 다른 에이전트의 것 — 같은 404 로 답한다(존재를 알리지 않는다). */
  | { readonly kind: 'not_found' }
  /** `dead` 가 아니다(pending 은 아직 시도 중, delivered 는 이미 받았다). */
  | { readonly kind: 'not_dead' }
  | { readonly kind: 'endpoint_disabled' }
  | { readonly kind: 'destination_rejected' }
  /** 가족(루트 + 재전송) 중 하나가 이미 `delivered` 다 — 수신측은 이 이벤트를 받았다(코드 리뷰 L13). */
  | { readonly kind: 'already_delivered' }
  | { readonly kind: 'limit_reached' }
  /** 에이전트의 최근 1시간 재전송이 `MAX_REDELIVERIES_PER_AGENT_HOURLY` 에 닿았다(보안 L5). */
  | { readonly kind: 'agent_rate_limited' };

/**
 * 재전송 — 정의자 함수 `redeliver_webhook_delivery` 하나(202609301410 · 보안 M2). 규칙은 예전 이 함수가 하던 것 그대로 함수 안에 있다: 대상 확인 →
 * 루트 잠금 → dead · 켜진 엔드포인트 · 목적지 거부류 없음 · 가족에 delivered 없음 · 루트당 3회 → 에이전트 잠금 → 시간당 100 → 새 행 INSERT(루트에서만
 * 복사 — 본문·이벤트·엔드포인트를 호출자가 고를 수 없다). 재전송 행을 지정하면 그 **루트**로 귀속된다. 가드 트리거
 * (`webhook_deliveries_redelivery_guard`)가 같은 잠금 키 아래에서 한 번 더 본다. `now` 는 새 행의 `next_attempt_at`.
 */
export async function redeliverWebhookDelivery(
  pool: Pool,
  agentId: AgentId,
  deliveryId: string,
  now: Date,
): Promise<RedeliveryResult> {
  return withTransaction(pool, async (client): Promise<RedeliveryResult> => {
    const row = await selectRow<{
      r_outcome: RedeliveryResult['kind'];
      r_delivery_id: string | null;
      r_redelivery_of: string | null;
      r_event_id: string | null;
      r_ordinal: number | null;
    }>(client, `SELECT * FROM redeliver_webhook_delivery($1, $2::uuid, $3)`, [agentId, deliveryId, now]);
    if (row === null) throw new Error('redeliver_webhook_delivery 가 행을 돌려주지 않았다');
    if (row.r_outcome !== 'redelivered') return { kind: row.r_outcome } as RedeliveryResult;
    if (row.r_delivery_id === null || row.r_redelivery_of === null || row.r_event_id === null || row.r_ordinal === null) {
      throw new Error('redeliver_webhook_delivery 가 빈 결과를 돌려주었다');
    }
    return { kind: 'redelivered', deliveryId: row.r_delivery_id, redeliveryOf: row.r_redelivery_of, eventId: row.r_event_id, ordinal: row.r_ordinal };
  });
}
