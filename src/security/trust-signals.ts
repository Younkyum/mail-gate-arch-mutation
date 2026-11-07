/**
 * src/security/trust-signals.ts — Sender Trust 의 **입력**: 신호 유니온, 수집 포트, 수집기 (계획 §6 P4, §4B.4).
 *
 * **이 파일은 I/O 를 하지 않는다.** DB 에서 사실(`TrustFacts`)을 채우는 것은 포트 구현(`db/repositories/trust-facts-store.ts`)의
 * 몫이고, 여기는 그 사실을 신호 목록으로 바꾸는 순수 함수만 있다. 판정(`computeTrust`)은
 * `sender-trust.ts` 에 있다 — 수집과 판정을 나눈 이유는 §4B.4 가 말한 그대로다: 신호가 하나 늘 때
 * 판정의 분기가 폭발하지 않게, 판정은 "신호 목록의 축약" 하나로 둔다.
 *
 * ---------------------------------------------------------------------------
 * ## 포트가 사실을 넘치게 줘도 여기서 다시 거른다
 * ---------------------------------------------------------------------------
 *
 * `resolve.ts` 와 같은 규율이다. 포트가 에이전트 범위나 주소 매칭을 빠뜨려 다른 발신자의 관계 행을
 * 돌려주면, 그 행이 이 발신자의 신뢰로 둔갑한다. 그래서 수집기는 모든 행을 **발신자 주소·에이전트로
 * 한 번 더** 대조한다. 매칭 방향은 이 프로젝트의 규칙을 따른다:
 *
 *   - **올리는 신호(관계·수동 분류)는 좁게** — 소문자화만 한 전체 주소의 정확 일치. `+tag` 를 지우지
 *     않는다. `bob+x@corp.com` 이 `bob@corp.com` 의 관계를 빌리지 못한다 — 다른 메일 서버에서 `+` 는
 *     다른 사람일 수 있다. 관계 주소는 소문자 정확 형태로 저장된다(2026-09-23 — 그 전의 태그 절단형 옛 행은
 *     절단된 주소 하나만 덮는다). 태그 달린 발신자는 그 정확한 주소의 관계가 있을 때만 얻는다. 잃는 것은 승인 한 번이다(안전 방향).
 *   - **막는 신호(blocklist·억제)는 넓게** — `normalizeAddress`(정규화의 유일한 지점)로 태그를 잘라
 *     비교한다. 차단 목록(정책 v2 `agent_contact_rules` block — 발신·수신 두 방향 모두)의 매칭은 관문과 **같은 함수**
 *     (`policy/contact-rules.ts` — `example.com` 은 그 도메인만, `*.example.com` 은 하위 도메인)다.
 */

import type { InjectionRisk } from '../db/schema';
import { contactRuleMatches, domainOfAddress } from '../policy/contact-rules';
import { normalizeAddress } from '../policy/policy-loader';

// ---------------------------------------------------------------------------
// 신호
// ---------------------------------------------------------------------------

/**
 * 신뢰 신호. `computeTrust` 가 이 목록을 축약한다. 각 신호의 **효과**(올림·상한·차단·관측)는
 * `sender-trust.ts` 머리말의 표가 정한다 — 여기에는 모양만 있다.
 *
 * 계획 §4B.4 의 Phase 1 신호 이름(`spf_dkim_aligned`·`seed_contact`·`approved_relationship`·
 * `suppression_hit`)을 그대로 쓴다. `prior_thread` 는 `contact_history`(관측 전용)로 대체했다 —
 * 이유는 `sender-trust.ts` 의 "자동 승격을 하지 않는다" 절.
 */
export type TrustSignal =
  /** 이 메일의 `From` 도메인이 DMARC 정렬을 통과했다(SES receipt `dmarcVerdict.status === 'PASS'`). */
  | { readonly kind: 'spf_dkim_aligned' }
  /** 소유자가 프로비저닝 때 적은 seed 주소(`sender_relationships.trust_category='seed'`, 항상 주소 스코프). */
  | { readonly kind: 'seed_contact' }
  /**
   * 소유자가 승인해 생긴 standing approval(`trust_category='approved'`).
   * `thread` 스코프는 수집기가 **이 메일의 권한용 스레드**와 일치할 때만 만든다.
   * `domain` 스코프는 판정이 공유 메일 도메인을 거르도록 도메인을 싣는다.
   */
  | {
      readonly kind: 'approved_relationship';
      readonly scope: 'recipient' | 'thread' | 'domain';
      readonly domain: string | null;
      readonly approvalId: string;
    }
  /** 소유자의 **수동 분류** — `seen` 의 유일한 출처(자동 승격 없음). 주소 또는 도메인 단위. */
  | { readonly kind: 'owner_marked_seen'; readonly scope: 'address' | 'domain'; readonly domain: string | null }
  /** 정책 blocklist 적중. 일치한 항목(주소 또는 `@domain`)을 싣는다. */
  | { readonly kind: 'blocklisted'; readonly entry: string }
  /** 조직 억제 목록 적중(만료 안 된 행). */
  | { readonly kind: 'suppression_hit'; readonly source: SuppressionSource }
  /** 이 발신자의 **과거** 수신 메일 중 injection 판정이 `none` 이 아닌 것이 있다. 가장 나쁜 값. */
  | { readonly kind: 'injection_history'; readonly worst: Exclude<InjectionRisk, 'none'> }
  /**
   * 접촉 이력 — **관측 전용. 신뢰를 올리지 않는다.** 판정이 이 신호를 받고도 등급을 바꾸지 않는 것이
   * 곧 "메일 N통·N일로 `seen` 이 되지 않는다" 의 집행 지점이다.
   */
  | {
      readonly kind: 'contact_history';
      readonly inboundCount: number;
      readonly authenticatedInboundCount: number;
      readonly outboundSentCount: number;
      readonly firstInboundAt: Date | null;
      readonly firstOutboundAt: Date | null;
    }
  /**
   * **선언만 한다 (§4B.4).** Phase 1 에는 이것을 만드는 수집기가 없다 — `collectTrustSignals` 는
   * 이 종류를 절대 만들지 않고, `computeTrust` 는 이것을 받으면 **던진다.** 수집기가 없는데 이 신호가
   * 나타났다면 누군가 판정 의미를 정하지 않은 채 생산자를 붙인 것이다.
   */
  | { readonly kind: 'passport_verified'; readonly did: string };

export type TrustSignalKind = TrustSignal['kind'];

/** `suppression_entries.source` 와 같은 집합. */
export type SuppressionSource = 'bounce' | 'complaint' | 'manual' | 'ses_account_level';

// ---------------------------------------------------------------------------
// 수집 포트 — 구현은 `db/repositories/trust-facts-store.ts`
// ---------------------------------------------------------------------------

/** 판정 대상 메일 한 통의 맥락. 파서·스레드 해석기 출력에서 어댑터로 채운다. */
export interface InboundTrustContext {
  /** 봉투 기준 수신 에이전트. */
  readonly agentId: string;
  /** `From` 의 주소만. */
  readonly from: string;
  /** DMARC 정렬 통과 여부 — `resolve.ts` 의 `fromAuthenticated` 와 같은 값. */
  readonly fromAuthenticated: boolean;
  /** `resolveThread(...).authority` 가 `existing` 이면 그 `threadId`, 아니면 `null`. **표시용 스레드를 넣지 마라.** */
  readonly authorityThreadId: string | null;
  /** 억제 만료 판정 기준 시각(수신 시각). */
  readonly now: Date;
}

/** `sender_relationships` 한 행. 포트는 이 발신자의 주소·도메인에 걸릴 수 있는 행을 준다. */
export interface RelationshipFact {
  readonly agentId: string;
  readonly scope: 'recipient' | 'thread' | 'domain';
  readonly trustCategory: 'seed' | 'approved';
  readonly address: string | null;
  readonly domain: string | null;
  readonly threadId: string | null;
  readonly grantedViaApprovalId: string | null;
}

/** 소유자 수동 분류 한 행(`sender_marks` — `sender_relationships` 가 아니다). */
export interface OwnerClassificationFact {
  readonly agentId: string;
  readonly scope: 'address' | 'domain';
  readonly address: string | null;
  readonly domain: string | null;
  readonly category: 'seen';
}

export interface SuppressionFact {
  readonly address: string;
  readonly source: SuppressionSource;
  readonly expiresAt: Date | null;
}

/** 이 발신자에 대해 DB 가 아는 것 전부. 없는 값은 빈 배열·0·`null`. */
export interface TrustFacts {
  readonly relationships: readonly RelationshipFact[];
  readonly ownerClassifications: readonly OwnerClassificationFact[];
  /**
   * 이 에이전트의 차단 규칙 값 — 발신·수신 block 목록의 합(정책 v2). 소유자가 어느 방향으로든 "이 상대는 막는다" 고 적었으면
   * 수신 신뢰를 올릴 근거가 아니다. 주소 값은 판정형(`+tag` 절단), 도메인 값은 `example.com`·`*.example.com`.
   */
  readonly blocklist: readonly string[];
  readonly suppressions: readonly SuppressionFact[];
  /** 이 발신자의 과거 inbound 들의 `injection_risk`(이번 메일 제외). */
  readonly priorInjectionRisks: readonly InjectionRisk[];
  /** 수신 이력 — 이 발신자로부터 이 에이전트가 받은 메일(이번 메일 제외). */
  readonly inbound: { readonly count: number; readonly authenticatedCount: number; readonly firstAt: Date | null };
  /** 발신 이력 — 이 에이전트가 이 주소로 실제로 내보낸(`sent`) 메일. */
  readonly outbound: { readonly sentCount: number; readonly firstAt: Date | null };
}

export interface TrustFactsPort {
  /** `agentId` 범위에서 `sender` 에 관한 사실. `sender` 는 `InboundTrustContext.from` 원형이다. */
  loadTrustFacts(agentId: string, sender: string): Promise<TrustFacts>;
}

// ---------------------------------------------------------------------------
// 수집기 — Phase 1 의 수집기 집합은 이 함수 하나다
// ---------------------------------------------------------------------------

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+$/;

/** 올리는 신호용 — 소문자화만. 모양이 아니면 `null`. */
function exactAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  return ADDRESS.test(trimmed) ? trimmed : null;
}

/** 관문 Stage 3 과 같은 매칭(`contact-rules.ts`) — 첫 적중 항목, 없으면 `null`. */
function blocklistHit(normalized: string, blocklist: readonly string[]): string | null {
  return blocklist.find((entry) => contactRuleMatches(entry, normalized)) ?? null;
}

const RISK_ORDER: readonly Exclude<InjectionRisk, 'none'>[] = ['low', 'medium', 'high'];

/** 사실 → 신호. **`passport_verified` 를 만들지 않는다**(§4B.4, AC-f1). */
export function collectTrustSignals(message: InboundTrustContext, facts: TrustFacts): TrustSignal[] {
  const signals: TrustSignal[] = [];
  const sender = exactAddress(message.from);

  // 막는 신호는 인증과 무관하게 먼저 모은다 — 사칭된 From 이 차단 주소를 달고 와도 막는 쪽이 안전 방향이다.
  if (sender !== null) {
    const wide = normalizeAddress(sender);
    const hit = blocklistHit(wide, facts.blocklist);
    if (hit !== null) signals.push({ kind: 'blocklisted', entry: hit });

    for (const entry of facts.suppressions) {
      if (entry.address !== wide) continue;
      if (entry.expiresAt !== null && entry.expiresAt.getTime() <= message.now.getTime()) continue;
      signals.push({ kind: 'suppression_hit', source: entry.source });
    }
  }

  let worst: Exclude<InjectionRisk, 'none'> | null = null;
  for (const risk of facts.priorInjectionRisks) {
    if (risk === 'none') continue;
    if (worst === null || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst)) worst = risk;
  }
  if (worst !== null) signals.push({ kind: 'injection_history', worst });

  if (message.fromAuthenticated) signals.push({ kind: 'spf_dkim_aligned' });

  if (sender !== null) {
    const senderDomain = domainOfAddress(sender);
    for (const row of facts.relationships) {
      if (row.agentId !== message.agentId) continue;
      const signal = relationshipSignal(row, sender, senderDomain, message.authorityThreadId);
      if (signal !== null) signals.push(signal);
    }
    for (const row of facts.ownerClassifications) {
      if (row.agentId !== message.agentId || row.category !== 'seen') continue;
      if (row.scope === 'address' && row.address === sender) {
        signals.push({ kind: 'owner_marked_seen', scope: 'address', domain: null });
      } else if (row.scope === 'domain' && row.domain === senderDomain) {
        signals.push({ kind: 'owner_marked_seen', scope: 'domain', domain: senderDomain });
      }
    }
  }

  signals.push({
    kind: 'contact_history',
    inboundCount: facts.inbound.count,
    authenticatedInboundCount: facts.inbound.authenticatedCount,
    outboundSentCount: facts.outbound.sentCount,
    firstInboundAt: facts.inbound.firstAt,
    firstOutboundAt: facts.outbound.firstAt,
  });

  return signals;
}

function relationshipSignal(
  row: RelationshipFact,
  sender: string,
  senderDomain: string,
  authorityThreadId: string | null,
): TrustSignal | null {
  if (row.trustCategory === 'seed') {
    // DB CHECK 가 seed 를 주소 스코프로 묶는다. 다른 모양이 오면 신뢰를 주지 않는다.
    return row.scope === 'recipient' && row.address === sender ? { kind: 'seed_contact' } : null;
  }
  const approvalId = row.grantedViaApprovalId;
  if (approvalId === null) return null;
  switch (row.scope) {
    case 'recipient':
      return row.address === sender ? { kind: 'approved_relationship', scope: 'recipient', domain: null, approvalId } : null;
    case 'thread':
      return row.address === sender && authorityThreadId !== null && row.threadId === authorityThreadId
        ? { kind: 'approved_relationship', scope: 'thread', domain: null, approvalId }
        : null;
    case 'domain':
      // 올리는 신호는 좁게 — 도메인 정확 일치만. 하위 도메인은 다른 메일 서버일 수 있다.
      return row.domain === senderDomain
        ? { kind: 'approved_relationship', scope: 'domain', domain: senderDomain, approvalId }
        : null;
  }
}

/** 포트 + 수집기. 수신 소비자는 이것만 부른다. */
export async function loadTrustSignals(message: InboundTrustContext, port: TrustFactsPort): Promise<TrustSignal[]> {
  return collectTrustSignals(message, await port.loadTrustFacts(message.agentId, message.from));
}
