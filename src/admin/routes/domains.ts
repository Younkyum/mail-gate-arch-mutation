/**
 * src/admin/routes/domains.ts — 고객 도메인 API(ADR-0014 단계 4 M3b · 연산은 `ops/domains.ts`). 콘솔(세션)과 조직 API(조직 키 `domains:manage`)의
 * 라우트 함수가 여기 함께 있다 — 같은 연산 · 같은 응답 모양, 감사 행위자만 다르다(세션 `audited` · 조직 키 `auditedByOrgKey`).
 *
 *   콘솔                                               조직 API(`/org-api/v1`)                   역할 · 권한
 *   - `GET    /api/domains`            → 목록           `GET    /domains`                          member · domains:manage
 *   - `POST   /api/domains {domain}`   → 201 한 개      `POST   /domains {domain}`                 admin  · domains:manage
 *     (+ `provision` — 커밋 뒤 즉시 실행 결과. 레코드 전부(DKIM 포함)가 대개 이 응답에 이미 있다 — 2026-10 one-shot)
 *   - `GET    /api/domains/{id}`       → 한 개(레코드)  `GET    /domains/{domainId}`               member · domains:manage
 *   - `POST   /api/domains/{id}/check` → 202            `POST   /domains/{domainId}/check`         admin  · domains:manage
 *   - `DELETE /api/domains/{id} {releaseAddresses?}` → 200  `DELETE /domains/{domainId}`          admin  · domains:manage
 *   - `GET    /api/domains/{id}/connect` → 200 Domain Connect 지원 여부(단추 표시만 · 콘솔만)                  admin
 *   - `POST   /api/domains/{id}/connect` → 200 서명 URL 발급(템플릿 하나 · 누를 때만 · 감사 `domain.connect_issued` · 조직 시간당 10 → 429)  admin
 *     (둘 다 409 `domain_connect_existing_mail` — 서브도메인에 다른 메일 서버)
 *
 * 거부: 기능 꺼짐 403 `feature_not_enabled`(추가 · 지금 확인) · 이름 400(판정 사유 코드) · 한도 409 · 지금 확인 429 `domain_check_rate_limited` ·
 * 다른 조직 · 없음 · 모양 아닌 id = 같은 404 `domain_not_found`. 감사 `domain.add` · `domain.check` · `domain.remove`(대상 = 도메인 id).
 * 메일을 보내지 않는다 — 관문 · 전송단 import 없음(Layer C `NON_SENDING_ENTRYPOINTS`). 확인 · 전이는 틱이 한다.
 */

import { audited, objectBody, rejectUnknownKeys, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import {
  addDomainOp,
  checkDomainOp,
  provisionAfterAdd,
  recordConnectIssued,
  DOMAIN_ADD_ACTION,
  DOMAIN_CHECK_ACTION,
  DOMAIN_REMOVE_ACTION,
  DOMAIN_CONNECT_ACTION,
  domainConnectInfoOp,
  domainConnectIssueOp,
  getDomainOp,
  listDomainsOp,
  releaseAddressesOf,
  removeDomainOp,
  type DomainRemovalView,
} from '../ops/domains';
import { auditedByOrgKey } from '../ops/org-keys';
import type { OrgApiCall } from './org-api';

const ADD_KEYS: ReadonlySet<string> = new Set(['domain']);
const REMOVE_KEYS: ReadonlySet<string> = new Set(['releaseAddresses']);

/** 제거 본문(선택) — `{releaseAddresses?: boolean}`. 본문이 없으면 주소를 남긴다. */
function removalBody(body: unknown): boolean {
  if (body === undefined) return false;
  const record = objectBody(body);
  rejectUnknownKeys(record, REMOVE_KEYS);
  return releaseAddressesOf(record['releaseAddresses']);
}

/** 제거 응답 — 대표로 쓰던 에이전트가 있으면 경고 칸(콘솔이 "N개 에이전트가 주소 없음이 됩니다" 를 보여 준다). */
function removalBodyOf(result: DomainRemovalView): Record<string, unknown> {
  return { item: result.item, replayed: result.replayed, primaryAgents: result.primaryAgents, releasedAddresses: result.releasedAddresses };
}

// ---------------------------------------------------------------------------
// 콘솔
// ---------------------------------------------------------------------------

/** `GET /api/domains` */
export async function handleListDomains(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, await listDomainsOp(call.deps.pool, sessionOf(call).organizationId));
}

/** `GET /api/domains/{domainId}` */
export async function handleGetDomain(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, { item: await getDomainOp(call.deps.pool, sessionOf(call).organizationId, call.params['domainId']) });
}

/**
 * `POST /api/domains {domain}` → 201 `{item, provision}`. 추가(감사와 한 트랜잭션)가 **커밋된 뒤** 즉시 실행(`provisionAfterAdd` — 틱 롤 풀 · 자체 예산 ·
 * 던지지 않는다)을 돌려 DKIM 토큰까지 담아 답한다. 즉시 실행이 없거나 늦으면 `item.recordsReady:false` — 콘솔이 잠깐 다시 읽는다.
 */
export async function handleAddDomain(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, ADD_KEYS);
  const item = await audited(
    call.deps.pool,
    session,
    DOMAIN_ADD_ACTION,
    (tx) => addDomainOp(tx, { organizationId: session.organizationId, rawDomain: body['domain'], createdByUserId: session.userId }),
    (result) => result.id,
  );
  return jsonResponse(201, await provisionAfterAdd(call.deps.pool, session.organizationId, item, call.deps.provisionDomainNow));
}

/** `POST /api/domains/{domainId}/check` → 202 `{id, nextCheckAt}` */
export async function handleCheckDomain(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const result = await audited(
    call.deps.pool,
    session,
    DOMAIN_CHECK_ACTION,
    (tx) => checkDomainOp(tx, session.organizationId, call.params['domainId'], call.deps.now()),
    (outcome) => outcome.id,
  );
  return jsonResponse(202, result);
}

/** `DELETE /api/domains/{domainId} {releaseAddresses?}` → 200 `{item, replayed, primaryAgents, releasedAddresses}` */
export async function handleRemoveDomain(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const release = removalBody(call.request.body);
  const result = await audited(
    call.deps.pool,
    session,
    DOMAIN_REMOVE_ACTION,
    (tx) => removeDomainOp(tx, session.organizationId, call.params['domainId'], release),
    (outcome) => (outcome.replayed ? undefined : outcome.item.id),
  );
  return jsonResponse(200, removalBodyOf(result));
}

/**
 * `GET /api/domains/{domainId}/connect` → 200 `{supported:false}` | `{supported:true, providerName}` — 단추를 보일지만(발견 결과 · 캐시). 서명 · 감사 없음.
 * 조직 API 에는 두지 않는다 — 적용은 사람이 DNS 업체 화면에서 로그인·동의하는 흐름이다(키로 부를 이유가 없다).
 */
export async function handleDomainConnect(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  return jsonResponse(200, await domainConnectInfoOp(call.deps.pool, session.organizationId, call.params['domainId'], call.deps.domainConnect));
}

/**
 * `POST /api/domains/{domainId}/connect` → 200 `{supported:true, providerName, applyUrl, records}` | `{supported:false}` — 단추를 누를 때만 발급.
 * URL 을 내주기 전에 감사 · 상한을 한 트랜잭션에서(조직 잠금 아래 다시 센다). 실패하면 URL 은 나가지 않는다. 감사 행에는 행위 · 대상(도메인 id) ·
 * 행위자(세션)만 — URL · 토큰 값은 없다. 409 `domain_connect_existing_mail` · 429 `domain_connect_rate_limited`(조직 시간당 10).
 */
export async function handleDomainConnectIssue(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const now = call.deps.now();
  const issued = await domainConnectIssueOp(call.deps.pool, session.organizationId, call.params['domainId'], call.deps.domainConnect, now);
  if (!issued.supported) return jsonResponse(200, issued);
  const domainId = String(call.params['domainId']);
  await audited(call.deps.pool, session, DOMAIN_CONNECT_ACTION, (tx) => recordConnectIssued(tx, session.organizationId, now), () => domainId);
  return jsonResponse(200, issued);
}

// ---------------------------------------------------------------------------
// 조직 API(`domains:manage`) — 같은 연산 · 키 행위자 감사
// ---------------------------------------------------------------------------

/** `GET /org-api/v1/domains` */
export async function handleOrgApiListDomains(call: OrgApiCall): Promise<AdminResponse> {
  return jsonResponse(200, await listDomainsOp(call.deps.pool, call.principal.organizationId));
}

/** `GET /org-api/v1/domains/{domainId}` */
export async function handleOrgApiGetDomain(call: OrgApiCall): Promise<AdminResponse> {
  return jsonResponse(200, { item: await getDomainOp(call.deps.pool, call.principal.organizationId, call.params['domainId']) });
}

/** `POST /org-api/v1/domains {domain}` → 201 `{item, provision}` — 만든 사람 칸은 비운다(사람이 아니라 키다 · 감사 행에 키가 남는다). 커밋 뒤 즉시 실행은 콘솔과 같다. */
export async function handleOrgApiAddDomain(call: OrgApiCall): Promise<AdminResponse> {
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, ADD_KEYS);
  const principal = call.principal;
  const item = await auditedByOrgKey(
    call.deps.pool,
    principal,
    DOMAIN_ADD_ACTION,
    (tx) => addDomainOp(tx, { organizationId: principal.organizationId, rawDomain: body['domain'], createdByUserId: null }),
    (result) => result.id,
  );
  return jsonResponse(201, await provisionAfterAdd(call.deps.pool, principal.organizationId, item, call.deps.provisionDomainNow));
}

/** `POST /org-api/v1/domains/{domainId}/check` → 202 */
export async function handleOrgApiCheckDomain(call: OrgApiCall): Promise<AdminResponse> {
  const principal = call.principal;
  const result = await auditedByOrgKey(
    call.deps.pool,
    principal,
    DOMAIN_CHECK_ACTION,
    (tx) => checkDomainOp(tx, principal.organizationId, call.params['domainId'], call.deps.now()),
    (outcome) => outcome.id,
  );
  return jsonResponse(202, result);
}

/** `DELETE /org-api/v1/domains/{domainId} {releaseAddresses?}` → 200 */
export async function handleOrgApiRemoveDomain(call: OrgApiCall): Promise<AdminResponse> {
  const principal = call.principal;
  const release = removalBody(call.request.body);
  const result = await auditedByOrgKey(
    call.deps.pool,
    principal,
    DOMAIN_REMOVE_ACTION,
    (tx) => removeDomainOp(tx, principal.organizationId, call.params['domainId'], release),
    (outcome) => (outcome.replayed ? undefined : outcome.item.id),
  );
  return jsonResponse(200, removalBodyOf(result));
}
