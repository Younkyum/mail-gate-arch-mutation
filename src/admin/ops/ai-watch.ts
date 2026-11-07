/**
 * src/admin/ops/ai-watch.ts — 조직 설정 "AI 의심 메일 감시"(ADR-0017 · 설계 `docs/internal/plans/ai-mail-watch.md` §7.3)의 연산.
 *
 * 값은 `organizations.ai_mail_watch_enabled` 하나다(마이그레이션 `202610061100_ai_mail_watch.sql` — admin 롤은 이 칸만 UPDATE,
 * `owner_paused` 와 같은 모양). 켜기는 운영자 기능 허용 목록(`org_features.feature = 'ai_mail_watch'`)에 있는 조직만 — 앱이 먼저 보고(403
 * `feature_not_enabled`), DB 가드 트리거 `organizations_ai_mail_watch_guard`(P0A07)가 같은 것을 다시 집행한다. 끄기는 언제나 된다
 * (허용 목록에서 빠진 조직도 끌 수 있어야 한다).
 *
 * **이 값은 경고 표시만 켠다**(D6) — 수신 판정 · 정책 · 관문 · 승인 · 위험 보류는 이 값을 읽지 않는다(arch `ai-watch-boundary`).
 * 이 파일은 `src/inbound/ai-watch/contract.ts` 의 상수만 가져온다(I/O 없는 계약).
 */

import { AI_WATCH_FEATURE } from '../../inbound/ai-watch/contract';
import type { Queryable } from '../../db/client';
import { AdminInputError, notFound, sqlStateOf } from './errors';

export const AI_WATCH_ON_ACTION = 'org.ai_watch.on';
export const AI_WATCH_OFF_ACTION = 'org.ai_watch.off';

/** DB 가드 트리거의 "허용 목록에 없다"(고객 도메인과 같은 코드). */
const FEATURE_SQLSTATE = 'P0A07';

interface AiWatchSetting {
  /** 운영자 허용 목록에 있나 — 거짓이면 콘솔은 잠긴 상태(베타)를 보인다. */
  readonly feature: boolean;
  readonly enabled: boolean;
}

interface AiWatchChange extends AiWatchSetting {
  readonly changed: boolean;
}

function featureNotEnabled(): AdminInputError {
  return new AdminInputError('이 조직에는 AI 의심 메일 감시 기능이 열려 있지 않다.', 'feature_not_enabled', 403);
}

async function readSetting(db: Queryable, organizationId: string, lock: boolean): Promise<AiWatchSetting> {
  const result = await db.query<{ enabled: boolean; feature: boolean }>(
    `SELECT o.ai_mail_watch_enabled AS enabled,
            EXISTS (SELECT 1 FROM org_features f WHERE f.organization_id = o.id AND f.feature = $2) AS feature
       FROM organizations o
      WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`,
    [organizationId, AI_WATCH_FEATURE],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound('조직이 없다.', 'organization_not_found');
  return { feature: row.feature === true, enabled: row.enabled === true };
}

/** `GET /api/settings/ai-watch` */
export function getAiWatchSettingOp(db: Queryable, organizationId: string): Promise<AiWatchSetting> {
  return readSetting(db, organizationId, false);
}

/** 켜짐/꺼짐 본문 값 — 불리언만. */
export function aiWatchEnabledOf(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AdminInputError('enabled 는 true | false 다.', 'invalid_body');
  return value;
}

/**
 * 켜기/끄기. 이미 그 상태면 `changed:false`(감사 행 없음 — 호출자가 `audited` 의 대상 id 를 비운다). 켜기는 허용 목록 필수.
 * 행 잠금(`FOR UPDATE`) 뒤에 읽고 바꾼다 — 동시에 두 번 눌러도 감사 행은 하나다.
 */
export async function setAiWatchOp(db: Queryable, organizationId: string, enabled: boolean): Promise<AiWatchChange> {
  const current = await readSetting(db, organizationId, true);
  if (current.enabled === enabled) return { ...current, changed: false };
  if (enabled && !current.feature) throw featureNotEnabled();
  try {
    await db.query('UPDATE organizations SET ai_mail_watch_enabled = $2 WHERE id = $1', [organizationId, enabled]);
  } catch (error) {
    // 읽은 뒤 운영자가 허용 목록에서 뺐다 — DB 가드가 같은 판정을 한다.
    if (sqlStateOf(error) === FEATURE_SQLSTATE) throw featureNotEnabled();
    throw error;
  }
  return { feature: current.feature, enabled, changed: true };
}
