/**
 * src/notify/contact-forwarder.ts — **문의 전달의 전용 발송 경로** (US-009, ADR-0009). 네 번째 시스템 메일.
 *
 * `support@atmark.ai` 로 온 문의(수신 소비자가 받아들여 `contact_forwards` 에 적은 것)를 운영자 메일함 **한 곳**으로 새 메일로
 * 보낸다: From `support@atmark.ai`(DMARC 정렬) · To 전달 주소 · Reply-To 원 발신자 · 제목 `[Atmark 문의] …` · text/plain.
 *
 * ## 이 경로가 에이전트 메일의 우회로·임의 발송기가 되지 않게 — 승인 알림과 같은 규율
 *
 * 1. **공개 API 는 `forwardId` 하나만 받는다.** 수신자·제목·본문을 인자로 받는 함수가 이 모듈에 없다. 의존성에도 문자열이 없다
 *    (풀·SES 호출면·문서 리더·전달 주소 로더·시계).
 * 2. **수신자는 전달 주소 로더 하나에서만 나온다** — 조립 루트가 비밀 `atmark/contact-forward-to` 로 만든다(`src/contact/destination.ts`).
 *    메일 내용·헤더(To·Reply-To·Resent-To…)·DB 행 어디에서도 수신자를 읽지 않는다. 문서의 `fromAddress` 는 **Reply-To 로만** 간다.
 * 3. **이 파일이 전송단에서 쓰는 것은 문의 전달면뿐이다**(`createSesContactForwardTransport`) — 에이전트 전송단을 쥐지 않는다.
 * 4. 발신 주소는 상수다(`CONTACT_FORWARD_FROM_ADDRESS`). IAM 은 `support@` 발신을 이 함수(Lambda `atmark-contact-forwarder`)로만
 *    허락한다 — 같은 발송 역할을 쓰는 api 등에서는 명시 Deny(`compute-stack.ts` `SesDenySupportFromOutsideForwarder`). **단 `ATMARK_CONTACT_ROUTING`
 *    이 `forward` 가 아니면 그 Deny 는 없다**(2026-09-30) — support@ 가 지원 에이전트의 대표 주소가 되어 api(관문)가 그 주소로 회신한다.
 * 5. **알림만 모드**(`notifyOnly` — `agent_and_notify`)는 원 제목 + 보낸 사람 도메인만, Reply-To 없이 보낸다(`renderContactNotify`).
 *
 * `test/arch/gate-chokepoint.arch.test.ts` "문의 전달 경로" 절과 `test/arch/contact-forward.arch.test.ts` 가 단언한다.
 *
 * ## 닫힌 쪽으로 실패한다
 *
 * - 전달 주소를 읽지 못하면(자리값·모양 틀림·권한) **보내지 않는다** — 집기 전에 멈추므로 시도 횟수도 쓰지 않는다(`unconfigured`).
 * - 전달 주소 자신(별칭·Gmail 점·+태그 포함)이나 우리 도메인에서 온 문의는 보내지 않는다(`suppressed` — 루프).
 * - 문서 모양이 틀리면 종단(`dead`) — 재시도해도 같다.
 * - **차선별 시간당 상한**(수신 쪽과 같은 값 — support 30 · role 10, 202610021000)을 여기서도 센다 — 수신 쪽 계수를 우회해 행이 쌓여도
 *   (앱 롤로 INSERT) 나가는 양은 차선마다 같다. 차선은 행의 `lane`(불변 — 종단 동결 트리거)이고, 한 차선이 차도 다른 차선은 나간다.
 *
 * 멱등: 행 하나 = 한 통. 집기는 `FOR UPDATE SKIP LOCKED` + 임대. 알려진 창(승인 알림과 같다): SES 가 받은 뒤 `sent` 를 적기 전에
 * 죽으면 임대 만료 뒤 한 번 더 나간다 — 문의 유실보다 중복 한 통이 낫다.
 */

import type { Pool, PoolClient } from 'pg';

import type { ContactDocumentReader } from '../contact/contact-store';
import {
  CONTACT_ADDRESS,
  CONTACT_DOCUMENT_VERSION,
  CONTACT_TEXT_MAX_CHARS,
  CONTACT_FORWARD_LANE_HOURLY_CAP,
  CONTACT_FORWARD_ROUTE_ID,
  isForwardableAddress,
  isOwnDomain,
  type ContactForwardDocument,
  type ContactLane,
} from '../contact/intake';
import { withTransaction } from '../db/client';
import { selectRow } from '../db/repositories/rows';
import { isHumanMailbox } from '../gate/forwarded';
import { resolveMailLocale } from '../i18n/locales';
import { createSesContactForwardTransport, type SesSendClient } from '../mail/transport/ses-transport';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { renderContactForward, renderContactNotify } from './contact-forward-template';

/** 발신 주소 — **상수**. 문의 주소 자신이다(회신 스레드가 같은 주소로 보인다). IAM Deny 가 다른 Lambda 의 이 주소 발신을 막는다. */
export const CONTACT_FORWARD_FROM_ADDRESS = CONTACT_ADDRESS;

/** 관측 축 — `SYSTEM_MAIL_ENTRYPOINTS` 의 id. */
export const CONTACT_FORWARD_NOTIFY_ROUTE_ID = CONTACT_FORWARD_ROUTE_ID;

/** 전달 쪽 차선별 시간당 상한(시도 수) — 수신 쪽 상한과 같은 값(support 30 · role 10). */
export const CONTACT_FORWARD_HOURLY_SEND_CAP = CONTACT_FORWARD_LANE_HOURLY_CAP;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60 * 1000;
const FORWARD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 한 건의 결말.
 * - `sent` — SES 가 받았다.
 * - `deferred` — 그 행의 차선 상한. 큐에 남았다.
 * - `retry` — 전송·문서 읽기 실패. 뒤로 미뤘다.
 * - `dead` — 시도를 다 썼거나 문서 모양이 틀렸다(종단).
 * - `suppressed` — 루프(전달 주소 자신·우리 도메인에서 온 문의). 보내지 않았다(종단).
 * - `unconfigured` — 전달 주소 비밀이 비었다·읽지 못했다. **보내지 않았고 행은 그대로다.**
 * - `not_due` — 집을 것이 없다.
 */
export type ContactForwardOutcome = 'sent' | 'deferred' | 'retry' | 'dead' | 'suppressed' | 'unconfigured' | 'not_due';

/**
 * 의존성. **문자열이 하나도 없다.** `destination` 은 인자 없는 로더다 — 조립 루트가 비밀로 만든다(`src/contact/destination.ts`).
 * (`test/arch/gate-chokepoint.arch.test.ts` 가 속성 이름·타입을 동결한다.)
 */
export interface ContactForwarderDependencies {
  readonly pool: Pool;
  readonly client: SesSendClient;
  readonly documents: ContactDocumentReader;
  readonly destination: () => Promise<string | null>;
  readonly now: () => Date;
  /**
   * **알림만**(`ATMARK_CONTACT_ROUTING=agent_and_notify`, 2026-09-30) — 원 제목과 보낸 사람 도메인만 싣고 본문·Reply-To 없이 보낸다
   * (`renderContactNotify`). 원문은 지원 에이전트 수신함에 있다. 조립 루트가 환경에서 정한다(문자열이 아니다 — 수신자·내용을 고를 자리가 아니다).
   */
  readonly notifyOnly: boolean;
}

/** 이 모듈의 공개 API 전부. **메서드 하나, 인자 하나.** */
export interface ContactForwarder {
  forward(forwardId: string): Promise<ContactForwardOutcome>;
}

// ---------------------------------------------------------------------------
// 집기 — 한 트랜잭션
// ---------------------------------------------------------------------------

interface Claimed {
  readonly kind: 'claimed';
  readonly forwardId: string;
  readonly sesMessageId: string;
  readonly attempt: number;
}

type ClaimResult = Claimed | { readonly kind: 'not_due' } | { readonly kind: 'deferred'; readonly lane: ContactLane };

async function claim(client: PoolClient, forwardId: string, now: Date): Promise<ClaimResult> {
  const row = await selectRow<{ id: string; ses_message_id: string; attempt_count: number; lane: ContactLane }>(
    client,
    `SELECT id, ses_message_id, attempt_count, lane
       FROM contact_forwards
      WHERE id = $1 AND status = 'pending' AND next_attempt_at <= $2
      FOR UPDATE SKIP LOCKED`,
    [forwardId, now],
  );
  if (row === null) return { kind: 'not_due' };

  // 전역 직렬화 — 계수와 집기 사이에 다른 워커가 끼지 못한다. 계수는 차선별이지만 키는 하나다(워커 경합이 작고, 수신 쪽 키와 같은 규율).
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('contact_forward:send', 0))`);
  // 이 행의 차선만 센다. 모르는 값(CHECK 가 막지만)은 상한 0 — 닫힌 쪽으로 미룬다.
  const cap = CONTACT_FORWARD_HOURLY_SEND_CAP[row.lane] ?? 0;
  const usage = await selectRow<{ used: number; oldest: Date | null }>(
    client,
    `SELECT coalesce(sum(attempt_count), 0)::int AS used, min(claimed_at) AS oldest
       FROM contact_forwards
      WHERE lane = $3 AND claimed_at > $1 AND claimed_at <= $2`,
    [new Date(now.getTime() - RATE_WINDOW_MS), now, row.lane],
  );
  if (usage !== null && usage.used >= cap && usage.oldest !== null) {
    await client.query(`UPDATE contact_forwards SET next_attempt_at = $2 WHERE id = $1 AND status = 'pending'`, [
      row.id,
      new Date(usage.oldest.getTime() + RATE_WINDOW_MS + 1),
    ]);
    return { kind: 'deferred', lane: row.lane };
  }

  const attempt = row.attempt_count + 1;
  await client.query(
    `UPDATE contact_forwards SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4
      WHERE id = $1 AND status = 'pending'`,
    [row.id, attempt, now, new Date(now.getTime() + CLAIM_LEASE_MS)],
  );
  return { kind: 'claimed', forwardId: row.id, sesMessageId: row.ses_message_id, attempt };
}

// ---------------------------------------------------------------------------
// 문서 — S3 를 거쳐 왔다. 모양을 값으로 확인한다
// ---------------------------------------------------------------------------

class ContactDocumentShapeError extends Error {
  constructor(field: string) {
    super(`전달 문서 모양이 틀렸다: ${field}`);
    this.name = 'ContactDocumentShapeError';
  }
}

/**
 * 문서 칸 상한 — 수신 쪽(`buildContactDocument`)이 자른 길이와 같다(2026-09-24 최종 검증 L7). 문서는 앱 롤이 쓴 S3 객체라 쓰는 쪽을
 * 믿지 않는다: 넘으면 모양 오류(`dead`)다 — 템플릿이 자르기 전에 수 MB 문자열을 메모리·정규식에 올리지 않는다.
 * 본문은 코드포인트 `CONTACT_TEXT_MAX_CHARS` 이하 = UTF-16 길이 그 두 배 이하(보조 평면 글자는 2단위).
 */
const DOCUMENT_SUBJECT_MAX_LENGTH = 998;
const DOCUMENT_FROM_NAME_MAX_LENGTH = 200;
const DOCUMENT_TO_ITEM_MAX_LENGTH = 254;
const DOCUMENT_TEXT_MAX_LENGTH = CONTACT_TEXT_MAX_CHARS * 2;

function parseDocument(bytes: Uint8Array, sesMessageId: string): ContactForwardDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ContactDocumentShapeError('json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ContactDocumentShapeError('object');
  const d = parsed as Record<string, unknown>;
  const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
  if (d['version'] !== CONTACT_DOCUMENT_VERSION) throw new ContactDocumentShapeError('version');
  if (d['sesMessageId'] !== sesMessageId) throw new ContactDocumentShapeError('sesMessageId');
  if (typeof d['receivedAt'] !== 'string' || d['receivedAt'].length > 40) throw new ContactDocumentShapeError('receivedAt');
  if (typeof d['fromAddress'] !== 'string' || !isForwardableAddress(d['fromAddress'])) throw new ContactDocumentShapeError('fromAddress');
  if (!isStringOrNull(d['fromName']) || (typeof d['fromName'] === 'string' && d['fromName'].length > DOCUMENT_FROM_NAME_MAX_LENGTH)) {
    throw new ContactDocumentShapeError('fromName');
  }
  const to = d['to'];
  if (!Array.isArray(to) || to.length > 10 || !to.every((item) => typeof item === 'string' && item.length <= DOCUMENT_TO_ITEM_MAX_LENGTH)) {
    throw new ContactDocumentShapeError('to');
  }
  if (!isStringOrNull(d['date']) || (typeof d['date'] === 'string' && d['date'].length > 40)) throw new ContactDocumentShapeError('date');
  if (!isStringOrNull(d['subject']) || (typeof d['subject'] === 'string' && d['subject'].length > DOCUMENT_SUBJECT_MAX_LENGTH)) {
    throw new ContactDocumentShapeError('subject');
  }
  if (typeof d['text'] !== 'string' || d['text'].length > DOCUMENT_TEXT_MAX_LENGTH) throw new ContactDocumentShapeError('text');
  if (typeof d['textTruncated'] !== 'boolean') throw new ContactDocumentShapeError('textTruncated');
  if (d['textSource'] !== 'plain' && d['textSource'] !== 'html' && d['textSource'] !== 'none') throw new ContactDocumentShapeError('textSource');
  const count = d['attachmentCount'];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new ContactDocumentShapeError('attachmentCount');
  if (typeof d['dmarc'] !== 'string' || !/^[a-z_]{1,32}$/.test(d['dmarc'])) throw new ContactDocumentShapeError('dmarc');
  return {
    version: CONTACT_DOCUMENT_VERSION,
    sesMessageId,
    receivedAt: d['receivedAt'],
    fromAddress: d['fromAddress'],
    fromName: d['fromName'],
    to: to as string[],
    date: d['date'],
    subject: d['subject'],
    text: d['text'],
    textTruncated: d['textTruncated'],
    textSource: d['textSource'],
    attachmentCount: count,
    dmarc: d['dmarc'],
  };
}

// ---------------------------------------------------------------------------
// 결말 기록 — 전부 조건부(자기가 집은 시도만)
// ---------------------------------------------------------------------------

async function settle(pool: Pool, claimed: Claimed, status: 'suppressed' | 'dead', reason: string, now: Date): Promise<void> {
  await pool.query(
    `UPDATE contact_forwards SET status = $3, settled_at = $4, last_error = $5
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.forwardId, claimed.attempt, status, now, reason],
  );
}

async function markSent(pool: Pool, claimed: Claimed, sesMessageId: string, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE contact_forwards SET status = 'sent', sent_at = $3, forward_ses_message_id = $4, last_error = NULL
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.forwardId, claimed.attempt, now, sesMessageId],
  );
  return result.rowCount === 1;
}

async function markFailed(pool: Pool, claimed: Claimed, errorKind: string, now: Date): Promise<'retry' | 'dead'> {
  if (claimed.attempt >= MAX_ATTEMPTS) {
    await settle(pool, claimed, 'dead', errorKind, now);
    return 'dead';
  }
  await pool.query(
    `UPDATE contact_forwards SET next_attempt_at = $3, last_error = $4
      WHERE id = $1 AND status = 'pending' AND attempt_count = $2`,
    [claimed.forwardId, claimed.attempt, new Date(now.getTime() + RETRY_BASE_MS * 2 ** (claimed.attempt - 1)), errorKind],
  );
  return 'retry';
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export function createContactForwarder(deps: ContactForwarderDependencies): ContactForwarder {
  const transport = createSesContactForwardTransport({ client: deps.client, now: deps.now });

  return {
    async forward(forwardId: string): Promise<ContactForwardOutcome> {
      if (!FORWARD_ID_PATTERN.test(forwardId)) {
        throw new Error(`forwardId 는 정규형 uuid 여야 한다: ${JSON.stringify(forwardId)}`);
      }

      // ① 수신자 — 비밀 하나에서만. 없으면 집기 전에 멈춘다(시도 수를 쓰지 않는다).
      const destination = await deps.destination().catch(() => null);
      if (destination === null || !isForwardableAddress(destination) || isOwnDomain(destination)) {
        log('error', 'contact_forward.unconfigured', {
          route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID,
          reason: 'destination_unavailable',
          detail: '전달 주소 비밀(atmark/contact-forward-to)이 비었거나 읽지 못했다 — 보내지 않는다. 배포 런북 §문의 전달.',
        });
        countMetric(METRIC_NAMES.contactForwardBlocked, { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID });
        return 'unconfigured';
      }

      const claimed = await withTransaction(deps.pool, (client) => claim(client, forwardId, deps.now()));
      if (claimed.kind === 'not_due') return 'not_due';
      if (claimed.kind === 'deferred') {
        log('warn', 'contact_forward.deferred', { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID, lane: claimed.lane, reason: 'global_rate_cap' });
        return 'deferred';
      }

      let document: ContactForwardDocument;
      try {
        document = parseDocument(await deps.documents.read(claimed.sesMessageId), claimed.sesMessageId);
      } catch (error) {
        if (error instanceof ContactDocumentShapeError) {
          await settle(deps.pool, claimed, 'dead', 'document_invalid', deps.now());
          log('error', 'contact_forward.dead', { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID, ses_message_id: claimed.sesMessageId, reason: 'document_invalid', detail: error.message });
          countMetric(METRIC_NAMES.contactForwardBlocked, { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID });
          return 'dead';
        }
        const outcome = await markFailed(deps.pool, claimed, 'document_unreadable', deps.now());
        log('warn', 'contact_forward.failed', { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID, ses_message_id: claimed.sesMessageId, outcome, reason: 'document_unreadable' });
        return outcome;
      }

      // ② 루프 — 전달 주소 자신(별칭·Gmail 점·+태그 무시)이나 우리 도메인에서 온 문의는 보내지 않는다.
      if (isOwnDomain(document.fromAddress) || isHumanMailbox(document.fromAddress, [destination])) {
        await settle(deps.pool, claimed, 'suppressed', 'loop_destination', deps.now());
        log('warn', 'contact_forward.suppressed', { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID, ses_message_id: claimed.sesMessageId, reason: 'loop_destination' });
        return 'suppressed';
      }

      let sesMessageId: string;
      try {
        // 알림만이면 Reply-To 도 없다 — 회신은 Atmark(지원 에이전트)에서 한다. 언어 = 전달 주소가 활성 운영자의 사용자 주소면 그 설정, 아니면 'en'
        //   (정의자 함수 — 앱 롤은 users 권한 0). 보내는 순간 고른다.
        const operator = await selectRow<{ mail_locale: string | null }>(deps.pool, 'SELECT atmark_operator_mail_locale($1) AS mail_locale', [destination]);
        const locale = resolveMailLocale(operator?.mail_locale);
        const rendered = deps.notifyOnly ? renderContactNotify(document, locale) : renderContactForward(document, locale);
        ({ sesMessageId } = await transport.sendContactForward({
          forwardId: claimed.forwardId,
          fromAddress: CONTACT_FORWARD_FROM_ADDRESS,
          toAddress: destination,
          replyToAddress: deps.notifyOnly ? null : document.fromAddress,
          subject: rendered.subject,
          text: rendered.text,
        }));
      } catch (error) {
        const outcome = await markFailed(deps.pool, claimed, 'send_failed', deps.now());
        log(outcome === 'dead' ? 'error' : 'warn', 'contact_forward.failed', {
          route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID,
          ses_message_id: claimed.sesMessageId,
          outcome,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        if (outcome === 'dead') countMetric(METRIC_NAMES.contactForwardBlocked, { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID });
        return outcome;
      }

      // 여기부터 메일은 **이미 나갔다.** 기록 실패로 던지면 다음 틱이 한 번 더 보낸다 — 던지지 않는다.
      const settled = await markSent(deps.pool, claimed, sesMessageId, deps.now()).catch(() => false);
      log(settled ? 'info' : 'warn', 'contact_forward.sent', {
        route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID,
        ses_message_id: claimed.sesMessageId,
        settled,
      });
      countMetric(METRIC_NAMES.contactForwardSent, { route_id: CONTACT_FORWARD_NOTIFY_ROUTE_ID });
      return 'sent';
    },
  };
}
