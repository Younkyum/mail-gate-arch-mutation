/** src/admin/ui/console/markup/logs.ts — 로그 모듈(조직 · 에이전트 공용) · 조직 로그 화면 · 투명성 로그 칸(설정으로 옮김 — D5). */

import { copyBtn, P, prop, skelRows, tip, viewHead } from '../kit';

// --- 로그 (조직 · 에이전트 공용 모듈 — 스크립트가 자리로 옮긴다) -----------------

const LOGS_MODULE =
  '<div class="logs" id="logs-mod">' +
  '<div class="lgtabs"><nav class="seg tabs" aria-label="로그 종류">' +
  '<a href="#/logs" id="lt-outbound">발신</a><a href="#/logs/inbound" id="lt-inbound">수신</a><a href="#/logs/console" id="lt-console">콘솔</a><a href="#/logs/scheduled" id="lt-scheduled">예약</a></nav>' +
  '</div>' +
  '<div class="logbar">' +
  '<label class="filter" id="lf-wrap" for="lf-agent"><span class="lbl">에이전트</span><select id="lf-agent"><option value="">전체</option></select></label>' +
  '<label class="filter" id="ld-wrap" for="lf-dec"><span class="lbl">결과</span><select id="lf-dec"><option value="">전체</option></select></label>' +
  // 수신 필터(메일 기본기 A5) — 보낸 주소(정확 일치)·기간(KST 날짜, 끝 날짜 포함). 수신 탭에서만 보인다.
  '<label class="filter" id="lff-wrap" for="lf-from" hidden><span class="lbl">보낸 사람</span><input type="email" id="lf-from" maxlength="320" placeholder="주소 전체" autocomplete="off" inputmode="email" spellcheck="false" autocapitalize="off"></label>' +
  '<label class="filter" id="lfs-wrap" for="lf-since" hidden><span class="lbl">시작일</span><input type="date" id="lf-since"></label>' +
  '<label class="filter" id="lfu-wrap" for="lf-until" hidden><span class="lbl">종료일</span><input type="date" id="lf-until"></label>' +
  '<button type="button" class="btn sm ghost" id="lg-refresh">새로고침</button></div>' +
  '<table class="tbl dense logt" id="lg-tbl"><thead><tr id="lg-head"></tr></thead><tbody id="lg-body">' + skelRows(6) + '</tbody></table>' +
  `<div class="empty" id="lg-empty" hidden><p>기록이 없습니다.</p></div>` +
  '<div class="actions lgmore"><button type="button" class="btn ghost sm" id="lg-more" hidden>더 보기</button><span class="small muted num" id="lg-count"></span></div>' +
  '<p class="msg" id="lg-msg" role="status"></p>' +
  '</div>';

/**
 * 예약 취소 대화상자(메일 기본기 1차 Y2) — 예약 로그 행의 "취소" 버튼(owner·admin · `scheduled` 상태만)이 연다. 사유는 필수(값 = DB 사유 코드,
 * 글 = 로그의 사유 이름과 같은 사전 키), 메모는 선택(200자 — 서버가 제어문자를 다시 거른다).
 */
export const DLG_SCHEDULE_CANCEL =
  '<dialog id="dlg-sched-cancel" aria-labelledby="sc-title"><form id="sc-form" novalidate>' +
  '<div class="dh hatch"><p class="kicker">예약 취소</p><h3 id="sc-title">이 예약 발송을 취소할까요?</h3></div>' +
  '<div class="db">' +
  '<p>이 예약 메일은 보내지지 않습니다. 에이전트가 취소할 수 없게 만든 예약도 취소됩니다. 취소는 되돌릴 수 없고 콘솔 로그에 남습니다.</p>' +
  '<label class="field" for="sc-reason"><span>사유</span><select id="sc-reason"><option value="">사유를 고르세요</option>' +
  '<option value="owner_request">소유자 요청</option><option value="no_longer_needed">더는 필요 없음</option>' +
  '<option value="wrong_recipient">받는 사람 잘못</option><option value="wrong_content">내용 잘못</option>' +
  '<option value="wrong_time">시각 잘못</option><option value="duplicate">중복</option><option value="other">기타</option></select></label>' +
  '<label class="field" for="sc-note"><span>메모(선택)</span><input type="text" id="sc-note" maxlength="200" autocomplete="off" spellcheck="false">' +
  '<small>200자까지, 로그에만 보입니다</small></label>' +
  '<p class="msg" id="sc-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="sc-close">닫기</button><button type="submit" class="btn danger" id="sc-go">예약 취소</button></div>' +
  '</form></dialog>';

/**
 * 투명성 로그(US-010 메모 · ADR-0008) — v4 에서 설정의 한 행으로 옮겼다(D5 · §2.4 설정). 상시 보이는 것은 사실 칸(데이터)뿐이고, 검증
 * 방법은 ⓘ 안에, 번들을 내려받는 결과(커밋 열쇠가 들어 있다 — 조직 밖으로 보내지 말 것)는 확인 대화상자에 둔다(§4 R6).
 * 문구 규칙(ADR-0008 Q10 · 런북 transparency-log §5): "변조 흔적이 남는 투명성 로그(RFC 9162)" 까지.
 * Bitcoin 은 기록 완료가 아니라 OpenTimestamps에 제출한 증명으로 적는다(블록 헤더는 대조하지 않음 · `ots verify`).
 * "독립 검증 가능"·"블록체인에 기록된 신원" 은 쓰지 않는다.
 */
export const INTEGRITY_TIP =
  P(
    '콘솔·메일 기록은 변조 흔적이 남는 투명성 로그(RFC 9162)입니다. 매시 체크포인트에 서명하고, 하루 한 번 OpenTimestamps에 제출해 Bitcoin 증명을 받습니다. 블록 헤더는 Atmark가 대조하지 않으며, 각자 <code>ots verify</code>로 확인합니다. Sigstore에도 남깁니다.',
  ) +
  P('오프라인 검증은 번들을 받아 <code>pnpm log:verify &lt;file&gt; --key &lt;vkey&gt;</code>를 실행합니다. Sigstore는 이 명령으로 대조합니다.') +
  P('공개키가 <code>id.atmark.ai/log/key</code>와 DNS TXT <code>_tlog.id.atmark.ai</code>가 같은지 확인합니다.');

export const INTEGRITY_BODY =
  '<div class="integ" id="it">' +
  '<dl class="pl it-facts" id="it-facts">' +
  prop('마지막 체크포인트', 'it-cp') +
  prop('이 조직 로그 항목', 'it-size', 'num') +
  prop('OpenTimestamps', 'it-ots') +
  prop('Rekor', 'it-rekor') +
  '</dl>' +
  // 검증 도구 v4(메일 기본기 2차 · 런북 transparency-log §8) — 번들 min_verifier_version 4, v3 은 verifier_outdated 로 멈춘다. 고객 문구만(2026-10-15 F52).
  '<p class="small muted" id="it-ver">검증 도구 v4 이상에서 확인할 수 있습니다.</p>' +
  '<p class="small muted" id="it-shred" hidden>이 조직의 커밋 열쇠는 삭제 요청으로 폐기됐습니다.</p>' +
  '<div class="empty" id="it-empty" hidden><p>첫 감사 기록 뒤에 로그가 시작됩니다.</p></div>' +
  '<p class="msg" id="it-msg" role="status"></p>' +
  '</div>';

/**
 * 투명성 로그 카드 푸터 — 왼쪽 로그 공개키 칩 + 복사, 오른쪽 검증 번들 내려받기(명세 §4.5 설정). 공개키를 사실 칸에서 푸터로 옮겨 사실 칸이
 * 한 줄 네 칸으로 끝난다(비평 R1-20 — 다섯째 칸이 홀로 남던 것).
 */
export const INTEGRITY_FOOT =
  `<div class="itk"><span class="lbl">로그 공개키</span><span class="it-kv"><span class="mono chip" id="it-key">—</span><span class="sub mono" id="it-kname"></span></span>${copyBtn('it-key-copy', '공개키 복사')}</div>` +
  '<div class="actions it-act"><button type="button" class="btn sm ghost" id="it-dl" disabled>검증 번들 내려받기</button></div>';

/** 조직 로그 — 사이드바 1단 항목(비평 R10-11)이라 뒤로가기 링크가 없다. */
export const LOGS_VIEW =
  '<section class="view" id="v-logs" aria-labelledby="h-logs" hidden>' +
  viewHead('h-logs', '로그', { tip: tip('logs', '로그 종류 설명', '<p id="tip-logs-t"></p>') }) +
  `<div id="logs-host">${LOGS_MODULE}</div>` +
  '</section>';
