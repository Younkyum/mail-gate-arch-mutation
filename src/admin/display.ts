/**
 * src/admin/display.ts — 관리 API 응답의 **표시 문자열 정화**(이중 방어). 에이전트·외부가 정한 문자열(에이전트 이름·주소·
 * 제목·수신자·발신자)을 응답에 싣기 전에 승인 페이지와 같은 규칙(`sanitizeDisplayText` — 한 줄 · 보이지 않는/양방향 문자 제거 ·
 * 길이 상한)으로 한 번 거른다. UI 도 `textContent` 로만 그리지만, 응답 자체가 깨끗하면 다른 소비자(스크립트·로그)도 안전하다.
 * **식별자(id)는 거르지 않는다** — 바뀌면 다음 요청이 다른 대상을 가리킨다.
 */

import {
  AGENT_SUBJECT_MAX_CHARS,
  RECIPIENT_MAX_CHARS,
  sanitizeDisplayText,
} from '../notify/approval-notification-template';

/**
 * 이름(가입 조직 이름 · 토큰 이름)에 쓸 수 없는 문자 — `signup_links.organization_name` CHECK 의 문자 집합의 **엄격한 상위 집합**이어야 한다(검증 H3).
 * 앱이 통과시키고 DB 가 거부하는 문자가 하나라도 있으면, 새 주소는 가입 링크 INSERT 에서 CHECK(23514)로 떨어지고 소유자 주소는
 * 그 INSERT 가 0행이라 202 — 응답이 주소의 존재를 가른다(U+2065 로 실증됐다). 그래서 일반 범주(제어 Cc · 서식 Cf · **미할당 Cn** ·
 * 사용자 영역 Co · 대리 Cs · 줄/문단 구분 Zl·Zp)에 더해, 범주로는 잡히지 않는 **보이지 않거나 폭 없는 글자**(한글 채움 문자 ·
 * 결합 자소 결합자 · 몽골 자유 변형 선택자 · 이형 선택자 · 점자 빈칸 · 태그 문자)를 명시한다. 이 목록이 DB 보다 좁아지면
 * `test/integration/admin/signup-name-charset.test.ts` 가 실제 CHECK 를 전 코드 포인트에 대 보고 빨개진다.
 */
export const INVISIBLE_OR_CONTROL_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\u2800\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** 에이전트·조직 이름 상한 — DB CHECK(200자)와 같다. */
const NAME_MAX_CHARS = 200;

export function displayName(value: string): string {
  return sanitizeDisplayText(value, NAME_MAX_CHARS);
}

export function displayAddress(value: string): string {
  return sanitizeDisplayText(value, RECIPIENT_MAX_CHARS);
}

export function displaySubject(value: string): string {
  return sanitizeDisplayText(value, AGENT_SUBJECT_MAX_CHARS);
}

/** 응답의 시각 — ISO 문자열, 없으면 `null`. */
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
