/**
 * src/admin/ui/console/script/ai-watch.ts — 앱 스크립트 조각: 설정 "AI 의심 메일 감시"(ADR-0017 · 마크업 `markup/ai-watch.ts`).
 *
 *   - 섹션을 열 때 `GET /api/settings/ai-watch` → `{feature, enabled}`. `feature:false` = 잠김(베타 안내 한 장, 스위치 없음).
 *     단, 이미 켜진 채 허용 목록에서 빠진 조직은 끌 수 있어야 하므로 `enabled:true` 면 스위치를 보인다.
 *   - 켜기 = 소유자만 · 확인 대화상자(무엇을 어디로 보내는지 · 경고만 · 언제든 끔). 끄기 = 관리자 이상 · 즉시.
 *   - `PATCH /api/settings/ai-watch {enabled}` → `{feature, enabled, changed}`. 403 `feature_not_enabled` 면 잠김으로 다시 그린다.
 * 글자는 전부 `textContent`(마크업에 사전 문구만).
 */

export const AI_WATCH_JS = String.raw`/* ---------- AI suspicious-mail watch (ADR-0017): a warning-only signal. On = owner + one confirm; off = admin, at once. ---------- */
function awOf(j){j=obj(j)?j:{};return {feature:j.feature===true,enabled:j.enabled===true};}
function loadAiWatch(){say('aw-msg','');return api('GET','/api/settings/ai-watch').then(function(j){S.aw=awOf(j);renderAiWatch();});}
function renderAiWatch(){var x=S.aw,b=$('aw-switch');
  if(!x){$('aw-open').hidden=true;$('aw-locked').hidden=true;return;}
  var open=x.feature||x.enabled;$('aw-open').hidden=!open;$('aw-locked').hidden=open;if(!open)return;
  b.setAttribute('aria-checked',x.enabled?'true':'false');b.removeAttribute('aria-busy');
  txt('aw-st',x.enabled?'켜짐':'꺼짐');
  /* who may flip it: on = owner, off = admin and up (the server decides again) */
  var may=x.enabled?can('admin'):can('owner')&&x.feature;
  if(may){b.removeAttribute('aria-disabled');b.title='';}
  else{b.setAttribute('aria-disabled','true');b.title=x.enabled?ROLE_WHY.admin:!x.feature?'':ROLE_WHY.owner;}
  txt('aw-line',x.enabled?'수신 로그에 AI 의심 표시가 붙습니다. 언제든 끌 수 있습니다.':
    !x.feature?'이 조직은 이 기능을 다시 켤 수 없습니다.':can('owner')?'켜기 전에 처리 내용을 한 번 확인합니다.':'소유자만 켤 수 있습니다.');}
function awSet(on){var b=$('aw-switch');b.setAttribute('aria-busy','true');say('aw-msg','');
  return api('PATCH','/api/settings/ai-watch',{enabled:on}).then(function(j){S.aw=awOf(j);renderAiWatch();
    say('aw-msg',on?'켰습니다. 이제부터 받는 메일에 적용됩니다.':'껐습니다.','ok');},
  function(e){b.removeAttribute('aria-busy');
    if(e instanceof ApiError&&e.code==='feature_not_enabled'){S.aw={feature:false,enabled:false};renderAiWatch();say('aw-msg','이 조직에는 이 기능이 열려 있지 않습니다.','err');return;}
    sectionErr('aw-msg')(e);});}
$('aw-switch').addEventListener('click',function(){var x=S.aw;if(!x||this.getAttribute('aria-disabled')==='true'||this.getAttribute('aria-busy')==='true')return;
  if(x.enabled){awSet(false);return;}
  ask({kicker:'AI 의심 메일 감시 켜기',title:'AI 의심 메일 감시를 켤까요?',ok:'켜기',
    body:['받은 메일의 제목과 본문 일부(최대 4,000자)만 Atmark가 운영하는 장비의 분류 모델로 검사합니다. 주소 · 다른 헤더 · 첨부는 보내지 않습니다. 전송 중에는 암호화된 채 최대 5분 기다릴 수 있고, 처리 뒤에는 보관하지 않습니다.',
      '에이전트를 조종하려는 지시처럼 보이면 경고를 붙입니다. 메일을 막거나 지우지 않고, 오탐도 있습니다.',
      '검사를 기다리는 동안 메일이 최대 30초 늦게 보일 수 있습니다. 언제든 끌 수 있습니다.']})
  .then(function(y){if(y)awSet(true);});});
`;
