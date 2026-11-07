/**
 * src/admin/ui/console/script/team.ts — 앱 스크립트 조각: 설정의 멤버(목록 · 역할 · 제거 · 나가기 · 초대 · 초대 취소)와 조직 API 키
 * (목록 · 발급 → 평문 한 번만 · 교체 · 폐기 · 이름) — `extensibility-p0-p1.md` §3.3 · §3.7 · §4-4.
 *
 * 멤버 목록은 누구나 본다(GET 은 member). 바꾸는 동작은 owner 만 — 그 밖의 역할에는 컨트롤을 만들지 않거나 잠근다. 조직 키는 owner 만
 * 보고 관리한다(owner 가 아니면 목록을 부르지 않고 한 줄로 말한다). 조직 키 평문은 에이전트 토큰 창과 **다른** 창에서 한 번만 보인다.
 */

import { ORG_API_URL } from '../markup/org-team';

export const TEAM_JS = String.raw`/* ---------- members (P1 s3.3) ---------- */
function loadMembers(){return api('GET','/api/members').then(function(j){j=obj(j)?j:{};
  S.mb={members:arr(j.members).filter(function(m){return obj(m)&&typeof m.userId==='string';}),
    invites:arr(j.invites).filter(function(x){return obj(x)&&typeof x.id==='string';}),limits:obj(j.limits)?j.limits:{}};renderMembers();});}
function limN(v){return typeof v==='number'&&isFinite(v)?v:null;}
function renderMembers(){var M=S.mb,own=can('owner'),iv=$('mb-invite');gate(iv,'owner');
  if(!M){txt('mb-count','—');iv.disabled=true;$('mb-leave').hidden=true;return;}
  var max=limN(M.limits.maxMembers),pend=M.invites.filter(function(x){return x.status==='pending'||x.status===undefined;}),maxInv=limN(M.limits.maxPendingInvites);
  txt('mb-count',M.members.length+(max!==null?' / '+max:''));
  if(own){var full=max!==null&&M.members.length+pend.length>=max,ifull=maxInv!==null&&pend.length>=maxInv;iv.disabled=full||ifull;iv.title=full?CODES.member_limit:ifull?CODES.invite_limit:'';}
  var tb=$('mb-body');clear(tb);M.members.forEach(function(m){tb.appendChild(memberRow(m,own));});
  $('inv-w').hidden=!pend.length;txt('inv-n',pend.length+(maxInv!==null?' / '+maxInv:''));
  var ib=$('inv-body');clear(ib);pend.forEach(function(x){ib.appendChild(inviteRow(x,own));});
  var me=M.members.filter(function(m){return m.you===true;})[0];$('mb-leave').hidden=!me||me.primary===true;}
function memberRow(m,own){var tr=el('tr'),you=m.you===true,fixed=m.primary===true||you;
  var c=cell(tr,'주소'),w=el('span','mbn');w.appendChild(addrNode(m.email,false));if(you)w.appendChild(pillEl('내 계정','tag'));if(m.primary===true)w.appendChild(pillEl('주 소유자','tag'));c.appendChild(w);
  var rc=cell(tr,'역할');
  if(own&&!fixed){var sel=el('select','rolesel');sel.setAttribute('aria-label',fmt('{e} 역할',{e:clean(m.email,254)}));
    ['owner','admin','member'].forEach(function(r){var o=el('option',null,ROLE_NAME[r]);o.value=r;sel.appendChild(o);});
    sel.value=roleOf(m.role)||'member';sel.addEventListener('change',function(){changeRole(m,sel);});rc.appendChild(sel);}
  else rc.appendChild(roleChip(m.role));
  var jc=cell(tr,'참여한 날');jc.className='cv num';jc.textContent=ymd(m.joinedAt);jc.title=kst(m.joinedAt);
  var ac=el('td','act');tr.appendChild(ac);
  if(own&&!fixed)rowAct(ac,'제거',function(b){removeMember(m,b);},fmt('{e} 제거',{e:clean(m.email,254)}));
  return tr;}
function changeRole(m,sel){var to=sel.value,from=roleOf(m.role)||'member';if(to===from)return;
  var o={kicker:'역할 변경',title:fmt('{e}의 역할을 바꿀까요?',{e:clean(m.email,254)}),ok:'변경',body:[ROLE_NAME[from]+' → '+ROLE_NAME[to]]};
  if(to==='owner')o.body.push('소유자는 멤버·초대·조직 API 키까지 전부 관리합니다.');
  if(from==='owner')o.body.push('이 사람은 멤버·초대·조직 API 키를 더 관리하지 못합니다.');
  ask(o).then(function(y){if(!y){sel.value=from;return;}sel.disabled=true;say('mb-msg','');
    return api('PATCH','/api/members/'+enc(m.userId),{role:to}).then(function(){say('mb-msg','역할을 바꿨습니다.','ok');return loadMembers();},
      function(e){sel.value=from;say('mb-msg',human(e),'err');}).then(function(){sel.disabled=false;});});}
function removeMember(m,b){ask({kicker:'멤버 제거',title:fmt('{e} 멤버를 이 조직에서 제거할까요?',{e:clean(m.email,254)}),danger:true,ok:'제거',
  body:['이 사람의 이 조직 세션이 바로 끊깁니다. 다른 조직의 멤버십은 그대로입니다. 다시 들어오려면 새 초대가 필요합니다.']})
  .then(function(y){if(!y)return;return run(b,'mb-msg',function(){return api('DELETE','/api/members/'+enc(m.userId)).then(function(){
    say('mb-msg','제거했습니다.','ok');return loadMembers().then(function(){landFocus('h-members');});});});});}
/* L7: an erased invitee (never joined, 30 days after the invite ended) has no address — the server sends erased:true and email:null. */
function inviteAddr(x){return x.erased===true?el('span','muted','(지워진 주소)'):addrNode(x.email,false);}
function inviteLabel(x){return x.erased===true?'(지워진 주소)':clean(x.email,254);}
function inviteRow(x,own){var tr=el('tr');cell(tr,'주소').appendChild(inviteAddr(x));cell(tr,'역할').appendChild(roleChip(x.role));
  var e=cell(tr,'만료');e.className='cv num';e.textContent=ymd(x.expiresAt);e.title=kst(x.expiresAt);
  var ac=el('td','act');tr.appendChild(ac);if(own)rowAct(ac,'초대 취소',function(b){revokeInvite(x,b);},fmt('{e} 초대 취소',{e:inviteLabel(x)}));return tr;}
function revokeInvite(x,b){ask({kicker:'초대 취소',title:fmt('{e} 초대를 취소할까요?',{e:inviteLabel(x)}),ok:'초대 취소',body:['이미 보낸 초대 링크가 더는 열리지 않습니다.']})
  .then(function(y){if(!y)return;return run(b,'mb-msg',function(){return api('POST','/api/members/invites/'+enc(x.id)+'/revoke').then(function(){
    say('mb-msg','초대를 취소했습니다.','ok');return loadMembers().then(function(){landFocus('h-members');});});});});}
function leaveOrg(b){ask({kicker:'조직에서 나가기',title:'이 조직에서 나갈까요?',danger:true,ok:'나가기',
  body:['이 조직의 콘솔을 더 볼 수 없습니다. 다시 들어오려면 소유자의 초대가 필요합니다.']})
  .then(function(y){if(!y)return;return run(b,'mb-msg',function(){return api('POST','/api/members/leave').then(function(){location.replace('/');});});});}
$('mb-leave').addEventListener('click',function(){leaveOrg(this);});
/* invite (owner): address + role. The invitee gets the invite mail, then (after opening it) a login mail bound to that browser. */
function emailOk(v){return v.length>=3&&v.length<=254&&v.indexOf('@')>0&&v.lastIndexOf('@')<v.length-1&&!/\s/.test(v);}
$('mb-invite').addEventListener('click',function(){if(!can('owner'))return;$('in-email').value='';$('in-r-member').checked=true;$('in-r-admin').checked=false;
  say('in-msg','');fieldErr($('in-email'),'');$('dlg-invite').showModal();$('in-email').focus();});
$('in-cancel').addEventListener('click',function(){$('dlg-invite').close();});
$('in-form').addEventListener('submit',function(ev){ev.preventDefault();var v=$('in-email').value.trim().toLowerCase(),role=$('in-r-admin').checked?'admin':'member';
  say('in-msg','');if(!emailOk(v)){fieldErr($('in-email'),CODES.invalid_email);return;}fieldErr($('in-email'),'');
  run($('in-go'),'in-msg',function(){return api('POST','/api/members/invites',{email:v,role:role}).then(function(){$('dlg-invite').close();
    say('mb-msg',fmt('{e}에게 초대를 보냈습니다.',{e:clean(v,254)}),'ok');return loadMembers();});});});

/* ---------- organization API keys (P1 s3.7 / p0p1-api B4): owner only (GET too); status=all = active + ended; plaintext once in its own window ---------- */
var ORG_API='${ORG_API_URL}';
var OKCAP={'agents:read':'에이전트 읽기','agents:create':'에이전트 만들기','domains:manage':'도메인 관리'};
function loadOrgKeys(){if(!can('owner')){renderOrgKeys();return Promise.resolve();}
  return api('GET','/api/org-keys?status=all').then(function(j){j=obj(j)?j:{};var list=arr(j.keys).filter(function(k){return obj(k)&&typeof k.id==='string';});
    S.ok={list:list,active:limN(j.activeCount)!==null?j.activeCount:list.filter(function(k){return k.status==='active';}).length,max:limN(j.maxActive)!==null?j.maxActive:5};renderOrgKeys();});}
function capChips(list,names){var w=el('span','caps');arr(list).forEach(function(x){if(typeof x==='string')w.appendChild(el('span','cap',names[x]||str(x,40)));});return w;}
function renderOrgKeys(){var own=can('owner'),K=S.ok,nb=$('ok-new');$('ok-owner').hidden=own;$('ok-ctl').hidden=!own;
  if(!own||!K){$('ok-tbl').hidden=true;$('ok-empty').hidden=true;txt('ok-count','—');if(!K)nb.disabled=true;gate(nb,'owner');gate($('ok-cta'),'owner');return;}
  var full=K.active>=K.max;nb.disabled=full;nb.title=full?CODES.org_key_limit:'';$('ok-cta').disabled=full;nb.hidden=!K.list.length;
  txt('ok-count',K.active+' / '+K.max);$('ok-tbl').hidden=!K.list.length;$('ok-empty').hidden=K.list.length>0;
  var tb=$('ok-body'),now=Date.now();clear(tb);K.list.forEach(function(k){tb.appendChild(orgKeyRow(k,now));});}
function orgKeyRow(k,now){var tr=el('tr',k.status==='active'?'':'off'),name=typeof k.label==='string'&&k.label?str(k.label,60):'',st=TKST[k.status];
  var c=cell(tr,'이름'),nm=el('span','tkn');nm.appendChild(el('span',name?'strong':'muted',name||'이름 없음'));
  if(k.status!=='active')nm.appendChild(pillEl(st?st[0]:str(k.status,20),'dim'));c.appendChild(nm);
  cell(tr,'키 값').appendChild(el('span','mono',maskKey(OKPFX,k.hint)));
  cell(tr,'권한').appendChild(capChips(k.capabilities,OKCAP));
  var by=cell(tr,'만든 사람');if(obj(k.createdBy)&&typeof k.createdBy.email==='string')by.appendChild(addrNode(k.createdBy.email,false));else by.textContent='—';
  var u=cell(tr,'마지막 사용'),uu=typeof k.lastUsedAt==='string'&&!!k.lastUsedAt;u.className='cv used'+(uu?'':' none');u.textContent=uu?fmtDateTime(k.lastUsedAt,now):EMPTY;u.title=uu?kst(k.lastUsedAt):'사용 기록 없음';
  cell(tr,'만료').appendChild(expCell(k,now));
  var ac=el('td','act');tr.appendChild(ac);if(k.status!=='active')return tr;
  rowMenu(ac,'okm-'+k.id,name||'이름 없음',[{label:'이름 바꾸기',fn:function(){koOpen('rename',k);}},{label:'교체',fn:function(mb){rotateOrgKey(k,mb);}},{label:'폐기',fn:function(mb){revokeOrgKey(k,mb);},danger:true}]);return tr;}
function okName(k){return typeof k.label==='string'&&k.label?str(k.label,60):'이름 없음';}
function revokeOrgKey(k,b){ask({kicker:'키 폐기',title:fmt('{n} 키를 폐기할까요?',{n:okName(k)}),danger:true,ok:'폐기',
  body:['이 키를 쓰는 CI는 바로 401을 받습니다. 이 키로 만든 에이전트는 그대로입니다.'],warn:'폐기는 되돌릴 수 없습니다.'})
  .then(function(y){if(!y)return;return run(b,'ok-msg',function(){return api('POST','/api/org-keys/'+enc(k.id)+'/revoke').then(function(){
    say('ok-msg',fmt('{n} 키를 폐기했습니다.',{n:okName(k)}),'ok');return loadOrgKeys().then(function(){landFocus('h-keys');});});});});}
function rotateOrgKey(k,b){ask({kicker:'키 교체',title:fmt('{n} 키를 교체할까요?',{n:okName(k)}),danger:true,ok:'교체',
  body:['같은 이름·권한의 새 키를 발급하고 지금 키는 바로 폐기합니다. 새 키는 다음 창에서 한 번만 보입니다.'],warn:'CI의 비밀 값을 새 키로 바꿔야 합니다.'})
  .then(function(y){if(!y)return;return run(b,'ok-msg',function(){return api('POST','/api/org-keys/'+enc(k.id)+'/rotate').then(function(j){
    say('ok-msg',fmt('{n} 키를 교체했습니다.',{n:okName(k)}),'ok');showOrgKey(j&&j.key,j&&obj(j.item)?j.item:k,'rotate');return loadOrgKeys();});});});}
/* issue / rename: one dialog. At least one capability (the server refuses an empty list too). */
var KO={mode:'new',key:null};
function koCaps(){var out=[];for(var i=0;i<3;i++){var c=$('ko-cap-'+i);if(c.checked)out.push(c.value);}return out;}
function koCheck(){var none=KO.mode==='new'&&!koCaps().length;$('ko-go').disabled=none;say('ko-msg',none?'권한을 하나 이상 고르세요.':'',none?'err':'');}
function koOpen(mode,k){if(!can('owner'))return;KO={mode:mode,key:k||null};txt('ko-title',mode==='new'?'키 발급':'이름 바꾸기');txt('ko-go',mode==='new'?'발급':'저장');
  $('ko-caps-w').hidden=mode!=='new';$('ko-exp-w').hidden=mode!=='new';$('ko-label').value=mode==='rename'&&k?(typeof k.label==='string'?k.label:''):'';$('ko-exp').value='';
  for(var i=0;i<3;i++)$('ko-cap-'+i).checked=i<2;$('ko-go').disabled=false;say('ko-msg','');fieldErr($('ko-label'),'');$('dlg-orgkey').showModal();$('ko-label').focus();}
for(var koi=0;koi<3;koi++)$('ko-cap-'+koi).addEventListener('change',koCheck);
$('ok-new').addEventListener('click',function(){koOpen('new');});
$('ok-cta').addEventListener('click',function(){koOpen('new');});
$('ko-cancel').addEventListener('click',function(){$('dlg-orgkey').close();});
$('ko-form').addEventListener('submit',function(ev){ev.preventDefault();var label=$('ko-label').value.trim(),k=KO.key;
  say('ko-msg','');if(!labelOk(label)){fieldErr($('ko-label'),CODES.invalid_label);return;}fieldErr($('ko-label'),'');
  if(KO.mode==='rename'&&k){run($('ko-go'),'ko-msg',function(){return api('PATCH','/api/org-keys/'+enc(k.id),{label:label}).then(function(){
    $('dlg-orgkey').close();say('ok-msg','이름을 바꿨습니다.','ok');return loadOrgKeys();});});return;}
  var caps=koCaps();if(!caps.length){koCheck();return;}
  var body={label:label,capabilities:caps},exp=$('ko-exp').value;if(exp)body.expiresDays=Number(exp);
  run($('ko-go'),'ko-msg',function(){return api('POST','/api/org-keys',body).then(function(j){$('dlg-orgkey').close();
    say('ok-msg',fmt('{n} 키를 발급했습니다.',{n:clean(label,60)}),'ok');showOrgKey(j&&j.key,j&&obj(j.item)?j.item:{label:label,capabilities:caps},'issue');return loadOrgKeys();});});});
/* the plaintext window: once; closing (the button, Esc) wipes the key from the DOM and this variable. */
var OKEY='';
function okExample(){return 'curl -H "Authorization: Bearer '+OKEY+'" '+ORG_API+'/agents';}
function showOrgKey(key,item,kind){OKEY=typeof key==='string'&&OKRE.test(key)?key:'';var it=obj(item)?item:{};
  txt('ks-kicker',kind==='rotate'?'새 키(이전 키는 폐기됨)':'조직 API 키');txt('ks-name',okName(it));put('ks-caps',capChips(it.capabilities,OKCAP));
  txt('ks-key',OKEY||'(응답에 키가 없습니다. 새 키를 다시 발급하세요)');txt('ks-ex',OKEY?okExample():'');
  $('dlg-okshow').showModal();$('ks-copy').focus();}
function wipeOrgKey(){OKEY='';txt('ks-key','');txt('ks-ex','');}
$('dlg-okshow').addEventListener('close',wipeOrgKey);
$('ks-close').addEventListener('click',function(){wipeOrgKey();var dl=$('dlg-okshow');if(dl.open)dl.close();});
$('ks-copy').addEventListener('click',function(){copy(OKEY,this,'ks-key');});
`;
