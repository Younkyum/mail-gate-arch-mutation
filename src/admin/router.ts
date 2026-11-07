/**
 * src/admin/router.ts — admin Lambda 의 라우터. **별도 호스트 `https://console.atmark.ai`** 의 별도 HTTP API 가 모든 경로를
 * 이 Lambda 로 보낸다(`infra/cdk/stacks/compute-stack.ts` `ConsoleHttpApi`). `api.atmark.ai` 의 HTTP API 에는 관리 경로가
 * 하나도 없고(템플릿 테스트), api Lambda 의 라우터(`src/runtime/router.ts`)도 관리 경로를 모른다.
 *
 * 인증·인가가 **이 표에 박혀 있다**(라우트 함수가 잊을 수 없게):
 *   - `auth: 'session'` — 쿠키 `__Host-atmark_admin` 의 살아 있는 세션만. 없으면 401. **`Authorization` 헤더가 있으면 무조건 401** —
 *     에이전트 토큰(Bearer)은 이 표면에서 무효이고, 쿠키와 섞인 요청을 "어느 쪽이 이기나" 로 해석하지 않는다.
 *   - `csrf: true` — `X-Atmark-CSRF` 가 세션에 묶인 토큰과 같아야 한다(403). 모든 변경 요청(POST·PATCH)과 감사 행을 쓰는 GET
 *     하나(`/api/logs/bundle`)가 그렇다 —
 *     세션 전 경로(로그인·가입·초대 claim·대기자 명단)는 예외다(로그인·가입 CSRF 는 브라우저 결속 쿠키가 막는다: `admin/session.ts`).
 *   - 변경 요청에 `Origin` 이 있으면 관리 출처(`https://console.atmark.ai`)여야 한다(403). JSON 본문은 `application/json` 만(415).
 *     **예외**(US-003): `CROSS_SITE_AUTH_PATHS`(로그인·가입과 그 verify · 대기자 명단 — POST)는 홈 출처(`https://atmark.ai`)도 받는다 — 폼이 홈에
 *     있다. 그 출처의 요청에만 CORS 응답 헤더(정확히 `https://atmark.ai` · 자격 포함 · `Vary: Origin`)를 싣고, 그 경로들의
 *     `OPTIONS` 프리플라이트만 받는다(`preflight`). 다른 출처·다른 경로는 CORS 헤더 없이 지금처럼 거부한다.
 *     이 예외는 운영 스위치 `ATMARK_SITE_CORS='true'` 일 때만 선다(기본 끔 — 끄면 홈 출처도 다른 교차 출처와 같다, 검증 F2).
 *     읽기 하나(2026-09-30): `GET /api/session/hint` → `{signedIn}` 도 같은 스위치·같은 헤더로 홈 출처에 열린다(`SESSION_HINT_PATH`).
 *
 * 승인 **결정** 경로는 표에 없다 — 승인은 서명 링크(`https://api.atmark.ai/approve`) 한 경로뿐이다(계약).
 * 응답에 스택·내부 메시지를 싣지 않는다 — 예외는 로그로만, 응답은 `internal_error` + 요청 id.
 * 보안 거부(CSRF·출처 불일치·교차 조직 탐침으로 보이는 404)는 **값 없이** 한 줄씩 남긴다(`logSecurityEvent`).
 */

import { FAVICON_PATHS } from '../ui/favicon';
import { Ac0InputError } from '../gate/ac0-verdict';
import { log } from '../observability/logger';
import { logSecurityEvent, roleAtLeast, type AdminCall, type AdminDependencies, type MemberRole } from './context';
import {
  ADMIN_ORIGIN,
  assetResponse,
  clientIpOf,
  CROSS_SITE_AUTH_PATHS,
  CSRF_HEADER,
  errorResponse,
  faviconResponse,
  findRoute,
  jsonResponse,
  lowerHeaders,
  parseCookies,
  parseQuery,
  preflightResponse,
  readJsonBody,
  SESSION_COOKIE,
  SESSION_HINT_PATH,
  SITE_CORS_HEADERS,
  SITE_ORIGIN,
  siteCors,
  type AdminHttpEvent,
  type AdminHttpResult,
  type AdminRequest,
  type AdminResponse,
} from './http';
import { AdminInputError, domainSqlStateRejection, sqlStateOf } from './ops/errors';
import {
  channelAlias,
  handleAddRule,
  handleAgentToken,
  handleCreateAgent,
  handleDeleteAgent,
  handleGetAgent,
  handleGetPolicy,
  handleListAgents,
  handlePatchPolicy,
  handleRemoveRule,
} from './routes/agents';
import { isOrgApiPath, routeOrgApiRequest } from './org-api/router';
import {
  handleApprovePolicyRequest,
  handleListPolicyRequests,
  handleRejectPolicyRequest,
} from './routes/policy-requests';
import { handleAddAlias, handleListAliases, handleRetireAlias, handleSetAgentPrimary } from './routes/aliases';
import { handleAddDomain, handleCheckDomain, handleDomainConnect, handleDomainConnectIssue, handleGetDomain, handleListDomains, handleRemoveDomain } from './routes/domains';
import { handleIssueOrgKey, handleListOrgKeys, handleRenameOrgKey, handleRevokeOrgKey, handleRotateOrgKey } from './routes/org-keys';
import { handleBillingCheckout, handleBillingOverview, handleBillingPortal } from './routes/billing';
import { handlePlan } from './routes/plan';
import { handleListApprovals } from './routes/approvals';
import { handleGateForwarding, handleGateIntervention, handleGateReport, handleGateStart } from './routes/gate';
import { handleGetIdentity, handlePublishIdentity, handleSuspendIdentity } from './routes/identity';
import { handleConsistencyProof, handleIdentityBlocks, handleInclusionProof, handleIntegritySummary, handleVerificationBundle } from './routes/integrity';
import { handleKillSwitch } from './routes/kill-switch';
import { handleGetAiWatch, handleSetAiWatch } from './routes/ai-watch';
import {
  handleGetAgentWatch,
  handleGetWatchSettings,
  handleListHeld,
  handleListSignups,
  handleReleaseHeld,
  handleSetAgentWatch,
  handleSetWatchSettings,
} from './routes/watch';
import { handleListLogs, handleLogDetail } from './routes/logs';
import { handleCancelScheduled } from './routes/scheduled';
import { handleStats } from './routes/stats';
import { handleIssueToken, handleListTokens, handleRenameToken, handleRevokeToken, handleRotateToken } from './routes/tokens';
import {
  handleClearWebhookAuthorization,
  handleCreateWebhook,
  handleDeleteWebhook,
  handleListWebhookDeliveries,
  handleListWebhooks,
  handleRedeliverWebhook,
  handleRotateWebhook,
  handleSetWebhookAuthorization,
} from './routes/webhooks';
import { handleAppPage, handleInvitePage, handleLoginLandingPage, handleLoginPage, handleSignupLandingPage, handleSignupPage } from './routes/pages';
import { handleMarkSender, handleListSenders } from './routes/senders';
import { handleChangeMemberRole, handleClaimInvite, handleInviteMember, handleLeaveOrganization, handleListMembers, handleRemoveMember, handleRevokeInvite } from './routes/members';
import {
  handleCreateOrganization,
  handleLoginRequest,
  handleLoginVerify,
  handleLogout,
  handleLogoutAll,
  handleGetPreferences,
  handleMe,
  handlePatchPreferences,
  handleSessionHint,
  handleSwitchOrganization,
} from './routes/session';
import { handleSignupRequest, handleSignupVerify } from './routes/signup';
import { handleWaitlistRequest } from './routes/waitlist';
import { csrfMatches, resolveSession } from './session';
import { adminUiAsset, ASSET_PREFIX } from './ui/index';

export type AdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface AdminRoute {
  readonly method: AdminMethod;
  /** 경로 템플릿. 파라미터는 `{name}`. */
  readonly path: string;
  /** `none` = 세션 없이(로그인·페이지), `session` = 살아 있는 세션 필수. `optional` = 있으면 읽는다(페이지 리다이렉트용). */
  readonly auth: 'none' | 'optional' | 'session';
  readonly csrf: boolean;
  /**
   * 세션 라우트의 **최소 역할**(창업자 결정 F-1 — 계획 §3.1 표). 세션 라우트는 반드시 있다(`route` 의 겹쳐 쓰기가 타입으로 강제 —
   * 기본값이 없다), 세션 없는 라우트는 `null`. 라우터가 세션 해석·CSRF 뒤에 본다 → 403 `forbidden_role {required}`.
   * 역할은 매 요청 멤버십에서 읽은 값이다(`resolveSession`).
   */
  readonly role: MemberRole | null;
  readonly handler: (call: AdminCall) => Promise<AdminResponse>;
}

interface RouteOptions {
  readonly csrf?: true;
}

function route(method: AdminMethod, path: string, auth: 'none' | 'optional', handler: AdminRoute['handler'], options?: RouteOptions): AdminRoute;
function route(method: AdminMethod, path: string, auth: 'session', handler: AdminRoute['handler'], options: RouteOptions & { readonly role: MemberRole }): AdminRoute;
function route(
  method: AdminMethod,
  path: string,
  auth: AdminRoute['auth'],
  handler: AdminRoute['handler'],
  options: RouteOptions & { readonly role?: MemberRole } = {},
): AdminRoute {
  // 변경 요청 + 세션 = CSRF 필수. 표에서 따로 끌 자리를 두지 않는다 — **켜는** 자리만 있다(쓰기를 하는 GET: 감사 행을 남기는 번들 내려받기).
  return {
    method,
    path,
    auth,
    csrf: auth === 'session' && (method !== 'GET' || options.csrf === true),
    role: auth === 'session' ? (options.role ?? 'owner') : null,
    handler,
  };
}

const MEMBER = { role: 'member' } as const;
const ADMIN = { role: 'admin' } as const;
const OWNER = { role: 'owner' } as const;

/**
 * **관리 라우트 표** — 계약의 경로 전부. 여기 없는 경로는 404.
 * 역할(F-1): member = 모든 읽기 + 자기 세션(로그아웃·조직 전환·새 조직·나가기) · admin = 에이전트·토큰·정책·게이트·정지 켜기·신원 ·
 * owner = 조직 정지 **해제**(핸들러 안 `requireRole`) · 멤버·초대 · 조직 API 키.
 */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  route('GET', '/', 'optional', handleLoginPage),
  route('GET', '/login', 'none', handleLoginLandingPage),
  // 파비콘(콘솔 v5) — 공개 정적 응답. 홈·문서와 같은 그림(`src/ui/favicon.ts` — 해시 경로 셋 + 옛 고정 경로 셋).
  ...FAVICON_PATHS.map((path) => route('GET', path, 'none', () => Promise.resolve(faviconResponse(path)))),
  route('GET', '/app', 'optional', handleAppPage),
  route('POST', '/api/login', 'none', handleLoginRequest),
  route('POST', '/api/login/verify', 'none', handleLoginVerify),
  // 셀프 가입(signup-contract.md §5) — 세션 전이라 로그인 둘과 같은 자리(CSRF 대신 브라우저 결속 쿠키 · Origin 검사).
  route('GET', '/signup', 'optional', handleSignupPage),
  route('GET', '/signup/verify', 'none', handleSignupLandingPage),
  route('POST', '/api/signup', 'none', handleSignupRequest),
  route('POST', '/api/signup/verify', 'none', handleSignupVerify),
  // 대기자 명단(202609301520) — 세션 전 · 홈 출처(CROSS_SITE_AUTH_PATHS). 가입 요청과 같은 원장·상한.
  route('POST', '/api/waitlist', 'none', handleWaitlistRequest),
  route('POST', '/api/logout', 'session', handleLogout, MEMBER),
  route('POST', '/api/logout-all', 'session', handleLogoutAll, MEMBER),
  route('GET', '/api/me', 'session', handleMe, MEMBER),
  // 개인 설정(202610101000) — 시스템 메일 언어. 본인 행만(세션의 사용자) · 역할 무관(owner · admin · member 가 각자).
  route('GET', '/api/me/preferences', 'session', handleGetPreferences, MEMBER),
  route('PATCH', '/api/me/preferences', 'session', handlePatchPreferences, MEMBER),
  // 세션 힌트(2026-09-30) — 홈이 부르는 읽기 전용 `{signedIn}`. 세션이 없어도 200 이라 `optional`(계약: `http.ts` `SESSION_HINT_PATH`).
  route('GET', SESSION_HINT_PATH, 'optional', handleSessionHint),
  // 조직 전환(= 새 세션 행 · 부모 폐기 · 만료 상속)과 기존 사용자의 새 조직(확장성 P0 R-1).
  route('POST', '/api/session/org', 'session', handleSwitchOrganization, MEMBER),
  route('POST', '/api/organizations', 'session', handleCreateOrganization, MEMBER),
  route('GET', '/api/agents', 'session', handleListAgents, MEMBER),
  route('POST', '/api/agents', 'session', handleCreateAgent, ADMIN),
  route('POST', '/api/agents/{agentId}/token', 'session', handleAgentToken, ADMIN),
  // 에이전트 삭제(2026-10-13 진윤겸 결정 — 별칭 폐기와 같은 소프트 삭제 · 되돌릴 수 없다). 콘솔 세션 전용(에이전트 토큰 · 조직 키 표면에 없다).
  route('POST', '/api/agents/{agentId}/delete', 'session', handleDeleteAgent, ADMIN),
  // 토큰 목록(콘솔 v4 D7) — 에이전트당 이름 있는 여러 토큰(활성 5) · 한 개 폐기(행은 남는다 — DELETE 가 아니라 POST) · 이름 바꾸기.
  route('GET', '/api/agents/{agentId}/tokens', 'session', handleListTokens, MEMBER),
  route('POST', '/api/agents/{agentId}/tokens', 'session', handleIssueToken, ADMIN),
  route('POST', '/api/agents/{agentId}/tokens/{tokenId}/revoke', 'session', handleRevokeToken, ADMIN),
  // 한 개 교체 — 그 토큰 폐기 + 같은 이름·권한의 새 토큰(한 트랜잭션, 평문 1회). 조직 키 교체와 같은 모델.
  route('POST', '/api/agents/{agentId}/tokens/{tokenId}/rotate', 'session', handleRotateToken, ADMIN),
  route('PATCH', '/api/agents/{agentId}/tokens/{tokenId}', 'session', handleRenameToken, ADMIN),
  // 웹훅 관리(2026-09-30 진윤겸 승인) — 에이전트 API 와 같은 연산(`webhooks/management.ts`). 보기 = member · 쓰기 = admin. 전달 경로가
  // `{webhookId}` 경로보다 앞이다(같은 길이의 GET 은 전달 목록 하나뿐 — 메서드로 갈린다).
  route('GET', '/api/agents/{agentId}/webhooks', 'session', handleListWebhooks, MEMBER),
  route('POST', '/api/agents/{agentId}/webhooks', 'session', handleCreateWebhook, ADMIN),
  route('GET', '/api/agents/{agentId}/webhooks/deliveries', 'session', handleListWebhookDeliveries, MEMBER),
  route('POST', '/api/agents/{agentId}/webhooks/deliveries/{deliveryId}/redeliver', 'session', handleRedeliverWebhook, ADMIN),
  route('DELETE', '/api/agents/{agentId}/webhooks/{webhookId}', 'session', handleDeleteWebhook, ADMIN),
  route('POST', '/api/agents/{agentId}/webhooks/{webhookId}/rotate', 'session', handleRotateWebhook, ADMIN),
  // 인증 헤더(선택, 202610141400) — 설정·교체·지우기는 콘솔만(에이전트 토큰은 등록 때만 줄 수 있다).
  route('POST', '/api/agents/{agentId}/webhooks/{webhookId}/authorization', 'session', handleSetWebhookAuthorization, ADMIN),
  route('DELETE', '/api/agents/{agentId}/webhooks/{webhookId}/authorization', 'session', handleClearWebhookAuthorization, ADMIN),
  // 메일 기본기 2차 A6 — 별칭 주소(스위치 `ATMARK_ADDRESS_ALIASES_ENABLED` 가 꺼지면 핸들러가 404).
  route('GET', '/api/agents/{agentId}/aliases', 'session', handleListAliases, MEMBER),
  route('POST', '/api/agents/{agentId}/aliases', 'session', handleAddAlias, ADMIN),
  route('POST', '/api/agents/{agentId}/aliases/{addressId}/retire', 'session', handleRetireAlias, ADMIN),
  route('GET', '/api/agents/{agentId}/policy', 'session', handleGetPolicy, MEMBER),
  route('PATCH', '/api/agents/{agentId}/policy', 'session', handlePatchPolicy, ADMIN),
  // 정책 v2 연락처 목록(계약 v2 §1 T1) — seeds 라우트를 대체한다.
  route('POST', '/api/agents/{agentId}/rules', 'session', handleAddRule, ADMIN),
  route('DELETE', '/api/agents/{agentId}/rules/{ruleId}', 'session', handleRemoveRule, ADMIN),
  // 에이전트의 정책 변경 요청(ADR-0007 2026-10-13) — 보기 = member · 승인 · 거절 = admin(정책을 직접 바꾸는 역할과 같다). 승인은 위 정책 · 목록 라우트와
  //   같은 관리 연산 · 같은 감사 결로 새 정책 버전을 쓴다. 에이전트 토큰은 이 표면에 닿지 않는다(`Authorization` → 401).
  route('GET', '/api/agents/{agentId}/change-requests', 'session', handleListPolicyRequests, MEMBER),
  route('POST', '/api/agents/{agentId}/change-requests/{requestId}/approve', 'session', handleApprovePolicyRequest, ADMIN),
  route('POST', '/api/agents/{agentId}/change-requests/{requestId}/reject', 'session', handleRejectPolicyRequest, ADMIN),
  route('GET', '/api/approvals', 'session', handleListApprovals, MEMBER),
  route('GET', '/api/senders', 'session', handleListSenders, MEMBER),
  route('POST', '/api/senders', 'session', handleMarkSender, ADMIN),
  route('GET', '/api/gate', 'session', handleGateReport, MEMBER),
  route('POST', '/api/gate/start', 'session', handleGateStart, ADMIN),
  route('POST', '/api/gate/forwarding', 'session', handleGateForwarding, ADMIN),
  route('POST', '/api/gate/intervention', 'session', handleGateIntervention, ADMIN),
  // 정지 켜기·에이전트 정지 해제 = admin. 조직 정지 **해제**는 owner — 본문에 따라 갈리므로 핸들러가 `requireRole` 로 한 번 더 본다.
  route('POST', '/api/kill-switch', 'session', handleKillSwitch, ADMIN),
  // 신원(PP-B/PP-C, 계약 §3 T4) — 요청을 outbox 에 넣을 뿐, 서명·게시는 서명 Lambda 가 한다.
  route('GET', '/api/agents/{agentId}/identity', 'session', handleGetIdentity, MEMBER),
  route('POST', '/api/agents/{agentId}/identity/publish', 'session', handlePublishIdentity, ADMIN),
  route('POST', '/api/agents/{agentId}/identity/suspend', 'session', handleSuspendIdentity, ADMIN),
  // 신원 변경 이력 블록(US-013) — 투명성 로그의 identity.* 잎을 해시로 잇는다. 읽기만(감사 행 없음) · 증명과 같은 조직당 슬롯.
  route('GET', '/api/agents/{agentId}/identity-blocks', 'session', handleIdentityBlocks, MEMBER),
  route('GET', '/api/logs', 'session', handleListLogs, MEMBER),
  // 개요 통계(콘솔 v4 E10) — 읽기만. 로그 API 와 같은 조직 범위 SQL 조각.
  route('GET', '/api/stats', 'session', handleStats, MEMBER),
  // 투명성 로그 무결성(US-010, ADR-0008) — 세 조각 경로(`/api/logs/{type}/{id}` 와 겹치지 않는다).
  route('GET', '/api/logs/integrity', 'session', handleIntegritySummary, MEMBER),
  route('GET', '/api/logs/inclusion-proof', 'session', handleInclusionProof, MEMBER),
  route('GET', '/api/logs/consistency-proof', 'session', handleConsistencyProof, MEMBER),
  // 번들 내려받기는 GET 이지만 **쓴다**(소유자 행위 감사 행 → 투명성 로그 잎). SameSite=Strict 쿠키는 같은 사이트(atmark.ai·id.atmark.ai)의
  // 요청에도 실리므로 CSRF 헤더를 요구한다(최종 적대적 검증 L4 — 콘솔 `api()` 는 파일 내려받기에 헤더를 싣는다).
  route('GET', '/api/logs/bundle', 'session', handleVerificationBundle, { csrf: true, role: 'member' }),
  route('GET', '/api/logs/{type}/{id}', 'session', handleLogDetail, MEMBER),
  // 예약 취소(메일 기본기 1차 Y2 — 진윤겸 결정 2026-09-26) — owner·admin. 보호 예약 포함 · 상한 없음 · 경로 `console` · 감사 1행.
  route('POST', '/api/scheduled/{scheduleId}/cancel', 'session', handleCancelScheduled, ADMIN),
  // --- 멤버·초대(확장성 P1 R-1, 창업자 결정 F-2) — 관리 = owner, 목록·나가기 = member.
  route('GET', '/api/members', 'session', handleListMembers, MEMBER),
  route('POST', '/api/members/invites', 'session', handleInviteMember, OWNER),
  route('POST', '/api/members/invites/{inviteId}/revoke', 'session', handleRevokeInvite, OWNER),
  route('POST', '/api/members/leave', 'session', handleLeaveOrganization, MEMBER),
  route('PATCH', '/api/members/{userId}', 'session', handleChangeMemberRole, OWNER),
  route('DELETE', '/api/members/{userId}', 'session', handleRemoveMember, OWNER),
  // 초대 링크 착지(페이지) — 토큰은 프래그먼트에만. 사람이 버튼을 눌러야 claim 한다.
  route('GET', '/invite', 'none', handleInvitePage),
  // 초대 수락 1단계 — 세션 전(토큰만). 초대받은 주소로 **이 브라우저에 결속된** 로그인 링크를 적는다(`admin/invites.ts`).
  route('POST', '/api/invites/claim', 'none', handleClaimInvite),
  // --- WP-B: channels · pagination · org-keys (확장성 P1 R-5·R-9·R-6 — 계약 .omc/handoffs/p0p1-api.md B2–B4) ---
  // 에이전트 한 개(딥링크 첫 칠). 목록 쪽 나누기는 위 `GET /api/agents` 가 쿼리로 가른다.
  route('GET', '/api/agents/{agentId}', 'session', handleGetAgent, MEMBER),
  // 채널 별칭 — 옛 `/policy`·`/rules` 와 같은 핸들러(같은 역할). 지금 채널은 email 하나(`admin/channels.ts`).
  route('GET', '/api/agents/{agentId}/channels/{channel}/policy', 'session', channelAlias(handleGetPolicy), MEMBER),
  route('PATCH', '/api/agents/{agentId}/channels/{channel}/policy', 'session', channelAlias(handlePatchPolicy), ADMIN),
  route('POST', '/api/agents/{agentId}/channels/{channel}/rules', 'session', channelAlias(handleAddRule), ADMIN),
  route('DELETE', '/api/agents/{agentId}/channels/{channel}/rules/{ruleId}', 'session', channelAlias(handleRemoveRule), ADMIN),
  // 조직 API 키 관리(F-4) — 전부 owner(목록 포함). 키를 **쓰는** 표면은 `/org-api/v1/*`(`admin/org-api/router.ts`).
  route('GET', '/api/org-keys', 'session', handleListOrgKeys, OWNER),
  route('POST', '/api/org-keys', 'session', handleIssueOrgKey, OWNER),
  route('POST', '/api/org-keys/{keyId}/revoke', 'session', handleRevokeOrgKey, OWNER),
  route('POST', '/api/org-keys/{keyId}/rotate', 'session', handleRotateOrgKey, OWNER),
  route('PATCH', '/api/org-keys/{keyId}', 'session', handleRenameOrgKey, OWNER),
  // 요금제·사용량(과금 P0, ADR-0011) — 읽기만. 요금제를 바꾸는 라우트는 없다(운영자 CLI · WP-2 결제 동기화만).
  route('GET', '/api/plan', 'session', handlePlan, MEMBER),
  // 결제(WP-2 · D-5) — 보기는 멤버 누구나, 체크아웃·결제 관리는 owner·admin. 요금제 쓰기는 여전히 없다(결제 → 웹훅 → sync 가 쓴다).
  route('GET', '/api/billing', 'session', handleBillingOverview, MEMBER),
  route('POST', '/api/billing/checkout', 'session', handleBillingCheckout, ADMIN),
  route('POST', '/api/billing/portal', 'session', handleBillingPortal, ADMIN),
  // 고객 도메인(ADR-0014 단계 4 M3b) — 보기 = member · 추가 · 지금 확인 · 제거 = admin. 추가 · 지금 확인은 기능 허용 목록(`org_features`)이 없으면 403.
  route('GET', '/api/domains', 'session', handleListDomains, MEMBER),
  route('POST', '/api/domains', 'session', handleAddDomain, ADMIN),
  route('GET', '/api/domains/{domainId}', 'session', handleGetDomain, MEMBER),
  route('POST', '/api/domains/{domainId}/check', 'session', handleCheckDomain, ADMIN),
  route('DELETE', '/api/domains/{domainId}', 'session', handleRemoveDomain, ADMIN),
  // Domain Connect(동기 · 서명) — 업체 적용 URL 을 만든다. 쓰기 없음 · 감사 없음(적용은 사람이 업체 화면에서). 기능 플래그가 꺼지면 `{supported:false}`.
  route('GET', '/api/domains/{domainId}/connect', 'session', handleDomainConnect, ADMIN),
  route('POST', '/api/domains/{domainId}/connect', 'session', handleDomainConnectIssue, ADMIN),
  // 대표 주소 선택(ADR-0014 2026-10 개정 · M3b) — 앵커 또는 같은 조직 verified 고객 도메인 별칭. 재생(이미 그 주소)은 200 replayed.
  route('POST', '/api/agents/{agentId}/primary', 'session', handleSetAgentPrimary, ADMIN),
  // AI 의심 메일 감시(ADR-0017) — 보기 = member · 끄기 = admin · 켜기 = owner(핸들러가 `requireRole`). 켜기는 기능 허용 목록이 없으면 403.
  route('GET', '/api/settings/ai-watch', 'session', handleGetAiWatch, MEMBER),
  route('PATCH', '/api/settings/ai-watch', 'session', handleSetAiWatch, ADMIN),
  // 감시 탭 — 받기 등급(ADR-0016 2026-10-08). 보기 = member · 위험 처리 · 알림 · 풀기 = admin · 신뢰 발신자(탐지 효과를 건너뛰는 유일한 설정) = owner.
  route('GET', '/api/watch/settings', 'session', handleGetWatchSettings, MEMBER),
  route('PATCH', '/api/watch/settings', 'session', handleSetWatchSettings, OWNER),
  route('GET', '/api/agents/{agentId}/watch', 'session', handleGetAgentWatch, MEMBER),
  route('PATCH', '/api/agents/{agentId}/watch', 'session', handleSetAgentWatch, ADMIN),
  route('GET', '/api/watch/held', 'session', handleListHeld, MEMBER),
  route('GET', '/api/watch/signups', 'session', handleListSignups, MEMBER),
  route('POST', '/api/watch/held/{messageId}/release', 'session', handleReleaseHeld, ADMIN),
];

function toResult(response: AdminResponse): AdminHttpResult {
  return {
    statusCode: response.status,
    headers: response.headers,
    body: response.body,
    ...(response.cookies === undefined ? {} : { cookies: response.cookies }),
    isBase64Encoded: response.isBase64Encoded === true,
  };
}

function stripStage(event: AdminHttpEvent): string {
  const stage = event.requestContext.stage;
  if (stage === undefined || stage === '$default') return event.rawPath;
  const prefix = `/${stage}`;
  return event.rawPath.startsWith(`${prefix}/`) ? event.rawPath.slice(prefix.length) : event.rawPath;
}

/** 다른 조직의 대상을 가리켰을 수 있는 404 — 교차 조직 탐침의 신호라 센다(없는 대상과 구별하지 않고 둘 다 센다). */
const PROBE_CODES: ReadonlySet<string> = new Set(['agent_not_found', 'gate_not_found', 'organization_not_found', 'token_not_found', 'member_not_found', 'invite_not_found', 'org_key_not_found', 'schedule_not_found', 'webhook_not_found', 'delivery_not_found', 'domain_not_found', 'address_not_found', 'message_not_found', 'policy_request_not_found']);

/** 403 `forbidden_role` — `{error, detail, required}`(화면이 필요한 역할을 보여 준다). */
function forbiddenRole(required: MemberRole): AdminResponse {
  return jsonResponse(403, { error: 'forbidden_role', detail: `이 작업에는 ${required} 역할이 필요하다.`, required });
}

/** 관리 예외 → 응답. 모르는 예외는 던진다(라우터가 500 으로). */
function rejection(error: unknown): AdminResponse | null {
  if (error instanceof AdminInputError) return errorResponse(error.status, error.code, error.message);
  // 고객 도메인 계약 SQLSTATE(P0A01~P0A10) — 연산이 번역하지 못한 것도 500 이 아니다(코드별 상수 몸통, ADR-0014 M3b).
  const domain = domainSqlStateRejection(error);
  if (domain !== null) return errorResponse(domain.status, domain.code, domain.message);
  if (error instanceof Ac0InputError) return errorResponse(400, 'invalid_request', error.message);
  // 유니크 위반(주소 중복 등) — 원문 메시지(제약 이름·값)를 싣지 않는다.
  if (sqlStateOf(error) === '23505') return errorResponse(409, 'conflict', '이미 있는 값이다(예: 주소가 이미 쓰이고 있다).');
  return null;
}

/** 홈 출처를 받는 요청인가 — `POST` + `CROSS_SITE_AUTH_PATHS` 의 경로. */
function crossSiteAuthRoute(method: string, path: string): boolean {
  return method === 'POST' && CROSS_SITE_AUTH_PATHS.has(path);
}

/**
 * 응답에 홈 CORS 헤더(홈 출처일 때) · `Vary: Origin` 을 붙이는 요청인가 — 위 넷(POST) + 세션 힌트(GET 하나, `SESSION_HINT_PATH`).
 * 힌트는 GET 이라 출처 검사(변경 요청만)를 받지 않는다 — 다른 출처의 GET 도 200 이지만 CORS 헤더가 없어 그 스크립트는 읽지 못하고,
 * 세션 쿠키는 SameSite=Strict 라 다른 사이트의 요청에는 애초에 실리지 않는다.
 */
function siteCorsRoute(method: string, path: string): boolean {
  return crossSiteAuthRoute(method, path) || (method === 'GET' && path === SESSION_HINT_PATH);
}

/** 홈 출처의 교차 출처 로그인·가입이 **지금** 열려 있는가 — 출처가 정확히 홈이고 스위치 `ATMARK_SITE_CORS` 가 켜졌을 때만. */
function siteOriginAllowed(origin: string | undefined): boolean {
  return origin === SITE_ORIGIN && siteCors();
}

/**
 * `OPTIONS` 프리플라이트 — `CROSS_SITE_AUTH_PATHS` 만. 출처가 정확히 홈이고, 요청 메서드가 POST 이고, 요청 헤더가
 * `content-type` 뿐일 때만 204 + CORS 헤더. 그 밖은 403(CORS 헤더 없음 — 브라우저가 본 요청을 보내지 않는다).
 * 다른 경로의 `OPTIONS` 는 `null`(라우트 표로 — 지금처럼 404·405).
 */
function preflight(path: string, headers: Readonly<Record<string, string>>, requestId: string): AdminResponse | null {
  if (!CROSS_SITE_AUTH_PATHS.has(path)) return null;
  const requested = (headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (
    !siteOriginAllowed(headers['origin']) ||
    (headers['access-control-request-method'] ?? '') !== 'POST' ||
    requested.some((name) => name !== 'content-type')
  ) {
    logSecurityEvent('cors_preflight_rejected', path, requestId, null);
    return errorResponse(403, 'cors_rejected', '이 출처·메서드·헤더의 교차 출처 요청은 받지 않는다.');
  }
  return preflightResponse();
}

/**
 * 콘솔 정적 자산(`/_assets/<해시>/<파일>`, `admin/ui/page.ts`) — **조립(DB·비밀) 전에** 핸들러가 먼저 부른다(`runtime/handlers/admin.ts`).
 * 세션·CSRF·쿠키·DB 를 보지 않는다. 자산 경로가 아니면 `null`(평소 라우팅). GET 만(HEAD 도 405 — 페이지와 같다).
 * 목록에 없는 자산 경로는 404 `route_not_found`(다른 없는 경로와 같은 모양 · `no-store` — 옛 해시가 캐시에 404 로 박히지 않게).
 */
export function routeAdminAssetEvent(event: AdminHttpEvent): AdminHttpResult | null {
  let path: string;
  let method: string;
  try {
    path = stripStage(event);
    method = event.requestContext.http.method.toUpperCase();
  } catch {
    return null;
  }
  if (!path.startsWith(ASSET_PREFIX)) return null;
  if (method !== 'GET') {
    const response = errorResponse(405, 'method_not_allowed', '이 경로가 받는 메서드: GET');
    return toResult({ ...response, headers: { ...response.headers, allow: 'GET' } });
  }
  const asset = adminUiAsset(path);
  if (asset === undefined) return toResult(errorResponse(404, 'route_not_found', '이 경로는 없다.'));
  return toResult(assetResponse(asset.body, asset.contentType, lowerHeaders(event)['accept-encoding']));
}

/**
 * 이벤트 하나. **던지지 않는다.** 홈 출처의 교차 출처 경로(`siteCorsRoute`)면 응답(성공·오류·500 모두)에 CORS 헤더를 붙인다 —
 * 화면이 429·400 을 읽어야 한다. 출처 검사는 `routeRequest` 안에서 이미 끝났다(그 경로들 밖의 홈 출처 요청은 403 이고 헤더 없음).
 */
export async function routeAdminEvent(deps: AdminDependencies, event: AdminHttpEvent): Promise<AdminHttpResult> {
  const result = await routeRequest(deps, event);
  let method = '';
  let path = '';
  let origin: string | undefined;
  try {
    method = event.requestContext.http.method.toUpperCase();
    path = stripStage(event).replace(/\/+$/, '') || '/';
    origin = lowerHeaders(event)['origin'];
  } catch {
    return result;
  }
  if (!siteCorsRoute(method, path)) return result;
  const vary = result.headers['vary'];
  return {
    ...result,
    headers: {
      ...result.headers,
      ...(siteOriginAllowed(origin) ? SITE_CORS_HEADERS : {}),
      vary: vary === undefined ? 'Origin' : `${vary}, Origin`,
    },
  };
}

async function routeRequest(deps: AdminDependencies, event: AdminHttpEvent): Promise<AdminHttpResult> {
  const requestId = event.requestContext.requestId;
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = stripStage(event).replace(/\/+$/, '') || '/';
    // 정적 자산 — 운영에서는 핸들러가 조립 전에 이미 답했다. 라우터를 직접 부르는 쪽(테스트·통합)도 같은 응답을 받게 여기서도 본다.
    const asset = routeAdminAssetEvent(event);
    if (asset !== null) return asset;
    // --- WP-B: 조직 API 키 표면(`/org-api/*`)은 별도 표·Bearer 인증(쿠키·CSRF·세션 없음) — `admin/org-api/router.ts`.
    if (isOrgApiPath(path)) return toResult(await routeOrgApiRequest(deps, event, method, path));
    const headers = lowerHeaders(event);
    if (method === 'OPTIONS') {
      const answered = preflight(path, headers, requestId);
      if (answered !== null) return toResult(answered);
    }
    const found = findRoute(ADMIN_ROUTES, method, path);
    if (found.kind === 'rejected') return toResult(found.response);
    const { entry, params } = found;

    // 에이전트 토큰(Bearer)은 이 표면에서 무효다 — 쿠키가 있어도 섞인 요청은 받지 않는다.
    if (entry.path.startsWith('/api/') && headers['authorization'] !== undefined) {
      return toResult(errorResponse(401, 'unauthenticated', '관리 API 는 소유자 세션(쿠키)만 받는다 — 에이전트 토큰은 무효다.'));
    }

    const mutating = method !== 'GET';
    if (mutating) {
      const origin = headers['origin'];
      const siteAllowed = crossSiteAuthRoute(entry.method, entry.path) && siteOriginAllowed(origin);
      if (origin !== undefined && origin !== ADMIN_ORIGIN && !siteAllowed) {
        logSecurityEvent('origin_mismatch', entry.path, requestId, null);
        return toResult(errorResponse(403, 'origin_mismatch', '관리 출처가 아닌 요청이다.'));
      }
    }

    const body = readJsonBody(event, method, headers);
    if (!body.ok) return toResult(body.response);

    const cookies = parseCookies(event);
    const sessionToken = cookies[SESSION_COOKIE] ?? null;
    const session = entry.auth === 'none' ? null : await resolveSession(deps.pool, sessionToken ?? undefined);
    if (entry.auth === 'session' && session === null) return toResult(errorResponse(401, 'unauthenticated', '로그인이 필요하다.'));
    if (entry.csrf && (sessionToken === null || !csrfMatches(sessionToken, headers[CSRF_HEADER]))) {
      logSecurityEvent('csrf_mismatch', entry.path, requestId, session?.id ?? null);
      return toResult(errorResponse(403, 'csrf_mismatch', 'X-Atmark-CSRF 가 세션과 맞지 않는다.'));
    }
    // 역할 — 대상(에이전트·게이트)을 보기 **전에** 막는다. 모든 대상에 같은 403 이라 다른 조직의 존재가 새지 않는다.
    if (entry.role !== null && session !== null && !roleAtLeast(session.role, entry.role)) {
      logSecurityEvent('forbidden_role', entry.path, requestId, session.id);
      return toResult(forbiddenRole(entry.role));
    }

    const query = parseQuery(event.rawQueryString);
    if (!query.ok) return toResult(query.response);
    const request: AdminRequest = {
      method,
      path,
      headers,
      query: query.query,
      body: body.body,
      cookies,
      sourceIp: clientIpOf(event),
      requestId,
    };
    try {
      return toResult(await entry.handler({ deps, request, params, session, sessionToken: session === null ? null : sessionToken }));
    } catch (error) {
      const handled = rejection(error);
      if (handled !== null) {
        if (error instanceof AdminInputError && PROBE_CODES.has(error.code)) logSecurityEvent(error.code, entry.path, requestId, session?.id ?? null);
        return toResult(handled);
      }
      throw error;
    }
  } catch (error) {
    log('error', 'admin.unhandled', {
      route_id: 'admin',
      trace_id: requestId,
      error_kind: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? error.message : String(error),
    });
    return toResult(errorResponse(500, 'internal_error', `요청을 처리하지 못했다. 요청 id: ${requestId}`));
  }
}

/** 조립 실패(비밀·설정) — 원인은 로그로만. */
export function adminUnavailable(requestId: string): AdminHttpResult {
  return toResult(errorResponse(503, 'service_unavailable', `서비스를 시작하지 못했다. 요청 id: ${requestId}`));
}
