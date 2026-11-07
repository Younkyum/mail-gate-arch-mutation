/**
 * src/admin/ui/console/script/watch.ts — 앱 스크립트 조각: 감시 탭(`#/watch/{section}` · 마크업 `markup/watch.ts` · API `src/admin/routes/watch.ts`).
 *
 *   - 보류된 메일: `GET /api/watch/held?limit&agentId&cursor` → 표(등급 표식 · 이유 · 보낸 사람 도메인 + 인증 · 받은 시각) · `더 보기` ·
 *     `풀어 주기`(관리자 · 확인 대화상자 — 차단 등급은 확인란까지) → `POST /api/watch/held/{id}/release`. 풀 수 없는 행은 이유 한 줄.
 *   - 에이전트별 설정: 불러온 에이전트마다 `GET /api/agents/{id}/watch`(줄 세우기는 `api` 의 동시 2개 규율) → 표 · `변경`(관리자) → 대화상자 →
 *     **바뀐 칸만** `PATCH`. 일괄 읽기 API 가 없어 에이전트 수만큼 읽는다(보고: API 빈칸).
 *   - 조직 설정(신뢰 발신자 · 자가 등록 · 알림 둘): `GET /api/watch/settings` 한 번을 세 섹션이 같이 쓴다. 바꾸기는 **소유자만** —
 *     `PATCH {trustedSenders}`(목록 통째로) 또는 조직 칸만(서버가 둘을 한 요청에 섞지 않는다).
 *   - 가입한 곳: `GET /api/watch/signups?limit&agentId&cursor` · 알림 스위치(`notifyOnSignup`).
 *   - AI 의심 메일 감시: `ai-watch.ts` 그대로(섹션만 이 탭으로 옮겼다).
 * 섹션 데이터는 그 섹션을 열 때 읽는다(감시에 머무는 동안 한 번 · 떠났다 오면 다시 — 설정과 같은 규율). 글자는 전부 `textContent`.
 */

import { TRUSTED_SENDER_FREEMAIL_DOMAINS } from '../../../../watch/settings';

export const WATCH_JS = String.raw`/* ---------- watch tab (2026-10-08): held mail, trusted senders, AI watch, per-agent settings, sign-ups, self-enroll ---------- */
var WATCH_HEAD={held:'h-w-held',trusted:'h-w-trusted',ai:'h-w-ai',agents:'h-w-agents',signups:'h-w-signups',enroll:'h-w-enroll'};
var WPAGE=50;
var LVL={block:['차단','lvl lvl-block'],risk:['위험','lvl lvl-risk']};
var HELD_WHY={injection_risk:'인젝션 의심',scanner_error:'검사 실패',risk_hold:'위험 보류'};
var FAMILY={override:'지시 덮어쓰기',ai_addressee:'AI에게 건네는 말',prompt_reference:'프롬프트 언급',prompt_leak:'프롬프트 빼내기',role_spoof:'역할 사칭',
  jailbreak:'제한 풀기 시도',concealment:'숨긴 글자',exfiltration:'정보 빼내기',agent_action:'에이전트 동작 지시',tool_invocation:'도구 호출',authority:'권위 사칭',
  encoded:'인코딩된 글',technique:'알려진 공격 기법',obfuscation:'글자 비틀기',evasion:'탐지 피하기',narrative:'서술형 지시',scan_limit:'끝까지 검사하지 못함'};
var SIGNUP_KIND={verification:'인증 메일',welcome:'환영 메일',account_created:'계정 생성'};
var RISK_HANDLING={deliver:'바로 전달',hold:'보류 후 확인'},SEND_APPROVAL={auto:'자동',always:'모두 내 승인'};
var FREEMAIL=${JSON.stringify([...TRUSTED_SENDER_FREEMAIL_DOMAINS])};
var WDOMAIN=/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
var HM={items:[],next:null,agent:'',loaded:false,seq:0};
var SG={items:[],next:null,agent:'',loaded:false,seq:0};
var PA={list:null,next:null,set:{},err:{},btn:{}};

/* the watch menu: the route's section is the current page; as a phone tab row it keeps the current tab in view (same as settings). */
function wMark(k){WATCH_SECTIONS.forEach(function(s){var x=$('nw-'+s);if(s===k)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  var n=$('wnav'),a=$('nw-'+k);if(!a||!n||!(n.scrollWidth>n.clientWidth)||!a.getBoundingClientRect)return;
  var nb=n.getBoundingClientRect(),ab=a.getBoundingClientRect();if(ab.left<nb.left||ab.right>nb.right)n.scrollLeft+=ab.left-nb.left-(nb.width-ab.width)/2;}
/* one section per screen; its data is read when it is shown - once per visit to the watch tab (a failed read tries again on the next open). */
function showWatch(r,prev){var k=WATCH_SECTIONS.indexOf(r.section)>=0?r.section:WATCH_SECTIONS[0];
  if(prev.view!=='watch'||!S.wSeen){S.wSeen={};S.wsSeen=false;}var first=!S.wSeen[k];S.wSeen[k]=true;
  WATCH_SECTIONS.forEach(function(s){$('w-'+s).hidden=s!==k;});wMark(k);
  if(k==='held'){wAgentOptions('hm-agent',HM.agent);renderHeld();if(first||!HM.loaded)loadHeld(false).catch(sectionErr('hm-msg'));}
  else if(k==='trusted'){renderTrusted();if(wsNeed())loadWatchSettings().catch(function(e){S.wsSeen=false;sectionErr('wt-msg')(e);});}
  else if(k==='ai'){renderAiWatch();if(first||!S.aw)loadAiWatch().catch(sectionErr('aw-msg'));}
  else if(k==='agents'){if(first||!PA.list)loadWatchAgents();else renderWatchAgents();}
  else if(k==='signups'){wAgentOptions('su-agent',SG.agent);renderSignupNotify();renderSignups();
    if(wsNeed())loadWatchSettings().catch(function(e){S.wsSeen=false;sectionErr('su-msg')(e);});if(first||!SG.loaded)loadSignups(false).catch(sectionErr('su-msg'));}
  else if(k==='enroll'){renderEnroll();if(wsNeed())loadWatchSettings().catch(function(e){S.wsSeen=false;sectionErr('we-msg')(e);});}}
/* the agent filter (held mail, sign-ups): every loaded agent; a filter whose agent is gone falls back to all. */
function wAgentOptions(id,cur){var s=$(id);clear(s);var o=el('option',null,'모든 에이전트');o.value='';s.appendChild(o);
  S.agents.forEach(function(a){var x=el('option',null,str(a.name,80)||a.id);x.value=a.id;s.appendChild(x);});s.value=cur&&agentById(cur)?cur:'';}
function wNext(j){return typeof j.nextCursor==='string'&&j.nextCursor?j.nextCursor:null;}
function lvlEl(level){var l=LVL[level];return l?el('span',l[1],l[0]):pillEl('없음','dim');}

/* ---------- held mail ---------- */
function okHeld(m){return obj(m)&&typeof m.id==='string'&&typeof m.agentId==='string';}
function heldUrl(cur){var q='/api/watch/held?limit='+WPAGE;if(HM.agent)q+='&agentId='+enc(HM.agent);if(cur)q+='&cursor='+enc(cur);return q;}
function loadHeld(more){var seq=++HM.seq;return api('GET',heldUrl(more?HM.next:'')).then(function(j){if(seq!==HM.seq)return;j=obj(j)?j:{};
  var items=arr(j.items).filter(okHeld);HM.items=more?HM.items.concat(items):items;HM.next=wNext(j);HM.loaded=true;renderHeld();});}
function famText(list){var f=arr(list).filter(function(x){return typeof x==='string';}).map(function(x){return FAMILY[x]||str(x,40);});return f;}
function senderNode(m){var w=el('span','sdr'),ok=m.senderAuthenticated===true,a=el('span','auth'+(ok?' on':''));
  w.appendChild(el('span','addr',clean(m.senderDomain,253)||'—'));
  if(ok)a.appendChild(ico('check'));a.appendChild(d.createTextNode(ok?'인증됨':'인증 안 됨'));w.appendChild(a);
  w.title=ok?'DMARC 인증을 통과한 보낸 사람입니다.':'인증되지 않았습니다. 도메인이 위조됐을 수 있습니다.';return w;}
function renderHeld(){if(!HM.loaded){txt('hm-count','—');return;}
  var tb=$('hm-body'),n=HM.items.length;clear(tb);txt('hm-count',fmt(HM.next?'{n}건 이상':'{n}건',{n:grp(n)}));
  $('hm-tbl').hidden=!n;$('hm-empty').hidden=n>0;$('hm-more').hidden=!HM.next;
  HM.items.forEach(function(m){tb.appendChild(heldRow(m));});}
function heldRow(m){var tr=el('tr'),fam=famText(m.families);
  var c=cell(tr,'에이전트');c.appendChild(el('span','strong',str(m.agentName,80)||'—'));
  cell(tr,'등급','status').appendChild(lvlEl(m.level));
  var r=cell(tr,'이유'),why=HELD_WHY[m.reason]||str(m.reason,40)||'—';
  r.textContent=fam.length?why+' · '+fam[0]+(fam.length>1?fmt(' 외 {n}',{n:fam.length-1}):''):why;if(fam.length)r.title=why+': '+fam.join(', ');
  cell(tr,'보낸 사람').appendChild(senderNode(m));
  timeCell(cell(tr,'시각'),m.receivedAt);
  var ac=el('td','act');tr.appendChild(ac);
  if(m.releasable===true){if(can('admin'))rowAct(ac,'풀어 주기',function(b){releaseHeld(m,b);});}
  else if(can('admin')){var no=button('풀어 주기','btn sm link',function(){});no.disabled=true;
    no.title=m.reason==='scanner_error'?'검사를 마치지 못한 메일은 안전하게 풀 수 없습니다.':'이 메일은 풀 수 없습니다.';no.setAttribute('aria-label',fmt('풀 수 없음: {r}',{r:no.title}));ac.appendChild(no);
    /* the reason stays visible too - a title alone never shows on touch */
    var why=el('span','small muted held-why',m.reason==='scanner_error'?'풀 수 없음: 검사 실패':'풀 수 없음');why.setAttribute('aria-hidden','true');ac.appendChild(why);}
  return tr;}
/* release: the agent will see the mail, and reading it puts its sends to new recipients under my approval. A block-level mail asks for a check too. */
function releaseHeld(m,b){var name=str(m.agentName,80)||'—',blk=m.level==='block';
  ask({kicker:'보류된 메일 풀어 주기',title:'이 메일을 풀어 줄까요?',danger:true,ok:'풀어 주기',
    body:[fmt('에이전트 {a}에게 {d}에서 온 메일이 보이게 됩니다. 풀어 준 메일은 다시 숨길 수 없습니다.',{a:name,d:clean(m.senderDomain,253)||'—'}),
      '에이전트가 이 메일을 읽으면, 그 뒤 처음 보내는 상대에게 가는 메일은 내 승인을 거칩니다.'],
    warn:m.senderAuthenticated===true?'':'보낸 사람이 인증되지 않았습니다. 도메인이 위조됐을 수 있습니다.',
    ack:blk?'차단 등급 메일인 것을 확인했습니다':''})
  .then(function(y){if(!y)return;say('hm-msg','');busy(b,true);
    return api('POST','/api/watch/held/'+enc(m.id)+'/release').then(function(j){
      HM.items=HM.items.filter(function(x){return x.id!==m.id;});renderHeld();landFocus('h-w-held');
      say('hm-msg',j&&j.replayed===true?'이미 풀린 메일입니다.':'풀어 줬습니다. 이제 에이전트에게 보입니다.','ok');},
    function(e){busy(b,false);say('hm-msg',human(e),'err',errMeta(e));
      /* the mail changed under us (released elsewhere, gone): read the list again so the row says what is true now */
      if(e instanceof ApiError&&(e.code==='message_not_held'||e.code==='message_not_found'))loadHeld(false).catch(function(){});});});}
$('hm-agent').addEventListener('change',function(){HM.agent=this.value;HM.loaded=false;HM.next=null;say('hm-msg','');loadHeld(false).catch(sectionErr('hm-msg'));});
$('hm-more').addEventListener('click',function(){run(this,'hm-msg',function(){return loadHeld(true);});});

/* ---------- organization watch settings (trusted senders, self-enroll, the two notices): one read, three sections; owner changes ---------- */
function wsOf(j){j=obj(j)?j:{};var cap=typeof j.enrollDailyCap==='number'&&j.enrollDailyCap>=1?Math.floor(j.enrollDailyCap):5;
  return {list:arr(j.trustedSenders).filter(function(t){return obj(t)&&typeof t.value==='string'&&(t.kind==='address'||t.kind==='domain');}),
    max:typeof j.maxTrustedSenders==='number'?j.maxTrustedSenders:200,enroll:j.agentSelfEnroll===true,cap:cap,
    capMax:typeof j.maxEnrollDailyCap==='number'&&j.maxEnrollDailyCap>=1?Math.floor(j.maxEnrollDailyCap):20,
    nEnroll:j.notifyOnEnroll!==false,nSignup:j.notifyOnSignup!==false};}
/* the organization settings are shared by three sections: read once per visit to the watch tab (and again after a failed read). */
function wsNeed(){if(!S.wsSeen||!S.ws){S.wsSeen=true;return true;}return false;}
function loadWatchSettings(){return api('GET','/api/watch/settings').then(function(j){S.ws=wsOf(j);renderTrusted();renderEnroll();renderSignupNotify();});}
function wsPatch(body,msg){return api('PATCH','/api/watch/settings',body).then(function(j){S.ws=wsOf(j);renderTrusted();renderEnroll();renderSignupNotify();return j;});}
/* a switch row (watch tab): state word, aria, lock + why. on/off come from the settings; only the owner may flip (the server decides again). */
function wSwitch(id,on,line){var b=$(id),own=can('owner'),ready=!!S.ws;b.setAttribute('aria-checked',on?'true':'false');b.removeAttribute('aria-busy');
  txt(id+'-st',ready?(on?'켜짐':'꺼짐'):'');
  if(ready&&own){b.removeAttribute('aria-disabled');b.title='';}else{b.setAttribute('aria-disabled','true');b.title=ready?ROLE_WHY.owner:'';}
  txt(id+'-line',!ready?'':own?line:'소유자만 바꿀 수 있습니다.');}
function wFlip(id,body,msg,done){var b=$(id);if(!S.ws||b.getAttribute('aria-disabled')==='true'||b.getAttribute('aria-busy')==='true')return;
  b.setAttribute('aria-busy','true');say(msg,'');
  wsPatch(body).then(function(){say(msg,done,'ok');},function(e){b.removeAttribute('aria-busy');sectionErr(msg)(e);});}

/* ---------- trusted senders ---------- */
function renderTrusted(){var W=S.ws,own=can('owner'),add=$('wt-add');$('wt-owner').hidden=own||!W;
  if(!W){txt('wt-count','—');add.disabled=true;gate(add,'owner');return;}
  var n=W.list.length,full=n>=W.max;txt('wt-count',n+' / '+W.max);add.disabled=!own||full;add.title=!own?ROLE_WHY.owner:full?CODES.too_many_trusted_senders:'';
  add.hidden=!own;var tb=$('wt-body');clear(tb);$('wt-tbl').hidden=!n;$('wt-empty').hidden=n>0;
  W.list.forEach(function(t){tb.appendChild(trustedRow(t,own));});}
function trustedRow(t,own){var tr=el('tr'),v=clean(t.value,320);
  cell(tr,'발신자').appendChild(t.kind==='address'?addrNode(v,false):el('span','addr',v));
  cell(tr,'종류').textContent=t.kind==='address'?'주소':'도메인';
  var c=cell(tr,'만든 날');c.className='cv num';c.textContent=fmtDate(t.createdAt);c.title=kst(t.createdAt);
  var ac=el('td','act');tr.appendChild(ac);if(own)rowAct(ac,'제거',function(b){removeTrusted(t,b);},fmt('{v} 제거',{v:v}));return tr;}
function trustedValues(){return S.ws?S.ws.list.map(function(t){return t.value;}):[];}
function removeTrusted(t,b){var v=clean(t.value,320);
  ask({kicker:'신뢰 발신자 제거',title:'이 신뢰 발신자를 제거할까요?',ok:'제거',list:[t.kind==='address'?addrNode(v,false):el('span','addr',v)],body:['이 발신자의 메일도 다시 인젝션 탐지를 거칩니다.']})
  .then(function(y){if(!y)return;return run(b,'wt-msg',function(){return wsPatch({trustedSenders:trustedValues().filter(function(x){return x!==t.value;})}).then(function(){
    say('wt-msg','신뢰 발신자에서 제거했습니다.','ok');landFocus('h-w-trusted');});});});}
/* the same shape rules as the server (parseTrustedSender): ASCII, lower case, an exact address or a domain - no wildcard. The server decides. */
function trustedParse(raw){var v=String(raw||'').trim().toLowerCase();if(!v||v.length>320||!/^[\x21-\x7e]+$/.test(v))return null;
  var at=v.lastIndexOf('@');if(at<0)return WDOMAIN.test(v)&&v.length<=253?{kind:'domain',value:v,domain:v}:null;
  var dom=v.slice(at+1),loc=v.slice(0,at);if(!loc||loc.length>64||loc.indexOf('@')>=0||!WDOMAIN.test(dom))return null;return {kind:'address',value:v,domain:dom};}
function freemail(dom){return FREEMAIL.indexOf(dom)>=0||/^gmx\.[a-z]{2,63}$/.test(dom);}
function freemailLine(dom){return fmt('{d} 도메인은 누구나 주소를 만들 수 있어 통째로 넣을 수 없습니다. 정확한 주소(name@{d})를 넣으세요.',{d:dom});}
function wtCheck(){$('wt-go').disabled=!$('wt-ack').checked;}
$('wt-ack').addEventListener('change',wtCheck);
$('wt-add').addEventListener('click',function(){if(!can('owner')||!S.ws)return;$('wt-in').value='';$('wt-ack').checked=false;wtCheck();say('wt-dmsg','');fieldErr($('wt-in'),'');
  $('dlg-wtrust').showModal();$('wt-in').focus();});
$('wt-cancel').addEventListener('click',function(){$('dlg-wtrust').close();});
$('wt-form').addEventListener('submit',function(ev){ev.preventDefault();if(!$('wt-ack').checked||!S.ws)return;var inp=$('wt-in'),p=trustedParse(inp.value);say('wt-dmsg','');
  if(!p){fieldErr(inp,CODES.invalid_trusted_sender);return;}
  if(p.kind==='domain'&&freemail(p.domain)){fieldErr(inp,freemailLine(p.domain));return;}
  if(trustedValues().indexOf(p.value)>=0){fieldErr(inp,CODES.rule_duplicate);return;}fieldErr(inp,'');
  var b=$('wt-go');busy(b,true);
  wsPatch({trustedSenders:trustedValues().concat([p.value])}).then(function(){busy(b,false);$('dlg-wtrust').close();say('wt-msg','신뢰 발신자로 넣었습니다.','ok');},
    function(e){busy(b,false);wtCheck();
      if(e instanceof ApiError&&e.code==='trusted_sender_freemail_domain'){fieldErr(inp,freemailLine(p.domain));return;}
      if(e instanceof ApiError&&e.code==='invalid_trusted_sender'){fieldErr(inp,CODES.invalid_trusted_sender);return;}
      say('wt-dmsg',human(e),'err',errMeta(e));});});

/* ---------- self-enroll ---------- */
function renderEnroll(){var W=S.ws,own=can('owner');
  wSwitch('we-switch',!!W&&W.enroll,W&&W.enroll?'토큰에 자가 등록 권한을 준 에이전트만 새 에이전트를 만들 수 있습니다.':'켜기 전에 무엇이 열리는지 한 번 확인합니다.');
  wSwitch('we-notify',!!W&&W.nEnroll,'새 에이전트가 생기면 소유자 메일로 알립니다.');
  txt('we-cap',W?fmt('{n}개 / 24시간',{n:W.cap}):'—');var ce=$('we-cap-edit');ce.disabled=!W||!own;ce.hidden=!!W&&!own;
  /* the scope is given per token: one agent -> its tokens page; several -> the agent list */
  var a=$('we-tokens');a.href=S.agents.length===1?routeHref({view:'agent',agent:S.agents[0].id,tab:'tokens'}):'#/agents';}
$('we-switch').addEventListener('click',function(){var W=S.ws;if(!W||this.getAttribute('aria-disabled')==='true'||this.getAttribute('aria-busy')==='true')return;
  if(W.enroll){wFlip('we-switch',{agentSelfEnroll:false},'we-msg','자가 등록을 껐습니다.');return;}
  ask({kicker:'자가 등록 켜기',title:'자가 등록을 켤까요?',ok:'켜기',
    body:['자가 등록 권한(agents:enroll)을 받은 토큰만 새 에이전트를 만들 수 있습니다. 권한은 에이전트 토큰 화면에서 토큰마다 줍니다.',
      fmt('24시간에 {n}번까지 시도할 수 있고, 요금제의 에이전트 한도를 넘지 못합니다.',{n:W.cap}),
      '새 에이전트는 안전한 기본값으로 시작합니다. 바깥으로 가는 메일은 모두 내 승인을 거칩니다.']})
  .then(function(y){if(y)wFlip('we-switch',{agentSelfEnroll:true},'we-msg','자가 등록을 켰습니다.');});});
$('we-notify').addEventListener('click',function(){var W=S.ws;if(!W)return;
  wFlip('we-notify',{notifyOnEnroll:!W.nEnroll},'we-msg',W.nEnroll?'새 에이전트 알림을 껐습니다.':'새 에이전트 알림을 켰습니다.');});
$('we-cap-edit').addEventListener('click',function(){var W=S.ws;if(!W||!can('owner'))return;var n=$('wc-n');n.value=String(W.cap);n.max=String(W.capMax);
  txt('wc-hint',fmt('1~{m} 사이 정수',{m:W.capMax}));say('wc-msg','');fieldErr(n,'');$('dlg-wcap').showModal();n.focus();});
$('wc-cancel').addEventListener('click',function(){$('dlg-wcap').close();});
$('wc-form').addEventListener('submit',function(ev){ev.preventDefault();var W=S.ws,inp=$('wc-n'),v=Number(inp.value);if(!W)return;say('wc-msg','');
  if(!/^[0-9]+$/.test(String(inp.value).trim())||v<1||v>W.capMax){fieldErr(inp,fmt('1~{m} 사이 정수를 넣으세요.',{m:W.capMax}));return;}fieldErr(inp,'');
  if(v===W.cap){$('dlg-wcap').close();return;}
  run($('wc-go'),'wc-msg',function(){return wsPatch({enrollDailyCap:v}).then(function(){$('dlg-wcap').close();say('we-msg','하루 상한을 바꿨습니다.','ok');});});});

/* ---------- sign-ups ---------- */
function renderSignupNotify(){var W=S.ws;wSwitch('su-notify',!!W&&W.nSignup,'가입 확인 메일을 받으면 소유자 메일로 알립니다.');}
$('su-notify').addEventListener('click',function(){var W=S.ws;if(!W)return;
  wFlip('su-notify',{notifyOnSignup:!W.nSignup},'su-msg',W.nSignup?'가입 알림을 껐습니다.':'가입 알림을 켰습니다.');});
function okSignup(x){return obj(x)&&typeof x.agentId==='string'&&typeof x.serviceDomain==='string';}
function signupUrl(cur){var q='/api/watch/signups?limit='+WPAGE;if(SG.agent)q+='&agentId='+enc(SG.agent);if(cur)q+='&cursor='+enc(cur);return q;}
function loadSignups(more){var seq=++SG.seq;return api('GET',signupUrl(more?SG.next:'')).then(function(j){if(seq!==SG.seq)return;j=obj(j)?j:{};
  var items=arr(j.items).filter(okSignup);SG.items=more?SG.items.concat(items):items;SG.next=wNext(j);SG.loaded=true;renderSignups();});}
function renderSignups(){if(!SG.loaded)return;var tb=$('su-body'),n=SG.items.length;clear(tb);
  $('su-tbl').hidden=!n;$('su-empty').hidden=n>0;$('su-more').hidden=!SG.next;
  SG.items.forEach(function(x){var tr=el('tr');
    cell(tr,'서비스').appendChild(el('span','addr strong',clean(x.serviceDomain,253)));
    cell(tr,'에이전트').textContent=str(x.agentName,80)||'—';
    cell(tr,'종류').textContent=SIGNUP_KIND[x.kind]||str(x.kind,40);
    var f=cell(tr,'만든 날');f.className='cv num';f.textContent=fmtDate(x.firstSeenAt);f.title=kst(x.firstSeenAt);
    timeCell(cell(tr,'마지막 메일'),x.lastSeenAt);
    var c=cell(tr,'메일 수');c.className='cv num';c.textContent=grp(num(x.messageCount));tb.appendChild(tr);});}
$('su-agent').addEventListener('change',function(){SG.agent=this.value;SG.loaded=false;SG.next=null;say('su-msg','');loadSignups(false).catch(sectionErr('su-msg'));});
$('su-more').addEventListener('click',function(){run(this,'su-msg',function(){return loadSignups(true);});});

/* ---------- per-agent settings: one read per loaded agent (there is no list endpoint); change = admin, in a dialog, only the changed fields ---------- */
function watchOf(j){j=obj(j)?j:{};return {riskHandling:j.riskHandling==='hold'?'hold':'deliver',riskNotify:j.riskNotify!==false,sendApproval:j.sendApproval==='always'?'always':'auto'};}
function loadAgentWatch(id){return api('GET','/api/agents/'+enc(id)+'/watch').then(function(j){PA.set[id]=watchOf(j);delete PA.err[id];renderWatchAgents();},
  function(e){PA.err[id]=true;renderWatchAgents();if(forbidden(e))$('ro-bar').hidden=false;else say('pa-msg',human(e),'err',errMeta(e));});}
function liveAgent(a){return a.status!=='disabled';}
function loadWatchAgents(){PA.list=S.agents.filter(liveAgent);PA.next=S.agNext;PA.set={};PA.err={};say('pa-msg','');renderWatchAgents();
  PA.list.forEach(function(a){loadAgentWatch(a.id);});}
function waValue(tr,label,text){var c=cell(tr,label);if(text===null){c.appendChild(el('span','skel'));c.setAttribute('aria-busy','true');}else c.textContent=text;return c;}
function renderWatchAgents(){var tb=$('pa-body'),list=PA.list||[];if(!PA.list)return;clear(tb);PA.btn={};
  $('pa-tbl').hidden=!list.length;$('pa-empty').hidden=list.length>0;$('pa-more').hidden=!PA.next;
  list.forEach(function(a){var tr=el('tr'),v=PA.set[a.id],bad=PA.err[a.id];
    var c=cell(tr,'에이전트'),w=el('span','nmt');w.appendChild(el('span','strong',str(a.name,80)||'—'));w.appendChild(addrNode(a.address,true));c.appendChild(w);
    waValue(tr,'위험 메일',v?RISK_HANDLING[v.riskHandling]:bad?'—':null);
    waValue(tr,'위험 메일 알림',v?(v.riskNotify?'켜짐':'꺼짐'):bad?'—':null);
    waValue(tr,'발신 승인',v?SEND_APPROVAL[v.sendApproval]:bad?'—':null);
    var ac=el('td','act');tr.appendChild(ac);
    if(v&&can('admin')){var b=rowAct(ac,'변경',function(){wgOpen(a);},fmt('{n} 설정 변경',{n:str(a.name,80)||'—'}));b.setAttribute('aria-haspopup','dialog');PA.btn[a.id]=b;}
    tb.appendChild(tr);});}
/* "more": a page can add no rows (every agent on it deleted) - then read on, up to 3 pages, so the button never seems to do nothing */
$('pa-more').addEventListener('click',function(){if(!PA.next)return;
  run(this,'pa-msg',function(){var left=3;function page(cur){return api('GET','/api/agents?limit='+AG_PAGE+'&cursor='+enc(cur)).then(function(j){var p=agentsPage(j),have={};
    keepAgents(p.items);PA.list.forEach(function(a){have[a.id]=1;});var add=p.items.filter(function(a){return !have[a.id]&&liveAgent(a);});
    PA.list=PA.list.concat(add);PA.next=p.next;add.forEach(function(a){loadAgentWatch(a.id);});
    if(!add.length&&p.next&&--left>0)return page(p.next);renderWatchAgents();});}
    return page(PA.next);});});
var PG={agent:null};
function wgOpen(a){var v=PA.set[a.id];if(!v||!can('admin'))return;PG.agent=a;txt('pg-title',str(a.name,80)||'—');
  $('pg-rh-deliver').checked=v.riskHandling==='deliver';$('pg-rh-hold').checked=v.riskHandling==='hold';$('pg-notify').checked=v.riskNotify;
  $('pg-sa-auto').checked=v.sendApproval==='auto';$('pg-sa-always').checked=v.sendApproval==='always';say('pg-msg','');$('dlg-wagent').showModal();
  $(v.riskHandling==='hold'?'pg-rh-hold':'pg-rh-deliver').focus();}
$('pg-cancel').addEventListener('click',function(){$('dlg-wagent').close();});
$('pg-form').addEventListener('submit',function(ev){ev.preventDefault();var a=PG.agent,v=a?PA.set[a.id]:null;if(!a||!v)return;
  var next={riskHandling:$('pg-rh-hold').checked?'hold':'deliver',riskNotify:!!$('pg-notify').checked,sendApproval:$('pg-sa-always').checked?'always':'auto'},body={};
  ['riskHandling','riskNotify','sendApproval'].forEach(function(k){if(next[k]!==v[k])body[k]=next[k];});
  if(!Object.keys(body).length){$('dlg-wagent').close();return;}
  run($('pg-go'),'pg-msg',function(){return api('PATCH','/api/agents/'+enc(a.id)+'/watch',body).then(function(j){PA.set[a.id]=watchOf(j);
    $('dlg-wagent').close();renderWatchAgents();var b=PA.btn[a.id];if(b)b.focus();say('pa-msg',fmt('{n} 설정을 저장했습니다.',{n:str(a.name,80)||'—'}),'ok');});});});
`;
