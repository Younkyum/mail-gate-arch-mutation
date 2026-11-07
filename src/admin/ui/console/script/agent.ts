/** src/admin/ui/console/script/agent.ts — 앱 스크립트 조각: 에이전트 스코프 화면 전환 · 에이전트 개요(통계 · 요약 카드 · 최근 활동 · 정지 행) · 연결. */

export const AGENT_JS = String.raw`/* ---------- agent scope ---------- */
function rerender(){if(S.route.view==='agent')showAgent(S.route,true);else if(S.route.view==='agents')renderAgents();else if(S.route.view==='overview')renderOverview();renderScope();}
function idStatusOf(a){var x=S.ident[a.id];return x&&IDST[x.status]?x.status:(IDST[a.identityStatus]?a.identityStatus:'');}
function renderAgentHead(a){txt('a-name',str(a.name,80)||'—');put('a-addr',addrNode(a.address,true));put('a-status',statusPill(a));
  var st=idStatusOf(a);txt('a-ident',st?fmt('신원: {s}',{s:identLabel(st)}):'');txt('a-id',str(a.id,80));paintThumb($('ao-thumb'),a.keyFingerprint);}
function showAgent(r,soft){
  var a=agentById(r.agent);
  /* R-9 deep link: an agent outside the first page is read on its own (GET /api/agents/{id}) — no wait for the whole list. */
  if(!a&&S.agentsLoaded&&!S.agMiss[r.agent])fetchAgent(r.agent);
  $('a-missing').hidden=!!a||!S.agentsLoaded||!S.agMiss[r.agent]||S.agMiss[r.agent]==='busy';$('a-body').hidden=!a;
  if(!a)return;
  if(S.cur!==a.id){S.draft={};}
  S.cur=a.id;
  /* a deleted agent is read-only: overview + logs only (records are kept); any other screen falls back to the overview. */
  var gone=a.status==='disabled';$('a-gone').hidden=!gone;
  if(gone&&GONE_TABS.indexOf(r.tab)<0){r={view:'agent',agent:a.id,tab:'overview'};S.route=r;try{history.replaceState(null,'',routeHref(r));}catch(e){}renderScope();}
  TABS.forEach(function(t){$('t-'+t).hidden=t!==r.tab;});
  var id=a.id,t=r.tab;
  function pol(then,msg){loadPolicy(id).then(function(){if(S.cur===id&&S.route.tab===t)then();},partErrFn(msg));}
  if(t==='overview'){renderAgentHead(a);renderAgentOverview(a);renderAgentStats(id);renderDanger(a);
    pol(function(){renderAgentOverview(a);},'ao-msg');
    if(!soft){loadStats(id,'ao-stats-msg').then(function(){if(S.cur===id)renderAgentStats(id);});loadAgentRecent(id);
      loadIdentity(id).then(function(){if(S.cur===id&&S.route.tab==='overview'){renderAgentHead(a);renderAgentOverview(a);}},function(){});}
    if(S.scrollTo==='danger'){S.scrollTo='';scrollDanger();}}
  else if(t==='connect')renderConnect();
  else if(t==='email')showEmail(r,a,soft);
  else if(t==='addresses')showAddresses(a,soft);
  else if(t==='webhooks')showWebhooks(a,soft);
  else if(t==='logs')showLogs(r,id);
  else if(t==='identity')showIdentity(a,soft);
  else if(t==='tokens')showTokens(a,soft);
}
function fetchAgent(id){S.agMiss[id]='busy';
  api('GET','/api/agents/'+enc(id)).then(function(j){if(!(obj(j)&&typeof j.id==='string'&&j.id===id)){S.agMiss[id]='gone';return;}delete S.agMiss[id];S.agx[id]=j;},
    function(){S.agMiss[id]='gone';}).then(function(){var r=S.route;if(r.view==='agent'&&r.agent===id){renderScope();showAgent(r,false);}});}
/* R-5: the policy lives under its channel (/channels/email/...). The old /policy and /rules paths stay as the server's email aliases. */
var CH='email';
function loadPolicy(id){return api('GET','/api/agents/'+enc(id)+'/channels/'+CH+'/policy').then(function(j){S.pol[id]=normPolicy(j);return S.pol[id];});}
function renderAgentOverview(a){var p=S.pol[a.id],x=S.ident[a.id],st=idStatusOf(a);
  txt('ao-out',outLine(a,true));txt('ao-in',modeLabel(inMode(a)));
  var pm=p?limOf(p.limits,'per_minute','perMinute'):'—';txt('ao-rate',pm==='—'?'—':fmt('분당 {n}',{n:pm}));
  txt('ao-tokens',String(num(a.activeTokens)));showUsed('ao-used',a);
  txt('ao-ident',st?identLabel(st)+(x&&st!=='draft'&&x.version!==undefined&&x.version!==null?' · v'+str(x.version,20):''):'—');
  txt('ao-until',x&&st!=='draft'?ymd(x.validUntil):'—');
  $('ao-email-a').href=agentHref(a,'email');$('ao-tokens-a').href=agentHref(a,'tokens');$('ao-identity-a').href=agentHref(a,'identity');$('ao-logs-a').href=agentHref(a,'logs');}
function renderAgentStats(id){var x=S.stats[id];
  statCells(['ao-st-out','ao-st-denied','ao-st-in','ao-st-q'],x===undefined?null:x===false?[null,null,null,null]:(function(s){return [s.sent,s.denied,s.recv,s.q];})(statsOf(x)));}
function loadAgentRecent(id){say('ao-msg','');return recentItems(id,5).then(function(items){if(S.cur===id)renderActivity('ao',id,items);})
  .catch(function(e){$('ao-log-tbl').hidden=true;partErr('ao-msg',e);});}
/* old #/agents/{id}/danger lands here: bring the suspend row into view and focus its button. */
function scrollDanger(){var z=$('dz');if(z&&z.scrollIntoView)z.scrollIntoView({block:'center'});$('dz-kill').focus({preventScroll:true});}
$('ao-copy').addEventListener('click',function(){var a=curAgent();copy(a?setupMessage(S.msgLang,msgInput(a,'')):'',this,function(){if(a){S.afterRoute=function(){selectText($('cm-text'));};location.hash=agentHref(a,'connect');}});});
$('a-id-copy').addEventListener('click',function(){var a=curAgent();copyTo(a?String(a.id):'','a-id-copy-st');});

/* the bottom rows of the agent overview (D6): suspend + delete. A deleted agent has neither (and no setup message or edit links). */
var GONE_TABS=['overview','logs'];
function renderDanger(a){var k=$('dz-kill'),susp=a.status==='suspended',gone=a.status==='disabled';k.disabled=false;k.title='';
  $('dz').hidden=gone;$('ao-copy').hidden=gone;['ao-email-a','ao-tokens-a','ao-identity-a'].forEach(function(i){$(i).hidden=gone;});
  renderDelete(a);
  k.textContent=susp?'긴급 정지 해제':'정지';k.className='btn '+(susp?'ghost':'danger');
  txt('dz-title',susp?'긴급 정지 중':'긴급 정지');
  txt('dz-text',susp?'해제하면 발신이 다시 정책을 따릅니다.':'모든 발신을 즉시 막습니다. 수신은 계속됩니다.');
  txt('dz-note','');
  if(a.status!=='active'&&!susp){k.disabled=true;txt('dz-note','활성이거나 긴급 정지 중인 에이전트만 바꿀 수 있습니다.');}
  if(susp&&a.suspendedBy!=='owner'){k.disabled=true;txt('dz-note','운영자가 보류해 운영자만 풀 수 있습니다.');}
  gate(k,'admin');
}
$('dz-kill').addEventListener('click',function(){var a=curAgent();if(a)agentKill(a,a.status!=='suspended',this);});
function renderDelete(a){var b=$('dz-del');b.disabled=false;b.title='';txt('dzd-note','');
  if(a.status==='provisioning'){b.disabled=true;txt('dzd-note','준비가 끝난 에이전트만 삭제할 수 있습니다.');}
  if(a.status==='suspended'&&a.suspendedBy!=='owner'){b.disabled=true;txt('dzd-note','운영자가 보류한 에이전트는 삭제할 수 없습니다.');}
  gate(b,'admin');}
$('dz-del').addEventListener('click',function(){var a=curAgent();if(a)agentDelete(a,this);});

/* ---------- connect ---------- */
function renderConnect(){var a=curAgent();if(!a)return;txt('cm-text',setupMessage(S.msgLang,msgInput(a,'')));seg('cm',S.msgLang);}
$('cm-en').addEventListener('click',function(){S.msgLang='en';renderConnect();});
$('cm-ko').addEventListener('click',function(){S.msgLang='ko';renderConnect();});
radioKeys(['cm-en','cm-ko']);
$('cm-copy').addEventListener('click',function(){var a=curAgent();copy(a?setupMessage(S.msgLang,msgInput(a,'')):'',this,'cm-text');});

`;
