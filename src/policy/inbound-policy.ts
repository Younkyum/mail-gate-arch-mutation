/**
 * 수신 정책 판정(정책 v2 · ADR-0007). 순수 함수. 수신 소비자가 저장 직전에 부르고, 막히면 **격리**로 쓴다
 * (`policy_blocked` — 에이전트 API·MCP 에 안 보이고 반송하지 않는다, 진윤겸 결정 ③). 발신 관문과 나눈 이유: 질문이
 * "보낼 것인가" 가 아니라 "에이전트에게 보일 것인가" 다.
 *
 * | 모드 | 판정 |
 * |---|---|
 * | `all`            | 전부 보인다. |
 * | `allowlist_only` | 차단이 먼저(이긴다). 그다음 **인증된**(DMARC pass) 발신자가 allow 목록에 있어야 보인다. |
 * | `blocklist_only` | 차단 목록이면 격리 — 인증 여부와 무관(막는 쪽은 사칭돼도 안전하다). |
 * | `disabled`       | 전부 격리. |
 *
 * 인증 실패 메일의 `From` 을 allow 와 맞추면 아무나 허락된 상대를 사칭해 들어온다 — 그래서 allow 는 인증된 헤더 `From` 하나만(좁게).
 * 차단은 넓게: 봉투 발신자·SES 가 DMARC 로 본 `From` 도메인까지, 따옴표·끝 점을 풀어 본다(검증 L2).
 */

import type { InboundMode, InboundPolicyReason } from '../db/schema';
import { anyContactRuleMatches, anyDomainRuleCovers, canonicalMailboxForBlock, domainOfAddress } from './contact-rules';
import { comparableAddress, normalizeAddress, PolicyShapeError } from './policy-loader';
import type { SnapshotRule } from './policy-snapshot';

/** 판정에 필요한 정책 — 로더가 규칙 행에서 만든다. */
export interface InboundPolicy {
  readonly mode: InboundMode;
  /** allow 규칙 값 — 주소는 허용 비교형(`+tag` 보존), 도메인은 그대로. */
  readonly allow: readonly string[];
  /** block 규칙 값 — 주소는 판정형(`+tag` 절단), 도메인은 그대로. */
  readonly block: readonly string[];
  /** `policy_versions.version` — 로그의 "어느 정책으로 막혔나". */
  readonly version: number;
}

/** 수신 정책 소스 — 운영은 `db/repositories/inbound-policy-store.ts`. */
export interface InboundPolicyPort {
  loadInboundPolicy(agentId: string): Promise<InboundPolicy>;
}

/** 수신 한 통의 발신자. `address` 는 소비자가 소문자화한 `From` 주소. */
export interface InboundSender {
  readonly address: string;
  /** DMARC pass 만 `true`(`inbound/receipt.ts` `isFromAuthenticated`). */
  readonly authenticated: boolean;
  /** 봉투 발신자(`MAIL FROM`, 원문). **차단에만** 쓴다 — 헤더 `From` 만 보면 차단된 상대가 `From` 을 바꿔 들어온다(검증 L2). */
  readonly envelopeSender?: string | null;
  /** SES 가 DMARC 를 판정한 `From` 도메인들. **차단에만** — 우리 파서와 SES 의 해석이 다른 메일에서 비껴가지 못하게. */
  readonly authenticatedDomains?: readonly string[];
}

/** 차단 목록에 걸리는가 — 넓게. 헤더 `From`·봉투 발신자(풀고 `+tag` 절단)와 그 도메인·SES 가 본 도메인 중 하나라도 걸리면 차단. */
function senderBlocked(block: readonly string[], sender: InboundSender): boolean {
  if (block.length === 0) return false;
  const mailboxes = [sender.address, sender.envelopeSender ?? null]
    .filter((value): value is string => value !== null && value !== '')
    .flatMap((value) => {
      const canonical = canonicalMailboxForBlock(value);
      return canonical === '' ? [normalizeAddress(value)] : [normalizeAddress(value), normalizeAddress(canonical)];
    });
  if (mailboxes.some((mailbox) => anyContactRuleMatches(block, mailbox))) return true;
  const domains = [...mailboxes.map(domainOfAddress), ...(sender.authenticatedDomains ?? [])].filter((domain) => domain !== '');
  return domains.some((domain) => anyDomainRuleCovers(block, domain));
}

export type InboundPolicyVerdict =
  | { readonly kind: 'deliver' }
  | { readonly kind: 'quarantine'; readonly reason: InboundPolicyReason };

const DELIVER: InboundPolicyVerdict = { kind: 'deliver' };

function quarantine(reason: InboundPolicyReason): InboundPolicyVerdict {
  return { kind: 'quarantine', reason };
}

/** 스냅샷 모드 + 수신 규칙 → 판정용 정책. 다른 방향의 행이면 던진다(발신 allow 가 수신 allow 로 새지 않게). */
export function resolveInboundPolicy(mode: InboundMode, rules: readonly SnapshotRule[], version: number): InboundPolicy {
  const allow: string[] = [];
  const block: string[] = [];
  for (const rule of rules) {
    if (rule.direction !== 'inbound') {
      throw new PolicyShapeError(`수신 정책에 ${rule.direction} 규칙이 섞였다 (rule=${rule.id})`);
    }
    if (rule.list === 'allow') allow.push(rule.kind === 'address' ? comparableAddress(rule.value) : rule.value);
    else block.push(rule.kind === 'address' ? normalizeAddress(rule.value) : rule.value);
  }
  return { mode, allow, block, version };
}

/** 수신 정책 판정. 던지지 않는다(모르는 모드는 격리 — 열리는 쪽으로 떨어지지 않는다). */
export function evaluateInboundPolicy(policy: InboundPolicy, sender: InboundSender): InboundPolicyVerdict {
  switch (policy.mode) {
    case 'all':
      return DELIVER;
    case 'disabled':
      return quarantine('inbound_disabled');
    case 'blocklist_only':
      return senderBlocked(policy.block, sender) ? quarantine('sender_blocklisted') : DELIVER;
    case 'allowlist_only':
      if (senderBlocked(policy.block, sender)) return quarantine('sender_blocklisted');
      // 인증되지 않은 From 은 allow 의 근거가 아니다(머리말).
      if (!sender.authenticated) return quarantine('sender_not_allowlisted');
      return anyContactRuleMatches(policy.allow, comparableAddress(sender.address)) ? DELIVER : quarantine('sender_not_allowlisted');
    default: {
      // 열거형 밖 값은 격리 — 판정할 수 없는 메일을 보이지 않는다(fail closed).
      const exhaustive: never = policy.mode;
      void exhaustive;
      return quarantine('inbound_disabled');
    }
  }
}
