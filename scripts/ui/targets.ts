/**
 * scripts/ui/targets.ts — `pnpm ui:shots` 가 찍는 화면 목록. 여기만 고치면 화면이 늘거나 준다(`shots.ts` 는 이 배열을 돌 뿐).
 *
 *   - `console` 대상은 `preview.ts` 의 콘솔(4173)을 `path`(해시 라우트 포함, `src/admin/ui/console/router.ts`)로 연다.
 *     언어는 CLI `--langs`(기본 `ko`)를 그대로 따른다(쿼리 `?lang=`). 필요하면 `widths` 로 이 대상만 너비를 좁힌다
 *     (모바일 메뉴처럼 그 너비에서만 뜻이 있는 것).
 *   - `site` 대상은 홈(4174)을 연다. 언어는 홈이 **경로로만** 정하므로(`src/site/http.ts`) 대상마다 `lang` 을 고정하고
 *     `--langs` 는 적용하지 않는다(같은 URL 이 늘 같은 문서).
 *   - `steps` — 화면을 연 뒤 더 누르는 것(열린 상태를 찍을 때). `click` 은 `document.querySelector` shot 결과를 클릭
 *     한다(못 찾으면 조용히 지나간다 — 화면마다 있는 요소가 아닐 수 있어서다). `key` 는 키 하나(Esc 등). `wait` 는 그냥 대기.
 *     아이디는 실제 마크업에서 그대로 가져왔다(`src/admin/ui/console/markup/*.ts`) — 마크업이 바뀌면 여기도 고친다.
 */

export type WidthName =
  | 'desktop' | 'tablet' | 'mobile'
  // 8회전 반응형 — 경계값 직전·직후(명세 §4.6·§5)와 가로 모드 폰·확대 200%. 기본 목록(ALL_WIDTHS)에는 넣지 않는다 — `--widths w1149,w1150` 처럼 골라 쓴다.
  | 'w1280' | 'w1279' | 'w1150' | 'w1149' | 'w1024' | 'w960' | 'w959' | 'w768' | 'w767' | 'w720' | 'w600' | 'w375' | 'w360' | 'land';

export interface WidthSpec {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

/** 지시서의 세 너비 — 배율은 전부 1(파일 크기를 작게 유지). */
export const WIDTHS: Readonly<Record<WidthName, WidthSpec>> = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 834, height: 1112, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
  w1280: { width: 1280, height: 800, mobile: false },
  w1279: { width: 1279, height: 800, mobile: false },
  w1150: { width: 1150, height: 800, mobile: false },
  w1149: { width: 1149, height: 800, mobile: false },
  w1024: { width: 1024, height: 768, mobile: false },
  w960: { width: 960, height: 800, mobile: false },
  w959: { width: 959, height: 800, mobile: false },
  w768: { width: 768, height: 1024, mobile: false },
  w767: { width: 767, height: 1024, mobile: false },
  /** 1440 창을 200% 확대한 것과 같은 CSS 폭(글자·레이아웃 전부 2배 = 뷰포트 절반). */
  w720: { width: 720, height: 450, mobile: false },
  w600: { width: 600, height: 960, mobile: true },
  w375: { width: 375, height: 812, mobile: true },
  w360: { width: 360, height: 780, mobile: true },
  /** 가로 모드 폰(844×390). */
  land: { width: 844, height: 390, mobile: true },
};

export const ALL_WIDTHS: readonly WidthName[] = ['desktop', 'tablet', 'mobile'];

export type ThemeName = 'light' | 'dark';
export const ALL_THEMES: readonly ThemeName[] = ['light', 'dark'];

export type LangName = 'ko' | 'en';

export interface Step {
  /** 이 CSS 선택자에 걸리는 첫 요소를 누른다(`Element.click()` — 진짜 클릭 이벤트를 낸다). */
  readonly click?: string;
  /** 키를 누른다 — "Tab" · "Shift+Tab" · "Tab*5"(반복) · "Escape" · "Enter" · "Space" · "ArrowDown" 등(shots.ts runStep). */
  readonly key?: string;
  /** 그냥 이만큼(ms) 기다린다. */
  readonly wait?: number;
  /** 포커스된 칸에 이 글자를 넣는다(`Input.insertText` — 대화상자의 입력 칸을 채운 뒤 제출한 상태를 찍을 때). */
  readonly type?: string;
  /** `[선택자, 값]` — 그 `<select>` 의 값을 바꾸고 change 를 낸다(헤드리스에서 목록을 열어 고를 수 없어서). */
  readonly select?: readonly [string, string];
  /** 이 스텝 뒤 대기(ms) — 기본 200. */
  readonly waitAfter?: number;
}

export interface Target {
  readonly id: string;
  readonly kind: 'console' | 'site';
  /** 콘솔은 `/app#/...` 같은 경로(+해시), 사이트는 `/`·`/kr/pricing` 같은 경로(영어가 기본 — 한국어는 `/kr`). */
  readonly path: string;
  /** 사이트 대상만 — 이 대상의 고정 언어(`--langs` 를 타지 않는다). */
  readonly lang?: LangName;
  readonly steps?: readonly Step[];
  /** 기본 너비 목록(`--widths`) 대신 이 대상만 쓸 목록. */
  readonly widths?: readonly WidthName[];
}

export const TARGETS: readonly Target[] = [
  // --- 고객 도메인 M4(ADR-0014 단계 4) — `--only m4-`. 시나리오 `dom-*` · 한 개 보기 id 는 scripts/ui/fake-domains.ts.
  { id: 'm4-domains-list', kind: 'console', path: '/app#/domains' },
  { id: 'm4-domains-none', kind: 'console', path: '/app?_scn=dom-none#/domains' },
  // AI 의심 메일 감시(ADR-0017) — 설정 칸 넷(꺼짐 · 켜짐 · 잠김 · 관리자) · 수신 로그(상태별 표시) · 상세(flagged · skipped).
  { id: 'aw-settings-off', kind: 'console', path: '/app#/watch/ai' },
  { id: 'aw-settings-on', kind: 'console', path: '/app?_scn=aw-on#/watch/ai' },
  { id: 'aw-settings-locked', kind: 'console', path: '/app?_scn=aw-locked#/watch/ai' },
  { id: 'aw-settings-admin', kind: 'console', path: '/app?_scn=aw-admin#/watch/ai' },
  // 감시 탭(2026-10-08) — `--only watch-`. 섹션 여섯 · 대화상자 셋(풀어 주기 확인 · 에이전트별 설정 · 신뢰 발신자 추가 + 공용 메일 도메인 거절) · 멤버(읽기 전용).
  { id: 'watch-held', kind: 'console', path: '/app#/watch/held' },
  { id: 'watch-held-release', kind: 'console', path: '/app#/watch/held', steps: [{ click: '#hm-body tr:first-child td.act button', waitAfter: 400 }] },
  { id: 'watch-held-member', kind: 'console', path: '/app?_scn=member#/watch/held' },
  { id: 'watch-trusted', kind: 'console', path: '/app#/watch/trusted' },
  { id: 'watch-trusted-add', kind: 'console', path: '/app#/watch/trusted', steps: [{ click: '#wt-add', waitAfter: 300 }, { type: 'naver.com' }, { click: '#wt-ack' }, { click: '#wt-go', waitAfter: 400 }] },
  { id: 'watch-ai', kind: 'console', path: '/app#/watch/ai' },
  { id: 'watch-agents', kind: 'console', path: '/app#/watch/agents' },
  { id: 'watch-agents-edit', kind: 'console', path: '/app#/watch/agents', steps: [{ click: '#pa-body tr:first-child td.act button', waitAfter: 400 }] },
  { id: 'watch-signups', kind: 'console', path: '/app#/watch/signups' },
  { id: 'watch-enroll', kind: 'console', path: '/app#/watch/enroll' },
  { id: 'aw-inbound', kind: 'console', path: '/app#/logs/inbound' },
  { id: 'aw-inbound-flagged', kind: 'console', path: '/app#/logs/inbound/aw-0' },
  { id: 'aw-inbound-skipped', kind: 'console', path: '/app#/logs/inbound/aw-3' },
  { id: 'm4-domains-locked', kind: 'console', path: '/app?_scn=dom-off#/domains' },
  { id: 'm4-domains-closed', kind: 'console', path: '/app?_scn=dom-closed#/domains' },
  { id: 'm4-domains-limit', kind: 'console', path: '/app?_scn=dom-limit#/domains' },
  { id: 'm4-dom-pending', kind: 'console', path: '/app#/domains/pending' },
  { id: 'm4-dom-pending-mail', kind: 'console', path: '/app#/domains/pending-mail' },
  { id: 'm4-dom-pending-taken', kind: 'console', path: '/app#/domains/pending-taken' },
  { id: 'm4-dom-pending-late', kind: 'console', path: '/app#/domains/pending-late' },
  { id: 'm4-dom-verifying', kind: 'console', path: '/app#/domains/verifying' },
  { id: 'm4-dom-verifying-dkim', kind: 'console', path: '/app#/domains/verifying-dkim' },
  { id: 'm4-dom-verified', kind: 'console', path: '/app#/domains/verified' },
  { id: 'm4-dom-ready', kind: 'console', path: '/app#/domains/ready' },
  { id: 'm4-dom-susp-ownership', kind: 'console', path: '/app#/domains/susp-ownership' },
  { id: 'm4-dom-susp-dkim', kind: 'console', path: '/app#/domains/susp-dkim' },
  { id: 'm4-dom-susp-reputation', kind: 'console', path: '/app#/domains/susp-reputation' },
  { id: 'm4-dom-susp-operator', kind: 'console', path: '/app#/domains/susp-operator' },
  { id: 'm4-dom-susp-plan', kind: 'console', path: '/app#/domains/susp-plan' },
  { id: 'm4-dom-removed', kind: 'console', path: '/app#/domains/removed' },
  // 한 번에 설정(2026-10 one-shot) — 확인 대기도 레코드 전부 · DKIM 토큰 전 "준비 중" · Domain Connect 단추 · 업체에서 돌아오기.
  { id: 'm4-dom-pending-prep', kind: 'console', path: '/app#/domains/pending-prep' },
  { id: 'm4-dom-preparing', kind: 'console', path: '/app?_scn=dom-preparing#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'desk.lumen.example' }, { click: '#dad-go', waitAfter: 400 }] },
  { id: 'm4-dom-dc', kind: 'console', path: '/app#/domains/pending-dc' },
  { id: 'm4-dom-dc-back', kind: 'console', path: '/app?dc=1&d=pending-dc#/domains' },
  { id: 'm4-dom-check-cooldown', kind: 'console', path: '/app#/domains/verifying-dkim', steps: [{ click: '#dd-check', waitAfter: 700 }] },
  { id: 'm4-dom-copy-tip', kind: 'console', path: '/app#/domains/pending', steps: [{ click: '#tipb-dd-mail', waitAfter: 400 }] },
  { id: 'm4-dom-add-open', kind: 'console', path: '/app?_scn=dom-errors#/domains', steps: [{ click: '#dm-add', waitAfter: 400 }] },
  { id: 'm4-dom-add-apex', kind: 'console', path: '/app?_scn=dom-errors#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'example.com' }, { click: '#dad-go', waitAfter: 600 }] },
  { id: 'm4-dom-add-idn', kind: 'console', path: '/app?_scn=dom-errors#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'xn--bcher-kva.example.com' }, { click: '#dad-go', waitAfter: 600 }] },
  { id: 'm4-dom-add-shared', kind: 'console', path: '/app?_scn=dom-errors#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'agents.gmail.com' }, { click: '#dad-go', waitAfter: 600 }] },
  { id: 'm4-dom-add-limit', kind: 'console', path: '/app?_scn=dom-errors#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'limit.example.com' }, { click: '#dad-go', waitAfter: 600 }] },
  { id: 'm4-dom-add-ok', kind: 'console', path: '/app#/domains', steps: [{ click: '#dm-add', waitAfter: 300 }, { type: 'agents.lumen.example' }, { click: '#dad-go', waitAfter: 900 }] },
  { id: 'm4-dom-remove-open', kind: 'console', path: '/app#/domains/ready', steps: [{ click: '#dd-remove', waitAfter: 400 }] },
  { id: 'm4-dom-remove-tick', kind: 'console', path: '/app#/domains/ready', steps: [{ click: '#dd-remove', waitAfter: 300 }, { click: '#dr-release', waitAfter: 200 }] },
  { id: 'm4-agent-create', kind: 'console', path: '/app?_scn=dom-create#/agents', steps: [{ click: '#na-open', waitAfter: 600 }] },
  { id: 'm4-agent-create-custom', kind: 'console', path: '/app?_scn=dom-create#/agents', steps: [{ click: '#na-open', waitAfter: 600 }, { select: ['#na-dom', 'agents.example.com'] }] },
  { id: 'm4-addr-default', kind: 'console', path: '/app#/agents/a1/addresses' },
  { id: 'm4-addr-alias-dlg', kind: 'console', path: '/app#/agents/a1/addresses', steps: [{ click: '#al-add', waitAfter: 400 }, { select: ['#al-dom', 'agents.example.com'] }] },
  { id: 'm4-addr-set-primary', kind: 'console', path: '/app#/agents/a1/addresses', steps: [{ click: '#al-list .btn', waitAfter: 400 }] },
  { id: 'm4-addr-primary-domain', kind: 'console', path: '/app?_scn=dom-primary#/agents/a1/addresses' },
  { id: 'm4-addr-noaddr', kind: 'console', path: '/app?_scn=dom-noaddr#/agents/a1/addresses' },
  { id: 'm4-addr-noaddr-bare', kind: 'console', path: '/app?_scn=dom-noaddr-bare#/agents/a1/addresses' },
  { id: 'm4-addr-wake', kind: 'console', path: '/app?_scn=dom-noaddr#/agents/a1/addresses', steps: [{ click: '#al-wake', waitAfter: 400 }] },
  { id: 'm4-agents-noaddr', kind: 'console', path: '/app?_scn=dom-noaddr#/agents' },
  // --- 게이트 B(2026-10-01) — `--only gb-`: 홈 히어로 새 문구 · FAQ(열림) · 꼬리 고지, 남용 신고, 변경 내역.
  { id: 'gb-s-home-en', kind: 'site', path: '/?hl=en', lang: 'en' },
  { id: 'gb-s-home-ko', kind: 'site', path: '/kr', lang: 'ko' },
  { id: 'gb-s-faq-en', kind: 'site', path: '/?hl=en', lang: 'en', steps: [{ click: '.faq details:last-child summary' }] },
  { id: 'gb-s-abuse-en', kind: 'site', path: '/abuse?hl=en', lang: 'en' },
  { id: 'gb-s-abuse-ko', kind: 'site', path: '/kr/abuse', lang: 'ko' },
  { id: 'gb-s-changelog-en', kind: 'site', path: '/changelog?hl=en', lang: 'en' },
  { id: 'gb-s-changelog-ko', kind: 'site', path: '/kr/changelog', lang: 'ko' },
  // --- 10회전 Vercel 닮음·고유성 — `--only r10-`. 상태가 다른 에이전트(준비 중 a2 · 정지 a3)의 ID 카드·위험 카드, 설정 긴급 정지 카드.
  { id: 'r10-c-agent-a2', kind: 'console', path: '/app#/agents/a2' },
  { id: 'r10-c-agent-a3', kind: 'console', path: '/app#/agents/a3' },
  { id: 'r10-c-settings-pause', kind: 'console', path: '/app#/settings/pause' },
  { id: 'r10-c-org-switcher-tablet', kind: 'console', path: '/app#/agents/a1/identity', steps: [{ click: '#sw-org' }], widths: ['tablet', 'desktop'] },
  // 위 샷에서 메뉴가 반투명·카드 아래로 찍혔다 — 애니메이션 도중인지(대기 800ms) 층 순서 문제인지 가른다.
  { id: 'r10-d-org-switcher-wait', kind: 'console', path: '/app#/agents/a1/identity', steps: [{ click: '#sw-org', waitAfter: 900 }], widths: ['tablet', 'desktop'] },
  { id: 'r10-e-org-sw-agent', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#sw-org', waitAfter: 900 }], widths: ['desktop'] },
  { id: 'r10-e-org-sw-tokens', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#sw-org', waitAfter: 900 }], widths: ['desktop'] },
  { id: 'r10-e-org-sw-settings', kind: 'console', path: '/app#/settings', steps: [{ click: '#sw-org', waitAfter: 900 }], widths: ['desktop'] },
  { id: 'r10-d-ag-switcher-wait', kind: 'console', path: '/app#/agents/a1/identity', steps: [{ click: '#sw-ag', waitAfter: 900 }], widths: ['desktop'] },
  // --- 9회전 다크·언어 동등 — `--only r9-` 로 찍는다. 테마 전환·유지는 localStorage 를 남기므로 순서가 뜻이다:
  // t1 설정에서 다크를 누른다 → t2 새 문서(다른 화면)가 다크로 뜨는가 → t3 계정 메뉴(사이드바 왼쪽 아래)의 테마 칸에서 라이트 → t4 로그인 화면이 라이트인가 → t9 시스템으로 되돌림.
  // 계정 블록은 ≤1149 에서 서랍·겹침 패널 안이라 `#menu-btn` 을 먼저 누른다(≥1150 에서는 보이지 않아 건너뛴다).
  { id: 'r9-t1-set-dark', kind: 'console', path: '/app#/settings', steps: [{ click: '#th-dark' }, { wait: 300 }] },
  { id: 'r9-t2-persist-agent', kind: 'console', path: '/app#/agents/a1/identity' },
  { id: 'r9-t3-set-light', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }, { click: '#acct-btn' }, { click: '#sbt-light' }, { wait: 300 }] },
  { id: 'r9-t4-persist-login', kind: 'console', path: '/' },
  { id: 'r9-t9-reset', kind: 'console', path: '/app#/overview', steps: [{ click: '#menu-btn' }, { click: '#acct-btn' }, { click: '#sbt-system' }, { wait: 300 }] },
  // 열린 상태 — 다크에서 떠 있는 면(메뉴·ⓘ·시트)과 배경막이 보이는지, 영어에서 넘치는지.
  { id: 'r9-c-tip-overview', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '.tip-btn' }] },
  // 9회전 수정 확인 — 위험 카드 안 ⓘ(카드가 자르지 않는지, R9-01) · 설정 긴급 정지 ⓘ.
  { id: 'r9-c-tip-danger', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#tipb-danger' }] },
  { id: 'r9-c-tip-pause', kind: 'console', path: '/app#/settings/pause', steps: [{ click: '#tipb-pause' }] },
  { id: 'r9-c-tip-settings', kind: 'console', path: '/app#/settings', steps: [{ click: '#s-tlog .tip-btn' }] },
  { id: 'r9-c-row-menu', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#tk-body button[aria-haspopup="menu"]' }] },
  { id: 'r9-c-agent-sheet', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#sw-ag' }], widths: ['mobile'] },
  { id: 'r9-c-drawer-agent', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }], widths: ['mobile'] },
  { id: 'r9-s-terms-en', kind: 'site', path: '/terms', lang: 'en' },
  { id: 'r9-s-refund-en', kind: 'site', path: '/refund', lang: 'en' },
  { id: 'r9-s-pay-info-en', kind: 'site', path: '/?_host=pay.atmark.ai', lang: 'en' },
  // --- 8회전 반응형 — `--only r8-` 로 경계 폭(w1280·w1150·w1149·w1024·w768·w767·w600·w375·w360·land·w720)을 골라 찍는다.
  // 너비가 고정된 열린 상태는 그 경계 양쪽만. 레일 대상은 localStorage 를 남기므로 r8-z-unrail 로 되돌린다(배열 맨 앞 — 기본 대상의 펼침 상태 유지).
  { id: 'r8-c-overview', kind: 'console', path: '/app#/overview' },
  { id: 'r8-c-agents', kind: 'console', path: '/app#/agents' },
  { id: 'r8-c-agent', kind: 'console', path: '/app#/agents/a1' },
  { id: 'r8-c-email', kind: 'console', path: '/app#/agents/a1/email' },
  { id: 'r8-c-identity', kind: 'console', path: '/app#/agents/a1/identity' },
  { id: 'r8-c-tokens', kind: 'console', path: '/app#/agents/a1/tokens' },
  { id: 'r8-c-logs', kind: 'console', path: '/app#/logs' },
  { id: 'r8-c-settings', kind: 'console', path: '/app#/settings' },
  { id: 'r8-c-connect', kind: 'console', path: '/app#/agents/a1/connect' },
  { id: 'r8-o-overlay', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }], widths: ['w1149', 'w1024', 'w768'] },
  { id: 'r8-o-drawer', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }], widths: ['w767', 'w360', 'land'] },
  { id: 'r8-o-sheet', kind: 'console', path: '/app#/overview', steps: [{ click: '#sw-org' }], widths: ['w767', 'w360', 'land'] },
  { id: 'r8-o-acct', kind: 'console', path: '/app#/overview', steps: [{ click: '#menu-btn' }, { click: '#acct-btn' }], widths: ['w1149', 'w1150'] },
  { id: 'r8-o-dialog', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#dz-kill' }], widths: ['land', 'w360', 'w720'] },
  { id: 'r8-o-newagent', kind: 'console', path: '/app#/agents', steps: [{ click: '#na-open' }], widths: ['land', 'w360', 'w720'] },
  { id: 'r8-z-rail', kind: 'console', path: '/app#/agents/a1', steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { wait: 300 }], widths: ['w1150', 'w1280'] },
  { id: 'r8-z-rail-email', kind: 'console', path: '/app#/agents/a1/email', steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { wait: 300 }], widths: ['w1280'] },
  // 낮은 화면(844x390)의 레일 — 목록은 스크롤 상자인데 툴팁이 그 밖에 그려지는지(R8-03, 앵커 위치 지정).
  { id: 'r8-z-rail-tip-low', kind: 'console', path: '/app#/agents/a1', steps: [{ key: 'Tab*7' }], widths: ['land'] },
  { id: 'r8-z-unrail', kind: 'console', path: '/app#/overview', steps: [{ click: 'html[data-side="rail"] #side-toggle' }, { wait: 300 }], widths: ['w1150'] },
  { id: 'r8-s-home-ko', kind: 'site', path: '/kr', lang: 'ko' },
  // SEO·AEO — 홈 FAQ 첫 질문을 펼친 모습(`<details>`, 스크립트 없음).
  { id: 'seo-s-faq-open-ko', kind: 'site', path: '/kr', lang: 'ko', steps: [{ click: '.faq summary' }] },
  { id: 'seo-s-faq-open-en', kind: 'site', path: '/', lang: 'en', steps: [{ click: '.faq summary' }] },
  { id: 'r8-s-home-en', kind: 'site', path: '/', lang: 'en' },
  { id: 'r8-s-pricing-ko', kind: 'site', path: '/kr/pricing', lang: 'ko' },
  { id: 'r8-s-pricing-en', kind: 'site', path: '/pricing', lang: 'en' },
  { id: 'r8-s-terms-ko', kind: 'site', path: '/kr/terms', lang: 'ko' },
  { id: 'r8-s-signup-en', kind: 'site', path: '/signup', lang: 'en' },
  { id: 'r8-s-menu-ko', kind: 'site', path: '/kr', lang: 'ko', steps: [{ click: '.mnav-b' }], widths: ['w767', 'w360', 'land'] },
  { id: 'r8-s-menu-en', kind: 'site', path: '/', lang: 'en', steps: [{ click: '.mnav-b' }], widths: ['w767', 'land'] },

  // --- 콘솔: 조직 스코프 ---
  { id: 'console-overview', kind: 'console', path: '/app#/overview' },
  { id: 'console-agents', kind: 'console', path: '/app#/agents' },
  // 만들고 바꾸는 흐름은 전부 라이트박스(2026-09-30) — 새 에이전트는 목록 · 개요 · 스위처 어디서 눌러도 같은 `dlg-newagent`.
  { id: 'console-agents-new-open', kind: 'console', path: '/app#/agents', steps: [{ click: '#na-open', waitAfter: 300 }] },
  { id: 'console-overview-new-open', kind: 'console', path: '/app#/overview', steps: [{ click: '#ov-new', waitAfter: 300 }] },
  { id: 'console-switcher-new-open', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#sw-ag' }, { click: '#swa-new', waitAfter: 300 }] },
  { id: 'console-settings', kind: 'console', path: '/app#/settings' },
  { id: 'console-settings-members', kind: 'console', path: '/app#/settings/members' },
  { id: 'console-settings-members-invite-open', kind: 'console', path: '/app#/settings/members', steps: [{ click: '#mb-invite' }] },
  { id: 'console-settings-keys', kind: 'console', path: '/app#/settings/keys' },
  { id: 'console-settings-plan', kind: 'console', path: '/app#/settings/plan' },
  // 설정 — 섹션마다 한 화면(2026-09-27): 섹션 아홉 · GATE 펼침 · 메뉴 탭 줄(폰).
  ...['org', 'members', 'keys', 'plan', 'pause', 'aiwatch', 'tlog', 'gate', 'display', 'session'].map((s) => ({ id: `set1-${s}`, kind: 'console' as const, path: `/app#/settings/${s}` })),
  { id: 'set1-gate-open', kind: 'console', path: '/app#/settings/gate', steps: [{ click: '#g-toggle', waitAfter: 400 }] },
  // 인계 시험 시작 · 개입 기록 대화상자(개입 기록은 판정할 인계 시험이 있을 때만 열린다 — 없으면 버튼이 잠겨 펼친 화면만 찍힌다).
  { id: 'set1-gate-start-open', kind: 'console', path: '/app#/settings/gate', steps: [{ click: '#g-toggle' }, { click: '#gs-open', waitAfter: 400 }] },
  { id: 'set1-gate-iv-open', kind: 'console', path: '/app#/settings/gate', steps: [{ click: '#g-toggle' }, { click: '#iv-open', waitAfter: 400 }] },
  { id: 'console-logs', kind: 'console', path: '/app#/logs' },

  // --- 콘솔: 에이전트 스코프(a1 = founder-agent, 활성 · 신원 게시됨) ---
  { id: 'console-agent-overview', kind: 'console', path: '/app#/agents/a1' },
  // 분당 한도 `변경` → `dlg-limit`(지금 값으로 채워 연다).
  { id: 'console-agent-limit-open', kind: 'console', path: '/app#/agents/a1/email', steps: [{ click: '#ol-edit', waitAfter: 400 }] },
  { id: 'console-agent-connect', kind: 'console', path: '/app#/agents/a1/connect' },
  { id: 'console-agent-email', kind: 'console', path: '/app#/agents/a1/email' },
  { id: 'console-agent-email-inbound', kind: 'console', path: '/app#/agents/a1/email/inbound' },
  // 주소 탭(2026-09-29 — 이메일 화면에서 뺐다) · 더하기 대화상자 · 삭제 확인. `aliases` 시나리오 = 대표 + 별칭 둘.
  { id: 'console-agent-addresses', kind: 'console', path: '/app?_scn=aliases#/agents/a1/addresses' },
  { id: 'console-agent-addresses-add-open', kind: 'console', path: '/app?_scn=aliases#/agents/a1/addresses', steps: [{ click: '#al-add', waitAfter: 400 }] },
  { id: 'console-agent-addresses-delete-open', kind: 'console', path: '/app?_scn=aliases#/agents/a1/addresses', steps: [{ click: '#al-list .btn', waitAfter: 400 }] },
  { id: 'console-agent-email-rule-add-open', kind: 'console', path: '/app#/agents/a1/email', steps: [{ click: '#o-allow-add', waitAfter: 400 }] },
  { id: 'console-agent-email-sender-add-open', kind: 'console', path: '/app#/agents/a1/email/inbound', steps: [{ click: '#sn-add', waitAfter: 400 }] },
  { id: 'console-agent-logs', kind: 'console', path: '/app#/agents/a1/logs' },
  { id: 'console-agent-identity', kind: 'console', path: '/app#/agents/a1/identity' },
  // 웹훅 탭(2026-09-30) — 엔드포인트 둘(전달됨 · 실패 HTTP 503) + 전달 기록(실패 · 재시도 끝남 행) · 추가 대화상자 · 교체 확인 · 삭제 확인(빨강) ·
  // 비밀값 창(한 번만 — 교체 뒤 · 추가 뒤). 데이터는 `fake-api.ts` 의 웹훅 예시. 쓰기가 상태를 바꿀 수 있으니 비밀값 창 둘을 맨 뒤에 둔다. `--only console-agent-webhooks`.
  { id: 'console-agent-webhooks', kind: 'console', path: '/app#/agents/a1/webhooks' },
  { id: 'console-agent-webhooks-add-open', kind: 'console', path: '/app#/agents/a1/webhooks', steps: [{ click: '#wh-add', waitAfter: 400 }] },
  { id: 'console-agent-webhooks-rotate-confirm', kind: 'console', path: '/app#/agents/a1/webhooks', steps: [{ click: '#wh-body tr:first-child .more-btn' }, { click: '#wh-body tr:first-child .rowmenu .mi', waitAfter: 400 }] },
  { id: 'console-agent-webhooks-delete-confirm', kind: 'console', path: '/app#/agents/a1/webhooks', steps: [{ click: '#wh-body tr:nth-child(2) .more-btn' }, { click: '#wh-body tr:nth-child(2) .rowmenu .mi.danger', waitAfter: 400 }] },
  { id: 'console-agent-webhooks-secret-rotate', kind: 'console', path: '/app#/agents/a1/webhooks', steps: [{ click: '#wh-body tr:first-child .more-btn' }, { click: '#wh-body tr:first-child .rowmenu .mi' }, { click: '#dc-ok', waitAfter: 600 }] },
  { id: 'console-agent-webhooks-secret-new', kind: 'console', path: '/app#/agents/a1/webhooks', steps: [{ click: '#wh-add', waitAfter: 300 }, { type: 'https://hooks.example.com/atmark/new' }, { click: '#wa-go', waitAfter: 600 }] },
  { id: 'console-agent-tokens', kind: 'console', path: '/app#/agents/a1/tokens' },
  { id: 'console-agent-tokens-new-open', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#tk-new' }] },
  // 한 번만 보이는 토큰 창 — 첫 행 ⋯ → 교체(두 번째 항목) → 확인. 가짜 API 가 새 토큰을 돌려준다.
  { id: 'console-agent-token-window', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#tk-body button[aria-haspopup="menu"]' }, { click: '[role="menu"] li:nth-child(2) > [role="menuitem"]' }, { click: '#dc-ok', waitAfter: 800 }] },

  // --- 콘솔: 열린 상태(스위처 · 계정 메뉴 · ⓘ 팝오버 · 모바일 메뉴 · 대화상자) ---
  { id: 'console-org-switcher-open', kind: 'console', path: '/app#/overview', steps: [{ click: '#sw-org' }] },
  { id: 'console-agent-switcher-open', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#sw-ag' }] },
  // 계정 메뉴(2026-09-30 — 사이드바 왼쪽 아래 계정 블록, 위로 열림 · 테마·언어 칸 포함). ≤1149 는 서랍·겹침 패널을 먼저 연다.
  { id: 'console-account-menu-open', kind: 'console', path: '/app#/overview', steps: [{ click: '#menu-btn' }, { click: '#acct-btn' }] },
  // 레일로 접힌 사이드바 — 계정 블록은 아바타만, 메뉴는 오른쪽으로(태블릿은 처음부터 레일).
  { id: 'console-account-menu-rail', kind: 'console', path: '/app#/overview', steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { wait: 300 }, { click: '#acct-btn' }], widths: ['desktop'] },
  { id: 'console-account-menu-tablet-rail', kind: 'console', path: '/app#/overview', steps: [{ click: '#acct-btn' }], widths: ['tablet'] },
  { id: 'console-info-tip-open', kind: 'console', path: '/app#/agents/a1/email', steps: [{ click: '.tip-btn' }] },
  { id: 'console-mobile-nav-open', kind: 'console', path: '/app#/overview', steps: [{ click: '#menu-btn' }], widths: ['mobile'] },
  { id: 'console-dialog-open', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#dz-kill' }] },
  // 키보드 포커스 — Tab 을 몇 번 눌러 포커스 링이 보이는 상태를 찍는다(6회전 포커스·키보드).
  { id: 'console-focus-tab', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*4' }] },
  { id: 'console-focus-tab-deep', kind: 'console', path: '/app#/agents/a1/email', steps: [{ key: 'Tab*14' }] },
  // 6회전 키보드 순회 — 실제 키로 연 상태(Tab 수는 1440 펼침 사이드바 기준 순서: 건너뛰기 · 조직 · 조직 스위처 · [에이전트] · 내비 4 · 계정 블록 · 접기).
  // 서랍·겹침 패널이 열린 채 Tab 이 뒤 본문으로 새는지(가둠) · 계정 메뉴 Esc · 스위처 화살표/Esc 복귀 · 대화상자 안 순회 · 라디오 모드 링 · 한도 초과 잠긴 버튼.
  { id: 'console-kb-drawer-leak', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }, { key: 'Tab*14' }], widths: ['mobile'] },
  { id: 'console-kb-tablet-leak', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }, { key: 'Tab*15' }], widths: ['tablet'] },
  { id: 'console-kb-acct-esc', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*8' }, { key: 'Enter' }, { key: 'Escape' }], widths: ['desktop'] },
  { id: 'console-kb-acct-obscured', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*8' }, { key: 'Enter' }, { key: 'Shift+Tab' }], widths: ['desktop'] },
  { id: 'console-kb-acct-arrows', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*8' }, { key: 'ArrowDown*3' }], widths: ['desktop'] },
  { id: 'console-kb-switcher-arrows', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*2' }, { key: 'ArrowDown*2' }], widths: ['desktop', 'tablet'] },
  { id: 'console-kb-switcher-esc', kind: 'console', path: '/app#/overview', steps: [{ key: 'Tab*2' }, { key: 'ArrowDown' }, { key: 'Escape' }], widths: ['desktop'] },
  { id: 'console-kb-agent-switcher', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#sw-ag' }, { key: 'ArrowDown*2' }] },
  { id: 'console-kb-dialog', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#dz-kill' }, { key: 'Tab*2' }] },
  { id: 'console-kb-mode-radio', kind: 'console', path: '/app#/agents/a1/email', steps: [{ key: 'Tab*20' }], widths: ['desktop'] },
  { id: 'console-kb-locked', kind: 'console', path: '/app#/agents', steps: [{ key: 'Tab*13' }, { key: 'Enter' }], widths: ['desktop'] },
  { id: 'console-kb-rail-tip-tablet', kind: 'console', path: '/app#/agents/a1', steps: [{ key: 'Tab*7' }], widths: ['tablet'] },

  // 7회전 빈·로딩·오류 상태 — `?_scn=` 은 fake-api.ts `SCENARIOS`(preview.ts 가 쿠키로 옮겨 /api/* 에 적용). 없으면 기본 데이터.
  { id: 'console-st-empty-overview', kind: 'console', path: '/app?_scn=empty#/overview' },
  { id: 'console-st-empty-agents', kind: 'console', path: '/app?_scn=empty#/agents' },
  { id: 'console-st-empty-logs', kind: 'console', path: '/app?_scn=empty#/logs' },
  { id: 'console-st-empty-members', kind: 'console', path: '/app?_scn=empty#/settings/members' },
  { id: 'console-st-fresh-agent', kind: 'console', path: '/app?_scn=fresh#/agents/a1' },
  { id: 'console-st-fresh-tokens', kind: 'console', path: '/app?_scn=fresh#/agents/a1/tokens' },
  { id: 'console-st-fresh-email', kind: 'console', path: '/app?_scn=fresh#/agents/a1/email' },
  { id: 'console-st-fresh-logs', kind: 'console', path: '/app?_scn=fresh#/agents/a1/logs' },
  { id: 'console-st-slow-overview', kind: 'console', path: '/app?_scn=slow#/overview' },
  { id: 'console-st-slow-agents', kind: 'console', path: '/app?_scn=slow#/agents' },
  { id: 'console-st-slow-agent', kind: 'console', path: '/app?_scn=slow#/agents/a1' },
  { id: 'console-st-slowsub-settings', kind: 'console', path: '/app?_scn=slowsub#/settings' },
  { id: 'console-st-slowsub-tokens', kind: 'console', path: '/app?_scn=slowsub#/agents/a1/tokens' },
  { id: 'console-st-slowsub-email', kind: 'console', path: '/app?_scn=slowsub#/agents/a1/email' },
  { id: 'console-st-500-overview', kind: 'console', path: '/app?_scn=error500#/overview' },
  { id: 'console-st-500-agent', kind: 'console', path: '/app?_scn=error500#/agents/a1' },
  { id: 'console-st-sub500-overview', kind: 'console', path: '/app?_scn=sub500#/overview' },
  { id: 'console-st-sub500-agent', kind: 'console', path: '/app?_scn=sub500#/agents/a1' },
  { id: 'console-st-sub500-settings', kind: 'console', path: '/app?_scn=sub500#/settings' },
  { id: 'console-st-sub500-tokens', kind: 'console', path: '/app?_scn=sub500#/agents/a1/tokens' },
  { id: 'console-st-offline-overview', kind: 'console', path: '/app?_scn=offline#/overview' },
  { id: 'console-st-expired', kind: 'console', path: '/app?_scn=expired#/overview', steps: [{ wait: 800 }] },
  { id: 'console-st-403-settings', kind: 'console', path: '/app?_scn=forbidden#/settings' },
  { id: 'console-st-403-agent-email', kind: 'console', path: '/app?_scn=forbidden#/agents/a1/email' },
  { id: 'console-st-429-overview', kind: 'console', path: '/app?_scn=ratelimit#/overview', steps: [{ wait: 3000 }] },
  { id: 'console-st-write500-kill', kind: 'console', path: '/app?_scn=write500#/agents/a1', steps: [{ click: '#dz-kill' }, { click: '#dc-ack' }, { click: '#dc-ok', waitAfter: 800 }] },
  { id: 'console-st-write500-invite', kind: 'console', path: '/app?_scn=write500#/settings/members', steps: [{ click: '#mb-invite' }, { click: '#in-r-member' }, { click: '#in-go', waitAfter: 800 }] },
  { id: 'console-st-ok-kill', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#dz-kill' }, { click: '#dc-ack' }, { click: '#dc-ok', waitAfter: 800 }] },
  { id: 'console-st-ok-copy', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#ao-copy', waitAfter: 300 }] },
  { id: 'console-st-val-newagent', kind: 'console', path: '/app#/agents', steps: [{ click: '#na-open' }, { click: '#na-go', waitAfter: 400 }] },
  { id: 'console-st-val-invite', kind: 'console', path: '/app#/settings/members', steps: [{ click: '#mb-invite' }, { click: '#in-go', waitAfter: 400 }] },
  { id: 'console-st-val-newtoken', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#tk-new' }, { click: '#nt-go', waitAfter: 400 }] },
  { id: 'console-st-member-overview', kind: 'console', path: '/app?_scn=member#/overview' },
  { id: 'console-st-member-email', kind: 'console', path: '/app?_scn=member#/agents/a1/email' },
  { id: 'console-st-pending', kind: 'console', path: '/app?_scn=pending#/overview' },
  { id: 'console-st-rejected', kind: 'console', path: '/app?_scn=rejected#/overview' },
  { id: 'console-st-frozen', kind: 'console', path: '/app?_scn=frozen#/agents/a1' },
  { id: 'console-st-paused', kind: 'console', path: '/app?_scn=paused#/settings' },
  { id: 'console-st-over', kind: 'console', path: '/app?_scn=over#/agents' },
  { id: 'console-st-404-route', kind: 'console', path: '/app#/no-such-screen' },
  { id: 'console-st-404-agent', kind: 'console', path: '/app#/agents/zzz' },
  { id: 'console-st-token-revoke', kind: 'console', path: '/app#/agents/a1/tokens', steps: [{ click: '#tk-body button[aria-haspopup="menu"]' }, { click: '[role="menu"] li:last-child > [role="menuitem"]' }] },

  // --- 콘솔: 로그인 전 화면 ---
  { id: 'console-login', kind: 'console', path: '/' },
  { id: 'console-login-landing', kind: 'console', path: '/login' },
  { id: 'console-signup', kind: 'console', path: '/signup' },

  // --- 콘솔: 사이드바 상태(명세 §4.3) — 겹침 패널(768–1149) · 레일(≥1150, localStorage 에 남으므로 콘솔 대상 맨 끝) ---
  { id: 'console-tablet-nav-open', kind: 'console', path: '/app#/agents/a1', steps: [{ click: '#menu-btn' }], widths: ['tablet'] },
  { id: 'console-sidebar-rail', kind: 'console', path: '/app#/agents/a1', // 토글은 localStorage 에 남으므로 한 Chrome 안에서 샷마다 누르면 펼침/레일이 번갈아 찍힌다(비평 4회전에서 light·en 이 펼침으로 찍힘) —
  // 이미 레일이 아닐 때만 누른다.
  steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { wait: 300 }], widths: ['desktop'] },
  // 레일(위 대상이 남긴 localStorage 상태)에서 키보드 — 항목 포커스 때 라벨 툴팁, 아이콘뿐인 접기 버튼.
  { id: 'console-kb-rail-tip', kind: 'console', path: '/app#/agents/a1', steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { key: 'Tab*6' }], widths: ['desktop'] },
  { id: 'console-kb-rail-toggle', kind: 'console', path: '/app#/overview', steps: [{ click: 'html:not([data-side="rail"]) #side-toggle' }, { key: 'Tab*6' }], widths: ['desktop'] },

  // --- 홈(atmark.ai) ---
  { id: 'site-home-ko', kind: 'site', path: '/kr', lang: 'ko' },
  { id: 'site-home-focus-tab', kind: 'site', path: '/kr', lang: 'ko', steps: [{ key: 'Tab*3' }] },
  { id: 'site-home-en', kind: 'site', path: '/', lang: 'en' },
  // 두 겹 방어 절(2026-10-07) — 전체 페이지 샷에도 들어가지만, 좁은 폭(그림 축소 · 겹 한 줄)을 따로 본다.
  { id: 'site-home-defense-ko', kind: 'site', path: '/kr#def-title', lang: 'ko', widths: ['w375', 'w768', 'desktop'] },
  { id: 'site-home-defense-en', kind: 'site', path: '/#def-title', lang: 'en', widths: ['w375', 'desktop'] },
  { id: 'site-kb-skip-en', kind: 'site', path: '/', lang: 'en', steps: [{ key: 'Tab' }] },
  // ≡ 메뉴를 키보드로 열고 Tab — 메뉴가 열린 채 포커스가 배경막 뒤 본문으로 가는지.
  { id: 'site-kb-menu-leak', kind: 'site', path: '/kr', lang: 'ko', steps: [{ key: 'Tab*4' }, { key: 'Enter' }, { key: 'Tab*6' }], widths: ['mobile'] },
  { id: 'site-pricing-ko', kind: 'site', path: '/kr/pricing', lang: 'ko' },
  { id: 'site-pricing-en', kind: 'site', path: '/pricing', lang: 'en' },
  { id: 'site-terms-ko', kind: 'site', path: '/kr/terms', lang: 'ko' },
  { id: 'site-privacy-ko', kind: 'site', path: '/kr/privacy', lang: 'ko' },
  { id: 'site-refund-ko', kind: 'site', path: '/kr/refund', lang: 'ko' },
  { id: 'site-login-ko', kind: 'site', path: '/kr/login', lang: 'ko' },
  { id: 'site-login-en', kind: 'site', path: '/login', lang: 'en' },
  { id: 'site-signup-ko', kind: 'site', path: '/kr/signup', lang: 'ko' },
  { id: 'site-signup-en', kind: 'site', path: '/signup', lang: 'en' },
  { id: 'site-privacy-en', kind: 'site', path: '/privacy', lang: 'en' },
  { id: 'site-not-found-ko', kind: 'site', path: '/kr/no-such-page', lang: 'ko' },
  { id: 'site-not-found-en', kind: 'site', path: '/no-such-page', lang: 'en' },
  // 모바일 ≡ 메뉴(Popover API `<button popovertarget>` + `<nav popover>`, 스크립트 없음) — 767px 이하에서만 보인다.
  { id: 'site-home-ko-menu-open', kind: 'site', path: '/kr', lang: 'ko', steps: [{ click: '.mnav-b' }], widths: ['mobile'] },
  { id: 'site-home-en-menu-open', kind: 'site', path: '/', lang: 'en', steps: [{ click: '.mnav-b' }], widths: ['mobile'] },
  // pay.atmark.ai 안내 페이지(쿼리 없음 — 결제 스위치와 무관하게 200). `_host` 는 preview.ts 전용 손잡이.
  { id: 'site-pay-info-ko', kind: 'site', path: '/kr?_host=pay.atmark.ai', lang: 'ko' },
];
