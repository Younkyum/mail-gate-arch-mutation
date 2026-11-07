/**
 * src/admin/routes/agents.ts — 에이전트 프로비저닝·토큰·정책·연락처 목록 (계약 `/api/agents/**` · 정책 v2 계약 §1).
 *
 * 로직은 CLI 와 **같은 함수**(`src/admin/ops/**`)다 — 이 파일은 세션 조직 범위 검사 · 본문 해석 · 감사 1행 · 응답 모양만 한다.
 * 행위와 감사 1행은 **한 트랜잭션**이다(`audited` — 감사가 실패하면 행위도 없다).
 * 토큰 평문은 응답에 **한 번** 실리고 어디에도 남지 않는다(감사 행에도 없다). DID 는 어느 응답에도 없다.
 */

import { OWNER_CREATED_OUTBOUND_MODE } from '../../db/schema';
import { CHANNELS, isChannel } from '../channels';
import { requireEnrollGrantable } from '../ops/enroll';
import { AdminInputError, notFound } from '../ops/errors';
import { AGENT_CREATE_TAKEN_ACTION } from '../ops/addresses';
import {
  addressConflict,
  capabilitiesFromBody,
  customPrimaryDomainOf,
  DEFAULT_BUDGET_CENTS,
  deleteAgentOp,
  expiryFromDays,
  getAgentOp,
  listAgentsOp,
  listAgentsPageOp,
  provisionAgentOp,
  resolveAgentPageQuery,
  revokeAgentTokensOp,
  type ProvisionOutcome,
} from '../ops/agents';
import { resolveTokenLabel } from '../ops/tokens';
import { tokenForDisplay } from './tokens';
import { changePolicyOp, readPolicyOp, resolvePolicyChange, type PolicyView, type RuleView } from '../ops/policy';
import { addRuleOp, removeRuleOp, resolveContactRuleInput } from '../ops/rules';
import { actorOfSession, audited, objectBody, optionalBody, rejectUnknownKeys, requireAgentInOrganization, requireRole, sessionOf, type AdminCall } from '../context';
import { displayAddress, displayName } from '../display';
import { jsonResponse, type AdminResponse } from '../http';
import type { AgentView } from '../ops/agents';

/** 표시 문자열(이름·주소)만 정화한다 — id 는 그대로. */
export function agentForDisplay(agent: AgentView): AgentView {
  return { ...agent, name: displayName(agent.name), address: agent.address === null ? null : displayAddress(agent.address) };
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AdminInputError(`${name} 는 문자열이다.`, 'invalid_body');
  return value;
}

/**
 * `GET /api/agents` → 옛 모양 `AgentView[]`. **삭제한 에이전트(`disabled`)는 빠진다**(2026-10-13 — 목록은 쓰는 에이전트만 · 요금제 수와 같은 셈).
 * 삭제한 에이전트는 `GET /api/agents/{id}`(읽기 전용 화면) · 로그로 본다. 조직 키 목록(`/org-api/v1/agents`)은 그대로 `status: disabled` 로 싣는다. `limit`·`cursor`·`q` 중 하나라도 오면 `{items, nextCursor}`(확장성 P1 R-9) — 쿼리 없는
 * 호출(열린 옛 탭·기존 테스트)은 모양이 바뀌지 않는다.
 */
export async function handleListAgents(call: AdminCall): Promise<AdminResponse> {
  const organizationId = sessionOf(call).organizationId;
  const page = resolveAgentPageQuery(call.request.query);
  if (page === null) return jsonResponse(200, (await listAgentsOp(call.deps.pool, organizationId, { excludeDeleted: true })).map(agentForDisplay));
  const result = await listAgentsPageOp(call.deps.pool, organizationId, page, { excludeDeleted: true });
  return jsonResponse(200, { items: result.items.map(agentForDisplay), nextCursor: result.nextCursor });
}

/** `GET /api/agents/{agentId}` → `AgentView`(딥링크 첫 칠 — 목록을 기다리지 않는다). 다른 조직·없음 = 404 `agent_not_found`. */
export async function handleGetAgent(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  const agent = await getAgentOp(call.deps.pool, agentId);
  if (agent === null) throw notFound('에이전트가 없다.', 'agent_not_found');
  return jsonResponse(200, agentForDisplay(agent));
}

/**
 * 채널 별칭(확장성 P1 R-5) — `/api/agents/{agentId}/channels/{channel}/…` 를 옛 핸들러로. **에이전트 조직 검사가 먼저**다(다른 조직의
 * 에이전트는 채널과 무관하게 `agent_not_found` — 채널 404 로 존재가 새지 않는다). 그 뒤 채널이 목록 밖이면 404 `channel_not_found`.
 * 옛 핸들러가 조직 검사를 한 번 더 한다(같은 결과 — 별칭이 검사를 건너뛰지 않게 옛 경로와 같은 함수를 그대로 부른다).
 */
export function channelAlias(handler: (call: AdminCall) => Promise<AdminResponse>): (call: AdminCall) => Promise<AdminResponse> {
  return async (call) => {
    await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
    if (!isChannel(call.params['channel'])) throw notFound(`채널이 없다(가능: ${CHANNELS.join(', ')}).`, 'channel_not_found');
    return handler(call);
  };
}

/**
 * `POST /api/agents {name, localPart, domain?, primary?}` → 201 `{agent, token}` — **토큰은 이 응답 한 번뿐**. `domain`(고객 도메인)이면 그 주소가 대표이고
 * @atmark.ai 앵커는 내부에만 둔다(ADR-0014 2026-10 개정 — `customPrimaryDomainOf`). 조직은 세션에서만 온다 — 다른 조직의 도메인은 verified 로 보이지
 * 않으므로 400 `domain_not_verified`(정의자 함수 `atmark_provision_custom_primary` 는 호출자 조직을 모른다 — 그 대조는 여기와 DB 가드 P0A05 가 한다).
 */
export async function handleCreateAgent(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const name = optionalString(body, 'name');
  const localPart = optionalString(body, 'localPart');
  if (name === undefined || localPart === undefined) throw new AdminInputError('name 과 localPart 가 필요하다.', 'invalid_body');
  const customPrimaryDomain = customPrimaryDomainOf(body['domain'], body['primary']);
  const custody = call.deps.custody();
  // 쓸 수 없는 주소 — 시도도 감사 행(`agent.create.taken`, 대상 없음)으로 남기고 커밋한 뒤 예전과 같은 409 `conflict`(재발급 보안 리뷰 M2 —
  // 조직의 하루 주소 탐침 상한에 센다). 키 보관은 돌지 않았다(`provisionAgentOp` 가 주소를 먼저 본다).
  const result = await audited<ProvisionOutcome>(
    call.deps.pool,
    session,
    (outcome) => (outcome.kind === 'taken' ? AGENT_CREATE_TAKEN_ACTION : 'agent.create'),
    (tx) =>
      provisionAgentOp(
        tx,
        {
          organizationId: session.organizationId,
          name,
          localPart,
          seeds: [],
          budgetCents: DEFAULT_BUDGET_CENTS,
          createdBy: actorOfSession(session),
          attachmentFollowsPlan: call.deps.features?.policyAttachmentFollowPlan === true,
          // 콘솔 세션의 소유자가 만든 에이전트만 발신 "전체"로 시작한다(2026-10-13 진윤겸 결정 B). 조직 키 · CLI 는 허용 목록(적대 검증 I08).
          outboundMode: OWNER_CREATED_OUTBOUND_MODE,
          ...(customPrimaryDomain === undefined ? {} : { customPrimaryDomain }),
        },
        custody,
      ),
    (outcome) => (outcome.kind === 'taken' ? null : outcome.agent.id),
  );
  if (result.kind === 'taken') throw addressConflict();
  return jsonResponse(201, { agent: agentForDisplay(result.agent), token: result.token });
}

/**
 * `POST /api/agents/{id}/token {action:'rotate'|'revoke-all', expiresDays?, label?}` → `{revoked, token?, item?}` — 콘솔의 `전부 교체`·`전부 폐기`.
 * `label`·`item`(새 토큰의 화면 모양)은 콘솔 v4 추가 칸이고 rotate 에서만 쓴다.
 */
export async function handleAgentToken(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  const action = body['action'];
  if (action !== 'rotate' && action !== 'revoke-all') throw new AdminInputError("action 은 'rotate' | 'revoke-all' 이다.", 'invalid_action');
  if (action === 'revoke-all' && (body['expiresDays'] !== undefined || body['label'] !== undefined || body['capabilities'] !== undefined)) {
    throw new AdminInputError('revoke-all 은 새 토큰을 만들지 않는다 — expiresDays·label·capabilities 는 rotate 와 쓴다.', 'invalid_body');
  }
  const expiresAt = expiryFromDays(body['expiresDays'], call.deps.now());
  const label = resolveTokenLabel(body['label'], false);
  // 생략하면 기본 권한 · `[]` 는 400(발급과 같은 규칙 — `capabilitiesFromBody`).
  const capabilities = capabilitiesFromBody(body['capabilities']);
  // 자가 등록 권한(`agents:enroll`, ADR-0016 2026-10-08)은 **소유자만** 준다 — 에이전트가 같은 조직에 에이전트를 만드는 길을 여는 쪽이다(신뢰 발신자와 같은 결).
  if (capabilities.includes('agents:enroll')) {
    requireRole(session, 'owner');
    await requireEnrollGrantable(call.deps.pool, agentId);
  }
  const result = await audited(
    call.deps.pool,
    session,
    action === 'rotate' ? 'agent.token.rotate' : 'agent.token.revoke_all',
    (tx) => revokeAgentTokensOp(tx, agentId, action, { capabilities, expiresAt, label }),
    () => agentId,
  );
  return jsonResponse(
    200,
    result.issued === null
      ? { revoked: result.revoked }
      : { revoked: result.revoked, token: result.issued.token, item: tokenForDisplay(result.issued.item) },
  );
}

/** 에이전트 삭제 감사 행위 — 대상 = 에이전트 id. 아무것도 바꾸지 않은 재생은 감사하지 않는다(별칭 폐기와 같다). */
const AGENT_DELETE_ACTION = 'agent.delete';
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * `POST /api/agents/{agentId}/delete` → 200 `{agentId, replayed, addresses, revokedTokens, cancelledScheduled, disabledWebhooks}` — 에이전트 삭제
 * (진윤겸 결정 2026-10-13 — 별칭 폐기와 같은 소프트 삭제, `deleteAgentOp`). 본문은 비어 있어야 한다(모르는 키 400). 역할(admin 이상)·CSRF·Origin
 * 은 라우터 표가 막는다. **콘솔 세션 전용** — 에이전트 토큰 · MCP · 조직 키 표면에는 없다(에이전트가 자기를 지우지 못한다).
 */
export async function handleDeleteAgent(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  rejectUnknownKeys(optionalBody(call.request.body), NO_KEYS);
  const result = await audited(
    call.deps.pool,
    session,
    AGENT_DELETE_ACTION,
    (tx) => deleteAgentOp(tx, session.organizationId, agentId),
    // 재생이 남은 것(주소 · 토큰 · 예약 · 웹훅)을 정리했으면 그것도 감사한다 — 아무것도 바꾸지 않은 재생만 감사하지 않는다.
    (outcome) => (outcome.changed ? agentId : undefined),
  );
  return jsonResponse(200, {
    agentId,
    replayed: result.replayed,
    addresses: result.addresses.map(displayAddress),
    revokedTokens: result.revokedTokens,
    cancelledScheduled: result.cancelledScheduled,
    disabledWebhooks: result.disabledWebhooks,
  });
}

/** 규칙 값의 표시 정화 — 주소와 도메인 모두 한 줄·보이지 않는 문자 제거(값은 이미 ASCII 모양이지만 이중 방어). id 는 그대로. */
function ruleForDisplay(rule: RuleView): RuleView {
  return { ...rule, value: displayAddress(rule.value) };
}

/** 관리 API 의 정책 모양(계약 v2 §1 · T1 메모). 레거시 승인 손잡이(`autoApproveVerificationSenders`)는 싣지 않는다. */
function policyBody(view: PolicyView): Record<string, unknown> {
  return {
    outbound: {
      mode: view.outbound.mode,
      legacyMode: view.outbound.legacyMode,
      allow: view.outbound.allow.map(ruleForDisplay),
      block: view.outbound.block.map(ruleForDisplay),
    },
    inbound: {
      mode: view.inbound.mode,
      allow: view.inbound.allow.map(ruleForDisplay),
      block: view.inbound.block.map(ruleForDisplay),
    },
    limits: view.limits,
    version: view.version,
    ruleLimit: view.ruleLimit,
  };
}

/** `GET /api/agents/{id}/policy` */
export async function handleGetPolicy(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  return jsonResponse(200, policyBody(await readPolicyOp(call.deps.pool, agentId)));
}

const PATCH_KEYS: ReadonlySet<string> = new Set(['outbound', 'inbound', 'limits']);

/** `{mode}` 모양의 하위 객체에서 모드 문자열. 없으면 `undefined`. */
function modeOf(body: Record<string, unknown>, name: 'outbound' | 'inbound'): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new AdminInputError(`${name} 는 {mode} 객체다.`, 'invalid_body');
  const entries = Object.keys(value);
  if (entries.some((key) => key !== 'mode')) throw new AdminInputError(`${name} 에는 mode 만 온다.`, 'invalid_body');
  const mode = (value as Record<string, unknown>)['mode'];
  if (typeof mode !== 'string') throw new AdminInputError(`${name}.mode 는 문자열이다.`, 'invalid_body');
  return mode;
}

/**
 * `PATCH /api/agents/{id}/policy {outbound?:{mode}, inbound?:{mode}, limits?:{perMinute}}` → 새 버전 → 정책 모양.
 * 모드는 콘솔 이름(`all|allowlist|blocklist|none`) — 레거시 승인 모드는 `legacy_mode_rejected`. CLI 와 같은 함수(`resolvePolicyChange`).
 * 모르는 키(옛 `mode`·`autoApproveVerificationSenders` 포함)는 `invalid_body` — 옛 클라이언트가 조용히 무시당하지 않게.
 */
export async function handlePatchPolicy(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, PATCH_KEYS);
  let perMinute: number | undefined;
  const limits = body['limits'];
  if (limits !== undefined && limits !== null) {
    if (typeof limits !== 'object' || Array.isArray(limits)) throw new AdminInputError('limits 는 {perMinute} 객체다.', 'invalid_body');
    const keys = Object.keys(limits);
    if (keys.some((key) => key !== 'perMinute')) throw new AdminInputError('limits 에는 perMinute 만 온다.', 'invalid_body');
    const raw = (limits as Record<string, unknown>)['perMinute'];
    if (raw !== undefined && typeof raw !== 'number') throw new AdminInputError('perMinute 는 숫자다.', 'invalid_per_minute');
    perMinute = raw;
  }
  const change = resolvePolicyChange({
    outboundMode: modeOf(body, 'outbound'),
    inboundMode: modeOf(body, 'inbound'),
    perMinute,
  });
  const view = await audited(call.deps.pool, session, 'agent.policy.change', (tx) => changePolicyOp(tx, agentId, change, actorOfSession(session)), () => agentId);
  return jsonResponse(200, policyBody(view));
}

/** `POST /api/agents/{id}/rules {direction, list, value}` → 201 `{rule, policy}` — 새 버전 · 감사 `agent.rule.add`. */
export async function handleAddRule(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  const input = resolveContactRuleInput({ direction: body['direction'], list: body['list'], value: body['value'] });
  const result = await audited(
    call.deps.pool,
    session,
    'agent.rule.add',
    (tx) => addRuleOp(tx, agentId, input, actorOfSession(session)),
    () => agentId,
  );
  const rule: RuleView = {
    id: result.rule.id,
    kind: result.rule.kind,
    value: result.rule.value,
    createdAt: result.rule.created_at.toISOString(),
  };
  return jsonResponse(201, { rule: ruleForDisplay(rule), policy: policyBody(result.policy) });
}

/** `DELETE /api/agents/{id}/rules/{ruleId}` → `{policy}` — 새 버전 · 감사 `agent.rule.remove`. 남의 규칙·없는 규칙은 같은 404. */
export async function handleRemoveRule(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const ruleId = call.params['ruleId'] ?? '';
  const view = await audited(
    call.deps.pool,
    session,
    'agent.rule.remove',
    (tx) => removeRuleOp(tx, agentId, ruleId, actorOfSession(session)),
    () => agentId,
  );
  return jsonResponse(200, { policy: policyBody(view) });
}
