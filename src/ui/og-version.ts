/**
 * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:images` 가 `src/site/image-data.ts` 와 함께 쓴다. OG 이미지(링크 미리보기)의 내용 해시.
 * 홈과 문서가 `og:image` 를 `/og/<해시>/<lang>.png` 로 가리킨다 — 카카오톡·슬랙·X 는 이미지를 **URL 로** 오래 기억하므로, 그림이 바뀌면
 * URL 도 바뀌어야 새 미리보기가 뜬다(2026-09-30 진윤겸: 새 로고가 공유 미리보기에 안 보였다). 문서 번들은 사이트 모듈을 싣지 않으므로 여기 둔다.
 */

export const OG_IMAGE_HASH = { ko: '52441232c8de2eb8', en: 'd73dc0e6cc85e929' } as const;
