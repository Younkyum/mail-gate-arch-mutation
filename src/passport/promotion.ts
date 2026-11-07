/**
 * src/passport/promotion.ts — **승격(promotion) 순수 함수** (계획 §5.0b Layer P2 · AC-13 · ADR-0003).
 *
 * 증명할 명제: 같은 `agentId`·같은 keypair 로 `alsoKnownAs` 에 체인 신원을 **추가만** 하는 변경은 이미 발급된 passport 를 폐기하지 않는다.
 * 그래서 이 함수는 DID 문서에 `alsoKnownAs` 한 칸을 더할 뿐 `id`·`verificationMethod`·`authentication`·`assertionMethod`·`controller`·
 * `service` 를 **건드리지 않는다**(배열 순서까지 — `kid` 해석이 순서에 기대는 리졸버가 있다). **체인 호출·SDK·네트워크 없음** — 체인
 * 선택은 §3.6 트리거(T-A1~T-A3)가 성립할 때의 ADR 이 한다. 이 함수가 존재하는 이유는 "승격 경로가 열려 있다" 를 **코드와 동결 픽스처로**
 * 보이는 것이다(`test/integration/passport/promotion.test.ts` 단언 (a)~(h)).
 *
 * 체인 신원 표기: **CAIP-10** 계정 식별자 `<namespace>:<reference>:<account>`. 계정 말단은 `agentId`(16바이트)를 **bytes32 로 0 채움**한
 * `0x` + 64 hex 다(§4B.1 "온체인 bytes32 에 제로패딩으로 무손실 매핑"). 그래서 말단에서 `agentId` 를 되찾을 수 있다(단언 (d)).
 */

import type { AgentId } from '../db/schema';
import type { DidDocument } from './document';

/** 연속성을 깨는 승격 요청 — 새 키·다른 에이전트·다른 DID. **거부가 이 함수의 기능이다**(단언 (e)). */
export class PromotionWouldBreakContinuity extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionWouldBreakContinuity';
  }
}

export interface ChainIdentity {
  /** CAIP-2 체인 id(`eip155:8453` 등). */
  readonly chainId: string;
  /** 승격 대상 에이전트 — DID 의 말단과 같아야 한다. */
  readonly agentId: AgentId;
  /**
   * 체인 쪽이 요구하는 공개키(있으면). **DID 문서의 키와 다르면 거부한다** — 새 키를 요구하는 승격은 승격이 아니라 신규 발급이다
   * (§4B.1b 긴장 2).
   */
  readonly publicKeyJwkX?: string;
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const CAIP10 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32}):([-.%a-zA-Z0-9]{1,128})$/;

/** `agentId`(32 hex) → bytes32 계정 말단(`0x` + 64 hex, 앞 0 채움). */
function bytes32AccountOf(agentId: AgentId): string {
  return `0x${agentId.padStart(64, '0')}`;
}

/** CAIP-10 문자열 → 부분. 형식이 아니면 `null`. */
export function parseCaip10(value: string): { readonly namespace: string; readonly reference: string; readonly account: string } | null {
  const match = CAIP10.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { namespace: match[1], reference: match[2], account: match[3] };
}

function caip10Of(identity: ChainIdentity): string {
  if (!CAIP2.test(identity.chainId)) throw new PromotionWouldBreakContinuity(`CAIP-2 체인 id 가 아니다: ${identity.chainId}`);
  return `${identity.chainId}:${bytes32AccountOf(identity.agentId)}`;
}

/** DID 문서 → 승격된 DID 문서. 원본은 바꾸지 않는다(새 객체). */
export function promote(original: DidDocument, identity: ChainIdentity): DidDocument {
  if (!original.id.endsWith(`:${identity.agentId}`)) {
    throw new PromotionWouldBreakContinuity('다른 에이전트의 체인 신원이다 — DID 말단과 agentId 가 다르다.');
  }
  if (identity.publicKeyJwkX !== undefined) {
    const keys = original.verificationMethod.map((method) => method.publicKeyJwk?.x).filter((x): x is string => x !== undefined);
    if (!keys.includes(identity.publicKeyJwkX)) {
      throw new PromotionWouldBreakContinuity('새 키를 요구하는 승격이다 — 그것은 승격이 아니라 신규 발급이다(§4B.1b 긴장 2).');
    }
  }
  const account = caip10Of(identity);
  const existing = original.alsoKnownAs ?? [];
  if (existing.includes(account)) return original;
  return { ...original, alsoKnownAs: [...existing, account] };
}
