/**
 * src/admin/ui/console/markup/settings.ts — 설정(§2.4): 섹션마다 한 화면(진윤겸 2026-09-27 — "누르면 그것만 뜨는 게 낫다").
 * 왼쪽(좁으면 위 가로 탭)의 설정 메뉴 `SETTINGS_NAV` 가 섹션을 고르고, 오른쪽에는 고른 섹션 하나만 보인다(`#/settings/{section}` —
 * 순서 = 라우터 `SETTINGS_SECTIONS`). 묶음: 조직(일반 · 멤버와 초대 · API 키 · 요금제) · 운영(긴급 정지 · 투명성 로그 · 인계 시험 — AI 메일 감시는 2026-10-08 감시 탭으로) ·
 * 개인(화면 · 세션). 도메인은 2026-10-05 사이드바 1단 항목으로 옮겼다(`domains.ts`). 섹션 카드는 `settingsRow`(kit) — 멤버 · 조직 API 키는 `org-team.ts`, 요금제는 `plan.ts`, 투명성 로그 칸은 `logs.ts`.
 * 섹션 데이터는 그 섹션을 열 때 읽는다(스크립트 `showSettings`).
 */

import { AC0_OBSERVATION_DAYS, AC0_PROOF_DAYS } from '../../../../gate/ac0-verdict';
import { DEFAULT_MAIL_LOCALE, MAIL_LOCALE_LABELS, SUPPORTED_MAIL_LOCALES, type MailLocale } from '../../../../i18n/locales';
import { dangerZone, P, prop, settingsRow, tip, viewHead } from '../kit';
import { KEYS_ROW, MEMBERS_ROW, ORG_ROLE_PROP } from './org-team';
import { INTEGRITY_BODY, INTEGRITY_FOOT, INTEGRITY_TIP } from './logs';
import { PLAN_ROW } from './plan';

// --- 설정 -----------------------------------------------------------------------

/** 언어 선택지 순서 — 화면 언어(`lg-*`)와 같게 한국어 먼저(2026-10-15 F35). 나머지는 등록부 순서. */
export const MAIL_LOCALE_ORDER: readonly MailLocale[] = [...SUPPORTED_MAIL_LOCALES].sort((a, b) => (a === 'ko' ? -1 : b === 'ko' ? 1 : 0));

export { settingsRow } from '../kit';

const GATE_BODY =
  '<div class="gate-body" id="gate-body" hidden>' +
  '<div class="row"><label class="field" for="g-agent"><span>대상 에이전트</span><select id="g-agent" disabled><option value="">불러오는 중</option></select></label>' +
  '<label class="field" id="g-pick" for="g-sel" hidden><span>인계 시험</span><select id="g-sel"></select></label></div>' +
  '<div class="actions"><span class="muted small" id="g-asof"></span><button type="button" class="btn sm ghost" id="g-refresh">판정 다시 보기</button></div>' +
  '<p class="msg" id="g-msg" role="status"></p>' +
  '<div id="g-report" hidden>' +
  '<div class="verdict">' +
  '<div><p class="kicker">판정 · <span id="g-exit"></span></p>' +
  '<p class="v-status" id="g-status"></p><p class="v-meaning" id="g-meaning"></p>' +
  '<p class="small muted" id="g-restart" hidden></p></div>' +
  '<div><div class="v-day" id="g-day"></div>' +
  '<dl class="v-facts">' +
  '<dt>구간</dt><dd id="gf-phase"></dd>' +
  '<dt>전달 규칙</dt><dd id="gf-fwd"></dd>' +
  '<dt>1일차</dt><dd id="gf-day1"></dd>' +
  '<dt>재시작</dt><dd id="gf-restarts"></dd>' +
  '<dt>사람 메일함</dt><dd id="gf-mbx" class="addr"></dd>' +
  '</dl></div>' +
  '</div>' +
  '<div class="block"><h3>14일</h3><div class="days" id="g-days"></div>' +
  '<div class="legend"><span>막대: 그날 전달된 외부 발신 건수(관측)</span><span><i class="okm" aria-hidden="true"></i>개입·누수 없이 끝난 증명일</span><span>굵은 테두리: 오늘</span></div></div>' +
  '<div class="ac"><h4><span class="code">AC-b3</span>관측 추세: 기준일 대비 비교일<span class="pill" id="b3-pill"></span></h4>' +
  '<p id="b3-line"></p><p class="small muted" id="b3-sub"></p></div>' +
  '<div class="ac"><h4><span class="code">AC-b4</span>증명: 개입 0 연속<span class="pill" id="b4-pill"></span></h4>' +
  '<div class="mrow"><div class="mh"><span>끝난 증명일</span><b id="b4-days"></b></div><div class="meter"><i id="b4-meter"></i></div></div>' +
  '<p id="b4-line" class="small"></p><ul class="log" id="b4-log"></ul></div>' +
  '<div class="ac"><h4><span class="code">AC-b5</span>활동 분모: 연속 7일 창<span class="pill" id="b5-pill"></span></h4>' +
  '<p class="small muted" id="b5-window"></p><div class="meters" id="b5-meters"></div></div>' +
  '<div class="ac"><h4>다음 할 일</h4><ol class="next" id="g-next"></ol></div>' +
  '</div>' +
  '<div class="block split" id="g-actions">' +
  '<div><h3>전달 규칙</h3><p id="fwd-now" class="small"></p>' +
  '<div class="note"><div class="hrow"><strong>OFF는 8일차에 끕니다.</strong>' +
  tip(
    'gate-off',
    '전달 규칙 OFF 설명',
    P(
      '정확히는 비교일(연장이 없으면 7일차) 23:00–24:00 KST. Gmail 필터와 전달 주소를 먼저 삭제하고 <strong>바로</strong> 기록합니다. ' +
        '증명 구간은 OFF 기록 다음 KST 자정부터 셉니다. 비교일 끝 1시간 전보다 이르게 끄면 관측이 무효가 되어 1일차로 돌아갑니다.',
    ),
  ) +
  '</div></div>' +
  '<div class="actions"><button type="button" class="btn ghost" id="fwd-on">ON 기록</button>' +
  '<button type="button" class="btn danger" id="fwd-off">OFF 기록</button></div>' +
  '<p class="msg" id="fwd-msg" role="status"></p></div>' +
  // 개입 기록 · 인계 시험 시작은 버튼 → 대화상자(`DLG_GATE_IV` · `DLG_GATE_START` — 2026-09-30 진윤겸: 만들고 바꾸는 흐름은 전부 라이트박스).
  '<div><h3>개입 기록</h3>' +
  '<div class="actions"><button type="button" class="btn ghost" id="iv-open" aria-haspopup="dialog">기록</button></div>' +
  '<p class="msg" id="iv-msg" role="status"></p></div></div>' +
  '<div class="block" id="gs-block">' +
  '<div class="actions"><button type="button" class="btn" id="gs-open" aria-haspopup="dialog">인계 시험 시작</button></div>' +
  '<p class="msg" id="gs-msg" role="status"></p></div>' +
  '</div>';

/** 개입 기록 대화상자 — 카테고리 · 사유 한 줄. 제출하면 확인 대화상자(`ask`, 증명 구간이면 빨갛고 확인란)를 거쳐 기록한다(지울 수 없다). */
export const DLG_GATE_IV =
  '<dialog id="dlg-iv" aria-labelledby="di-title"><form id="iv-form" novalidate>' +
  '<div class="dh"><h3 id="di-title">개입 기록</h3></div>' +
  '<div class="db">' +
  '<div class="note"><div class="hrow"><strong>매직링크 클릭은 개입이 아닙니다.</strong>' +
  tip(
    'gate-iv',
    '개입 설명',
    P('개입은 에이전트가 처리했어야 할 메일을 사람이 <strong>자기 메일함(Gmail 등)에서</strong> 직접 읽거나 쓴 것입니다. 에이전트 수신함을 API로 열어 본 것도 개입이 아닙니다.'),
  ) +
  '</div></div>' +
  '<label class="field" for="iv-cat"><span>카테고리</span><select id="iv-cat">' +
  '<option value="address_transition">주소전환: 옛 주소(사람 메일함)로 온 거래 메일</option>' +
  '<option value="agent_gap">에이전트: 에이전트가 못 한 일</option>' +
  '<option value="deliverability">배달: 스팸함·반송</option>' +
  '<option value="policy_friction">정책: 승인·한도 마찰</option>' +
  '<option value="other">기타</option>' +
  '</select><small id="iv-hint"></small></label>' +
  '<label class="field" for="iv-reason"><span>사유(한 줄)</span><input type="text" id="iv-reason" maxlength="500" autocomplete="off">' +
  '<small>한 줄, 본문 없이. 지울 수 없습니다.</small></label>' +
  '<p class="msg" id="di-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="di-cancel">취소</button><button type="submit" class="btn" id="iv-go">기록</button></div>' +
  '</form></dialog>';

/** 인계 시험 시작 대화상자 — 사람 메일함 · 1일차(· 이미 있으면 따로 새로 열기). 제출하면 확인 대화상자(확인란)를 거쳐 연다. */
export const DLG_GATE_START =
  '<dialog id="dlg-gstart" aria-labelledby="dg-title"><form id="gs-form" novalidate>' +
  '<div class="dh"><div class="hrow"><h3 id="dg-title">인계 시험 시작</h3>' +
  tip(
    'gate-start',
    '인계 시험 시작 설명',
    P('아래 "인계 시험 시작"으로 엽니다(인계 시험 0일차 13단계까지 끝낸 뒤).') +
      P('재시작(복귀 일차부터 다시 세기)은 콘솔에서 하지 않습니다. 운영자에게 요청하세요.') +
      P('범위를 잘못 정해 따로 새 인계 시험을 열 때만 "새 인계 시험으로 따로 엽니다"를 체크합니다. 새로 열면 판정할 때마다 인계 시험을 골라야 합니다.'),
  ) +
  '</div></div>' +
  '<div class="db">' +
  '<label class="check" id="gs-new-wrap" hidden><input type="checkbox" id="gs-new"><span>새 인계 시험으로 따로 엽니다. 기존 인계 시험은 그대로 남습니다.</span></label>' +
  '<label class="field" for="gs-mbx"><span>사람 메일함(별칭·Workspace 주소까지 전부)</span>' +
  '<textarea id="gs-mbx" rows="2" spellcheck="false" autocapitalize="off" placeholder="founder@gmail.com, me@company.example"></textarea></label>' +
  '<label class="field" for="gs-day1"><span>1일차 (비우면 다음 KST 자정)</span><input type="date" id="gs-day1"></label>' +
  '<p class="msg" id="dg-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="dg-cancel">취소</button><button type="submit" class="btn" id="gs-go">인계 시험 시작</button></div>' +
  '</form></dialog>';

const GATE_SECTION = settingsRow(
  's-gate',
  'h-gate',
  '메일함 인계 시험',
  tip(
    'gate',
    '메일함 인계 시험 설명',
    P(
      `14일. 1–${AC0_OBSERVATION_DAYS}일차는 Gmail 전달 규칙 ON으로 추세를 관측하고, 8일차 00:00 KST 전에 끄고, 8–${AC0_OBSERVATION_DAYS + AC0_PROOF_DAYS}일차는 개입 0 이어야 합니다. ` +
        '판정은 <code>pnpm check:ac0</code>와 같은 계산으로, 열 때마다 DB에서 다시 셉니다.',
    ) +
      P('판정·기록은 고른 인계 시험에만 합니다(최신을 자동으로 고르지 않습니다. 틀린 인계 시험의 통과는 공허한 통과입니다).') +
      P('인계 시험 0일차 14·15단계 · ac0-shadow-log §2–§8'),
  ),
  '사람 메일함을 에이전트가 사람 손 없이 맡는지 14일 동안 확인합니다.',
  '<div class="gsum"><p class="stateline"><span id="g-sum">—</span></p>' +
    '<button type="button" class="btn sm ghost" id="g-toggle" aria-expanded="false" aria-controls="gate-body">열기</button></div>',
  GATE_BODY,
);

/**
 * 설정 메뉴 — [묶음 이름, [섹션, 메뉴 이름]…]. 섹션 순서는 라우터 `SETTINGS_SECTIONS` 와 같다(테스트). 메뉴 이름 = 섹션 제목(2026-10-15 F34 —
 * 고른 이름이 그대로 화면 제목이 된다). 부가 설명은 제목 아래 한 줄.
 */
export const SETTINGS_NAV: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'org',
    '조직',
    [
      ['org', '일반'],
      ['members', '멤버와 초대'],
      ['keys', '조직 API 키'],
      ['plan', '요금제 · 사용량'],
    ],
  ],
  [
    'ops',
    '운영',
    [
      ['pause', '긴급 정지'],
      ['tlog', '투명성 로그'],
      ['gate', '메일함 인계 시험'],
    ],
  ],
  [
    'me',
    '개인',
    [
      ['display', '화면'],
      ['mail', '메일 언어'],
      ['session', '계정 · 세션'],
    ],
  ],
];

const SETTINGS_MENU =
  '<nav class="snav" id="snav" aria-label="설정 메뉴">' +
  SETTINGS_NAV.map(
    ([g, label, items]) =>
      `<div class="snav-sec"><p class="snav-g" id="sg-${g}">${label}</p><ul aria-labelledby="sg-${g}">` +
      items.map(([sec, l]) => `<li><a href="#/settings/${sec}" id="ns-${sec}">${l}</a></li>`).join('') +
      '</ul></div>',
  ).join('') +
  '</nav>';

export const SETTINGS_VIEW =
  '<section class="view" id="v-settings" aria-labelledby="h-settings" hidden>' +
  viewHead('h-settings', '설정') +
  '<div class="sset">' +
  SETTINGS_MENU +
  '<div class="spanes">' +
  settingsRow(
    's-org',
    'h-org',
    '일반',
    tip('org', '조직 설명', P('이름과 소유자 주소는 가입 때 정해지고 콘솔에서 바꿀 수 없습니다.')),
    '',
    '<dl class="pl facts">' + prop('이름', 'so-name') + prop('ID', 'so-id', 'mono') + prop('소유자', 'so-owner', 'addr') + prop('검토 상태', 'so-review') + ORG_ROLE_PROP + '</dl>',
  ) +
  MEMBERS_ROW +
  KEYS_ROW +
  PLAN_ROW +
  settingsRow(
    's-pause',
    'h-pause',
    '긴급 정지',
    tip(
      'pause',
      '조직 긴급 정지 설명',
      P('에이전트 하나만 멈추려면 그 에이전트 개요 맨 아래의 긴급 정지를 씁니다.') + P('Atmark 운영자가 건 동결(플랫폼 동결)은 이 버튼으로 풀리지 않습니다. 운영자만 풉니다.'),
    ),
    '',
    '',
    // 위험 구역 한 행(F07 — 에이전트 개요와 같은 구조): [제목 · 설명 · 지금 상태 한 줄] [빨간 외곽선 버튼 | 해제].
    dangerZone('sp-dz', [
      {
        title: '조직 전체 정지',
        titleId: 'sp-dz-title',
        text: '모든 에이전트의 발신을 즉시 멈춥니다.',
        noteId: 'sp-state',
        button:
          '<div class="actions"><button type="button" class="btn danger" id="org-kill-on" hidden>긴급 정지</button>' +
          '<button type="button" class="btn ghost" id="org-kill-off" hidden>긴급 정지 해제</button></div>',
        msgId: 'org-kill-msg',
      },
    ]),
  ) +
  settingsRow('s-tlog', 'h-it', '투명성 로그', tip('integrity', '무결성 설명', INTEGRITY_TIP), '', INTEGRITY_BODY, '', INTEGRITY_FOOT) +
  GATE_SECTION +
  settingsRow(
    's-display',
    'h-display',
    '화면',
    '',
    '이 브라우저에 저장됩니다.',
    '<div class="disp"><div class="dg"><span class="lbl" id="th-l">테마</span><div class="seg" role="radiogroup" aria-labelledby="th-l">' +
      '<button type="button" role="radio" id="th-system" aria-checked="true" tabindex="0">시스템</button>' +
      '<button type="button" role="radio" id="th-light" aria-checked="false" tabindex="-1">라이트</button>' +
      '<button type="button" role="radio" id="th-dark" aria-checked="false" tabindex="-1">다크</button></div></div>' +
      '<div class="dg"><span class="lbl" id="lg-l">언어</span><nav class="seg" aria-labelledby="lg-l">' +
      '<a href="?lang=ko" hreflang="ko" lang="ko" id="lg-ko">한국어</a><a href="?lang=en" hreflang="en" lang="en" id="lg-en">English</a></nav></div></div>',
  ) +
  // 시스템 메일 언어(202610101000) — 이 사람에게 가는 로그인 코드 · 승인 요청 · 알림 메일의 언어. 서버에 저장한다(`/api/me/preferences`) —
  //   화면 언어(이 브라우저의 쿠키)와 따로다. 선택지는 등록부(`src/i18n/locales.ts`)의 언어를 그 언어로 적는다.
  settingsRow(
    's-mail',
    'h-mail',
    '메일 언어',
    '',
    '로그인 코드 · 승인 요청 · 알림 메일을 이 언어로 받습니다.',
    '<div class="disp"><div class="dg"><span class="lbl" id="ml-l">언어</span><div class="seg" role="radiogroup" aria-labelledby="ml-l">' +
      MAIL_LOCALE_ORDER.map(
        (code) =>
          `<button type="button" role="radio" id="ml-${code}" lang="${code}" aria-checked="${String(code === DEFAULT_MAIL_LOCALE)}" tabindex="${code === DEFAULT_MAIL_LOCALE ? '0' : '-1'}">${MAIL_LOCALE_LABELS[code]}</button>`,
      ).join('') +
      '</div></div></div>' +
      '<p class="msg" id="ml-msg" role="status"></p>',
  ) +
  settingsRow(
    's-session',
    'h-account',
    '계정 · 세션',
    tip('session', '세션 설명', P('세션이 샜다고 의심되면 모든 기기에서 로그아웃하세요.')),
    '세션은 12시간 유지됩니다.',
    '<dl class="pl facts">' + prop('로그인한 주소', 'ss-me', 'addr') + '</dl>',
    '',
    '<div class="actions"><button type="button" class="btn ghost" id="logout-s">로그아웃</button>' +
      '<button type="button" class="btn ghost" id="logout-all-s">모든 기기에서 로그아웃</button></div>',
  ) +
  '</div></div>' +
  '</section>';
