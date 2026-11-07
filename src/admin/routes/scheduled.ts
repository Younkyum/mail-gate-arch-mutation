/**
 * src/admin/routes/scheduled.ts — 콘솔 예약 취소(메일 기본기 1차 Y2 — 진윤겸 결정 2026-09-26, `.omc/handoffs/mail-basics-fix2.md`).
 *
 *   - `POST /api/scheduled/{scheduleId}/cancel {reasonCode, note?}` → `{id, status, cancelledAt, cancelReason, cancelledVia, replayed}`
 *
 * 역할은 라우터 표가 막는다(admin 이상 — owner·admin 성공, member 403 `forbidden_role`). CSRF·Origin 도 라우터가 본다(세션 POST).
 * 에이전트 경로와 달리 **보호 예약(`agent_cancellable = false`)도 취소하고 상한이 없다** — 소유자가 주입 메일의 유도 취소를 우회하는 길이다.
 * 판정 순서는 에이전트 경로와 같다: 없음(다른 조직 포함 → 404) · 이미 취소(200 `replayed`, 감사 없음) · 발송됨(409) · 발송 중(409) · 취소.
 * 쓰기는 정의자 함수 하나(`console_cancel_scheduled_send`, 202609260125 — 경로 리터럴 `console`)이고, 감사 1행(`scheduled.cancel`, `target_id` =
 * 예약 id — 수신자·메모 같은 PII 없음)과 **한 트랜잭션**이다(`audited`). 에이전트 알람 로그·메트릭(`scheduled.cancelled`)은 내지 않는다 —
 * 그 알람은 에이전트 취소만 센다.
 */

import { CANCEL_REASON_CODES, MAX_CANCEL_NOTE_LENGTH, type CancelReasonCode } from '../../db/schema';
import { cancelScheduledFromConsole, type ConsoleScheduledCancelOutcome } from '../../db/repositories/scheduled-send-store';
import { audited, objectBody, rejectUnknownKeys, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { AdminInputError, notFound, UUID_PATTERN } from '../ops/errors';

/** 메모 금지 문자 — 에이전트 경로(`api/routes/scheduled-queries.ts`)와 같다. DB CHECK 는 `[[:cntrl:]]` 를 본다. */
const NOTE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const CANCEL_KEYS: ReadonlySet<string> = new Set(['reasonCode', 'note']);

const SCHEDULE_CANCEL_ACTION = 'scheduled.cancel';

function parseReason(raw: unknown): CancelReasonCode {
  if (typeof raw !== 'string' || !(CANCEL_REASON_CODES as readonly string[]).includes(raw)) {
    throw new AdminInputError(`reasonCode 가 필요하다 — ${CANCEL_REASON_CODES.join(' · ')} 중 하나.`, 'invalid_reason_code');
  }
  return raw as CancelReasonCode;
}

function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new AdminInputError('note 는 문자열이다.', 'invalid_note');
  if (NOTE_FORBIDDEN.test(raw)) throw new AdminInputError('note 에 제어문자·줄바꿈을 쓸 수 없다.', 'invalid_note');
  const note = raw.trim();
  // DB 의 char_length 와 같은 단위(코드 포인트).
  if ([...note].length > MAX_CANCEL_NOTE_LENGTH) throw new AdminInputError(`note 는 ${String(MAX_CANCEL_NOTE_LENGTH)}자 이하다.`, 'invalid_note');
  return note === '' ? null : note;
}

/** `POST /api/scheduled/{scheduleId}/cancel` */
export async function handleCancelScheduled(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const id = call.params['scheduleId'] ?? '';
  if (!UUID_PATTERN.test(id)) throw new AdminInputError('scheduleId 는 예약 id(소문자 uuid)다.', 'invalid_schedule_id');
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, CANCEL_KEYS);
  const reasonCode = parseReason(body['reasonCode']);
  const note = parseNote(body['note']);

  const outcome: ConsoleScheduledCancelOutcome = await audited(
    call.deps.pool,
    session,
    SCHEDULE_CANCEL_ACTION,
    (tx) => cancelScheduledFromConsole(tx, { organizationId: session.organizationId, id, reasonCode, note }),
    // 새로 취소한 때만 감사 — 재생·거부는 상태를 바꾸지 않았다.
    (result) => (result.kind === 'cancelled' ? id : undefined),
  );
  switch (outcome.kind) {
    case 'not_found':
      throw notFound('예약이 없다.', 'schedule_not_found');
    case 'already_dispatched':
      throw new AdminInputError('이미 발송된 예약이다 — 나간 메일은 거둘 수 없다.', 'schedule_already_dispatched', 409);
    case 'in_flight':
      throw new AdminInputError('지금 발송 중인 예약이다 — 잠시 뒤 다시 보라.', 'schedule_in_flight', 409);
    case 'replayed':
    case 'cancelled':
      return jsonResponse(200, {
        id,
        status: 'cancelled',
        cancelledAt: outcome.cancelledAt.toISOString(),
        cancelReason: outcome.reasonCode,
        cancelledVia: outcome.cancelledVia,
        replayed: outcome.kind === 'replayed',
      });
  }
}
