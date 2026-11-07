/**
 * src/admin/ui/console/script/plan.ts — 앱 스크립트 조각: 설정 "요금제 · 사용량"(과금 P0, ADR-0011) · 결제(WP-2) · 한도 초과 배너 · 에이전트 수 분모.
 *
 * `GET /api/plan`(한도·사용량 — 무변경)과 `GET /api/billing`(결제 상태 — 계획 §3-8)을 함께 읽는다. 숫자·요금제 코드·날짜는 `textContent` 로만.
 * 활성 조직의 에이전트 분모는 요금제 한도(비활성 제외), 검토 전 조직은 서버 상수 `L.pending`.
 *
 * 결제(D-5 — owner·admin): "업그레이드" 는 `/api/billing` 이 열려 있다고 할 때만 풀린다 — 읽지 못하면(404·503·네트워크) 지금처럼 잠긴다.
 * 누르면 `POST /api/billing/checkout {plan}` → 서버가 Paddle 거래를 만들고(조직 id 는 서버가 넣는다) `https://pay.atmark.ai/?_ptxn=…` 를 준다 —
 * 모양을 확인한 뒤에만 그 주소로 옮긴다. **콘솔은 결제 스크립트를 싣지 않는다**(CSP 불변). "결제 관리" 는 포털 세션 URL(임시 — 저장하지 않는다)로 옮긴다.
 * 결제에서 돌아오면(`?billing=return`) 5초 간격으로 6번까지 다시 읽는다(웹훅 → sync 가 반영하는 동안). 그동안(구독이 보이기 전) "업그레이드" 는
 * 잠기고 ⓘ 는 "처리 중" 이다 — 방금 낸 결제가 반영되기 전에 두 번째 결제를 만들지 않게(코드 검토 M-8). 서버도 결제된 열린 거래를 보고 409 로 막는다.
 */

export const PLAN_JS = String.raw`/* ---------- plan & usage (ADR-0011) ---------- */
var PLAN_NAME={free:'Free',beta:'Beta',pro:'Pro',team:'Team',scale:'Scale'};
var PLAN_OVER={agents:'에이전트',agents_total:'에이전트(전체)',org_keys:'조직 API 키',tokens:'에이전트 토큰',aliases:'별칭 주소'};
function planN(v){return typeof v==='number'&&isFinite(v)?v:null;}
/* /api/me carries a summary (S.planBrief: code · maxAgents · overLimit) — the denominator and the banner need no extra request at boot. */
function agentLim(){if(S.review!=='active')return L.pending;
  var m=S.plan?planN(S.plan.limits.maxAgents):S.planBrief?planN(S.planBrief.maxAgents):null;return m===null?'—':m;}
function planBanner(list){var over=arr(list).filter(function(x){return typeof x==='string'&&PLAN_OVER[x];});$('pl-banner').hidden=!over.length;return over;}
/* The plan view reads the plan (limits and usage) and billing together. Billing never fails the section: unreadable billing = locked (as before). */
function loadPlan(){billReturnCheck();return Promise.all([loadBilling(),api('GET','/api/plan').then(function(j){
  S.plan=obj(j)&&obj(j.plan)&&obj(j.limits)&&obj(j.usage)?j:null;renderPlan();})]);}
function renderPlan(){var P=S.plan,tb=$('pl-body');clear(tb);
  if(!P){clear($('pl-body2'));txt('pl-name','—');txt('pl-cap','');$('pl-over').hidden=true;$('pl-grace').hidden=true;return;}
  var p=P.plan,l=P.limits,u=P.usage,code=typeof p.code==='string'?p.code:'',tb2=$('pl-body2');clear(tb2);
  txt('pl-name',(PLAN_NAME[code]||str(code,20)||'—')+(p.basis==='missing'?' · 기본':p.basis==='grace_expired'?' · 유예 끝남':p.basis==='table_missing'?' · 도입 전 한도':''));
  var g=p.basis==='row'&&typeof p.graceUntil==='string';$('pl-grace').hidden=!g;txt('pl-grace',g?fmt('유예 끝: {t}',{t:kst(p.graceUntil)}):'');
  function lim(limit){return limit===null?'—':typeof limit==='string'?limit:grp(limit);}
  function row(label,used,limit){var tr=el('tr');cell(tr,'항목').textContent=label;
    var a=cell(tr,'사용');a.className='cv num';a.textContent=used===null?'—':grp(used);
    var b=cell(tr,'한도');b.className='cv num';b.textContent=lim(limit);tb.appendChild(tr);}
  /* per agent / per message: a limit with no usage - its own small table (F55) */
  function row2(label,limit){var tr=el('tr');cell(tr,'에이전트 · 메일마다').textContent=label;var b=cell(tr,'한도');b.className='cv num';b.textContent=lim(limit);tb2.appendChild(tr);}
  var att=planN(l.attachmentBytesTotalMax);
  row('에이전트(삭제한 것 제외)',planN(u.agents),planN(l.maxAgents));
  row('에이전트(전체)',planN(u.agentsTotal),planN(l.agentsTotalMax));
  row('조직 하루 수신자',planN(u.recipientsLastDay),planN(u.dailyCap));
  row('조직 API 키',planN(u.orgKeys),planN(l.orgApiKeysMax));
  row2('에이전트당 토큰',planN(l.tokensPerAgentMax));
  row2('에이전트당 웹훅',planN(l.webhookEndpointsPerAgentMax));
  row2('에이전트 분당 발송',planN(l.agentPerMinuteMax));
  row2('에이전트 하루 발송',planN(l.agentPerDayMax));
  row2('메일당 수신자',planN(l.recipientsPerMessageMax));
  if(!(obj(P.features)&&P.features.addressAliases===false))row2('에이전트당 별칭 주소',planN(l.aliasesPerAgentMax));
  row2('메일당 첨부 용량',att===null?null:grp(Math.floor(att/1048576))+' MB');
  var cap=planN(u.dailyCap);txt('pl-cap',u.dailyCapReason==='plan_daily_cap'?'오늘 하루 한도는 요금제가 정합니다.':cap===null?'새 조직은 하루 발송량을 단계적으로 늘립니다. 요금제를 올려도 앞당겨지지 않습니다.':
    fmt('새 조직은 하루 발송량을 단계적으로 늘립니다(오늘 상한 수신자 {n}명). 요금제를 올려도 앞당겨지지 않습니다.',{n:grp(cap)}));
  var over=planBanner(P.overLimit);$('pl-over').hidden=!over.length;txt('pl-over-d',over.map(function(x){return PLAN_OVER[x];}).join(' · '));}

/* ---------- billing (WP-2, owner + admin): the server creates the Paddle transaction; the console only moves to pay.atmark.ai ---------- */
var PAID={pro:1,team:1,scale:1};
/* lockedReason (GET /api/billing) -> the one line in the upgrade toggletip. Unknown or missing -> "not ready yet". Fixed phrases, not data. */
var BILL_WHY_TEXT={off:'결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.',
  beta:'베타 기간에는 결제가 열리지 않습니다. 베타 요금제는 무료입니다.',
  review:'운영자 검토가 끝난 조직만 결제할 수 있습니다.',
  sub:'이미 구독이 있습니다. 결제 관리에서 확인하세요.',
  higher:'지금 한도보다 모든 항목이 넓은 요금제가 없습니다. 한도를 바꾸려면 운영자에게 요청하세요.',
  sandbox:'이 조직은 시험 결제 대상이 아닙니다.',
  open:'가격은 결제 화면에서 확인합니다. 결제는 pay.atmark.ai에서 Paddle이 처리하고, 끝나면 이 화면으로 돌아옵니다.',
  wait:'결제를 처리하는 중입니다. 반영되면 이 화면에 나타납니다.'};
var BILL_WHY={disabled:'off',not_configured:'off',beta:'beta',not_active:'review',subscription_exists:'sub',no_higher_plan:'higher',sandbox_not_allowed:'sandbox'};
var BILL_STATUS={active:'구독 중',trialing:'체험 중',past_due:'결제 실패',paused:'일시정지',canceled:'해지됨'};
/* The only places the console will navigate to for billing: our checkout page with a transaction id, and a Paddle customer portal. */
var PAY_URL=/^https:\/\/pay\.atmark\.ai\/(kr)?\?_ptxn=txn_[a-z0-9]{26}$/;
var PORTAL_URL=/^https:\/\/([a-z0-9-]+\.)*paddle\.com\/[\x21-\x7e]*$/;
var BILL_POLL={n:0,max:6,ms:5000,on:false};
function loadBilling(){return api('GET','/api/billing').then(function(j){S.bill=obj(j)?j:null;},function(){S.bill=null;}).then(renderBilling);}
function billWhy(k){txt('bl-why',BILL_WHY_TEXT[k]);}
function billOpenPlans(B){return arr(B&&B.plans).filter(function(p){return obj(p)&&p.available===true&&PAID[p.code]===1;});}
/* Just back from checkout and the subscription is not visible yet: no second checkout, "processing" in the toggletip. */
function billWaiting(){return BILL_POLL.on&&!billSettled();}
function renderBilling(){var B=S.bill,on=!!(B&&B.enabled===true),manage=can('admin')&&!!(B&&B.canManage===true),wait=on&&manage&&billWaiting();
  var plans=on&&manage&&!wait&&B.upgradeAvailable===true?billOpenPlans(B):[],open=plans.length>0,pick=$('bl-pick');
  clear(pick);plans.forEach(function(p){var o=el('option',null,PLAN_NAME[p.code]);o.value=p.code;pick.appendChild(o);});
  pick.value=open?plans[0].code:'';$('bl-pick-w').hidden=!open;
  /* member: no billing controls at all (D-5). owner and admin: the upgrade button stays, locked with the reason in the toggletip. */
  var member=!can('admin');$('bl-member').hidden=!(on&&member);
  $('pl-upgrade').hidden=on&&member;$('tipb-upgrade').hidden=on&&member;$('pl-upgrade').disabled=!open;
  billWhy(wait?'wait':open?'open':!on?'off':BILL_WHY[B.lockedReason]||(B.upgradeAvailable===true?'higher':'off'));
  $('bl-portal').hidden=!(on&&manage&&B.portalAvailable===true);
  var s=on&&obj(B.subscription)?B.subscription:null,st=s&&typeof s.status==='string'?s.status:'';
  $('bl-sub').hidden=!s;
  if(s){var sc=obj(s.scheduledChange)?s.scheduledChange:null,parts=[(PLAN_NAME[s.plan]||'—')+' · '+(BILL_STATUS[st]||'—')];
    if(sc&&sc.action==='cancel')parts.push(fmt('해지 예정: {t}',{t:kst(sc.at)}));
    else if(st!=='canceled'&&typeof s.currentPeriodEnd==='string')parts.push(fmt('다음 결제: {t}',{t:kst(s.currentPeriodEnd)}));
    txt('bl-sub',parts.join(' · '));}else txt('bl-sub','');
  var due=st==='past_due';$('bl-due').hidden=!due;
  txt('bl-due-d',due&&typeof s.graceUntil==='string'?fmt('{t}까지 결제 수단을 고치지 않으면 Free로 바뀝니다.',{t:kst(s.graceUntil)}):'');}
/* Coming back from pay.atmark.ai (?billing=return): the webhook -> sync path takes a few seconds, so read again every 5 s, at most 6 times. */
function billReturnCheck(){if(BILL_POLL.on||!/(^|[?&])billing=return(&|$)/.test(String(location.search||'')))return;BILL_POLL.on=true;billPoll();}
function billSettled(){var s=S.bill&&obj(S.bill.subscription)?S.bill.subscription:null;return !!(s&&(s.status==='active'||s.status==='trialing'));}
function billPoll(){if(BILL_POLL.n>=BILL_POLL.max)return;BILL_POLL.n++;
  setTimeout(function(){loadPlan().then(function(){if(!billSettled())billPoll();},function(){billPoll();});},BILL_POLL.ms);}
$('pl-upgrade').addEventListener('click',function(){var b=this,plan=$('bl-pick').value;if(PAID[plan]!==1||!can('admin')||billWaiting())return;
  run(b,'bl-msg',function(){return api('POST','/api/billing/checkout',{plan:plan}).then(function(j){var u=obj(j)&&typeof j.url==='string'?j.url:'';
    if(!PAY_URL.test(u))throw new ApiError(502,'billing_unavailable',null);say('bl-msg','결제 화면으로 이동합니다.');location.href=u;});});});
$('bl-portal').addEventListener('click',function(){var b=this;if(!can('admin'))return;
  run(b,'bl-msg',function(){return api('POST','/api/billing/portal').then(function(j){var u=obj(j)&&typeof j.url==='string'?j.url:'';
    if(!PORTAL_URL.test(u))throw new ApiError(502,'billing_unavailable',null);say('bl-msg','결제 관리 페이지로 이동합니다.');location.href=u;});});});
`;
