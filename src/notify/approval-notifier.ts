/**
 * src/notify/approval-notifier.ts — **소유자 승인 알림의 전용 발송 경로** (P2, §3.4 5조 — 리드 결정 (b)).
 *
 * ===========================================================================
 * ## 왜 관문을 지나지 않는가 (선택지 (a) 기각 요약)
 * ===========================================================================
 *
 * 알림을 에이전트 메일처럼 관문에 태우면: Stage 1 에서 `notify@` 는 에이전트 주소가 아니라 `from_forgery`,
 * Stage 7 에서 소유자 주소가 다시 승인을 요구하는 **무한 회귀**, 그리고 워밍업 캡을 먹어 Day 0(캡 20)에
 * 전환 공지 20통이면 **알림이 막히고 요청은 만료**된다. audit "시도당 1행" 과 AC-0 활동 분모도 오염된다.
 *
 * ===========================================================================
 * ## 그 대가 — 이 경로가 에이전트 메일의 우회로가 되면 안 된다. 그것을 **정적으로** 닫는다
 * ===========================================================================
 *
 * 1. **공개 API 는 `approvalId` 하나만 받는다.** 수신자·제목·본문을 인자로 받는 함수가 이 모듈에
 *    **존재하지 않는다.** 팩토리의 의존성에도 문자열이 없다(풀·SES 호출면·서명 키·시계뿐) — 발신 주소도
 *    승인 페이지 URL 도 주입할 수 없는 상수다(주입 가능한 URL 은 곧 피싱 링크의 입구다).
 * 2. **수신자는 DB 의 `organizations.owner_email` 에서만 나온다** — approval → agent → organization.
 *    그 컬럼을 **읽는** 코드는 `src/**` 에서 이 파일 하나다(프로비저닝 저장소는 쓰기만 한다).
 * 3. **이 파일이 전송단에서 쓰는 것은 알림 전송면뿐이다** — 에이전트 전송단(`createSesTransport`)을
 *    참조하면 이 파일이 `TransportRequest` 를 조립하는 두 번째 관문이 된다.
 *
 * 셋 다 `test/arch/gate-chokepoint.arch.test.ts` 의 "알림 경로" 절이 ts-morph 로 단언하고, 이 파일은 그
 * 층의 전송단 참조 허용목록에 **이름으로** 올라 있다(와일드카드 없음).
 *
 * ===========================================================================
 * ## 요청당 정확히 1통 · 조직당 속도 상한
 * ===========================================================================
 *
 * - outbox 행(`approval_notifications`)은 `approval_requests` INSERT 트리거가 **같은 트랜잭션**에서 만든다
 *   (`202609222100_*`). `approval_id` 유니크가 "요청당 1행" 을 집행하고, 종단 행은 트리거가 동결한다 —
 *   재전달·재실행이 두 번째 알림을 만들 수 없다.
 * - 집기(claim)는 `FOR UPDATE SKIP LOCKED` + 임대(`next_attempt_at` 을 미래로). **알려진 창:** SES 가 받은 뒤
 *   `sent` 를 적기 전에 프로세스가 죽으면 임대 만료 후 한 번 더 나간다. 중복 알림은 안전하다 — 같은 요청의
 *   링크 둘은 approval 당 1회 사용(`approval_link_uses`)을 공유한다. **유실**(요청이 아무도 모른 채 만료)이
 *   더 나쁜 실패라서 at-least-once 쪽을 골랐다.
 * - **조직당 속도 상한 `APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG`** — 아래 상수 주석에 값과 근거.
 */

import type { Pool, PoolClient } from 'pg';

import { buildApprovalLinkUrl, mintApprovalLinkToken } from '../approval/magic-link';
import { withTransaction } from '../db/client';
import { selectRow, selectRows } from '../db/repositories/rows';
import { DEFAULT_MAIL_LOCALE, type MailLocale } from '../i18n/locales';
import { createSesNotificationTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import type { HmacKeyring } from '../security/hmac-keyring';
import { orderedRiskReasons } from '../approval/risk-copy';
import { RISK_HOLD_REASONS } from '../policy/rules/risk-hold';
import type { InjectionRisk } from '../policy/types';
import {
  MAX_ITEMS_SHOWN,
  MAX_RISK_SOURCES_SHOWN,
  approvalConsoleLink,
  renderApprovalNotification,
  type ApprovalNotificationItem,
  type ApprovalRiskView,
} from './approval-notification-template';
import { recipientLocales } from './recipient-locale';

/**
 * 발신 주소. **상수다** — 설정·의존성으로 열면 발신 주소를 고르는 코드가 생긴다.
 * `notify` 로컬파트는 에이전트에게 발급할 수 없다(`identity/address.ts` 예약) — 에이전트가 이 주소를
 * 가지면 승인 알림과 구별되지 않는 메일을 소유자에게 보낼 수 있다.
 */
export const APPROVAL_NOTIFY_FROM_ADDRESS = 'notify@atmark.ai';
/** raw MIME 헤더 `From` — 받은편지함에 "notify" 대신 "Atmark" 로 보이게(2026-10-07). 격리 · 도메인 알림도 같은 모양. 전송단이 글자 그대로 대조한다. */
export const APPROVAL_NOTIFY_FROM_HEADER = `"Atmark" <${APPROVAL_NOTIFY_FROM_ADDRESS}>`;

/**
 * 승인 페이지(`src/api/routes/approval-link.ts` 의 `GET|HEAD|POST /approve`). 토큰은 fragment(`#`)에
 * 실린다(`magic-link.ts` 위협 T3·T6). **상수다** — 주입 가능하면 조립 루트 하나가 링크를 다른 호스트로
 * 돌릴 수 있다. 환경 변수(`ATMARK_APPROVAL_PAGE_URL`)도 읽지 않는다 — 그 값은 운영 설정 한 줄로 바뀐다.
 *
 * 호스트는 **API 커스텀 도메인**이다(`infra/cdk/stacks/api-certificate-stack.ts` 의 `API_DOMAIN_NAME`) — HTTP API 가
 * 붙는 곳이 거기뿐이라 `atmark.ai` 로 적으면 소유자 링크가 404 다. 컴퓨트 스택의 출력 `ApprovalPageUrl` 과
 * 이 값의 일치는 `test/unit/notify/approval-page-url.test.ts` 가 스택을 합성해 맞붙인다.
 */
export const APPROVAL_PAGE_URL = 'https://api.atmark.ai/approve';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 id 와 같다(`policy/manifest.ts`). */
export const APPROVAL_NOTIFY_ROUTE_ID = 'approval_notify';

/**
 * **조직당 알림 속도 상한: 시간당(롤링 60분) 10통.** 초과분은 큐에 남는다(`deferred`).
 *
 * 근거 세 가지:
 *   ① **승인 피로 공격(MFA fatigue 의 승인판).** 에이전트가 승인 요청을 1000개 만들면 소유자 메일함에
 *      1000통이다 — 그 흐름 안에서 소유자는 결국 읽지 않고 누른다. 상한은 "사람이 한 시간에 실제로 읽고
 *      판단할 수 있는 수" 다. 10을 넘는 요청이 한 시간에 쏟아지는 것 자체가 이상 신호이고, 그 신호는
 *      `notification_deferred` 메트릭으로 드러난다.
 *   ② **도메인 평판.** `notify@` 는 에이전트들과 같은 `atmark.ai` 도메인이다. 한 수신함에 같은 발신자가
 *      분당 수십 통을 꽂으면 수신측(Gmail 등)의 수신자별 속도 제한·스팸 분류에 걸리고, 그 평판 손상은
 *      **모든 에이전트의 도달률**로 번진다(AC-2).
 *   ③ **만료와의 관계.** TTL 최소가 1시간(§3.4 4조)이므로 상한이 시간 단위면 대기 중인 알림은 최악의 경우
 *      다음 창에서 나간다. 창을 넘겨도 못 나간 알림은 요청이 만료되면 `obsolete` 로 닫힌다 — 결정할 수 없는
 *      링크는 보내지 않는다. 즉 폭주 때 **오래된 요청부터** 알려지고, 나머지는 막히는 방향으로 끝난다.
 *
 * 세는 것은 보낸 수가 아니라 **시도 수**다 — 창 안에서 집힌(`claimed_at`) 행들의 `attempt_count` 합.
 * 실패한 시도도 수신함에 닿았을 수 있다(SES 가 받은 뒤 응답이 끊긴 경우). 행 하나의 재시도(최대 5회,
 * 간격 1·2·4·8분)는 `claimed_at` 을 덮어쓰므로 행 수(`count(*)`)로 세면 재시도가 1통으로 접힌다 — 그래서 합을
 * 쓴다. 합은 **위로만** 틀린다: 창 밖에서 한 이전 시도까지 마지막 집기 시각의 창에 얹힌다(보수적 방향).
 * 계수와 집기는 조직 단위 advisory lock 아래 한 트랜잭션이라 워커가 여럿이어도 상한을 넘지 않는다.
 */
export const APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG = 10;

const RATE_WINDOW_MS = 60 * 60 * 1000;

/** 집은 뒤 결과를 적기까지의 임대. SES 호출 하나 + 렌더링이면 초 단위다. */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/** 전송 시도 상한. 넘으면 `dead` — 요청은 아무도 모른 채 만료된다(메트릭으로 드러난다). */
const MAX_ATTEMPTS = 5;

/** 재시도 간격의 바닥(ms). 시도마다 두 배. */
const RETRY_BASE_MS = 60 * 1000;

const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 알림 한 건의 결말.
 * - `sent` — SES 가 받았다.
 * - `deferred` — 조직 속도 상한. 큐에 남았다.
 * - `retry` — 전송이 실패했다. 뒤로 미뤘다.
 * - `dead` — 전송 시도를 다 썼다(종단).
 * - `undeliverable` — 소유자 이메일이 없다(종단).
 * - `obsolete` — 요청이 이미 결정·만료됐다(종단).
 * - `not_due` — 집을 것이 없다: 이미 끝났거나, 다른 워커가 쥐고 있거나, 아직 때가 아니다.
 */
export type ApprovalNotifyOutcome = 'sent' | 'deferred' | 'retry' | 'dead' | 'undeliverable' | 'obsolete' | 'not_due';

/**
 * 의존성. **문자열이 하나도 없다** — 수신자·발신자·URL·제목·본문 중 어느 것도 여기로 들어올 수 없다.
 * (`test/arch/gate-chokepoint.arch.test.ts` 가 이 인터페이스의 속성 이름·타입을 동결한다.)
 */
export interface ApprovalNotifierDependencies {
  readonly pool: Pool;
  /** SES 호출면. 전송단의 알림면(`createSesNotificationTransport`)이 이것을 감싼다. */
  readonly client: SesSendClient;
  /** 승인 링크 서명 키 묶음(`ATMARK_APPROVAL_LINK_KEYS`). */
  readonly keyring: HmacKeyring;
  readonly now: () => Date;
}

/** 이 모듈의 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface ApprovalNotifier {
  notify(approvalId: string): Promise<ApprovalNotifyOutcome>;
}

// ---------------------------------------------------------------------------
// 집기 — 한 트랜잭션
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  organization_id: string;
  attempt_count: number;
  approval_status: string;
  expires_at: Date;
  agent_id: string;
  agent_name: string;
  agent_organization_id: string;
  organization_name: string;
  owner_email: string | null;
}

interface Claimed {
  readonly kind: 'claimed';
  readonly notificationId: string;
  readonly attempt: number;
  readonly ownerEmail: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** 조직 이름 — 본문의 피싱 구별 표지(2026-10-10). 받는 사람(그 조직의 주 소유자)이 지은 이름이다. */
  readonly organizationName: string;
  readonly expiresAt: Date;
}

type ClaimResult =
  | Claimed
  | { readonly kind: 'not_due'; readonly reason: null }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'undeliverable'; readonly reason: string }
  | { readonly kind: 'obsolete'; readonly reason: string };

async function settle(
  client: PoolClient,
  notificationId: string,
  status: 'undeliverable' | 'obsolete',
  reason: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE approval_notifications SET status = $2, settled_at = $3, last_error = $4
      WHERE id = $1 AND status = 'pending'`,
    [notificationId, status, now, reason],
  );
}

async function claim(client: PoolClient, approvalId: string, now: Date): Promise<ClaimResult> {
  // **수신자가 나오는 유일한 조회다.** approval → agent → organization. `approval_notifications.organization_id`
  // 는 속도 상한의 축일 뿐 수신자를 고르지 않는다 — 둘이 다르면 행이 오염된 것이고, 보내지 않는다.
  const row = await selectRow<CandidateRow>(
    client,
    `SELECT n.id, n.organization_id, n.attempt_count,
            r.status::text AS approval_status, r.expires_at,
            ag.id AS agent_id, ag.name AS agent_name, ag.organization_id AS agent_organization_id,
            o.name AS organization_name, o.owner_email
       FROM approval_notifications n
       JOIN approval_requests r ON r.id = n.approval_id
       JOIN agents ag ON ag.id = r.agent_id
       JOIN organizations o ON o.id = ag.organization_id
      WHERE n.approval_id = $1 AND n.status = 'pending' AND n.next_attempt_at <= $2
      FOR UPDATE OF n SKIP LOCKED`,
    [approvalId, now],
  );
  if (row === null) return { kind: 'not_due', reason: null };

  if (row.organization_id !== row.agent_organization_id) {
    throw new Error(
      `approval_notifications.organization_id 가 에이전트의 조직과 다르다 (approval=${approvalId}) — ` +
        '다른 조직의 소유자에게 보낼 수 있는 상태다. 보내지 않는다.',
    );
  }

  // 결정할 수 없는 링크는 보내지 않는다. 만료는 스위퍼보다 먼저 여기서 볼 수도 있다(스위퍼 주기 사이).
  if (row.approval_status !== 'pending') {
    await settle(client, row.id, 'obsolete', 'approval_not_pending', now);
    return { kind: 'obsolete', reason: 'approval_not_pending' };
  }
  if (row.expires_at.getTime() <= now.getTime()) {
    await settle(client, row.id, 'obsolete', 'approval_expired', now);
    return { kind: 'obsolete', reason: 'approval_expired' };
  }

  if (row.owner_email === null) {
    // **조용히 삼키지 않는다.** 종단으로 닫고(재시도해도 주소가 생기지 않는다) 호출자가 error 로그·메트릭을 낸다.
    await settle(client, row.id, 'undeliverable', 'owner_email_missing', now);
    return { kind: 'undeliverable', reason: 'owner_email_missing' };
  }

  // 조직 단위 직렬화 — 계수와 집기 사이에 다른 워커가 끼지 못한다. 트랜잭션이 끝나면 풀린다.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('approval_notify:' || $1::text, 0))`, [
    row.organization_id,
  ]);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);
  const usage = await selectRow<{ used: number; oldest: Date | null }>(
    client,
    `SELECT coalesce(sum(attempt_count), 0)::int AS used, min(claimed_at) AS oldest
       FROM approval_notifications
      WHERE organization_id = $1 AND claimed_at > $2`,
    [row.organization_id, windowStart],
  );
  if (usage !== null && usage.used >= APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG && usage.oldest !== null) {
    // 가장 오래된 집기가 창을 벗어나는 순간까지 민다 — 그 전에 다시 집어 봐야 또 막힌다.
    await client.query(
      `UPDATE approval_notifications SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`,
      [row.id, new Date(usage.oldest.getTime() + RATE_WINDOW_MS + 1)],
    );
    return { kind: 'deferred', reason: 'org_rate_cap' };
  }

  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE approval_notifications
        SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4
      WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );

  return {
    kind: 'claimed',
    notificationId: row.id,
    attempt,
    ownerEmail: row.owner_email,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    organizationName: row.organization_name,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// 렌더 재료 — 전부 DB 에서 다시 읽는다
// ---------------------------------------------------------------------------

interface ItemRow {
  message_id: string;
  recipients: string[];
  subject: string | null;
  attachment_count: number;
  attachment_bytes: string;
  attachment_names: string[] | null;
}

async function loadItems(
  pool: Pool,
  approvalId: string,
): Promise<{ readonly items: readonly ApprovalNotificationItem[]; readonly itemCount: number; readonly firstMessageId: string | null }> {
  const items = await selectRows<ItemRow>(
    pool,
    // 첨부 요약(메일 기본기 2차 · 보안 리뷰 L5) — 소유자가 무엇이 붙었는지 보고 승인한다. 파일명은 렌더가 무력화한다.
    `SELECT i.message_id, i.recipients, m.subject,
            (SELECT count(*)::int FROM message_attachments l WHERE l.message_id = i.message_id) AS attachment_count,
            (SELECT coalesce(sum(a.bytes), 0)::text FROM message_attachments l JOIN outbound_attachments a ON a.id = l.attachment_id
              WHERE l.message_id = i.message_id) AS attachment_bytes,
            (SELECT array_agg(a.filename ORDER BY l.position) FROM message_attachments l JOIN outbound_attachments a ON a.id = l.attachment_id
              WHERE l.message_id = i.message_id) AS attachment_names
       FROM approval_request_items i
       JOIN messages m ON m.id = i.message_id
      WHERE i.approval_id = $1
      ORDER BY i.created_at, i.message_id
      LIMIT $2`,
    [approvalId, MAX_ITEMS_SHOWN],
  );
  const count = await selectRow<{ n: number }>(
    pool,
    `SELECT count(*)::int AS n FROM approval_request_items WHERE approval_id = $1`,
    [approvalId],
  );
  return {
    items: items.map((row) => ({
      recipients: row.recipients,
      subject: row.subject,
      ...(row.attachment_count > 0
        ? { attachments: { count: row.attachment_count, bytes: Number(row.attachment_bytes), names: row.attachment_names ?? [] } }
        : {}),
    })),
    itemCount: count?.n ?? items.length,
    firstMessageId: items[0]?.message_id ?? null,
  };
}

/**
 * 위험 보류(ADR-0016) — 항목들의 audit 사유 중 위험 보류 사유, 오염 맥락이면 그 에이전트가 최근(요청 시각 기준 7일) 읽은 T2 메일의 **메타**(발신 주소 ·
 * 받은 시각 · DMARC · 위험도). 제목·본문은 읽지 않는다. 위험 보류가 아니면 `null`.
 */
async function loadRisk(pool: Pool, approvalId: string, agentId: string): Promise<ApprovalRiskView | null> {
  const reasons = await selectRows<{ reason: string }>(
    pool,
    `SELECT DISTINCT r AS reason
       FROM approval_request_items i
       JOIN audit_logs a ON a.id = i.audit_id
       CROSS JOIN LATERAL unnest(a.reasons) AS r
      WHERE i.approval_id = $1 AND r = ANY($2::text[])`,
    [approvalId, [...RISK_HOLD_REASONS]],
  );
  const ordered = orderedRiskReasons(reasons.map((row) => row.reason));
  if (ordered.length === 0) return null;
  if (!ordered.includes('tainted_context')) return { reasons: ordered, sources: [] };
  const sources = await selectRows<{ from_address: string; received_at: Date; from_authenticated: boolean; injection_risk: InjectionRisk | null }>(
    pool,
    `SELECT m.from_address, m.received_at, m.from_authenticated, m.injection_risk
       FROM agent_exposures e
       JOIN inbound_messages m ON m.id = e.inbound_message_id
       JOIN approval_requests r ON r.id = $2
      WHERE e.agent_id = $1 AND e.level >= 2 AND e.last_at > r.created_at - interval '7 days' AND e.last_at <= r.created_at + interval '5 minutes'
      ORDER BY e.last_at DESC
      LIMIT $3`,
    [agentId, approvalId, MAX_RISK_SOURCES_SHOWN],
  );
  return {
    reasons: ordered,
    sources: sources.map((row) => ({
      sender: row.from_address,
      receivedAt: row.received_at,
      authenticated: row.from_authenticated,
      injectionRisk: row.injection_risk,
    })),
  };
}

/**
 * 받는 사람(조직 주 소유자)의 메일 언어 — 정의자 함수가 그 조직의 멤버 · 주 소유자인 주소의 설정만 돌려준다(앱 롤은 users 권한 0). 없으면 'en'.
 * 언어는 **보내는 순간** 고른다(outbox 행에 저장하지 않는다 — 재시도 사이에 설정이 바뀌면 바뀐 언어로 나간다).
 */
async function ownerLocaleOf(pool: Pool, organizationId: string, email: string): Promise<MailLocale> {
  return (await recipientLocales(pool, organizationId, [email])).get(email) ?? DEFAULT_MAIL_LOCALE;
}

/** 알림 본문의 에이전트 주소 = **유효 대표**(ADR-0014 2026-10 개정 — 잠든 앵커는 싣지 않는다). 무효면(도메인을 잃었다) "주소 없음". */
async function agentAddressOf(pool: Pool, agentId: string): Promise<string | null> {
  const row = await selectRow<{ address: string | null }>(pool, `SELECT atmark_agent_primary_address($1) AS address`, [agentId]);
  return row?.address ?? null;
}

// ---------------------------------------------------------------------------
// 결말 기록
// ---------------------------------------------------------------------------

/**
 * `sent` 기록. **자기가 집은 시도일 때만**(`attempt_count` 일치) — 임대가 만료돼 다른 워커가 다시 집은
 * 뒤라면 0행이고, 그 사실을 로그로 남긴다(같은 요청에 알림이 두 통 나갔다는 뜻이다).
 */
async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE approval_notifications SET status = 'sent', sent_at = $3, ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.notificationId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

/** 실패 기록 — 시도가 남았으면 뒤로 미루고, 다 썼으면 `dead`. 둘 다 조건부(자기가 집은 시도만). */
async function markFailed(pool: Pool, claimed: Claimed, errorKind: string, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE approval_notifications SET status = 'dead', settled_at = $3, last_error = $4
        WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
      [claimed.notificationId, claimed.attempt, now, errorKind],
    );
    return 'dead';
  }
  const delay = RETRY_BASE_MS * 2 ** (claimed.attempt - 1);
  await pool.query(
    `UPDATE approval_notifications SET next_attempt_at = $3, last_error = $4
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.notificationId, claimed.attempt, new Date(now.getTime() + delay), errorKind],
  );
  return 'retry';
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * 알림기를 만든다. 반환하는 것은 `notify(approvalId)` **하나뿐**이다.
 *
 * `approvalId` 는 uuid 정규형만 받는다 — 문자열 인자 하나가 주소·본문의 통로가 되지 않도록 모양을
 * 먼저 닫는다(닫지 않아도 SQL 매개변수라 새지는 않지만, 모양이 틀린 값이 여기까지 온 것 자체가 호출부 버그다).
 */
export function createApprovalNotifier(deps: ApprovalNotifierDependencies): ApprovalNotifier {
  const transport = createSesNotificationTransport({ client: deps.client, now: deps.now });

  return {
    async notify(approvalId: string): Promise<ApprovalNotifyOutcome> {
      if (!APPROVAL_ID_PATTERN.test(approvalId)) {
        throw new Error(`approvalId 는 정규형 uuid 여야 한다: ${JSON.stringify(approvalId)}`);
      }

      const claimed = await withTransaction(deps.pool, (client) => claim(client, approvalId, deps.now()));

      if (claimed.kind === 'not_due') return 'not_due';
      if (claimed.kind === 'obsolete') {
        log('info', 'approval_notify.obsolete', {
          route_id: APPROVAL_NOTIFY_ROUTE_ID,
          approval_id: approvalId,
          reason: claimed.reason,
        });
        return 'obsolete';
      }
      if (claimed.kind === 'undeliverable') {
        log('error', 'approval_notify.undeliverable', {
          route_id: APPROVAL_NOTIFY_ROUTE_ID,
          approval_id: approvalId,
          reason: claimed.reason,
          detail:
            '조직에 owner_email 이 없다 — 이 승인 요청은 아무에게도 알려지지 않고 TTL 에 만료된다. ' +
            '소유자 이메일을 채워야 이후 요청이 알려진다.',
        });
        countMetric(METRIC_NAMES.approvalNotificationUndeliverable, { route_id: APPROVAL_NOTIFY_ROUTE_ID });
        return 'undeliverable';
      }
      if (claimed.kind === 'deferred') {
        log('warn', 'approval_notify.deferred', {
          route_id: APPROVAL_NOTIFY_ROUTE_ID,
          approval_id: approvalId,
          reason: claimed.reason,
        });
        countMetric(METRIC_NAMES.approvalNotificationDeferred, { route_id: APPROVAL_NOTIFY_ROUTE_ID });
        return 'deferred';
      }

      let sesMessageId: string;
      try {
        const [{ items, itemCount, firstMessageId }, agentAddress, risk, locale] = await Promise.all([
          loadItems(deps.pool, approvalId),
          agentAddressOf(deps.pool, claimed.agentId),
          loadRisk(deps.pool, approvalId, claimed.agentId),
          ownerLocaleOf(deps.pool, claimed.organizationId, claimed.ownerEmail),
        ]);
        // `expiresAt` 은 **방금 DB 에서 다시 읽은 값**이다(`magic-link.ts` 배선 규약 — 토큰 만료와 DB 만료가
        // 같아야 링크가 통한다). 관문이 들고 있던 값이나 잡의 값을 쓰지 않는다.
        const token = mintApprovalLinkToken(deps.keyring, { approvalId, expiresAt: claimed.expiresAt });
        // 주 링크 = 승인 확인 페이지(GET 은 확인 페이지만 — 보내기 · 거절은 그 페이지의 POST 버튼, `approval/magic-link.ts`) · 콘솔 딥 링크 하나.
        const rendered = renderApprovalNotification(
          {
            approvalId,
            agentName: claimed.agentName,
            organizationName: claimed.organizationName,
            agentAddress,
            expiresAt: claimed.expiresAt,
            link: buildApprovalLinkUrl(APPROVAL_PAGE_URL, token),
            consoleLink: approvalConsoleLink(claimed.agentId, firstMessageId),
            items,
            itemCount,
            risk,
          },
          locale,
        );
        ({ sesMessageId } = await transport.sendOwnerNotification({
          notificationId: claimed.notificationId,
          fromAddress: APPROVAL_NOTIFY_FROM_ADDRESS,
          fromHeader: APPROVAL_NOTIFY_FROM_HEADER,
          toAddress: claimed.ownerEmail,
          subject: rendered.subject,
          text: rendered.text,
          // 2026-10-10 — 공용 틀의 HTML 파트(주 버튼 "그래도 보내기" · 콘솔 링크). 에이전트가 쓴 문자열은 두 파트 어디에도 없다(템플릿 머리말).
          html: rendered.html,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, 'send_failed', deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'approval_notify.failed', {
          route_id: APPROVAL_NOTIFY_ROUTE_ID,
          approval_id: approvalId,
          outcome,
          detail: error instanceof Error ? error.message : String(error),
        });
        if (outcome === 'dead') {
          countMetric(METRIC_NAMES.approvalNotificationUndeliverable, { route_id: APPROVAL_NOTIFY_ROUTE_ID });
        }
        return outcome;
      }

      // 여기부터 알림은 **이미 나갔다.** 기록 실패로 던지면 호출자가 재시도해 두 번 나간다 — 던지지 않는다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'approval_notify.sent', {
        route_id: APPROVAL_NOTIFY_ROUTE_ID,
        approval_id: approvalId,
        ses_message_id: sesMessageId,
        settled,
      });
      countMetric(METRIC_NAMES.approvalNotificationSent, { route_id: APPROVAL_NOTIFY_ROUTE_ID });
      return 'sent';
    },
  };
}
