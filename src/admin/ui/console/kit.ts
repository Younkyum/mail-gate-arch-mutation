/** src/admin/ui/console/kit.ts — 마크업 도구: 아이콘 · ⓘ 토글팁 · 화면·섹션 머리 · 칸. 정적 문자열만 만든다(데이터를 끼우지 않는다). */

/**
 * 단색 인라인 SVG 아이콘(`console-v3-design.md` §2.1). 색·선 굵기는 스타일시트의 `.ico` 가 준다 — `style=""` 은 CSP 가 막고,
 * `stroke`·`fill` 같은 표현 속성도 쓰지 않는다(색 테스트가 스타일시트 한 곳만 보면 되게).
 */
export const ICON_PATHS = {
  overview:
    '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  agents: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14c.6-2.6 2.7-4.25 5.25-4.25s4.65 1.65 5.25 4.25"/>',
  domains:
    '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c1.65 1.75 2.5 3.85 2.5 6.25S9.65 12.5 8 14.25M8 1.75C6.35 3.5 5.5 5.6 5.5 8s.85 4.5 2.5 6.25"/>',
  logs: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  /** 감시 — 눈(받은 메일을 지켜본다). 막는다는 뜻의 방패는 쓰지 않는다(copy-guard 와 같은 결 — 탐지는 전부를 잡지 않는다). */
  watch: '<path d="M1.75 8s2.3-4.25 6.25-4.25S14.25 8 14.25 8 11.95 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="2"/>',
  identity:
    '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><circle cx="5.5" cy="7.25" r="1.5"/><path d="M3.5 10.75c.4-1 1.1-1.5 2-1.5s1.6.5 2 1.5M9.5 6.5h3M9.5 9h3"/>',
  settings: '<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v3.75M8 5h.01"/>',
  connect: '<path d="M5 5.5h7.5l-2-2M11 10.5H3.5l2 2"/>',
  email: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="M2.25 4l5.75 4.5L13.75 4"/>',
  /** 주소(대표 + 별칭) — 꼬리표. `@` 모양은 쓰지 않는다(`@` 는 브랜드 표식 — 회색 `@` 아이콘이 그 뜻을 흐린다). */
  addresses: '<path d="M2.25 3.25v4.1c0 .27.1.52.3.7l5.4 5.4a1 1 0 0 0 1.4 0l4.1-4.1a1 1 0 0 0 0-1.4l-5.4-5.4a1 1 0 0 0-.7-.3h-4.1a1 1 0 0 0-1 1z"/><circle cx="5.25" cy="5.75" r="1"/>',
  /** 웹훅 — 세 점을 잇는 선(이벤트가 한 곳에서 다른 곳으로). */
  webhooks: '<circle cx="8" cy="3.75" r="1.75"/><circle cx="3.5" cy="11.75" r="1.75"/><circle cx="12.5" cy="11.75" r="1.75"/><path d="M7.1 5.3L4.4 10.2M8.9 5.3l2.7 4.9M5.25 11.75h5.5"/>',
  tokens: '<circle cx="5" cy="8" r="2.75"/><path d="M7.75 8h6.5M12 8v2.5M14 8v1.75"/>',
  back: '<path d="M13 8H3.5M7.5 4L3.5 8l4 4"/>',
  chev: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01"/>',
  eyeoff: '<path d="M2.5 6.5c1.5 2.2 3.4 3.3 5.5 3.3s4-1.1 5.5-3.3M4.6 9.2l-1 1.6M8 9.9v1.9M11.4 9.2l1 1.6"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/><path d="M10.75 5.25v-2a1 1 0 0 0-1-1h-6.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h2"/>',
  /** breadcrumb 스위처 · 계정 — 위아래 쉐브론(명세 §3.7). */
  updown: '<path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10"/>',
  /** 사이드바 접기·펼치기(§4.3). */
  panel: '<rect x="2" y="2.75" width="12" height="10.5" rx="1.5"/><path d="M6 2.75v10.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  /** 링크 화살표 · 바깥 링크 · 선택 표시(비평 R10-06 — 글자 기호 → ↗ ✓ 대신). 오른쪽 화살표는 사이트 `ARROW_RIGHT_ICON` 과 같은 경로. */
  arrowRight: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  arrowUpRight: '<path d="M5 11l6-6M6.5 5H11v4.5"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  /** 파일 받기 — 아래 화살표 + 받침(도메인 레코드 파일). */
  download: '<path d="M8 2.5v8M4.75 7.25L8 10.5l3.25-3.25M2.75 13.25h10.5"/>',
  /** 테마 — 시스템 · 라이트 · 다크(사이드바 도구 줄). */
  system: '<rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.75h5M8 11.25v2.5"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
  moon: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z"/>',
} as const;

export function icon(name: keyof typeof ICON_PATHS): string {
  return `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

/**
 * ⓘ 토글팁(§5) — 버튼과 팝오버를 **나란히** 낸다(팝오버는 버튼 바로 뒤 형제 · DOM 순서가 곧 읽는 순서). `label` 은 언어별 완전한
 * 문장 키(`발신 모드 설명` → `About outbound mode`)라 조립하지 않는다. `body` 는 **이 파일에 적힌 정적 문자열만** 받는다 — 데이터가
 * 들어가지 않으므로 `innerHTML` 규율에 닿지 않는다. 팝오버 안에는 링크·버튼·입력이 없다(R5 · 테스트).
 */
export function tip(id: string, label: string, body: string): string {
  return (
    `<button type="button" class="tip-btn" id="tipb-${id}" aria-expanded="false" aria-controls="tip-${id}" aria-label="${label}">${icon('info')}</button>` +
    `<div class="tip-pop" id="tip-${id}" hidden>${body}</div>`
  );
}

export const P = (text: string): string => `<p>${text}</p>`;
export const LI = (items: readonly string[]): string => `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;

/** 복사 아이콘 버튼 + 결과 한 줄(`복사됨` 을 1.5초). */
export function copyBtn(id: string, label: string): string {
  return `<button type="button" class="icon-btn" id="${id}" aria-label="${label}">${icon('copy')}</button><span class="cpd" id="${id}-st" role="status"></span>`;
}

/**
 * 화면 머리(§2.2 · 2026-10-15 UI 감사 §3.2) — `h1 [사용량 n / N muted] [ⓘ] …… [주 동작]`. 화면의 주 자원 만들기는 오른쪽 검정 `btn` 하나
 * (`{자원} 추가` — 자격 증명은 `{자원} 발급`). 보조 정보(주소 · 상태)는 h1 아래 한 줄(`sub`)로만 — h1 옆에 붙이지 않는다. 설명 줄(lede)은 두지 않는다(R1).
 */
export function viewHead(
  id: string,
  title: string,
  o: { readonly count?: string; readonly tip?: string; readonly actions?: string; readonly sub?: string } = {},
): string {
  return (
    `<header class="vh"><div class="vh-t"><div class="hrow"><h1 id="${id}" tabindex="-1">${title}</h1>${o.count ?? ''}${o.tip ?? ''}</div>` +
    (o.sub ? `<p class="vh-sub">${o.sub}</p>` : '') +
    '</div>' +
    (o.actions ? `<div class="vh-act">${o.actions}</div>` : '') +
    '</header>'
  );
}

/** 상세 화면 위 `← {부모}`(§3.2 · F38) — 도메인 하나 · 에이전트 화면이 같은 모양. */
export function backLink(id: string, href: string, label: string): string {
  return `<a class="dback" id="${id}" href="${href}">${icon('back')}<span>${label}</span></a>`;
}

/**
 * 위험 구역(§3.5 · F06 · F07) — 상세 화면 맨 아래 카드 하나, 행마다 `[제목 · 설명 · (사유 한 줄)] [빨간 외곽선 버튼]`. 카드 테두리는 빨간 버튼이
 * 보일 때만 빨갛다(스타일시트 `.dz:has(.btn.danger…)`). 행의 결과 한 줄(`.msg`)은 그 행 바로 아래.
 */
export interface DangerRow {
  readonly title: string;
  readonly titleId: string;
  readonly tip?: string;
  readonly text: string;
  readonly textId?: string;
  readonly noteId: string;
  readonly button: string;
  readonly msgId: string;
}
export function dangerZone(id: string, rows: readonly DangerRow[]): string {
  return (
    `<div class="dz" id="${id}">` +
    rows
      .map(
        (r) =>
          `<div class="dz-row"><div class="dz-t"><div class="hrow"><h2 id="${r.titleId}">${r.title}</h2>${r.tip ?? ''}</div>` +
          `<p${r.textId ? ` id="${r.textId}"` : ''}>${r.text}</p><p class="small muted" id="${r.noteId}"></p></div>${r.button}</div>` +
          `<p class="msg" id="${r.msgId}" role="status"></p>`,
      )
      .join('') +
    '</div>'
  );
}

/** 섹션 머리(§2.5) — H2 heading-16 + ⓘ · 오른쪽에 그 섹션의 동작. 번호 칸·위 2px 선은 없다. */
export function secHead(id: string, title: string, tipHtml = '', actions = ''): string {
  return `<div class="sh"><div class="hrow"><h2 id="${id}">${title}</h2>${tipHtml}</div>${actions}</div>`;
}

/** 가로 PropertyList 한 칸 — `<div><dt/><dd/></div>`. */
export function prop(label: string, id: string, cls = ''): string {
  return `<div><dt>${label}</dt><dd id="${id}"${cls ? ` class="${cls}"` : ''}>—</dd></div>`;
}

/**
 * 설정 섹션 한 화면(2026-09-27 — 섹션마다 한 화면, Vercel settings): 머리(제목 H2 + ⓘ + 한 줄 이하) → 카드(조작부 → 있으면 전체 폭 `extra` →
 * 있으면 푸터 `.sf` · 오른쪽 정렬 동작). 섹션은 처음에 숨어 있고, 라우트 `#/settings/{section}` 이 그 하나만 연다(스크립트 `showSettings`).
 * 제목은 `tabindex="-1"` — 섹션을 옮기면 포커스가 여기로 온다. 버튼 id 는 어디에 있든 그대로다.
 */
export function settingsRow(id: string, hid: string, title: string, tipHtml: string, desc: string, control: string, extra = '', footer = ''): string {
  return (
    `<section class="spane" id="${id}" aria-labelledby="${hid}" hidden><header class="sph">` +
    `<div class="hrow"><h2 id="${hid}" tabindex="-1">${title}</h2>${tipHtml}</div>` +
    (desc ? `<p class="sdesc">${desc}</p>` : '') +
    '</header><div class="srow">' +
    (control ? `<div class="sc">${control}</div>` : '') +
    extra +
    (footer ? `<div class="sf">${footer}</div>` : '') +
    '</div></section>'
  );
}

/**
 * 스켈레톤 행 — 표 tbody 의 첫 칠(비평 R7-01·R7-13): 실제 행과 같은 높이 · **열마다 짧은 회색 막대**(표 모양 그대로 — 모든 열을 가로지르는
 * 막대 하나는 실제 표와 닮지 않는다, 2026-09-27 AI 티 감사 B5). 좁은 화면(목록 행)에서는 첫 칸만 보인다. 첫 렌더가 `clear()` 로 지운다.
 */
export function skelRows(cols: number, n = 3): string {
  const row = `<tr class="skr" aria-hidden="true">${'<td><span class="skel"></span></td>'.repeat(cols)}</tr>`;
  return row.repeat(n);
}
