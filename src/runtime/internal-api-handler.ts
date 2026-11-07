/**
 * src/runtime/internal-api-handler.ts — api λ 의 내부 이벤트 처리(모양은 `internal-api-event.ts`). api 핸들러만 import 한다 — DB 풀(앱 롤)과 웹훅
 * 키링을 쓰므로 부르는 쪽(admin λ) 번들에 들어가면 안 된다.
 */

import type { Pool } from 'pg';

import { nextWebhookAuthorizationGeneration } from '../db/repositories/webhook-store';
import { toAgentId } from '../db/schema';
import { log } from '../observability/logger';
import { activeKey, type HmacKeyring } from '../security/hmac-keyring';
import { parseWebhookAuthorization, sealWebhookAuthorization } from '../webhooks/authorization';
import { canonicalWebhookUrl, issueConsoleWebhookSecret } from '../webhooks/management';
import type { InternalApiEvent, InternalApiResult } from './internal-api-event';

/** 내부 이벤트 처리 — api λ 의 풀(앱 롤)과 웹훅 키링. 던지지 않는다(실패는 `unavailable`). */
export async function handleInternalApiEvent(
  deps: { readonly db: Pool; readonly keyring: HmacKeyring },
  event: InternalApiEvent,
): Promise<InternalApiResult> {
  try {
    if (event.kind === 'webhook.activeKid') return { ok: true, kid: activeKey(deps.keyring).kid };
    if (event.kind === 'webhook.sealAuthorization') {
      // 봉인만 한다. 그 전에 대상을 DB 에서 다시 본다(보안 리뷰 L3 — `sealTargetEligible`). 값은 로그에 없다.
      const url = canonicalWebhookUrl(event.url);
      if (url === null) return { ok: false, error: 'invalid_url' };
      const parsed = parseWebhookAuthorization(event.authorization);
      if (parsed.kind !== 'value') return { ok: false, error: 'invalid_authorization' };
      const agentId = toAgentId(event.agentId);
      if (!(await sealTargetEligible(deps.db, { ...event, agentId, url }))) {
        log('warn', 'webhook.console_authorization_refused', {
          agent_id: agentId,
          route_id: 'internal:webhook.sealAuthorization',
          outcome: 'not_eligible',
          detail: `endpoint:${event.endpointId} purpose:${event.purpose}`,
        });
        return { ok: false, error: 'not_eligible' };
      }
      // 세대(재검증 L2) — 새 등록은 1, 교체는 지금 세대 + 1. 설정 함수가 같은 값을 다시 확인한다(그 사이 바뀌면 stale).
      const generation = event.purpose === 'register' ? 1 : await nextWebhookAuthorizationGeneration(deps.db, event.endpointId);
      const sealed = sealWebhookAuthorization(deps.keyring, { agentId, endpointId: event.endpointId, generation, url }, parsed.value);
      return { ok: true, url, ...sealed };
    }
    const agentId = toAgentId(event.agentId);
    const secret = await issueConsoleWebhookSecret(deps.db, deps.keyring, agentId, event.endpointId);
    if (secret === null) {
      log('warn', 'webhook.console_secret_refused', { agent_id: agentId, route_id: 'internal:webhook.issueSecret', outcome: 'not_eligible' });
      return { ok: false, error: 'not_eligible' };
    }
    log('info', 'webhook.console_secret_issued', {
      agent_id: agentId,
      route_id: 'internal:webhook.issueSecret',
      outcome: 'issued',
      detail: `endpoint:${event.endpointId}`,
    });
    return { ok: true, secret };
  } catch (error) {
    log('error', 'webhook.console_secret_failed', {
      route_id: `internal:${event.kind}`,
      outcome: 'unavailable',
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * 봉인 대상 확인(보안 리뷰 L3) — 에이전트가 그 조직의 것이고 삭제되지 않았다 · `replace` 면 엔드포인트가 있고 켜져 있고 그 에이전트 · 그 정규화 URL 의
 * 것이다 · `register` 면 그 id 의 행이 아직 없다(콘솔이 곧 그 id 로 등록한다 — 등록 정의자 함수가 PK 로 한 번 더 막는다). 앱 롤 읽기 둘.
 */
async function sealTargetEligible(
  db: Pool,
  target: { readonly agentId: string; readonly organizationId: string; readonly endpointId: string; readonly url: string; readonly purpose: 'register' | 'replace' },
): Promise<boolean> {
  const agent = await db.query<{ organization_id: string; status: string }>('SELECT organization_id::text AS organization_id, status::text AS status FROM agents WHERE id = $1', [
    target.agentId,
  ]);
  const row = agent.rows[0];
  if (row === undefined || row.organization_id !== target.organizationId || row.status === 'disabled') return false;
  const endpoint = await db.query<{ agent_id: string; url: string; disabled: boolean }>(
    'SELECT agent_id::text AS agent_id, url, (disabled_at IS NOT NULL) AS disabled FROM webhook_endpoints WHERE id = $1::uuid',
    [target.endpointId],
  );
  const found = endpoint.rows[0];
  if (target.purpose === 'register') return found === undefined;
  return found !== undefined && !found.disabled && found.agent_id === target.agentId && found.url === target.url;
}
