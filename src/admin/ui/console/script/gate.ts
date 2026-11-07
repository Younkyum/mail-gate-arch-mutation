/** src/admin/ui/console/script/gate.ts — 앱 스크립트 조각(ASCII 코드 · 한국어는 문자열 안에만). `app.ts` 가 순서대로 잇는다. */

export const GATE_JS = String.raw`/* ---------- gate (settings) ---------- */
var STATUS_TEXT={
  held:['판정 보류','판정식이 모르는 봉투로 전달이 계속 옵니다. pnpm ac0:probe로 보고 런북 §4로 판정식을 실측 교체합니다.'],
  not_yet_true:['AC-0 미성립','재시작이 3회를 넘었습니다. 인계 시험을 멈추고 P3·P4로 돌아갑니다.'],
  waiting:['관측 대기','1일차 00:00 KST 전입니다. 그 전에 Gmail seed 필터를 켜고 전달 규칙 ON을 기록합니다.'],
  observing:['관측 중','1–7일차, 전달 규칙 ON. 1–5일차에는 개입 원인을 고치는 것 말고는 아무 작업도 하지 않습니다.'],
  observation_extended:['관측 연장','아직 기준일이 없습니다(서로 다른 외부 발신자 '+T.minBaselineSenders+'명 이상에게서 전달이 온 날). 규칙을 끄지 않습니다. 계속 0이면 판정식부터 의심합니다.'],
  awaiting_switch:['전환 대기','비교일 23:00–24:00 KST에 Gmail 필터와 전달 주소를 지우고 바로 OFF를 기록합니다. OFF 기록이 없으면 증명은 시작하지 않습니다.'],
  proving:['증명 중','전달 규칙 OFF. 개입이 0건이어야 합니다. 사람 메일함에서 거래 메일을 읽거나 쓰지 않습니다.'],
  proof_extended:['증명 연장','개입은 0건이지만 활동 분모 3종이 아직 모자랍니다. 에이전트가 실제 일을 더 해야 합니다.'],
  passed:['통과','AC-0 성립. 규칙은 다시 켜지 않습니다. 통과 뒤에 개입·누수가 생기면 다시 재시작 필요가 됩니다.'],
  restart_required:['재시작 필요','원인을 고친 뒤 복귀 일차부터 다시 셉니다. 재시작 기록은 콘솔에서 하지 않습니다. 운영자에게 요청하세요.']
};
var EXIT_TEXT={0:'exit 0 · 통과',1:'exit 1 · 재시작 필요',3:'exit 3 · 진행 중'};
var PHASE_TEXT={before:'시작 전',observation:'관측(규칙 ON)',switch:'전환(OFF 기록 대기/완료)',proof:'증명(규칙 OFF)'};
var FWD_TEXT={on:'ON',off:'OFF',unrecorded:'기록 없음'};
var CAT_TEXT={address_transition:'주소전환',agent_gap:'에이전트',deliverability:'배달',policy_friction:'정책',other:'기타'};
var DAY=86400000;
function renderGateAgents(){var s=$('g-agent');clear(s);
  if(!S.agents.length){s.appendChild(el('option',null,'에이전트 없음'));s.disabled=true;S.gateAgent='';gateEnabled(false);return;}
  if(!agentById(S.gateAgent))S.gateAgent=S.agents[0].id;
  S.agents.forEach(function(a){var o=el('option',null,str(a.name,60));o.value=a.id;s.appendChild(o);});
  s.value=S.gateAgent;s.disabled=false;gateEnabled(true);}
var GATE_KEY='atmark.console.gate-open';
function gateOpen(on,save){$('gate-body').hidden=!on;var b=$('g-toggle');b.setAttribute('aria-expanded',String(on));b.textContent=on?'닫기':'열기';
  if(save){try{sessionStorage.setItem(GATE_KEY,on?'1':'0');}catch(e){}}}
$('g-toggle').addEventListener('click',function(){gateOpen($('gate-body').hidden,true);});
function gateSaved(){try{return sessionStorage.getItem(GATE_KEY)==='1';}catch(e){return false;}}
gateOpen(gateSaved(),false);
function gateEnabled(on){['gs-open','gs-go','g-refresh'].forEach(function(i){$(i).disabled=!on;});gate($('gs-open'),'admin');gate($('gs-go'),'admin');}
$('g-agent').addEventListener('change',function(){S.gateAgent=this.value;S.gate='';loadGate().catch(sectionErr('g-msg'));});
function loadGate(){
  if(!S.gateAgent){S.report=null;S.gates=[];renderGatePick();renderGate();return Promise.resolve();}
  var url='/api/gate?agent='+enc(S.gateAgent)+(S.gate?'&gate='+enc(S.gate):'');
  return api('GET',url).then(function(j){
    j=obj(j)?j:{};
    S.gates=arr(j.gates).filter(function(g){return obj(g)&&typeof g.id==='string';});
    var rep=obj(j.report)?j.report:(obj(j.verdict)?j:null);S.report=rep;S.ambiguous=j.ambiguous===true&&!rep;
    if(rep&&obj(rep.gate)&&typeof rep.gate.id==='string')S.gate=rep.gate.id;
    renderGatePick();renderGate();
  });
}
function renderGatePick(){
  var wrap=$('g-pick'),s=$('g-sel');wrap.hidden=S.gates.length<2;clear(s);
  if(!S.gate&&S.gates.length>1){var ph=el('option',null,'판정할 인계 시험을 고르세요');ph.value='';ph.disabled=true;s.appendChild(ph);}
  S.gates.forEach(function(g){var o=el('option',null,kstDate(g.createdAt)+' · '+str(g.id,40));o.value=g.id;s.appendChild(o);});
  s.value=S.gate||'';
  $('gs-new-wrap').hidden=S.gates.length===0;$('gs-new').checked=false;
}
$('g-sel').addEventListener('change',function(){S.gate=this.value;loadGate().catch(function(e){say('g-msg',human(e),'err');});});
$('g-refresh').addEventListener('click',function(){var b=this;run(b,'g-msg',loadGate);});

/* next-step code -> text in this language; null for an unknown code or unfilled slot (then the server line is shown as-is). */
function nextStepText(st){
  if(!obj(st)||typeof st.code!=='string'||!Object.prototype.hasOwnProperty.call(NEXT_STEPS,st.code))return null;
  var p=obj(st.params)?st.params:{},ok=true;
  var out=NEXT_STEPS[st.code].replace(/\{([a-zA-Z]+)\}/g,function(_,k){
    if(k==='cause')return typeof p.cause==='string'&&p.cause?' · '+str(p.cause,60):'';
    if(k==='status'){var sl=typeof p.status==='string'&&Object.prototype.hasOwnProperty.call(STATUS_TEXT,p.status)?STATUS_TEXT[p.status]:null;if(sl)return sl[0];ok=false;return '';}
    if(typeof p[k]==='number'&&isFinite(p[k]))return String(p[k]);
    ok=false;return '';});
  return ok?out:null;
}
function dayOf(anchor,iso){var a=new Date(anchor).getTime(),t=new Date(iso).getTime();if(isNaN(a)||isNaN(t))return null;return Math.floor((t-a)/DAY)+1;}
function renderGate(){
  var rep=S.report,has=!!rep,amb=!has&&S.ambiguous;
  $('g-report').hidden=!has;
  var fwdOk=has&&obj(rep.gate)&&typeof rep.gate.id==='string';
  ['fwd-on','fwd-off','iv-open','iv-go'].forEach(function(i){$(i).disabled=!fwdOk;gate($(i),'admin');});
  if(!has){txt('g-sum',amb?fmt('인계 시험이 {n}개 있습니다. 판정할 인계 시험을 고르세요.',{n:S.gates.length}):'열린 인계 시험이 없습니다.');txt('g-asof','');txt('fwd-now',amb?'먼저 위에서 판정할 인계 시험을 고르세요. 기록은 고른 인계 시험에 남습니다.':'인계 시험이 없어 기록할 수 없습니다.');ivHint();return;}
  var v=obj(rep.verdict)?rep.verdict:{},o=obj(v.observation)?v.observation:{},p=obj(v.proof)?v.proof:{},g=obj(rep.gate)?rep.gate:{};
  var st=STATUS_TEXT[v.status]||[str(v.status,40)||'알 수 없음',''];
  txt('g-status',st[0]);txt('g-meaning',st[1]);txt('g-exit',EXIT_TEXT[v.exitCode]||('exit '+str(v.exitCode,4)));
  txt('g-asof','기준 '+kst(v.asOf));
  var rs=$('g-restart');
  if(obj(v.restart)){rs.hidden=false;rs.textContent='재시작 → '+num(v.restart.returnDay)+'일차 복귀 · 원인 '+str(v.restart.cause,60)+': '+str(v.restart.detail,300);}else rs.hidden=true;
  var dn=typeof v.dayNumber==='number'?v.dayNumber:null,dayEl=$('g-day');clear(dayEl);
  if(LANG==='en'&&dn!==null)dayEl.appendChild(el('small',null,'Day'));
  dayEl.appendChild(d.createTextNode(dn===null?'0':String(dn)));if(LANG!=='en'||dn===null)dayEl.appendChild(el('small',null,dn===null?'1일차 이전':'일차'));
  txt('gf-phase',PHASE_TEXT[v.phase]||str(v.phase,40));
  txt('gf-fwd',FWD_TEXT[v.forwardingNow]||'—');
  txt('gf-day1',kstDate(o.anchor));
  var r=obj(v.restarts)?v.restarts:{};txt('g-sum',st[0]+' \u00b7 '+(dn===null?'1일차 이전':dayN(dn))+' \u00b7 '+'재시작'+' '+num(r.total));txt('gf-restarts',num(r.total)+'회 (1일차 복귀 '+num(r.toDay1)+' · 8일차 복귀 '+num(r.toDay8)+')'+(r.signal?' · 3회 신호':''));
  txt('gf-mbx',arr(g.humanMailboxes).map(function(m){return clean(m,254);}).join(', ')||'—');
  renderDays(v,o,p,dn);
  renderB3(rep,v,o);renderB4(v,p);renderB5(v,p);
  var nx=$('g-next');clear(nx);var nxLi=function(t){var li=el('li');li.appendChild(el('span',null,t));nx.appendChild(li);};
  var raw=arr(v.next),steps=arr(v.nextSteps),nn=Math.max(raw.length,steps.length);
  for(var ni=0;ni<nn;ni++){var nt=nextStepText(steps[ni]);nxLi(nt!==null?nt:str(raw[ni],400));}
  if(!nn)nxLi('—');
  txt('fwd-now','지금 '+(FWD_TEXT[v.forwardingNow]||'—')+' · '+(dn===null?'1일차 이전':dayN(dn))+' · '+(PHASE_TEXT[v.phase]||''));
  ivHint();
}
function renderDays(v,o,p,dn){
  var box=$('g-days');clear(box);
  var daily=arr(o.dailyForwarded),senders=arr(o.dailySenders);
  var obsEnd=Math.max(T.observationDays,typeof o.comparisonDay==='number'?o.comparisonDay:0,daily.length);
  var proofStart=p.start?dayOf(o.anchor,p.start):null;if(proofStart===null||proofStart<=obsEnd)proofStart=obsEnd+1;
  var n=Math.max(T.observationDays+T.proofDays,proofStart+T.proofDays-1,dn||0);if(n>42)n=42;
  box.style.gridTemplateColumns='repeat('+n+',minmax(0,1fr))';
  function phase(label,span){if(span<=0)return;var h=el('div','phase',label);h.style.gridColumn='span '+span;box.appendChild(h);}
  phase('관측 · 규칙 ON',obsEnd);phase('전환',proofStart-obsEnd-1);phase('증명 · 규칙 OFF · 개입 0',n-proofStart+1);
  var max=1;daily.forEach(function(c){if(num(c)>max)max=num(c);});if(num(o.todayForwarded)>max)max=num(o.todayForwarded);
  var done=num(p.completeDays),clean0=arr(p.interventions).length===0&&arr(p.leaks).length===0;
  for(var i=1;i<=n;i++){
    var cls='day'+(dn!==null&&i<dn?' past':'')+(dn===i?' now':'');
    var c=el('div',cls),col=el('div','col'),fill=el('i');col.appendChild(fill);
    var label='',title=dayN(i);
    if(i<=daily.length){var cnt=num(daily[i-1]);label=String(cnt);fill.style.height=(cnt/max*100).toFixed(1)+'%';title+=' · 전달 '+cnt+'건 · 외부 발신자 '+num(senders[i-1])+'명';}
    else if(dn===i&&v.phase==='observation'){var tc=num(o.todayForwarded);label=String(tc);col.className='col fill';fill.style.height=(tc/max*100).toFixed(1)+'%';title+=' · 오늘 지금까지 '+tc+'건';}
    else if(i>=proofStart&&i<proofStart+done){col.className='col fill';fill.style.height='100%';label=clean0?'ok':'';title+=' · 끝난 증명일';}
    c.appendChild(label==='ok'?el('div','cnt ok'):el('div','cnt',label));
    col.setAttribute('title',title);c.appendChild(col);
    var tag=i===o.baselineDay?'기준':i===o.comparisonDay?'비교':'';c.appendChild(el('div','tagx',tag));
    c.appendChild(el('div','d',String(i)));box.appendChild(c);
  }
}
function renderB3(rep,v,o){
  var daily=arr(o.dailyForwarded),senders=arr(o.dailySenders),line,kind;
  if(typeof o.baselineDay!=='number'){
    line='기준일 없음. 서로 다른 외부 발신자 '+T.minBaselineSenders+'명 이상에게서 전달이 온 날이 아직 없습니다. 통과가 아닙니다.';
  }else{
    var b=o.baselineDay,base=num(daily[b-1]),cmp=typeof o.comparisonDay==='number'?daily[o.comparisonDay-1]:undefined;
    line='기준일 '+b+'일차 '+base+'건('+num(senders[b-1])+'명) → 비교일 '+(typeof o.comparisonDay==='number'?o.comparisonDay+'일차 ':'')+
      (cmp===undefined?'(진행 전)':num(cmp)+'건')+'. 기준의 절반 이하('+(base/2)+'건 이하)여야 합니다.'+(b>1?' 관측 연장 +'+(b-1)+'일.':'');
  }
  kind=o.trend==='passed'?['OK','on']:o.trend==='failed'?['NG','bad']:['진행 중','wait'];
  pill('b3-pill',kind[0],kind[1]);txt('b3-line',line);
  txt('b3-sub','1일차 시작 시 ON 기록 '+(o.onAtStart?'있음':'없음(관측 무효)')+' · 판정식 불일치 의심 '+num(rep.auxiliaryOnly)+'건'+(num(rep.auxiliaryOnly)>0?'(1건이라도 있으면 통과 아님, ac0:probe)':'')+' · 인계 시험 전체 전달 '+num(rep.forwardedTotal)+'건');
}
function renderB4(v,p){
  var iv=arr(p.interventions),lk=arr(p.leaks),done=num(p.completeDays),log=$('b4-log');clear(log);
  txt('b4-days',done+' / '+T.proofDays+'일');bar($('b4-meter'),done/T.proofDays);
  if(!p.start){txt('b4-line','증명 구간 시작 전입니다. 전달 규칙 OFF 기록이 있어야 시작합니다(OFF 기록 다음 KST 자정부터).');pill('b4-pill','시작 전','dim');}
  else{txt('b4-line','증명 시작 '+kst(p.start)+' · 개입 '+iv.length+'건 · 규칙 OFF 뒤 전달 도착(누수) '+lk.length+'건');
    if(iv.length||lk.length)pill('b4-pill','NG','bad');else if(done>=T.proofDays)pill('b4-pill','OK','on');else pill('b4-pill','진행 중','wait');}
  function row(rec,obs){var li=el('li');li.appendChild(el('span','muted',kst(rec.recordedAt)+' · '));
    li.appendChild(el('strong',null,'['+(CAT_TEXT[rec.category]||str(rec.category,30))+'] '));li.appendChild(d.createTextNode(str(rec.reason,500)));
    if(obs)li.appendChild(el('span','sub','관측·전환 구간: 판정에 들지 않지만 원인 수정 대상'));log.appendChild(li);}
  iv.filter(obj).forEach(function(x){row(x,false);});arr(v.observationInterventions).filter(obj).forEach(function(x){row(x,true);});
}
function renderB5(v,p){
  var box=$('b5-meters');clear(box);var a=obj(p.activity)?p.activity:null;
  var items=[['신규 외부 상대',a?num(a.newExternalContacts):0,T.newExternalContacts,'그 창에서 처음 성공 발송한 상대(정규화 주소 단위)'],
    ['outbound 성공',a?num(a.outboundSuccess):0,T.outboundSuccess,'외부 수신자가 있는 발송(반송·거부 제외)'],
    [T.minTurns+'턴 이상 스레드',a?num(a.multiTurnThreads):0,T.multiTurnThreads,'창 안의 메시지만으로 센 턴']];
  items.forEach(function(it){var r=el('div','mrow'),h=el('div','mh');h.appendChild(el('span',null,it[0]));h.appendChild(el('b',null,it[1]+' / '+it[2]));
    var m=el('div','meter'),f=el('i');m.appendChild(f);r.appendChild(h);r.appendChild(m);r.appendChild(el('span','sub small muted',it[3]));box.appendChild(r);bar(f,it[1]/it[2]);});
  if(!a){txt('b5-window','창 없음. 끝난 증명일이 7일 이상일 때 산출합니다.');pill('b5-pill','대기','wait');return;}
  var w=obj(a.window)?a.window:{};txt('b5-window','창 '+kst(w.start)+' ~ '+kst(w.end)+' · 첫 충족 창, 없으면 최근 창');
  if(a.satisfied===true)pill('b5-pill','OK','on');else pill('b5-pill','미달','bad');
}

function gateId(){return S.report&&obj(S.report.gate)&&typeof S.report.gate.id==='string'?S.report.gate.id:'';}
function verdict(){return S.report&&obj(S.report.verdict)?S.report.verdict:{};}
$('fwd-on').addEventListener('click',function(){var b=this,v=verdict(),late=v.phase==='proof'||v.phase==='switch';
  ask({kicker:'ON 기록',title:'전달 규칙 ON을 기록할까요?',danger:late,ok:'ON 기록',
    body:['Gmail seed 필터가 켜져 있는지 눈으로 본 뒤 기록합니다. 1일차 00:00 KST 전에 합니다.',
      late?'지금은 '+(PHASE_TEXT[v.phase]||'')+' 구간입니다. 규칙을 다시 켜면 재시작(1일차 복귀)입니다.':''],
    ack:'Gmail seed 필터가 켜져 있는 것을 확인했습니다'})
  .then(function(y){if(!y)return;return run(b,'fwd-msg',function(){return api('POST','/api/gate/forwarding',{gateId:gateId(),state:'on'}).then(function(){
    say('fwd-msg','ON을 기록했습니다.','ok');return loadGate();});});});});
$('fwd-off').addEventListener('click',function(){var b=this,v=verdict(),o=obj(v.observation)?v.observation:{},dn=typeof v.dayNumber==='number'?v.dayNumber:null;
  var cmp=typeof o.comparisonDay==='number'?o.comparisonDay:T.observationDays,early=dn===null||dn<cmp;
  ask({kicker:'OFF 기록',title:'전달 규칙 OFF를 기록할까요?',danger:true,ok:'OFF 기록',
    body:['8일차에 끕니다. 정확히는 비교일('+cmp+'일차) 23:00–24:00 KST. 증명 구간은 OFF 기록 다음 KST 자정부터 셉니다.',
      '먼저 Gmail 필터를 삭제하고 전달 주소도 삭제합니다. 기록 시각은 서버의 지금이고, 바꿀 수 없습니다.',
      early?'현재 '+(dn===null?'1일차 이전':dayN(dn))+'. 비교일 전입니다. 지금 끄면 관측이 무효가 되어 1일차로 돌아갑니다.':'현재 '+dayN(dn)+'.',
      v.forwardingNow==='off'?'이미 OFF가 기록돼 있습니다. 다시 기록할 필요가 없습니다.':''],
    ack:'Gmail 필터와 전달 주소를 삭제했고, 지금이 비교일 밤임을 확인했습니다'})
  .then(function(y){if(!y)return;return run(b,'fwd-msg',function(){return api('POST','/api/gate/forwarding',{gateId:gateId(),state:'off'}).then(function(){
    say('fwd-msg','OFF를 기록했습니다. 판정에 "전환 대기"가 보여야 합니다.','ok');return loadGate();});});});});
function ivHint(){var c=$('iv-cat').value,v=verdict(),h;
  if(v.phase==='proof')h=c==='address_transition'?'증명 구간입니다. 기록하면 1일차로 복귀합니다(그 상대에게 재공지 후 규칙 ON).':'증명 구간입니다. 기록하면 8일차로 복귀합니다(원인을 고쳐 배포, 규칙은 OFF 그대로).';
  else h='관측·전환 구간의 개입은 판정에 들지 않지만 출력에 남고, 원인 수정 대상입니다.';
  txt('iv-hint',h);}
$('iv-cat').addEventListener('change',ivHint);
function parseList(v){var out=[],seen={};String(v||'').split(/[\s,;]+/).forEach(function(x){x=x.trim();if(!x)return;var k=x.toLowerCase();if(seen[k])return;seen[k]=1;out.push(x);});return out;}
/* intervention and trial start: a button opens a dialog with the fields (2026-09-30: every create flow is a lightbox). Submitting still goes
   through the confirm dialog (ask, stacked on top) because the record cannot be undone; confirmed and saved, the dialog closes and the
   result is said on the page, next to the button the dialog hands focus back to. */
function ivOpen(){var b=$('iv-open');if(b.disabled||!can('admin'))return;$('iv-cat').value='address_transition';$('iv-reason').value='';ivHint();
  fieldErr($('iv-reason'),'');say('di-msg','');$('dlg-iv').showModal();$('iv-cat').focus();}
$('iv-open').addEventListener('click',ivOpen);
dlgBind('dlg-iv','iv-go','di-cancel');
$('iv-form').addEventListener('submit',function(ev){ev.preventDefault();
  var cat=$('iv-cat').value,reason=$('iv-reason').value.replace(/[\r\n]+/g,' ').trim(),v=verdict();
  say('di-msg','');fieldErr($('iv-reason'),'');
  if(!reason){fieldErr($('iv-reason'),'사유를 한 줄 적어 주세요.');return;}
  if(reason.length>500){fieldErr($('iv-reason'),'사유는 500자까지입니다.');return;}
  var b=$('iv-go');
  ask({kicker:'개입 기록',title:fmt('{c} 개입을 기록할까요?',{c:CAT_TEXT[cat]||cat}),danger:v.phase==='proof',ok:'기록',
    body:['사유: '+reason,$('iv-hint').textContent,'기록은 지울 수 없습니다(append-only). 기록 시각은 서버의 지금입니다. 승인 링크 클릭은 개입이 아닙니다.'],
    ack:v.phase==='proof'?'증명 구간 개입이 재시작을 부르는 것을 확인했습니다':''})
  .then(function(y){if(!y)return;return run(b,'di-msg',function(){return api('POST','/api/gate/intervention',{gateId:gateId(),category:cat,reason:reason}).then(function(){
    $('dlg-iv').close();say('iv-msg','기록했습니다.','ok');return loadGate();});});});
});
function gsOpen(){var b=$('gs-open');if(b.disabled||!can('admin'))return;$('gs-mbx').value='';$('gs-day1').value='';$('gs-new').checked=false;
  fieldErr($('gs-mbx'),'');say('dg-msg','');$('dlg-gstart').showModal();$('gs-mbx').focus();}
$('gs-open').addEventListener('click',gsOpen);
dlgBind('dlg-gstart','gs-go','dg-cancel');
$('gs-form').addEventListener('submit',function(ev){ev.preventDefault();
  var mbx=parseList($('gs-mbx').value),day1=$('gs-day1').value;
  say('dg-msg','');fieldErr($('gs-mbx'),'');
  if(!mbx.length){fieldErr($('gs-mbx'),'사람 메일함 주소를 하나 이상 적어 주세요.');return;}
  var bad=mbx.filter(function(x){return x.indexOf('@')<1||x.lastIndexOf('@')===x.length-1;});
  if(bad.length){fieldErr($('gs-mbx'),'주소 모양이 아닙니다: '+bad.map(function(x){return clean(x,80);}).join(', '));return;}
  if(day1&&!/^\d{4}-\d{2}-\d{2}$/.test(day1)){say('dg-msg','1일차는 YYYY-MM-DD 입니다.','err');return;}
  var body={agentId:S.gateAgent,humanMailboxes:mbx};if(day1)body.day1=day1;
  var fresh=$('gs-new').checked;if(fresh)body.newGate=true;
  if(S.gates.length&&!fresh){say('dg-msg',CODES.gate_exists,'err');return;}
  var b=$('gs-go');
  ask({kicker:'인계 시험 시작',title:fresh?'새 인계 시험을 따로 열까요?':'인계 시험을 열까요?',ok:'시작',
    body:['1일차 = '+(day1?day1+' 00:00 KST':'다음 KST 자정')+'. 사람 메일함(별칭 포함):',
      fresh?'기존 인계 시험은 그대로 남습니다. 이제부터 판정할 때마다 인계 시험을 골라야 합니다.':''],list:mbx.map(function(x){return addrNode(x,false);}),
    ack:'첫 전달 메일이 "전달"로 판정되는 것을 확인했습니다(인계 시험 0일차 13단계)'})
  .then(function(y){if(!y)return;return run(b,'dg-msg',function(){return api('POST','/api/gate/start',body).catch(function(e){
    if(e instanceof ApiError&&e.code==='gate_exists')$('gs-new-wrap').hidden=false;throw e;}).then(function(j){
    if(j&&typeof j.gateId==='string')S.gate=j.gateId;$('dlg-gstart').close();
    say('gs-msg','인계 시험을 열었습니다. 1일차 '+kstDate(j&&j.day1)+'. 다음: 1일차 00:00 KST 전에 전달 규칙 ON 기록.','ok');return loadGate();});});});
});

`;
