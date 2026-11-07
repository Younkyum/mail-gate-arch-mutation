/**
 * src/admin/ui/console/script/webhooks.ts — 앱 스크립트 조각: 웹훅 탭(`#/agents/{id}/webhooks`, 화면 함수 `showWebhooks`).
 *
 *   - 목록 `GET …/webhooks` → `{items, limits, availableEventTypes}`. 활성(`status` 가 없거나 `active`)만 올린다 — 삭제한 웹훅은 목록에 없다.
 *   - 추가 = 버튼 → `dlg-webhook`(https 만 · 이벤트는 서버의 `availableEventTypes`, 기본 넷이 켜진 채) → `POST` 201 `{item, secret}` →
 *     비밀값 창 `dlg-whsecret`(한 번만). 대화상자는 연 에이전트에 묶이고(`dlgStale`), 보내는 중에는 Esc·취소가 닫지 않는다(`dlgBind`).
 *     비밀값 창은 라우트가 바뀌어도 뜬다 — 다시 볼 수 없는 값이라서다(목록 새로고침만 건너뛴다).
 *   - 행의 ⋯ 메뉴: 비밀값 교체(확인 → `POST …/rotate` → 같은 비밀값 창, 이전 값이 통하는 시각 한 줄) · 삭제(빨간 확인 → `DELETE`).
 *   - 전달 기록 `GET …/webhooks/deliveries?cursor=&webhookId=` — 웹훅 필터 · `더 보기` 커서 · 재시도가 끝난 행의 `다시 보내기`
 *     (확인 없음 · 누르는 동안 잠김 · 토스트) → `POST …/deliveries/{id}/redeliver` 202 `{item}` — 서버는 **재시도가 끝난(dead)** 전달만 받고
 *     새 전달 행(같은 이벤트, pending)을 돌려준다. 화면은 그 행을 맨 위에 더한다(원래 행은 기록으로 남는다).
 *   - 인증 헤더(선택, 202610141400): 추가 대화상자의 가린 칸 `wh-auth`(비우면 보내지 않는다) · ⋯ 메뉴의 설정/교체(`dlg-whauth` → `POST …/authorization`)
 *     · 삭제(확인 → `DELETE …/authorization`). 값은 보낸 뒤·닫을 때 입력에서 지운다. 표에는 서버의 힌트(`authorizationHint`)만 보인다.
 *   - member(읽기 전용)에게는 추가·⋯ 메뉴·다시 보내기를 만들지 않는다. 서버가 최종 판정이다(403 `forbidden_role`).
 */

export const WEBHOOKS_JS = String.raw`/* ---------- webhooks tab (endpoints + deliveries) ---------- */
/* the four types an endpoint gets when it names none (server LEGACY_EVENT_TYPES) - pre-checked in the add dialog. */
var WH_DEFAULT=['approval.resolved','approval.expired','message.sent','message.received'];
var WH_ALL=WH_DEFAULT.concat(['message.delivered','message.bounced','message.complained']);
var WH_EVT={'approval.resolved':'승인 요청이 승인되거나 거절됨','approval.expired':'승인 요청이 기한을 넘김','message.sent':'메일을 보냄',
  'message.received':'메일을 받음(보류된 메일 제외)','message.delivered':'보낸 메일이 받는 서버에 닿음','message.bounced':'보낸 메일이 반송됨',
  'message.complained':'받는 사람이 스팸으로 신고함'};
/* delivery states (server WebhookDeliveryDisplayStatus): delivered = on · pending = waiting · failed = an attempt failed, a retry is scheduled ·
   dead = retries are over (the one state that can be redelivered). failed / dead use the monochrome bordered "bad" pill (x glyph). */
var WH_ST={delivered:['전달됨','on'],failed:['실패','bad'],dead:['재시도 끝남','bad']};
function whState(st,attempts){if(WH_ST[st])return WH_ST[st];if(st==='pending')return [num(attempts)>0?'재시도 중':'대기 중','wait'];return [str(st,20)||'—','dim'];}
var WH_URL_RE=/^https:\/\/[^\s\/?#@]+(?:[\/?#]\S*)?$/i;
/* the Authorization value (server parseWebhookAuthorization): printable ASCII, 1-2048 after trimming, without the header name. '' = fine. */
function whAuthErr(v){if(v.length>2048)return '2048자까지 넣을 수 있습니다.';if(!/^[\x20-\x7E]+$/.test(v))return '줄바꿈·탭·한글 같은 글자 없이 영문·숫자·기호만 넣으세요.';
  if(/^authorization\s*:/i.test(v))return '“Authorization:” 없이 값만 넣으세요.';return '';}
var WH={id:'',j:null,dlg:'',secret:'',back:'',dl:{items:[],next:null,filter:'',seq:0}};
function whUrl(u){return clean(u,2048);}
function whItems(j){return arr(j&&j.items).filter(function(w){return obj(w)&&typeof w.id==='string'&&typeof w.url==='string'&&(w.status===undefined||w.status===null||w.status==='active');});}
function whById(id){var it=obj(WH.j)?whItems(WH.j):[];for(var i=0;i<it.length;i++)if(it[i].id===id)return it[i];return null;}
function whUrlNode(u){var s=el('span','mono whurl',whUrl(u));s.title=whUrl(u);return s;}
/* a URL in a narrow place (the filter, the deliveries table): host + path, cut in the middle of nothing - the full value goes to the title. */
function whShort(u,max){var s=whUrl(u).replace(/^https:\/\//i,'');return s.length>max?s.slice(0,max-1)+'…':s;}
function showWebhooks(a,soft){if(WH.id!==a.id){WH.id=a.id;WH.j=null;WH.dl={items:[],next:null,filter:'',seq:WH.dl.seq+1};$('wd-f').value='';say('wh-msg','');say('wd-msg','');
    if(WH.seen){clear($('wh-body'));clear($('wd-body'));}WH.seen=true;}
  renderWebhooks();renderDeliveries();if(soft&&WH.j)return;loadWebhooks();loadDeliveries(true);}
function loadWebhooks(){var id=S.cur;if(!id)return Promise.resolve();
  return api('GET','/api/agents/'+enc(id)+'/webhooks').then(function(j){if(S.cur!==id)return;WH.j=obj(j)?j:{};renderWebhooks();},
    function(e){if(S.cur!==id)return;$('wh-tbl').hidden=true;$('wh-empty').hidden=true;sectionErr('wh-msg')(e);});}
function whLimits(){var l=obj(WH.j)&&obj(WH.j.limits)?WH.j.limits:null;return l?{a:num(l.active),am:num(l.activeMax),r:num(l.registrationsToday),rm:num(l.registrationsMax)}:null;}
function renderWebhooks(){var loaded=obj(WH.j),items=loaded?whItems(WH.j):[],L=whLimits(),admin=can('admin'),now=Date.now();
  txt('wh-lim',L?grp(L.a)+' / '+grp(L.am):'');$('wh-lim').title=L?fmt('활성 {a} / {b} · 24시간 등록 {c} / {d}',{a:grp(L.a),b:grp(L.am),c:grp(L.r),d:grp(L.rm)}):'';
  var full=!!L&&L.a>=L.am,rfull=!!L&&L.r>=L.rm,why=full?CODES.webhook_endpoint_limit:rfull?CODES.webhook_endpoint_registration_limit:'';
  /* one Add on screen: the head's while there are webhooks, the empty state's while there are none. Hidden for member. */
  ['wh-add','wh-add-empty'].forEach(function(i){var b=$(i);b.disabled=!loaded||full||rfull;b.title=why;gate(b,'admin');});
  $('wh-add').hidden=!admin||(loaded&&!items.length);$('wh-add-empty').hidden=!admin;
  $('wh-empty').hidden=!loaded||items.length>0;$('wh-tbl').hidden=loaded&&!items.length;
  if(!loaded)return;
  var tb=$('wh-body');clear(tb);items.forEach(function(w){tb.appendChild(whRow(w,now));});
  renderWhFilter(items);}
/* the subscribed types as chips under the URL: up to four, else three + "+n" (all of them in the title). */
function whEvents(list){var w=el('span','caps'),t=arr(list).filter(function(x){return typeof x==='string';}),show=t.length>4?t.slice(0,3):t;
  show.forEach(function(x){w.appendChild(el('span','cap mono',str(x,60)));});
  if(t.length>show.length)w.appendChild(el('span','cap',fmt('+{n}',{n:t.length-show.length})));
  w.title=t.map(function(x){return str(x,60);}).join(', ');return w;}
/* last delivery: none / state pill + HTTP status (when there is one) + relative time (exact KST time in the title). */
function whLast(x,now){if(!obj(x)){var no=el('span','muted',EMPTY);no.title='아직 전달하지 않았습니다';return no;}var k=whState(x.status,1),w=el('span','whld');w.appendChild(pillEl(k[0],k[1]));
  var bits=[];if(typeof x.httpStatus==='number'&&x.status!=='delivered')bits.push('HTTP '+x.httpStatus);var at=typeof x.at==='string'?fmtDateTime(x.at,now):'';if(at)bits.push(at);
  if(bits.length)w.appendChild(el('span','muted',bits.join(' · ')));w.title=x.at?kst(x.at):'';return w;}
/* secret: the version, and under it when it was last rotated. */
function whSecretCell(w,now){var v=typeof w.secretVersion==='number'?'v'+w.secretVersion:'—',s=el('span','whsv num');s.appendChild(el('span',null,v));
  if(typeof w.rotatedAt==='string'&&w.rotatedAt)s.appendChild(el('span','muted',fmt('{d} 교체',{d:ymd(w.rotatedAt)})));
  /* the Authorization header: only the server's hint (scheme + last 4) - the value never comes back. */
  if(w.hasAuthorization===true){var ah=el('span','muted whah','인증 헤더 ');ah.appendChild(el('span','mono',str(w.authorizationHint,40)||'…'));s.appendChild(ah);}
  var pv=typeof w.previousValidUntil==='string'?new Date(w.previousValidUntil).getTime():NaN;
  s.title=!isNaN(pv)&&pv>now?fmt('이전 비밀값은 {t}까지 통합니다.',{t:kst(w.previousValidUntil)}):(w.rotatedAt?kst(w.rotatedAt):'');return s;}
/* one row: the URL with its event chips under it · last delivery · secret · created · the row menu. */
function whRow(w,now){var tr=el('tr'),u=cell(tr,'URL'),un=whUrlNode(w.url);u.className='cv whep';
  /* member sessions get the URL masked (host + the path's last 4) - say why on hover. */
  if(w.urlMasked===true)un.title='관리자만 전체 주소를 볼 수 있습니다.';u.appendChild(un);u.appendChild(whEvents(w.eventTypes));
  cell(tr,'마지막 전달').appendChild(whLast(w.lastDelivery,now));
  cell(tr,'비밀값').appendChild(whSecretCell(w,now));
  var c=cell(tr,'만든 날');c.className='cv num';c.textContent=ymd(w.createdAt);c.title=kst(w.createdAt);
  var ac=el('td','act');tr.appendChild(ac);if(!can('admin'))return tr;
  /* row actions behind one menu (rowMenu): rotate the secret, the auth header, then the irreversible ones in red. */
  rowMenu(ac,'whm-'+w.id,whShort(w.url,80),[{label:'비밀값 교체',fn:function(mb){rotateWh(w,mb);}},{label:w.hasAuthorization===true?'인증 헤더 교체':'인증 헤더 설정',fn:function(){authWh(w);}},
    w.hasAuthorization===true?{label:'인증 헤더 삭제',fn:function(mb){clearAuthWh(w,mb);},danger:true}:null,{label:'삭제',fn:function(mb){deleteWh(w,mb);},danger:true}]);
  return tr;}

/* ---------- add ---------- */
function waChecked(){var out=[],box=$('wa-evts');
  (function walk(n){var c=n&&n.children;if(!c)return;for(var i=0;i<c.length;i++){var x=c[i];if(x.tagName==='INPUT'&&x.checked)out.push(x.value);walk(x);}})(box);return out;}
function waCheck(){var none=!waChecked().length;$('wa-go').disabled=none;$('wa-none').hidden=!none;}
function waEvents(){var j=WH.j,list=arr(j&&j.availableEventTypes).filter(function(x){return typeof x==='string'&&/^[a-z]+\.[a-z_]+$/.test(x);}),box=$('wa-evts');
  if(!list.length)list=WH_ALL;clear(box);
  list.forEach(function(t,i){var lb=el('label','check'),inp=el('input'),sp=el('span');inp.type='checkbox';inp.id='wa-ev-'+i;inp.value=t;inp.checked=WH_DEFAULT.indexOf(t)>=0;
    inp.addEventListener('change',waCheck);lb.appendChild(inp);sp.appendChild(el('span',null,WH_EVT[t]||t));sp.appendChild(el('code',null,t));lb.appendChild(sp);box.appendChild(lb);});
  waCheck();}
function whOpen(){var b=obj(WH.j)&&!whItems(WH.j).length?$('wh-add-empty'):$('wh-add');
  if(!can('admin')||!obj(WH.j)||!S.cur||b.disabled)return;
  var L=whLimits(),inp=$('wh-url');WH.dlg=S.cur;inp.value='';fieldErr(inp,'');$('wh-auth').value='';fieldErr($('wh-auth'),'');say('wa-msg','');waEvents();
  txt('wa-active',L?grp(L.a)+' / '+grp(L.am):'—');txt('wa-today',L?grp(L.r)+' / '+grp(L.rm):'—');
  $('dlg-webhook').showModal();inp.focus();}
$('wh-add').addEventListener('click',whOpen);
$('wh-add-empty').addEventListener('click',whOpen);
dlgBind('dlg-webhook','wa-go','wa-cancel');
$('wa-form').addEventListener('submit',function(ev){ev.preventDefault();var id=WH.dlg,inp=$('wh-url'),u=inp.value.trim(),ai=$('wh-auth'),av=ai.value.trim();
  if(dlgStale('dlg-webhook',id))return;fieldErr(inp,'');fieldErr(ai,'');say('wa-msg','');
  if(!/^https:\/\//i.test(u)){fieldErr(inp,'https://로 시작하는 주소만 됩니다.');return;}
  if(u.length>2048||!WH_URL_RE.test(u)){fieldErr(inp,'URL 모양이 아닙니다.');return;}
  var types=waChecked();if(!types.length){waCheck();return;}
  var ae=av?whAuthErr(av):'';if(ae){fieldErr(ai,ae);ai.focus();return;}
  var body={url:u,eventTypes:types};if(av)body.authorization=av;
  run($('wa-go'),'wa-msg',function(){return api('POST','/api/agents/'+enc(id)+'/webhooks',body).then(function(j){
    ai.value='';$('dlg-webhook').close();
    /* the secret is shown even if the route moved meanwhile - it can never be read again. */
    showWhSecret(j&&j.secret,obj(j)&&obj(j.item)?j.item:{url:u},'new',null);
    if(S.cur!==id)return;say('wh-msg','웹훅을 추가했습니다.','ok');return loadWebhooks();},function(e){
    if(e instanceof ApiError&&e.code==='invalid_webhook_url'){fieldErr(inp,human(e));return;}
    if(e instanceof ApiError&&e.code==='invalid_authorization'){fieldErr(ai,human(e));return;}
    if(whSaved(e)){ai.value='';$('dlg-webhook').close();if(S.cur===id)return loadWebhooks();return;}throw e;});});});
/* the typed Authorization value never outlives the dialog. */
$('dlg-webhook').addEventListener('close',function(){$('wh-auth').value='';});
/* 503 webhook_secret_unavailable: the write committed but the secret never came back - say so under the list, re-read it; the owner rotates for a secret. */
function whSaved(e){if(!(e instanceof ApiError&&e.code==='webhook_secret_unavailable'))return false;say('wh-msg',human(e),'err');return true;}

/* ---------- the secret, once (the token window's pattern) ---------- */
function showWhSecret(secret,item,kind,prevUntil){WH.secret=typeof secret==='string'?secret:'';WH.back='h-ag-wh';var it=obj(item)?item:{};
  txt('ws-kicker',kind==='rotate'?'비밀값 교체':'새 웹훅');txt('ws-url',whUrl(it.url)||'—');$('ws-url').title=whUrl(it.url);
  var pv=typeof prevUntil==='string'&&prevUntil?prevUntil:'';$('ws-prev-t').hidden=!pv;$('ws-prev').hidden=!pv;txt('ws-prev',pv?fmt('{t}까지 통합니다',{t:kst(pv)}):'');
  txt('ws-secret',WH.secret||'(응답에 비밀값이 없습니다. 비밀값을 다시 교체하세요)');
  $('dlg-whsecret').showModal();$('ws-copy').focus();}
/* closing (the button, Esc) wipes the secret from the DOM and this variable. */
$('dlg-whsecret').addEventListener('close',function(){WH.secret='';txt('ws-secret','');var back=WH.back;WH.back='';if(back&&S.route.tab==='webhooks')landFocus(back);});
$('ws-close').addEventListener('click',function(){$('dlg-whsecret').close();});
$('ws-copy').addEventListener('click',function(){copy(WH.secret,this,'ws-secret');});

/* ---------- rotate · delete ---------- */
/* rotate: the current secret keeps working 24 h (the server keeps one previous secret). If an earlier rotation's previous secret is still in
   its 24 h, rotating again cuts that one right away - the dialog says so. */
function rotateWh(w,b){var now=Date.now(),until=new Date(now+86400000).toISOString(),pv=typeof w.previousValidUntil==='string'?new Date(w.previousValidUntil).getTime():NaN;
  var body=['새 비밀값을 만듭니다. 지금 비밀값도 24시간 동안 함께 통하니, 그동안 수신 서버를 새 값으로 바꾸세요.',fmt('지금 비밀값은 {t}쯤까지 통합니다.',{t:kst(until)})];
  if(!isNaN(pv)&&pv>now)body.push(fmt('지난 교체 전의 비밀값({t}까지)은 바로 끊깁니다.',{t:kst(w.previousValidUntil)}));
  body.push('새 비밀값은 다음 창에서 한 번만 보입니다.');
  ask({kicker:'비밀값 교체',title:'이 웹훅의 비밀값을 교체할까요?',ok:'교체',list:[whUrlNode(w.url)],body:body})
  .then(function(y){if(!y)return;var id=S.cur;return run(b,'wh-msg',function(){return api('POST','/api/agents/'+enc(id)+'/webhooks/'+enc(w.id)+'/rotate').then(function(j){
    showWhSecret(j&&j.secret,obj(j)&&obj(j.item)?j.item:w,'rotate',j&&typeof j.previousValidUntil==='string'?j.previousValidUntil:(obj(j)&&obj(j.item)?j.item.previousValidUntil:null));
    if(S.cur!==id)return;say('wh-msg','비밀값을 교체했습니다.','ok');return loadWebhooks();},function(e){if(whSaved(e)){if(S.cur===id)return loadWebhooks();return;}throw e;});});});}
function deleteWh(w,b){
  ask({kicker:'웹훅 삭제',title:'이 웹훅을 삭제할까요?',danger:true,ok:'삭제',list:[whUrlNode(w.url)],
    body:['이 주소로 가던 이벤트가 바로 멈춥니다. 아직 보내지 못한 이벤트도 더 보내지 않습니다.'],warn:'삭제는 되돌릴 수 없습니다. 다시 받으려면 새로 추가하고 새 비밀값을 받아야 합니다.'})
  .then(function(y){if(!y)return;var id=S.cur;return run(b,'wh-msg',function(){return api('DELETE','/api/agents/'+enc(id)+'/webhooks/'+enc(w.id)).then(function(){
    if(S.cur!==id)return;say('wh-msg','웹훅을 삭제했습니다.','ok');
    if(WH.dl.filter===w.id){WH.dl.filter='';$('wd-f').value='';}
    return loadWebhooks().then(function(){landFocus('h-ag-wh');loadDeliveries(true);});});});});}

/* ---------- the Authorization header: set / replace (dialog) · clear (confirm) ---------- */
var WZ={id:'',w:null};
function authWh(w){if(!can('admin')||!S.cur)return;WZ.id=S.cur;WZ.w=w;var inp=$('wz-auth'),has=w.hasAuthorization===true;
  inp.value='';fieldErr(inp,'');say('wz-msg','');txt('wz-title',has?'인증 헤더 교체':'인증 헤더 설정');
  txt('wz-url',whUrl(w.url)||'—');$('wz-url').title=whUrl(w.url);
  $('wz-cur-t').hidden=!has;$('wz-cur').hidden=!has;txt('wz-cur',has?(str(w.authorizationHint,40)||'…'):'');
  $('dlg-whauth').showModal();inp.focus();}
dlgBind('dlg-whauth','wz-go','wz-cancel');
$('dlg-whauth').addEventListener('close',function(){$('wz-auth').value='';WZ.w=null;});
$('wz-form').addEventListener('submit',function(ev){ev.preventDefault();var id=WZ.id,w=WZ.w,inp=$('wz-auth'),v=inp.value.trim();
  if(!w||dlgStale('dlg-whauth',id))return;fieldErr(inp,'');say('wz-msg','');
  if(!v){fieldErr(inp,'값을 넣으세요. 헤더를 없애려면 ⋯ 메뉴의 ‘인증 헤더 삭제’를 쓰세요.');return;}
  var ae=whAuthErr(v);if(ae){fieldErr(inp,ae);return;}
  run($('wz-go'),'wz-msg',function(){return api('POST','/api/agents/'+enc(id)+'/webhooks/'+enc(w.id)+'/authorization',{authorization:v}).then(function(){
    inp.value='';$('dlg-whauth').close();if(S.cur!==id)return;say('wh-msg','인증 헤더를 저장했습니다. 다음 전달부터 실립니다.','ok');return loadWebhooks();},function(e){
    if(e instanceof ApiError&&e.code==='invalid_authorization'){fieldErr(inp,human(e));return;}throw e;});});});
function clearAuthWh(w,b){
  ask({kicker:'인증 헤더 삭제',title:'인증 헤더를 삭제할까요?',danger:true,ok:'삭제',list:[whUrlNode(w.url)],
    body:['다음 전달부터 Authorization 헤더 없이 보냅니다. 수신 서버가 인증을 요구하면 전달이 실패합니다.','삭제한 값은 되살릴 수 없습니다. 다시 쓰려면 새로 넣으세요.']})
  .then(function(y){if(!y)return;var id=S.cur;return run(b,'wh-msg',function(){return api('DELETE','/api/agents/'+enc(id)+'/webhooks/'+enc(w.id)+'/authorization').then(function(){
    if(S.cur!==id)return;say('wh-msg','인증 헤더를 삭제했습니다.','ok');return loadWebhooks().then(function(){landFocus('h-ag-wh');});});});});}

/* ---------- deliveries ---------- */
function renderWhFilter(items){var s=$('wd-f'),cur=WH.dl.filter;
  /* the first option ("all webhooks") is markup; the rest are this list's, marked so a redraw removes only them. */
  for(var i=s.children.length-1;i>=0;i--)if(s.children[i].className==='whopt')s.removeChild(s.children[i]);
  items.forEach(function(w){var o=el('option','whopt',whShort(w.url,56));o.value=w.id;o.title=whUrl(w.url);s.appendChild(o);});
  s.value=cur;s.hidden=items.length<2&&!cur;}
function loadDeliveries(reset){var id=S.cur,D=WH.dl;if(!id)return Promise.resolve();
  if(reset){D.items=[];D.next=null;D.seq++;}
  var seq=D.seq,p=[],q='/api/agents/'+enc(id)+'/webhooks/deliveries';
  if(!reset&&D.next)p.push('cursor='+enc(D.next));if(D.filter)p.push('webhookId='+enc(D.filter));if(p.length)q+='?'+p.join('&');
  say('wd-msg','');busy($('wd-more'),true);
  return api('GET',q).then(function(j){if(seq!==D.seq||S.cur!==id)return;
    D.items=D.items.concat(arr(j&&j.items).filter(function(x){return obj(x)&&typeof x.id==='string';}));
    D.next=obj(j)&&typeof j.nextCursor==='string'&&j.nextCursor?j.nextCursor:null;D.loaded=true;renderDeliveries();},
    function(e){if(seq!==D.seq||S.cur!==id)return;D.loaded=true;$('wd-tbl').hidden=!D.items.length;$('wd-empty').hidden=true;sectionErr('wd-msg')(e);})
  .then(function(){busy($('wd-more'),false);});}
function renderDeliveries(){var D=WH.dl,tb=$('wd-body');if(!D.loaded)return;
  clear(tb);$('wd-tbl').hidden=!D.items.length;$('wd-empty').hidden=D.items.length>0;$('wd-more').hidden=!D.next;
  D.items.forEach(function(x){tb.appendChild(deliveryRow(x));});}
function deliveryRow(x){var tr=el('tr'),k=whState(x.status,x.attempts);
  cell(tr,'이벤트').appendChild(el('span','mono',str(x.eventType,60)||'—'));
  cell(tr,'상태').appendChild(pillEl(k[0],k[1]));
  var a=cell(tr,'시도');a.className='cv num';a.textContent=typeof x.attempts==='number'?grp(x.attempts):'—';
  var h=cell(tr,'HTTP');h.className='cv num';h.textContent=typeof x.httpStatus==='number'?String(x.httpStatus):'—';
  var w=whById(x.webhookId),wc=cell(tr,'URL');wc.className='cv mono whw';wc.textContent=w?whShort(w.url,40):(typeof x.webhookId==='string'?str(x.webhookId,12):'—');if(w)wc.title=whUrl(w.url);
  var at=x.deliveredAt||x.lastAttemptAt||x.createdAt,t=timeCell(cell(tr,'시각'),at);
  var ac=el('td','act');tr.appendChild(ac);
  if(can('admin')&&x.status==='dead'){var b=button('다시 보내기','btn sm link',function(bt){redeliver(x,bt);});
    b.setAttribute('aria-label',fmt('{e} 다시 보내기',{e:str(x.eventType,60)}));ac.appendChild(b);}
  return tr;}
function redeliver(x,b){var id=S.cur;
  run(b,'wd-msg',function(){return api('POST','/api/agents/'+enc(id)+'/webhooks/deliveries/'+enc(x.id)+'/redeliver').then(function(j){if(S.cur!==id)return;
    say('wd-msg','다시 보내도록 요청했습니다.','ok');var n=obj(j)&&obj(j.item)&&typeof j.item.id==='string'?j.item:null;
    /* the server answers with a new delivery row (same event, pending): it goes on top; the dead row stays as the record. */
    if(n){WH.dl.items=[n].concat(WH.dl.items.filter(function(it){return it.id!==n.id;}));renderDeliveries();}landFocus('h-wd');});});}
$('wd-more').addEventListener('click',function(){loadDeliveries(false);});
$('wd-f').addEventListener('change',function(){WH.dl.filter=this.value;loadDeliveries(true);});
`;
