/**
 * src/admin/routes/ai-watch.ts — 조직 설정 "AI 의심 메일 감시"(ADR-0017 · 연산 `ops/ai-watch.ts`).
 *
 *   - `GET   /api/settings/ai-watch`              → 200 `{feature, enabled}`          member(보기)
 *   - `PATCH /api/settings/ai-watch {enabled}`    → 200 `{feature, enabled, changed}`  admin(끄기) · **owner(켜기)**
 *
 * 켜기는 소유자만 — 수신 본문 일부를 운영자 장비의 분류 모델로 보내는 데이터 처리를 켜는 일이라(설계 §7.3 "소유자만으로 시작"). 끄기는 관리자도
 * 된다(안전한 쪽 · 조직 긴급 정지와 반대 방향의 같은 규율). 켜기는 허용 목록이 없으면 403 `feature_not_enabled`.
 * 행위와 감사 1행(`org.ai_watch.on` · `org.ai_watch.off`, 대상 = 조직 id)은 한 트랜잭션이다(`audited`). 이미 그 상태인 호출은 감사하지 않는다.
 */

import { audited, objectBody, rejectUnknownKeys, requireRole, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { AI_WATCH_OFF_ACTION, AI_WATCH_ON_ACTION, aiWatchEnabledOf, getAiWatchSettingOp, setAiWatchOp } from '../ops/ai-watch';

const KEYS: ReadonlySet<string> = new Set(['enabled']);

/** `GET /api/settings/ai-watch` */
export async function handleGetAiWatch(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, await getAiWatchSettingOp(call.deps.pool, sessionOf(call).organizationId));
}

/** `PATCH /api/settings/ai-watch {enabled}` */
export async function handleSetAiWatch(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, KEYS);
  const enabled = aiWatchEnabledOf(body['enabled']);
  if (enabled) requireRole(session, 'owner');
  const result = await audited(
    call.deps.pool,
    session,
    enabled ? AI_WATCH_ON_ACTION : AI_WATCH_OFF_ACTION,
    (tx) => setAiWatchOp(tx, session.organizationId, enabled),
    (outcome) => (outcome.changed ? session.organizationId : undefined),
  );
  return jsonResponse(200, { feature: result.feature, enabled: result.enabled, changed: result.changed });
}
