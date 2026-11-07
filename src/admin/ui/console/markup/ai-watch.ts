/**
 * src/admin/ui/console/markup/ai-watch.ts — 감시 > 메일 > "AI 의심 메일 감시"(ADR-0017 · 설계 §7.3). 2026-10-08 설정 > 운영에서 감시 탭으로 옮겼다 —
 * 예전 설정 경로(섹션 aiwatch)는 `#/watch/ai` 로 리다이렉트한다(라우터). 조작부 id(`aw-*`)는 그대로다.
 *
 * 한 칸에 두 모습(스크립트 `showAiWatch` 가 `GET /api/settings/ai-watch` 의 `feature` 로 고른다):
 *   - 열림 — 스위치 한 개(`role="switch"`, 신원 공개 스위치와 같은 부품) + 상태 한 줄. 켜기는 소유자만 · 확인 대화상자 한 번(데이터 처리 고지).
 *     끄기는 관리자도 · 즉시.
 *   - 잠김 — 운영자 허용 목록에 없는 조직. 도메인 잠김과 같은 조용한 상태 한 장(파는 문구 · 단추 없음).
 *
 * 문구 규칙(설계 §4.3 · copy-guard): **경고만 붙인다 · 막지 않는다 · 판정하지 못하면 그대로 전달된다.** "막는다 · 보호한다 · 전부 잡는다" 류는 쓰지
 * 않는다. 설명 한 줄에 "운영자 장비에서 분석" 고지를 둔다(진윤겸 결정 Q2 — 처리방침 항목은 따로 없다). 모델 · 제공사 이름은 쓰지 않는다.
 */

import { P, settingsRow, tip } from '../kit';

const AI_WATCH_TIP = tip(
  'aiwatch',
  'AI 의심 메일 감시 설명',
  P('받은 메일 본문 일부를 Atmark가 운영하는 장비의 분류 모델로 검사해, 에이전트를 조종하려는 지시처럼 보이면 경고를 붙입니다. 메일을 막거나 지우지 않습니다.') +
    P('검사는 최대 30초 걸립니다. 그 안에 끝나지 않으면 경고 없이 전달되고, 수신 로그에 "판정 없음"으로 남습니다.') +
    P('제목과 본문 일부만 보내고 주소 · 다른 헤더 · 첨부는 보내지 않습니다. 전송 중 암호화된 채 최대 5분 기다릴 수 있고, 처리 뒤에는 보관하지 않습니다. 기본 보호(수신 정책 · 위험 보류 · 발신 검사)는 항상 켜져 있습니다.'),
);

/** 허용 목록에 없는 조직 — 조용한 상태 한 장(도메인 `dm-locked` 와 같은 모양). */
const AI_WATCH_LOCKED =
  '<div class="dlock" id="aw-locked" hidden>' +
  '<span class="pill tag">베타</span>' +
  '<p class="dlock-t">초대받은 조직에만 열려 있는 기능입니다</p>' +
  '<p>열리면 여기에서 켜고 끌 수 있습니다.</p>' +
  '</div>';

/** 스위치 + 상태 한 줄. 아래 줄은 스크립트가 상태(켜짐 · 꺼짐 · 역할)에 맞춰 적는다. */
const AI_WATCH_SWITCH =
  '<div class="idsw aw-sw" id="aw-open" hidden><div class="idsw-r"><span class="idsw-l" id="aw-sw-l">AI 의심 메일 감시</span>' +
  '<button type="button" class="switch" id="aw-switch" role="switch" aria-checked="false" aria-labelledby="aw-sw-l" aria-describedby="aw-line"><span class="knob" aria-hidden="true"></span></button>' +
  '<span class="small strong" id="aw-st"></span></div>' +
  '<p class="small muted" id="aw-line"></p></div>';

export const AI_WATCH_SECTION = settingsRow(
  'w-ai',
  'h-w-ai',
  'AI 의심 메일 감시',
  AI_WATCH_TIP,
  '경고만 붙이고 막지 않습니다. 제목과 본문 일부를 운영자 장비에서 분석합니다.',
  AI_WATCH_SWITCH + AI_WATCH_LOCKED,
  '<p class="msg" id="aw-msg" role="status"></p>',
);
