/**
 * src/site/blog/shots.ts — 블로그 스크린샷 등록부. 글의 `![대체 글](shot:<id>)` 는 **여기 또는 문서 등록부(`src/docs/shots.ts` `DOCS_SHOTS`)**
 * 에 있는 id 만 쓸 수 있다(없으면 `pnpm gen:blog` 오류). 같은 id 가 둘 다에 있으면 여기 것이 이긴다.
 *
 * 스크린샷은 **실제 콘솔 화면**이다 — `pnpm gen:blog-images`(`scripts/gen-blog-images.ts`)가 문서 스크린샷과 같은 기계(로컬 미리보기 + 가짜 API
 * 시나리오 `docs` · 고정 시계 · 헤드리스 Chrome)로 **글이 실제로 쓰는 id 만** 두 언어 × 두 테마 WebP 로 찍어 `src/site/blog-shot-data.ts` 에 쓴다.
 * 목업은 없다. 모양(`path`·`steps`·`clip`)은 문서 등록부와 같다 — 그 머리말을 본다.
 *
 * 사이트 λ 번들은 이 파일을 싣지 않는다(빌드 때만 읽는다 — 번들은 생성 값 파일만 싣는다).
 */

import { DOCS_SHOT_AGENT_ID, type DocsShotSpec } from '../../docs/shots';

/**
 * 문서 등록부에 없는 화면이 필요할 때만 여기에 더한다. 꼴:
 *   'blog-<이름>': { path: '/app#/agents/<id>/email', clip: { selector: '#t-email' } },
 * id 는 `blog-` 로 시작한다(문서 id 와 겹치지 않게 — 테스트).
 */
export const BLOG_SHOTS: Readonly<Record<string, DocsShotSpec>> = {
  // 블로그 1호 첫 경험 — 가짜 API 시나리오 `blog`(docs + scout 발신 허용목록에 owner@example.com 하나 · 발신 로그 답장 둘).
  // 이메일 화면의 발신 열만 — 위 머리(이메일 · scout@atmark.ai)부터, 아래 한도 절은 뺀다.
  'blog-agent-email-allowlisted': {
    path: `/app#/agents/${DOCS_SHOT_AGENT_ID}/email/outbound`,
    scenario: 'blog',
    clip: { selector: '#col-outbound', from: '#t-email', until: '#col-outbound .limits' },
  },
  // 로그 › 발신 — 같은 소유자에게 간 답장 둘(위 sent, 아래 denied recipient_not_allowlisted). 사유 칸이 보이게 창을 넓힌다(콘솔 본문 960px 초과).
  'blog-logs-outbound-deny-then-sent': { path: '/app#/logs', scenario: 'blog', width: 1340, clip: { selector: '#v-logs' } },
};
