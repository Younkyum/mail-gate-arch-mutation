/**
 * src/admin/ui/console/script/email.ts — 앱 스크립트 조각: 채널(이메일) 화면 — 발신 | 수신 두 열(`dirPanel`)을 열마다 따로 저장
 * (`PATCH /channels/email/policy {outbound}` · `{inbound}` — R-5 채널 경로, 옛 `/policy` 는 서버의 이메일 별칭) · 목록 추가/삭제 · 한도 · 신뢰 표시 ·
 * 주소 탭(대표 + 별칭 — 2026-09-29 이메일 화면에서 뺀 `#/agents/{id}/addresses`, 화면 함수 `showAddresses`).
 * 더하고 바꾸는 흐름은 전부 버튼 → 대화상자(목록 항목 `dlg-rule` · 신뢰 표시 `dlg-sender` · 별칭 `dlg-alias` · 분당 한도 `dlg-limit`),
 * 지우는 흐름은 확인 대화상자(`ask`)다.
 * member(읽기 전용)에게는 삭제·표시 버튼을 만들지 않고, 모드·추가·저장 컨트롤은 잠근다(`org.ts` `applyRole`).
 */

export const EMAIL_JS = String.raw`/* ---------- channel: email (two direction columns, each saved on its own) ---------- */
var DIRS={outbound:{p:'o',key:'out'},inbound:{p:'i',key:'in'}};
/* one line under the mode segment: what the chosen mode does. */
var MLINE={outbound:{all:'모든 상대에게 보냅니다.',allowlist:'목록에 있는 상대에게만 보냅니다.',blocklist:'차단 목록만 빼고 보냅니다.',none:'보내지 않습니다.'},
  inbound:{all:'모든 메일을 받습니다.',allowlist:'목록에 있는 발신자만 받습니다.',blocklist:'차단 목록만 보류합니다.',none:'모두 보류합니다.'}};
function listUsed(mode,list){return list==='allow'?mode==='allowlist':(mode==='allowlist'||mode==='blocklist');}
function renderDir(dir){var a=curAgent();if(!a)return;var D=DIRS[dir],p=S.pol[a.id];
  var side=p?p[D.key]:{mode:'',allow:[],block:[]},saved=side.mode,draft=S.draft[dir]!==undefined?S.draft[dir]:saved;
  MKEYS.forEach(function(m){var c=$(D.p+'m-'+m);$(D.p+'m-'+m+'-i').checked=m===draft;c.classList.toggle('on',m===draft);c.classList.toggle('saved',m===saved);});
  txt(D.p+'-mline',MLINE[dir][draft]||'');
  if(dir==='outbound'){$('o-legacy').hidden=saved!=='legacy';if(saved==='legacy')txt('o-legacy-mode',modeLabel('legacy',side.raw));$('o-warn-all').hidden=draft!=='all';}
  else $('i-warn-none').hidden=draft!=='none';
  /* the whole column (modes, lists, limits, save) stays locked until the policy has loaded (fieldset disabled). */
  ['-fs','-allow-fs','-block-fs','-save-fs'].forEach(function(k){$(D.p+k).disabled=!p;});
  var changed=!!p&&draft!==saved&&MKEYS.indexOf(draft)>=0&&can('admin');
  $(D.p+'-go').disabled=!changed;$(D.p+'-cancel').disabled=!changed;$(D.p+'-save').classList.toggle('dirty',changed);
  txt(D.p+'-change',changed?modeLabel(saved,side.raw)+' → '+MODE_NAME[draft]:'');
  if(dir==='outbound'){var lm=p?p.limits:{};
    txt('ol-min',limShow(lm,'per_minute','perMinute'));txt('ol-hour',limShow(lm,'per_hour','perHour'));txt('ol-day',limShow(lm,'per_day','perDay'));
    txt('ol-rcpt',limShow(lm,'recipients_per_message','recipientsPerMessage'));
    txt('ol-ver',p&&p.version!==undefined&&p.version!==null?fmt('정책 버전 {v}',{v:str(p.version,40)}):'');}
  var lim=p&&p.ruleLimit?p.ruleLimit:null;
  renderList(dir,'allow',side.allow,lim,!!p);renderList(dir,'block',side.block,lim,!!p);
  /* lists the saved mode does not use fold under one disclosure (they still apply once the mode changes). */
  var unused=[];['allow','block'].forEach(function(list){var box=$(D.p+'-'+list+'-box'),use=!p||listUsed(saved,list);
    $(use?D.p+'-lists':D.p+'-unused-b').appendChild(box);if(!use)unused.push(fmt(list==='allow'?'허용 {n}':'차단 {n}',{n:side[list].length}));});
  $(D.p+'-unused').hidden=!unused.length;txt(D.p+'-unused-s','쓰지 않는 목록 ('+unused.join(' · ')+')');
}
function limShow(lm,k1,k2){var v=limOf(lm,k1,k2);return v==='—'?v:grp(v);}
function limOf(lm,k1,k2){var v=lm[k1]!==undefined?lm[k1]:lm[k2];return typeof v==='number'?String(v):'—';}
function renderList(dir,list,rules,lim,loaded){var id=DIRS[dir].p+'-'+list;
  /* before the policy is known there is no count (a false "0" means "can send to no one") — critique R7-02. */
  txt(id+'-n',loaded?grp(rules.length)+(lim?' / '+grp(lim):''):'');var ul=$(id+'-list');clear(ul);$(id+'-empty').hidden=rules.length>0||!loaded;
  $(id+'-add').disabled=!loaded;gate($(id+'-add'),'admin');
  if(loaded&&!rules.length&&dir==='outbound'&&list==='allow'){var P0=curAgent(),pp=P0&&S.pol[P0.id];txt(id+'-empty-t',pp&&pp.out.mode==='allowlist'?'아직 아무에게도 보낼 수 없습니다. 받는 사람을 추가하세요.':'항목이 없습니다.');}
  rules.forEach(function(r){var li=el('li'),v=String(r.value),isAddr=r.kind==='address'||(r.kind!=='domain'&&v.indexOf('@')>=0);
    var an=isAddr?addrNode(v,false):el('span','addr',str(v,254));an.title=str(v,254);li.appendChild(an);
    li.appendChild(el('span','kind',isAddr?'주소':v.indexOf('*.')===0?'하위 도메인':'도메인'));
    var wn=el('span','when',r.createdAt?kstDate(r.createdAt):'');if(r.createdAt)wn.title=kst(r.createdAt);li.appendChild(wn);
    if(can('admin'))rowAct(li,'제거',function(b){delRule(dir,list,r,b);},fmt('{v} 제거',{v:str(v,254)}));
    ul.appendChild(li);});
}
var LABEL_RE=/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function domainOk(v){if(!v||v.length>255)return false;if(v.indexOf('*.')===0)v=v.slice(2);var ls=v.split('.');if(ls.length<2)return false;
  for(var i=0;i<ls.length;i++)if(!LABEL_RE.test(ls[i]))return false;return true;}
function ruleOk(v){if(!v||v.length>255||/[^\x21-\x7e]/.test(v))return false;var i=v.indexOf('@');
  if(i<0)return domainOk(v);
  if(v.length>254||v.lastIndexOf('@')!==i)return false;
  return /^[a-z0-9.!#$%&'*+\/=?^_\x60{|}~-]{1,64}$/.test(v.slice(0,i))&&v.charAt(i+1)!=='*'&&domainOk(v.slice(i+1));}
function applyPolicy(id,j){if(obj(j)&&obj(j.outbound)){S.pol[id]=normPolicy(j);return Promise.resolve(S.pol[id]);}return loadPolicy(id);}
/* add dialogs (rule, trust mark, alias) remember the agent they were opened for: a submit for another agent (the route moved) closes
   the dialog without sending. While a submit is in flight, Esc and Cancel do nothing (reopening would show a half-finished state). */
function dlgBusy(go){return $(go).classList.contains('busy');}
function dlgBind(dlg,go,cancel){$(dlg).addEventListener('cancel',function(ev){if(dlgBusy(go))ev.preventDefault();});
  $(cancel).addEventListener('click',function(){if(!dlgBusy(go))$(dlg).close();});}
function dlgStale(dlg,aid){if(aid&&S.cur===aid)return false;$(dlg).close();return true;}
/* adding a list entry: the list's Add button opens one shared dialog (dlg-rule) — no inline input (2026-09-29). Once the POST lands the
   dialog closes; what follows (policy reload) reports into the list's own line, which is on screen. */
var RL={dir:'',list:'',agent:''};
function ruleOpen(dir,list){var a=curAgent();if(!a||!can('admin')||!S.pol[a.id])return;RL={dir:dir,list:list,agent:a.id};
  txt('rl-title',fmt('{l}에 추가',{l:LIST_NAME[dir+':'+list]}));
  var inp=$('rl-in');inp.value='';fieldErr(inp,'');say('rl-msg','');$('dlg-rule').showModal();inp.focus();}
function addRule(){var aid=RL.agent,dir=RL.dir,list=RL.list;if(dlgStale('dlg-rule',aid)||!DIRS[dir])return;var id=DIRS[dir].p+'-'+list,inp=$('rl-in'),v=inp.value.trim().toLowerCase();
  say('rl-msg','');if(!ruleOk(v)){fieldErr(inp,'주소(name@example.com)나 도메인(example.com · *.example.com) 모양이 아닙니다. 영문 소문자·숫자만 됩니다.');return;}fieldErr(inp,'');
  run($('rl-go'),'rl-msg',function(){return api('POST','/api/agents/'+enc(aid)+'/channels/'+CH+'/rules',{direction:dir,list:list,value:v}).then(function(j){
    $('dlg-rule').close();
    return applyPolicy(aid,j&&j.policy).then(function(){if(S.cur!==aid)return;renderDir(dir);say(id+'-msg','추가했습니다: '+clean(v,120),'ok');return refreshAgents();})
      .catch(function(e){say(id+'-msg',human(e),'err',errMeta(e));});});});}
$('rl-form').addEventListener('submit',function(ev){ev.preventDefault();addRule();});
dlgBind('dlg-rule','rl-go','rl-cancel');
var LIST_NAME={'outbound:allow':'발신 허용 목록','outbound:block':'발신 차단 목록','inbound:allow':'수신 허용 목록','inbound:block':'수신 차단 목록'};
function delRule(dir,list,r,b){var a=curAgent();if(!a)return;var id=DIRS[dir].p+'-'+list;
  ask({kicker:'목록 항목 제거',title:fmt('{l}에서 제거할까요?',{l:LIST_NAME[dir+':'+list]}),ok:'제거',list:[el('span','addr',str(r.value,254))],
    body:['제거하면 새 정책 버전이 생기고 즉시 적용됩니다.']})
  .then(function(y){if(!y)return;return run(b,id+'-msg',function(){return api('DELETE','/api/agents/'+enc(a.id)+'/channels/'+CH+'/rules/'+enc(r.id)).then(function(j){
    return applyPolicy(a.id,j&&j.policy);}).then(function(){renderDir(dir);say(id+'-msg','제거했습니다.','ok');landFocus(id+'-add');});});});}
function saveMode(dir){var a=curAgent();if(!a)return;var D=DIRS[dir],p=S.pol[a.id];if(!p)return;
  var from=p[D.key].mode,to=S.draft[dir],side=p[D.key];if(!to||to===from)return;
  var body={};body[dir]={mode:to};
  /* F42: a question title; the change itself (A -> B) and the result are the body; the one risk is the warnbox */
  var o={kicker:dir==='outbound'?'발신 모드 변경':'수신 모드 변경',title:dir==='outbound'?'발신 모드를 바꿀까요?':'수신 모드를 바꿀까요?',ok:'변경',danger:(dir==='outbound'&&to==='all')||to==='none',
    body:[modeLabel(from,side.raw)+' → '+MODE_NAME[to],'저장하면 새 정책 버전이 생기고 즉시 적용됩니다.']};
  if(dir==='outbound'&&to==='all'){o.warn='이 에이전트가 누구에게나 메일을 보낼 수 있게 됩니다. 한도·수신 거부 목록·내용 검사는 그대로지만 상대를 고르는 층은 없어집니다.';o.ack='누구에게나 보낼 수 있게 되는 것을 확인했습니다';}
  if(to==='none')o.warn=dir==='outbound'?'모든 발송이 거부됩니다. 급히 멈추려면 개요 맨 아래의 긴급 정지가 더 빠릅니다.':'모든 수신 메일이 보류돼 에이전트에게 보이지 않습니다.';
  if(to==='allowlist'&&!side.allow.length)o.warn=dir==='outbound'?'허용 목록이 비어 있습니다. 저장하면 아무에게도 보낼 수 없습니다.':'허용 목록이 비어 있습니다. 저장하면 모든 메일이 보류됩니다.';
  if(to==='allowlist'&&dir==='inbound')o.body.push('수신 허용 목록은 발신 도메인 인증(DMARC)을 통과한 메일만 목록과 맞춰 봅니다.');
  if(to==='blocklist'&&!side.block.length)o.warn='차단 목록이 비어 있습니다. 저장하면 "전체"와 같습니다.';
  ask(o).then(function(y){if(!y)return;return run($(D.p+'-go'),D.p+'-msg',function(){return api('PATCH','/api/agents/'+enc(a.id)+'/channels/'+CH+'/policy',body).then(function(j){
    delete S.draft[dir];return applyPolicy(a.id,j);}).then(function(){
    renderDir(dir);var v=S.pol[a.id]&&S.pol[a.id].version;say(D.p+'-msg','저장했습니다.'+(v!==undefined&&v!==null?' 정책 버전 '+str(v,40)+'.':''),'ok');return refreshAgents();});});});}
/* per-minute limit: the Change button opens dlg-limit, filled with the current value and bound to the agent it was opened for (like the add dialogs). */
var LM={agent:''};
function limitOpen(){var a=curAgent(),p=a&&S.pol[a.id];if(!a||!p||!can('admin'))return;LM.agent=a.id;
  var cur=limOf(p.limits,'per_minute','perMinute'),inp=$('ol-rate');inp.value=cur==='—'?'':cur;fieldErr(inp,'');say('lm-msg','');
  $('dlg-limit').showModal();inp.focus();}
$('ol-edit').addEventListener('click',limitOpen);
dlgBind('dlg-limit','ol-go','ol-cancel');
$('ol-form').addEventListener('submit',function(ev){ev.preventDefault();var aid=LM.agent;if(dlgStale('dlg-limit',aid))return;
  var inp=$('ol-rate'),raw=inp.value.trim(),n=Number(raw),p=S.pol[aid],cur=p?Number(limOf(p.limits,'per_minute','perMinute')):NaN;
  say('lm-msg','');fieldErr(inp,'');
  if(!raw||!isFinite(n)||n<1||n>9999||Math.floor(n)!==n){fieldErr(inp,'분당 한도는 1~9,999 사이 정수입니다.');return;}
  if(n===cur){say('lm-msg','바뀐 것이 없습니다.','');return;}
  run($('ol-go'),'lm-msg',function(){return api('PATCH','/api/agents/'+enc(aid)+'/channels/'+CH+'/policy',{limits:{perMinute:n}}).then(function(j){return applyPolicy(aid,j);}).then(function(){
    $('dlg-limit').close();if(S.cur!==aid)return;renderDir('outbound');say('ol-msg','저장했습니다.','ok');});});});
function bindDir(dir){var D=DIRS[dir];
  MKEYS.forEach(function(m){$(D.p+'m-'+m+'-i').addEventListener('change',function(){S.draft[dir]=this.value;renderDir(dir);});});
  $(D.p+'-go').addEventListener('click',function(){saveMode(dir);});
  $(D.p+'-cancel').addEventListener('click',function(){delete S.draft[dir];renderDir(dir);});
  ['allow','block'].forEach(function(list){$(D.p+'-'+list+'-add').addEventListener('click',function(){ruleOpen(dir,list);});});}
bindDir('outbound');bindDir('inbound');
/* the email page: address in the head, both columns drawn; below 1280px one column at a time behind a segment (the route's /outbound|/inbound opens it). */
function emTab(dir,push){S.emailDir=dir;radioSet(['em-t-outbound','em-t-inbound'],'em-t-'+dir);
  $('em-cols').className='em-cols show-'+dir;
  if(push&&S.route.view==='agent'&&S.route.tab==='email'){S.route.sub=dir;history.replaceState(null,'',routeHref(S.route));}}
$('em-t-outbound').addEventListener('click',function(){emTab('outbound',true);});
$('em-t-inbound').addEventListener('click',function(){emTab('inbound',true);});
radioKeys(['em-t-outbound','em-t-inbound']);
function showEmail(r,a,soft){put('em-addr',addrNode(a.address,true));emTab(r.sub||'outbound',false);
  renderDir('outbound');renderDir('inbound');
  loadPolicy(a.id).then(function(){if(S.cur===a.id&&S.route.tab==='email'){renderDir('outbound');renderDir('inbound');}},sectionErr('o-msg'));
  loadRequests(a.id);
  if(!soft){loadSenders().catch(sectionErr('sn-load-msg'));
    var c=r.sub?$('col-'+r.sub):null;if(c&&c.scrollIntoView&&(window.innerWidth||0)>=1280)c.scrollIntoView({block:'start'});}}

/* ---------- agent policy change requests (ADR-0007 2026-10-13) ----------
   The agent asked for one change to its own policy (add/remove one list entry, or switch a mode) with a reason. Nothing changes until an
   admin approves here: the server runs the same admin operation as the controls below (a new policy version) in one transaction with the
   audit row. The card shows the exact change against the policy as it is now (server-computed diff), the agent's reason (its own words -
   shown as text, quoted, never as markup) and a strong warning when the agent had just read mail marked risky (pinned when it asked).
   Approve sends the policy version the diff was drawn from (expectedVersion): if the policy moved meanwhile the server answers 409
   policy_changed and the list is read again. The section hides when nothing is waiting. */
var PR={agent:'',j:null};
var PR_TITLE={'add_rule:outbound:allow':'발신 허용 목록에 추가','add_rule:outbound:block':'발신 차단 목록에 추가','add_rule:inbound:allow':'수신 허용 목록에 추가','add_rule:inbound:block':'수신 차단 목록에 추가',
  'remove_rule:outbound:allow':'발신 허용 목록에서 제거','remove_rule:outbound:block':'발신 차단 목록에서 제거','remove_rule:inbound:allow':'수신 허용 목록에서 제거','remove_rule:inbound:block':'수신 차단 목록에서 제거',
  'set_mode:outbound':'발신 모드 변경','set_mode:inbound':'수신 모드 변경'};
var PR_CODES={policy_changed:'요청을 본 뒤 정책이 바뀌었습니다. 바뀐 내용을 다시 확인하세요.',policy_request_stale:'지금 정책에서는 적용할 수 없어 요청을 닫았습니다.',
  policy_request_expired:'7일이 지나 만료된 요청입니다.',risk_ack_required:'에이전트가 그사이 위험 표시된 메일을 읽었습니다. 경고를 확인하고 다시 승인하세요.',policy_request_decided:'이미 결정된 요청입니다.',policy_request_not_found:'요청을 찾을 수 없습니다. 새로고침하세요.',
  operator_reserved:'운영자 예약 주소를 쓰는 에이전트라 정책 변경 요청을 승인할 수 없습니다. 운영자에게 문의하세요.',operator_suspension:'Atmark 운영자가 보류한 에이전트라 정책 변경 요청을 승인할 수 없습니다. 운영자만 풀 수 있습니다.'};
function prKey(c){return c.action==='set_mode'?c.action+':'+c.direction:c.action+':'+c.direction+':'+c.list;}
function prTitle(c){return PR_TITLE[prKey(c)]||'정책 변경';}
function prValue(v){var s=String(v||'');return s.indexOf('@')>0?addrNode(s,false):el('span','addr',str(s,254));}
function prCountLine(n){return fmt('{n}개',{n:grp(n)});}
/* the two sides of the change: now -> if approved. */
function prSides(x){var now=el('dd'),after=el('dd');
  if(x.kind==='mode'){now.textContent=modeLabel(x.before);after.textContent=MODE_NAME[x.after]||'—';return [now,after];}
  now.textContent=prCountLine(num(x.countBefore));
  after.appendChild(el('span','pr-op',x.op==='add'?'+ ':'− '));after.appendChild(prValue(x.value));after.appendChild(el('span','muted',' · '+prCountLine(num(x.countAfter))));
  return [now,after];}
function loadRequests(id){if(PR.agent!==id){PR.agent=id;PR.j=null;$('pr-sec').hidden=true;clear($('pr-list'));say('pr-msg','');}
  return api('GET','/api/agents/'+enc(id)+'/change-requests').then(function(j){if(S.cur!==id)return;PR.j=obj(j)?j:{items:[]};renderRequests();},
    function(e){if(S.cur!==id)return;if(e instanceof ApiError&&e.status===404){$('pr-sec').hidden=true;return;}$('pr-sec').hidden=false;sectionErr('pr-msg')(e);});}
function renderRequests(){var j=PR.j,ul=$('pr-list');if(!obj(j))return;var items=arr(j.items).filter(function(r){return obj(r)&&obj(r.change)&&r.status==='pending';});
  clear(ul);$('pr-sec').hidden=!items.length;txt('pr-n',items.length?fmt('{n}건 대기',{n:grp(items.length)}):'');if(!items.length)return;
  var cur=num(j.currentVersion);
  items.forEach(function(r){var li=el('li','pr'),c=r.change,x=obj(r.diff)?r.diff:null;
    var h=el('div','pr-h');h.appendChild(el('strong',null,prTitle(c)));
    h.appendChild(el('span','when',fmt('요청 {t} · 만료 {e}',{t:kstShort(r.createdAt),e:kstShort(r.expiresAt)})));li.appendChild(h);
    if(r.tainted===true){var w=el('div','warnbox');w.appendChild(el('strong',null,r.taintedAtRequest===false?'요청한 뒤 이 에이전트가 위험 표시된 메일을 읽었습니다.':'요청하기 4시간 안에 이 에이전트가 위험 표시된 메일을 읽었습니다.'));
      w.appendChild(el('p',null,'메일 속 지시에 따라 요청했을 수 있습니다. 직접 시킨 일이 아니면 거절하세요.'));li.appendChild(w);}
    else if(typeof r.lastRiskExposureAt==='string'&&r.lastRiskExposureAt)li.appendChild(el('p','small muted',fmt('이 에이전트는 최근 7일 안에 위험 표시된 메일을 읽었습니다(마지막 {t}).',{t:kstShort(r.lastRiskExposureAt)})));
    if(num(r.recentRejections)>0){var rr=el('div','warnbox');rr.appendChild(el('strong',null,'최근 거절한 요청이 있습니다.'));
      rr.appendChild(el('p',null,fmt('24시간 안에 이 에이전트의 같은 목록 추가 요청을 {n}건 거절했습니다. 같은 상대를 다른 모양으로 다시 묻는 것일 수 있습니다.',{n:grp(num(r.recentRejections))})));li.appendChild(rr);}
    if(x){var dl=el('dl','pl pr-diff'),sides=prSides(x);
      [['지금',sides[0]],['승인하면',sides[1]]].forEach(function(p){var dv=el('div');dv.appendChild(el('dt',null,p[0]));dv.appendChild(p[1]);dl.appendChild(dv);});
      li.appendChild(dl);
      if(x.inEffect===true)li.appendChild(el('p','small muted','이미 이 상태입니다. 승인하면 아무것도 바뀌지 않고 요청이 닫힙니다.'));}
    var rs=el('p','pr-reason');rs.appendChild(el('span','muted','에이전트가 적은 이유'));rs.appendChild(el('q',null,clean(r.reason,500)));li.appendChild(rs);
    if(num(r.baseVersion)!==cur&&cur)li.appendChild(el('p','small muted',fmt('요청한 뒤 정책이 바뀌었습니다(버전 {a} → {b}). 위 내용은 지금 정책 기준입니다.',{a:str(r.baseVersion,20),b:str(cur,20)})));
    if(can('admin')){var act=el('div','actions');
      var no=button('거절','btn sm ghost',function(b){prDecide(r,'reject',b);});no.setAttribute('aria-label',fmt('{t} 요청 거절',{t:prTitle(c)}));
      var ok=button('승인','btn sm',function(b){prDecide(r,'approve',b);});ok.setAttribute('aria-label',fmt('{t} 요청 승인',{t:prTitle(c)}));
      act.appendChild(no);act.appendChild(ok);li.appendChild(act);}
    ul.appendChild(li);});}
function prDecide(r,decision,b){var id=PR.agent,j=PR.j,c=r.change,x=obj(r.diff)?r.diff:null;if(!id||S.cur!==id||!obj(j))return;
  /* F45: the result in one line, the target value, then the single most important risk in one warnbox (taint > a wide mode > recent rejections) */
  var approve=decision==='approve',o={kicker:approve?'변경 요청 승인':'변경 요청 거절',title:fmt(approve?'{t} 요청을 승인할까요?':'{t} 요청을 거절할까요?',{t:prTitle(c)}),ok:approve?'승인':'거절',body:[]};
  if(x&&x.kind==='rule')o.list=[prValue(x.value)];
  if(x&&x.kind==='mode')o.body.push(modeLabel(x.before)+' → '+(MODE_NAME[x.after]||'—'));
  if(approve){var allowAdd=c.action==='add_rule'&&c.direction==='outbound'&&c.list==='allow',warns=[];
    o.body.push(allowAdd?'승인하면 이 에이전트가 이 주소로 메일을 보낼 수 있게 되고, 새 정책 버전이 즉시 적용됩니다.':'승인하면 새 정책 버전이 생기고 즉시 적용됩니다.');
    /* outbound allow add (security audit H-1): the risk hold still applies to an address the agent asked for. */
    if(allowAdd)o.body.push('에이전트가 요청한 주소라서, 위험 표시된 메일을 읽은 뒤에는 이 주소로 보내는 메일도 보류돼 승인을 기다립니다. 직접 추가한 주소와 다릅니다.');
    if(r.tainted===true){o.danger=true;warns.push(r.taintedAtRequest===false?'이 에이전트는 요청한 뒤 위험 표시된 메일을 읽었습니다.':'이 에이전트는 요청하기 직전에 위험 표시된 메일을 읽었습니다.');o.ack='메일 속 지시에 따른 요청일 수 있음을 확인했습니다';}
    if(c.action==='set_mode'&&c.direction==='outbound'&&c.mode==='all'){o.danger=true;warns.push('이 에이전트가 누구에게나 메일을 보낼 수 있게 됩니다. 한도·수신 거부 목록·내용 검사는 그대로지만 상대를 고르는 층은 없어집니다.');}
    if(c.action==='set_mode'&&c.mode==='none'){o.danger=true;warns.push(c.direction==='outbound'?'모든 발송이 거부됩니다.':'모든 수신 메일이 보류돼 에이전트에게 보이지 않습니다.');}
    if(num(r.recentRejections)>0)warns.push('최근 24시간 안에 이 에이전트의 같은 목록 추가 요청을 거절했습니다.');
    if(warns.length)o.warn=warns.join(' ');}
  else o.body.push('거절하면 아무것도 바뀌지 않습니다. 에이전트는 거절됐다는 결과만 봅니다.');
  ask(o).then(function(y){if(!y)return;
    return run(b,'pr-msg',function(){return api('POST','/api/agents/'+enc(id)+'/change-requests/'+enc(r.id)+'/'+decision,approve?(r.tainted===true?{expectedVersion:num(j.currentVersion),ack:true}:{expectedVersion:num(j.currentVersion)}):undefined)
      .then(function(res){var done=approve?'승인했습니다. 새 정책이 적용됐습니다.':'거절했습니다.';
        return (approve&&obj(res)&&obj(res.policy)?applyPolicy(id,res.policy):Promise.resolve()).then(function(){if(S.cur!==id)return;
          renderDir('outbound');renderDir('inbound');return loadRequests(id).then(function(){say('pr-msg',done,'ok');landFocus($('pr-sec').hidden?'h-ag-email':'h-preq');});});},
      function(e){if(e instanceof ApiError&&PR_CODES[e.code]){var m=PR_CODES[e.code];
          return loadPolicy(id).then(function(){if(S.cur!==id)return;renderDir('outbound');renderDir('inbound');return loadRequests(id);}).then(function(){say('pr-msg',m,'err',errMeta(e));});}
        throw e;});});});}

/* ---------- addresses tab: primary + aliases (mail basics 2, A6 — its own tab since 2026-09-29) ----------
   The primary is always shown, read-only (from the agent, then from the list's primary row). Adding is open only when /api/plan says
   features.addressAliases === true (the add POST's own 404 rule; unknown = closed). Listing and deleting work even when closed (security
   review L-4: aliases made earlier keep receiving, so the owner must still be able to cut them) — a closed org with no aliases keeps the
   alias section hidden, one with aliases sees them with Delete and no Add. A GET 404 (older server) also hides it.
   Add = a button that opens dlg-alias (quota from the list's own aliases{active,activeMax,issued,issuedMax} — never made up here).
   Delete = the server's retire (one-time retired_at, a transparency-log leaf) behind a danger dialog. The same org can add the address
   again right away; other orgs only 30 days after the retire (ADR-0013 2026-09-29). Retired aliases are not listed: re-creating one is
   just Add again. Free (activeMax 0) shows an upgrade link instead. */
var AL={id:'',j:null,q:null,on:false,open:null,dlg:'',doms:[]};
var AL_FIELD={invalid_character:1,invalid_length:1,consecutive_dots:1,reserved_local_part:1,invalid_local_part:1,address_taken:1};
function aliasesOpen(){if(AL.open!==null)return Promise.resolve(AL.open);
  return features().then(function(f){AL.open=f.addressAliases===true;return AL.open;});}
function showAddresses(a,soft){renderPrimary(a,null,[]);if(soft&&AL.id===a.id&&AL.j){renderAliases();return;}loadAliases();}
function domOf(addr){var s=clean(addr,254),i=s.lastIndexOf('@');return i<0?'':s.slice(i+1).toLowerCase();}
/* the primary (ADR-0014 2026-10): the list's effective primary row. No primary at all = "no address" (the custom domain behind it was lost):
   two ways back - reconnect the domain, or turn on the agent's @atmark.ai address ({anchor:true}). A customer-domain primary means the
   @atmark.ai address is off (the dormant anchor is not listed): one quiet line offers to turn it on. */
function renderPrimary(a,it,all){var ul=$('al-primary'),addr=it&&typeof it.address==='string'?it.address:a.address,admin=can('admin');clear(ul);
  var none=!addr;$('al-none').hidden=!none;ul.hidden=none;
  /* "no primary" is not "no mail": live aliases (atmark.ai or another verified domain) still send and receive - say which case this is. */
  var live=arr(all).some(function(x){return x.primary!==true&&x.anchor!==true&&x.status!=='retired';});
  txt('al-none-t',live?'대표 주소가 없습니다':'쓸 수 있는 주소가 없습니다');
  txt('al-none-d',live?'기본으로 보내는 주소가 없지만, 아래 별칭으로는 계속 받고 보낼 수 있습니다.':'도메인 연결이 끊겨 지금은 메일을 보내지도 받지도 않습니다.');
  $('al-wake').hidden=!admin;
  var anchorOff=!none&&domOf(addr)!=='atmark.ai'&&!arr(all).some(function(x){return x.anchor===true&&x.status!=='retired';});
  $('al-anchor').hidden=!anchorOff;$('al-wake2').hidden=!admin;
  if(none)return;
  var li=el('li'),an=addrNode(addr,true);an.title=clean(addr,254);li.appendChild(an);li.appendChild(pillEl('대표','tag'));
  li.appendChild(el('span','when',it&&it.createdAt?kstDate(it.createdAt):''));ul.appendChild(li);}
function loadAliases(){var id=S.cur;if(!id)return Promise.resolve();
  if(AL.id!==id){AL.id=id;AL.j=null;AL.q=null;$('al-sec').hidden=true;clear($('al-list'));say('al-msg','');}
  return Promise.all([api('GET','/api/agents/'+enc(id)+'/aliases'),aliasesOpen(),verifiedDomains()]).then(function(r){if(S.cur!==id)return;AL.j=r[0];AL.on=r[1];AL.doms=r[2];renderAliases();},function(e){if(S.cur!==id)return;
    $('al-sec').hidden=true;if(e instanceof ApiError&&e.status===404)return;sectionErr('al-msg')(e);});}
function renderAliases(){var a=curAgent(),j=AL.j,open=AL.on,doms=AL.doms||[];if(!a||!obj(j))return;
  var q=obj(j.aliases)?j.aliases:{},all=arr(j.items).filter(obj),ul=$('al-list');AL.q=q;
  renderPrimary(a,all.filter(function(it){return it.primary===true;})[0]||null,all);
  var items=all.filter(function(it){return it.primary!==true&&it.status!=='retired'&&it.anchor!==true;});
  /* adding is open for atmark.ai aliases (the rollout switch) or for a verified customer domain (its own gate - ADR-0014 M3b). */
  var addable=open||doms.length>0;
  var act=num(q.active),max=num(q.activeMax),free=max<=0,ifull=num(q.issued)>=num(q.issuedMax),full=!free&&(act>=max||ifull),admin=can('admin');
  if(!addable&&!items.length){$('al-sec').hidden=true;clear(ul);return;}
  $('al-sec').hidden=false;txt('al-n',free||!addable?'':grp(act)+' / '+grp(max));
  var add=$('al-add');add.hidden=!admin||!addable||free;add.disabled=full;add.title=full?(ifull?CODES.alias_issued_limit:CODES.alias_plan_limit):'';
  $('al-up').hidden=!admin||!addable||!free;$('al-over').hidden=!addable||q.overLimit!==true;
  clear(ul);$('al-empty').hidden=items.length>0;
  items.forEach(function(it){var li=el('li'),an=addrNode(it.address,true);an.title=clean(it.address,254);li.appendChild(an);
    li.appendChild(el('span','when',kstDate(it.createdAt)));
    /* a verified customer-domain alias can become the primary (warm-up warning in the confirm): two actions = one menu, else one text button (F09). */
    if(admin&&doms.indexOf(domOf(it.address))>=0)rowMenu(li,'alm-'+it.id,clean(it.address,254),[{label:'대표로 고르기',fn:function(mb){setPrimary(it,mb);}},{label:'삭제',fn:function(mb){deleteAlias(it,mb);},danger:true}]);
    else if(admin)rowAct(li,'삭제',function(bt){deleteAlias(it,bt);},fmt('{v} 삭제',{v:clean(it.address,254)}));
    ul.appendChild(li);});}
function afterPrimary(id,msg){if(S.cur!==id)return;say('al-msg',msg,'ok');return refreshAgents().then(function(){if(S.cur===id)return loadAliases();}).then(function(){landFocus('h-ag-addr');});}
function setPrimary(it,b){var id=S.cur,all=AL.j&&arr(AL.j.items).filter(obj)||[],cur=all.filter(function(x){return x.primary===true;})[0]||null;
  var body=['메일을 보낼 때 쓰는 기본 주소가 이 주소로 바뀌고, 패스포트와 공개 조회에도 이 주소가 나옵니다.'];
  if(cur&&cur.anchor===true)body.push(fmt('지금 대표인 {a} 주소는 꺼지고 목록에서도 사라집니다. 그 주소로 오는 메일은 받지 않습니다. 이 화면에서 언제든 다시 켤 수 있습니다.',{a:clean(cur.address,254)}));
  body.push('대표 주소는 하루에 5번까지 바꿀 수 있습니다.');
  ask({kicker:'대표 주소 변경',title:'이 주소를 대표로 바꿀까요?',ok:'변경',list:[addrNode(it.address,true)],body:body,
    warn:'새 도메인은 하루에 보낼 수 있는 양이 작게 시작해 며칠에 걸쳐 늘어납니다. 그동안은 많이 보내지 못할 수 있습니다.'})
  .then(function(y){if(!y)return;return run(b,'al-msg',function(){return api('POST','/api/agents/'+enc(id)+'/primary',{addressId:it.id}).then(function(){
    return afterPrimary(id,'대표 주소를 바꿨습니다.');});});});}
/* "turn on the @atmark.ai address" = choose the anchor as the primary ({anchor:true}). Its name is a random ax--... string chosen at create
   time and never shown until now - the confirm says so before it appears. */
function wakeAnchor(b){var id=S.cur;
  ask({kicker:'@atmark.ai 주소 켜기',title:'@atmark.ai 주소를 켤까요?',ok:'켜기',
    body:['이 에이전트에게는 처음부터 @atmark.ai 주소가 하나 있었습니다. 내 도메인 주소를 대표로 고르면서 꺼 두었던 주소입니다.',
      '켜면 이 주소가 대표 주소가 되어 화면에 보이고, 메일을 보내고 받는 데 쓰입니다. 주소는 ax‑‑로 시작하는 무작위 글자(예: ax‑‑k7m2q…@atmark.ai)이고, 바꿀 수 없습니다.',
      '도메인을 다시 연결하면, 남아 있는 그 도메인 주소를 언제든 다시 대표로 고를 수 있습니다.']})
  .then(function(y){if(!y)return;return run(b,'al-msg',function(){return api('POST','/api/agents/'+enc(id)+'/primary',{anchor:true}).then(function(j){
    var ad=j&&obj(j.primary)&&typeof j.primary.address==='string'?clean(j.primary.address,254):'';
    return afterPrimary(id,ad?fmt('{a} 주소를 켰습니다.',{a:ad}):'@atmark.ai 주소를 켰습니다.');});});});}
$('al-wake').addEventListener('click',function(){wakeAnchor(this);});
$('al-wake2').addEventListener('click',function(){wakeAnchor(this);});
function deleteAlias(it,b){var id=S.cur;
  ask({kicker:'별칭 삭제',title:'이 별칭을 삭제할까요?',danger:true,ok:'삭제',list:[addrNode(it.address,true)],
    body:['다시 만들기 전까지 이 주소로 오는 메일은 거부됩니다. 이 조직에서는 바로 다시 만들 수 있습니다.'],
    warn:'30일이 지나면 다른 조직이 이 주소를 가져가 그 앞으로 오는 메일(비밀번호 재설정 · 인증 메일 포함)을 받을 수 있습니다. 삭제하기 전에 이 주소로 가입한 서비스의 주소를 바꾸세요.'})
  .then(function(y){if(!y)return;return run(b,'al-msg',function(){return api('POST','/api/agents/'+enc(id)+'/aliases/'+enc(it.id)+'/retire').then(function(){
    if(S.cur!==id)return;say('al-msg','별칭을 삭제했습니다.','ok');return loadAliases().then(function(){landFocus($('al-sec').hidden?'h-ag-addr':'h-al');});});});});}
/* the alias domain: atmark.ai (when the rollout switch is open) + verified customer domains. With one choice the field hides. */
function alDomains(){var s=$('al-dom'),opts=(AL.on?['atmark.ai']:[]).concat(AL.doms||[]);clear(s);
  opts.forEach(function(dm){var o=el('option',null,'@'+dm);o.value=dm;s.appendChild(o);});
  s.value=opts[0]||'atmark.ai';s.hidden=opts.length<2;$('al-suf-w').hidden=opts.length>=2;txt('al-suf',opts[0]||'atmark.ai');}
$('al-dom').addEventListener('change',function(){txt('al-suf',this.value||'atmark.ai');});
function alOpen(){var q=AL.q||{},inp=$('al-local'),add=$('al-add');if(!can('admin')||add.hidden||add.disabled||!S.cur)return;
  AL.dlg=S.cur;inp.value='';fieldErr(inp,'');say('da-msg','');alDomains();
  txt('da-active',grp(num(q.active))+' / '+grp(num(q.activeMax)));txt('da-issued',grp(num(q.issued))+' / '+grp(num(q.issuedMax)));
  $('dlg-alias').showModal();inp.focus();}
$('al-add').addEventListener('click',alOpen);
dlgBind('dlg-alias','da-go','da-cancel');
$('al-form').addEventListener('submit',function(ev){ev.preventDefault();var id=AL.dlg,inp=$('al-local'),lp=inp.value.trim().toLowerCase();
  if(dlgStale('dlg-alias',id))return;fieldErr(inp,'');say('da-msg','');
  if(!lp||lp.indexOf('@')>=0||/\s/.test(lp)){fieldErr(inp,'주소는 @ 앞부분만 적습니다(공백 없이).');return;}
  var dom=$('al-dom').value,body={localPart:lp};if(dom&&dom!=='atmark.ai')body.domain=dom;
  run($('da-go'),'da-msg',function(){return api('POST','/api/agents/'+enc(id)+'/aliases',body).then(function(){
    $('dlg-alias').close();if(S.cur!==id)return;say('al-msg','별칭을 추가했습니다.','ok');
    /* the alias that fills the quota disables Add (the focus the dialog handed back would fall to <body>): land on the section title. */
    return loadAliases().then(function(){var ad=$('al-add');if(ad.hidden||ad.disabled)landFocus('h-al');});},function(e){
    if(e instanceof ApiError&&AL_FIELD[e.code]){fieldErr(inp,e.code==='address_taken'?'이미 쓰이고 있거나 지금은 쓸 수 없는 주소입니다. 다른 주소를 고르세요.':human(e));return;}throw e;});});});

/* ---------- trust marks (senders) ----------
   Adding a mark goes through a dialog (dlg-sender); a row's seen / clear goes through a confirm — either one changes the sender_trust
   the agent reads. */
function loadSenders(){var id=S.cur;return api('GET','/api/senders?agent='+enc(id)).then(function(j){if(S.cur!==id)return;
  var list=arr(j).filter(obj),tb=$('sn-body');clear(tb);$('sn-empty').hidden=list.length>0;$('sn-tbl').hidden=list.length===0;
  list.forEach(function(s){
    var tr=el('tr');cell(tr,'발신자').appendChild(addrNode(s.address,false));
    var seen=s.mark==='seen';cell(tr,'표시').appendChild(pillEl(str(s.mark,20)||'—',seen?'on':'dim'));
    timeCell(cell(tr,'시각'),s.markedAt);
    var ac=el('td','act');tr.appendChild(ac);
    var addr=(typeof s.address==='string')?s.address:'';
    if(addr&&addr.charAt(0)!=='@'&&can('admin'))rowAct(ac,seen?'표시 해제':'seen 표시',function(b){rowMark(addr,seen?'cleared':'seen',b);});
    tb.appendChild(tr);
  });
});}
function mark(aid,address,m,scope,confirmDomain,b,msg,done){
  var body={agentId:aid,address:address,mark:m,scope:scope};if(scope==='domain'&&m==='seen')body.confirmDomain=confirmDomain===true;
  return run(b,msg,function(){return api('POST','/api/senders',body).then(function(){if(done)done();if(S.cur!==aid)return;
    say('sn-load-msg',clean(address,254)+' → '+m,'ok');return loadSenders().catch(sectionErr('sn-load-msg'));});});
}
function rowMark(addr,to,b){var seen=to==='seen';
  ask({kicker:'신뢰 표시',title:seen?'이 발신자를 seen으로 표시할까요?':'이 발신자의 표시를 해제할까요?',ok:seen?'seen 표시':'표시 해제',list:[addrNode(addr,false)],
    body:[seen?'에이전트가 이 발신자의 메일에서 sender_trust: "seen"을 봅니다.':'에이전트는 이 발신자를 다시 unknown으로 봅니다.']})
  .then(function(y){if(!y)return;var aid=S.cur;return mark(aid,addr,to,'address',false,b,'sn-load-msg',null).then(function(){landFocus('h-trust');});});}
function snScope(){var dom=$('sn-scope').value==='domain';
  txt('sn-addr-label',dom?'도메인':'발신자 주소');$('sn-addr').placeholder=dom?'service.example':'noreply@service.example';
  $('sn-confirm-wrap').hidden=!dom;$('sn-confirm').checked=false;}
$('sn-scope').addEventListener('change',snScope);
var SN={agent:''};
function snOpen(){if(!can('admin')||!S.cur)return;SN.agent=S.cur;$('sn-scope').value='address';snScope();$('sn-addr').value='';$('sn-m-seen').checked=true;$('sn-m-cleared').checked=false;
  say('sn-msg','');fieldErr($('sn-addr'),'');$('dlg-sender').showModal();$('sn-addr').focus();}
$('sn-add').addEventListener('click',snOpen);
dlgBind('dlg-sender','sn-go','sn-cancel');
$('sn-form').addEventListener('submit',function(ev){ev.preventDefault();var inp=$('sn-addr');if(dlgStale('dlg-sender',SN.agent))return;
  var scope=$('sn-scope').value,v=inp.value.trim().toLowerCase(),m=$('sn-m-cleared').checked?'cleared':'seen';say('sn-msg','');fieldErr(inp,'');
  if(scope==='address'&&(v.indexOf('@')<1||v.lastIndexOf('@')===v.length-1)){fieldErr(inp,'주소 모양이 아닙니다.');return;}
  if(scope==='domain'){v=v.replace(/^@/,'');if(!v||v.indexOf('@')>=0||v.indexOf('.')<1){fieldErr(inp,'도메인 모양이 아닙니다(예: service.example).');return;}
    if(m==='seen'&&!$('sn-confirm').checked){say('sn-msg','도메인 스코프는 확인란을 체크해야 합니다.','err');return;}}
  mark(SN.agent,v,m,scope,$('sn-confirm').checked,$('sn-go'),'sn-msg',function(){$('dlg-sender').close();});
});

`;