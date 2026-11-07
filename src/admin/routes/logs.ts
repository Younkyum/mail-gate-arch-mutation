/**
 * src/admin/routes/logs.ts — 콘솔 로그 API(계약 v2 §2, 모양은 `.omc/handoffs/v2-contract.md` "T3 메모"):
 *   - `GET /api/logs?type=outbound|inbound|console|scheduled&agent=&decision=&before=&limit=` → `{items, next}`
 *     (`type=inbound` 는 `from`·`since`·`until` 필터도 — 메일 기본기 A5. 격리 필터는 기존 `decision`)
 *   - `GET /api/logs/{type}/{id}` → 상세(+ `tlogEntryId`·`tlogPending` — 투명성 로그 잎, 포함 증명은 `integrity.ts`)
 *
 * **예약 로그(`type=scheduled`, 메일 기본기 A3 완화 ② — 2026-09-26).** 조직 에이전트의 예약 발송을 보낼 시각 최신순으로 보인다. 취소된 행은
 * 사유 코드·경로(`mcp` = 에이전트 도구, `http` = API, `console` = 소유자 콘솔 — 취소 버튼은 `routes/scheduled.ts`)·시각·메모를 싣는다 — 주입 메일이 에이전트에게 예약을 취소하게 만들었다면 소유자가
 * 여기서 본다. 메모는 에이전트가 쓴 글이라 `sanitizeDisplayText` 를 거친다. 본문(제목·내용)은 싣지 않는다 — S3 에 있고 이 화면은 행만 본다.
 * admin 롤은 이 칸들만 SELECT 할 수 있다(202609260120).
 *
 * **조직 범위가 SQL 에 박혀 있다.** 모든 조회는 세션 조직의 에이전트(`agents.organization_id`)에서 출발하거나(발신·수신), 세션 조직의
 * 행만 고른다(콘솔 — `owner_actions.organization_id`, 수신 거부 — 이 조직 주소와 봉투 수신자가 겹치는 행). `agent` 필터는 먼저
 * `requireAgentInOrganization` 을 지난다(다른 조직·없는 에이전트 → 404, 둘을 구별하지 않는다). 상세도 같은 조건 — 다른 조직의 id 는
 * "없음"(404 `log_not_found`)이다.
 *
 * **수신 로그에는 본문이 없다.** 수신 로그는 헤더 요약(보낸 사람·제목·인증 판정·격리 사유)만 싣는다 — 본문·스니펫·저장 키(원문·
 * 파싱본 위치)를 SELECT 하지도 않는다. 격리된 메일도 소유자에게는 보인다(사유와 함께) — 에이전트 컨텍스트에서 가리는 규칙
 * (`visibleToAgent`)은 에이전트 표면의 것이고, 이 표면은 소유자다.
 *
 * **발신 로그 상세에는 보낸 본문이 있다**(US-004). 우리 에이전트가 **보낸** 것이고(외부인이 보낸 격리 메일이 아니다), 소유자가
 * "무엇이 나갔나" 를 볼 수 있어야 한다. 본문은 S3(`outbound/content/{id}.json`)에서 **상세에서만** 읽는다 — 조직 범위로 행을
 * 고른 **뒤**, 그 행의 `body_storage_key`(DB CHECK 가 `id` 에 묶는다 — 202609241320)로. 평문 파트만 싣는다(상한
 * `OUTBOUND_BODY_MAX_BYTES`, 넘으면 `truncated`) — html 파트는 **있다는 사실만**(`hasHtml`) 싣고 내용은 싣지 않는다.
 * SES 배달 이벤트(`ses_events` — send·delivery·bounce·complaint·reject·delivery_delay·rendering_failure)는 시각과 함께.
 *
 * **최신순 + 키셋 커서.** 정렬은 (시각 DESC, id DESC). 커서는 마지막 행의 (시각, id) — 시각은 Postgres 의 마이크로초 그대로
 * 문자열로 싣는다(JS `Date` 는 밀리초라 동률·근접 시각에서 행을 건너뛰거나 되풀이한다). 커서는 type 에 묶인다.
 * 조직 범위 목록은 에이전트마다 LATERAL 로 앞쪽 `limit+1` 행만 읽어 합친다(색인: 202609241100).
 *
 * 표시 문자열(이름·주소·제목·사유 코드·해소 문자열)은 전부 `sanitizeDisplayText` 를 거친다. id·시각은 그대로.
 */

import { contentKeyFor, MessageContentNotFoundError } from '../../api/content-store';
import { SCHEDULED_CANCELLED_VIA, SNIPPET_MAX_LENGTH } from '../../db/schema';
import { sanitizeDisplayBlock, sanitizeDisplayText } from '../../notify/approval-notification-template';
import { log } from '../../observability/logger';
import { requireAgentInOrganization, sessionOf, type AdminCall, type OwnerSession } from '../context';
import { displayAddress, displayName, displaySubject, iso } from '../display';
import { tlogEntryRefFor } from '../../tlog/proofs';
import type { TlogSourceTable } from '../../tlog/constants';
import { jsonResponse, type AdminResponse } from '../http';
import { AdminInputError, notFound, UUID_PATTERN } from '../ops/errors';
import { TOKEN_LABEL_MAX_LENGTH } from '../ops/tokens';
import { AI_WATCH_BANDS, AI_WATCH_JOB_STATES, AI_WATCH_VERDICTS, isAiWatchModelVersion } from '../../inbound/ai-watch/contract';
import { aiWatchOwnerStatus, type AiWatchOwnerView } from '../../inbound/ai-watch/status';

const LOG_TYPES = ['outbound', 'inbound', 'console', 'scheduled'] as const;
type LogType = (typeof LOG_TYPES)[number];

/** 발신 결과 — 관문 판정(audit_logs) + 전송 상태(messages.status) 에서 유도. */
export const OUTBOUND_DECISIONS = ['sent', 'denied', 'pending', 'failed', 'sending', 'queued'] as const;
const INBOUND_VERDICTS = ['delivered', 'quarantined', 'rejected'] as const;
/** 예약 상태(`scheduled_send_status`) — 예약 로그의 `decision` 필터. */
const SCHEDULED_STATUSES = ['scheduled', 'dispatched', 'cancelled'] as const;
/** 취소 메모의 표시 상한(DB CHECK 는 200자). */
const CANCEL_NOTE_MAX_CHARS = 200;

const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 100;
/** 목록 항목의 수신자 미리보기 수(상세는 전부). */
const RECIPIENT_PREVIEW = 5;

/** 사유 코드·해소 문자열의 표시 상한. */
const CODE_MAX_CHARS = 200;

/** 목록 항목의 본문 미리보기 상한(코드포인트). 상세는 저장된 스니펫 전부(≤ `SNIPPET_MAX_LENGTH`). */
const LIST_SNIPPET_MAX_CHARS = 120;
/** 발신 상세 본문(평문 파트)의 응답 상한 — UTF-8 64 KiB. 넘으면 코드포인트 경계에서 자르고 `truncated: true`. */
export const OUTBOUND_BODY_MAX_BYTES = 64 * 1024;
/** 발신 상세의 SES 이벤트 상한(시각 오름차순 앞쪽). 수신자마다 delivery 가 한 행이다. */
const OUTBOUND_EVENTS_MAX = 200;

/**
 * 메일 본문 보존 기간(일) — US-008, 진윤겸 결정(2026-09-24). `infra/cdk/stacks/storage-stack.ts` 의
 * `MAIL_BODY_RETENTION_DAYS`(S3 수명주기 규칙이 실제로 지우는 기준)와 같은 값이어야 한다 — 인프라 쪽을
 * import 하지 않는 이유는 그 파일이 `aws-cdk-lib` 를 끌고 오기 때문이다(Lambda 번들에 들어가면 안 된다).
 * 값의 일치는 테스트가 단언한다.
 */
export const MAIL_BODY_RETENTION_DAYS = 365;

/** 커서 시각 — `to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 의 모양. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const AT_KEY = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Cursor {
  readonly at: string;
  readonly id: string;
}

/** 값을 자리표시로 — `values` 에 넣고 `$n` 을 돌려준다(값은 SQL 문자열에 들어가지 않는다). */
function binder(values: unknown[]): (value: unknown) => string {
  return (value) => {
    values.push(value);
    return `$${String(values.length)}`;
  };
}

function code(value: string): string {
  return sanitizeDisplayText(value, CODE_MAX_CHARS);
}

function encodeCursor(type: LogType, cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ k: type, t: cursor.at, i: cursor.id }), 'utf8').toString('base64url');
}

function decodeCursor(type: LogType, raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const invalid = new AdminInputError('before 는 이전 응답의 next 값 그대로여야 한다.', 'invalid_cursor');
  if (raw === '' || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid;
  const { k, t, i } = parsed as Record<string, unknown>;
  if (k !== type || typeof t !== 'string' || !CURSOR_AT.test(t) || !isRealCursorInstant(t) || typeof i !== 'string' || !UUID_PATTERN.test(i)) throw invalid;
  return { at: t, id: i };
}

/**
 * 커서 시각이 **실재하는 시각**인가 — 모양(정규식)만 보면 `2026-13-45T99:99:99` · `0000-01-01`(Postgres 에 0년이 없다)이 통과해
 * `::timestamptz` 캐스트가 500 을 낸다(2026-09-24 검증). 달력으로 되돌려 같은 문자열이 나오는지 본다(윤년·월말 포함). 연도는
 * 1970~9999 — 커서는 우리 행의 시각이고, 그 밖은 위조다.
 */
function isRealCursorInstant(value: string): boolean {
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 9999) return false;
  const parsed = new Date(`${value.slice(0, 23)}Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 23) === value.slice(0, 23);
}

function parseType(raw: string | undefined): LogType {
  if (raw === undefined || !(LOG_TYPES as readonly string[]).includes(raw)) {
    throw new AdminInputError(`type 은 ${LOG_TYPES.join(' | ')} 다.`, 'invalid_log_type');
  }
  return raw as LogType;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LOG_LIMIT;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LOG_LIMIT) {
    throw new AdminInputError(`limit 은 1~${String(MAX_LOG_LIMIT)} 정수다.`, 'invalid_limit');
  }
  return Number(raw);
}

/** `decision`(inbound 는 `verdict` 로도) — 값 밖이면 400. console 에는 없다. */
function parseDecision(type: LogType, query: Readonly<Record<string, string>>): string | null {
  const decision = query['decision'];
  const verdict = query['verdict'];
  if (decision !== undefined && verdict !== undefined) throw new AdminInputError('decision 과 verdict 는 하나만 준다.', 'invalid_decision');
  if (verdict !== undefined && type !== 'inbound') throw new AdminInputError('verdict 는 type=inbound 에서만 쓴다.', 'invalid_decision');
  const value = decision ?? verdict;
  if (value === undefined) return null;
  const allowed: readonly string[] =
    type === 'outbound' ? OUTBOUND_DECISIONS : type === 'inbound' ? INBOUND_VERDICTS : type === 'scheduled' ? SCHEDULED_STATUSES : [];
  if (!allowed.includes(value)) {
    throw new AdminInputError(
      type === 'console' ? 'console 로그에는 decision 필터가 없다.' : `decision 은 ${allowed.join(' | ')} 다.`,
      'invalid_decision',
    );
  }
  return value;
}

/** 수신 로그 필터(메일 기본기 A5) — 보낸 주소(정확 일치)·기간(반열림). 격리는 `decision` 이다. */
interface InboundLogFilters {
  readonly from: string | null;
  readonly since: string | null;
  readonly until: string | null;
}

function parseInstant(raw: string | undefined, name: string): string | null {
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) || Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1970 || parsed.getUTCFullYear() > 9999) {
    throw new AdminInputError(`${name} 는 ISO 8601 시각(또는 날짜)이다.`, 'invalid_filter');
  }
  return parsed.toISOString();
}

/** `from`·`since`·`until` — `type=inbound` 에서만. 값이 틀리면 400. */
function parseInboundFilters(type: LogType, query: Readonly<Record<string, string>>): InboundLogFilters {
  const given = ['from', 'since', 'until'].filter((key) => query[key] !== undefined);
  if (given.length > 0 && type !== 'inbound') {
    throw new AdminInputError(`${given.join('·')} 필터는 type=inbound 에서만 쓴다.`, 'invalid_filter');
  }
  const fromRaw = query['from'];
  let from: string | null = null;
  if (fromRaw !== undefined) {
    from = fromRaw.trim().toLowerCase();
    if (from.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(from)) throw new AdminInputError('from 은 메일 주소 하나(정확 일치)다.', 'invalid_filter');
  }
  const since = parseInstant(query['since'], 'since');
  const until = parseInstant(query['until'], 'until');
  if (since !== null && until !== null && since >= until) throw new AdminInputError('since 는 until 보다 앞이어야 한다.', 'invalid_filter');
  return { from, since, until };
}

interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** `limit+1` 행 → 쪽 + 다음 커서. */
function paginate<R extends { at_key: string; id: string }, T>(type: LogType, rows: readonly R[], limit: number, map: (row: R) => T): Page<T> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(map),
    next: rows.length > limit && last !== undefined ? encodeCursor(type, { at: last.at_key, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// 발신
// ---------------------------------------------------------------------------

/**
 * 발신 결과 유도식 — **판정(audit_logs 최신 행)과 전송 상태(messages.status)** 를 합친다. 순서가 의미다: 전송 결과가 있으면
 * 그것(sent·failed), 거부(관문 거부 · 승인 거절/만료 → 메시지도 denied)면 denied, 레거시 승인 대기면 pending, 전송 중이면 sending,
 * 나머지(허용됐지만 아직 전송 전 · 판정 전)는 queued.
 */
export const OUTBOUND_DECISION_SQL = `CASE
    WHEN m.status = 'sent' THEN 'sent'
    WHEN m.status = 'failed' THEN 'failed'
    WHEN m.status = 'denied' OR a.decision = 'denied' THEN 'denied'
    WHEN a.decision = 'pending_approval' THEN 'pending'
    WHEN m.status = 'dispatching' THEN 'sending'
    ELSE 'queued'
  END`;

/** 메시지 한 행의 최신 판정. 발송 시도당 1행이 규약이지만(audit-sink) 여럿이어도 최신 하나만. */
const LATEST_AUDIT_SQL = `LEFT JOIN LATERAL (
    SELECT al.decision::text AS decision, al.reasons, al.policy_version, al.evaluated_at, al.resolved_at, al.resolution_reason, al.approval_id
      FROM audit_logs al WHERE al.message_id = m.id
     ORDER BY al.created_at DESC, al.id DESC LIMIT 1
  ) a ON true`;

/** 발신 주소 — messages 는 해시만 가진다. 이 에이전트 주소 중 해시가 맞는 것(없으면 NULL — 위조 시도 등). */
const FROM_ADDRESS_SQL = (message: string): string => `(SELECT aa.address FROM agent_addresses aa
      WHERE aa.agent_id = ${message}.agent_id AND encode(sha256(convert_to(aa.address, 'UTF8')), 'hex') = ${message}.from_address_hash
      ORDER BY aa.address LIMIT 1)`;

interface OutboundRow {
  id: string;
  agent_id: string;
  agent_name: string;
  at: Date;
  at_key: string;
  from_address: string | null;
  from_domain: string;
  subject: string | null;
  thread_id: string | null;
  decision: string;
  reasons: string[] | null;
  policy_version: number | null;
  recipients: string[] | null;
  recipient_count: number;
  snippet: string | null;
}

function outboundItem(row: OutboundRow): Record<string, unknown> {
  return {
    id: row.id,
    at: row.at.toISOString(),
    agentId: row.agent_id,
    agentName: displayName(row.agent_name),
    from: row.from_address === null ? null : displayAddress(row.from_address),
    fromDomain: displayAddress(row.from_domain),
    recipients: (row.recipients ?? []).map(displayAddress),
    recipientCount: row.recipient_count,
    subject: row.subject === null ? null : displaySubject(row.subject),
    snippet: row.snippet === null ? null : sanitizeDisplayText(row.snippet, LIST_SNIPPET_MAX_CHARS),
    decision: row.decision,
    reasons: (row.reasons ?? []).map(code),
    policyVersion: row.policy_version,
    threadId: row.thread_id,
  };
}

async function listOutbound(call: AdminCall, session: OwnerSession, agentId: string | null, decision: string | null, cursor: Cursor | null, limit: number) {
  const values: unknown[] = [session.organizationId, limit + 1];
  const param = binder(values);
  const agentClause = agentId === null ? '' : `AND ag.id = ${param(agentId)}`;
  const cursorClause = cursor === null ? '' : `AND (m.created_at, m.id) < (${param(cursor.at)}::timestamptz, ${param(cursor.id)}::uuid)`;
  const decisionClause = decision === null ? '' : `AND d.decision = ${param(decision)}`;
  const result = await call.deps.pool.query<OutboundRow>(
    `SELECT o.id, o.agent_id, ag.name AS agent_name, o.at, o.at_key, o.from_domain, o.subject, o.snippet, o.thread_id, o.decision, o.reasons,
            o.policy_version, ${FROM_ADDRESS_SQL('o')} AS from_address,
            (SELECT array_agg(p.address ORDER BY p.address)
               FROM (SELECT r.address FROM outbound_recipients r WHERE r.message_id = o.id ORDER BY r.address LIMIT ${String(RECIPIENT_PREVIEW)}) p
            ) AS recipients,
            (SELECT count(*)::int FROM outbound_recipients r WHERE r.message_id = o.id) AS recipient_count
       FROM agents ag
       CROSS JOIN LATERAL (
         SELECT m.id, m.agent_id, m.created_at AS at, ${AT_KEY('m.created_at')} AS at_key, m.from_address_hash, m.from_domain,
                m.subject, m.snippet, m.thread_id, d.decision, a.reasons, a.policy_version
           FROM messages m
           ${LATEST_AUDIT_SQL}
           CROSS JOIN LATERAL (SELECT ${OUTBOUND_DECISION_SQL} AS decision) d
          WHERE m.agent_id = ag.id AND m.direction = 'outbound' ${cursorClause} ${decisionClause}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2
       ) o
      WHERE ag.organization_id = $1 ${agentClause}
      ORDER BY o.at DESC, o.id DESC
      LIMIT $2`,
    values,
  );
  return paginate('outbound', result.rows, limit, outboundItem);
}

/** 발신 상세의 본문 — 상태 하나 + (있으면) 평문. */
interface OutboundBody {
  /**
   * `available` 본문을 읽었다 · `not_stored` 이 행에 본문 자리가 기록되지 않았다(관문 전에 끝난 옛 행) · `missing` 자리는 있는데
   * 객체가 없다(본문 쓰기 전에 실패한 시도 — 메시지가 보존 기간 안이다) · `expired` 자리는 있는데 객체가 없고 메시지가
   * `MAIL_BODY_RETENTION_DAYS` 보다 오래됐다(S3 수명주기가 지웠다, US-008 — `missing` 과 원인이 다르므로 구별한다) ·
   * `unavailable` 읽기 실패(권한·손상·상한 — 원인은 로그로만).
   */
  readonly status: 'available' | 'not_stored' | 'missing' | 'expired' | 'unavailable';
  readonly text: string | null;
  readonly truncated: boolean;
  /** html 파트가 있었는가(`available` 일 때만 참·거짓, 그 밖엔 `null`). 내용은 싣지 않는다. */
  readonly hasHtml: boolean | null;
}

/** UTF-8 `maxBytes` 이하가 되도록 코드포인트 경계에서 자른다. */
function truncateUtf8(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { text: value.slice(0, end), truncated: true };
}

/** 메시지 생성 시각이 보존 기간(`MAIL_BODY_RETENTION_DAYS`)을 넘었는가 — S3 수명주기가 지웠을 시점인가. */
function isPastRetention(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= MAIL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 본문 읽기 — **조직 범위로 고른 행의** 키로만 부른다. 키는 DB CHECK 가 `id` 에 묶지만(202609241320), 여기서도 한 번 더 대조한다:
 * 어긋나면 읽지 않는다(`unavailable`). S3 는 `outbound/content/` 접두사 하나만 읽을 수 있다(리더·IAM 둘 다).
 *
 * `createdAt` 은 객체가 없을 때(`ObjectNotFoundError` → `MessageContentNotFoundError`) `missing` 과 `expired` 를 가른다 —
 * 보존 기간을 넘겼으면 S3 수명주기(US-008)가 지운 것이고, 안 넘겼으면 애초에 쓰기가 실패한 옛 시도다.
 *
 * **보존 기간을 넘긴 행은 S3 를 부르지 않고 `expired` 다**(2026-09-24 검증 F8). 운영 admin 역할에는 `s3:ListBucket` 이 없어
 * (ADR-0006 "US-004 추가") 없는 키의 GetObject 가 404 가 아니라 **403** 이다 — 그러면 `MessageContentNotFoundError` 가 안 나고
 * `unavailable` 로 떨어져 `expired` 가 운영에서 한 번도 보이지 않았다. 보존 기간이 지난 본문은 (수명주기가 아직 안 돌았더라도)
 * 보여 주지 않는 것이 개인정보 문구("1년 뒤 삭제")와도 맞다.
 */
async function outboundBody(call: AdminCall, id: string, storageKey: string | null, createdAt: Date): Promise<OutboundBody> {
  const none = (status: OutboundBody['status']): OutboundBody => ({ status, text: null, truncated: false, hasHtml: null });
  if (storageKey === null) return none('not_stored');
  if (storageKey !== contentKeyFor(id)) {
    log('warn', 'admin.outbound_body_unavailable', { route_id: 'admin:logs', message_id: id, error_kind: 'key_mismatch' });
    return none('unavailable');
  }
  if (isPastRetention(createdAt, call.deps.now())) return none('expired');
  try {
    const content = await call.deps.outboundContent.load(id);
    const { text, truncated } = truncateUtf8(sanitizeDisplayBlock(content.text), OUTBOUND_BODY_MAX_BYTES);
    return { status: 'available', text, truncated, hasHtml: content.html !== null };
  } catch (error) {
    // 보존 기간 안인데 객체가 없다 — 쓰기가 실패한 옛 시도(보존 만료는 위에서 이미 걸렀다).
    if (error instanceof MessageContentNotFoundError) return none('missing');
    // 403(ListBucket 없음 — 없는 키도 403 이다) · 손상 · 상한 초과 · 네트워크. 화면은 "읽지 못함", 원인은 로그.
    log('warn', 'admin.outbound_body_unavailable', {
      route_id: 'admin:logs',
      message_id: id,
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    return none('unavailable');
  }
}

async function outboundDetail(call: AdminCall, session: OwnerSession, id: string): Promise<Record<string, unknown> | null> {
  const result = await call.deps.pool.query<
    OutboundRow & {
      evaluated_at: Date | null;
      resolved_at: Date | null;
      resolution_reason: string | null;
      approval_id: string | null;
      failure_reason: string | null;
      sent_at: Date | null;
      failed_at: Date | null;
      body_storage_key: string | null;
      events: Array<{ type: string; at: string }> | null;
      audit_ids: string[] | null;
    }
  >(
    `SELECT m.id, m.agent_id, ag.name AS agent_name, m.created_at AS at, ${AT_KEY('m.created_at')} AS at_key, m.from_domain, m.subject,
            m.snippet, m.body_storage_key,
            m.thread_id, d.decision, a.reasons, a.policy_version, a.evaluated_at, a.resolved_at, a.resolution_reason, a.approval_id,
            m.failure_reason, m.sent_at, m.failed_at, ${FROM_ADDRESS_SQL('m')} AS from_address,
            (SELECT json_agg(json_build_object('type', e.event_type::text, 'at', ${AT_KEY('e.event_at')}) ORDER BY e.event_at, e.received_at, e.id)
               FROM (SELECT se.event_type, se.event_at, se.received_at, se.id FROM ses_events se WHERE se.message_id = m.id
                      ORDER BY se.event_at, se.received_at, se.id LIMIT ${String(OUTBOUND_EVENTS_MAX)}) e
            ) AS events,
            (SELECT array_agg(r.address ORDER BY r.address) FROM outbound_recipients r WHERE r.message_id = m.id) AS recipients,
            (SELECT count(*)::int FROM outbound_recipients r WHERE r.message_id = m.id) AS recipient_count,
            (SELECT array_agg(al.id::text) FROM audit_logs al WHERE al.message_id = m.id) AS audit_ids
       FROM messages m
       JOIN agents ag ON ag.id = m.agent_id
       ${LATEST_AUDIT_SQL}
       CROSS JOIN LATERAL (SELECT ${OUTBOUND_DECISION_SQL} AS decision) d
      WHERE m.id = $2::uuid AND m.direction = 'outbound' AND ag.organization_id = $1`,
    [session.organizationId, id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    ...outboundItem(row),
    // 상세는 저장된 스니펫 전부(≤512). 목록은 ≤120.
    snippet: row.snippet === null ? null : sanitizeDisplayText(row.snippet, SNIPPET_MAX_LENGTH),
    body: await outboundBody(call, row.id, row.body_storage_key, row.at),
    events: row.events ?? [],
    resolution: row.resolution_reason === null ? null : code(row.resolution_reason),
    failureReason: row.failure_reason === null ? null : code(row.failure_reason),
    evaluatedAt: iso(row.evaluated_at),
    resolvedAt: iso(row.resolved_at),
    sentAt: iso(row.sent_at),
    failedAt: iso(row.failed_at),
    approvalId: row.approval_id,
    // 잎은 감사 행(발송 시도마다 · 결과 갱신마다 rev)에 달린다 — 그중 체크포인트에 든 가장 최근 잎.
    ...(await tlogEntry(call, session, 'audit_logs', row.audit_ids ?? [])),
  };
}

// ---------------------------------------------------------------------------
// 수신
// ---------------------------------------------------------------------------

/**
 * 격리 사유 — 격리 아님이면 NULL. 정책 v2(202609241010, T1) 부터는 행이 사유를 직접 가진다(`quarantine_reason`:
 * `policy_blocked` · `injection_risk` · `scanner_error`). 그 전 행(`quarantine_reason` NULL)은 스캔 결과로 유도한다 — 판정 없음이면
 * `scanner_error`(fail-closed 격리), 나머지 격리는 스캐너 판정(`injection_risk`).
 */
const QUARANTINE_REASON_SQL = `CASE
    WHEN NOT i.quarantined THEN NULL
    WHEN i.quarantine_reason IS NOT NULL THEN i.quarantine_reason
    WHEN i.injection_risk IS NULL THEN 'scanner_error'
    ELSE 'injection_risk'
  END`;

interface InboundRow {
  kind: 'message' | 'rejection';
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  at: Date;
  at_key: string;
  from_address: string | null;
  subject: string | null;
  quarantined: boolean | null;
  reason: string | null;
  policy_reason: string | null;
  injection_risk: string | null;
  sender_trust: string | null;
  /** AI 의심 메일 감시 작업(ADR-0017) — 작업이 없는 행 · 거부 행 · 그림자(shadow) 작업은 전부 null. */
  aw_state: string | null;
  aw_verdict: string | null;
  aw_band: string | null;
  aw_model_version: string | null;
  aw_late: boolean | null;
  aw_deadline: Date | null;
}

function inboundItem(row: InboundRow, now: Date): Record<string, unknown> {
  const aiWatch = ownerAiWatchOf(row, now);
  return {
    id: row.id,
    at: row.at.toISOString(),
    agentId: row.agent_id,
    agentName: row.agent_name === null ? null : displayName(row.agent_name),
    from: row.from_address === null ? null : displayAddress(row.from_address),
    subject: row.subject === null ? null : displaySubject(row.subject),
    verdict: row.kind === 'rejection' ? 'rejected' : row.quarantined === true ? 'quarantined' : 'delivered',
    reason: row.reason === null ? null : code(row.reason),
    // 정책 격리(`policy_blocked`)의 판정 사유 — `sender_not_allowlisted` · `sender_blocklisted` · `inbound_disabled`. 그 밖엔 null.
    policyReason: row.policy_reason === null ? null : code(row.policy_reason),
    injectionRisk: row.injection_risk,
    senderTrust: row.sender_trust,
    ...(aiWatch === null ? {} : { aiWatch }),
  };
}

/**
 * AI 의심 메일 감시(ADR-0017 · 설계 §4.2)의 **소유자** 표시 — `{status, band, modelVersion, late}`. 작업이 없으면 `null`(키 없음 — 감시를 끈 조직 ·
 * 승격 규칙 밖 · 그림자 작업). 상태 대응은 에이전트 표면과 같은 순수 함수(`aiWatchOwnerStatus`)다. 밴드는 소유자에게만(에이전트 provenance 에는 없다).
 * **경고 표시만** — 이 값은 어떤 판정의 입력도 아니다(arch `ai-watch-boundary`).
 */
function ownerAiWatchOf(row: InboundRow, now: Date): AiWatchOwnerView | null {
  if (row.aw_state === null || row.aw_state === undefined || row.aw_deadline === null || row.aw_deadline === undefined) return null;
  const state = AI_WATCH_JOB_STATES.find((candidate) => candidate === row.aw_state);
  if (state === undefined) return null;
  return aiWatchOwnerStatus(
    {
      state,
      verdict: AI_WATCH_VERDICTS.find((candidate) => candidate === row.aw_verdict) ?? null,
      band: AI_WATCH_BANDS.find((candidate) => candidate === row.aw_band) ?? null,
      modelVersion: isAiWatchModelVersion(row.aw_model_version) ? row.aw_model_version : null,
      late: row.aw_late === true,
      shadow: false,
      deadline: row.aw_deadline,
    },
    now,
  );
}

/** 수신 행의 AI 감시 칸(`j` = `ai_watch_jobs`, 그림자 작업은 소유자에게도 보이지 않는다 — 롤아웃 §8.3 "표시 0"). */
const AI_WATCH_COLUMNS = `j.state AS aw_state, j.verdict AS aw_verdict, j.band AS aw_band, j.model_version AS aw_model_version, j.late AS aw_late,
                j.deadline AS aw_deadline`;
const AI_WATCH_JOIN = (alias: string): string => `LEFT JOIN ai_watch_jobs j ON j.job_id = ${alias}.ai_watch_job_id AND NOT j.shadow`;
const AI_WATCH_NULLS = `NULL::text AS aw_state, NULL::text AS aw_verdict, NULL::text AS aw_band, NULL::text AS aw_model_version, NULL::boolean AS aw_late,
                NULL::timestamptz AS aw_deadline`;

/** 조직(과 선택한 에이전트)의 에이전트 · 그 주소 전부(주소가 생긴 시각 · 폐기 시각과 함께) — 거부 행(agent_id 없음)을 봉투 수신자로 가른다. */
export const ORG_SCOPE_CTE = (agentClause: string): string => `org_agents AS (
      SELECT ag.id, ag.name FROM agents ag WHERE ag.organization_id = $1 ${agentClause}
    ), org_addresses AS (
      SELECT aa.address, aa.agent_id, aa.created_at, aa.retired_at FROM agent_addresses aa WHERE aa.agent_id IN (SELECT id FROM org_agents)
    )`;

/**
 * 거부 행이 이 조직의 것인가(2026-09-24 검증 반영):
 *   - 봉투 수신자 중 이 조직(선택) 주소가 있고, **그 주소가 생긴 뒤에 받은** 거부여야 한다. 주소가 생기기 전의 거부는 이 조직이
 *     받은 메일이 아니다 — 예전 판은 그 주소를 나중에 가진 조직에게 그 전의 거부(다른 사람 앞으로 온 메일의 흔적)를 보였다.
 *   - **그 주소를 폐기하기 전에 받은** 거부여야 한다(별칭 재발급, ADR-0013 2026-09-29 개정). 폐기한 별칭을 다른 조직(30일 뒤)이나 같은 조직의
 *     다른 에이전트가 다시 받으면, 그 뒤의 거부는 새 주인의 것이다 — 예전 주인에게 보이지 않는다.
 *   - `unknown_recipient` 는 어느 조직 것도 아니다 — 봉투에 이 조직 주소가 함께 있어도(여러 수신자 메일) 그 거부 사유는 **다른**
 *     (없는) 주소에 대한 것이다. 보이지 않는다.
 * `r` 은 `inbound_rejections` 별칭. 목록·상세·에이전트 판정이 같은 술어를 쓴다.
 */
const REJECTION_ADDRESS_MATCH = (alias: string): string =>
  `${alias}.address = ANY (r.envelope_recipients) AND ${alias}.created_at <= r.received_at AND (${alias}.retired_at IS NULL OR r.received_at < ${alias}.retired_at)`;
export const REJECTION_VISIBLE_SQL = `r.reason <> 'unknown_recipient'
            AND EXISTS (SELECT 1 FROM org_addresses oa WHERE ${REJECTION_ADDRESS_MATCH('oa')})`;

/** 거부 행의 에이전트 — 봉투 수신자 중 이 조직(선택) 주소(받은 시각 이전에 생긴 것)의 에이전트 하나(주소 순). */
const REJECTION_AGENT_SQL = `(SELECT oa.agent_id FROM org_addresses oa WHERE ${REJECTION_ADDRESS_MATCH('oa')} ORDER BY oa.address LIMIT 1)`;

async function listInbound(
  call: AdminCall,
  session: OwnerSession,
  agentId: string | null,
  verdict: string | null,
  filters: InboundLogFilters,
  cursor: Cursor | null,
  limit: number,
) {
  const values: unknown[] = [session.organizationId, limit + 1];
  const param = binder(values);
  const agentClause = agentId === null ? '' : `AND ag.id = ${param(agentId)}`;
  const cursorAt = cursor === null ? null : param(cursor.at);
  const cursorId = cursor === null ? null : param(cursor.id);
  const messageCursor = cursor === null ? '' : `AND (i.received_at, i.id) < (${String(cursorAt)}::timestamptz, ${String(cursorId)}::uuid)`;
  const rejectionCursor = cursor === null ? '' : `AND (r.received_at, r.id) < (${String(cursorAt)}::timestamptz, ${String(cursorId)}::uuid)`;
  const wantMessages = verdict !== 'rejected';
  // 거부 행에는 보낸 주소가 없다 — 주소 필터가 있으면 거부 행은 맞을 수 없다.
  const wantRejections = (verdict === null || verdict === 'rejected') && filters.from === null;
  const quarantineClause = verdict === 'delivered' ? 'AND NOT i.quarantined' : verdict === 'quarantined' ? 'AND i.quarantined' : '';
  const fromClause = filters.from === null ? '' : `AND i.from_address = ${param(filters.from)}`;
  const sinceAt = filters.since === null ? null : param(filters.since);
  const untilAt = filters.until === null ? null : param(filters.until);
  const periodClause = (column: string): string =>
    `${sinceAt === null ? '' : `AND ${column} >= ${sinceAt}::timestamptz`} ${untilAt === null ? '' : `AND ${column} < ${untilAt}::timestamptz`}`;

  const parts: string[] = [];
  if (wantMessages) {
    parts.push(`(SELECT 'message' AS kind, i.id, i.agent_id, oag.name AS agent_name, i.received_at AS at, ${AT_KEY('i.received_at')} AS at_key,
                i.from_address, i.subject, i.quarantined, ${QUARANTINE_REASON_SQL} AS reason, i.policy_reason,
                i.injection_risk::text AS injection_risk, i.sender_trust::text AS sender_trust, ${AI_WATCH_COLUMNS}
           FROM agents oag
           CROSS JOIN LATERAL (
             SELECT i.id, i.agent_id, i.received_at, i.from_address, i.subject, i.quarantined, i.quarantine_reason, i.policy_reason,
                    i.injection_risk, i.sender_trust, i.ai_watch_job_id
               FROM inbound_messages i
              WHERE i.agent_id = oag.id ${quarantineClause} ${fromClause} ${periodClause('i.received_at')} ${messageCursor}
              ORDER BY i.received_at DESC, i.id DESC
              LIMIT $2
           ) i
           ${AI_WATCH_JOIN('i')}
          WHERE oag.organization_id = $1 ${agentClause.replace('ag.id', 'oag.id')})`);
  }
  if (wantRejections) {
    parts.push(`(SELECT 'rejection' AS kind, r.id, ${REJECTION_AGENT_SQL} AS agent_id,
                (SELECT oag.name FROM org_agents oag WHERE oag.id = ${REJECTION_AGENT_SQL}) AS agent_name,
                r.received_at AS at, ${AT_KEY('r.received_at')} AS at_key, NULL::text AS from_address, NULL::text AS subject,
                NULL::boolean AS quarantined, r.reason, NULL::text AS policy_reason, NULL::text AS injection_risk, NULL::text AS sender_trust,
                ${AI_WATCH_NULLS}
           FROM inbound_rejections r
          WHERE r.envelope_recipients && (SELECT coalesce(array_agg(address), '{}') FROM org_addresses)
            AND ${REJECTION_VISIBLE_SQL} ${periodClause('r.received_at')} ${rejectionCursor}
          ORDER BY r.received_at DESC, r.id DESC
          LIMIT $2)`);
  }
  // 거부 행만 고르면서 보낸 주소로 거르면 맞을 수 있는 행이 없다.
  if (parts.length === 0) return { items: [], next: null };
  const result = await call.deps.pool.query<InboundRow>(
    `WITH ${ORG_SCOPE_CTE(agentClause)}
     SELECT * FROM (${parts.join(' UNION ALL ')}) u
      ORDER BY u.at DESC, u.id DESC
      LIMIT $2`,
    values,
  );
  const now = call.deps.now();
  return paginate('inbound', result.rows, limit, (row) => inboundItem(row, now));
}

async function inboundDetail(call: AdminCall, session: OwnerSession, id: string): Promise<Record<string, unknown> | null> {
  // 본문·스니펫·저장 키(raw/parsed)는 **SELECT 하지 않는다** — 응답에 실을 수 없는 칸은 읽지도 않는다.
  const message = await call.deps.pool.query<
    InboundRow & {
      envelope_recipient: string;
      from_authenticated: boolean;
      spf_verdict: string;
      dkim_verdict: string;
      dmarc_verdict: string;
      spam_verdict: string;
      virus_verdict: string;
      message_id_header: string | null;
      in_reply_to: string | null;
      header_date: Date | null;
      thread_id: string;
      attachment_count: number;
      auto_submitted: boolean;
    }
  >(
    `SELECT 'message' AS kind, i.id, i.agent_id, ag.name AS agent_name, i.received_at AS at, ${AT_KEY('i.received_at')} AS at_key,
            i.from_address, i.subject, i.quarantined, ${QUARANTINE_REASON_SQL} AS reason, i.policy_reason,
            i.injection_risk::text AS injection_risk, i.sender_trust::text AS sender_trust,
            i.envelope_recipient, i.from_authenticated, i.spf_verdict::text AS spf_verdict, i.dkim_verdict::text AS dkim_verdict,
            i.dmarc_verdict::text AS dmarc_verdict, i.spam_verdict::text AS spam_verdict, i.virus_verdict::text AS virus_verdict,
            i.message_id_header, i.in_reply_to, i.header_date, i.thread_id, i.attachment_count, i.auto_submitted, ${AI_WATCH_COLUMNS}
       FROM inbound_messages i JOIN agents ag ON ag.id = i.agent_id
       ${AI_WATCH_JOIN('i')}
      WHERE i.id = $2::uuid AND ag.organization_id = $1`,
    [session.organizationId, id],
  );
  const row = message.rows[0];
  if (row !== undefined) {
    return {
      ...inboundItem(row, call.deps.now()),
      to: [displayAddress(row.envelope_recipient)],
      fromAuthenticated: row.from_authenticated,
      auth: { spf: row.spf_verdict, dkim: row.dkim_verdict, dmarc: row.dmarc_verdict, spam: row.spam_verdict, virus: row.virus_verdict },
      messageIdHeader: row.message_id_header === null ? null : code(row.message_id_header),
      inReplyTo: row.in_reply_to === null ? null : code(row.in_reply_to),
      headerDate: iso(row.header_date),
      threadId: row.thread_id,
      attachmentCount: row.attachment_count,
      autoSubmitted: row.auto_submitted,
      ...(await tlogEntry(call, session, 'inbound_messages', [row.id])),
    };
  }
  const rejection = await call.deps.pool.query<InboundRow & { to: string[] | null; spam_verdict: string; virus_verdict: string }>(
    `WITH ${ORG_SCOPE_CTE('')}
     SELECT 'rejection' AS kind, r.id, ${REJECTION_AGENT_SQL} AS agent_id,
            (SELECT oag.name FROM org_agents oag WHERE oag.id = ${REJECTION_AGENT_SQL}) AS agent_name,
            r.received_at AS at, ${AT_KEY('r.received_at')} AS at_key, NULL::text AS from_address, NULL::text AS subject,
            NULL::boolean AS quarantined, r.reason, NULL::text AS policy_reason, NULL::text AS injection_risk, NULL::text AS sender_trust,
            ${AI_WATCH_NULLS},
            r.spam_verdict::text AS spam_verdict, r.virus_verdict::text AS virus_verdict,
            (SELECT array_agg(oa.address ORDER BY oa.address) FROM org_addresses oa WHERE ${REJECTION_ADDRESS_MATCH('oa')}) AS to
       FROM inbound_rejections r
      WHERE r.id = $2::uuid AND r.envelope_recipients && (SELECT coalesce(array_agg(address), '{}') FROM org_addresses)
        AND ${REJECTION_VISIBLE_SQL}`,
    [session.organizationId, id],
  );
  const rejected = rejection.rows[0];
  if (rejected === undefined) return null;
  return {
    ...inboundItem(rejected, call.deps.now()),
    // 봉투 수신자 중 **이 조직 주소만** — 같은 메일의 다른 조직 수신자를 흘리지 않는다.
    to: (rejected.to ?? []).map(displayAddress),
    fromAuthenticated: null,
    auth: { spf: null, dkim: null, dmarc: null, spam: rejected.spam_verdict, virus: rejected.virus_verdict },
    messageIdHeader: null,
    inReplyTo: null,
    headerDate: null,
    threadId: null,
    attachmentCount: null,
    autoSubmitted: null,
    // SMTP 단계 거부(`inbound_rejections`)는 로그 원천이 아니다 — 잎이 없다.
    tlogEntryId: null,
    tlogPending: false,
  };
}

// ---------------------------------------------------------------------------
// 콘솔(소유자 행위 감사)
// ---------------------------------------------------------------------------

interface ConsoleRow {
  id: string;
  at: Date;
  at_key: string;
  action: string;
  target_id: string | null;
  actor_email: string | null;
  actor_key_label: string | null;
  actor_key_hint: string | null;
  /** 운영자 · 시스템 행위자의 **종류**만(202610131610) — 행위자 문자열(운영자 이름 · 사유)은 화면에 보내지 않는다. */
  actor_operator_kind: 'operator' | 'system' | null;
}

/**
 * 행위자(확장성 P1 — 다중 멤버에서 "누가"): 세션 행위 = 그 세션의 사용자 주소, 조직 키 행위(`/org-api`) = 키 이름·끝 4자.
 * 사용자 결속 전(202609250110 이전) 세션의 행은 `null`. 주소·이름은 표시 정화.
 */
function consoleActor(row: ConsoleRow): Record<string, unknown> | null {
  // 운영자 CLI(삭제 · 조직 동결/해제) · 플랫폼 자동 보호(공유 도메인 평판 동결) — 종류만(202610131610).
  if (row.actor_operator_kind !== null) return { kind: row.actor_operator_kind };
  if (row.actor_key_label !== null) {
    return { kind: 'org_key', label: sanitizeDisplayText(row.actor_key_label, TOKEN_LABEL_MAX_LENGTH), hint: row.actor_key_hint };
  }
  if (row.actor_email !== null) return { kind: 'user', email: displayAddress(row.actor_email) };
  return null;
}

function consoleItem(row: ConsoleRow): Record<string, unknown> {
  return { id: row.id, at: row.at.toISOString(), action: code(row.action), targetId: row.target_id, actor: consoleActor(row) };
}

/** 행위자 조인 — 조직 키 → 이름·끝 4자(같은 조직 조건). 세션 행위의 사용자 주소는 `withActorEmails`(admin 은 세션 id 를 읽지 않는다). */
const CONSOLE_ACTOR_SQL = `k.label AS actor_key_label, k.hint AS actor_key_hint,
       CASE WHEN o.operator_actor LIKE 'system:%' THEN 'system' WHEN o.operator_actor IS NOT NULL THEN 'operator' END AS actor_operator_kind
       FROM owner_actions o
       LEFT JOIN org_api_keys k ON k.id = o.org_api_key_id AND k.organization_id = o.organization_id`;

type ConsoleQueryRow = Omit<ConsoleRow, 'actor_email'>;

/**
 * 세션 행위의 사용자 주소 — SECURITY DEFINER 함수(202609250170 `owner_action_actor_emails`)가 조직 범위로 `(id, email)` 만 돌려준다.
 * 키 행위 행은 묻지 않는다. 사용자 결속 전 세션의 행은 주소가 없다(`null`).
 */
async function withActorEmails(call: AdminCall, organizationId: string, rows: readonly ConsoleQueryRow[]): Promise<ConsoleRow[]> {
  const ids = rows.filter((row) => row.actor_key_label === null && row.actor_operator_kind === null).map((row) => row.id);
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const found = await call.deps.pool.query<{ id: string; email: string }>(
      'SELECT id::text AS id, email FROM owner_action_actor_emails($1::uuid, $2::uuid[])',
      [organizationId, ids],
    );
    for (const row of found.rows) emails.set(row.id, row.email);
  }
  return rows.map((row) => ({ ...row, actor_email: emails.get(row.id) ?? null }));
}

async function listConsole(call: AdminCall, session: OwnerSession, agentId: string | null, cursor: Cursor | null, limit: number) {
  const values: unknown[] = [session.organizationId, limit + 1];
  const param = binder(values);
  const agentClause = agentId === null ? '' : `AND o.target_id = ${param(agentId)}`;
  const cursorClause = cursor === null ? '' : `AND (o.created_at, o.id) < (${param(cursor.at)}::timestamptz, ${param(cursor.id)}::uuid)`;
  const result = await call.deps.pool.query<ConsoleQueryRow>(
    `SELECT o.id, o.created_at AS at, ${AT_KEY('o.created_at')} AS at_key, o.action, o.target_id, ${CONSOLE_ACTOR_SQL}
      WHERE o.organization_id = $1 ${agentClause} ${cursorClause}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2`,
    values,
  );
  return paginate('console', await withActorEmails(call, session.organizationId, result.rows), limit, consoleItem);
}

async function consoleDetail(call: AdminCall, session: OwnerSession, id: string): Promise<Record<string, unknown> | null> {
  const result = await call.deps.pool.query<ConsoleQueryRow>(
    `SELECT o.id, o.created_at AS at, ${AT_KEY('o.created_at')} AS at_key, o.action, o.target_id, ${CONSOLE_ACTOR_SQL}
      WHERE o.id = $2::uuid AND o.organization_id = $1`,
    [session.organizationId, id],
  );
  const row = (await withActorEmails(call, session.organizationId, result.rows))[0];
  return row === undefined ? null : { ...consoleItem(row), ...(await tlogEntry(call, session, 'owner_actions', [row.id])) };
}

/**
 * 상세의 투명성 로그 잎(US-010 · T3) — `tlogEntryId`(있으면 `GET /api/logs/inclusion-proof?entry=` 로 증명을 받는다) · `tlogPending`
 * (잎이 아직 체크포인트 전). 조직 범위는 `tlogEntryRefFor` 의 SQL(`tlog_logs.organization_id`)과 이미 조직으로 고른 원천 id 두 겹이다.
 */
async function tlogEntry(
  call: AdminCall,
  session: OwnerSession,
  table: TlogSourceTable,
  ids: readonly string[],
): Promise<{ readonly tlogEntryId: string | null; readonly tlogPending: boolean }> {
  const ref = await tlogEntryRefFor(call.deps.pool, session.organizationId, { table, ids });
  return { tlogEntryId: ref.entryId, tlogPending: ref.pending };
}

// ---------------------------------------------------------------------------
// 예약(메일 기본기 A3 — 취소 사유·경로를 소유자가 본다)
// ---------------------------------------------------------------------------

interface ScheduledRow {
  id: string;
  agent_id: string;
  agent_name: string;
  at: Date;
  at_key: string;
  status: string;
  from_address: string;
  recipients: string[] | null;
  recipient_count: number;
  created_at: Date;
  dispatched_at: Date | null;
  dispatch_outcome: string | null;
  message_id: string | null;
  cancelled_at: Date | null;
  cancel_reason_code: string | null;
  cancel_note: string | null;
  cancelled_via: string | null;
  agent_cancellable: boolean;
}

/** 예약 행의 칸 — admin 롤이 SELECT 할 수 있는 칸만(202609260120). `recipients` 는 호출자가 고른다(목록은 앞쪽 몇 개, 상세는 전부). */
const SCHEDULED_COLUMNS = (recipients: string): string => `s.id, s.agent_id, s.send_at AS at, ${AT_KEY('s.send_at')} AS at_key, s.status::text AS status,
         s.from_address, ${recipients} AS recipients, cardinality(s.recipients) AS recipient_count, s.created_at, s.dispatched_at,
         s.dispatch_outcome, s.message_id, s.cancelled_at, s.cancel_reason_code, s.cancel_note, s.cancelled_via, s.agent_cancellable`;

function scheduledItem(row: ScheduledRow): Record<string, unknown> {
  return {
    id: row.id,
    at: row.at.toISOString(),
    agentId: row.agent_id,
    agentName: displayName(row.agent_name),
    from: displayAddress(row.from_address),
    recipients: (row.recipients ?? []).map(displayAddress),
    recipientCount: row.recipient_count,
    status: row.status,
    sendAt: row.at.toISOString(),
    createdAt: row.created_at.toISOString(),
    dispatchedAt: iso(row.dispatched_at),
    dispatchOutcome: row.dispatch_outcome === null ? null : code(row.dispatch_outcome),
    messageId: row.message_id,
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason_code === null ? null : code(row.cancel_reason_code),
    // 취소 경로 — `mcp`(에이전트 도구) · `http`(API) · `console`(소유자 콘솔, 202609260125). 닫힌 세 값(DB CHECK)이지만 표시 문자열이라 한 번 더 거른다.
    cancelledVia: row.cancelled_via !== null && (SCHEDULED_CANCELLED_VIA as readonly string[]).includes(row.cancelled_via) ? row.cancelled_via : null,
    // 메모는 에이전트가 쓴 글이다 — 표시 정화(제어문자·양방향 문자 등).
    cancelNote: row.cancel_note === null ? null : sanitizeDisplayText(row.cancel_note, CANCEL_NOTE_MAX_CHARS),
    agentCancellable: row.agent_cancellable,
  };
}

async function listScheduled(call: AdminCall, session: OwnerSession, agentId: string | null, status: string | null, cursor: Cursor | null, limit: number) {
  const values: unknown[] = [session.organizationId, limit + 1];
  const param = binder(values);
  const agentClause = agentId === null ? '' : `AND ag.id = ${param(agentId)}`;
  const statusClause = status === null ? '' : `AND s.status = ${param(status)}::scheduled_send_status`;
  const cursorClause = cursor === null ? '' : `AND (s.send_at, s.id) < (${param(cursor.at)}::timestamptz, ${param(cursor.id)}::uuid)`;
  const result = await call.deps.pool.query<ScheduledRow>(
    `SELECT x.*, ag.name AS agent_name
       FROM agents ag
       CROSS JOIN LATERAL (
         SELECT ${SCHEDULED_COLUMNS(`s.recipients[1:${String(RECIPIENT_PREVIEW)}]`)}
           FROM scheduled_sends s
          WHERE s.agent_id = ag.id ${statusClause} ${cursorClause}
          ORDER BY s.send_at DESC, s.id DESC
          LIMIT $2
       ) x
      WHERE ag.organization_id = $1 ${agentClause}
      ORDER BY x.at DESC, x.id DESC
      LIMIT $2`,
    values,
  );
  return paginate('scheduled', result.rows, limit, scheduledItem);
}

async function scheduledDetail(call: AdminCall, session: OwnerSession, id: string): Promise<Record<string, unknown> | null> {
  const result = await call.deps.pool.query<ScheduledRow>(
    `SELECT ${SCHEDULED_COLUMNS('s.recipients')}, ag.name AS agent_name
       FROM scheduled_sends s JOIN agents ag ON ag.id = s.agent_id
      WHERE s.id = $2::uuid AND ag.organization_id = $1`,
    [session.organizationId, id],
  );
  const row = result.rows[0];
  // 예약 행은 투명성 로그 원천이 아니다 — 잎이 없다.
  return row === undefined ? null : { ...scheduledItem(row), tlogEntryId: null, tlogPending: false };
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

/** `GET /api/logs` */
export async function handleListLogs(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const query = call.request.query;
  const type = parseType(query['type']);
  const decision = parseDecision(type, query);
  const inboundFilters = parseInboundFilters(type, query);
  const limit = parseLimit(query['limit']);
  const cursor = decodeCursor(type, query['before']);
  const agentId = query['agent'] === undefined ? null : await requireAgentInOrganization(call.deps.pool, session, query['agent']);
  const page =
    type === 'outbound'
      ? await listOutbound(call, session, agentId, decision, cursor, limit)
      : type === 'inbound'
        ? await listInbound(call, session, agentId, decision, inboundFilters, cursor, limit)
        : type === 'scheduled'
          ? await listScheduled(call, session, agentId, decision, cursor, limit)
          : await listConsole(call, session, agentId, cursor, limit);
  return jsonResponse(200, page);
}

/** `GET /api/logs/{type}/{id}` */
export async function handleLogDetail(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const type = parseType(call.params['type']);
  const id = call.params['id'] ?? '';
  if (!UUID_PATTERN.test(id)) throw new AdminInputError('id 는 로그 항목 id(uuid)다.', 'invalid_log_id');
  const detail =
    type === 'outbound'
      ? await outboundDetail(call, session, id)
      : type === 'inbound'
        ? await inboundDetail(call, session, id)
        : type === 'scheduled'
          ? await scheduledDetail(call, session, id)
          : await consoleDetail(call, session, id);
  if (detail === null) throw notFound('로그 항목이 없다.', 'log_not_found');
  return jsonResponse(200, detail);
}
