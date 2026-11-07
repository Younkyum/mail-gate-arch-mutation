/**
 * src/site/hero-names.ts — 히어로 한 줄의 주소에서 차례로 바뀌는 에이전트 이름(진윤겸 2026-09-30). 전부 **예약 로컬파트**다(누구도 발급받지 못한다 —
 * `src/identity/address.ts`). 마크업(`home.ts`)과 폭 애니메이션(`styles.ts` — 이름 길이만큼 칸이 줄고 늘어 `@` 앞에 빈칸이 없다)이 같은 목록을 쓴다.
 */

export const HERO_AGENT_NAMES = ['claude-code', 'codex', 'hermes', 'openclaw', 'cursor', 'gemini'] as const;

/** 한 이름이 보이는 시간(초). 한 바퀴 = 이름 수 × 이 값. */
export const HERO_NAME_SECONDS = 2;
