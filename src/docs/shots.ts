/**
 * src/docs/shots.ts — 문서 스크린샷 등록부. 콘텐츠의 `![대체 글](shot:<id>)` 는 여기 있는 id 만 쓸 수 있다(없으면 빌드 오류).
 *
 * 스크린샷은 **실제 콘솔 화면**이다 — `pnpm gen:docs-shots`(`scripts/gen-docs-shots.ts`)가 로컬 미리보기(`scripts/ui/preview.ts`)와 가짜 API
 * (`scripts/ui/fake-api.ts`, 예시 조직 Example Labs · `*.example` 상대 · 고정 시계)로 띄워 두 언어 × 두 테마 WebP 로 찍고, 바이트를
 * `src/docs/generated/shots.ts` 에 쓴다. 목업·가짜 UI 는 없다. 발급 직후 대화상자(`token-once`)는 가짜 API 가 토큰 모양이 아닌 예시 글자를 돌려준다(스크린샷에 토큰 모양 문자열이 없어야 한다 — 계획 §6).
 *
 * `path` 는 콘솔 미리보기 경로(해시 라우트), `steps` 는 연 뒤 누를 것(선택자는 콘솔 마크업의 id). import 가 없는 값 파일이다.
 */

export interface DocsShotStep {
  readonly click?: string;
  /** 입력 칸 값 채우기 — `[선택자, 값]`(input 이벤트를 낸다). */
  readonly fill?: readonly [string, string];
  readonly wait?: number;
}

/**
 * 찍을 영역 — 문서 본문 칸(최대 720px)에서 글자가 읽히게(약 11px 이상) 화면 전체가 아니라 **해당 패널만** 자른다.
 *   - `selector`: 그 요소의 상자(+ 둘레 16px). `from`: 이 요소가 위에 있으면 거기서 시작한다(패널 밖 배너를 함께 싣는다).
 *   - `until`: 이 선택자의 요소가 시작하는 곳에서 멈춘다(문서에 싣지 않는 아래 절을 빼는 틀 — 화면을 고치지 않는다).
 *   - `untilRow`: 이 선택자(예: 표의 `tr`) 중 글자에 `text` 가 들어간 첫 요소에서 멈춘다(언어마다 다른 글자라 둘 다 적는다).
 */
export interface DocsShotClip {
  readonly selector: string;
  readonly from?: string;
  readonly until?: string;
  readonly untilRow?: { readonly selector: string; readonly text: readonly string[] };
}

export interface DocsShotSpec {
  readonly path: string;
  /** 가짜 API 시나리오(`fake-api.ts` `SCENARIOS`). 기본 `docs`(예시 조직 Example Labs · 발급 값은 토큰 모양이 아닌 예시 글자). */
  readonly scenario?: string;
  readonly steps?: readonly DocsShotStep[];
  readonly clip: DocsShotClip;
  /** 찍는 창 폭(CSS px) — 기본 `DOCS_SHOT_VIEW.width`. 넓어야 보이는 칸(예: 로그 표의 사유 칸 — 콘솔 본문 960px 이하에서 숨는다)이 있을 때만. */
  readonly width?: number;
}

/** 예시 에이전트 id(32 hex — 실제 id 와 같은 모양). 가짜 API `DOCS_AGENT_IDS.a1` 과 같다(테스트). */
export const DOCS_SHOT_AGENT_ID = '7c3e9b2a4f1d4e8b9a6c0d2e5f7a1b3c';
const A1 = DOCS_SHOT_AGENT_ID;

export const DOCS_SHOTS = {
  // 새 에이전트는 대화상자(2026-09-30 — 펼치는 패널 대신) — 목록이 아니라 열린 창을 싣는다.
  'agent-new': { path: '/app#/agents', steps: [{ click: '#na-open', wait: 400 }], clip: { selector: 'dialog[open]' } },
  'agent-overview': { path: `/app#/agents/${A1}`, clip: { selector: '#t-overview', until: '#t-overview > .block' } },
  // 별칭(주소 탭 — 문서 플래그 off)은 2026-09-29 부터 이메일 화면 밖이라 자를 절이 없다.
  'agent-email': { path: `/app#/agents/${A1}/email`, clip: { selector: '#t-email' } },
  // 아래 "변경 이력"(공개 전 기능)은 뺀다.
  'agent-identity': { path: `/app#/agents/${A1}/identity`, clip: { selector: '#t-identity', until: '#ib' } },
  'agent-tokens': { path: `/app#/agents/${A1}/tokens`, clip: { selector: '#t-tokens' } },
  // 발급 직후 "한 번만 보입니다" 대화상자 — 값은 가짜 API 의 예시 글자(`DOCS_EXAMPLE_TOKEN`, 토큰 모양 아님).
  'token-once': {
    path: `/app#/agents/${A1}/tokens`,
    steps: [{ click: '#tk-new', wait: 300 }, { fill: ['#nt-label', 'hermes'] }, { click: '#nt-go', wait: 800 }],
    clip: { selector: 'dialog[open]' },
  },
  'agent-connect': { path: `/app#/agents/${A1}/connect`, clip: { selector: '#t-connect' } },
  logs: { path: '/app#/logs', clip: { selector: '#v-logs' } },
  'logs-scheduled': { path: '/app#/logs/scheduled', clip: { selector: '#v-logs' } },
  // 설정 화면은 패널 하나만 — 위의 설정 탭 줄(문서에서 다루지 않는 탭 이름 포함)은 들어가지 않는다.
  team: { path: '/app#/settings/members', clip: { selector: '#s-members' } },
  // 표의 별칭·첨부 행(문서 플래그 off)과 그 아래 안내문은 뺀다.
  'settings-plan': { path: '/app#/settings/plan', clip: { selector: '#s-plan', untilRow: { selector: '#s-plan tr', text: ['별칭', 'Alias', 'alias'] } } },
  'settings-pause': { path: '/app#/settings/pause', clip: { selector: '#s-pause' } },
  'settings-keys': { path: '/app#/settings/keys', clip: { selector: '#s-keys' } },
  'review-banner': { path: '/app#/overview', scenario: 'docs-pending', clip: { selector: '#v-overview', from: '#rv-pending', until: '#ov-log-b' } },
} as const satisfies Readonly<Record<string, DocsShotSpec>>;

export type DocsShotId = keyof typeof DOCS_SHOTS;

export function isDocsShotId(value: string): value is DocsShotId {
  return Object.prototype.hasOwnProperty.call(DOCS_SHOTS, value);
}

/** 찍는 창(CSS px)·배율 — 본문 칸(최대 720)에서 2배 화면도 흐리지 않게 1.5배로 찍는다. 창 1200 에서 콘솔 본문 칸은 약 860px. */
export const DOCS_SHOT_VIEW = { width: 1200, height: 900, scale: 1.5, quality: 82, pad: 16 } as const;
