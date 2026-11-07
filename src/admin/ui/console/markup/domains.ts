/**
 * src/admin/ui/console/markup/domains.ts — 도메인(ADR-0014 단계 4 M4 · 계획 `custom-domains-stage2-4.md`).
 *
 * 2026-10-05 진윤겸 결정: 설정 섹션에서 꺼내 **사이드바 1단 항목**(개요 · 에이전트 · 도메인 · 로그 · 설정)으로 올렸다. 한 화면에 세 모습이 있다
 * (라우트와 `features.customDomains` 가 고른다 — 스크립트 `showDomainsView`):
 *   - 목록 `#/domains` — 머리(제목 · 사용 수 `live / limit` · `도메인 추가`) → 표(도메인 · 상태 · 만든 날, 행 전체가 링크) · 빈 상태.
 *   - 한 도메인 `#/domains/{id}` — 머리(이름 · 전체 상태 · 제거) → 사실 줄 → 알림(정지 · 확인 대기 사유 · 남은 시간) →
 *     **DNS 레코드 표**(DNS 공급자 화면과 같은 칸: 형식 · 이름 · 콘텐츠 · 우선순위 · TTL · 프록시 상태 · 상태). 표 위에 한 줄 안내와 `지금 확인`.
 *     순서는 소유 확인 TXT → 수신 MX → MAIL FROM MX · SPF TXT → DKIM CNAME 셋 — **추가한 순간부터 전부**(2026-10 one-shot). DKIM 토큰을 받는
 *     몇 초 동안만 서명 무리에 "레코드를 준비하고 있습니다…" 한 줄(스크립트).
 *   - 잠김 — 기능이 닫힌 조직. 항목은 숨기지 않고(주 탭이라서) "초대받은 조직에만 열린 베타" 라고 조용히 말한다(파는 문구 없음).
 * 표 위 한 번에 넣기 줄: (DNS 업체가 Domain Connect 를 지원하면) `{업체}로 연결` 하나 · `레코드 파일 받기`(BIND 존 파일 하나에 전부) · `모두 복사`
 * + Cloudflare 가져오기 안내 한 줄. 소유 확인 TXT 는 서브도메인 이름으로 보이고, 최상위 도메인 이름도 인정된다는 것은 주의 줄의 ⓘ 안에.
 * 레코드 이름 · 값은 스크립트가 `textContent` 로 그린다(복사 단추는 `navigator.clipboard` — CSP 무관). 안내 줄은 가장 흔한 DNS 공급자 하나를
 * 예로 든다(진윤겸 요청 — "예: Cloudflare"). 표는 좁은 화면에서 **자기 안에서만** 가로로 밀린다(페이지는 가로로 밀리지 않는다).
 *
 * 추가 · 지금 확인이 열려 있는지는 `GET /api/domains` 의 `enabled` 가 말한다.
 */

import { backLink, dangerZone, icon, P, skelRows, tip, viewHead } from '../kit';

/**
 * 사이드바 · 화면 제목 · 돌아가기 글자 — 한국어 `도메인`, 영어 복수 `Domains`. 원문 `도메인` 한 단어는 사전에서 단수 `Domain`(칸 이름)이라서 빈 HTML
 * 주석을 붙여 키를 따로 둔다(`ADDRESSES_LABEL` 과 같은 방법 — **텍스트 노드에만** 쓴다).
 */
export const DOMAINS_LABEL = '도메인<!--복수-->';

const DOMAINS_TIP = tip(
  'domains',
  '도메인 설명',
  P('회사 도메인 아래 에이전트 전용 서브도메인(예: agents.example.com)을 연결하면, 에이전트가 그 도메인 주소로 메일을 주고받습니다.') +
    P('DNS 레코드로 소유를 확인한 뒤에 쓸 수 있습니다. 사람이 메일을 받는 도메인은 연결할 수 없습니다.') +
    P('개수는 요금제가 정하고, 확인을 기다리는 도메인도 셉니다.'),
);

/** 기능이 닫힌 조직 — 조용한 상태 한 장(파는 문구 · 단추 없음). */
const DOMAIN_LOCKED =
  '<div class="dlock" id="dm-locked" hidden>' +
  '<span class="pill tag">베타</span>' +
  '<h2 class="dlock-t">초대받은 조직에만 열려 있는 기능입니다</h2>' +
  '<p>에이전트가 회사 도메인 주소로 메일을 주고받게 합니다.</p>' +
  '<p>열리면 여기에서 도메인을 추가할 수 있습니다.</p>' +
  '</div>';

const DOMAIN_LIST =
  '<div id="dm-list-w">' +
  viewHead('h-domains', DOMAINS_LABEL, {
    count: '<span class="hcount num" id="dm-count" title="사용 중(확인 중 포함) / 요금제 한도"></span>',
    tip: DOMAINS_TIP,
    actions: '<button type="button" class="btn" id="dm-add" aria-haspopup="dialog" hidden>도메인 추가</button>',
  }) +
  DOMAIN_LOCKED +
  '<div class="block" id="dm-list-b">' +
  '<p class="small muted dm-off" id="dm-off" hidden>이 조직은 지금 새 도메인을 추가할 수 없습니다.</p>' +
  '<table class="tbl dmt" id="dm-tbl"><thead><tr><th scope="col">도메인</th><th scope="col">상태</th><th scope="col">만든 날</th></tr></thead>' +
  '<tbody id="dm-body">' +
  skelRows(3, 2) +
  '</tbody></table>' +
  '<div class="empty" id="dm-empty" hidden><p>연결한 도메인이 없습니다.</p><p>agents.example.com 같은 에이전트 전용 서브도메인을 연결하세요.</p></div>' +
  '<p class="msg" id="dm-msg" role="status"></p>' +
  '</div></div>';

/** DNS 레코드 표의 칸 — DNS 공급자 화면과 같은 이름 · 순서. */
const REC_COLS = ['형식', '이름', '콘텐츠', '우선순위', 'TTL', '프록시 상태', '상태'];

const DOMAIN_DETAIL =
  '<div id="dm-detail" hidden>' +
  backLink('dd-back', '#/domains', DOMAINS_LABEL) +
  // 머리 — 이름 · 전체 상태. 제거(되돌릴 수 없다)는 맨 아래 위험 구역(F06 — 에이전트 개요와 같은 자리).
  '<header class="vh dvh"><div class="dnh"><h1 class="dname" id="dd-name" tabindex="-1"></h1><span class="pill" id="dd-pill"></span>' +
  '<span class="pill tag" id="dd-ready" hidden>수신 · 발신 준비됨</span></div></header>' +
  '<dl class="pl facts dfacts" id="dd-facts">' +
  '<div><dt>만든 날</dt><dd id="dd-created">—</dd></div>' +
  '<div><dt>마지막 확인</dt><dd id="dd-last">—</dd></div>' +
  '<div id="dd-next-w"><dt>다음 자동 확인</dt><dd id="dd-next">—</dd></div>' +
  '<div id="dd-left-w" hidden><dt>남은 시간</dt><dd id="dd-left">—</dd></div>' +
  '<div id="dd-due-w" hidden><dt>제거 예정</dt><dd id="dd-due">—</dd></div>' +
  '</dl>' +
  '<p class="msg" id="dd-msg" role="status"></p>' +
  // 알림 — 정지 사유 · 확인 대기 사유 · 남은 시간 · 제거됨(스크립트가 문장을 고른다 — 다른 조직은 언제나 말하지 않는다).
  '<div class="warnbox dalert" id="dd-alert" hidden><strong id="dd-alert-t"></strong><p id="dd-alert-d"></p>' +
  '<p class="dalert-a" id="dd-alert-a" hidden></p></div>' +
  // DNS 레코드 — 안내 한 줄 + 지금 확인(60초) → 표(가로 스크롤은 표 칸 안에서만) → 짧은 주의 셋.
  '<section class="srow drec" id="dd-steps" aria-labelledby="dd-rec-h"><div class="sc">' +
  '<div class="drh"><div class="drh-t"><h2 id="dd-rec-h">DNS 레코드</h2>' +
  '<p class="small muted" id="dd-howto">DNS 공급자(예: Cloudflare)에 아래 레코드를 그대로 추가하세요.</p></div>' +
  '<div class="drh-a"><span class="dcool small muted" id="dd-cool" aria-live="polite"></span><button type="button" class="btn" id="dd-check">지금 확인</button></div></div>' +
  // 한 번에 넣기(2026-10-05 진윤겸) — 표와 같은 레코드를 BIND 존 파일로 받거나 통째로 복사. 안내는 가장 흔한 공급자 하나(Cloudflare 가져오기).
  '<div class="dzx" id="dd-zone">' +
  '<div class="dzx-a">' +
  // Domain Connect — 서버가 서명 URL 을 줄 때만 보인다(글자는 스크립트가 업체 이름으로 채운다). 동의 한 번으로 레코드 전부.
  `<button type="button" class="btn sm" id="dd-dc" hidden>${icon('connect')}<span id="dd-dc-t"></span></button>` +
  `<button type="button" class="btn sm ghost" id="dd-zone-dl">${icon('download')}<span>레코드 파일 받기</span></button>` +
  `<button type="button" class="btn sm ghost" id="dd-zone-cp">${icon('copy')}<span>모두 복사</span></button>` +
  '</div>' +
  // 상시 보이는 글은 한 줄(ko 45자 — Ⓥ-2): 가져오기 경로만 보이고, 무엇이 되는지 · 프록시 · TTL · 다른 공급자는 ⓘ 안에.
  '<div class="hrow small muted dzx-h"><span>Cloudflare: DNS → 레코드 → 가져오기 및 내보내기 → 가져오기</span>' +
  tip(
    'zone',
    '레코드 파일 설명',
    P('Cloudflare에서는 위 경로에 이 파일을 올리면 레코드가 한 번에 들어갑니다. 프록시는 꺼 두세요. 파일의 CNAME 레코드에는 프록시를 끄는 표시가 들어 있습니다.') +
      P('다른 DNS 공급자도 존 파일(BIND) 가져오기가 있으면 같은 파일을 씁니다. 없으면 모두 복사로 글을 옮기거나 아래 표대로 한 줄씩 넣으세요.') +
      P('TTL은 3600초로 적혀 있습니다. 공급자의 자동 값으로 두어도 됩니다.'),
  ) +
  '</div>' +
  // 다른 메일 서버가 있는 서브도메인(보안 리뷰 M3) — 자동 입력은 그 MX 를 덮어쓰므로 단추 대신 이 한 줄.
  '<p class="small muted" id="dd-dc-mail" hidden>이 서브도메인에는 다른 메일 서버가 있어 자동 입력을 쓸 수 없습니다.</p>' +
  '</div>' +
  '<div class="dnsw" id="dd-scroll" role="region" aria-labelledby="dd-rec-h" tabindex="0">' +
  `<table class="dnst" id="dd-tbl"><thead><tr>${REC_COLS.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>` +
  '<tbody id="dd-recs"></tbody></table></div>' +
  '<ul class="dnotes">' +
  '<li>이름 칸에는 굵게 보이는 앞부분만 넣으세요. DNS 공급자가 뒤의 도메인을 자동으로 붙입니다. 붙이지 않는 공급자라면 아래 회색 전체 이름을 넣습니다.</li>' +
  '<li><strong>CNAME 레코드는 프록시를 끄고 DNS 전용으로 두세요.</strong> 프록시를 켜면 서명(DKIM)을 확인할 수 없습니다.</li>' +
  '<li class="hrow"><span>소유 확인 TXT는 이 서브도메인 이름 아래에 넣습니다.</span>' +
  tip(
    'own',
    '소유 확인 레코드 설명',
    P('최상위 도메인 이름(예: _atmark-challenge.example.com)에 같은 값을 넣어도 인정됩니다. 둘 중 하나만 있으면 됩니다.') +
      P('다른 레코드와 함께 한 번에 넣을 수 있게 기본은 서브도메인 이름입니다.'),
  ) +
  '</li>' +
  '<li class="hrow"><span>레코드를 모두 넣으면 확인이 저절로 이어집니다. DMARC는 권장입니다.</span>' +
  tip(
    'dmarc',
    'DMARC 설명',
    P('DMARC는 확인에 쓰지 않지만, 받는 쪽 메일 서비스는 이 레코드가 없는 대량 발신을 스팸으로 분류하기도 합니다.') +
      P('최상위 도메인에 DMARC가 이미 있으면 그 정책이 적용됩니다. 처음엔 p=none으로 시작하세요.'),
  ) +
  '</li></ul>' +
  '</div></section>' +
  dangerZone('dd-dz', [
    {
      title: '도메인 제거',
      titleId: 'dd-dz-title',
      text: '이 도메인으로는 더 이상 메일을 보내거나 받지 않습니다. 되돌릴 수 없습니다.',
      noteId: 'dd-dz-note',
      button: '<button type="button" class="btn danger" id="dd-remove" aria-haspopup="dialog">제거</button>',
      msgId: 'dd-dz-msg',
    },
  ]) +
  '</div>';

export const DOMAINS_VIEW =
  '<section class="view" id="v-domains" aria-labelledby="h-domains" hidden>' + DOMAIN_LIST + DOMAIN_DETAIL + '</section>';

/** 도메인 추가 — 이름 하나. 거부 사유(서버 판정 코드)는 칸 바로 아래 한 줄로. 추가하면 그 도메인 화면(레코드)으로 간다. */
export const DLG_DOMAIN_ADD =
  '<dialog id="dlg-domadd" aria-labelledby="dad-title"><form id="dad-form" novalidate>' +
  '<div class="dh"><h3 id="dad-title">도메인 추가</h3></div>' +
  '<div class="db">' +
  '<label class="field" for="dad-name"><span>도메인</span><input type="text" id="dad-name" maxlength="100" autocomplete="off" spellcheck="false" autocapitalize="off" inputmode="url" placeholder="agents.example.com">' +
  '<small>에이전트만 쓰는 서브도메인을 적으세요. 사람이 메일을 받는 도메인은 쓸 수 없습니다.</small></label>' +
  '<dl class="kv aq"><dt>사용 중(확인 중 포함)</dt><dd class="num" id="dad-n">—</dd></dl>' +
  '<p class="small muted">추가하면 넣을 DNS 레코드가 나옵니다. 72시간 안에 소유가 확인되지 않으면 도메인은 저절로 지워집니다.</p>' +
  '<p class="msg" id="dad-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="dad-cancel">취소</button><button type="submit" class="btn" id="dad-go">추가</button></div>' +
  '</form></dialog>';

/**
 * 도메인 제거 — 되돌릴 수 없는 동작(빨간 머리 · 빨간 실행 단추). 이 도메인 주소 수와 이 도메인을 대표로 쓰는 에이전트 수(`GET /api/domains/{id}` 의
 * `liveAddresses` · `primaryAgents`)를 보이고, 주소도 함께 폐기할지 고른다(기본은 남긴다 — 다시 연결하면 돌아온다).
 */
export const DLG_DOMAIN_REMOVE =
  '<dialog id="dlg-domrm" aria-labelledby="dr-title"><form id="dr-form" novalidate>' +
  '<div class="dh hatch"><p class="kicker">도메인 제거</p><h3 id="dr-title">이 도메인을 제거할까요?</h3></div>' +
  '<div class="db">' +
  '<p class="dr-name addr" id="dr-name"></p>' +
  '<p>이 도메인으로는 더 이상 메일을 보내거나 받지 않습니다. DNS 레코드는 DNS 제공자에서 직접 지우세요.</p>' +
  '<div class="warnbox" id="dr-primary" hidden><strong id="dr-primary-t"></strong>' +
  '<p>도메인을 다시 연결하거나 @atmark.ai 주소를 켜기 전까지 이 에이전트들은 대표 주소가 없습니다. 다른 별칭이 없는 에이전트는 메일을 주고받지 못합니다.</p></div>' +
  '<div id="dr-release-w" hidden><label class="check" for="dr-release"><input type="checkbox" id="dr-release"><span id="dr-release-t"></span></label>' +
  '<p class="small muted">폐기하지 않으면, 같은 도메인을 다시 연결할 때 주소가 그대로 돌아옵니다.</p></div>' +
  '<p class="msg" id="dr-msg" role="status"></p></div>' +
  '<div class="df"><button type="button" class="btn ghost" id="dr-cancel">취소</button><button type="submit" class="btn danger solid" id="dr-go">제거</button></div>' +
  '</form></dialog>';
