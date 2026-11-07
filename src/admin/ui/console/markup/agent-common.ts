/**
 * src/admin/ui/console/markup/agent-common.ts — 채널 공통 컴포넌트 `dirPanel(channel, dir)`(§2.4 이메일 · §R-5).
 *
 * 한 채널 화면은 두 열(발신 | 수신)이고, 두 열은 **같은 모양**이다: 열 제목(H2 + ⓘ) → 네 모드 세그먼트(네이티브 라디오 — 글자 번호 없음, R10) →
 * 고른 모드의 한 줄 → 지금 모드에서 쓰는 목록 → "쓰지 않는 목록"(접힘) → 채널 전용 칸 → 되돌리기·저장(카드 푸터). 열마다 **따로 저장**한다
 * (`PATCH /policy {outbound}` 또는 `{inbound}` — 서버가 한쪽만 받는다). 새 채널을 붙일 때 채널마다 다른 것은 목록 값 검증기(스크립트
 * `ruleOk`)와 채널 전용 칸(`extra`)뿐이다.
 */

import { icon, P, tip } from '../kit';

const MODE_KEYS = ['all', 'allowlist', 'blocklist', 'none'] as const;
type ModeKey = (typeof MODE_KEYS)[number];
const MODE_TITLE: Record<ModeKey, string> = { all: '전체', allowlist: '허용 목록', blocklist: '차단 목록', none: '모두 막기' };

/** 모드 ⓘ 의 `<dl>` — 모드마다 긴 설명(원문 키 그대로). */
export function modeTipList(desc: Record<ModeKey, string>): string {
  return `<dl>${MODE_KEYS.map((m) => `<dt>${MODE_TITLE[m]}</dt><dd>${desc[m]}</dd>`).join('')}</dl>`;
}

export const RULE_NOTE = P(
  '주소는 대소문자를 가리지 않습니다. 허용은 +태그까지 정확히 일치해야 하고, 차단은 +태그를 떼고 비교합니다. <code>example.com</code>은 그 도메인만, <code>*.example.com</code>은 하위 도메인만입니다. 둘 다 원하면 두 줄을 넣습니다. 목록마다 최대 1000개.',
);
export const LIST_SWITCH = P('현재 모드에서 쓰이지 않는 목록도 모드를 바꾸면 적용됩니다.');

type Dir = 'outbound' | 'inbound';
const PFX: Record<Dir, 'o' | 'i'> = { outbound: 'o', inbound: 'i' };

/**
 * 허용·차단 목록 한 칸. 스크립트가 모드에 따라 "쓰는 목록" 자리와 "쓰지 않는 목록"(접힘) 자리 사이로 옮긴다. 추가는 머리의 `추가` →
 * 대화상자 하나(`DLG_RULE` — 네 목록이 같이 쓴다, 2026-09-29 진윤겸: 인라인 입력 칸은 너무 쉽게 넣는다) · 행 삭제는 확인 대화상자.
 */
function ruleList(p: 'o' | 'i', list: 'allow' | 'block', body: string): string {
  const title = list === 'allow' ? '허용 목록' : '차단 목록';
  const label = list === 'allow' ? '허용 목록 설명' : '차단 목록 설명';
  const add = list === 'allow' ? '허용 목록에 추가' : '차단 목록에 추가';
  return (
    `<div class="lst" id="${p}-${list}-box"><div class="lh"><div class="hrow"><h3>${title}</h3>${tip(`${p}-${list}`, label, body)}</div>` +
    `<div class="lh-r"><span class="num lcount" id="${p}-${list}-n">0</span>` +
    // 정책을 받기 전에는 잠긴다(스크립트 `renderList` — 머리는 fieldset 밖이라 ⓘ 가 늘 열린다).
    `<button type="button" class="btn sm ghost addbtn" id="${p}-${list}-add" aria-haspopup="dialog" aria-label="${add}" disabled>${icon('plus')}<span>추가</span></button></div></div>` +
    // 잠금(정책을 받기 전)은 행 삭제만 — 제목의 ⓘ 는 늘 열린다(리뷰: fieldset 이 설명까지 잠갔다).
    `<fieldset class="dirfs" id="${p}-${list}-fs" disabled>` +
    `<p class="msg" id="${p}-${list}-msg" role="status"></p>` +
    `<ul class="rules" id="${p}-${list}-list"></ul><div class="empty" id="${p}-${list}-empty" hidden><p id="${p}-${list}-empty-t">항목이 없습니다.</p></div></fieldset></div>`
  );
}

/**
 * 목록 항목 추가 대화상자 — 네 목록(발신·수신 × 허용·차단)이 같이 쓴다. 제목·머리말은 연 목록에 맞춰 스크립트가 쓴다(`ruleOpen`).
 * 모양 오류는 입력 칸 바로 아래(`fieldErr`), 서버 오류는 대화상자 안 한 줄.
 */
export const DLG_RULE =
  '<dialog id="dlg-rule" aria-labelledby="rl-title"><form id="rl-form" novalidate>' +
  '<div class="dh"><h3 id="rl-title"></h3></div>' +
  '<div class="db">' +
  '<label class="field" for="rl-in"><span>주소 또는 도메인</span>' +
  '<input type="text" id="rl-in" maxlength="254" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="name@example.com · example.com">' +
  '<small><code>*.example.com</code>은 하위 도메인만입니다.</small></label>' +
  '<p class="small muted">추가하면 새 정책 버전이 생기고 즉시 적용됩니다.</p>' +
  '<p class="msg" id="rl-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="rl-cancel">취소</button><button type="submit" class="btn" id="rl-go">추가</button></div>' +
  '</form></dialog>';

interface ChannelDir {
  /** 열 제목(H2) — `발신` / `수신`. 질문형 제목은 쓰지 않는다(R9). */
  readonly title: string;
  /** 모드 세그먼트의 숨은 legend(스크린리더용). */
  readonly legend: string;
  readonly tipLabel: string;
  readonly tipBody: string;
  readonly allowTip: string;
  readonly blockTip: string;
  /** 모드 한 줄 아래의 경고 상자들(한 줄 굵은 제목 — R4). */
  readonly warn: string;
  /** 채널 전용 칸(이메일: 발신 = 한도, 수신 = 신뢰 표시). */
  readonly extra: string;
  /** 모드마다 한 줄 — 좁은 화면의 세로 목록에서 각 선택지 아래에 보인다(F64). 넓은 화면은 고른 모드의 한 줄(`.mline`)만. */
  readonly modeLine: Record<ModeKey, string>;
}

/** 채널 방향 한 열. 라디오 이름·id 는 v3 와 같다(`o-mode` · `om-all-i` …) — 모드 저장 흐름과 테스트가 그대로 산다. */
export function dirPanel(channel: string, dir: Dir, d: ChannelDir): string {
  const p = PFX[dir];
  return (
    `<section class="dirp" id="col-${dir}" data-channel="${channel}" aria-labelledby="h-${p}-col">` +
    `<div class="sh"><div class="hrow"><h2 id="h-${p}-col">${d.title}</h2>${tip(dir === 'outbound' ? 'out-mode' : 'in-mode', d.tipLabel, d.tipBody)}</div></div>` +
    // 정책을 받기 전(로딩·권한 오류)에는 모드·목록 입력·저장만 잠긴다(비평 R7-02) — ⓘ·경고·채널 전용 칸(한도·신뢰 표시)은 밖이라
    // 정책 GET 이 실패해도 설명은 열린다(리뷰). 잠금 칸 넷: `${p}-fs`(모드) · `${p}-allow-fs` · `${p}-block-fs` · `${p}-save-fs`.
    `<fieldset class="dirfs" id="${p}-fs" disabled>` +
    `<fieldset class="modes-f"><legend class="sr">${d.legend}</legend><div class="mseg" id="${p}-modes" role="radiogroup" aria-labelledby="h-${p}-col">` +
    MODE_KEYS.map(
      (m) =>
        `<label class="mopt${m === 'none' ? ' m-none' : ''}" id="${p}m-${m}" for="${p}m-${m}-i">` +
        `<input type="radio" name="${p}-mode" value="${m}" id="${p}m-${m}-i"><span class="t">${MODE_TITLE[m]}</span><span class="cur">현재</span><span class="md">${d.modeLine[m]}</span></label>`,
    ).join('') +
    '</div></fieldset></fieldset>' +
    `<p class="mline" id="${p}-mline"></p>` +
    d.warn +
    `<div class="lists" id="${p}-lists">${ruleList(p, 'allow', d.allowTip)}${ruleList(p, 'block', d.blockTip)}</div>` +
    `<details class="unused" id="${p}-unused" hidden><summary id="${p}-unused-s"></summary><div class="lists" id="${p}-unused-b"></div></details>` +
    d.extra +
    `<p class="msg" id="${p}-msg" role="status"></p>` +
    `<fieldset class="dirfs" id="${p}-save-fs" disabled><div class="savebar" id="${p}-save"><span id="${p}-change"></span>${p === 'o' ? '<span class="small muted num" id="ol-ver"></span>' : ''}<span class="grow"></span>` +
    `<button type="button" class="btn ghost sm" id="${p}-cancel" disabled>되돌리기</button><button type="button" class="btn sm" id="${p}-go" disabled>저장</button></div></fieldset>` +
    '</section>'
  );
}
