/**
 * src/admin/context.ts — 관리 라우트의 의존성·세션·감사. 조립은 `src/runtime/admin-composition.ts`.
 *
 * **풀은 admin DB 롤 `atmark_admin` 이다**(`atmark/db/admin` — 소유자 롤 아님, ADR-0006). 아무것도 소유하지 않고
 * 202609230720 의 GRANT(컬럼 단위까지)만 가진다 — `sender_marks` 쓰기처럼 앱 롤에 없는 권한이 필요하고, 관리 표면은 앱 롤
 * 경계(에이전트 토큰이 닿는 곳)와 **다른 경계**여야 하기 때문이다. 새 SQL 이 권한 밖이면 `permission denied` 다(허용 목록은
 * `src/runtime/role-bootstrap.ts` `RESTRICTED_ROLE_GRANTS` — 마이그레이션과 같은 변경에서 늘린다). 그래서 이 표면의 인가는 전부 코드에 있다 —
 * 모든 대상(에이전트·게이트·조직)은 세션의 조직 안에 있는지 먼저 본다(`requireAgentInOrganization` 등). 다른 조직의 대상은
 * "없음"(404)과 구별하지 않는다.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { MessageContentReader } from '../api/content-store';
import type { AdminBillingDependencies } from '../billing/provider';
import { withTransaction, type Queryable } from '../db/client';
import { isAgentId, type AgentId } from '../db/schema';
import type { ProvisionDomainNow } from '../domains/contract';
import { log } from '../observability/logger';
import type { KeyCustody } from '../passport/custody';
import type { RealtimePusher } from '../realtime/push';
import type { FeatureRollout } from '../runtime/feature-rollout';
import type { HmacKeyring } from '../security/hmac-keyring';
import { errorResponse, type AdminRequest, type AdminResponse } from './http';
import { agentOrganizationOf } from './ops/agents';
import type { DomainConnectDependencies } from './ops/domains';
import { AdminInputError, notFound } from './ops/errors';
import { transactionPool } from './ops/transaction';

/** 조직 안의 역할(창업자 결정 F-1) — member(읽기 전용) < admin < owner. */
export type MemberRole = 'owner' | 'admin' | 'member';

const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value);
}

const ROLE_RANK: Readonly<Record<MemberRole, number>> = { member: 0, admin: 1, owner: 2 };

/** `role` 이 `required` 이상인가. */
export function roleAtLeast(role: MemberRole, required: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * 살아 있는 세션 — 세션 모듈(`session.ts`)이 만들고 되내보낸다. 감사·조직 범위 검사가 이것만 받는다.
 * `role` 은 **매 요청** `memberships` 에서 다시 읽은 값이다(세션에 캐시하지 않는다 — 강등·제거가 다음 요청부터 효력).
 */
export interface OwnerSession {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

/**
 * 핸들러 안의 역할 검사 — 본문에 따라 필요한 역할이 갈리는 라우트(조직 정지 **해제**는 owner)만 쓴다. 나머지는 라우트 표의
 * `role` 이 라우터에서 막는다. 403 `forbidden_role`.
 */
export function requireRole(session: OwnerSession, required: MemberRole): void {
  if (!roleAtLeast(session.role, required)) {
    throw new AdminInputError(`이 작업에는 ${required} 역할이 필요하다.`, 'forbidden_role', 403);
  }
}

export interface AdminDependencies {
  /** **admin 롤**(`atmark_admin`) 풀. 테스트는 소유자 롤 풀을 넣기도 한다 — 운영 권한 경계는 `admin-role-grants` 통합 테스트가 본다. */
  readonly pool: Pool;
  /** 로그인 링크 키링(`atmark/owner-login-keys`) — 검증과 요청자 키 HMAC. 승인 링크 키가 아니다. */
  readonly loginKeys: HmacKeyring;
  /** 프로비저닝의 키 보관소 — 운영은 AWS custody(KMS envelope → Secrets Manager). 부를 때 만든다. */
  readonly custody: () => KeyCustody;
  /**
   * 발신 본문 **읽기** (US-004 — 로그 상세). 운영은 S3 읽기 전용 리더(`outbound/content/` 접두사 하나 · IAM `s3:GetObject` 하나)
   * 위의 `createObjectContentReader`. 쓰기 면이 없다. 호출 전에 조직 범위는 SQL 이 이미 가른다(`routes/logs.ts`).
   */
  readonly outboundContent: MessageContentReader;
  /**
   * login-mailer 깨우기 — outbox(`owner_login_links`·`signup_links`·`org_invites`)에 행을 적을 수 있는 요청이 **커밋된 뒤** 부른다
   * (`kickLoginMailer` 아래). 운영은 `admin-composition.ts` 가 채운다(Lambda 비동기 호출 · 1초 상한 · 던지지 않는다). **없으면 부르지 않는다**
   * (로컬·테스트 — 1분 틱이 보낸다). 보내는 것은 login-mailer 다(ADR-0006) — 이 함수는 "지금 outbox 를 보라" 만 말한다.
   */
  readonly kickLoginMailer?: () => Promise<void>;
  readonly now: () => Date;
  /**
   * 결제(WP-2 — `routes/billing.ts`). **없으면 결제는 잠김**(`/api/billing` 은 `enabled:false` · 체크아웃·포털 409) — 조립이 결제 설정을 받지 못한
   * 배포·테스트에서 콘솔의 다른 표면은 그대로 돈다. 운영은 `admin-composition.ts` 가 채운다(admin 키 · 스위치 · 환경).
   */
  readonly billing?: AdminBillingDependencies;
  /**
   * 콘솔 웹훅의 **시크릿 받기**(보안 M1 — `runtime/lambda-invoke.ts` `createWebhookSecretIssuer`). admin λ 는 웹훅 키링을 갖지 않는다 — 등록·회전을
   * 커밋한 뒤 api λ 에 내부 이벤트로 묻는다(활성 kid · 방금 콘솔이 만든 행의 시크릿). **없으면 등록·회전만 503** `webhooks_unavailable`(쓰기 전에
   * 멈춘다) — 목록·삭제·전달 목록·재전송은 필요 없다. 운영은 `admin-composition.ts` 가 `ATMARK_API_FUNCTION_ARN` 으로 채운다(없거나 틀리면 비워 둔다 —
   * 기동을 막지 않는다, 보안 L4).
   */
  readonly webhookSecrets?: {
    readonly activeKid: () => Promise<string>;
    readonly issue: (agentId: AgentId, endpointId: string) => Promise<string>;
    /**
     * 인증 헤더 값 봉인(202610141400) — api λ 가 대상(조직 · 에이전트 · 엔드포인트 · URL, 보안 리뷰 L3)을 다시 보고 `(agentId, endpointId, 정규화 URL)` 로
     * 봉인한다. 콘솔은 평문을 저장하지 않는다.
     */
    readonly sealAuthorization?: (
      target: {
        readonly agentId: AgentId;
        readonly organizationId: string;
        readonly endpointId: string;
        readonly url: string;
        readonly purpose: 'register' | 'replace';
      },
      authorization: string,
    ) => Promise<{ readonly url: string; readonly kid: string; readonly sealed: string; readonly hint: string; readonly generation: number }>;
  };
  /**
   * Domain Connect(고객 도메인 DNS 자동 입력 — `src/domains/dc-url.ts`). **없으면 꺼짐** — `GET /api/domains/{id}/connect` 가 `{supported:false}`.
   * 운영은 `admin-composition.ts` 가 `ATMARK_DOMAIN_CONNECT_ENABLED=true` 이고 서명 키 ARN 이 있을 때만 채운다.
   */
  readonly domainConnect?: DomainConnectDependencies;
  /**
   * 고객 도메인 **즉시 실행**(2026-10 one-shot — 계약 `ProvisionDomainNow`, 구현 `src/domains/lifecycle.ts`). 도메인 추가가 커밋된 뒤 그 행 하나에 대해
   * 틱 롤 풀로 SES identity 를 만들어 DKIM 토큰을 받는다(`routes/domains.ts`). **없으면** 추가 응답의 `provision` 이 `unavailable` 이고 예약 틱이 잇는다.
   */
  readonly provisionDomainNow?: ProvisionDomainNow;
  /**
   * 실시간 힌트(묶음 E — `realtime/push.ts`). 콘솔이 숨은 메일을 풀어 **커밋한 뒤** `message.received` 를 민다(던지지 않는다 · 1초 상한). **없으면 밀지
   * 않는다**(실시간이 꺼진 배포 · 테스트). 대상(보이는 메일 · 그 에이전트의 연결)은 DB 정의 함수가 정한다.
   */
  readonly realtime?: RealtimePusher;
  /**
   * 기능 플래그(메일 기본기 2차). **없으면 전부 꺼짐** — 별칭 API(`routes/aliases.ts`)는 404 다. 운영은 `admin-composition.ts` 가
   * `ATMARK_ADDRESS_ALIASES_ENABLED`(`readFeatureRollout`)로 채운다.
   */
  readonly features?: {
    /** 별칭 주소 단계 공개 — `false` · `true` · `{organizations}`(세션의 조직이 목록에 있을 때만 — 닫힌 조직은 꺼짐과 같은 404). */
    readonly addressAliases: FeatureRollout;
    /** 새 에이전트 정책의 첨부 총량 = "요금제를 따른다"(null) — `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN`(기본 끔 · 보안 리뷰 M3). */
    readonly policyAttachmentFollowPlan?: boolean;
  };
}

/**
 * 감사 1행 — 세션 · 행위 · 대상 id. 비밀·토큰 평문·주소는 **모양상** 들어갈 수 없다(DB CHECK). `id` 를 주면 그 id 로 적는다(부속 상세 행이
 * 이 감사 행을 가리킬 때 — `audited` 의 `detail`). RETURNING 을 쓰지 않는다(적는 롤마다 `owner_actions.id` SELECT 가 있지는 않다).
 */
export async function recordOwnerAction(db: Queryable, session: OwnerSession, action: string, targetId: string | null, id?: string): Promise<void> {
  if (id === undefined) {
    await db.query('INSERT INTO owner_actions (session_id, organization_id, action, target_id) VALUES ($1, $2, $3, $4)', [
      session.id,
      session.organizationId,
      action,
      targetId,
    ]);
    return;
  }
  await db.query('INSERT INTO owner_actions (id, session_id, organization_id, action, target_id) VALUES ($5::uuid, $1, $2, $3, $4)', [
    session.id,
    session.organizationId,
    action,
    targetId,
    id,
  ]);
}

/**
 * **관리 행위 + 감사 1행 = 한 트랜잭션**(검증 M1). 예전에는 행위가 커밋된 뒤 감사를 따로 적었다 — 감사 INSERT 가
 * 실패하면(또는 그 사이 Lambda 가 끊기면) 토큰 교체는 옛 토큰을 폐기하고 새 토큰을 **아무도 받지 못한 채** 남기고,
 * 감사는 0행이었다. 이제 감사가 실패하면 행위도 롤백된다(응답 500, 상태는 요청 전 그대로).
 *
 * `run` 은 이 트랜잭션에 묶인 `Pool` 을 받는다(`transactionPool`). 프로비저닝처럼 외부 부작용(KMS·Secrets Manager)이
 * 있는 연산도 여기서 돈다 — 감사 INSERT 는 프로비저닝 DB 트랜잭션의 **커밋 직전**에 들어간다(프로비저닝 트랜잭션은
 * 이 트랜잭션의 세이브포인트다). 감사가 실패하면 에이전트 행은 남지 않고, 이미 만든 보관소 비밀은 프로비저닝이
 * 다른 이유로 실패했을 때와 같은 고아가 된다(행 없이는 쓸 수 없다).
 *
 * `target` 은 결과에서 대상 id 를 꺼낸다(새 에이전트 id 처럼 행위가 끝나야 아는 값 · 대상이 없는 행위는 `null`).
 * `undefined` 를 돌려주면 감사하지 않는다 — 아무것도 바꾸지 않은 호출(예: 이미 그 상태)이다.
 *
 * `detail` 은 감사 행을 적은 **뒤** 같은 트랜잭션에서 그 감사 행 id 로 부속 상세를 적는다(토큰 한 개 폐기·이름 바꾸기 → `agent_api_key_events`).
 * 감사하지 않은 호출에는 부르지 않는다.
 */
export async function audited<T>(
  pool: Pool,
  session: OwnerSession,
  action: string | ((result: T) => string),
  run: (tx: Pool) => Promise<T>,
  target: (result: T) => string | null | undefined,
  detail?: (tx: Pool, ownerActionId: string, result: T) => Promise<void>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const tx = transactionPool(client);
    const result = await run(tx);
    const targetId = target(result);
    if (targetId !== undefined) {
      const id = detail === undefined ? undefined : randomUUID();
      await recordOwnerAction(client, session, typeof action === 'string' ? action : action(result), targetId, id);
      if (detail !== undefined && id !== undefined) await detail(tx, id, result);
    }
    return result;
  });
}

/**
 * 보안 사건 한 줄(L4) — **값 없이** 코드 · 라우트 · 세션 id 해시만. 교차 조직 탐침(`agent_not_found`·`gate_not_found`)·
 * CSRF 불일치·출처 불일치·로그인 링크 거부를 운영자가 셀 수 있게 한다. 이메일·토큰·id 원문은 싣지 않는다.
 */
export function logSecurityEvent(code: string, route: string, requestId: string, sessionId: string | null): void {
  log('warn', 'admin.security', {
    error_code: code,
    route_id: `admin:${route}`,
    trace_id: requestId,
    detail: sessionId === null ? 'session:none' : `session:${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16)}`,
  });
}

/**
 * 요청자 IP 가 없다(재확인 I-3) — 요청자 상한을 거는 세션 전 라우트(로그인·가입 요청/검증 · 초대 수락)는 **닫힌 채 실패한다**(503). IP 없이 돌면
 * 모든 요청자가 한 버킷을 나눠 한 사람이 모두를 막거나, 상한이 사실상 사라진다. API Gateway 는 언제나 `sourceIp` 를 주므로 이것은 통합 설정
 * 오류다 — 오류 로그 한 줄(값 없이)로 운영자가 알아차리게 한다.
 */
export function clientIpUnavailable(request: AdminRequest): AdminResponse {
  log('error', 'admin.client_ip_missing', { route_id: `admin:${request.path}`, trace_id: request.requestId, error_code: 'client_ip_unavailable' });
  return errorResponse(503, 'client_ip_unavailable', `요청을 처리하지 못했다 — 잠시 뒤 다시 시도하라. 요청 id: ${request.requestId}`);
}

/**
 * outbox 행을 적은(적었을 수 있는) 트랜잭션이 **커밋된 뒤** login-mailer 를 깨운다 — 메일이 1분 틱을 기다리지 않게.
 *
 * **열거 방지:** 로그인·가입·초대 claim 은 행을 실제로 적었는지와 **무관하게** 받아들인 요청(202)마다 부른다. 적었을 때만 부르면 깨우기
 * 호출 시간(수십 ms)이 응답 시간에 얹혀 "그 주소는 존재한다" 가 새어 나간다. 상한(429)·모양 오류(400)에는 부르지 않는다 — 둘 다 주소와 무관하다.
 * **요청을 실패시키지 않는다** — 운영 구현은 던지지 않지만, 주입된 것이 던져도 여기서 삼킨다.
 */
export async function kickLoginMailer(deps: AdminDependencies): Promise<void> {
  if (deps.kickLoginMailer === undefined) return;
  try {
    await deps.kickLoginMailer();
  } catch (error) {
    log('warn', 'runtime.login_mailer_kick', { route_id: 'admin', outcome: 'failed', error_kind: error instanceof Error ? error.name : typeof error });
  }
}

/** 에이전트 id 모양 + 세션 조직 소속. 아니면 404(다른 조직의 에이전트와 없는 에이전트를 구별하지 않는다). */
export async function requireAgentInOrganization(db: Queryable, session: OwnerSession, raw: unknown): Promise<AgentId> {
  if (typeof raw !== 'string' || !isAgentId(raw)) throw new AdminInputError('agent 는 에이전트 id(hex 32)다.', 'invalid_agent');
  const organizationId = await agentOrganizationOf(db, raw);
  if (organizationId !== session.organizationId) throw notFound('에이전트가 없다.', 'agent_not_found');
  return raw;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 요청 본문이 JSON 객체인가. */
export function objectBody(body: unknown): Record<string, unknown> {
  if (!isJsonObject(body)) throw new AdminInputError('본문은 JSON 객체여야 한다.', 'invalid_body');
  return body;
}

/** 본문이 없어도 되는 요청(폐기·교체) — 없으면 빈 객체. */
export function optionalBody(body: unknown): Record<string, unknown> {
  return body === undefined ? {} : objectBody(body);
}

/** 본문 칸 하나 — 본문이 객체가 아니면 `undefined`(400 을 내지 않는다 — 세션 전 경로의 같은 응답). */
export function bodyField(body: unknown, name: string): unknown {
  return isJsonObject(body) ? body[name] : undefined;
}

/** 모르는 키가 있으면 400 `invalid_body` — 옛 클라이언트의 칸이 조용히 무시되지 않게. */
export function rejectUnknownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const key = Object.keys(body).find((name) => !allowed.has(name));
  if (key !== undefined) throw new AdminInputError(`모르는 키: ${key} (${[...allowed].join(' · ')})`, 'invalid_body');
}

/** 감사·정책 버전의 행위자 이름 — 세션 id(사람 이름을 지어내지 않는다). */
export function actorOfSession(session: OwnerSession): string {
  return `admin:session:${session.id}`;
}

/** 라우트 함수 한 번의 호출 — 세션 라우트는 `session`·`sessionToken` 이 채워져 있다(라우터가 보장). */
export interface AdminCall {
  readonly deps: AdminDependencies;
  readonly request: AdminRequest;
  readonly params: Readonly<Record<string, string>>;
  readonly session: OwnerSession | null;
  readonly sessionToken: string | null;
}

/** 세션 라우트에서 세션을 꺼낸다. 라우터가 세션 없는 호출을 막으므로 여기서 없으면 표 결함이다. */
export function sessionOf(call: AdminCall): OwnerSession {
  if (call.session === null) throw new Error('라우터 표 결함: 세션 라우트에 세션이 없다');
  return call.session;
}
