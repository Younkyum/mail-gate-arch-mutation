/** src/admin/ui/console/script/logs.ts — 앱 스크립트 조각: 로그 모듈(조직 · 에이전트) · 상세 시트 · 투명성 로그 칸(설정). */

import { GATE_NEXT_JSON, REASONS_JSON } from '../data';

export const LOGS_JS = String.raw`/* ---------- logs ---------- */
var LOGNAME={outbound:'발신',inbound:'수신',console:'콘솔',scheduled:'예약'};
var LCOLS={outbound:['시각','에이전트 이름','받는 사람','제목','결과','사유'],inbound:['시각','에이전트 이름','보낸 사람','제목','결과','사유'],console:['시각','동작','누가','대상'],scheduled:['보낼 시각','에이전트 이름','받는 사람','상태','취소 경로','취소 사유','']};
var LDESC={outbound:'에이전트가 보내려 한 메일과 관문의 판정. 거부 사유는 정책 코드로 남습니다. 예전 승인 흐름의 발송은 결과가 승인 대기로 보입니다.',
  inbound:'에이전트 주소로 온 메일. 보류된 메일은 에이전트에게 보이지 않고, 본문은 여기서도 열지 않습니다.',
  console:'이 조직의 콘솔 동작(무엇을·언제·대상). 지울 수 없는 감사 기록입니다.',
  scheduled:'에이전트의 예약 발송. 취소된 예약에는 사유와 경로(MCP = 에이전트 도구, API)가 남습니다. 에이전트가 받은 메일의 지시로 예약을 취소하지 않았는지 여기서 확인하세요.'};
var DECS={outbound:['sent','denied','pending','failed','sending','queued'],inbound:['delivered','quarantined','rejected'],console:[],scheduled:['scheduled','dispatched','cancelled']};
var OUTCOME={sent:['보냄','on'],delivered:['받음','on'],denied:['거부','bad'],rejected:['수신 거절','bad'],quarantined:['보류','bad'],failed:['실패','bad'],
  pending:['승인 대기','dim'],sending:['보내는 중','dim'],queued:['대기열','dim'],scheduled:['예약됨','dim'],dispatched:['발송됨','on'],cancelled:['취소됨','bad']};
/* scheduled sends (mail basics A3): cancel path and reason. mcp = the agent's own tool, http = API, console = an owner or admin here. */
var VIA={mcp:'MCP(에이전트)',http:'API',console:'콘솔'};
var CANCEL_REASONS={no_longer_needed:'더는 필요 없음',wrong_recipient:'받는 사람 잘못',wrong_content:'내용 잘못',wrong_time:'시각 잘못',duplicate:'중복',owner_request:'소유자 요청',other:'기타'};
function viaLabel(v){return VIA[v]||(v?str(v,20):'—');}
function cancelLabel(c){return c?(CANCEL_REASONS[c]||str(c,80)):'—';}
/* inbound filters (mail basics A5): a KST calendar day; 'until' includes that whole day. */
function kstDay(v,next){if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v))return '';var t=Date.parse(v+'T00:00:00+09:00');if(isNaN(t))return '';return new Date(t+(next?86400000:0)).toISOString();}
var REASONS=${REASONS_JSON};
var NEXT_STEPS=${GATE_NEXT_JSON};
var ACTIONS={'agent.create':'에이전트 만들기','agent.token.rotate':'토큰 전부 교체','agent.token.rotate_one':'토큰 교체','agent.token.revoke_all':'토큰 전부 폐기','agent.token.issue':'새 토큰','agent.token.revoke':'토큰 폐기','agent.token.rename':'토큰 이름 바꾸기','agent.policy.change':'정책 변경','agent.webhook.create':'웹훅 추가','agent.webhook.delete':'웹훅 삭제','agent.webhook.rotate':'웹훅 비밀값 교체','agent.webhook.redeliver':'웹훅 다시 보내기','agent.webhook.authorization_set':'웹훅 인증 헤더 설정','agent.webhook.authorization_clear':'웹훅 인증 헤더 삭제',
  'agent.rule.add':'목록에 추가','agent.rule.remove':'목록에서 제거','agent.identity.publish':'신원 게시','agent.identity.suspend':'신원 게시 중단',
  'agent.seeds.add':'seed 추가(예전)','kill_switch.agent.on':'에이전트 긴급 정지','kill_switch.agent.off':'에이전트 긴급 정지 해제','kill_switch.org.on':'조직 긴급 정지','kill_switch.org.off':'조직 긴급 정지 해제',
  'gate.start':'인계 시험 시작','gate.forwarding.on':'전달 규칙 ON 기록','gate.forwarding.off':'전달 규칙 OFF 기록','gate.intervention':'개입 기록','sender.mark':'신뢰 표시',
  'session.login':'로그인','session.logout':'로그아웃','session.logout_all':'모든 기기에서 로그아웃','logs.bundle_export':'검증 번들 내려받기',
  'session.switch':'조직 전환','org.create':'새 조직 만들기','member.invite':'멤버 초대','member.invite_revoke':'초대 취소','member.join':'멤버 합류',
  'member.role':'역할 변경','member.remove':'멤버 제거','member.leave':'조직에서 나감',
  'org_key.issue':'조직 키 발급','org_key.revoke':'조직 키 폐기','org_key.rotate':'조직 키 교체','org_key.rename':'조직 키 이름 바꾸기',
  'org.ai_watch.on':'AI 의심 메일 감시 켜기','org.ai_watch.off':'AI 의심 메일 감시 끄기',
  'agent.delete':'에이전트 삭제','org.abuse_freeze':'플랫폼 동결','org.abuse_unfreeze':'플랫폼 동결 해제'};
/* who did it (P1 s3.7): a signed-in user (address) or an organization API key (name + last 4). Older rows have no actor.
   Atmark staff (operator CLI) and Atmark's automatic protection (shared-domain reputation freeze) show only the kind, never a name. */
var OPACT={operator:'Atmark 운영팀',system:'Atmark 자동 보호'};
function actorNode(v){var w=el('span');if(!obj(v)){w.textContent='—';return w;}
  if(v.kind==='operator'||v.kind==='system'){w.textContent=OPACT[v.kind];return w;}
  if(v.kind==='user'&&typeof v.email==='string'){w.appendChild(addrNode(v.email,false));return w;}
  if(v.kind==='org_key'){w.appendChild(el('span',null,str(v.label,60)||'이름 없음'));w.appendChild(el('span','sub mono',maskKey(OKPFX,v.hint)));return w;}
  w.textContent='—';return w;}
/* AI suspicious-mail watch (ADR-0017): a warning mark next to the inbound result, never a verdict. Monochrome: flagged = solid outline +
   a 3-step strength meter (owner only; agents never see the band), pending = pulsing, skipped = dashed "not checked", clear = plain muted text.
   No key on the row (watch off, rule out of scope, shadow) = nothing drawn. */
var AIW={flagged:['AI 의심','f'],clear:['AI 표시 없음','c'],pending:['AI 확인 중','p'],skipped:['판정 없음','s']};
var AIW_BAND={high:['높음',3],mid:['중간',2],low:['낮음',1]};
var AIW_TIP={flagged:'분류 모델이 에이전트를 조종하려는 지시처럼 보인다고 표시했습니다. 경고일 뿐, 메일은 막히지 않았습니다.',
  clear:'분류 모델이 표시하지 않았습니다. 안전하다는 판정은 아닙니다.',pending:'분류 모델의 결과를 기다리고 있습니다(최대 30초).',
  skipped:'시간 안에 검사하지 못해 경고 없이 전달됐습니다.'};
function aiwOf(x){var a=obj(x)&&obj(x.aiWatch)?x.aiWatch:null;return a&&AIW[a.status]?a:null;}
function aiwNode(a){var k=AIW[a.status],n=el('span','aiw aiw-'+k[1]);n.appendChild(el('span','aiw-t',k[0]));
  var bd=a.status==='flagged'?AIW_BAND[a.band]:null;
  if(bd){var m=el('span','aiw-m');m.setAttribute('aria-hidden','true');for(var i=1;i<=3;i++)m.appendChild(el('i',i<=bd[1]?'on':null));n.appendChild(m);
    n.appendChild(el('span','sr',fmt(' · 강도 {b}',{b:bd[0]})));}
  n.title=AIW_TIP[a.status]+(bd?' '+fmt('강도 {b}.',{b:bd[0]}):'');return n;}
/* the mark itself is in the facts above (AI watch row); this block adds strength, model and lateness, then says what the mark is not */
function aiwBlock(ex,a){ex.appendChild(el('h4',null,'AI 의심 메일 감시'));var dl=el('dl','kv');
  if(a.status==='flagged'&&AIW_BAND[a.band])kvRow(dl,'강도',AIW_BAND[a.band][0]);
  if(typeof a.modelVersion==='string'&&a.modelVersion)kvRow(dl,'모델 버전',mono(a.modelVersion,64));
  if(a.late===true)kvRow(dl,'도착','마감(30초) 뒤에 늦게 도착');
  if(dl.firstChild)ex.appendChild(dl);ex.appendChild(el('p','small muted',AIW_TIP[a.status]));
  ex.appendChild(el('p','small muted','수신 정책 · 위험 보류 · 발신 검사는 이 표시와 관계없이 따로 판정합니다.'));}
function outcomePill(o){var k=OUTCOME[o];return pillEl(k?k[0]:(str(o,30)||'—'),k?k[1]:'dim');}
function reasonLabel(c){return REASONS[c]||str(c,80);}
function agentName(id){var a=agentById(id);return a?str(a.name,60):str(id,40);}
function actionNode(x){var w=el('span');w.appendChild(el('span','strong',ACTIONS[x.action]||str(x.action,80)||'—'));
  if(ACTIONS[x.action])w.appendChild(el('span','sub mono',str(x.action,80)));return w;}
function targetNode(id){var a=agentById(id),w=el('span');if(a){w.appendChild(el('span',null,str(a.name,60)));w.appendChild(el('span','sub mono',str(id,80)));}
  else w.appendChild(el('span','mono small',str(id,80)||'—'));return w;}
function recips(node,list,count){var rs=arr(list).filter(function(x){return typeof x==='string';}),n=typeof count==='number'?count:rs.length;
  if(!rs.length){node.textContent='—';return;}
  rs.slice(0,2).forEach(function(r,i){if(i)node.appendChild(d.createTextNode(', '));node.appendChild(addrNode(r,false));});
  if(n>2)node.appendChild(el('span','sub',fmt('외 {n}명',{n:n-2})));}
function inReasons(x){var rs=[];if(x.reason)rs.push(x.reason);if(x.policyReason)rs.push(x.policyReason);return rs;}
function logRow(type,x,hrefOf){var tr=el('tr','rl'),L0=LCOLS[type],href=hrefOf(String(x.id));
  var a=link(kstShort(x.at),href,'tlink');a.title=kst(x.at);cell(tr,L0[0],'time').appendChild(a);
  a.addEventListener('click',function(){S.entryFromList=true;});
  if(type==='console'){cell(tr,L0[1],'peer').appendChild(actionNode(x));cell(tr,L0[2],'actor').appendChild(actorNode(x.actor));cell(tr,L0[3],'target').appendChild(targetNode(x.targetId));}
  else if(type==='scheduled'){cell(tr,L0[1],'agent').textContent=str(x.agentName,60)||agentName(x.agentId);recips(cell(tr,L0[2],'peer'),x.recipients,x.recipientCount);
    cell(tr,L0[3],'result').appendChild(outcomePill(x.status));cell(tr,L0[4],'via').textContent=x.status==='cancelled'?viaLabel(x.cancelledVia):'—';
    cell(tr,L0[5],'reason').textContent=x.status==='cancelled'?cancelLabel(x.cancelReason):'—';
    /* cancel button (mail basics Y2): owner or admin, scheduled rows only. The server decides again (dispatched or sending = 409). */
    var ac=el('td','act');tr.appendChild(ac);
    if(x.status==='scheduled'&&can('admin'))rowAct(ac,'취소',function(){scOpen(x);});}
  else{cell(tr,L0[1],'agent').textContent=str(x.agentName,60)||agentName(x.agentId);
    var p=cell(tr,L0[2],'peer');if(type==='outbound')recips(p,x.recipients,x.recipientCount);else if(x.from)p.appendChild(addrNode(x.from,false));else p.textContent='—';
    var sj=cell(tr,L0[3],'subj');sj.className='cv subj';sj.textContent=type==='inbound'&&x.verdict==='rejected'&&!x.subject?'—':(str(x.subject,140)||'(제목 없음)');sj.title=sj.textContent;p.title=p.textContent;
    var rcell=cell(tr,L0[4],'result');rcell.appendChild(outcomePill(type==='outbound'?x.decision:x.verdict));
    var aw=type==='inbound'?aiwOf(x):null;if(aw)rcell.appendChild(aiwNode(aw));
    var rs=type==='outbound'?arr(x.reasons):inReasons(x),rc=cell(tr,L0[5],'reason');rc.textContent=rs.length?rs.map(reasonLabel).join(', '):'—';rc.title=rc.textContent;}
  if(oneAgent(type))tr.removeChild(tr.children[1]);
  tr.addEventListener('click',function(ev){if(ev&&ev.target&&(ev.target.tagName==='A'||ev.target.tagName==='BUTTON'))return;S.entryFromList=true;location.hash=href;});
  return tr;}
/* agent scope: every row is the same agent, so the agent-name column is not drawn (console log columns have no agent column). */
function oneAgent(type){return !!S.lg.fixed&&type!=='console';}
function logHref(id){return S.lg.fixed?routeHref({view:'agent',agent:S.lg.fixed,tab:'logs',log:S.lg.type,entry:id}):routeHref({view:'logs',log:S.lg.type,entry:id});}
function renderLogAgents(){var s=$('lf-agent'),v=S.lg.filter;clear(s);var o=el('option',null,'전체');o.value='';s.appendChild(o);
  S.agents.forEach(function(a){var x=el('option',null,str(a.name,60));x.value=a.id;s.appendChild(x);});s.value=agentById(v)?v:'';}
function renderDecisions(type){var s=$('lf-dec');clear(s);var o=el('option',null,'전체');o.value='';s.appendChild(o);
  DECS[type].forEach(function(k){var x=el('option',null,OUTCOME[k]?OUTCOME[k][0]:k);x.value=k;s.appendChild(x);});
  if(DECS[type].indexOf(S.lg.dec)<0)S.lg.dec='';s.value=S.lg.dec;$('ld-wrap').hidden=!DECS[type].length;
  var inb=type==='inbound';$('lff-wrap').hidden=!inb;$('lfs-wrap').hidden=!inb;$('lfu-wrap').hidden=!inb;
  $('lf-from').value=S.lg.from;$('lf-since').value=S.lg.since;$('lf-until').value=S.lg.until;}
function inboundFilterQuery(){var G=S.lg,q='';if(G.type!=='inbound')return q;
  if(G.from)q+='&from='+enc(G.from);var a=kstDay(G.since,false),b=kstDay(G.until,true);if(a)q+='&since='+enc(a);if(b)q+='&until='+enc(b);return q;}
function mountLogs(hostId,fixed){var m=$('logs-mod'),h=$(hostId);if(m.parentNode!==h)h.appendChild(m);S.lg.fixed=fixed||'';$('lf-wrap').hidden=!!fixed;}
function showLogs(r,fixed){
  mountLogs(fixed?'a-logs-host':'logs-host',fixed);
  var type=r.log||'outbound',agent=fixed||S.lg.filter||'';
  LOGT.forEach(function(t){var x=$('lt-'+t);x.href=fixed?routeHref({view:'agent',agent:fixed,tab:'logs',log:t}):routeHref({view:'logs',log:t});
    if(t===type)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  txt('tip-logs-t',LDESC[type]);txt('tip-logs-a-t',LDESC[type]);renderDecisions(type);
  /* the scope is part of the key (review M1): org logs filtered to X and X's own log tab have different columns and row links */
  var key=(fixed?'a:':'o:')+type+'|'+agent+'|'+S.lg.dec+(type==='inbound'?'|'+S.lg.from+'|'+S.lg.since+'|'+S.lg.until:'');
  if(key!==S.lg.key){S.lg.key=key;S.lg.type=type;S.lg.agent=agent;loadLogs(true);}
  if(r.entry)openLog(type,r.entry);
}
/* column kinds, same as the cells logRow makes: a header hides together with its cells when the body is narrow (critique R8-01) */
var LKIND={outbound:['time','agent','peer','subj','result','reason'],inbound:['time','agent','peer','subj','result','reason'],console:['time','peer','actor','target'],scheduled:['time','agent','peer','result','via','reason','act']};
function renderLogHead(){var h=$('lg-head'),one=oneAgent(S.lg.type),K=LKIND[S.lg.type];clear(h);LCOLS[S.lg.type].forEach(function(c,i){if(one&&i===1)return;var th=el('th',null,c);th.setAttribute('scope','col');th.setAttribute('data-k',K[i]);h.appendChild(th);});}
function loadLogs(reset){var G=S.lg,seq=++G.seq;
  if(reset){G.items=[];G.next=null;renderLogHead();clear($('lg-body'));$('lg-empty').hidden=true;$('lg-more').hidden=true;txt('lg-count','');}
  var q='/api/logs?type='+enc(G.type)+'&limit=50'+(G.agent?'&agent='+enc(G.agent):'')+(G.dec?'&decision='+enc(G.dec):'')+inboundFilterQuery()+((!reset&&G.next)?'&before='+enc(G.next):'');
  say('lg-msg',reset?'불러오는 중':'');busy($('lg-more'),true);
  return api('GET',q).then(function(j){if(seq!==G.seq)return;
    var items=arr(j&&j.items).filter(function(x){return obj(x)&&x.id!==undefined&&x.id!==null;});
    G.next=(j&&typeof j.next==='string'&&j.next)?j.next:null;
    items.forEach(function(x){G.items.push(x);$('lg-body').appendChild(logRow(G.type,x,logHref));});
    $('lg-empty').hidden=G.items.length>0;$('lg-tbl').hidden=G.items.length===0;$('lg-more').hidden=!G.next;
    txt('lg-count',G.items.length?fmt('{n}건 표시',{n:G.items.length})+(G.next?' · 더 있음':''):'');say('lg-msg','');
  }).catch(function(e){if(seq===G.seq){$('lg-tbl').hidden=G.items.length===0;say('lg-msg',human(e),'err');}}).then(function(){busy($('lg-more'),false);});}
$('lg-more').addEventListener('click',function(){loadLogs(false);});
$('lg-refresh').addEventListener('click',function(){S.lg.key='';showLogs({log:S.lg.type},S.lg.fixed);});
$('lf-agent').addEventListener('change',function(){S.lg.filter=this.value;S.lg.key='';showLogs({log:S.lg.type},'');});
$('lf-dec').addEventListener('change',function(){S.lg.dec=this.value;S.lg.key='';showLogs({log:S.lg.type},S.lg.fixed);});
$('lf-from').addEventListener('change',function(){S.lg.from=String(this.value||'').trim().toLowerCase().slice(0,320);S.lg.key='';showLogs({log:S.lg.type},S.lg.fixed);});
$('lf-since').addEventListener('change',function(){S.lg.since=this.value||'';S.lg.key='';showLogs({log:S.lg.type},S.lg.fixed);});
$('lf-until').addEventListener('change',function(){S.lg.until=this.value||'';S.lg.key='';showLogs({log:S.lg.type},S.lg.fixed);});
/* ---------- scheduled cancel (mail basics Y2): reason is required, note optional. Protected schedules too; no hourly cap. ---------- */
var SC={item:null};
var SC_ERR={schedule_already_dispatched:'이미 발송된 예약입니다. 나간 메일은 거둘 수 없습니다.',schedule_in_flight:'지금 발송 중인 예약입니다. 잠시 뒤 새로고침하세요.',
  schedule_not_found:'이 조직의 예약이 아닙니다. 새로고침하세요.',invalid_reason_code:'취소 사유를 고르세요.',invalid_note:'메모는 200자까지이고, 줄바꿈·보이지 않는 문자는 쓸 수 없습니다.'};
function scErr(e){return e instanceof ApiError&&SC_ERR[e.code]?SC_ERR[e.code]:human(e);}
function scOpen(x){if(!can('admin')||!obj(x))return;SC.item=x;$('sc-reason').value='';$('sc-note').value='';$('sc-go').disabled=false;say('sc-msg','');
  $('dlg-sched-cancel').showModal();$('sc-reason').focus();}
$('sc-close').addEventListener('click',function(){$('dlg-sched-cancel').close();});
$('sc-form').addEventListener('submit',function(ev){ev.preventDefault();var x=SC.item,go=$('sc-go');if(!x)return;
  var reason=$('sc-reason').value,note=String($('sc-note').value||'').trim();
  if(!reason){say('sc-msg',SC_ERR.invalid_reason_code,'err');$('sc-reason').focus();return;}
  var body={reasonCode:reason};if(note)body.note=note;
  say('sc-msg','');busy(go,true);
  api('POST','/api/scheduled/'+enc(String(x.id))+'/cancel',body).then(function(j){$('dlg-sched-cancel').close();
    var done=obj(j)&&j.replayed===true?'이미 취소된 예약입니다.':'예약을 취소했습니다.';
    return loadLogs(true).then(function(){say('lg-msg',done,'ok');});})
  .catch(function(e){say('sc-msg',scErr(e),'err');}).then(function(){busy(go,false);});});

function kvRow(dl,k,v){dl.appendChild(el('dt',null,k));var dd=el('dd');if(typeof v==='string')dd.textContent=v;else if(v)dd.appendChild(v);else dd.textContent='—';dl.appendChild(dd);}
function mono(v,max){return el('span','mono',str(v,max||120)||'—');}
function yesNo(v){return v===true?'예':v===false?'아니오':'—';}
function findItem(type,id){var it=S.lg.items;for(var i=0;i<it.length;i++)if(String(it[i].id)===id&&S.lg.type===type)return it[i];return null;}
function openLog(type,id){var dl=$('dlg-log'),seq=++S.dlSeq;
  txt('dl-kicker',LOGNAME[type]||'');txt('dl-id',str(id,80));say('dl-msg','');
  var known=findItem(type,id);if(known)renderLogDetail(type,known);else{txt('dl-title','불러오는 중');clear($('dl-kv'));clear($('dl-extra'));}
  if(!dl.open)dl.showModal();
  api('GET','/api/logs/'+enc(type)+'/'+enc(id)).then(function(j){if(seq!==S.dlSeq)return;renderLogDetail(type,obj(j)&&obj(j.item)?j.item:(obj(j)?j:{}));})
  .catch(function(e){if(seq!==S.dlSeq)return;if(!known)txt('dl-title','기록을 불러오지 못했습니다');say('dl-msg',human(e),'err');});
}
function addrList(ex,title,list){var rs=arr(list).filter(function(r){return typeof r==='string';});if(!rs.length)return;
  ex.appendChild(el('h4',null,title+' · '+rs.length));var ul=el('ul','log');rs.forEach(function(r){var li=el('li');li.appendChild(addrNode(r,false));ul.appendChild(li);});ex.appendChild(ul);}
function renderLogDetail(type,x){var dl=$('dl-kv'),ex=$('dl-extra');clear(dl);clear(ex);
  if(type==='console'){txt('dl-title',ACTIONS[x.action]||str(x.action,120)||'—');kvRow(dl,'시각',kst(x.at));kvRow(dl,'동작',mono(x.action));
    kvRow(dl,'누가',actorNode(x.actor));kvRow(dl,'대상',targetNode(x.targetId));kvRow(dl,'기록 ID',mono(x.id,80));proofBlock(ex,x);return;}
  if(type==='scheduled'){txt('dl-title',x.status==='cancelled'?'취소된 예약':'예약 발송');
    kvRow(dl,'보낼 시각',kst(x.sendAt||x.at));kvRow(dl,'에이전트 이름',str(x.agentName,80)||agentName(x.agentId));kvRow(dl,'상태',outcomePill(x.status));
    kvRow(dl,'보낸 주소',x.from?addrNode(x.from,true):null);
    kvRow(dl,'받는 사람 수',String(typeof x.recipientCount==='number'?x.recipientCount:arr(x.recipients).length));
    if(x.createdAt)kvRow(dl,'만든 시각',kst(x.createdAt));
    kvRow(dl,'에이전트 취소 허용',yesNo(x.agentCancellable));
    if(x.dispatchedAt)kvRow(dl,'발송 시각',kst(x.dispatchedAt));
    if(x.dispatchOutcome)kvRow(dl,'발송 결과',mono(x.dispatchOutcome,60));
    if(x.messageId)kvRow(dl,'발신 기록',mono(x.messageId,80));
    if(x.status==='cancelled'){ex.appendChild(el('h4',null,'취소 기록'));var cd=el('dl','kv');
      kvRow(cd,'취소 시각',kst(x.cancelledAt));kvRow(cd,'취소 경로',viaLabel(x.cancelledVia));
      var rs=el('span');rs.appendChild(el('span',null,cancelLabel(x.cancelReason)));if(x.cancelReason)rs.appendChild(el('span','sub mono',str(x.cancelReason,80)));kvRow(cd,'취소 사유',rs);
      if(typeof x.cancelNote==='string'&&x.cancelNote)kvRow(cd,'취소 메모',str(x.cancelNote,200));ex.appendChild(cd);
      if(x.cancelledVia==='mcp')ex.appendChild(el('p','small muted','에이전트가 MCP 도구로 취소했습니다. 받은 메일의 지시로 취소한 것이 아닌지 확인하세요.'));}
    addrList(ex,'받는 사람',x.recipients);
    ex.appendChild(el('p','small muted','예약 메일의 제목·본문은 콘솔에서 열지 않습니다.'));
    return;}
  txt('dl-title',type==='inbound'&&x.verdict==='rejected'&&!x.subject?'거절된 메일':(str(x.subject,300)||'(제목 없음)'));
  kvRow(dl,'시각',kst(x.at));kvRow(dl,'에이전트 이름',str(x.agentName,80)||agentName(x.agentId));
  if(type==='outbound'){kvRow(dl,'결과',outcomePill(x.decision));
    kvRow(dl,'보낸 주소',x.from?addrNode(x.from,true):(x.fromDomain?el('span','addr','…@'+str(x.fromDomain,200)):null));
    kvRow(dl,'받는 사람 수',String(typeof x.recipientCount==='number'?x.recipientCount:arr(x.recipients).length));
    if(x.threadId)kvRow(dl,'스레드',mono(x.threadId,80));
    kvRow(dl,'정책 버전',x.policyVersion===undefined||x.policyVersion===null?'—':str(x.policyVersion,40));
    if(x.resolution)kvRow(dl,'해소',mono(x.resolution,200));
    if(x.failureReason)kvRow(dl,'실패 사유',str(x.failureReason,300));
    if(x.evaluatedAt)kvRow(dl,'판정',kst(x.evaluatedAt));
    if(x.sentAt)kvRow(dl,'보낸 시각',kst(x.sentAt));
    if(x.failedAt)kvRow(dl,'실패 시각',kst(x.failedAt));
    if(x.approvalId)kvRow(dl,'승인 요청',mono(x.approvalId,80));
    reasonsBlock(ex,arr(x.reasons));addrList(ex,'받는 사람',x.recipients);
    bodyBlock(ex,x);eventsBlock(ex,x);proofBlock(ex,x);
    return;}
  kvRow(dl,'결과',outcomePill(x.verdict));
  kvRow(dl,'보낸 사람',x.from?addrNode(x.from,false):null);
  if(x.fromAuthenticated!==undefined)kvRow(dl,'발신 인증',yesNo(x.fromAuthenticated));
  kvRow(dl,'발신자 신뢰',str(x.senderTrust,30)||'—');
  kvRow(dl,'인젝션 위험',x.injectionRisk===undefined||x.injectionRisk===null?'—':str(x.injectionRisk,30));
  if(x.headerDate)kvRow(dl,'Date 헤더',str(x.headerDate,80));
  if(x.messageIdHeader)kvRow(dl,'Message-ID',mono(x.messageIdHeader,200));
  if(x.inReplyTo)kvRow(dl,'In-Reply-To',mono(x.inReplyTo,200));
  if(typeof x.attachmentCount==='number')kvRow(dl,'첨부',String(x.attachmentCount));
  if(x.autoSubmitted)kvRow(dl,'Auto-Submitted',mono(x.autoSubmitted,60));
  if(x.threadId)kvRow(dl,'스레드',mono(x.threadId,80));
  var aw=aiwOf(x);if(aw)kvRow(dl,'AI 감시',aiwNode(aw));
  reasonsBlock(ex,inReasons(x));if(aw)aiwBlock(ex,aw);addrList(ex,'받는 주소',x.to);
  if(obj(x.auth)){ex.appendChild(el('h4',null,'인증 결과'));var ad=el('dl','kv');['spf','dkim','dmarc','spam','virus'].forEach(function(k){kvRow(ad,k.toUpperCase(),x.auth[k]===null||x.auth[k]===undefined?'—':str(x.auth[k],40));});ex.appendChild(ad);}
  ex.appendChild(el('p','small muted','본문은 콘솔에서 열지 않습니다.'));
  proofBlock(ex,x);
}
/* outbound body (US-004): plain text only, drawn with textContent in a pre-wrap block; html part is never rendered.
   'expired' (US-008) is the 1-year retention rule at work, worded apart from 'missing' (which reads as a fault). */
var BODY_ST={not_stored:'이 기록에는 본문이 저장되지 않았습니다.',missing:'본문을 찾지 못했습니다.',expired:'보관 기간(1년)이 지나 본문이 삭제됐습니다.',unavailable:'본문을 읽지 못했습니다.'};
function bodyBlock(ex,x){var b=obj(x.body)?x.body:null,snip=typeof x.snippet==='string'?cleanBlock(x.snippet,2000):'';
  if(!b&&!snip)return;
  ex.appendChild(el('h4',null,'본문'));
  if(b&&b.status==='available'&&typeof b.text==='string'){var pre=el('pre','lbody');pre.textContent=cleanBlock(b.text,70000)||'—';ex.appendChild(pre);
    if(b.truncated===true)ex.appendChild(el('p','small muted','본문이 길어 앞부분만 보입니다.'));
    if(b.hasHtml===true)ex.appendChild(el('p','small muted','HTML 파트는 콘솔에서 열지 않습니다.'));
    return;}
  if(b&&BODY_ST[b.status])ex.appendChild(el('p','small muted body-st st-'+b.status,BODY_ST[b.status]));
  if(snip){ex.appendChild(el('p','small muted','미리보기'));var sp=el('pre','lbody');sp.textContent=snip;ex.appendChild(sp);}}
/* Delivery events, oldest first. Unknown types show the raw (cleaned) code. */
var EVT={send:['발송 접수',''],delivery:['배달됨','ok'],bounce:['반송','bad'],complaint:['스팸 신고','bad'],reject:['발송 거부','bad'],
  delivery_delay:['배달 지연','dim'],rendering_failure:['렌더링 실패','bad']};
function eventsBlock(ex,x){var list=arr(x.events).filter(function(e){return obj(e)&&typeof e.type==='string';});
  if(!list.length&&['sent','sending','failed'].indexOf(x.decision)<0)return;
  ex.appendChild(el('h4',null,'배달 이벤트'));
  if(!list.length){ex.appendChild(el('p','small muted','배달 이벤트가 아직 없습니다.'));return;}
  var ol=el('ol','tl');list.forEach(function(e){var k=EVT[e.type],li=el('li',k&&k[1]?'ev-'+k[1]:null);
    li.appendChild(el('span','tl-when',kst(e.at)));li.appendChild(el('span','tl-k',k?k[0]:str(e.type,40)));
    if(k)li.appendChild(el('span','tl-code mono',str(e.type,40)));ol.appendChild(li);});
  ex.appendChild(ol);}
function reasonsBlock(ex,codes){if(!codes.length)return;ex.appendChild(el('h4',null,'사유'));var ul=el('ul','log');
  codes.forEach(function(c){var li=el('li');li.appendChild(el('code',null,str(c,80)));if(REASONS[c])li.appendChild(d.createTextNode(': '+REASONS[c]));ul.appendChild(li);});ex.appendChild(ul);}
/* ---------- integrity (US-010): the transparency-log row in Settings (moved from the Logs view in v4) + per-entry inclusion proof ---------- */
/* Inclusion proof link only when the log API names the entry (tlogEntryId); the file is the proof JSON as served (pnpm log:verify reads it).
   tlogPending = the record has a leaf that the next hourly checkpoint will cover: one muted line, no button. */
function proofBlock(ex,x){var id=typeof x.tlogEntryId==='number'?String(x.tlogEntryId):x.tlogEntryId;
  if(typeof id!=='string'||!/^[1-9][0-9]{0,17}$/.test(id)){if(x.tlogPending===true){ex.appendChild(el('h4',null,'무결성'));
    ex.appendChild(el('p','small muted','다음 정시 체크포인트 뒤에 포함 증명을 내려받을 수 있습니다.'));}return;}
  ex.appendChild(el('h4',null,'무결성'));var row=el('div','actions');
  row.appendChild(button('포함 증명 내려받기','btn sm ghost',function(b){run(b,'dl-msg',function(){
    return api('GET','/api/logs/inclusion-proof?entry='+enc(id),undefined,'atmark-inclusion-'+id+'.json').then(function(f){
      saveBlob(f.blob,f.name);say('dl-msg',fmt('내려받았습니다: {f}',{f:f.name}),'ok');});});}));
  ex.appendChild(row);}
/* Anchor states = DB CHECK tlog_anchors_state_shape (202609241800): OTS pending/submitted/bitcoin_claimed/failed, Rekor pending/confirmed/failed.
   OTS never becomes 'confirmed': bitcoin_claimed is the calendar's claim, not checked against a block header (ADR-0008 M2) -- the label says so.
   Rekor 'confirmed' is written by the anchor role (anchor-reported, L7); pnpm log:verify checks the receipt -- the label and tip say so. */
var ANCHOR={opentimestamps:{pending:['대기 중','dim'],submitted:['Bitcoin 기록 대기','dim'],bitcoin_claimed:['Bitcoin 기록 주장(미검증)','on'],failed:['기록 실패','dim']},
  rekor:{pending:['대기 중','dim'],confirmed:['Sigstore 기록됨','on'],failed:['기록 실패','dim']}};
/* vkey = name+keyid+key (C2SP signed note). The key id (first 4 bytes of a hash over name and key) is the fingerprint shown. */
var VKEY_RE=/^([^+\s]{1,120})\+([0-9a-f]{8})\+[A-Za-z0-9+\/=]{4,120}$/;
function itCell(id,main,sub,title){var n=$(id);clear(n);n.appendChild(typeof main==='string'?el('span',null,main):main);
  if(sub)n.appendChild(el('span','sub',sub));n.title=title||'';}
function latestAnchor(list,target){var best=null;list.forEach(function(x){if(x.target===target&&(!best||num(x.epoch)>num(best.epoch)))best=x;});return best;}
function renderAnchor(id,list,target){var x=latestAnchor(list,target);if(!x){itCell(id,'—','','');return;}
  var k=(ANCHOR[target]||{})[x.state],when=typeof x.confirmedAt==='string'?x.confirmedAt:'',now=Date.now();
  itCell(id,pillEl(k?k[0]:(str(x.state,30)||'—'),k?k[1]:'dim'),when?fmt('체크포인트 #{e} · {t}',{e:num(x.epoch),t:fmtDateTime(when,now)}):fmt('체크포인트 #{e}',{e:num(x.epoch)}),when?kst(when):'');}
function renderIntegrity(){var x=S.integ,ok=obj(x),started=ok&&x.started===true,lt=ok&&obj(x.latest)?x.latest:null,now=Date.now();
  $('it-facts').hidden=ok&&!started;$('it-empty').hidden=!ok||started;$('it-shred').hidden=!(started&&x.shredded===true);
  $('it-dl').disabled=!(started&&lt);
  if(!started)return;
  if(lt){var w=el('span','pills');w.appendChild(el('span',null,fmtDateTime(lt.closedAt,now)));if(lt.published===false)w.appendChild(pillEl('게시 대기','dim'));
    itCell('it-cp',w,fmt('#{e} · 전체 기록 {s}건',{e:num(lt.epoch),s:grp(num(lt.globalTreeSize))}),kst(lt.closedAt));}
  else itCell('it-cp','아직 체크포인트가 없습니다','','');
  var pend=num(x.uncheckpointedLeaves);itCell('it-size',String(num(x.orgTreeSize)),pend>0?fmt('대기 {n}건',{n:pend}):'모두 체크포인트됨','');
  var an=arr(x.anchors).filter(obj);renderAnchor('it-ots',an,'opentimestamps');renderAnchor('it-rekor',an,'rekor');
  var vk=typeof x.vkey==='string'?x.vkey:'',m=vk?VKEY_RE.exec(vk):null,k=$('it-key');
  k.textContent=m?m[2]:(vk?str(vk,80):'—');k.title=vk;txt('it-kname',m?str(m[1],120):'');$('it-key-copy').hidden=!vk;}
function loadIntegrity(){say('it-msg','');return api('GET','/api/logs/integrity').then(function(j){S.integ=obj(j)?j:{};renderIntegrity();})
  .catch(function(e){S.integ=null;$('it-facts').hidden=true;$('it-dl').disabled=true;say('it-msg',human(e),'err');});}
$('it-key-copy').addEventListener('click',function(){var x=S.integ;copyTo(x&&typeof x.vkey==='string'?x.vkey:'','it-key-copy-st');});
$('it-dl').addEventListener('click',function(){var b=this;
  ask({kicker:'검증 번들 내려받기',title:'검증 번들을 내려받을까요?',ok:'내려받기',
    body:['최근 체크포인트 24개(약 하루)와 이 조직 기록의 증명이 든 JSON 파일입니다. 내려받으면 콘솔 로그에 남습니다.'],
    warn:'번들에는 이 조직의 커밋 열쇠(솔트 키)가 들어 있어 수신자·Message-ID를 열 수 있습니다. 조직 밖으로 보내지 마세요.'})
  .then(function(y){if(!y)return;return run(b,'it-msg',function(){return api('GET','/api/logs/bundle',undefined,'atmark-log-bundle.json').then(function(f){
    saveBlob(f.blob,f.name);say('it-msg',fmt('내려받았습니다: {f}',{f:f.name}),'ok');});});});});
$('dl-close').addEventListener('click',function(){$('dlg-log').close();});
$('dlg-log').addEventListener('close',function(){var r=S.route;if(!r.entry)return;S.dlSeq++;
  if(S.entryFromList){S.entryFromList=false;history.back();return;}
  var b={};Object.keys(r).forEach(function(k){if(k!=='entry')b[k]=r[k];});location.replace(routeHref(b));});

`;
