/**
 * src/admin/ui/console/script/tokens.ts — 앱 스크립트 조각: 토큰 목록(D7 · 계약 `console-v4-api.md` §1) — 이름 있는 여러 토큰(활성 상한 5) ·
 * 토큰 값(접두사 + 가림 + 끝 4자 — 평문은 저장되지 않는다) · 권한(발급 때 고름 — R-7, 하나 이상) · 활성 토큰 행마다 ⋯ 메뉴(이름 바꾸기 · 교체 ·
 * 폐기 — 끝난 토큰은 동작 없음) · 새 토큰 대화상자 → 평문은 v3 토큰 창에서 한 번만(교체도 같은 창) · 머리의 전부 교체/전부 폐기.
 *
 * 이름 검사는 서버(`isValidTokenLabel`)와 같다 — 길이는 **코드 포인트**, 금지 문자는 서버의 정규식 그대로(`INVISIBLE_OR_CONTROL_CHARACTERS`
 * 의 원문을 스크립트에 싣는다). 최종 판정은 서버다.
 */

import { INVISIBLE_OR_CONTROL_CHARACTERS } from '../../../display';
import { OWNER_ONLY_CAPS, TOKEN_CAPS } from '../markup/agent-tokens';

export const TOKENS_JS = String.raw`/* ---------- tokens ---------- */
var TKBAD=/${INVISIBLE_OR_CONTROL_CHARACTERS.source}/u;
function labelOk(v){var n=Array.from(v).length;return n>=1&&n<=60&&!TKBAD.test(v);}
var TKPFX='atk_agent_';
var CAPS={'messages:send':'보내기','messages:read':'읽기','audit:read':'감사','agent:read_self':'자기 정보','policy:request':'정책 변경 요청','webhooks:manage':'웹훅 관리','agents:enroll':'자가 등록'};
var TKST={active:['활성',''],expired:['만료됨','dim'],revoked:['폐기됨','dim']};
/* one call (status=all: active + ended within 90 days); the active filter is client side, so both counts are known. */
function loadTokens(id){return api('GET','/api/agents/'+enc(id)+'/tokens?status=all').then(function(j){j=obj(j)?j:{};
  var list=arr(j.tokens).filter(function(t){return obj(t)&&typeof t.id==='string';}),act=list.filter(function(t){return t.status==='active';}).length;
  S.tok[id]={list:list,active:typeof j.activeCount==='number'?j.activeCount:act,max:typeof j.maxActive==='number'?j.maxActive:5};return S.tok[id];});}
function showTokens(a,soft){renderTokens(a);if(soft&&S.tok[a.id])return;
  loadTokens(a.id).then(function(){if(S.cur===a.id&&S.route.tab==='tokens')renderTokens(a);},sectionErr('tk-msg'));}
function tokenName(t){return typeof t.label==='string'&&t.label?str(t.label,60):'';}
/* expiry: none, a KST date, or D-n in bold when an active token ends within 7 days. */
function expCell(t,now){var e=typeof t.expiresAt==='string'?new Date(t.expiresAt).getTime():NaN;if(isNaN(e))return el('span','muted','만료 없음');
  var days=Math.ceil((e-now)/86400000),n=t.status==='active'&&days>=0&&days<=7?el('strong','num','D-'+days):el('span','num',ymd(t.expiresAt));n.title=kst(t.expiresAt);return n;}
function renderTokens(a){var T=S.tok[a.id]||null,list=T?T.list:[],f=S.tkFilter,now=Date.now();
  var act=list.filter(function(t){return t.status==='active';}),shown=f==='active'?act:list,max=T?T.max:5,n=T?T.active:num(a.activeTokens);
  txt('tk-count',T?n+' / '+max:'');
  /* bulk actions and the filter need tokens to act on; with none the empty state is the one thing on the screen (critique R7-02 · R7-17). */
  $('tk-bulk').disabled=!T;gate($('tk-bulk'),'admin');$('tk-bulk').hidden=!!T&&!list.length;$('tk-filter').hidden=!!T&&!list.length;txt('tk-f-endn',T?'('+(list.length-act.length)+')':'');
  /* the server lists every active token first; if the count and the rows still differ, say so in one line. */
  var gap=!!T&&n!==act.length;$('tk-gap').hidden=!gap;txt('tk-gap',gap?fmt('활성 토큰 {n}개 중 {m}개만 보입니다. 새로고침하세요.',{n:n,m:act.length}):'');
  $('tk-f-all').checked=f==='all';
  var full=!!T&&n>=max,nb=$('tk-new');nb.disabled=full;nb.title=full?CODES.token_limit:'';gate(nb,'admin');
  var tb=$('tk-body');clear(tb);$('tk-tbl').hidden=!shown.length;$('tk-empty').hidden=!T||shown.length>0;
  shown.forEach(function(t){tb.appendChild(tokenRow(a,t,now));});}
function tokenRow(a,t,now){var tr=el('tr',t.status==='active'?'':'off'),name=tokenName(t),k=TKST[t.status];
  var c=cell(tr,'이름'),nm=el('span','tkn');nm.appendChild(el('span',name?'strong':'muted',name||'이름 없음'));
  if(t.status!=='active')nm.appendChild(pillEl(k?k[0]:str(t.status,20),'dim'));c.appendChild(nm);
  cell(tr,'토큰 값').appendChild(el('span','mono',maskKey(TKPFX,t.hint)));
  var w=el('span','caps');arr(t.capabilities).forEach(function(x){if(typeof x==='string')w.appendChild(el('span','cap',CAPS[x]||str(x,40)));});
  /* implied scopes (policy:request on tokens issued before it became a default): shown like any other scope, with a note on hover. */
  arr(t.impliedCapabilities).forEach(function(x){if(typeof x!=='string')return;var s=el('span','cap',CAPS[x]||str(x,40));s.title='이 권한이 생기기 전에 발급한 토큰에도 포함됩니다. 다시 발급하지 않아도 됩니다.';w.appendChild(s);});
  cell(tr,'권한').appendChild(w);
  var cr=cell(tr,'만든 날');cr.className='cv num';cr.textContent=ymd(t.createdAt);cr.title=kst(t.createdAt);
  var u=cell(tr,'마지막 사용'),uu=typeof t.lastUsedAt==='string'&&!!t.lastUsedAt;u.className='cv used'+(uu?'':' none');u.textContent=uu?fmtDateTime(t.lastUsedAt,now):EMPTY;u.title=uu?kst(t.lastUsedAt):'사용 기록 없음';
  cell(tr,'만료').appendChild(expCell(t,now));
  /* row actions behind one menu button, active tokens only: rename, rotate, revoke. An ended token is a record and has no actions. */
  var ac=el('td','act');tr.appendChild(ac);if(t.status!=='active'||!can('admin'))return tr;
  rowMenu(ac,'tkm-'+t.id,name||'이름 없음',[{label:'이름 바꾸기',fn:function(){ntOpen('rename',a,t);}},{label:'교체',fn:function(mb){rotateToken(a,t,mb);}},{label:'폐기',fn:function(mb){revokeToken(a,t,mb);},danger:true}]);
  return tr;}
function revokeToken(a,t,b){var name=tokenName(t)||'이름 없음';
  ask({kicker:'토큰 폐기',title:fmt('{n} 토큰을 폐기할까요?',{n:name}),danger:true,ok:'폐기',body:['이 토큰을 쓰는 곳은 바로 끊깁니다. 다른 토큰은 그대로입니다.'],warn:'폐기는 되돌릴 수 없습니다.'})
  .then(function(y){if(!y)return;return run(b,'tk-msg',function(){return api('POST','/api/agents/'+enc(a.id)+'/tokens/'+enc(t.id)+'/revoke').then(function(){
    say('tk-msg',fmt('{n} 토큰을 폐기했습니다.',{n:name}),'ok');return loadTokens(a.id).then(function(){renderTokens(a);landFocus('h-ag-tokens');return refreshAgents();});});});});}
/* rotate one: revoke it + a new token with the same name, scopes and lifetime, in one step on the server. The plaintext goes to the v3 token window once. */
function rotateToken(a,t,b){var name=tokenName(t)||'이름 없음';
  ask({kicker:'토큰 교체',title:fmt('{n} 토큰을 교체할까요?',{n:name}),danger:true,ok:'교체',body:['같은 이름·권한·기간으로 새 토큰을 발급하고, 지금 토큰은 바로 폐기합니다. 새 토큰은 다음 창에서 한 번만 보입니다.'],warn:'이 토큰을 쓰는 곳에 새 토큰을 넣어야 합니다.'})
  .then(function(y){if(!y)return;return run(b,'tk-msg',function(){return api('POST','/api/agents/'+enc(a.id)+'/tokens/'+enc(t.id)+'/rotate').then(function(j){
    say('tk-msg',fmt('{n} 토큰을 교체했습니다.',{n:name}),'ok');showToken(j&&j.token,a,'rotate-one','h-ag-tokens');
    return loadTokens(a.id).then(function(){renderTokens(a);});});});});}
/* new token / rename: one dialog. The plaintext comes back once and goes straight to the v3 token window. */
var NT={mode:'new',agent:null,token:null};
/* R-7: the capabilities are chosen at issue (the first four on by default, webhooks:manage off). None chosen = the issue button is locked
   (the server answers 400 too). Count and defaults come from the markup's TOKEN_CAPS. */
var NTCAPS=${String(TOKEN_CAPS.length)},NTON=${JSON.stringify(TOKEN_CAPS.map((c) => c[2]))};
/* owner-only scopes (agents:enroll - 2026-10-08): the box is shown to owners only; anyone else never sends it (the server checks again). */
var NTOWN=${JSON.stringify(TOKEN_CAPS.map((c) => OWNER_ONLY_CAPS.includes(c[0])))};
function ntCaps(){var out=[];for(var i=0;i<NTCAPS;i++){var c=$('nt-cap-'+i);if(c.checked&&!(NTOWN[i]&&!can('owner')))out.push(c.value);}return out;}
function ntCheck(){var none=NT.mode==='new'&&!ntCaps().length;$('nt-go').disabled=none;$('nt-caps-none').hidden=!none;
  var en=false;for(var i=0;i<NTCAPS;i++)if(NTOWN[i]&&$('nt-cap-'+i).checked)en=true;$('nt-enroll-warn').hidden=!en;}
for(var nti=0;nti<NTCAPS;nti++)$('nt-cap-'+nti).addEventListener('change',ntCheck);
function ntOpen(mode,a,t){if(!a||!can('admin'))return;NT={mode:mode,agent:a,token:t||null};txt('nt-title',mode==='new'?'토큰 발급':'이름 바꾸기');txt('nt-go',mode==='new'?'발급':'저장');
  $('nt-exp-w').hidden=mode!=='new';$('nt-caps-w').hidden=mode!=='new';for(var i=0;i<NTCAPS;i++){$('nt-cap-'+i).checked=NTON[i];$('nt-cap-'+i+'-w').hidden=NTOWN[i]&&!can('owner');}$('nt-go').disabled=false;$('nt-caps-none').hidden=true;$('nt-enroll-warn').hidden=true;$('nt-label').value=mode==='rename'?tokenName(t):'';$('nt-exp').value='';say('nt-msg','');fieldErr($('nt-label'),'');$('dlg-newtok').showModal();$('nt-label').focus();}
$('nt-cancel').addEventListener('click',function(){$('dlg-newtok').close();});
$('nt-form').addEventListener('submit',function(ev){ev.preventDefault();var a=NT.agent,t=NT.token;if(!a)return;var label=$('nt-label').value.trim();
  say('nt-msg','');if(!labelOk(label)){fieldErr($('nt-label'),CODES.invalid_label);return;}fieldErr($('nt-label'),'');
  if(NT.mode==='rename'&&t){run($('nt-go'),'nt-msg',function(){return api('PATCH','/api/agents/'+enc(a.id)+'/tokens/'+enc(t.id),{label:label}).then(function(){
    $('dlg-newtok').close();say('tk-msg','이름을 바꿨습니다.','ok');return loadTokens(a.id).then(function(){renderTokens(a);});});});return;}
  var caps=ntCaps();if(!caps.length){ntCheck();return;}
  var body={label:label,capabilities:caps},exp=$('nt-exp').value;if(exp)body.expiresDays=Number(exp);
  run($('nt-go'),'nt-msg',function(){return api('POST','/api/agents/'+enc(a.id)+'/tokens',body).then(function(j){$('dlg-newtok').close();
    say('tk-msg',fmt('{n} 토큰을 발급했습니다.',{n:clean(label,60)}),'ok');showToken(j&&j.token,a,'issue');
    return loadTokens(a.id).then(function(){renderTokens(a);return refreshAgents();});});});});
$('tk-new').addEventListener('click',function(){ntOpen('new',curAgent());});
$('tk-f-all').addEventListener('change',function(){S.tkFilter=this.checked?'all':'active';var a=curAgent();if(a)renderTokens(a);});
bindMenu($('tk-bulk'));
$('tk-rotate').addEventListener('click',function(){var a=curAgent();if(a)rotate(a,$('tk-bulk'),'tk-msg');});
$('tk-revoke').addEventListener('click',function(){var a=curAgent();if(a)revokeAll(a,$('tk-bulk'),'tk-msg');});
`;
