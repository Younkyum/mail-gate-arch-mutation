/**
 * src/admin/routes/org-api.ts — **조직 API 키 표면** `https://console.atmark.ai/org-api/v1/*` 의 라우트 함수(확장성 P1 R-6 · 계약
 * `.omc/handoffs/p0p1-api.md` B5). 인증·권한·라우트 표는 `src/admin/org-api/router.ts` 이고, 이 파일은 조직 범위 · 본문 해석 · 감사 ·
 * 응답 모양만 한다.
 *
 * - 목록·한 개(agents:read) — 콘솔과 같은 SQL(`listAgentsPageOp`·`getAgentOp`). 목록은 **늘 봉투** `{items, nextCursor}`.
 * - 생성(agents:create) — 콘솔 `POST /api/agents` 와 **같은 프로비저닝 연산**(`provisionAgentOp` — 조직당 상한 · 검토 전 상한 · custody).
 *   행위와 감사 1행(행위자 = 조직 키, `auditedByOrgKey`)이 한 트랜잭션. 첫 에이전트 토큰 평문은 이 응답 **한 번**.
 * 에이전트 메일을 보내지 않는다(관문·전송단 import 없음 — Layer C `NON_SENDING_ENTRYPOINTS`).
 */

import { isAgentId, type AgentId } from '../../db/schema';
import { objectBody, rejectUnknownKeys, type AdminDependencies } from '../context';
import { jsonResponse, type AdminRequest, type AdminResponse } from '../http';
import { AGENT_CREATE_TAKEN_ACTION } from '../ops/addresses';
import { addressConflict, agentOrganizationOf, customPrimaryDomainOf, DEFAULT_BUDGET_CENTS, getAgentOp, listAgentsPageOp, provisionAgentOp, resolveAgentPageQuery, type ProvisionOutcome } from '../ops/agents';
import { AdminInputError, notFound } from '../ops/errors';
import { auditedByOrgKey, limitOrgApiAgentCreates, type OrgKeyPrincipal } from '../ops/org-keys';
import { agentForDisplay } from './agents';

/** `/org-api` 라우트 함수 한 번의 호출 — 인증된 키가 늘 있다(라우터가 보장). */
export interface OrgApiCall {
  readonly deps: AdminDependencies;
  readonly request: AdminRequest;
  readonly params: Readonly<Record<string, string>>;
  readonly principal: OrgKeyPrincipal;
}

/** 에이전트 id 모양 + 키 조직 소속. 다른 조직 = 없음(404 — 존재를 새지 않는다). */
async function requireAgentOfKey(call: OrgApiCall, raw: string | undefined): Promise<AgentId> {
  if (raw === undefined || !isAgentId(raw)) throw new AdminInputError('agent 는 에이전트 id(hex 32)다.', 'invalid_agent');
  if ((await agentOrganizationOf(call.deps.pool, raw)) !== call.principal.organizationId) throw notFound('에이전트가 없다.', 'agent_not_found');
  return raw;
}

/** `GET /org-api/v1/agents?limit&cursor&q` → `{items, nextCursor}` */
export async function handleOrgApiListAgents(call: OrgApiCall): Promise<AdminResponse> {
  const page = resolveAgentPageQuery(call.request.query, true);
  if (page === null) throw new Error('resolveAgentPageQuery(always) 가 null 을 돌려주었다');
  const result = await listAgentsPageOp(call.deps.pool, call.principal.organizationId, page);
  return jsonResponse(200, { items: result.items.map(agentForDisplay), nextCursor: result.nextCursor });
}

/** `GET /org-api/v1/agents/{agentId}` → `AgentView` */
export async function handleOrgApiGetAgent(call: OrgApiCall): Promise<AdminResponse> {
  const agentId = await requireAgentOfKey(call, call.params['agentId']);
  const agent = await getAgentOp(call.deps.pool, agentId);
  if (agent === null) throw notFound('에이전트가 없다.', 'agent_not_found');
  return jsonResponse(200, agentForDisplay(agent));
}

const CREATE_KEYS: ReadonlySet<string> = new Set(['name', 'localPart', 'domain', 'primary']);

/**
 * `POST /org-api/v1/agents {name, localPart, domain?, primary?}` → 201 `{agent, token}` — **토큰은 이 응답 한 번뿐**. 감사 `agent.create`(행위자 = 조직 키).
 * `domain` 은 콘솔과 같다(고객 도메인 대표 — `customPrimaryDomainOf` · 키의 조직이 verified 로 가진 도메인만).
 */
export async function handleOrgApiCreateAgent(call: OrgApiCall): Promise<AdminResponse> {
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, CREATE_KEYS);
  const name = body['name'];
  const localPart = body['localPart'];
  if (typeof name !== 'string' || typeof localPart !== 'string') throw new AdminInputError('name 과 localPart 가 필요하다(문자열).', 'invalid_body');
  const customPrimaryDomain = customPrimaryDomainOf(body['domain'], body['primary']);
  const principal = call.principal;
  const custody = call.deps.custody();
  // 쓸 수 없는 주소 — 시도도 키 행위자 감사 행(`agent.create.taken`)으로 커밋한 뒤 예전과 같은 409 `conflict`(재발급 보안 리뷰 M2). 분당 생성 상한과
  // 조직의 하루 주소 탐침 상한 둘 다에 센다. 키 보관은 돌지 않았다.
  const result = await auditedByOrgKey<ProvisionOutcome>(
    call.deps.pool,
    principal,
    (outcome) => (outcome.kind === 'taken' ? AGENT_CREATE_TAKEN_ACTION : 'agent.create'),
    async (tx) => {
      // 쓰기 상한(ADR-0010 L5) — 조직 잠금 아래 지난 1분 키 행위자 생성 감사 행. 요청 상한(분당 120)과 별개.
      await limitOrgApiAgentCreates(tx, principal.organizationId);
      return provisionAgentOp(
        tx,
        {
          organizationId: principal.organizationId,
          name,
          localPart,
          seeds: [],
          budgetCents: DEFAULT_BUDGET_CENTS,
          createdBy: `admin:org_key:${principal.id}`,
          attachmentFollowsPlan: call.deps.features?.policyAttachmentFollowPlan === true,
          // 조직 키로 만든 에이전트는 허용 목록(빈 목록)으로 태어난다 — 키가 새면 바로 아무에게나 보내는 에이전트를 만들 수 없게(적대 검증 I08). 바꾸는 칸은 없다.
          outboundMode: 'allowlist_only',
          ...(customPrimaryDomain === undefined ? {} : { customPrimaryDomain }),
        },
        custody,
      );
    },
    (outcome) => (outcome.kind === 'taken' ? null : outcome.agent.id),
  );
  if (result.kind === 'taken') throw addressConflict();
  return jsonResponse(201, { agent: agentForDisplay(result.agent), token: result.token });
}
