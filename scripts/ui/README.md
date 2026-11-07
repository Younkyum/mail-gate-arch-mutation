# scripts/ui — 로컬 UI 미리보기 · 스크린샷

AWS·DB 없이 콘솔(`console.atmark.ai`)과 홈(`atmark.ai`)을 로컬에서 그대로 띄우고, 시스템 Chrome 헤드리스로 화면을
전체 페이지 PNG 로 찍는 도구다. 디자인 리뷰(디자이너·비평가 에이전트)가 실제로 돌아가는 화면을 보고 판단할 수 있게 만든 것이다.

## 실행

```bash
pnpm ui:preview        # 콘솔(4173)·홈(4174) 서버만 띄운다(수동으로 브라우저에서 열어볼 때)
pnpm ui:shots          # 서버가 없으면 스스로 띄우고, targets.ts 의 화면을 전부 찍고, 끝나면 서버·Chrome 을 끈다
```

`pnpm ui:preview` 를 먼저 켜 둔 채로 `pnpm ui:shots` 를 돌리면 그 서버를 그대로 쓴다(새로 안 띄우고, 끝나도 안 끈다) —
콘솔에서 `http://127.0.0.1:4173/app`, 홈에서 `http://127.0.0.1:4174/` 를 직접 열어보면서 동시에 스크린샷도 뽑고 싶을 때 쓴다.

Chrome 실행 파일은 `ATMARK_CHROME` 환경 변수로 바꿀 수 있다(기본: macOS `/Applications/Google Chrome.app/…`). Ctrl-C·SIGTERM 으로
끊어도 헤드리스 Chrome·임시 프로필·스스로 띄운 미리보기 서버를 치운다. 기본 출력 폴더 `.omc/shots/` 는 `.gitignore` 에 있다.

폰트: 콘솔은 폰트를 홈 출처에서 받는다(운영 `https://atmark.ai/_fonts/…`). 미리보기의 콘솔 페이지는 홈 미리보기(`http://127.0.0.1:4174`)를
폰트 출처로 렌더하고, 홈 미리보기는 `/_fonts/…` 응답의 `access-control-allow-origin` 을 콘솔 미리보기 출처(`http://127.0.0.1:4173`)로 바꿔 준다.

## 홈 미리보기 손잡이(2026-09-30 — 미리보기 전용, 운영에는 없다)

- **언어**: 영어가 기본(`http://127.0.0.1:4174/`), 한국어는 `/kr`(`http://127.0.0.1:4174/kr`). 운영의 엣지 언어 협상(CloudFront Function,
  `src/site/edge-lang.ts`)을 **같은 소스 그대로** 로컬 서버가 먼저 돌린다 — 브라우저가 한국어를 최상위로 보내거나 쿠키 `atmark_lang=ko` 면
  접두어 없는 페이지가 `/kr…` 로 302, 언어 전환 링크(`?hl=ko|en`)는 쿠키를 적고 302. 쿠키 `Secure` 는 http 로컬이라 뗀다.
  영어 화면을 한국어 브라우저에서 보려면 머리의 English 를 한 번 누른다(쿠키 `en`).
- **로그인 힌트**: 사이트 URL 에 `?_session=in` 을 붙이면 로그인한 방문자 화면(머리 왼쪽 "콘솔" 버튼, 로그인·시작하기 숨김 — `/login` 은 콘솔
  미리보기 `/app` 으로 곧장 간다), `?_session=out` 이면 로그아웃(기본). 값은 쿠키 `atmark_preview_session` 에 남고, 콘솔 미리보기의
  `GET /api/session/hint` 가 그 쿠키로 `{"signedIn":…}` 을 답한다. 탭의 `sessionStorage` 에도 표시가 남으므로 바꾼 뒤에는 새로 고친다.
- **콘솔 출처**: 사이트 페이지의 스크립트가 부르는 `https://console.atmark.ai` 를 미리보기가 콘솔 미리보기 출처로 바꿔 싣고, CSP 해시를 다시 잰다.

## `ui:shots` 플래그

| 플래그 | 기본값 | 뜻 |
|---|---|---|
| `--out <dir>` | `.omc/shots/<타임스탬프>` | PNG·리포트를 쓸 폴더 |
| `--only <문자열>` | (전부) | 대상 id 에 이 문자열이 포함된 것만(`targets.ts` 의 `id`). 쉼표로 여러 개(하나라도 포함) |
| `--widths <목록>` | `desktop,tablet,mobile` | 쉼표로 구분 |
| `--themes <목록>` | `light,dark` | 쉼표로 구분 |
| `--langs <목록>` | `ko` | 콘솔 대상에만 적용(`--langs en,ko`) — 홈 대상은 대상마다 언어가 고정이다(경로 기반) |

```bash
pnpm ui:shots --only agent-overview --widths desktop,mobile --themes light
pnpm ui:shots --langs en,ko                       # 콘솔 화면을 두 언어로
```

## 출력

`<out>/` 아래:
- `<대상 id>.<너비>.<테마>.<언어>.png` — 전체 페이지 스크린샷(가로 스크롤 없이 실제 문서 높이 전체).
- `report.json` — 찍은 것 전부의 구조화 기록. 각 항목:
  ```ts
  {
    id, target, kind,      // "console-overview.desktop.light.ko", "console-overview", "console"|"site"
    url, width, theme, lang, file,
    overflow: boolean,     // document.scrollingElement.scrollWidth > innerWidth
    consoleErrors: { level, text }[],   // console.error·console.warn
    exceptions: { text, url, line }[],  // 잡히지 않은 JS 예외
    cspViolations: unknown[],           // securitypolicyviolation 이벤트 + Chrome 의 security 로그
    networkFailures: { url, errorText }[], // 요청 자체가 실패(연결 거부 등)
    httpErrors: { url, status }[],         // 응답은 왔지만 4xx·5xx
  }
  ```
- `report.md` — 사람이 읽는 요약(문제 있는 샷만 나열). 전부 깨끗하면 "문제 없음" 한 줄.

## 화면 목록 고치기 — `targets.ts`

새 화면·새 상태를 찍고 싶으면 `scripts/ui/targets.ts` 의 `TARGETS` 배열에 한 줄 추가한다:

```ts
{ id: 'console-agent-connect', kind: 'console', path: '/app#/agents/a1/connect' },
{ id: 'console-org-switcher-open', kind: 'console', path: '/app#/overview', steps: [{ click: '#sw-org' }] },
{ id: 'site-pricing-ko', kind: 'site', path: '/kr/pricing', lang: 'ko' },
```

- `kind: 'console'` — `path` 는 `/app#/...` 같은 해시 라우트(`src/admin/ui/console/router.ts` 의 라우트 표를 따른다).
  언어는 `--langs` 를 그대로 타므로 `lang` 을 안 준다.
- `kind: 'site'` — `path` 는 홈의 실제 경로(`src/site/http.ts` `SITE_ROUTES`). 홈은 언어가 경로로만 갈리므로
  `lang` 을 꼭 고정해서 적는다(파일 이름에도 쓰인다).
- `steps` — 화면을 연 뒤 더 누른다(열린 상태를 찍을 때). `{ click: '선택자' }` 는 `document.querySelector` 로 찾아 진짜
  클릭 이벤트를 낸다(못 찾으면 조용히 지나간다). `{ key: 'Escape' }` 는 키 하나. `{ type: 'https://…' }` 는 포커스된 칸에 글자 넣기. `{ wait: 300 }` 은 그냥 대기.
  선택자는 실제 마크업의 id·class 다(`src/admin/ui/console/markup/*.ts`) — 마크업이 바뀌면 여기도 맞춰 고친다.
- `widths` — 이 대상만 기본 너비 목록 대신 쓸 목록(모바일 메뉴처럼 그 너비에서만 뜻이 있을 때, 예: `widths: ['mobile']`).

## 가짜 `/api/*` 가 답하는 것 — `fake-api.ts`

DB 없이 콘솔을 실제로 돌리려고 `test/unit/admin/console-harness.ts` 의 `mockApi`·고정 데이터(AGENT·POLICY·TOKENS·
STATS·PLAN·TEAM·...)를 그대로 재사용한다 — 콘솔 유닛 테스트가 이미 "진짜 API 계약과 같은 모양" 이라고 검증해 둔 것이다.
그 위에 이 미리보기만을 위해 더한 것:

- **에이전트 목록 넷** (`GET /api/agents`, `GET /api/agents/{id}`): `a1`(founder-agent · 활성 · 신원 게시됨,
  하네스의 `AGENT` 그대로) · `a2`(support-bot · 준비 중 · 신원 게시 전) · `a3`(sales-agent · 정지됨(owner) ·
  신원 게시됨) · `a4`(legacy-agent · 비활성 · 신원 폐기됨). **하위 자원(정책·규칙·토큰·신원·로그)은 어느 에이전트를 보든
  하네스의 `a1` 데이터를 그대로 낸다** — 목록·카드 밖에서는 a2~a4 가 a1 과 똑같이 보인다는 뜻이다(화면을 보는 용도라
  문제 없지만, a2~a4 의 실제 정책·토큰 화면을 봐야 하면 `fake-api.ts` 를 넓혀야 한다).
- `GET /api/me`: 하네스 기본값보다 넓혀 조직 둘(소유자 조직 `Chronostasis` + 검토 대기 중인 `Kairos Labs`)을 멤버십에 싣는다.
- `GET|POST /api/billing*`: 하네스에 없어서 여기서 직접 채운다(`src/admin/ops/billing.ts` `BillingOverviewView`
  모양 — 결제 열림 · 구독 없음 · pro/team/scale 전부 살 수 있음).

**모르는 경로**: GET 은 404(`route_not_found`, 스크립트 로그로도 남는다) · 그 밖(POST·PATCH·DELETE)은 저장 없이
`{ ok: true }` 로 성공 처리한다(화면이 죽지 않게). `pnpm ui:preview` 를 켜 둔 채로 콘솔 화면을 눌러보면 터미널에
어느 경로가 안 걸렸는지 그대로 찍힌다.

## 알려진 한계

- 세션·CSRF·역할 기반 302 리다이렉트는 흉내 내지 않는다 — `/`·`/app`·`/signup` 은 항상 그 경로의 화면을 낸다
  (실제 서버라면 세션 유무로 서로에게 리다이렉트한다).
- a2~a4 의 정책·토큰·신원·로그 화면은 a1 데이터를 그대로 보여준다(위 참고).
- `pay.atmark.ai`·`www.atmark.ai` 호스트는 로컬에 포트가 하나뿐이라 쿼리 `?_host=pay.atmark.ai` 로 흉내 낸다
  (진짜 배포에는 없는, 미리보기 전용 손잡이 — `preview.ts` 의 `toSiteEvent` 참고). 결제는 `{ pay: null }` 로 고정이라
  `pay.atmark.ai` 의 **체크아웃**(`?_ptxn=...`)은 늘 404 다 — 쿼리 없는 안내 페이지는 그대로 200.
- `Page.captureScreenshot` 배율은 전부 1(모바일도) — 파일 크기를 작게 유지하려고. 고배율이 필요하면
  `shots.ts` `captureOne` 의 `Page.captureScreenshot` 호출에 `deviceScaleFactor` 를 넣어 조정한다.

## 홈 이미지 만들기 — `pnpm gen:images`

OG 이미지(1200×630 PNG, 언어별 — 홈 h1 + **실제 콘솔 스크린샷** 조각)를 `scripts/gen-images.ts` 가 만들어
`src/site/image-data.ts` 로 쓴다. 홈 사진(히어로 등, Unsplash)은 `pnpm gen:photos` — `assets/site/photos/*.webp`(출처 `ATTRIBUTION.md`)를
`src/site/photo-data.ts` 로 쓴다(Chrome 없음). 가짜 API 시나리오 `landing`(예시 조직 Example Labs · `*.example` 상대 — 실명 없음)으로 콘솔 개요를 띄우고,
브라우저 시계를 `LANDING_NOW` 에 멈춰 "n분 전" 이 매번 같다. 미리보기는 그 프로세스 안에서 빈 포트 짝으로 띄우므로 4173·4174 에 떠 있는
다른 미리보기와 부딪히지 않는다. Chrome 을 쓰므로 여러 작업자가 있으면 잠금(`ui-shots.lock`)을 먼저 잡는다. 콘솔 개요 화면이나 홈 헤드라인이
눈에 띄게 바뀌면 다시 돌려 커밋한다. Chrome·CDP 공용 조각은 `browser.ts`(import 만으로는 아무것도 띄우지 않는다).

## 사용자 문서 미리보기·스크린샷 — `pnpm ui:docs` · `pnpm gen:docs-shots`

- `pnpm ui:docs` — 문서 사이트(`docs.atmark.ai`)를 `http://127.0.0.1:4175/` 에 띄운다(`scripts/ui/docs-preview.ts`). 진짜 핸들러(`src/docs/http.ts`)를
  부르되 원문은 디스크의 `src/docs/content/**` 에서 요청마다 다시 읽는다(작성 중 저장 → 새로 고침). 깨진 링크는 터미널에 찍는다.
- `pnpm gen:docs-shots` — 문서에 싣는 콘솔 스크린샷(`src/docs/shots.ts` 등록부)을 가짜 API 시나리오 `docs`(예시 조직 · 발급 값은 토큰 모양이 아닌 예시 글자)로
  찍어 `src/docs/generated/shots.ts` 에 쓴다. `gen:images` 처럼 이 프로세스 안에서 빈 포트로 미리보기를 띄우고, Chrome 을 쓰므로 `ui-shots.lock` 을 먼저 잡는다.
  절차 전체는 `docs/runbooks/docs.md` §4.
