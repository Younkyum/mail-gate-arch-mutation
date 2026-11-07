/**
 * 룰 타입 — `rules.ts` 와 `rules-multilingual.ts` 가 함께 쓴다(둘 사이 순환 import 를 끊으려고 따로 둔다 — dependency-cruiser no-circular).
 */
import type { Lexicon, Span } from './match';

export type RuleFamily =
  | 'override'
  | 'ai_addressee'
  | 'prompt_reference'
  | 'prompt_leak'
  | 'role_spoof'
  | 'jailbreak'
  | 'concealment'
  | 'exfiltration'
  | 'agent_action'
  | 'tool_invocation'
  | 'authority'
  | 'encoded'
  | 'technique'
  | 'obfuscation'
  | 'evasion'
  /** 서술형 지시(2026-10-08 진윤겸 결정) — 명령문이 아니라 "이 메일을 처리하는 쪽은 … 해야 한다" 류. DMARC 를 통과해도 위험 등급. */
  | 'narrative'
  | 'scan_limit';

export interface RuleBase {
  readonly id: string;
  readonly family: RuleFamily;
  /** 합산 점수 기여. 1–2 약한 표지, 3 지시성 표지, 5 단독으로 high(도구 행동으로 비밀 유출). */
  readonly weight: number;
  /** 인용·코드 펜스 안 + 메타 논의 문서에서 가중치를 1 로 낮출 수 있는가(머리말). */
  readonly dampable: boolean;
  /**
   * 다국어 룰 — 원문 글자로 적고 `foldPatternLiteral` 로 접은 룰. 발음 부호·동형문자 접기는 그 언어를 읽는 정상 경로라
   * 난독화 가산(`obfuscation.normalization_revealed`)은 **강한** 표시(보이지 않는 문자·태그·전각)에만 붙인다.
   */
  readonly nativeFold?: boolean;
}

/** 접은 보기(또는 base64 를 풀어 접은 보기)에 거는 단일 정규식 룰. */
export interface PatternRule extends RuleBase {
  readonly kind: 'pattern';
  readonly pattern: RegExp;
}

/** 어휘 적중 목록을 짝짓는 원거리 룰. 정규식 하나로 쓰면 이차 시간이 된다(머리말). */
export interface ProximityRule extends RuleBase {
  readonly kind: 'proximity';
  /** 짝짓기 로직의 데이터 서명(어휘 순서·창 크기). 로직을 바꾸면 이것도 바꾼다 — 버전 해시의 재료다. */
  readonly signature: string;
  readonly find: (text: string, lexicon: Lexicon) => Span[];
}

export type SemanticRule = PatternRule | ProximityRule;
