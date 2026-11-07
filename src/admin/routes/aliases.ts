/**
 * src/admin/routes/aliases.ts — 콘솔 **별칭 주소** API(메일 기본기 2차 A6, ADR-0013 2차 절 · 연산은 `ops/addresses.ts`).
 *
 *   - `GET  /api/agents/{agentId}/aliases`                          → `{items, aliases}`             (member 이상 — 읽기)
 *   - `POST /api/agents/{agentId}/aliases {localPart}`              → 201 `{item}`                   (admin 이상)
 *   - `POST /api/agents/{agentId}/aliases/{addressId}/retire`       → 200 `{item, replayed}`         (admin 이상)
 *   - `POST /api/agents/{agentId}/primary {addressId}|{anchor:true}` → 200 `{primary, replayed}`      (admin 이상 — ADR-0014 2026-10 개정)
 *
 * **스위치 `ATMARK_ADDRESS_ALIASES_ENABLED` 가 꺼져 있거나 세션의 조직이 단계 공개 목록(`orgs:<uuid>,…`)에 없으면 추가만 404 `not_found`**
 * (AC-A6-6) — 새 별칭을 만들 수 있는지(다른 조직에 열려 있는지)를 드러내지 않는다. **목록·폐기는 닫혀도 된다**(보안 리뷰 L-4): 이미 만든 별칭은
 * 플래그와 무관하게 계속 받고 보내므로, 조직을 목록에서 빼거나 스위치를 끈 뒤에도 소유자가 그 별칭을 보고 끊을 수 있어야 한다(폐기는 안전 조치다).
 * 목록은 자기 조직 에이전트의 주소뿐이라 새는 것이 없다. 콘솔(주소 탭 `#/agents/{id}/addresses`)은 `GET /api/plan` 의 `features.addressAliases`
 * 로 `별칭 추가` 버튼을 가리고, 닫힌 조직에 별칭이 없으면(대표 주소뿐) 별칭 절(`#al-sec`)을 숨긴다. 콘솔의 `삭제` 는 이 폐기다(폐기한 별칭은 목록에 올리지 않는다).
 * 역할·CSRF·Origin 은 라우터 표가 막는다(세션 POST). 조직 범위: `requireAgentInOrganization`(다른 조직 에이전트 → 404).
 * 감사: 추가 `agent.alias.add` · 폐기 `agent.alias.retire`(대상 = 에이전트 id — 주소 원문은 감사 행에 없다, `owner_actions.target_id` 모양).
 * 재생(이미 폐기)은 감사하지 않는다. 별칭은 **비공개**다(D5) — 이 API 는 콘솔(소유자)만 보고, 공개 조회·여권은 대표 주소만 싣는다.
 */

import { rolloutAllows } from '../../runtime/feature-rollout';
import { audited, bodyField, objectBody, rejectUnknownKeys, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { addAliasOp, ALIAS_TAKEN_ACTION, aliasDomainOf, listAddressesOp, retireAliasOp, setAgentPrimaryOp, type AddAliasOutcome } from '../ops/addresses';
import { AdminInputError, notFound } from '../ops/errors';

const ALIAS_ADD_ACTION = 'agent.alias.add';
const ALIAS_RETIRE_ACTION = 'agent.alias.retire';
/** 대표 주소 선택(ADR-0014 2026-10 개정 · M3b) — 대상 = 에이전트 id(주소 원문은 감사 행에 없다). 재생은 감사하지 않는다. */
const PRIMARY_SET_ACTION = 'agent.primary.set';

const ADD_KEYS: ReadonlySet<string> = new Set(['localPart', 'domain']);
const PRIMARY_KEYS: ReadonlySet<string> = new Set(['addressId', 'anchor']);

/** 꺼짐 · 닫힌 조직 → 404(같은 모양) — 추가만(목록·폐기는 닫혀도 된다, L-4). 세션은 라우터가 이미 세웠다 — 조직은 세션에서만 온다(요청 값이 아니다). */
function requireEnabled(call: AdminCall): void {
  const rollout = call.deps.features?.addressAliases ?? false;
  if (!rolloutAllows(rollout, rollout === false ? null : sessionOf(call).organizationId)) throw notFound('없는 경로다.', 'not_found');
}

/** `GET /api/agents/{agentId}/aliases` — 스위치와 무관(L-4). */
export async function handleListAliases(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  return jsonResponse(200, await listAddressesOp(call.deps.pool, agentId, call.deps.now()));
}

/**
 * `POST /api/agents/{agentId}/aliases {localPart, domain?}` — `domain` 이 고객 도메인이면(ADR-0014 단계 4 M3b) 별칭 스위치 대신 **그 조직의 verified
 * 도메인**이 문이다(400 `domain_not_verified` — 기능 허용 목록 · 도메인 확인이 이미 조직별로 열고 닫는다). 요금제 별칭 한도 · 발급 상한은 같다.
 */
export async function handleAddAlias(call: AdminCall): Promise<AdminResponse> {
  // 문은 본문을 해석하기 **전에** 고른다 — 닫힌 조직의 atmark.ai 별칭 요청은 본문 모양과 무관하게 같은 404(AC-A6-6).
  const raw = call.request.body;
  const peek = bodyField(raw, 'domain');
  const customDomain = typeof peek === 'string' && peek.trim() !== '' && peek.trim().toLowerCase() !== 'atmark.ai';
  if (!customDomain) requireEnabled(call);
  const body = objectBody(raw);
  aliasDomainOf(body['domain']);
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  rejectUnknownKeys(body, ADD_KEYS);
  // 이미 쓰인 주소 — 시도도 감사 행(`agent.alias.taken`)으로 남기고(조직 하루 발급 수에 센다, 보안 리뷰 L4) 커밋한 뒤 409.
  const outcome = await audited<AddAliasOutcome>(
    call.deps.pool,
    session,
    (result) => (result.kind === 'taken' ? ALIAS_TAKEN_ACTION : ALIAS_ADD_ACTION),
    (tx) => addAliasOp(tx, session.organizationId, agentId, body['localPart'], call.deps.now(), body['domain']),
    () => agentId,
  );
  // 사용 중 · 다른 조직의 폐기 뒤 보류 중(ADR-0013 2026-09-29 개정)을 가르지 않는다 — 남의 조직이 막 지운 주소인지 드러내지 않는다.
  if (outcome.kind === 'taken') throw new AdminInputError('이미 쓰이고 있거나 지금은 발급할 수 없는 주소다.', 'address_taken', 409);
  return jsonResponse(201, { item: outcome.item });
}

/** `POST /api/agents/{agentId}/aliases/{addressId}/retire` — 스위치와 무관(L-4 — 닫힌 뒤에도 이미 만든 별칭을 끊는 안전 조치). */
export async function handleRetireAlias(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const outcome = await audited(
    call.deps.pool,
    session,
    ALIAS_RETIRE_ACTION,
    (tx) => retireAliasOp(tx, agentId, call.params['addressId']),
    (result) => (result.kind === 'retired' ? agentId : undefined),
  );
  return jsonResponse(200, { item: outcome.item, replayed: outcome.kind === 'replayed' });
}

/**
 * `POST /api/agents/{agentId}/primary {addressId} | {anchor: true}` → 200 `{primary: {addressId, address}, replayed}` — 대표 주소 고르기(ADR-0014
 * 2026-10 개정). 앵커("@atmark.ai 주소 켜기" — 잠든 앵커는 목록에 없으므로 `{anchor: true}`)는 언제나 · 같은 조직 verified 고객 도메인 별칭. 거부는 DB 가드 SQLSTATE 의 번역(P0A08 400 `primary_not_eligible` ·
 * P0A05 400 `domain_not_verified` · P0A09 429 `primary_change_rate_limited`). 재생(이미 그 주소)은 200 `replayed:true` · 감사 없음.
 */
export async function handleSetAgentPrimary(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, call.params['agentId']);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, PRIMARY_KEYS);
  const anchor = body['anchor'];
  if (anchor !== undefined && anchor !== true) throw new AdminInputError('anchor 는 true 만 받는다.', 'invalid_body');
  if (anchor === true && body['addressId'] !== undefined) throw new AdminInputError('addressId 와 anchor 중 하나만 쓴다.', 'invalid_body');
  const result = await audited(
    call.deps.pool,
    session,
    PRIMARY_SET_ACTION,
    (tx) => setAgentPrimaryOp(tx, session.organizationId, agentId, body['addressId'], anchor === true),
    (outcome) => (outcome.replayed ? undefined : agentId),
  );
  return jsonResponse(200, { primary: { addressId: result.addressId, address: result.address }, replayed: result.replayed });
}
