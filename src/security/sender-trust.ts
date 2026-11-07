/**
 * src/security/sender-trust.ts — 수신 발신자 신뢰 판정 `computeTrust` (계획 §6 P4, §4B.4, §3.4 3조).
 *
 * **이 값은 권한 판정의 입력이다.** §3.4 3조가 `auto_approve_verification_senders` 의 ON 전제로
 * `inbound.injection_risk == none` **AND** `sender_trust >= seen` 을 건다. 즉 여기서 `seen` 이상을
 * 내는 순간 에이전트의 회신이 **사람 눈 없이** 나갈 수 있다. `resolve.ts` 의 authority/display 분리와
 * 같은 규율이 적용된다: 권한에 쓰이는 값은 **공격자가 만들 수 없는 증거**로만 올린다. "아마 아는
 * 사람" 같은 표시용 친숙도는 이 값에 섞지 않는다(`contact_history` 는 관측만 한다).
 *
 * I/O 없음. 신호 목록 → 판정 하나.
 *
 * ---------------------------------------------------------------------------
 * ## 격자 — 사슬 하나 + 흡수 원소
 * ---------------------------------------------------------------------------
 *
 *     blocked  <  unknown  <  seen  <  seed  <  approved
 *
 * - `>= seen` 은 `trustAtLeast(category, 'seen')` 한 줄이다. 전순서이므로 비교가 항상 성립한다.
 * - **`blocked` 는 바닥이고 흡수한다.** 비교 하한(`TrustFloor`)에 `blocked` 가 없으므로 `blocked` 는
 *   어떤 비교에서도 진다. 그리고 `computeTrust` 에서 차단 신호가 하나라도 있으면 다른 모든 신호를 무시하고
 *   `blocked` 다 — 합(join)이 아니라 흡수다. §4.2 "blocklist 는 항상 allowlist·관계·승인을 이긴다" 의
 *   수신 쪽 대응이다.
 * - `seed`·`approved` 는 둘 다 소유자 결정이다. 사슬 위 순서(approved > seed)는 "사람이 구체적 메시지를
 *   보고 승인했다" 가 "프로비저닝 때 미리 적었다" 보다 좁은 증거라는 뜻일 뿐, 지금 이 둘을 구분해 읽는
 *   소비자는 없다(소비자는 `>= seen` 하나).
 *
 * ---------------------------------------------------------------------------
 * ## 신호의 효과
 * ---------------------------------------------------------------------------
 *
 * | 신호                    | 효과                                                       |
 * |-------------------------|------------------------------------------------------------|
 * | `blocklisted`           | **흡수** → `blocked` (인증 불요 — 막는 쪽은 사칭돼도 안전) |
 * | `spf_dkim_aligned`      | **관문** — 없으면 올리는 신호 전부 무효                    |
 * | `suppression_hit`       | **상한** `unknown`                                          |
 * | `injection_history`     | **상한** `unknown`                                          |
 * | `owner_marked_seen`     | 올림 → `seen` (도메인 스코프는 공유 도메인에서 무효)        |
 * | `seed_contact`          | 올림 → `seed`                                               |
 * | `approved_relationship` | 올림 → `approved` (도메인 스코프는 공유 도메인에서 무효)    |
 * | `contact_history`       | **관측 전용** — 등급 불변                                   |
 * | `passport_verified`     | **거부** — 던진다                                           |
 *
 * 올리는 신호가 **있어야** 올라간다. 인증 신호도 **있어야** 통과한다. 신호가 빠지면 `unknown` 으로
 * 떨어진다 — 목록의 부재가 신뢰가 되는 경로가 없다.
 *
 * ---------------------------------------------------------------------------
 * ## 자동 승격(`unknown → seen`)을 하지 않는다 — 수동 분류로 축소 (§6 P4 thin slice)
 * ---------------------------------------------------------------------------
 *
 * 공격: 첫 메일로 `seen` 을 얻고, 두 번째 "확인 코드" 메일로 자동 승인 회신을 끌어낸다. 후보 조건을
 * 하나씩 보면 **수신 이력에서 나오는 사실은 전부 공격자가 만들 수 있다**:
 *
 *   - DMARC 인증 — 공격자 **자기 도메인**의 DMARC 통과는 공짜다. 인증은 "From 을 사칭하지 않았다" 를
 *     증명할 뿐 "믿을 만하다" 를 증명하지 않는다. (그래서 올림의 **필요조건**으로만 쓴다.)
 *   - 최소 횟수·기간 — 메일 N통을 D일에 걸쳐 보내면 된다. 방어가 아니라 지연이다.
 *   - injection 이력 없음 — 첫 N통을 무해하게 쓰면 된다. 스캐너 우회가 필요하지도 않다.
 *   - 에이전트가 먼저 보냈는가 — 공격자가 통제하지 못하는 유일한 후보지만, 둘로 갈린다.
 *     (a) `approval_required` 에서 새 상대로의 첫 발송은 승인을 타고, 승인은 `approved` 관계를 만든다 —
 *     이미 `approved` 이므로 `seen` 규칙이 더할 것이 없다. (b) 승인 없이 새 상대에게 나갈 수 있는 경로
 *     (공격자가 연 스레드 안의 회신, 승인 없는 모드)에서의 발송은 **injection 으로 유도할 수 있는 에이전트
 *     행동**이다 — 다른 스레드의 메일이 "evil@x 에 인사해" 라고 시키면 된다. 신뢰의 뿌리가 되지 못한다.
 *
 * 그러므로 안전한 자동 규칙은 세울 수 없다. `seen` 의 출처는 **소유자의 수동 분류(`owner_marked_seen`)
 * 하나**다. 대가: 워크로드 1 의 확인 메일 발신자(`noreply@service`)는 소유자가 미리 분류해 두지 않으면
 * `unknown` 이고, 그 회신은 승인을 한 번 탄다 — 승인 한 번은 복구 가능한 비용이고, 무인 자동 회신은 아니다.
 *
 * ---------------------------------------------------------------------------
 * ## 신뢰의 단위는 주소다. 도메인 신뢰는 소유자가 명시한 것만, 공유 도메인에서는 무효
 * ---------------------------------------------------------------------------
 *
 * DMARC 는 **도메인**만 인증한다. 도메인 단위 신뢰(`domain` 스코프 관계·분류)는 "그 조직의 누구든" 이고,
 * 그 도메인을 한 조직이 통제할 때만 뜻이 있다. `gmail.com` 의 도메인 신뢰는 "지구상 누구든" 이다.
 * 그리고 **`atmark.ai` 도 공유 도메인이다** — 다른 고객(공격자 포함)의 에이전트가 같은 도메인에서 보낸다.
 * `SHARED_MAILBOX_DOMAINS` 는 소유자 실수를 막는 **거부 목록**이라 불완전하다(목록 밖 무료 메일은
 * 걸리지 않는다). 그 구멍의 크기는 "소유자가 `confirm_scope: domain` 으로 무료 메일 도메인을 명시 확인한
 * 경우" 로 한정된다 — 도메인 신뢰가 소유자 명시 없이 생기는 경로는 없다.
 *
 * ---------------------------------------------------------------------------
 * ## 저장
 * ---------------------------------------------------------------------------
 *
 * 격자는 `sender_trust_category` 열거형(202609230020)이다. `sender_relationships.trust_category`(`seed`|`approved`)는
 * **발신 허가**(Stage 7 standing approval)이고 이 모듈에는 신호의 출처일 뿐이다. 수동 분류 `seen` 을 그 열거형에 더하면 안 된다 —
 * Stage 7 은 관계 행의 **존재**로 승인을 건너뛰므로 "수신 신뢰 표시" 가 곧 "승인 없는 발송 허가" 가 된다. 수동 분류는 `sender_marks` 다.
 */

import { isSharedMailboxDomain } from './shared-mailbox';
import type { TrustSignal, TrustSignalKind } from './trust-signals';

// ---------------------------------------------------------------------------
// 격자
// ---------------------------------------------------------------------------

export type SenderTrustCategory = 'blocked' | 'unknown' | 'seen' | 'seed' | 'approved';

/** 비교 하한. `blocked` 는 하한이 될 수 없다 — "적어도 차단됨" 은 모든 값이 만족하는 무의미한 조건이다. */
export type TrustFloor = Exclude<SenderTrustCategory, 'blocked'>;

const RANK: Readonly<Record<SenderTrustCategory, number>> = {
  blocked: 0,
  unknown: 1,
  seen: 2,
  seed: 3,
  approved: 4,
};

/** `category >= floor`. `blocked` 는 어떤 하한에도 진다. */
export function trustAtLeast(category: SenderTrustCategory, floor: TrustFloor): boolean {
  if (category === 'blocked') return false;
  return RANK[category] >= RANK[floor];
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

/** 올리는 신호가 있었는데 무효가 된 이유. audit·디버깅용. */
export type TrustCapReason =
  | 'unauthenticated'
  | 'suppression_hit'
  | 'injection_history'
  | 'shared_domain_scope';

export interface SenderTrust {
  readonly category: SenderTrustCategory;
  /** 등급을 정한 신호. `unknown` 이면 `null`. */
  readonly decidedBy: TrustSignalKind | null;
  /** 무효가 된 올림의 이유(중복 없음, 발생 순). 올림이 없었으면 빈 배열일 수 있다. */
  readonly capped: readonly TrustCapReason[];
}

/**
 * 수집기가 없는 신호가 들어왔다 (§4B.4). 조용히 무시하면, 생산자를 붙인 사람은 신뢰가 오른다고 믿고
 * 우리는 무시한다고 믿는 상태가 된다. 조용히 올리면 수집기 없는 신호가 권한이 된다. 둘 다 아니라 던진다 —
 * 판정 의미(어느 등급인가, 인증 관문을 타는가)를 여기서 정한 뒤에만 받는다.
 */
export class UncollectedTrustSignalError extends Error {
  constructor(readonly kind: TrustSignalKind) {
    super(
      `신뢰 신호 "${kind}" 는 선언만 됐고 Phase 1 수집기가 없다 (계획 §4B.4). ` +
        '생산자를 붙이려면 computeTrust 에서 그 의미를 먼저 정하라.',
    );
    this.name = 'UncollectedTrustSignalError';
  }
}

interface Raise {
  readonly category: 'seen' | 'seed' | 'approved';
  readonly kind: TrustSignalKind;
}

export function computeTrust(signals: readonly TrustSignal[]): SenderTrust {
  let blockedBy: TrustSignalKind | null = null;
  let authenticated = false;
  let best: Raise | null = null;
  const capped: TrustCapReason[] = [];
  const cap = (reason: TrustCapReason): void => {
    if (!capped.includes(reason)) capped.push(reason);
  };

  for (const signal of signals) {
    let candidate: Raise | null = null;
    switch (signal.kind) {
      case 'passport_verified':
        throw new UncollectedTrustSignalError(signal.kind);
      case 'blocklisted':
        blockedBy = signal.kind;
        break;
      case 'spf_dkim_aligned':
        authenticated = true;
        break;
      case 'suppression_hit':
      case 'injection_history':
        cap(signal.kind);
        break;
      case 'owner_marked_seen':
        if (signal.scope === 'domain' && (signal.domain === null || isSharedMailboxDomain(signal.domain))) {
          cap('shared_domain_scope');
        } else {
          candidate = { category: 'seen', kind: signal.kind };
        }
        break;
      case 'seed_contact':
        candidate = { category: 'seed', kind: signal.kind };
        break;
      case 'approved_relationship':
        if (signal.scope === 'domain' && (signal.domain === null || isSharedMailboxDomain(signal.domain))) {
          cap('shared_domain_scope');
        } else {
          candidate = { category: 'approved', kind: signal.kind };
        }
        break;
      case 'contact_history':
        // 관측 전용 — 머리말 "자동 승격을 하지 않는다".
        break;
      default: {
        const unreachable: never = signal;
        throw new UncollectedTrustSignalError((unreachable as TrustSignal).kind);
      }
    }
    if (candidate !== null && (best === null || RANK[candidate.category] > RANK[best.category])) best = candidate;
  }

  if (blockedBy !== null) return { category: 'blocked', decidedBy: blockedBy, capped };

  if (best === null) return { category: 'unknown', decidedBy: null, capped };

  if (!authenticated) cap('unauthenticated');
  if (!authenticated || capped.includes('suppression_hit') || capped.includes('injection_history')) {
    return { category: 'unknown', decidedBy: null, capped };
  }
  return { category: best.category, decidedBy: best.kind, capped };
}
