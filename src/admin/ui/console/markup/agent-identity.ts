/**
 * src/admin/ui/console/markup/agent-identity.ts — 신원 `#/agents/{id}/identity`(§2.4 · §3): **한 페이지, 탭 없음.**
 *   - 머리 오른쪽: `신원 공개` 스위치(`role="switch"`) — 켜기 = 게시, 끄기 = 게시 중단(문서는 남고 상태만 바뀐다 · D3). "비공개" 낱말 금지(R-0).
 *   - 왼쪽: 세로 ID-1 배지 카드(D9) — 소속(주인 조직, **콘솔에서만 보임** 표시 · D2) · 키 지문으로 그린 기요셰 로제트와 색(D1 · D8) ·
 *     이름 · 주소 · DID · 검증 마크(사실인 것만 — §3.5) · 발급/만료/버전 · 상태 배지 · 마이크로프린트.
 *   - 오른쪽: 소속 · 식별자 · 서명(게시됨이면 머리에 보조 동작 `다시 서명` — v3 의 수동 재서명, 스위치와 별개) · 공개 문서 · 기술 정보.
 *     아래: 변경 이력(신원 블록).
 * 값 요소는 `.idc-v`(측정기가 데이터로 뺀다). 워터마크·도장 글은 CSS `content` 가 아니라 DOM 요소다 — 스타일시트 해시가 두 언어에서
 * 같아야 하고, 사전이 번역해야 해서. 유채색은 이 카드와 썸네일(`.idthumb`)에만 있다(스타일시트 · C1–C5).
 */

import { copyBtn, icon, P, secHead, tip, viewHead } from '../kit';
import { LOGO } from '../../page';

/** 공개 신원 ⓘ(§8 I2 · §3.4 D2) — 코드(`buildPassportDocument`) 기준 사실. */
const IDENTITY_TIP =
  P('받는 쪽이 이 주소가 정말 이 조직의 에이전트인지 확인하는 공개 문서입니다.') +
  P('공개: 공개키(did.json), 이름·주소·등록 월·검증 배지·유효 기간·상태(passport).') +
  P('공개 문서에 없는 것: 조직 이름, 목록 내용, 수치, 메일. 서명은 Atmark 서명 작업이 하고(보통 1분), 서명은 90일 동안 유효합니다. 개인키는 이 화면에 오지 않습니다.');

/** 신원 변경 이력 ⓘ — 블록 = 투명성 로그의 잎 하나. 체인 규칙 · 포함 증명 · 표시 값의 출처. */
const BLOCKS_TIP =
  P('블록 하나는 투명성 로그의 잎 하나입니다. 블록 해시 = SHA-256(이전 블록 해시 ‖ 잎 해시)라서 앞 블록이 바뀌면 뒤의 해시가 모두 달라집니다.') +
  P('체크포인트에 든 블록은 포함 증명을 내려받아 <code>pnpm log:verify</code>로 확인합니다. 이름·주소는 잎에 커밋으로만 있고, 화면의 값은 DB에서 읽어 그 커밋과 대조합니다.');

const CONSOLE_ONLY = `<span class="conly">${icon('eyeoff')}<span>콘솔에서만 보임</span></span>`;

/** 신원 공개 스위치(§3.6) — 상태에 따라 켜짐/꺼짐/잠김/처리 중. 아래 한 줄은 스크립트가 상태에 맞춰 적는다. */
const SWITCH =
  '<div class="idsw"><div class="idsw-r"><span class="idsw-l" id="id-sw-l">신원 공개</span>' +
  '<button type="button" class="switch" id="id-switch" role="switch" aria-checked="false" aria-labelledby="id-sw-l" aria-describedby="id-sw-line"><span class="knob" aria-hidden="true"></span></button>' +
  '<span class="small strong" id="id-sw-st"></span></div>' +
  '<p class="small muted" id="id-sw-line"></p></div>';

const ID_CARD =
  '<div class="idw"><article class="idc" id="idc" aria-labelledby="idc-name">' +
  `<div class="idc-h"><div class="idc-org"><span class="idc-l">소속</span><span class="idc-on"><span class="idc-v" id="idc-org">—</span>${icon('eyeoff')}<span class="sr">콘솔에서만 보임</span></span></div>${LOGO}</div>` +
  '<p class="idc-k">에이전트 신원</p>' +
  '<div class="idc-art" id="idc-art"><svg class="idc-svg" id="idc-svg" viewBox="0 0 100 100" role="img" aria-label="신원 무늬" focusable="false"></svg></div>' +
  '<p class="idc-v idc-name" id="idc-name">—</p>' +
  '<p class="idc-v idc-addr" id="idc-addr">—</p>' +
  '<p class="idc-did"><span class="mono idc-v" id="ai-did">—</span>' +
  '<span class="seal" id="idc-seal" hidden><svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25"/><path d="M5.25 8.25l1.9 1.9 3.6-3.9"/></svg><span>서명됨</span></span></p>' +
  '<div class="idc-row"><dl class="idc-aux">' +
  '<div><dt>발급일</dt><dd class="idc-v num" id="idc-issued">—</dd></div>' +
  '<div><dt>만료</dt><dd class="idc-v num" id="idc-until">—</dd></div>' +
  '<div><dt>버전</dt><dd class="idc-v num" id="idc-ver">—</dd></div>' +
  '</dl><span class="idc-badge idc-v" id="idc-badge"></span></div>' +
  '<p class="micro" id="idc-micro" aria-hidden="true"></p>' +
  '<span class="wm" id="ai-wm" aria-hidden="true" hidden>게시 전 · DRAFT</span>' +
  '<span class="stamp" id="ai-stamp" aria-hidden="true" hidden>폐기됨 · REVOKED</span>' +
  '</article></div>';

const ID_INFO =
  '<div class="idinfo">' +
  '<p class="small" id="ai-pending" role="status" hidden></p>' +
  '<p class="msg" id="ai-msg" role="status"></p>' +
  '<section class="idsec" aria-labelledby="h-id-org">' +
  secHead('h-id-org', '소속', tip('id-org', '소속 설명', P('이 이름은 공개 문서에 들어가지 않습니다. 받는 쪽은 did.json과 패스포트만 봅니다.'))) +
  `<p class="idorg"><span class="strong" id="ai-org">—</span>${CONSOLE_ONLY}</p></section>` +
  '<section class="idsec" aria-labelledby="h-id-ids">' +
  secHead('h-id-ids', '식별자') +
  '<dl class="kv">' +
  `<dt>DID</dt><dd class="cpr"><span class="mono" id="ai-did-v">—</span>${copyBtn('ai-did-copy', 'DID 복사')}</dd>` +
  '<dt>주소</dt><dd id="ai-addr">—</dd>' +
  `<dt>에이전트 ID</dt><dd class="cpr"><span class="mono" id="ai-agent">—</span>${copyBtn('ai-agent-copy', 'ID 복사')}</dd>` +
  '</dl></section>' +
  '<section class="idsec" aria-labelledby="h-id-sig">' +
  secHead('h-id-sig', '서명 정보', '', '<button type="button" class="btn sm ghost" id="ai-resign" hidden>다시 서명</button>') +
  '<dl class="kv"><dt>패스포트</dt><dd id="ai-pp">—</dd><dt>공개키</dt><dd class="mono" id="ai-key">—</dd><dt>JWS 지문</dt><dd class="mono" id="ai-jws">—</dd></dl></section>' +
  '<section class="idsec" aria-labelledby="h-id-docs">' +
  secHead('h-id-docs', '공개 문서') +
  // 공개 설정은 이 절의 한 줄(F69 — 페이지 머리에 혼자 있던 스위치).
  SWITCH +
  '<ul class="idc-links" id="ai-links">' +
  '<li id="ai-did-li" hidden><a id="ai-did-a" target="_blank" rel="noopener noreferrer">did.json' + icon('arrowUpRight') + '</a></li>' +
  '<li id="ai-pp-li" hidden><a id="ai-pp-a" target="_blank" rel="noopener noreferrer">passport.json' + icon('arrowUpRight') + '</a></li>' +
  '<li id="ai-jws-li" hidden><a id="ai-jws-a" target="_blank" rel="noopener noreferrer">passport.jws' + icon('arrowUpRight') + '</a></li></ul>' +
  '<p class="small muted" id="ai-nolinks">게시 전입니다.</p></section>' +
  '<details class="tech"><summary>기술 정보</summary><dl class="kv">' +
  '<dt>처음 게시</dt><dd id="ai-at">—</dd><dt>서명</dt><dd id="ai-issued">—</dd><dt>만료</dt><dd id="ai-until">—</dd>' +
  '<dt>내용 해시</dt><dd id="ai-hash" class="mono">—</dd><dt>마지막 처리</dt><dd id="ai-last">—</dd></dl></details>' +
  '</div>';

export const A_IDENTITY =
  '<div class="pane" id="t-identity" hidden>' +
  viewHead('h-ag-identity', '신원', { tip: tip('identity-a', '공개 신원 설명', IDENTITY_TIP) }) +
  `<div class="idlay">${ID_CARD}${ID_INFO}</div>` +
  '<section class="ib" id="ib" aria-labelledby="h-ib">' +
  secHead('h-ib', '변경 이력', tip('blocks', '변경 이력 설명', BLOCKS_TIP), '<button type="button" class="btn sm ghost" id="ib-dl" disabled>내려받기</button>') +
  '<p class="small muted" id="ib-empty" hidden>변경 이력이 없습니다.</p>' +
  '<ol class="chain" id="ib-list"></ol>' +
  '<p class="msg" id="ib-msg" role="status"></p>' +
  '</section>' +
  '</div>';
