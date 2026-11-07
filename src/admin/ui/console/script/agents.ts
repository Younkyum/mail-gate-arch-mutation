/** src/admin/ui/console/script/agents.ts — 앱 스크립트 조각: 모드 · 설정 메시지 · 토큰 창 · 조직(`/api/me`) · 에이전트 목록 · 만들기 · 교체/폐기/정지. */

export const AGENTS_JS = String.raw`
/* ---------- modes ---------- */
var MODE_FROM={all:'all',allowlist:'allowlist',blocklist:'blocklist',none:'none',unrestricted:'all',allowlist_only:'allowlist',blocklist_only:'blocklist',disabled:'none'};
var MODE_NAME={all:'전체',allowlist:'허용 목록',blocklist:'차단 목록',none:'모두 막기',legacy:'예전 모드'};
var LEGACY={approval_required:'승인 필요',reply_only:'회신만'};
var MKEYS=['all','allowlist','blocklist','none'];
function normMode(m){return MODE_FROM[m]||((typeof m==='string'&&m)?'legacy':'');}
function modeLabel(m,legacy){var k=normMode(m);if(!k)return '—';if(k!=='legacy')return MODE_NAME[k];var r=legacy||m;return MODE_NAME.legacy+(LEGACY[r]?' · '+LEGACY[r]:'');}
function normRules(v){return arr(v).filter(function(r){return obj(r)&&(typeof r.id==='string'||typeof r.id==='number')&&typeof r.value==='string';});}
function normPolicy(j){j=obj(j)?j:{};var v2=obj(j.outbound);var o=v2?j.outbound:{mode:j.mode},i=obj(j.inbound)?j.inbound:{};
  return {v2:v2,ruleLimit:typeof j.ruleLimit==='number'?j.ruleLimit:null,out:{mode:normMode(o.mode),raw:typeof o.legacyMode==='string'?o.legacyMode:o.mode,allow:normRules(o.allow),block:normRules(o.block)},
    'in':{mode:obj(j.inbound)?normMode(i.mode):'',raw:i.mode,allow:normRules(i.allow),block:normRules(i.block)},
    limits:obj(j.limits)?j.limits:{},version:j.version};}

/* ---------- setup message ---------- */
function msgInput(a,token){a=a||{};return {address:clean(a.address,254),token:token||''};}

/* ---------- token modal ---------- */
var TOKEN='',TOKEN_AGENT=null,TOKEN_BACK='';
function tokenMsg(){return setupMessage(S.tokLang,msgInput(TOKEN_AGENT,TOKEN));}
function renderTokenMsg(){txt('dt-msg',TOKEN?tokenMsg():'');seg('dm',S.tokLang);}
/* back: a heading to land on once the window closes (the row that opened it may be gone after the list reloads). */
function showToken(token,agent,kind,back){
  TOKEN=(typeof token==='string')?token:'';TOKEN_BACK=back||'';
  var a=obj(agent)?agent:{};TOKEN_AGENT=a;
  txt('dt-kicker',kind==='rotate'?'새 토큰(이전 토큰은 전부 폐기됨)':kind==='rotate-one'?'새 토큰(이전 토큰은 폐기됨)':kind==='issue'?'새 토큰':'에이전트 추가');
  txt('dt-name',str(a.name,80)||'—');
  put('dt-addr',addrNode(a.address,true));
  txt('dt-id',str(a.id,80)||'—');
  txt('dt-token',TOKEN||'(응답에 토큰이 없습니다. 새 토큰을 다시 발급하세요)');
  renderTokenMsg();
  $('dlg-token').showModal();$('dt-copy').focus();
}
/* closing (the button, Esc) wipes the plaintext from the DOM and this variable; it is never shown again. */
$('dlg-token').addEventListener('close',function(){TOKEN='';txt('dt-token','');txt('dt-msg','');TOKEN_AGENT=null;
  var back=TOKEN_BACK;TOKEN_BACK='';if(back)landFocus(back);});
$('dt-close').addEventListener('click',function(){$('dlg-token').close();});
$('dt-copy').addEventListener('click',function(){copy(TOKEN,this,'dt-token');});
$('dt-copy-msg').addEventListener('click',function(){copy(TOKEN?tokenMsg():'',this,'dt-msg');});
$('dm-en').addEventListener('click',function(){S.tokLang='en';renderTokenMsg();});
$('dm-ko').addEventListener('click',function(){S.tokLang='ko';renderTokenMsg();});
radioKeys(['dm-en','dm-ko']);

/* ---------- me / agents ---------- */
/* glyph per state (spec s3.4): active = filled dot (on) · provisioning = pulsing dot (wait) · off = ring (dim) · blocked = x (bad). */
var STATUS={active:['활성','on'],suspended:['긴급 정지','bad'],provisioning:['준비 중','wait'],disabled:['삭제됨','dim']};
/* agents seen outside the first page (search results, a deep link fetched with GET /api/agents/{id}) are kept by id in S.agx. */
function agentById(id){for(var i=0;i<S.agents.length;i++)if(S.agents[i].id===id)return S.agents[i];
  return Object.prototype.hasOwnProperty.call(S.agx,id)?S.agx[id]:null;}
function curAgent(){return agentById(S.cur);}
/* an active agent in a frozen or paused org cannot send: the badge says so, so the page does not tell two truths (critique R7-19). */
function statusPill(a){var st=STATUS[a.status]||[str(a.status,30),'dim'],by=a.status==='suspended'?a.suspendedBy:null;
  if(a.status==='active'&&(S.ks.platformFrozen||S.ks.ownerPaused))return pillEl('활성 · 발송 멈춤','warn');
  return pillEl(by==='operator'?'운영자 보류':st[0],st[1]);}
function agentHref(a,tab){return routeHref({view:'agent',agent:a.id,tab:tab||'overview'});}
/* token last use (US-007): relative time measured at each render; the exact KST time goes to the title only. */
function usedAt(a){return typeof a.lastUsedAt==='string'&&a.lastUsedAt?a.lastUsedAt:'';}
function usedShort(a){var u=usedAt(a);return u?fmtDateTime(u,Date.now()):EMPTY;}
function showUsed(id,a){var n=$(id);n.textContent=usedShort(a);n.title=usedAt(a)?kst(usedAt(a)):'사용 기록 없음';}
function inMode(a){var p=S.pol[a.id];return p&&p['in'].mode?p['in'].mode:a.inboundMode;}
function outMode(a){var p=S.pol[a.id];return p?p.out.mode:a.outboundMode;}

function loadMe(){return api('GET','/api/me').then(function(j){
  S.csrf=(j&&typeof j.csrf==='string')?j.csrf:'';S.org=(j&&obj(j.organization))?j.organization:{};
  var k=(j&&obj(j.orgKillSwitch))?j.orgKillSwitch:{};
  S.ks={ownerPaused:k.ownerPaused===true,platformFrozen:k.platformFrozen===true};
  S.user=(j&&obj(j.user))?j.user:{};
  txt('org-name',str(S.org.name,80)||'조직');txt('owner',str(S.user.email,254));put('ss-me',addrNode(S.user.email,false));txt('acct-email',str(S.user.email,254));$('acct-email').title=str(S.user.email,254);
  S.review=(S.org.reviewStatus==='pending_review'||S.org.reviewStatus==='rejected')?S.org.reviewStatus:'active';
  S.planBrief=(j&&obj(j.plan))?j.plan:null;planBanner(S.planBrief?S.planBrief.overLimit:[]);
  $('rv-pending').hidden=S.review!=='pending_review';$('rv-rejected').hidden=S.review!=='rejected';

  /* E11: the org switcher draws its list from memberships only; without the field, the current org alone. */
  S.memberships=arr(j&&j.memberships).filter(function(m){return obj(m)&&typeof m.organizationId==='string';});
  if(!S.memberships.length&&typeof S.org.id==='string')S.memberships=[{organizationId:S.org.id,name:S.org.name,role:S.org.role,reviewStatus:S.org.reviewStatus}];
  /* F-1: my role in this org. An older server sends none (every session was the owner's). */
  var mine=typeof S.org.id==='string'?membershipOf(S.org.id):null;
  S.role=roleOf(S.org.role)||roleOf(mine&&mine.role)||'owner';
  renderOrgMenu();renderOrgKill();renderOrgFacts();applyRole();
});}
function sendState(){return S.ks.platformFrozen?['동결됨','운영자 플랫폼 동결']:S.ks.ownerPaused?['긴급 정지','모든 에이전트 발신이 막혀 있습니다']:S.review==='pending_review'?['검토 중','검토가 끝나면 열립니다']:S.review==='rejected'?['닫힘','가입이 승인되지 않았습니다']:['열림','정책에 따라 발송'];}
function renderOrgKill(){
  $('ks-owner').hidden=!S.ks.ownerPaused;$('ks-platform').hidden=!S.ks.platformFrozen;
  $('org-kill-on').hidden=S.ks.ownerPaused;$('org-kill-off').hidden=!S.ks.ownerPaused;
  var st=sendState();txt('sp-state',fmt('지금: {a} · {b}',{a:st[0],b:st[1]}));
}
var REVIEW={active:'활성',pending_review:'운영자 검토 중',rejected:'거절됨'};
function renderOrgFacts(){var o=S.org||{};txt('so-name',str(o.name,80)||'—');txt('so-id',str(o.id,80)||'—');
  put('so-owner',addrNode(o.ownerEmail,false));txt('so-review',REVIEW[S.review]||'—');}

/* R-9: the list is paged by the server (GET /api/agents?limit&cursor&q -> {items,nextCursor}). An older server answers a bare array
   (the whole list) — both shapes are read. S.agNext is the next cursor of the unfiltered list (null = every agent is loaded). */
var AG_PAGE=50,SW_PAGE=20;
function agentsPage(j){if(Array.isArray(j))return {items:okAgents(j),next:null};j=obj(j)?j:{};
  return {items:okAgents(j.items),next:typeof j.nextCursor==='string'&&j.nextCursor?j.nextCursor:null};}
function okAgents(v){return arr(v).filter(function(a){return obj(a)&&typeof a.id==='string';});}
function keepAgents(list){list.forEach(function(a){S.agx[a.id]=a;});return list;}
function loadAgents(){return api('GET','/api/agents?limit='+AG_PAGE).then(function(j){var p=agentsPage(j);
  S.agents=p.items;S.agNext=p.next;S.agentsLoaded=true;if(S.agq)S.agq.stale=true;
  renderAgentsAll();
});}
function moreAgents(b){var q=S.agq,cur=q?q.next:S.agNext;if(!cur)return;
  run(b,'agents-msg',function(){return api('GET','/api/agents?limit='+AG_PAGE+(q?'&q='+enc(q.q):'')+'&cursor='+enc(cur)).then(function(j){var p=agentsPage(j);
    if(q){if(S.agq!==q)return;q.items=q.items.concat(keepAgents(p.items));q.next=p.next;}
    else{var have={};S.agents.forEach(function(a){have[a.id]=1;});S.agents=S.agents.concat(p.items.filter(function(a){return !have[a.id];}));S.agNext=p.next;}
    renderAgents();});});}
/* search: while every agent is loaded, filter here (no request); otherwise ask the server (q, 250 ms after the last key). */
function agentMatch(a,q){return str(a.name,80).toLowerCase().indexOf(q)>=0||clean(a.address,254).toLowerCase().indexOf(q)>=0;}
var AGQ_T=0;
function agentSearch(){var q=$('ag-q').value.trim().toLowerCase().slice(0,64);clearTimeout(AGQ_T);
  if(!q){S.agq=null;renderAgents();return;}
  if(!S.agNext){S.agq={q:q,items:S.agents.filter(function(a){return agentMatch(a,q);}),next:null,local:true};renderAgents();return;}
  AGQ_T=setTimeout(function(){var mine={q:q,items:[],next:null,busy:true};S.agq=mine;
    api('GET','/api/agents?limit='+AG_PAGE+'&q='+enc(q)).then(function(j){if(S.agq!==mine)return;var p=agentsPage(j);mine.items=keepAgents(p.items);mine.next=p.next;mine.busy=false;renderAgents();},
      function(e){if(S.agq!==mine)return;mine.busy=false;say('agents-msg',human(e),'err');renderAgents();});},250);}
$('ag-q').addEventListener('input',agentSearch);
$('ag-clear').addEventListener('click',function(){$('ag-q').value='';agentSearch();$('ag-q').focus();});
$('ag-more').addEventListener('click',function(){moreAgents(this);});
function refreshAgents(){return loadAgents().catch(function(e){say('agents-msg',human(e),'err');});}
function renderAgentsAll(){renderAgents();renderScope();renderGateAgents();renderLogAgents();renderOverview();}
/* outbound column: the mode, plus the list size once this agent's policy is loaded ("allowlist · 3"). */
/* F57: an allowlist with nothing on it is said in words - the agent cannot send to anyone yet. long = the overview card (one more clause). */
function outLine(a,long){var p=S.pol[a.id],m=outMode(a);
  /* F28: list tables show the mode only (the count was there for the first agent alone - one column, two formats); the card adds the count */
  if(!long)return modeLabel(m);
  if(p&&p.out.mode==='allowlist'&&!p.out.allow.length)return modeLabel(m)+' · 비어 있음(보낼 수 없음)';
  return modeLabel(m)+(p&&p.out.mode==='allowlist'?' · '+p.out.allow.length:p&&p.out.mode==='blocklist'?' · '+p.out.block.length:'');}
function identLabel(st){var k=IDST[st];return k?k[0]:'—';}
/* one agent row (org overview + agents list share the columns): thumbnail + name, address, status, identity, out, in, last use. The whole row links. */
function agentRow(a){var tr=el('tr','rl');
  /* first cell = thumb + name, the address on a second line (the row's subject reads first at every width). */
  var c=cell(tr,'이름'),w=el('span','nmw'),nt=el('span','nmt');w.appendChild(thumb(a,''));nt.appendChild(link(str(a.name,80)||'—',agentHref(a),'strong'));
  var ad=addrNode(a.address,true);ad.className='addr sub';nt.appendChild(ad);w.appendChild(nt);c.appendChild(w);
  var sc=cell(tr,'상태','status');sc.appendChild(statusPill(a));
  if(a.status==='suspended'&&a.suspendedBy==='operator')sc.appendChild(el('span','sub','운영자만 풉니다'));
  cell(tr,'신원').textContent=identLabel(a.identityStatus);
  cell(tr,'발신').textContent=outLine(a);
  cell(tr,'수신').textContent=modeLabel(inMode(a));
  /* an empty value is a quiet dash (its meaning on hover) — sixteen "never used" in a column is noise (critique R4-07). */
  var u=cell(tr,'마지막 사용','used');u.className='cv used'+(usedAt(a)?'':' none');u.textContent=usedShort(a);u.title=usedAt(a)?kst(usedAt(a)):'사용 기록 없음';
  tr.addEventListener('click',function(ev){if(ev&&ev.target&&ev.target.tagName==='A')return;location.hash=agentHref(a);});
  return tr;}
function renderAgents(){
  if(S.agq&&S.agq.local&&S.agq.stale){var q0=S.agq.q;S.agq={q:q0,items:S.agents.filter(function(a){return agentMatch(a,q0);}),next:null,local:true};}
  var q=S.agq,list=q?q.items:S.agents,tb=$('agents-body');clear(tb);
  $('agents-empty').hidden=!!q||S.agents.length>0||!S.agentsLoaded;$('agents-tbl').hidden=list.length===0;
  $('agents-none').hidden=!q||q.busy||list.length>0;if(q)txt('agents-none-t',fmt('“{q}”와 맞는 에이전트가 없습니다.',{q:str(q.q,64)}));
  list.forEach(function(a){tb.appendChild(agentRow(a));});
  $('ag-more').hidden=!(q?q.next:S.agNext);
  $('ag-bar').hidden=!q&&!S.agNext&&S.agents.length<8;
  $('na-open').hidden=S.agentsLoaded&&!q&&!S.agents.length;
  var lim=agentLim();
  txt('ag-count',S.agentsLoaded?S.agents.length+(S.agNext?'+':'')+' / '+lim:'');
  /* over the plan's limit (a downgrade): the count reads as blocked — shape, not colour (R4-11). */
  var over=S.agentsLoaded&&typeof lim==='number'&&S.agents.length>lim;$('ag-over').hidden=!over;overLock(over);
}
/* over the plan's agent limit: the create buttons read as locked (aria-disabled + why) and do nothing — the server refuses anyway (R5-11). */
var OVER_DESC={'na-open':'ag-over','ov-new':'st-agents-over'};
/* the reason travels with the lock (2026-10-15 F26): a title on the button, not only the count badge */
function overLock(on){['na-open','ov-new'].forEach(function(i){var b=$(i);if(on){b.setAttribute('aria-disabled','true');b.setAttribute('aria-describedby',OVER_DESC[i]);b.title=OVER_WHY;}
  else if(b.getAttribute('aria-disabled')==='true'){b.removeAttribute('aria-disabled');b.removeAttribute('aria-describedby');b.title='';}});}
var OVER_WHY='요금제의 에이전트 한도를 넘어 새로 만들 수 없습니다.';
/* pressing a locked create button says why, in words, where the reader looks first (critique R6-10) — not a title tooltip. */
function overSay(){banner('요금제 한도를 넘었습니다. 설정의 요금제에서 올릴 수 있습니다.');}
function locked(b){return b.getAttribute('aria-disabled')==='true';}
/* new agent: one dialog (dlg-newagent) from every entry — the list head, its empty state, the overview, the switcher (2026-09-30: every
   create and edit flow is a lightbox). Over the plan's limit it only says why. From the switcher, the menu closes first so the dialog hands
   focus back to the switcher button (the menu item is hidden by then). */
function newAgent(){if(locked($('na-open'))){overSay();return;}if(!can('admin'))return;closeMenu(true);
  $('na-name').value='';$('na-local').value='';fieldErr($('na-name'),'');fieldErr($('na-local'),'');fieldErr($('na-dom'),'');say('na-msg','');
  naDomains([]);$('dlg-newagent').showModal();$('na-name').focus();
  verifiedDomains().then(function(list){if($('dlg-newagent').open&&!$('na-dom').value)naDomains(list);});}
/* the primary address domain (ADR-0014 2026-10, M4): @atmark.ai (default) or a verified customer domain. The field shows only when there is
   such a domain; picking one means this agent never shows or uses an @atmark.ai address (the anchor stays internal). */
function naDomains(list){var s=$('na-dom'),o0=el('option',null,'@atmark.ai');clear(s);o0.value='';s.appendChild(o0);
  list.forEach(function(dm){var o=el('option',null,'@'+dm);o.value=dm;s.appendChild(o);});
  s.value='';s.hidden=list.length===0;$('na-suf-w').hidden=list.length>0;naDomPaint();}
function naDomPaint(){var v=$('na-dom').value,h=$('na-dom-h');txt('na-suf',v||'atmark.ai');h.hidden=!v;
  h.textContent=v?fmt('이 에이전트는 {d} 주소만 씁니다. @atmark.ai 주소는 보이지 않고 메일에도 쓰이지 않습니다. 필요하면 나중에 주소 화면에서 켤 수 있습니다.',{d:v}):'';}
$('na-dom').addEventListener('change',naDomPaint);
$('na-open').addEventListener('click',newAgent);
$('na-cta').addEventListener('click',newAgent);
$('ov-new').addEventListener('click',function(){if(locked(this))overSay();else newAgent();});
dlgBind('dlg-newagent','na-go','na-cancel');

/* ---------- create / tokens / kill ---------- */
$('na-form').addEventListener('submit',function(ev){ev.preventDefault();
  var name=$('na-name').value.trim(),lp=$('na-local').value.trim().toLowerCase();
  say('na-msg','');fieldErr($('na-name'),'');fieldErr($('na-local'),'');
  if(!name){fieldErr($('na-name'),'이름을 적어 주세요.');return;}
  if(!lp||lp.indexOf('@')>=0||/\s/.test(lp)){fieldErr($('na-local'),'주소는 @ 앞부분만 적습니다(공백 없이).');return;}
  var dom=$('na-dom').value,body={name:name,localPart:lp};if(dom){body.domain=dom;body.primary='custom';}
  run($('na-go'),'na-msg',function(){return api('POST','/api/agents',body).then(function(j){
    $('dlg-newagent').close();var ag=j&&obj(j.agent)?j.agent:null;
    showToken(j&&j.token,ag,'create');
    return refreshAgents().then(function(){if(ag&&typeof ag.id==='string')location.hash=routeHref({view:'agent',agent:ag.id,tab:'connect'});});
  },function(e){if(dom&&e instanceof ApiError&&e.code==='domain_not_verified'){fieldErr($('na-dom'),human(e));return;}throw e;});});
});
function rotate(a,b,msg){var body={action:'rotate'};
  ask({kicker:'토큰 전부 교체',title:fmt('{n}의 토큰을 전부 교체할까요?',{n:str(a.name,80)}),danger:true,ok:'전부 교체',
  body:['살아 있는 토큰을 전부 폐기하고 새 토큰 1개를 발급합니다. 새 토큰과 설정 메시지는 다음 창에서 한 번만 보입니다.'],warn:'지금 쓰는 에이전트는 설정을 바꿀 때까지 인증에 실패합니다.'})
  .then(function(y){if(!y)return;return run(b,msg,function(){return api('POST','/api/agents/'+enc(a.id)+'/token',body).then(function(j){
    say(msg,'토큰을 교체했습니다. 폐기 '+num(j&&j.revoked)+'개.','ok');showToken(j&&j.token,a,'rotate');delete S.tok[a.id];return refreshAgents().then(rerender);});});});}
function revokeAll(a,b,msg){ask({kicker:'토큰 전부 폐기',title:fmt('{n}의 토큰을 전부 폐기할까요?',{n:str(a.name,80)}),danger:true,ok:'전부 폐기',
  body:['새 토큰은 발급하지 않습니다. 이 에이전트는 새 토큰을 받을 때까지 API를 쓸 수 없습니다.'],warn:'폐기는 되돌릴 수 없습니다.',
  ack:'모든 토큰이 바로 끊기는 것을 확인했습니다'})
  .then(function(y){if(!y)return;return run(b,msg,function(){return api('POST','/api/agents/'+enc(a.id)+'/token',{action:'revoke-all'}).then(function(j){
    say(msg,fmt('토큰 {n}개를 폐기했습니다.',{n:num(j&&j.revoked)}),'ok');delete S.tok[a.id];return refreshAgents().then(rerender);});});});}
function agentKill(a,on,b){
  var o=on?{kicker:'긴급 정지',title:fmt('{n}의 발신을 정지할까요?',{n:str(a.name,80)}),danger:true,ok:'정지',
      body:['이 에이전트의 모든 발신이 즉시 막힙니다. 승인 릴리스와 예약 발송도 막힙니다.'],
      warn:'토큰을 폐기하지 않습니다. 정지 중에도 유출된 토큰으로 받은 메일을 읽을 수 있습니다. 유출이 의심되면 그 토큰을 폐기하세요.',
      ack:'모든 발신이 바로 멈추는 것을 확인했습니다'}
    :{kicker:'긴급 정지 해제',title:fmt('{n}의 긴급 정지를 해제할까요?',{n:str(a.name,80)}),ok:'해제',body:['발신이 다시 정책을 따릅니다. 정지 중에 막힌 메일은 해제해도 다시 보내지 않습니다.']};
  ask(o).then(function(y){if(!y)return;return run(b,'dz-msg',function(){return api('POST','/api/kill-switch',{scope:'agent',id:a.id,on:on}).then(function(){
    say('dz-msg',on?'긴급 정지했습니다.':'긴급 정지를 풀었습니다.','ok');return refreshAgents().then(rerender);});});});
}
/* delete = the server's soft delete (POST /api/agents/{id}/delete — the same model as deleting an alias). The confirm lists every live
   address (the aliases list; the primary alone when that read fails) and says what stops, what stays and who can take the address. */
function agentDelete(a,b){var id=a.id;
  api('GET','/api/agents/'+enc(id)+'/aliases').then(function(j){return arr(j&&j.items).filter(function(x){return obj(x)&&x.status!=='retired'&&typeof x.address==='string';}).map(function(x){return x.address;});},function(){return [];})
  .then(function(list){if(!list.length&&a.address)list=[a.address];
    /* F46: one line + "goes / stays" + the addresses + one 30-day warning */
    return ask({kicker:'에이전트 삭제',title:'이 에이전트를 삭제할까요?',danger:true,ok:'삭제',list:list.map(function(x){return addrNode(x,true);}),
      body:['되돌릴 수 없습니다. 이 에이전트는 메일을 보내지도 받지도 않습니다.'],
      split:[['사라지는 것',['토큰 전부','주소(메일을 받지 않음)','예약 발송']],['남는 것',['받은 메일','로그 · 감사 기록']]],
      warn:'30일이 지나면 다른 조직이 이 주소를 가져가 그 앞으로 오는 메일(비밀번호 재설정 · 인증 메일 포함)을 받을 수 있습니다. 삭제하기 전에 이 주소로 가입한 서비스의 주소를 바꾸세요.',
      ack:'삭제하면 되돌릴 수 없는 것을 확인했습니다'});})
  .then(function(y){if(!y)return;return run(b,'dzd-msg',function(){return api('POST','/api/agents/'+enc(id)+'/delete',{}).then(function(){
    delete S.agx[id];delete S.tok[id];toast('에이전트를 삭제했습니다.');return refreshAgents().then(function(){location.hash='#/agents';});});});});
}
function orgKill(on,b){
  var id=S.org&&typeof S.org.id==='string'?S.org.id:'';
  if(!id){say('org-kill-msg','조직 정보를 불러오지 못했습니다. 새로고침하세요.','err');return;}
  var o=on?{kicker:'조직 긴급 정지',title:'조직 전체의 발신을 정지할까요?',danger:true,ok:'정지',
      body:['이 조직의 모든 에이전트 발신이 즉시 막힙니다.'],warn:'토큰 유출의 대안이 아닙니다. 유출이 의심되면 해당 에이전트의 그 토큰을 폐기하세요.',ack:'조직의 모든 발신이 바로 멈추는 것을 확인했습니다'}
    :{kicker:'조직 긴급 정지 해제',title:'조직 긴급 정지를 해제할까요?',ok:'해제',body:['각 에이전트의 발신이 다시 자기 상태와 정책을 따릅니다.']};
  if(!on&&S.ks.platformFrozen)o.body.push('운영자의 플랫폼 동결은 그대로 남습니다. 긴급 정지만 풀립니다.');
  ask(o).then(function(y){if(!y)return;return run(b,'org-kill-msg',function(){return api('POST','/api/kill-switch',{scope:'org',id:id,on:on}).then(function(){
    say('org-kill-msg',on?'조직 전체를 긴급 정지했습니다.':'조직 긴급 정지를 풀었습니다.','ok');return loadMe();});});});
}
$('org-kill-on').addEventListener('click',function(){orgKill(true,this);});
$('org-kill-off').addEventListener('click',function(){orgKill(false,this);});
`;
