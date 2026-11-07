/**
 * src/identity/agent-token.ts — agent-scoped API 토큰 (`atk_agent_*`).
 *
 * 에이전트에게 SMTP 자격 증명은 없다(SES 자격은 dispatcher role 에만) — 에이전트가 가질 수 있는 것은 **관문을 지나는 HTTP 토큰 하나뿐**이고,
 * 발송 수단이 하나면 우회할 수단도 그 하나뿐이다(AC-1 · AC-8).
 *
 * **이 토큰으로 불가능해야 하는 것**(`FORBIDDEN_TO_AGENT_TOKENS`): 다른 에이전트 생성(예산·정책 단위의 무한 복제) · 과금/정책 변경(Stage 7 이
 * 자기에게 묻는 꼴) · 조직 API 키 열람(읽을 수 있으면 가질 수 있다) · **자기 예산 상향**(쓰기 권한이 있으면 한도가 기본값이 된다).
 *
 * **두 겹으로 막는다.** ① `AgentTokenCapability` 는 닫힌 유니온이고 위 행위의 이름이 없다 — 요구하는 코드가 컴파일되지 않는다.
 * ② `authorizeAgentToken` 은 대상 `agentId` 를 **필수 인자**로 받고, 자기 것이 아니면 거부한다.
 *
 * 행 접근은 주입받는 `AgentTokenStore` 로 밀어낸다 — 이 파일은 형식·해시·검증 규칙만 있다.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { AgentId } from '../db/schema';
import { log } from '../observability/logger';

// ---------------------------------------------------------------------------
// 형식
// ---------------------------------------------------------------------------

/** 토큰 접두사 — 비밀이 아니라 분류자다. 유출된 문자열을 사람과 스캐너가 보는 즉시 알아보고, 조직 키(`atk_org_`)와 구별한다. */
export const AGENT_TOKEN_PREFIX = 'atk_agent_';

/** 비밀부 256비트. 이 엔트로피가 "해시에 salt 를 쓰지 않는다"(`hashAgentToken`)의 전제다 — 줄이면 그 전제가 무너진다. */
export const AGENT_TOKEN_SECRET_BYTES = 32;

/** 전체 토큰 형식. base64url 은 `-`·`_` 를 쓰므로 URL·헤더에서 인코딩이 필요 없다. */
const AGENT_TOKEN_PATTERN = new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

// ---------------------------------------------------------------------------
// 권한
// ---------------------------------------------------------------------------

/** agent-scoped 토큰이 가질 수 있는 **전부**(닫힌 유니온). 전부 self-scope 다 — "다른 에이전트"를 표현할 이름이 없다. */
export type AgentTokenCapability =
  | 'messages:send'
  | 'messages:read'
  | 'audit:read'
  | 'agent:read_self'
  | 'webhooks:manage'
  /**
   * **자가 등록**(ADR-0016 2026-10-08). 같은 조직에 **안전 기본값 고정**의 형제 에이전트 하나를 만든다(`POST /v1/agents` · MCP `create_agent`).
   * `agents:create`(금지 목록 — 조직 키의 권한)보다 **좁다**: 모드·토큰 권한·도메인을 고를 수 없고, 조직 설정이 켜졌을 때만 · 하루 상한 안에서 ·
   * 만든 토큰은 이 권한을 갖지 않는다(연쇄 금지 — DB 트리거). 대상 검사는 그대로 자기 자신이다. 기본 권한에 없다(소유자가 토큰마다 준다).
   */
  | 'agents:enroll'
  /**
   * **정책 변경 요청**(ADR-0007 2026-10-13 — 진윤겸 결정). 자기 정책의 좁은 변경 하나(목록 항목 더하기 · 빼기 · 모드 바꾸기)를 이유와 함께 **요청**한다
   * (`POST /v1/agents/{id}/policy/requests` · MCP `request_policy_change`). 바꾸지 않는다 — 소유자가 콘솔에서 승인해야 소유자 행위로 바뀐다. 그래서
   * 금지 목록의 `policy:write` 와 겹치지 않는다. 신규 토큰 기본 권한에 있다(소유자가 빼고 발급할 수 있다). 자가 등록 토큰에는 없다.
   */
  | 'policy:request';

/**
 * 순서는 DB 열거형 `agent_token_capability` 와 같다(`test/integration/db/schema-shape.test.ts`). `webhooks:manage` 는 바깥으로 나가는 데이터 경로를
 * 새로 여는 쓰기라 읽기 토큰으로 할 수 없다(ADR-0013).
 */
export const AGENT_TOKEN_CAPABILITIES = [
  'messages:send',
  'messages:read',
  'audit:read',
  'agent:read_self',
  'webhooks:manage',
  'agents:enroll',
  'policy:request',
] as const satisfies readonly AgentTokenCapability[];

/** 자가 등록으로 만든 에이전트의 첫 토큰 권한 — 이것뿐이다(`agents:enroll` · `webhooks:manage` · `audit:read` 없음). */
export const ENROLLED_AGENT_TOKEN_CAPABILITIES = [
  'messages:send',
  'messages:read',
  'agent:read_self',
] as const satisfies readonly AgentTokenCapability[];

/**
 * 신규 토큰의 기본 권한. **`webhooks:manage` 는 기본에 없다** — 이벤트를 바깥 URL 로 내보내는 경로라 소유자가 골라서 준다. 기존 토큰의 전환
 * 경로는 `src/webhooks/management.ts`. `policy:request`(2026-10-13)는 기본에 **있다** — 바꾸는 권한이 아니라 소유자에게 묻는 권한이다(진윤겸 결정 A).
 * 이 기본값 이전에 발급한 토큰은 열에는 없지만 **인증 시점에 함의된다**(`impliedAgentTokenCapabilities` — 열은 불변이라 고치지 않는다).
 */
export const DEFAULT_AGENT_TOKEN_CAPABILITIES = [
  'messages:send',
  'messages:read',
  'audit:read',
  'agent:read_self',
  'policy:request',
] as const satisfies readonly AgentTokenCapability[];

// ---------------------------------------------------------------------------
// 함의 권한 — 기본값 이전 토큰의 `policy:request`
// ---------------------------------------------------------------------------

/**
 * `policy:request` 가 신규 토큰 기본값이 된 경계(운영 compute 배포 2026-10-13 03:08 UTC 무렵 완료 → 03:10 UTC 로 잡는다). 이보다 **앞서**
 * 발급한 토큰은 그 기본값을 받을 기회가 없었다 — 진윤겸 결정(2026-10-13 "기존 토큰에도 추가").
 *
 * `agent_api_keys.capabilities` 는 불변이다(트리거 `agent_api_keys_immutable_core` — "권한 변경은 폐기 + 재발급", 감사 무결성). 그래서 행을
 * 고치지 않고 **인증 시점에 함의한다**: 열은 발급 때 준 그대로 남고, principal 의 권한에만 더한다. DB 정의자
 * (`atmark_policy_request_create`)는 같은 규칙을 SQL 함수 `atmark_agent_token_policy_request_legacy`(202610131400)로 본다 — 두 경계 값은
 * 테스트가 같은지 본다.
 *
 * 경계 직후 2분(03:08~03:10)에 새 코드로 발급하며 `policy:request` 를 일부러 뺀 토큰이 있다면 함의된다 — 받아들인 오차(요청은 바꾸지 않는다).
 */
export const LEGACY_POLICY_REQUEST_CUTOFF = new Date('2026-10-13T03:10:00Z');

/** 함의 판단에 쓰는 사실 — 하나라도 모르면(`undefined`) 함의하지 않는다(fail-closed). */
export interface ImpliedCapabilityFacts {
  readonly capabilities: readonly AgentTokenCapability[];
  /** 토큰 발급 시각(`agent_api_keys.created_at`). */
  readonly issuedAt?: Date | undefined;
  /** 토큰의 에이전트가 자가 등록으로 태어났는가(`agent_enrollments.child_agent_id`). */
  readonly selfEnrolledAgent?: boolean | undefined;
  /**
   * 토큰의 에이전트가 운영자 예약 주소(support@ 등 — SQL `atmark_operator_assignable_addresses()`)를 활성으로 쥐었는가(보안 감사 M-1).
   * 참이면 `policy:request` 는 함의되지 않고 **열에 있어도 유효 권한에서 빠진다** — 지원 에이전트의 정책은 운영자가 런북으로만 바꾼다.
   * 모르면(`undefined`) 함의하지 않는다(fail-closed) · 열의 권한은 그대로(DB 정의자가 따로 거부한다).
   */
  readonly operatorReservedAgent?: boolean | undefined;
}

/**
 * 이 토큰에 **함의되는** 권한(열에는 없다). 지금은 `policy:request` 하나 — 조건이 모두 참일 때만:
 *   ① 발급 시각이 `LEGACY_POLICY_REQUEST_CUTOFF` 보다 앞선다(그 뒤 토큰은 소유자가 고른 그대로 — 뺐으면 없다).
 *   ② 에이전트가 자가 등록으로 태어나지 않았다(자가 등록 토큰은 `ENROLLED_AGENT_TOKEN_CAPABILITIES` 뿐 — 소유자가 그 에이전트에 나중에 발급한
 *      토큰도 같다: 자가 등록 에이전트의 권한은 소유자가 새로 고른다).
 *   ③ 토큰이 `agent:read_self` 와 메일 권한(`messages:send` 또는 `messages:read`) 하나 이상을 가진다 — 옛 기본값에서 좁히지 않은 "에이전트 토큰"이다.
 *      웹훅만 · 감사만으로 좁힌 토큰은 메일 정책을 다룰 일이 없고, 요청 결과 확인(`get_policy_request`)에 `agent:read_self` 가 든다.
 *   ④ 에이전트가 운영자 예약 주소를 쥐지 않았다(`operatorReservedAgent === false` — 보안 감사 M-1).
 * 폐기 · 만료 토큰은 인증에서 이미 거부되므로 여기까지 오지 않는다(DB 정의자는 따로 본다).
 */
export function impliedAgentTokenCapabilities(facts: ImpliedCapabilityFacts): readonly AgentTokenCapability[] {
  const caps = facts.capabilities;
  if (caps.includes('policy:request')) return [];
  if (facts.issuedAt === undefined || facts.selfEnrolledAgent !== false || facts.operatorReservedAgent !== false) return [];
  if (facts.issuedAt.getTime() >= LEGACY_POLICY_REQUEST_CUTOFF.getTime()) return [];
  if (!caps.includes('agent:read_self')) return [];
  if (!caps.includes('messages:send') && !caps.includes('messages:read')) return [];
  return ['policy:request'];
}

/** 열의 권한 + 함의 권한(순서는 `AGENT_TOKEN_CAPABILITIES`). 인가 · 도구 목록 · 발견 · 교체가 모두 이 값을 본다. */
export function effectiveAgentTokenCapabilities(facts: ImpliedCapabilityFacts): readonly AgentTokenCapability[] {
  // 운영자 예약 주소 에이전트 — 열에 있어도 `policy:request` 를 빼고 본다(도구 목록 · 발견 · 교체가 같은 값을 본다, M-1).
  if (facts.operatorReservedAgent === true) return withoutOperatorReservedExclusions(facts.capabilities);
  const implied = impliedAgentTokenCapabilities(facts);
  if (implied.length === 0) return facts.capabilities;
  const all = new Set<AgentTokenCapability>([...facts.capabilities, ...implied]);
  return AGENT_TOKEN_CAPABILITIES.filter((capability) => all.has(capability));
}

/** 운영자 예약 주소 에이전트의 토큰에서 빠지는 권한(보안 감사 M-1) — 새 토큰 발급(관리 연산 · 예약 주소 프로비저닝)도 이 목록을 뺀다. */
export const OPERATOR_RESERVED_EXCLUDED_CAPABILITIES = ['policy:request'] as const satisfies readonly AgentTokenCapability[];

export function withoutOperatorReservedExclusions(capabilities: readonly AgentTokenCapability[]): readonly AgentTokenCapability[] {
  return capabilities.filter((capability) => !(OPERATOR_RESERVED_EXCLUDED_CAPABILITIES as readonly AgentTokenCapability[]).includes(capability));
}

/** agent-scoped 토큰이 **결코** 가질 수 없는 행위(§47). "없음"은 코드에서 보이지 않으므로 이름으로 적어 두고, 교집합이 비었음을 단언한다. */
export type ForbiddenToAgentTokens =
  | 'agents:create'
  | 'billing:write'
  | 'policy:write'
  | 'org_api_keys:read'
  | 'budget:write';

export const FORBIDDEN_TO_AGENT_TOKENS = [
  'agents:create',
  'billing:write',
  'policy:write',
  'org_api_keys:read',
  'budget:write', // 자기 예산이라도 — 통제 대상이 한도를 쓸 수 있으면 한도가 기본값이 된다.
] as const satisfies readonly ForbiddenToAgentTokens[];

/** 두 유니온이 겹치지 않는다는 **컴파일 시점** 단언 — 겹치면 `never` 가 되어 아래 대입이 컴파일되지 않는다. */
type CapabilitiesAreNeverPrivileged =
  Extract<AgentTokenCapability, ForbiddenToAgentTokens> extends never ? true : never;

/** 위 타입을 실제로 소비한다 — 선언만 하면 타입이 평가되지 않은 채 남는다. */
export const CAPABILITY_PRIVILEGE_SEPARATION: CapabilitiesAreNeverPrivileged = true;

// ---------------------------------------------------------------------------
// 해시
// ---------------------------------------------------------------------------

/**
 * 평문 → `sha256` hex 64자. **DB 에 들어가는 것은 이 값뿐이다.**
 *
 * salt·KDF 를 쓰지 않는 이유: 256비트 무작위 값에는 늦출 사전이 없다. 대신 **해시 자체가 조회 키**라 비교가 아니라 인덱스 조회로 끝나고
 * 타이밍 공격 표면이 없다. salt 를 쓰면 행마다 훑어 비교해야 해 전수 스캔과 타이밍 비교가 함께 들어온다.
 */
export function hashAgentToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 발급
// ---------------------------------------------------------------------------

/** 발급 결과. `plaintext` 는 **이 객체에만 1회 존재한다** — 저장·로깅 금지(분실 시 재발급뿐). */
export interface IssuedAgentToken {
  readonly plaintext: string;
  readonly tokenHash: string;
  /** 평문의 끝 4자(`agentTokenHint`) — 목록에서 토큰을 가리는 표시값(202609250010). 비밀이 아니다. */
  readonly hint: string;
  readonly agentId: AgentId;
  readonly capabilities: readonly AgentTokenCapability[];
}

/** 끝 4자 표시값의 길이. 비밀부 43자(256비트) 중 24비트 — 남는 232비트는 그대로다(Stripe·GitHub 의 끝자리 표시와 같은 절충). */
export const AGENT_TOKEN_HINT_LENGTH = 4;

/** 평문 → 끝 4자(`hint`). 발급 순간에만 부를 수 있다(평문은 저장되지 않는다). 형식이 아닌 값은 거부한다. */
export function agentTokenHint(plaintext: string): string {
  if (!AGENT_TOKEN_PATTERN.test(plaintext)) throw new TypeError('agent token 형식이 아니다');
  return plaintext.slice(-AGENT_TOKEN_HINT_LENGTH);
}

/** 새 토큰 발급. 프로비저닝 트랜잭션 안에서 호출된다(`provisioning.ts`). */
export function issueAgentToken(
  agentId: AgentId,
  capabilities: readonly AgentTokenCapability[] = DEFAULT_AGENT_TOKEN_CAPABILITIES,
): IssuedAgentToken {
  const plaintext = `${AGENT_TOKEN_PREFIX}${randomBytes(AGENT_TOKEN_SECRET_BYTES).toString('base64url')}`;
  return {
    plaintext,
    tokenHash: hashAgentToken(plaintext),
    hint: agentTokenHint(plaintext),
    agentId,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// 저장소
// ---------------------------------------------------------------------------

/** 저장소 행. **평문 컬럼이 없다는 것이 이 타입의 요점이다.** */
export interface AgentTokenRecord {
  readonly tokenHash: string;
  readonly agentId: AgentId;
  readonly capabilities: readonly AgentTokenCapability[];
  /** 폐기 시각. 행을 **삭제하지 않는** 이유는 audit 가 "어느 토큰이 보냈는가"에 답해야 하기 때문. */
  readonly revokedAt: Date | null;
  /** 만료 시각. `null` 은 무기한 — P1b 의 데모 토큰이 그렇다. */
  readonly expiresAt: Date | null;
  /** 발급 시각(`agent_api_keys.created_at`). 선택 칸 — 얕은 fake 스토어는 모른다. */
  readonly issuedAt?: Date;
  /** `webhooks:manage` 이전에 발급된 토큰인가(DB 가 정했고 불변) — 웹훅 관리 전환 경로만 본다. **없으면 false**(fail-closed). */
  readonly webhooksLegacyEligible?: boolean;
  /** 토큰의 에이전트가 자가 등록으로 태어났는가 — 함의 권한(`impliedAgentTokenCapabilities`)만 본다. **없으면 함의 없음**(fail-closed). */
  readonly selfEnrolledAgent?: boolean;
  /** 에이전트가 운영자 예약 주소를 쥐었는가(`ImpliedCapabilityFacts.operatorReservedAgent`). **없으면 함의 없음**(fail-closed). */
  readonly operatorReservedAgent?: boolean;
}

/** 토큰 조회. **해시로만 조회한다** — 평문을 받는 메서드는 존재하지 않는다. */
export interface AgentTokenStore {
  findByHash(tokenHash: string): Promise<AgentTokenRecord | null>;
  /** 마지막 사용 시각 갱신(선택, US-007) — 인증 **성공**마다 부른다(REST·MCP 공통). 없으면 건너뛴다. */
  touch?(tokenHash: string, now: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------------

/** 토큰이 해석된 뒤 남는 것. **`agentId` 는 자기 자신 하나뿐이다.** */
export interface AgentPrincipal {
  readonly agentId: AgentId;
  /** **유효 권한** — 열의 권한 + 함의 권한(`effectiveAgentTokenCapabilities`). */
  readonly capabilities: readonly AgentTokenCapability[];
  /** 토큰 발급 시각(로그·판정용). 모르면 없음. */
  readonly issuedAt?: Date;
  /** 웹훅 관리 전환 경로 자격(`AgentTokenRecord.webhooksLegacyEligible`). 없으면 false. */
  readonly webhooksLegacyEligible?: boolean;
}

export type AgentTokenRejection =
  | 'malformed_token'
  | 'unknown_token'
  | 'token_revoked'
  | 'token_expired';

/** 인증 결과. `null` 이 아니라 판별 유니온 — "없음"과 "거부"의 구별이 곧 운영 질의다. */
export type AgentTokenAuthentication =
  | { readonly kind: 'authenticated'; readonly principal: AgentPrincipal }
  | { readonly kind: 'rejected'; readonly reason: AgentTokenRejection };

/** 제시된 평문 토큰 → principal. 형식 검사를 먼저 해 저장소를 임의 문자열로 때리지 않는다. */
export async function authenticateAgentToken(
  store: AgentTokenStore,
  presented: string,
  now: Date,
): Promise<AgentTokenAuthentication> {
  if (!AGENT_TOKEN_PATTERN.test(presented)) {
    return { kind: 'rejected', reason: 'malformed_token' };
  }

  const record = await store.findByHash(hashAgentToken(presented));
  if (record === null) return { kind: 'rejected', reason: 'unknown_token' };
  if (record.revokedAt !== null) return { kind: 'rejected', reason: 'token_revoked' };
  // 만료 시각에 도달하면 만료(`<=`).
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'rejected', reason: 'token_expired' };
  }

  // 성공이 확정된 뒤에만 — "마지막 사용"은 실제로 통과한 시각이다. touch 실패는 삼킨다(관측이 인증을 죽이지 않는다).
  await touchLastUsed(store, record, now);

  return {
    kind: 'authenticated',
    principal: {
      agentId: record.agentId,
      capabilities: effectiveAgentTokenCapabilities({
        capabilities: record.capabilities,
        issuedAt: record.issuedAt,
        selfEnrolledAgent: record.selfEnrolledAgent,
        operatorReservedAgent: record.operatorReservedAgent,
      }),
      ...(record.issuedAt === undefined ? {} : { issuedAt: record.issuedAt }),
      ...(record.webhooksLegacyEligible === undefined ? {} : { webhooksLegacyEligible: record.webhooksLegacyEligible }),
    },
  };
}

/** `store.touch` 가 있으면 부르고, 실패는 삼킨다(경고 로그 한 줄). 없으면 아무 일도 하지 않는다. */
async function touchLastUsed(store: AgentTokenStore, record: AgentTokenRecord, now: Date): Promise<void> {
  if (store.touch === undefined) return;
  try {
    await store.touch(record.tokenHash, now);
  } catch (error) {
    log('warn', 'agent_token.touch_failed', {
      agent_id: record.agentId,
      error_kind: error instanceof Error ? error.name : 'unknown',
    });
  }
}

// ---------------------------------------------------------------------------
// 인가
// ---------------------------------------------------------------------------

export type AgentTokenAuthorization =
  | { readonly kind: 'authorized' }
  | { readonly kind: 'denied'; readonly reason: 'capability_not_granted' | 'not_own_agent' };

/**
 * 이 principal 이 **이 대상 에이전트에 대해** 이 행위를 할 수 있는가. `targetAgentId` 가 필수인 것이 요점이다 — 선택이면 "생략 = 자기 자신"
 * 이라는 기본값을 믿은 호출부가 대상 검사 없이 남의 행을 만진다.
 */
export function authorizeAgentToken(
  principal: AgentPrincipal,
  capability: AgentTokenCapability,
  targetAgentId: AgentId,
): AgentTokenAuthorization {
  // 소유 검사가 먼저다 — "권한은 있는데 남의 것" 은 `not_own_agent` 여야 한다.
  if (principal.agentId !== targetAgentId) {
    return { kind: 'denied', reason: 'not_own_agent' };
  }
  if (!principal.capabilities.includes(capability)) {
    return { kind: 'denied', reason: 'capability_not_granted' };
  }
  return { kind: 'authorized' };
}
