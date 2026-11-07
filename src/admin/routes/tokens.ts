/**
 * src/admin/routes/tokens.ts — 에이전트 토큰 목록·새 토큰·한 개 폐기·이름 바꾸기·한 개 교체 (콘솔 v4 D7 · 명세 §(e) E3–E6,
 * 계약 `.omc/handoffs/console-v4-api.md` §1 · 한 개 교체는 2026-09-27 진윤겸 요청).
 *
 * 이 파일은 세션 조직 범위 검사 · 본문 해석 · 감사 1행 · 응답 모양만 한다(로직은 `ops/tokens.ts`·`ops/agents.ts`).
 * 행위와 감사 1행은 **한 트랜잭션**(`audited`). 감사 `target_id` 는 **에이전트 id** — 기존 `agent.token.rotate`·`revoke_all` 과 같고, 에이전트
 * 로그 필터(`GET /api/logs?type=console&agent=`)에 그대로 걸린다. 어느 토큰인지(한 개 폐기·이름 바꾸기·한 개 교체)는 같은 트랜잭션에서
 * 그 감사 행을 가리키는 `agent_api_key_events` 한 행이 적는다(토큰 id · 이름 전·후 · 교체의 새 토큰 id — `recordTokenEvent`).
 * 새 토큰·한 개 폐기·이름 바꾸기·한 개 교체는 조직당 분당 상한(`limitTokenChanges` → 429 `rate_limited`)을 먼저 본다.
 * 토큰 평문은 새 토큰·교체 응답에 **한 번** 실리고 어디에도 남지 않는다. 해시는 어느 응답에도 없다.
 */

import { requireEnrollGrantable } from '../ops/enroll';
import { AdminInputError } from '../ops/errors';
import { capabilitiesFromBody, expiryFromDays, issueAgentTokenOp, supersedeAgentTokenOp } from '../ops/agents';
import {
  limitTokenChanges,
  listAgentTokensOp,
  recordTokenEvent,
  renameAgentTokenOp,
  resolveTokenLabel,
  revokeAgentTokenOp,
  TOKEN_LABEL_MAX_LENGTH,
  type TokenListScope,
  type TokenView,
} from '../ops/tokens';
import { audited, objectBody, optionalBody, rejectUnknownKeys, requireAgentInOrganization, requireRole, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { sanitizeDisplayText } from '../../notify/approval-notification-template';

/** 표시 정화(이중 방어 — 이름은 저장 때 이미 검사됐다). id·끝 4자는 그대로. */
export function tokenForDisplay(item: TokenView): TokenView {
  return { ...item, label: item.label === null ? null : sanitizeDisplayText(item.label, TOKEN_LABEL_MAX_LENGTH) };
}

/** `GET /api/agents/{agentId}/tokens?status=active|all` → `{tokens, activeCount, maxActive}` */
export async function handleListTokens(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  const raw = call.request.query['status'] ?? 'active';
  if (raw !== 'active' && raw !== 'all') throw new AdminInputError("status 는 'active' | 'all' 이다.", 'invalid_status');
  const view = await listAgentTokensOp(call.deps.pool, agentId, raw as TokenListScope);
  return jsonResponse(200, { ...view, tokens: view.tokens.map(tokenForDisplay) });
}

const ISSUE_KEYS: ReadonlySet<string> = new Set(['label', 'expiresDays', 'capabilities']);

/** `POST /api/agents/{agentId}/tokens {label, expiresDays?, capabilities?}` → 201 `{token, item}` — **평문은 이 응답 한 번뿐**. */
export async function handleIssueToken(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, ISSUE_KEYS);
  const label = resolveTokenLabel(body['label'], true);
  const expiresAt = expiryFromDays(body['expiresDays'], call.deps.now());
  const capabilities = capabilitiesFromBody(body['capabilities']);
  // 자가 등록 권한(`agents:enroll`, ADR-0016 2026-10-08)은 **소유자만** 준다 — 에이전트가 같은 조직에 에이전트를 만드는 길을 여는 쪽이다(신뢰 발신자와 같은 결).
  if (capabilities.includes('agents:enroll')) {
    requireRole(session, 'owner');
    await requireEnrollGrantable(call.deps.pool, agentId);
  }
  const issued = await audited(
    call.deps.pool,
    session,
    'agent.token.issue',
    async (tx) => {
      await limitTokenChanges(tx, session.organizationId);
      return issueAgentTokenOp(tx, agentId, { capabilities, expiresAt, label });
    },
    () => agentId,
  );
  return jsonResponse(201, { token: issued.token, item: tokenForDisplay(issued.item) });
}

/** `POST /api/agents/{agentId}/tokens/{tokenId}/revoke` → `{item}` — 멱등(이미 폐기면 그대로, 감사 없음). 감사 상세 = 토큰 id. */
export async function handleRevokeToken(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const tokenId = call.params['tokenId'] ?? '';
  const result = await audited(
    call.deps.pool,
    session,
    'agent.token.revoke',
    async (tx) => {
      await limitTokenChanges(tx, session.organizationId);
      return revokeAgentTokenOp(tx, agentId, tokenId);
    },
    (change) => (change.changed ? agentId : undefined),
    recordTokenEvent,
  );
  return jsonResponse(200, { item: tokenForDisplay(result.item) });
}

const RENAME_KEYS: ReadonlySet<string> = new Set(['label']);

/**
 * `PATCH /api/agents/{agentId}/tokens/{tokenId} {label}` → `{item}` — 활성 토큰만(폐기·만료 → 409 `token_not_active`). 같은 이름이면 감사
 * 없음. 감사 상세 = 토큰 id · 이름 전·후.
 */
export async function handleRenameToken(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const tokenId = call.params['tokenId'] ?? '';
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, RENAME_KEYS);
  const label = resolveTokenLabel(body['label'], true) ?? '';
  const result = await audited(
    call.deps.pool,
    session,
    'agent.token.rename',
    async (tx) => {
      await limitTokenChanges(tx, session.organizationId);
      return renameAgentTokenOp(tx, agentId, tokenId, label);
    },
    (change) => (change.changed ? agentId : undefined),
    recordTokenEvent,
  );
  return jsonResponse(200, { item: tokenForDisplay(result.item) });
}

const ROTATE_KEYS: ReadonlySet<string> = new Set(['expiresDays']);

/**
 * `POST /api/agents/{agentId}/tokens/{tokenId}/rotate {expiresDays?}` → 201 `{token, item, revoked}` — 그 토큰 폐기 + 같은 이름·권한의 새
 * 토큰이 한 트랜잭션(`supersedeAgentTokenOp`). 만료 생략(또는 `null`) = 옛 토큰과 같은 수명 — 조직 키 교체와 같다. 활성 토큰만(409
 * `token_not_active`). **평문은 이 응답 한 번뿐.** 감사 `agent.token.rotate_one`(대상 = 에이전트 id) + 상세 한 행(옛 토큰 id → 새 토큰 id).
 */
export async function handleRotateToken(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const tokenId = call.params['tokenId'] ?? '';
  const body = optionalBody(call.request.body);
  rejectUnknownKeys(body, ROTATE_KEYS);
  const expiresAt = body['expiresDays'] === undefined || body['expiresDays'] === null ? undefined : expiryFromDays(body['expiresDays'], call.deps.now());
  const rotated = await audited(
    call.deps.pool,
    session,
    'agent.token.rotate_one',
    async (tx) => {
      await limitTokenChanges(tx, session.organizationId);
      return supersedeAgentTokenOp(tx, agentId, tokenId, expiresAt);
    },
    () => agentId,
    (tx, ownerActionId, result) => recordTokenEvent(tx, ownerActionId, { item: result.revoked, changed: true }, result.item.id),
  );
  return jsonResponse(201, { token: rotated.token, item: tokenForDisplay(rotated.item), revoked: tokenForDisplay(rotated.revoked) });
}
