/**
 * src/admin/ui/console/markup/agent-addresses.ts — 주소 화면 `#/agents/{id}/addresses`(메일 기본기 2차 A6 — 별칭, 2026-09-29 진윤겸: 이메일 화면에서
 * 탭 하나로 뺐다). 대표 주소(읽기 전용 · `대표`) + 별칭 목록. 추가는 머리의 `별칭 추가` → 대화상자(남은 수 · 삭제한 별칭의 재발급 규칙 한 줄) ·
 * 삭제는 행마다 `삭제` → 위험 확인 대화상자(빨간 확인). 삭제 = 서버의 **폐기**(`POST …/aliases/{id}/retire`)다 — 행은 지워지지 않고
 * `retired_at` 한 번 쓰기 + 투명성 로그 잎이다. 그 주소는 같은 조직이 곧바로, 다른 조직은 30일 뒤에 다시 받을 수 있다(ADR-0013 2026-09-29 개정 —
 * 옛 에이전트에게 가던 메일을 남이 곧바로 받지 못하게). 화면은 폐기한 별칭을 목록에 올리지 않는다(다시 쓰려면 `별칭 추가` 로 새로 만든다).
 *
 * 대표 주소(ADR-0014 2026-10 개정 · M4): 목록의 `primary` 가 유효 대표다. 확인이 끝난 고객 도메인 별칭에는 `대표로` 동작(워밍업 경고 확인),
 * 대표가 고객 도메인이면 @atmark.ai 주소는 꺼져 있다는 한 줄 + `켜기`, 대표를 잃었으면 "대표 주소 없음" 상자(도메인 보기 · @atmark.ai 주소 켜기 — 살아 있는 별칭이 있으면 그 별칭으로는 계속 주고받는다고 말한다).
 * 대표인 별칭은 삭제할 수 없다(409 `address_is_primary`).
 *
 * 스위치(`/api/plan` features.addressAliases)가 닫혀 있으면 추가 버튼이 없고, 별칭이 하나도 없으면 별칭 절(`#al-sec`)이 통째로 숨는다 — 대표
 * 주소는 늘 보인다. 닫혀도 있는 별칭은 보이고 삭제할 수 있다(보안 리뷰 L-4).
 */

import { icon, P, secHead, tip, viewHead } from '../kit';

/**
 * 탭·제목 글자 — 한국어는 `주소`, 영어는 복수 `Addresses`. 원문 `주소` 한 단어는 사전에서 이미 단수 `Address`(표 머리·입력 칸)라서, 이 자리만
 * 빈 HTML 주석을 붙여 사전 키를 따로 둔다(`i18n.ts` — 한국어 화면에는 주석이 그대로 남지만 보이지 않는다).
 * **텍스트 노드에만 쓴다** — 속성 값(`aria-label` 등)에 넣으면 주석이 글자 그대로 읽힌다(테스트가 두 언어 페이지의 모든 속성을 본다).
 */
export const ADDRESSES_LABEL = '주소<!--복수-->';

/** 대표 주소 한 줄 + 별칭 절(머리 · 한 줄 · 목록 · 빈 상태 · 한도 초과 줄). */
export const A_ADDRESSES =
  '<div class="pane" id="t-addresses" hidden>' +
  // 머리의 ⓘ 는 대표 주소만 말한다 — 별칭 설명은 별칭 절(`#al-sec`, 닫힌 조직에서는 숨는다) 안에 둔다(리뷰 2026-09-29).
  viewHead('h-ag-addr', ADDRESSES_LABEL, {
    tip: tip(
      'addr',
      '주소 설명',
      P('대표 주소는 에이전트가 메일을 보낼 때 쓰고, 패스포트와 공개 조회에 나오는 주소입니다.') +
        P('연결한 도메인의 별칭은 대표 주소로 고를 수 있습니다. @atmark.ai 주소는 언제든 다시 켤 수 있습니다.'),
    ),
  }) +
  '<div class="alsec">' +
  '<ul class="rules" id="al-primary"></ul>' +
  // 주소 없음(ADR-0014 2026-10 개정 — 대표였던 고객 도메인 주소를 잃었다): 자동으로 @atmark.ai 로 옮기지 않는다. 두 길 — 도메인 다시 연결 · @atmark.ai 주소 켜기.
  // 문장은 스크립트가 고른다 — 살아 있는 별칭이 있으면 "대표 주소 없음(별칭으로는 계속)", 없으면 "주고받지 않음"(진윤겸 결정 2026-10 — 별칭 허용).
  '<div class="warnbox noaddr" id="al-none" hidden><div class="na-t"><strong id="al-none-t">쓸 수 있는 주소가 없습니다</strong>' +
  '<p id="al-none-d">도메인 연결이 끊겨 지금은 메일을 보내지도 받지도 않습니다.</p></div>' +
  '<div class="actions"><a class="btn sm ghost" id="al-none-dom" href="#/domains">도메인 보기</a>' +
  '<button type="button" class="btn sm" id="al-wake">@atmark.ai 주소 켜기</button></div></div>' +
  // 대표가 고객 도메인 주소면 @atmark.ai 주소는 꺼져 있다(잠든 앵커 — 목록에 없다). 켜는 길을 한 줄로 둔다.
  '<p class="al-anchor small muted" id="al-anchor" hidden><span>@atmark.ai 주소는 꺼져 있습니다.</span>' +
  '<button type="button" class="btn sm link" id="al-wake2">켜기</button></p>' +
  '<section class="alsub" id="al-sec" aria-labelledby="h-al" hidden>' +
  secHead(
    'h-al',
    '별칭',
    '<span class="num lcount" id="al-n"></span>' +
      tip(
        'al',
        '별칭 설명',
        P('별칭은 이 에이전트가 대표 주소와 함께 받는 주소입니다.') +
          P('삭제한 별칭으로 오는 메일은 거부되고, 이 조직에서는 바로 다시 만들 수 있습니다. 하지만 30일이 지나면 다른 조직이 그 주소를 가져가 그 앞으로 오는 메일을 받을 수 있습니다. 그 주소로 가입한 서비스의 비밀번호 재설정·인증 메일도 포함됩니다. 삭제하기 전에 가입 주소를 옮기세요.'),
      ),
    '<div class="al-act"><a class="btn sm ghost" id="al-up" href="#/settings/plan" hidden>업그레이드</a>' +
      `<button type="button" class="btn sm ghost addbtn" id="al-add" aria-haspopup="dialog" aria-label="별칭 추가" hidden>${icon('plus')}<span>추가</span></button></div>`,
  ) +
  '<p class="sdesc" id="al-note">별칭은 패스포트와 공개 조회에 나오지 않습니다.</p>' +
  '<p class="note" id="al-over" hidden>한도를 넘어 새 별칭은 만들 수 없습니다. 있는 별칭은 계속 받습니다.</p>' +
  '<ul class="rules" id="al-list"></ul>' +
  '<div class="empty" id="al-empty" hidden><p>별칭이 없습니다.</p></div>' +
  '</section></div>' +
  '<p class="msg" id="al-msg" role="status"></p>' +
  '</div>';

/**
 * 별칭 추가 대화상자 — (`사용 중<!--별칭 수-->` — 사전 키를 도메인 상태 `사용 중`(Active)과 가른다, `ADDRESSES_LABEL` 과 같은 방법) `@atmark.ai` 고정 접미 · 남은 수(요금제의 활성 한도 · 이 에이전트의 누적 발급 상한 — 둘 다 `GET …/aliases` 의
 * `aliases{active,activeMax,issued,issuedMax}` 그대로, 화면이 숫자를 지어내지 않는다) · 삭제한 별칭의 재발급 규칙(이 조직은 바로 · 다른 조직은 30일 뒤) 한 줄.
 */
export const DLG_ALIAS =
  '<dialog id="dlg-alias" aria-labelledby="da-title"><form id="al-form" novalidate>' +
  '<div class="dh"><h3 id="da-title">별칭 추가</h3></div>' +
  '<div class="db">' +
  // 도메인(ADR-0014 M4) — atmark.ai + 확인이 끝난 고객 도메인. 고를 것이 하나뿐이면 숨는다.
  // 도메인이 둘 이상이면 접미사 자리가 곧 도메인 고르기다(F48 — 고르기 칸과 접미사에 @atmark.ai 가 두 번 보이지 않게).
  '<label class="field" for="al-local"><span>새 별칭</span><span class="suffix"><input type="text" id="al-local" maxlength="64" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="billing">' +
  '<b id="al-suf-w"><span class="at">@</span><span id="al-suf">atmark.ai</span></b><select id="al-dom" aria-label="도메인" hidden></select></span></label>' +
  '<dl class="kv aq"><dt>사용 중<!--별칭 수--></dt><dd class="num" id="da-active">—</dd><dt>누적 발급(삭제 포함)</dt><dd class="num" id="da-issued">—</dd></dl>' +
  '<p class="small muted">삭제한 별칭은 이 조직에서 바로 다시 만들 수 있습니다. 30일이 지나면 다른 조직이 가져가 그 주소로 오는 메일을 받을 수 있습니다.</p>' +
  '<p class="msg" id="da-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="da-cancel">취소</button><button type="submit" class="btn" id="da-go">추가</button></div>' +
  '</form></dialog>';
