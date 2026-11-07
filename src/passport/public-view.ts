/**
 * src/passport/public-view.ts — ★ `GET /v1/identity/{address}` 의 **명시적 필드 allowlist 직렬화기** (계획 §4B.3 · §5.0b Layer P3).
 *
 * 이 엔드포인트는 무인증·CORS 전면 허용·CDN 캐시 가능이다 — **여기 넣은 것은 영구히 공개된 것으로 취급한다**(캐시 사본이 남는다).
 * 그래서 응답은 이 파일이 **필드 하나하나를 새로 만들어서만** 나간다. 도메인 객체(행·문서)를 펼치거나(`...row`) 통째로 JSON 화하는 길이
 * 없다 — 입력 타입(`PublicIdentitySource`)부터 공개 필드만 가진다. `test/arch/passport-public-surface.arch.test.ts` 가 라우트가 이 함수
 * 말고는 본문을 만들지 않음을, `test/integration/passport/public-view-leakage.test.ts` 가 비공개 필드의 sentinel 부재를 본다.
 *
 * **캐시 헤더(`Cache-Control: public`)가 붙어 있는 한 위 sentinel 스캔은 필수 게이트다** — 한 번 새면 CDN·브라우저 캐시에서 회수할 수 없다.
 *
 * 비공개(§4B.3 표 — 어떤 인증 수준에서도 넣지 않는다): 수치 전부(한도·예산·정확한 건수) · 관계 데이터(목록 내용·seed) · 메시지 일체 ·
 * 사람 신원(소유자 메일·이름) · 내부 식별자(organization_id·policy_version·config_json) · 운영 상태(승인 큐·감사) · 키 자료(key_ref) ·
 * 정밀 시각(정확한 created_at). 조직 이름 공개(opt-in, 기본 OFF)는 Phase 1 에 스위치가 없다 — 그래서 `owner` 필드 자체가 없다.
 */

import type { AgentStatus, OutboundMode } from '../db/schema';
import {
  ACCOUNT_AGE_BUCKETS,
  CONVERSATIONS_BUCKETS,
  type AccountAgeBucket,
  type Attestation,
  type ConversationsBucket,
} from './attestations';
import { publicJwkOf, publicKeyMultibaseOf, type Ed25519PublicJwk } from './document';

/**
 * 응답의 **키 경로 전부**(중첩 포함, 배열 원소는 `[]`). 응답의 키 집합은 이것의 부분집합이어야 한다 — 테스트가 깊이 대조한다.
 * 이 목록에 줄을 더하는 것은 "영구 공개" 결정이다. §4B.3 표를 먼저 고쳐라.
 */
export const PUBLIC_IDENTITY_FIELDS = [
  'address',
  'did',
  'agent',
  'agent.name',
  'agent.status',
  'passport',
  'passport.status',
  'passport.version',
  'passport.issued_at',
  'passport.valid_until',
  'passport.content_hash',
  'public_key',
  'public_key.jwk',
  'public_key.jwk.kty',
  'public_key.jwk.crv',
  'public_key.jwk.x',
  'public_key.multibase',
  'did_document_url',
  'passport_url',
  'passport_jws_url',
  'created_at',
  'capabilities',
  'capabilities.can_receive',
  'capabilities.can_send',
  'capabilities.requires_approval_for_first_contact',
  'policy_summary',
  'policy_summary.outbound_mode',
  'attestations',
  'attestations[].type',
  'attestations[].value',
  'attestations[].issuer',
  'attestations[].domain',
] as const;

/** 거칠게만(§4B.3) — 정지 **사유**는 없다. */
export type PublicAgentStatus = 'active' | 'suspended' | 'revoked';

/** 콘솔 이름(계약 §1 · T1 `CONSOLE_OUTBOUND_MODES`). 레거시 두 모드는 `legacy`. */
export type PublicOutboundMode = 'all' | 'allowlist' | 'blocklist' | 'none' | 'legacy';

/** 공개 뷰의 입력. **공개 필드의 재료만** 가진다 — 행 타입을 받지 않는다. */
export interface PublicIdentitySource {
  readonly address: string;
  readonly did: string;
  /** 서명 문서의 이름(검증 가능한 값과 같게). */
  readonly name: string;
  readonly agentStatus: AgentStatus;
  readonly passportStatus: 'published' | 'suspended' | 'revoked';
  readonly version: number;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly contentHash: string;
  readonly publicKey: string;
  /** 서명 문서의 `createdMonth`(YYYY-MM). */
  readonly createdMonth: string;
  /** 서명 문서의 attestation — 아래에서 **다시** 걸러 만든다(저장된 JSON 을 믿고 그대로 내보내지 않는다). */
  readonly attestations: readonly unknown[];
  /** 살아 있는 정책 모드(서명 문서에 없다 — 운영 상태). */
  readonly outboundMode: OutboundMode | string | null;
  readonly inboundMode: string | null;
  /**
   * 조직 층이 발송을 막고 있는가(Stage 0 과 같은 조건 — 검토 전·거절 · 결제 차단 · 동결 · 소유자 정지). **판정 결과만** 받는다 —
   * 어떤 차단인지(조직의 사실)는 공개하지 않는다.
   */
  readonly organizationSendingBlocked: boolean;
  /** 조직 층이 수신을 막고 있는가(검토 전·거절 — `org_not_active`). */
  readonly organizationReceivingBlocked: boolean;
  readonly didDocumentUrl: string;
  readonly passportUrl: string;
  readonly passportJwsUrl: string;
}

/** 타입 별칭인 이유: API 응답 본문 타입(`Readonly<Record<string, unknown>>`)에 대입되려면 암묵 인덱스 시그니처가 필요하다. */
export type PublicIdentityView = {
  readonly address: string;
  readonly did: string;
  readonly agent: { readonly name: string; readonly status: PublicAgentStatus };
  readonly passport: {
    readonly status: 'published' | 'suspended' | 'revoked';
    readonly version: number;
    readonly issued_at: string;
    readonly valid_until: string;
    readonly content_hash: string;
  };
  /** 폐기(revoked)면 `null` — 폐기된 키는 검증 수단이 아니다(did.json 에서도 내린다, `buildRevokedDidDocument`). */
  readonly public_key: { readonly jwk: Ed25519PublicJwk; readonly multibase: string } | null;
  readonly did_document_url: string;
  readonly passport_url: string;
  readonly passport_jws_url: string;
  readonly created_at: string;
  readonly capabilities: {
    readonly can_receive: boolean;
    readonly can_send: boolean;
    readonly requires_approval_for_first_contact: boolean;
  };
  readonly policy_summary: { readonly outbound_mode: PublicOutboundMode };
  readonly attestations: readonly Attestation[];
};

function publicAgentStatus(status: AgentStatus): PublicAgentStatus {
  if (status === 'active') return 'active';
  if (status === 'disabled') return 'revoked';
  return 'suspended';
}

export function publicOutboundMode(mode: string | null): PublicOutboundMode {
  switch (mode) {
    case 'unrestricted':
      return 'all';
    case 'allowlist_only':
      return 'allowlist';
    case 'blocklist_only':
      return 'blocklist';
    case 'approval_required':
    case 'reply_only':
      return 'legacy';
    default:
      // 정책 행이 없거나 모르는 값 — 가장 좁은 쪽(발송 불가)으로 말한다.
      return 'none';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** attestation 하나를 **알려진 모양으로만** 다시 만든다. 모르는 type·값은 버린다. */
function sanitizeAttestation(raw: unknown): Attestation | null {
  if (!isRecord(raw) || typeof raw['issuer'] !== 'string') return null;
  const issuer = raw['issuer'];
  const value = raw['value'];
  switch (raw['type']) {
    case 'domain_verified':
      // 공개 조회는 유효 대표 주소로만 찾히므로 `domain` 은 늘 문자열이다(주소 없는 여권은 공개 조회에 나오지 않는다) — null 이면 버린다.
      return typeof value === 'boolean' && typeof raw['domain'] === 'string'
        ? { type: 'domain_verified', value, domain: raw['domain'], issuer }
        : null;
    case 'no_policy_violations':
      return typeof value === 'boolean' ? { type: 'no_policy_violations', value, issuer } : null;
    case 'account_age_bucket':
      return typeof value === 'string' && (ACCOUNT_AGE_BUCKETS as readonly string[]).includes(value)
        ? { type: 'account_age_bucket', value: value as AccountAgeBucket, issuer }
        : null;
    case 'successful_conversations_bucket':
      return typeof value === 'string' && (CONVERSATIONS_BUCKETS as readonly string[]).includes(value)
        ? { type: 'successful_conversations_bucket', value: value as ConversationsBucket, issuer }
        : null;
    default:
      return null;
  }
}

/** ★ 공개 뷰. **필드를 하나씩 새로 만든다.** */
export function toPublicIdentityView(source: PublicIdentitySource): PublicIdentityView {
  const agentStatus = publicAgentStatus(source.agentStatus);
  const outbound = publicOutboundMode(source.outboundMode);
  const active = agentStatus === 'active' && source.passportStatus !== 'revoked';
  const revoked = source.passportStatus === 'revoked';
  return {
    address: source.address,
    did: source.did,
    agent: { name: source.name, status: agentStatus },
    passport: {
      status: source.passportStatus,
      version: source.version,
      issued_at: source.issuedAt.toISOString(),
      valid_until: source.validUntil.toISOString(),
      content_hash: source.contentHash,
    },
    // 폐기된 키를 공개 API 가 계속 "이 에이전트의 키" 로 내주면, 침해된 키로 만든 JWS 를 이 값으로 검증하는 길이 남는다.
    public_key: revoked ? null : { jwk: publicJwkOf(source.publicKey), multibase: publicKeyMultibaseOf(source.publicKey) },
    did_document_url: source.didDocumentUrl,
    passport_url: source.passportUrl,
    passport_jws_url: source.passportJwsUrl,
    created_at: /^\d{4}-\d{2}$/.test(source.createdMonth) ? source.createdMonth : '',
    capabilities: {
      // 조직 층 차단을 반영한다 — 에이전트·모드만 보면 검토 전·동결·소유자 정지·결제 차단 조직의 에이전트가
      //   "보낼 수 있다" 고 공표된다. 관문(Stage 0)이 실제로 막는 조건과 같은 것을 말한다.
      can_receive: active && !source.organizationReceivingBlocked && source.inboundMode !== 'disabled',
      can_send: active && !source.organizationSendingBlocked && outbound !== 'none',
      requires_approval_for_first_contact: source.outboundMode === 'approval_required',
    },
    policy_summary: { outbound_mode: outbound },
    attestations: source.attestations.map(sanitizeAttestation).filter((entry): entry is Attestation => entry !== null),
  };
}

/** 공개 뷰가 없을 때의 **유일한** 응답 본문 — 없는 주소·draft·형식 오류가 같은 바이트다(존재 누설 없음). */
export const PUBLIC_IDENTITY_NOT_FOUND = { error: 'not_found', detail: 'identity not found' } as const;
