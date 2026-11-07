/** src/admin/ui/console/script/core.ts — 앱 스크립트 조각: 유틸 · 상태 `S` · 서식 · ⓘ 토글팁 · 메뉴 · API · 오류 문구 · 대화상자. (ASCII 코드 · 한국어는 문자열 안에만 — `app.ts` 가 순서대로 잇는다.) */

export const CORE_JS = String.raw`
var d=document;
function $(i){return d.getElementById(i);}
function el(tag,cls,text){var e=d.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=text;return e;}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function txt(id,v){$(id).textContent=v;}
function num(v){return (typeof v==='number'&&isFinite(v))?v:0;}
function arr(v){return Array.isArray(v)?v:[];}
function obj(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function str(v,max){return clean(v,max||200);}
function dayN(n){return LANG==='en'?'Day '+n:n+'일차';}
function enc(v){return encodeURIComponent(String(v));}
/* organization API key prefix (P1 s3.7) — written once so the page carries no other key-shaped text. */
var OKPFX='atk_org_',OKRE=new RegExp('^'+OKPFX+'[A-Za-z0-9_-]{8,}$');
/* a stored token or key as it looks, masked: prefix + dots + the last 4 the server keeps (an old token without them: dots only). The rest is never stored. */
function maskKey(pfx,h){return pfx+'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'+(typeof h==='string'&&/^[A-Za-z0-9_-]{4}$/.test(h)?h:'\u2022\u2022\u2022\u2022');}
var S={ready:false,csrf:'',org:null,idOrgBlocked:false,review:'active',ks:{ownerPaused:false,platformFrozen:false},agents:[],agentsLoaded:false,route:{view:''},cur:'',
  pol:{},draft:{},ident:{},gates:[],gate:'',gateAgent:'',report:null,ambiguous:false,tip:null,
  lg:{key:'',type:'outbound',agent:'',fixed:'',filter:'',dec:'',from:'',since:'',until:'',items:[],next:null,seq:0},dlSeq:0,idTimer:0,entryFromList:false,msgLang:'en',tokLang:'en',integ:null,
  blocks:{},tok:{},tkFilter:'active',stats:{},recent:{},emailDir:'outbound',menu:null,memberships:[],scrollTo:'',
  role:'owner',user:{},mb:null,ok:null,otherOrg:'',otherHref:'',moving:false,staleBusy:false,agNext:null,agq:null,agx:{},agMiss:{},swq:null};

/* ---------- format ---------- */
function kst(iso){var v=ymdhm(iso);return v==='—'?v:v+' KST';}
/* a moment in a table or list row (s3.10): fmtDateTime - relative within the hour, else MM.DD HH:mm (another year: with the year). */
function kstShort(iso){return fmtDateTime(iso,Date.now());}
function kstDate(iso){return ymd(iso);}
/* an agent without a primary (its custom domain was lost - ADR-0014 2026-10) reads "no primary address", never a bare dash; its aliases may still work. */
function addrNode(a,agent){var s=clean(a,254),w=el('span','addr');var i=agent?s.lastIndexOf('@'):-1;
  if(agent&&!s){w.className='addr none';w.textContent='대표 주소 없음';return w;}
  if(i<0){w.textContent=s||'—';return w;}
  w.appendChild(d.createTextNode(s.slice(0,i)));w.appendChild(el('span','at','@'));w.appendChild(d.createTextNode(s.slice(i+1)));return w;}
/* k: the column's kind (data-k) — narrow layouts keep a row's subject + one fact and hide the rest by kind (critique R4-02/03). */
/* a time cell: the short form (fmtDateTime) on screen, the exact KST time in the title. */
function timeCell(c,iso){c.className='cv num';c.textContent=kstShort(iso);c.title=typeof iso==='string'&&iso?kst(iso):'';return c;}
function cell(tr,label,k){var td=el('td'),v=el('div','cv');td.setAttribute('data-label',label);if(k)td.setAttribute('data-k',k);td.appendChild(v);tr.appendChild(td);v.addEventListener('mouseenter',fullText);return v;}
/* a cut-off cell (ellipsis, critique R8-02) shows its whole text on hover; set once, only when it is actually cut */
function fullText(){var n=this,i,c;if(n.scrollWidth>n.clientWidth&&!n.getAttribute('title'))n.setAttribute('title',n.textContent);if(!n.children)return;for(i=0;i<n.children.length;i++){c=n.children[i];if(c.scrollWidth>c.clientWidth&&!c.getAttribute('title'))c.setAttribute('title',c.textContent);}}
function button(label,cls,fn){var b=el('button',cls,label);b.type='button';b.addEventListener('click',function(){fn(b);});return b;}
/* row actions (2026-10-15 UI audit s3.4 · F09): one action = a quiet text button; two or more = one "..." menu, the irreversible items last,
   red, after one rule. Every table and list draws its row actions through these two. */
function rowAct(ac,label,fn,aria){var b=button(label,'btn sm link',fn);if(aria)b.setAttribute('aria-label',aria);ac.appendChild(b);return b;}
function rowMenu(ac,id,name,items){var mb=el('button','icon-btn more-btn'),m=el('div','menu rowmenu'),ul=el('ul','mlist'),sep=false;
  mb.type='button';mb.setAttribute('aria-haspopup','menu');mb.setAttribute('aria-expanded','false');mb.setAttribute('aria-label',fmt('{n} 동작',{n:name}));
  mb.appendChild(el('span',null,'\u22ef')).setAttribute('aria-hidden','true');m.id=id;m.hidden=true;mb.setAttribute('aria-controls',id);ul.setAttribute('role','menu');
  items.forEach(function(it){if(!it)return;if(it.danger&&!sep){sep=true;var sp=el('li','msep');sp.setAttribute('role','separator');ul.appendChild(sp);}
    var li=el('li'),b=el('button',it.danger?'mi danger':'mi',it.label);li.setAttribute('role','none');b.type='button';b.setAttribute('role','menuitem');
    b.addEventListener('click',function(){it.fn(mb);});li.appendChild(b);ul.appendChild(li);});
  m.appendChild(ul);ac.appendChild(mb);ac.appendChild(m);bindMenu(mb,null,m);return mb;}
function link(text,href,cls){var a=el('a',cls||null,text);a.href=href;return a;}
function pill(id,text,kind){var p=$(id);p.textContent=text;p.className='pill'+(kind?' '+kind:'');}
/* line icons built in script (critique R10-06): the same 16px 1.5-stroke set as kit.ts icon(); the SVG namespace is read from the markup's own
   <svg> (no namespace URL literal in the script). */
var ICO={copy:'M6.5 5.25h6a1.25 1.25 0 0 1 1.25 1.25v6a1.25 1.25 0 0 1-1.25 1.25h-6a1.25 1.25 0 0 1-1.25-1.25v-6a1.25 1.25 0 0 1 1.25-1.25zM10.75 5.25v-2a1 1 0 0 0-1-1h-6.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h2',check:'M3.5 8.5l3 3 6-7',arrowRight:'M3 8h10M9 4l4 4-4 4',upRight:'M5 11l6-6M6.5 5H11v4.5',downLeft:'M11 5l-6 6M9.5 11H5V6.5'};
function ico(n){var ns=$('idc-svg').namespaceURI,s=d.createElementNS(ns,'svg'),p=d.createElementNS(ns,'path');
  s.setAttribute('class','ico');s.setAttribute('viewBox','0 0 16 16');s.setAttribute('aria-hidden','true');s.setAttribute('focusable','false');
  p.setAttribute('d',ICO[n]);s.appendChild(p);return s;}
function ckEl(){var c=el('span','ck');c.appendChild(ico('check'));return c;}
function pillEl(text,kind){return el('span','pill'+(kind?' '+kind:''),text);}
function bar(node,ratio){var r=Math.max(0,Math.min(1,ratio||0));node.style.width=(r*100).toFixed(1)+'%';}
function put(id,node){var n=$(id);clear(n);n.appendChild(node);}

/* ---------- tips (toggletips: APG disclosure + Esc / outside pointer / focus leave; one open at a time) ---------- */
function tipPop(b){return $(b.getAttribute('aria-controls'));}
function placeTip(b,p){p.style.left='';p.classList.remove('tip-up');
  var w=window.innerWidth||0;if(w<=767||!p.getBoundingClientRect||!b.getBoundingClientRect)return;
  var host=p.parentNode,hr=host.getBoundingClientRect(),br=b.getBoundingClientRect(),pw=p.getBoundingClientRect().width;
  var vw=(d.documentElement&&d.documentElement.clientWidth)||w,left=br.left-12;
  if(left+pw>vw-16)left=vw-16-pw;if(left<16)left=16;
  p.style.left=Math.round(left-hr.left)+'px';
  if((window.innerHeight||0)-br.bottom<240&&br.top>240)p.classList.add('tip-up');}
/* entry motion only on a real open (critique R10-03): the "enter" class carries the @starting-style and is dropped once the fade is done,
   so a popover that is re-displayed for another reason (a breakpoint flip, a screenshot's viewport resize) is simply there, never half-faded. */
function enter(n){n.classList.add('enter');if(n._enterT)clearTimeout(n._enterT);n._enterT=setTimeout(function(){n._enterT=0;n.classList.remove('enter');},260);}
function setTip(b,on){var p=tipPop(b);if(!p)return;b.setAttribute('aria-expanded',String(on));p.hidden=!on;if(on)enter(p);
  if(on){S.tip=b;placeTip(b,p);}else if(S.tip===b)S.tip=null;}
function closeTip(){if(S.tip)setTip(S.tip,false);}
function within(n,t){return !!(n&&t&&(n===t||(n.contains&&n.contains(t))));}
d.addEventListener('click',function(ev){var t=ev.target,b=t&&t.closest?t.closest('.tip-btn'):null;if(!b)return;
  var on=b.getAttribute('aria-expanded')!=='true';if(S.tip&&S.tip!==b)setTip(S.tip,false);setTip(b,on);});
/* Esc closes the innermost thing first (menu, then tip); the event is marked handled so the drawer's Esc (shell.ts) does not also close. */
d.addEventListener('keydown',function(ev){if(ev.key!=='Escape')return;if(S.menu){closeMenu(true);ev.preventDefault();return;}if(!S.tip)return;
  if(anyDialog())return;
  var b=S.tip,a=d.activeElement,back=within(b,a)||within(tipPop(b),a);setTip(b,false);ev.preventDefault();if(back)b.focus();});
function anyDialog(){return DLGS.some(function(i){return $(i).open;});}
var DLGS=['dlg-confirm','dlg-token','dlg-log','dlg-newtok','dlg-neworg','dlg-invite','dlg-orgkey','dlg-okshow','dlg-sched-cancel','dlg-rule','dlg-sender','dlg-alias','dlg-webhook','dlg-whsecret','dlg-newagent','dlg-limit','dlg-iv','dlg-gstart','dlg-domadd','dlg-domrm','dlg-wagent','dlg-wtrust','dlg-wcap'];
d.addEventListener('pointerdown',function(ev){var b=S.tip;if(!b||within(b,ev.target)||within(tipPop(b),ev.target))return;setTip(b,false);},true);
d.addEventListener('focusout',function(ev){var b=S.tip,r=ev.relatedTarget;if(!b||!r)return;var p=tipPop(b);
  if(!(within(b,ev.target)||within(p,ev.target)))return;if(within(b,r)||within(p,r))return;setTip(b,false);});
window.addEventListener('resize',function(){if(S.tip)placeTip(S.tip,tipPop(S.tip));});

/* ---------- menus (scope switchers, token actions, the account menu): button[aria-haspopup=menu] + aria-controls, one open at a time.
   Arrow keys move between role=menuitem/menuitemradio, Esc closes and returns focus to the button, an outside pointer closes, choosing an
   item (.mi) closes. The account menu's theme segment (.aseg-i) applies in place and leaves the menu open. ---------- */
function menuItems(m){var out=[];(function walk(n){var c=n&&n.children;if(!c)return;for(var i=0;i<c.length;i++){var x=c[i];if(x.hidden)continue;
  var ro=x.getAttribute&&x.getAttribute('role');if((ro==='menuitem'||ro==='menuitemradio')&&!x.disabled)out.push(x);walk(x);}})(m);return out;}
function menuOf(b){return b.menuEl||$(b.getAttribute('aria-controls'));}
function setMenu(b,on){var m=menuOf(b);if(!m)return;if(on&&S.menu&&S.menu!==b)setMenu(S.menu,false);
  b.setAttribute('aria-expanded',String(on));m.hidden=!on;if(on){enter(m);S.menu=b;closeTip();}else if(S.menu===b)S.menu=null;}
function closeMenu(focus){var b=S.menu;if(!b)return;setMenu(b,false);if(focus)b.focus();}
function menuMove(m,delta){var it=menuItems(m),a=d.activeElement,i=it.indexOf(a);if(!it.length)return;
  i=i<0?(delta>0?0:it.length-1):(i+delta+it.length)%it.length;it[i].focus();}
function bindMenu(b,onOpen,menuEl){if(menuEl)b.menuEl=menuEl;var m=menuOf(b);
  b.addEventListener('click',function(){var on=b.getAttribute('aria-expanded')!=='true';setMenu(b,on);if(on&&onOpen)onOpen();});
  b.addEventListener('keydown',function(ev){if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();if(b.getAttribute('aria-expanded')!=='true'){setMenu(b,true);if(onOpen)onOpen();}
    menuMove(m,ev.key==='ArrowDown'?1:-1);}});
  m.addEventListener('keydown',function(ev){var k=ev.key;
    if(k==='ArrowDown'||k==='ArrowUp'){ev.preventDefault();menuMove(m,k==='ArrowDown'?1:-1);}
    else if(k==='Home'||k==='End'){ev.preventDefault();var it=menuItems(m);if(it.length)it[k==='Home'?0:it.length-1].focus();}
    else if(k==='Tab')setMenu(b,false);});
  m.addEventListener('click',function(ev){var t=ev.target,it=t&&t.closest?t.closest('.mi'):null;if(it)setMenu(b,false);});}
d.addEventListener('pointerdown',function(ev){var b=S.menu;if(!b||within(b,ev.target)||within(menuOf(b),ev.target))return;setMenu(b,false);},true);
/* copy with a one-line status next to an icon button (the icon keeps its accessible name). */
function copyTo(text,stId){var s=$(stId);
  function done(ok){s.textContent=ok?'복사됨':'직접 선택해 복사';setTimeout(function(){s.textContent='';},1500);}
  if(text&&navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(function(){done(true);},function(){done(false);});
  else done(false);}

/* ---------- where we were (critique R7-05): after an expired session the login page says why, and the console reopens this screen.
   Only a console route shape is kept (a hash, same origin) - never a URL, so nothing can redirect elsewhere. ---------- */
/* where you were when the session ended (critique R7-05, review M2 / I-1). The login link opens in a NEW tab, so this lives in localStorage,
   not the tab's sessionStorage: {h: console hash, org: organization id, at: ms}. It is kept 15 minutes (the login link's life), restored once
   and only into the same organization, and dropped on logout. The org comes from /api/me, or the last org this browser saw (a 401 at boot). */
var NEXT_KEY='atmark.console.next',ORG_KEY='atmark.console.org',NEXT_TTL=900000,NEXT_RE=/^#\/(?!.*\/\/)[a-z][A-Za-z0-9\/_.-]{0,200}$/;
function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function lsDel(k){try{localStorage.removeItem(k);}catch(e){}}
function keepPlace(){var h=location.hash;if(!NEXT_RE.test(h))return;var org=S.org&&typeof S.org.id==='string'&&S.org.id?S.org.id:(lsGet(ORG_KEY)||'');
  if(org)lsSet(NEXT_KEY,JSON.stringify({h:h,org:org,at:Date.now()}));}
function takePlace(org){var raw=lsGet(NEXT_KEY),x=null,now=Date.now();if(raw===null)return '';lsDel(NEXT_KEY);try{x=JSON.parse(raw);}catch(e){return '';}
  if(!obj(x)||typeof x.h!=='string'||typeof x.at!=='number'||!org||x.org!==org||now-x.at>NEXT_TTL||x.at-now>60000)return '';return NEXT_RE.test(x.h)?x.h:'';}
function forgetPlace(){lsDel(NEXT_KEY);lsDel(ORG_KEY);}

/* ---------- api ---------- */
function ApiError(status,code,detail){this.status=status;this.code=code;this.detail=detail;}
/* Network discipline (2026-09-25): the admin Lambda runs at most 3 copies at once (reserved concurrency) and answers 503 when throttled.
   So at most NET.max requests are in flight and the rest wait in order; a GET that meets 503 or 429 is sent again after NET.back[n] ms
   (+ jitter, the slot is freed while waiting); a mutation is never sent again (its error is shown). Identical plain GETs in flight share one request. */
var NET={max:2,busy:0,q:[],back:[400,1200],get:{}};
function netNext(){while(NET.busy<NET.max&&NET.q.length){NET.busy++;NET.q.shift()();}}
function netRun(fn){return new Promise(function(res,rej){
  NET.q.push(function(){var p;try{p=fn();}catch(e){p=Promise.reject(e);}
    p.then(function(v){NET.busy--;netNext();res(v);},function(e){NET.busy--;netNext();rej(e);});});
  netNext();});}
function netWait(ms){return new Promise(function(res){setTimeout(res,ms);});}
/* file: a fallback file name. Then a 2xx body comes back as {blob,name} (name from content-disposition when it is a plain *.json name). */
function api(method,path,body,file){
  var get=method==='GET',share=get&&!file;
  if(share&&NET.get[path])return NET.get[path];
  function attempt(n){return netRun(function(){return netSend(method,path,body,file);}).catch(function(e){
    if(get&&e instanceof ApiError&&(e.status===503||e.status===429)&&n<NET.back.length)
      return netWait(NET.back[n]+Math.floor(Math.random()*150)).then(function(){return attempt(n+1);});
    throw e;});}
  var p=attempt(0);
  if(share){NET.get[path]=p;var off=function(){if(NET.get[path]===p)delete NET.get[path];};p.then(off,off);}
  return p;
}
function netSend(method,path,body,file){
  var h={'accept':'application/json'};
  var init={method:method,headers:h,credentials:'same-origin',cache:'no-store',redirect:'error'};
  if(method!=='GET'){h['x-atmark-csrf']=S.csrf;if(body!==undefined){h['content-type']='application/json';init.body=JSON.stringify(body);}}
  /* File downloads are GETs, but the bundle export is audited (a write): the server requires the CSRF header there too (L4). */
  else if(file)h['x-atmark-csrf']=S.csrf;
  return fetch(path,init).then(function(r){
    if(r.status===401){keepPlace();location.replace('/?expired=1');throw new ApiError(401,'unauthenticated',null);}
    if(file&&r.ok)return r.blob().then(function(b){return {blob:b,name:fileName(r,file)};});
    if(r.status===204)return null;
    return r.json().catch(function(){return null;}).then(function(j){
      if(!r.ok){var code=(j&&typeof j.error==='string')?j.error:'';
        /* another tab switched the org (the shared cookie is a new session): the old CSRF fails closed. Re-read /api/me (org.ts staleCheck). */
        if(r.status===403&&code==='csrf_mismatch')staleCheck();
        throw new ApiError(r.status,code,j?j.detail:null);}
      return j;
    });
  },function(){throw new ApiError(0,'network',null);});
}
function fileName(r,fallback){var h=(r.headers&&r.headers.get)?r.headers.get('content-disposition')||'':'',m=/filename="([A-Za-z0-9._-]{1,120})"/.exec(h);
  return m&&/\.json$/.test(m[1])?m[1]:fallback;}
/* Save a Blob as a file: object URL + a detached-then-removed <a download>. No markup strings; the URL is revoked shortly after. */
function saveBlob(blob,name){var u=URL.createObjectURL(blob),a=el('a');a.href=u;a.download=name;a.hidden=true;
  d.body.appendChild(a);a.click();d.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},4000);}
var CODES={
  network:'서버에 닿지 못했습니다. 연결을 확인하고 다시 시도하세요.',
  csrf:'보안 토큰이 맞지 않습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  csrf_mismatch:'보안 토큰이 맞지 않습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  invalid_csrf:'보안 토큰이 맞지 않습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  invalid_mode:'고를 수 없는 모드입니다.',
  legacy_mode_rejected:'예전 모드(승인 필요·회신만)는 새로 설정할 수 없습니다.',
  no_change:'바뀐 것이 없습니다.',
  policy_unevaluable:'새 정책을 관문이 해석할 수 없습니다. 값을 확인하세요.',
  invalid_body:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_per_minute:'분당 한도는 1~9,999 사이 정수입니다.',
  invalid_rule_value:'주소(name@example.com)나 도메인(example.com) 모양이 아닙니다. 영문 소문자·숫자만 됩니다.',
  invalid_rule_direction:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_rule_list:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  rule_duplicate:'이미 목록에 있습니다.',
  conflict:'이미 있거나 다른 변경과 부딪혔습니다. 새로고침한 뒤 다시 보세요.',
  rule_limit:'목록이 가득 찼습니다. 쓰지 않는 항목을 제거한 뒤 다시 추가하세요.',
  rule_self_address:'에이전트 자기 주소는 목록에 넣을 수 없습니다.',
  rule_platform_domain:'atmark.ai 도메인은 목록에 넣을 수 없습니다. 다른 에이전트는 주소로 하나씩 넣으세요.',
  rule_not_found:'이미 제거된 항목입니다. 새로고침하세요.',
  concurrent_change:'다른 변경이 먼저 들어왔습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_local_part:'쓸 수 없는 주소입니다. 영문 소문자·숫자 위주로 다시 고르세요.',
  reserved_local_part:'예약된 주소입니다. 다른 주소를 고르세요.',
  invalid_name:'이름은 1~200자입니다.',
  agent_provisioning:'아직 준비 중인 에이전트입니다. 잠시 뒤 다시 시도하세요.',
  invalid_transition:'지금 상태에서는 그 전환을 할 수 없습니다. 새로고침한 뒤 다시 보세요.',
  invalid_expiry:'만료 일수는 1~3650 사이 정수입니다.',
  invalid_address:'주소 모양이 아닙니다.',
  invalid_domain:'도메인 모양이 아닙니다.',
  domain_scope_unconfirmed:'도메인 스코프 seen은 확인란을 체크해야 합니다.',
  address_taken:'이미 쓰는 주소입니다. 다른 주소를 고르세요.',
  local_part_taken:'이미 쓰는 주소입니다. 다른 주소를 고르세요.',
  invalid_character:'주소에는 영문 소문자·숫자와 . _ - 만 씁니다. 처음과 끝은 영문이나 숫자여야 합니다.',
  invalid_length:'주소(@ 앞)는 1~64자여야 합니다.',
  consecutive_dots:'점(.)을 두 번 잇달아 쓸 수 없습니다.',
  alias_plan_limit:'요금제의 별칭 한도에 닿았습니다. 쓰지 않는 별칭을 삭제하거나 요금제를 올리세요.',
  alias_issued_limit:'이 에이전트는 별칭을 더 받을 수 없습니다. 삭제한 별칭도 발급 수에 들어갑니다.',
  alias_org_daily_limit:'오늘은 이 조직에서 별칭을 더 만들 수 없습니다. 내일 다시 시도하세요.',
  address_probe_limit:'오늘은 쓸 수 없는 주소로 너무 많이 시도했습니다. 내일 다시 시도하세요.',
  address_primary_not_retirable:'대표 주소는 삭제할 수 없습니다.',
  invalid_webhook_url:'등록할 수 없는 주소입니다. 공개된 https 주소인지 확인하세요.',
  webhook_endpoint_limit:'웹훅이 요금제 한도에 닿았습니다. 쓰지 않는 웹훅을 삭제한 뒤 다시 추가하세요.',
  webhook_endpoint_registration_limit:'24시간 동안 등록할 수 있는 웹훅 수를 넘었습니다. 나중에 다시 시도하세요.',
  webhooks_unavailable:'지금은 웹훅을 추가하거나 비밀값을 교체할 수 없습니다. 잠시 뒤 다시 시도하세요.',
  webhook_secret_unavailable:'웹훅은 저장했지만 비밀값을 받지 못했습니다. 잠시 뒤 비밀값을 교체해 새 값을 받으세요.',
  webhook_rotation_rate_limited:'이 웹훅은 24시간 동안 비밀값을 더 교체할 수 없습니다. 나중에 다시 시도하세요.',
  webhook_authorization_stale:'그 사이 인증 헤더가 바뀌었습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_authorization:'인증 헤더 값은 영문·숫자·기호 2048자까지이고, 줄바꿈이나 “Authorization:” 없이 값만 넣습니다.',
  invalid_event_types:'고를 수 없는 이벤트가 있습니다. 새로고침한 뒤 다시 시도하세요.',
  webhook_not_found:'이미 삭제된 웹훅입니다. 새로고침하세요.',
  delivery_not_found:'전달 기록을 찾지 못했습니다. 새로고침하세요.',
  delivery_not_dead:'재시도가 끝난 전달만 다시 보낼 수 있습니다.',
  webhook_endpoint_deleted:'삭제한 웹훅으로 가는 전달은 다시 보낼 수 없습니다.',
  redelivery_destination_rejected:'받는 주소가 거부해 끝난 전달입니다. URL을 고쳐 새 웹훅을 추가하세요.',
  delivery_already_delivered:'이미 전달된 이벤트입니다.',
  redelivery_limit:'이 전달은 더 다시 보낼 수 없습니다.',
  redelivery_rate_limited:'다시 보내기가 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
  not_found:'대상을 찾지 못했습니다. 새로고침한 뒤 다시 보세요.',
  agent_not_found:'대상을 찾지 못했습니다. 새로고침한 뒤 다시 보세요.',
  gate_not_found:'인계 시험을 찾지 못했습니다. 새로고침한 뒤 다시 보세요.',
  identity_revoked:'폐기된 신원입니다. 다시 게시할 수 없습니다.',
  identity_request_pending:'다른 요청이 처리 중입니다. 잠시 뒤 다시 시도하세요.',
  identity_not_published:'게시된 신원만 중단할 수 있습니다.',
  identity_org_not_active:'운영자 검토가 끝난 조직만 신원을 게시할 수 있습니다.',
  token_limit:'활성 토큰이 요금제 한도에 닿았습니다. 쓰지 않는 토큰을 폐기한 뒤 다시 발급하세요.',
  token_not_found:'이 에이전트의 토큰이 아닙니다. 새로고침한 뒤 다시 보세요.',
  token_not_active:'폐기되거나 만료된 토큰입니다.',
  invalid_label:'이름은 1~60자이고, 보이지 않는 문자는 쓸 수 없습니다.',
  invalid_status:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_days:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_capability:'권한을 하나 이상 고르세요.',
  invalid_cursor:'목록 위치가 맞지 않습니다. 새로고침하세요.',
  invalid_log_type:'모르는 로그 종류입니다.',
  log_not_found:'기록을 찾지 못했습니다.',
  invalid_agent:'에이전트 ID 모양이 아닙니다.',
  invalid_decision:'고를 수 없는 결과 필터입니다.',
  log_not_started:'이 조직의 로그가 아직 시작되지 않았습니다.',
  no_checkpoint_yet:'아직 체크포인트가 없습니다. 다음 정시 뒤에 다시 시도하세요.',
  entry_not_yet_checkpointed:'아직 체크포인트에 들어가지 않은 기록입니다. 다음 정시 뒤에 다시 시도하세요.',
  log_entry_not_found:'이 조직의 로그 항목이 아닙니다.',
  invalid_entry:'로그 항목 ID 모양이 아닙니다.',
  invalid_epoch:'체크포인트 범위가 올바르지 않습니다.',
  invalid_epoch_range:'체크포인트 범위가 올바르지 않습니다.',
  epoch_not_found:'체크포인트 범위가 올바르지 않습니다.',
  epoch_range_too_large:'번들이 너무 큽니다. 잠시 뒤 다시 시도하거나 운영자에게 문의하세요.',
  bundle_too_large:'번들이 너무 큽니다. 잠시 뒤 다시 시도하거나 운영자에게 문의하세요.',
  rate_limited:'요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
  forbidden:'이 작업을 할 권한이 없습니다.',
  forbidden_role:'내 역할로는 할 수 없는 작업입니다. 조직 소유자에게 역할을 요청하세요.',
  invalid_organization_name:'조직 이름은 1~80자이고, 보이지 않는 문자는 쓸 수 없습니다.',
  org_limit:'더 만들 수 없습니다. 소유한 조직은 5개까지, 새 조직은 하루 2개까지입니다.',
  organization_not_found:'이 조직의 멤버가 아닙니다. 새로고침하세요.',
  invalid_email:'이메일 주소를 확인해 주세요.',
  invalid_role:'고를 수 없는 역할입니다.',
  org_not_active:'운영자 검토가 끝난 조직만 초대를 보낼 수 있습니다.',
  already_member:'이미 이 조직의 멤버입니다.',
  invite_pending:'이미 대기 중인 초대가 있습니다.',
  invitee_erased:'이 주소의 이전 기록을 방금 정리했습니다. 다시 초대해 주세요.',
  member_limit:'조직 멤버가 가득 찼습니다(대기 중인 초대 포함).',
  invite_limit:'대기 중인 초대가 너무 많거나, 오늘 보낼 수 있는 초대를 다 썼습니다.',
  invite_not_found:'이미 처리된 초대입니다. 새로고침하세요.',
  invite_not_pending:'이미 처리된 초대입니다. 새로고침하세요.',
  cannot_remove_self:'자기 자신은 제거할 수 없습니다. 이 조직에서 나가기를 쓰세요.',
  member_not_found:'이미 조직에 없는 멤버입니다. 새로고침하세요.',
  last_owner:'조직에는 소유자가 한 명 이상 있어야 합니다.',
  primary_owner:'주 소유자는 역할을 바꾸거나 제거할 수 없습니다.',
  org_key_limit:'활성 조직 API 키가 요금제 한도에 닿았습니다. 쓰지 않는 키를 폐기한 뒤 다시 발급하세요.',
  org_key_not_found:'이 조직의 키가 아닙니다. 새로고침하세요.',
  org_key_not_active:'폐기되거나 만료된 키입니다.',
  invalid_query:'검색어는 1~64자입니다.',
  invalid_limit:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  channel_not_found:'모르는 채널입니다.',
  operator_suspension:'Atmark 운영자가 보류한 에이전트입니다. 운영자만 풀 수 있습니다.',
  agent_deleted:'삭제한 에이전트라 바꿀 수 없습니다.',
  operator_reserved:'운영자 예약 주소를 쓰는 에이전트라 삭제할 수 없습니다. 운영자에게 문의하세요.',
  agent_limit:'요금제의 에이전트 한도에 닿았습니다(삭제한 에이전트 제외). 쓰지 않는 에이전트를 삭제하면 자리가 납니다. 설정 › 요금제 · 사용량에서 확인하세요.',
  agent_total_limit:'삭제한 것을 포함한 에이전트가 한도에 닿았습니다(요금제 한도의 3배). 삭제한 에이전트도 이 수에는 계속 셉니다.',
  plan_per_minute_limit:'분당 발송은 요금제 한도를 넘을 수 없습니다. 설정 › 요금제 · 사용량에서 확인하세요.',
  agent_limit_pending:'운영자 검토 중인 조직은 에이전트를 '+L.pending+'개까지 만들 수 있습니다(긴급 정지·삭제한 에이전트 포함). 검토가 끝나 활성화되면 요금제 한도까지 늘어납니다.',
  invalid_plan:'고를 수 없는 요금제입니다.',
  billing_unavailable:'지금은 결제를 열 수 없습니다. 잠시 뒤 다시 시도하세요.',
  billing_provider_error:'결제 서비스에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.',
  billing_beta_locked:'베타 기간에는 결제가 열리지 않습니다.',
  billing_org_not_active:'운영자 검토가 끝난 조직만 결제할 수 있습니다.',
  billing_subscription_exists:'이미 구독이 있습니다. 결제 관리에서 확인하세요.',
  billing_plan_not_higher:'이 요금제는 지금 한도보다 좁은 항목이 있어 결제할 수 없습니다.',
  billing_sandbox_not_allowed:'이 조직은 시험 결제 대상이 아닙니다.',
  billing_no_customer:'결제 관리는 구독을 시작한 뒤에 열립니다.',
  billing_checkout_busy:'다른 창에서 결제를 준비하고 있습니다. 잠시 뒤 다시 시도하세요.',
  billing_checkout_limit:'오늘은 결제 화면을 더 열 수 없습니다. 내일 다시 시도하거나 운영자에게 문의하세요.',
  billing_portal_shared_customer:'이 결제 계정에는 다른 조직의 구독도 있어 여기서 결제 관리를 열 수 없습니다. 운영자에게 문의하세요.',
  billing_email_is_agent:'청구 이메일이 에이전트 주소라 여기서 결제 관리를 열 수 없습니다. 사람이 받는 주소로 바꾸려면 운영자에게 문의하세요.',
  address_is_primary:'지금 대표 주소인 별칭은 삭제할 수 없습니다. 먼저 다른 주소를 대표로 고르세요.',
  address_not_found:'주소를 찾지 못했습니다. 새로고침한 뒤 다시 보세요.',
  feature_not_enabled:'이 조직에는 도메인 연결이 열려 있지 않습니다.',
  domain_not_found:'도메인을 찾지 못했습니다. 새로고침한 뒤 다시 보세요.',
  domain_exists:'이미 추가한 도메인입니다.',
  domain_unavailable:'이 도메인은 지금 추가할 수 없습니다. 지원팀에 문의하세요.',
  plan_custom_domains_exceeded:'요금제의 도메인 한도에 닿았습니다(확인 중인 도메인 포함). 쓰지 않는 도메인을 제거하거나 요금제를 올리세요.',
  custom_domains_pending_exceeded:'소유 확인을 기다리는 도메인은 2개까지입니다. 먼저 하나를 확인하거나 제거하세요.',
  domain_add_rate_limited:'오늘은 도메인을 더 추가할 수 없습니다. 내일 다시 시도하세요.',
  domain_check_rate_limited:'확인 요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
  domain_not_verified:'확인이 끝난 도메인만 쓸 수 있습니다. 도메인 화면에서 상태를 보세요.',
  domain_registrable_taken:'이 도메인 아래는 지금 쓸 수 없습니다. 지원팀에 문의하세요.',
  domain_address_limit:'이 도메인의 주소 수가 상한에 닿았습니다.',
  primary_not_eligible:'이 주소는 대표 주소로 고를 수 없습니다. 확인이 끝난 도메인의 별칭만 됩니다.',
  primary_on_custom_domain:'이 주소는 대표 주소로 고를 수 없습니다. 확인이 끝난 도메인의 별칭만 됩니다.',
  primary_change_rate_limited:'대표 주소는 하루에 5번까지 바꿀 수 있습니다. 내일 다시 시도하세요.',
  primary_change_forbidden:'이 에이전트의 대표 주소는 Atmark 운영자만 바꿉니다.',
  release_policy_blocked:'수신 정책(허용 · 차단 목록)으로 막은 메일은 풀 수 없습니다. 수신 정책을 고치세요.',
  release_not_scanned:'검사를 마치지 못한 메일은 풀 수 없습니다.',
  message_not_held:'이미 풀렸거나 보류된 메일이 아닙니다. 새로고침하세요.',
  message_not_found:'메일을 찾지 못했습니다. 새로고침하세요.',
  invalid_message_id:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_trusted_sender:'정확한 주소(name@example.com)나 도메인(example.com) 모양이 아닙니다. *는 쓸 수 없습니다.',
  invalid_trusted_senders:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  trusted_sender_freemail_domain:'공용 메일 서비스 도메인은 누구나 주소를 만들 수 있어 도메인째로 넣을 수 없습니다. 정확한 주소를 넣으세요.',
  too_many_trusted_senders:'신뢰 발신자가 가득 찼습니다. 쓰지 않는 발신자를 제거한 뒤 다시 추가하세요.',
  invalid_watch_setting:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_enroll_daily_cap:'하루 상한이 허용 범위를 벗어났습니다.',
  invalid_risk_handling:'고를 수 없는 처리 방식입니다.',
  invalid_risk_notify:'요청 모양이 올바르지 않습니다. 새로고침한 뒤 다시 시도하세요.',
  invalid_send_approval:'고를 수 없는 보내기 방식입니다.',
  invalid_mail_locale:'고를 수 없는 메일 언어입니다.',
  enroll_chain_forbidden:'자가 등록으로 만든 에이전트에는 자가 등록 권한을 줄 수 없습니다.',
  gate_exists:'이 조직에는 이미 인계 시험이 있습니다. 재시작은 콘솔에서 하지 않습니다(운영자에게 요청). 따로 새 인계 시험을 열려면 "새 인계 시험으로 따로 엽니다"를 체크하고 다시 시작하세요.'
};
var OWN={webhook_endpoint_limit:1,webhook_endpoint_registration_limit:1,webhooks_unavailable:1,webhook_secret_unavailable:1,webhook_rotation_rate_limited:1,redelivery_limit:1,redelivery_rate_limited:1,redelivery_destination_rejected:1,alias_plan_limit:1,alias_issued_limit:1,alias_org_daily_limit:1,address_probe_limit:1,operator_suspension:1,agent_deleted:1,operator_reserved:1,agent_limit:1,agent_total_limit:1,plan_per_minute_limit:1,token_limit:1,org_key_limit:1,gate_exists:1,identity_org_not_active:1,forbidden_role:1,org_limit:1,member_limit:1,invite_limit:1,
  billing_unavailable:1,billing_provider_error:1,billing_beta_locked:1,billing_org_not_active:1,billing_subscription_exists:1,billing_plan_not_higher:1,billing_sandbox_not_allowed:1,billing_no_customer:1,
  billing_checkout_busy:1,billing_checkout_limit:1,billing_portal_shared_customer:1,billing_email_is_agent:1,
  address_is_primary:1,feature_not_enabled:1,domain_exists:1,domain_unavailable:1,plan_custom_domains_exceeded:1,custom_domains_pending_exceeded:1,domain_add_rate_limited:1,
  domain_check_rate_limited:1,domain_not_verified:1,domain_registrable_taken:1,domain_address_limit:1,primary_not_eligible:1,primary_on_custom_domain:1,primary_change_rate_limited:1,primary_change_forbidden:1};
function human(e){
  if(!(e instanceof ApiError))return '화면에서 오류가 났습니다. 새로고침해 주세요.';
  var s=e.status;
  var base=(e.code==='agent_limit'&&S.review!=='active')?CODES.agent_limit_pending:CODES[e.code]||(s===400||s===422?'입력이 올바르지 않습니다.':s===403?'이 작업을 할 권한이 없습니다. 새로고침하거나 다시 로그인하세요.':
    s===404?CODES.not_found:s===409?'이미 처리됐거나 다른 변경과 부딪혔습니다. 새로고침한 뒤 다시 보세요.':s===413?'입력이 너무 깁니다.':
    s===429?CODES.rate_limited:s>=500?'서버 오류입니다. 잠시 뒤 다시 시도하세요.':'요청을 처리하지 못했습니다.');
  return base;
}
/* what support needs (server code · Korean detail) stays out of the sentence people read (critique R7-04): it goes to the message's title. */
function errMeta(e){if(!(e instanceof ApiError))return '';var x=[];if(e.code)x.push(clean(e.code,60));
  var det=(typeof e.detail==='string')?clean(e.detail,300):'';if(LANG==='ko'&&det&&!OWN[e.code])x.push(det);return x.join(' · ');}
function say(id,text,kind,meta){var m=$(id);m.textContent=text||'';m.className='msg'+(kind?' '+kind:'');m.title=meta||'';
  if(kind==='ok'){m.removeAttribute('role');if(text)toast(text);}else m.setAttribute('role',kind==='err'?'alert':'status');}
/* toasts (spec s3.5, critique R7-11): #toasts is the one live region for moment successes; at most 3, each for 4 s, paused while hovered. */
function toast(text){var box=$('toasts');if(!box||!text)return;
  while(box.children.length>=3)box.removeChild(box.firstChild);
  var t=el('div','toast',text),left=4000,at=Date.now(),tm=0;
  function arm(){tm=setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},left);}
  t.addEventListener('mouseenter',function(){clearTimeout(tm);left=Math.max(800,left-(Date.now()-at));});
  t.addEventListener('mouseleave',function(){at=Date.now();arm();});
  box.appendChild(t);arm();}
/* after a destructive action redraws the list, the button that started it is gone: focus lands on the section title (or the list's own
   input) instead of falling to <body> (critique R7-11). Section h2s are made focusable just for this. */
function landFocus(id){var n=$(id);if(!n)return;if(!n.getAttribute('tabindex')&&/^H[1-6]$/.test(n.tagName||''))n.setAttribute('tabindex','-1');n.focus();}
/* a field's own error (spec s3.2, critique R7-06): the input gets aria-invalid + aria-describedby to a message right under it, and focus. */
var FE={};
function fieldErr(inp,text){if(!inp)return;var id=inp.id+'-err',m=FE[id];
  if(!m&&text){m=el('p','msg err');m.id=id;m.setAttribute('role','alert');var f=inp.closest?inp.closest('.field'):null;(f||inp.parentNode||d.body).appendChild(m);FE[id]=m;}
  if(m){m.textContent=text||'';m.hidden=!text;}
  if(text){inp.setAttribute('aria-invalid','true');inp.setAttribute('aria-describedby',id);inp.focus();}
  else{inp.removeAttribute('aria-invalid');if(inp.getAttribute('aria-describedby')===id)inp.removeAttribute('aria-describedby');}}
d.addEventListener('input',function(ev){var t=ev&&ev.target;if(t&&t.getAttribute&&t.getAttribute('aria-invalid')==='true')fieldErr(t,'');});
function banner(text){var b=$('banner');b.textContent=text||'';b.hidden=!text;}
function busy(b,on){b.disabled=on;b.classList.toggle('busy',on);}
function run(b,msg,fn){say(msg,'');busy(b,true);
  return Promise.resolve().then(fn).catch(function(e){say(msg,human(e),'err',errMeta(e));}).then(function(){busy(b,false);});}
/* a section that could not load. "Not allowed" (403) is said once, in the read-only bar at the top, not in every card (critique R7-07). */
function forbidden(e){return e instanceof ApiError&&e.status===403&&e.code!=='csrf_mismatch'&&e.code!=='invalid_csrf';}
/* a part of the screen could not load because the server or the network failed (F60): one banner at the top says so once, and each
   section shows a quiet dash instead of repeating the same sentence. Errors that are about that section (404, 4xx codes) stay in the section. */
function partErr(id,e,quiet){if(e instanceof ApiError&&(e.status===0||e.status>=500)){S.part=true;$('part-banner').hidden=false;say(id,quiet?'':'—','');$(id).title=errMeta(e);return;}
  say(id,human(e),'err',errMeta(e));}
function sectionErr(id){return function(e){if(forbidden(e)){$('ro-bar').hidden=false;say(id,'');return;}say(id,human(e),'err',errMeta(e));};}
/* the same for one part of a screen that has several (the overviews): a server / network failure goes to the one banner (partErr) */
function partErrFn(id){return function(e){if(forbidden(e)){$('ro-bar').hidden=false;say(id,'');return;}partErr(id,e);};}

/* ---------- dialogs ----------
   One confirm shape (2026-10-15 UI audit s3.6 · F42-F46): kicker = the action (red when irreversible) -> a question title -> the result in
   one line (body) -> optional two columns "what goes / what stays" (split) -> the target values (list) -> at most one warnbox (warn) ->
   when it cannot be undone, a check "I understand ..." (ack) -> [Cancel] [the action as a noun]. */
function ask(o){return new Promise(function(res){
  var dl=$('dlg-confirm'),ok=$('dc-ok'),cancel=$('dc-cancel'),ack=$('dc-ack'),body=$('dc-body');
  txt('dc-kicker',o.kicker||'확인');txt('dc-title',o.title);
  clear(body);arr(o.body).forEach(function(p){if(p)body.appendChild(el('p',null,p));});
  if(o.split){var sp=el('div','dsplit');o.split.forEach(function(c){var col=el('div'),cu=el('ul');col.appendChild(el('p','lbl',c[0]));arr(c[1]).forEach(function(t){cu.appendChild(el('li',null,t));});col.appendChild(cu);sp.appendChild(col);});body.appendChild(sp);}
  if(o.list){var ul=el('ul','log');o.list.forEach(function(x){var li=el('li');li.appendChild(x);ul.appendChild(li);});body.appendChild(ul);}
  if(o.warn){var wb=el('div','warnbox');wb.appendChild(el('strong',null,o.warn));body.appendChild(wb);}
  $('dc-head').className='dh'+(o.danger?' hatch':'');
  $('dc-ackwrap').hidden=!o.ack;txt('dc-acktext',o.ack||'');ack.checked=false;
  ok.textContent=o.ok||'확인';ok.className='btn'+(o.danger?' danger solid':'');ok.disabled=!!o.ack;
  ack.onchange=function(){ok.disabled=!ack.checked;};
  var settled=false;
  function done(v){if(settled)return;settled=true;ok.onclick=null;cancel.onclick=null;dl.onclose=null;if(dl.open)dl.close();res(v);}
  ok.onclick=function(){if(!ok.disabled)done(true);};
  cancel.onclick=function(){done(false);};
  dl.onclose=function(){done(false);};
  dl.showModal();cancel.focus();
});}
/* copy from a button. The label never changes (no width jump); the result is a toast. When the clipboard is refused, the text itself is
   selected on screen (sel: the element that shows it — or a function that opens the screen that does) so a manual copy works (R7-12). */
function selectText(n){try{var r=d.createRange(),s=window.getSelection();r.selectNodeContents(n);s.removeAllRanges();s.addRange(r);}catch(e){}}
function copy(text,b,sel){
  function done(ok){if(ok){toast('복사했습니다.');return;}
    toast('복사하지 못했습니다. 선택해 둔 글을 직접 복사하세요.');if(typeof sel==='function')sel();else if(sel&&$(sel))selectText($(sel));}
  if(text&&navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){done(true);},function(){done(false);});}
  else done(false);
}
function seg(prefix,lang){radioSet([prefix+'-en',prefix+'-ko'],prefix+'-'+lang);}
/* single-choice segments = ARIA radio group (critique R6-08): one Tab stop (the checked one); arrows / Home / End move and choose
   (they press the button, so every group keeps its one click handler). */
function radioSet(ids,cur){ids.forEach(function(i){var b=$(i),on=i===cur;b.setAttribute('aria-checked',String(on));b.setAttribute('tabindex',on?'0':'-1');});}
function radioKeys(ids){ids.forEach(function(i,n){$(i).addEventListener('keydown',function(ev){var k=ev.key,to=-1,m=ids.length;
  if(k==='ArrowRight'||k==='ArrowDown')to=(n+1)%m;else if(k==='ArrowLeft'||k==='ArrowUp')to=(n+m-1)%m;else if(k==='Home')to=0;else if(k==='End')to=m-1;
  if(to<0)return;if(ev.preventDefault)ev.preventDefault();var b=$(ids[to]);b.click();b.focus();});});}
`;
