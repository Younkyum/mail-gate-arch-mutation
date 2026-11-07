/**
 * src/admin/ui/console/script/identity.ts — 앱 스크립트 조각: 신원 한 페이지(§3) — 컬러 ID 카드(키 지문 → 색·기요셰 로제트·시질) ·
 * 오른쪽 정보 · 신원 공개 스위치(게시 ↔ 게시 중단) · 변경 이력(신원 블록) · 목록·스위처·사이드바의 썸네일.
 */

export const IDENTITY_JS = String.raw`/* ---------- identity ---------- */
var IDST={draft:['게시 전','dim'],published:['게시됨','on'],suspended:['게시 중단','bad'],revoked:['폐기됨','on']};
var IDKIND={publish:'게시',suspend:'게시 중단',revoke:'폐기',resign:'다시 서명'};
var IDOUT={published:'게시됨',suspended:'게시 중단됨',revoked:'폐기됨',unchanged:'바뀐 것 없음',rejected:'거부됨'};
function safeIdUrl(u){return (typeof u==='string'&&/^https:\/\/id\.atmark\.ai\/[A-Za-z0-9._~\/-]+$/.test(u))?u:'';}
function loadIdentity(id){return api('GET','/api/agents/'+enc(id)+'/identity').then(function(j){S.ident[id]=obj(j)?j:{};return S.ident[id];});}
function idLink(li,a,u){li.hidden=!u;if(u)a.href=u;}
// No DID prefix literal here (ADR-0002: only did.ts assembles DIDs). Shorten the id after the last ':'.
function didShort(did){var cut=did.lastIndexOf(':');if(cut>0){var head=did.slice(0,cut+1),id=did.slice(cut+1);return id.length>10?head+id.slice(0,4)+'…'+id.slice(-4):did;}
  return did.length>44?did.slice(0,30)+'…'+did.slice(-8):did;}
function idState(x,loaded){return IDST[x.status]?x.status:(loaded?'draft':'');}
/* key fingerprint: identity (E8) first, then the agent list (E9), then the identity-blocks card (older servers). Only a SHA-256 hex counts. */
function fpOf(a){var x=S.ident[a.id],b=S.blocks[a.id],c=b&&obj(b.card)?b.card:{};
  var k=x&&typeof x.keyFingerprint==='string'?x.keyFingerprint:typeof a.keyFingerprint==='string'?a.keyFingerprint:typeof c.keyFingerprint==='string'?c.keyFingerprint:'';
  return HEX64.test(k)?k:'';}
function algOf(a){var x=S.ident[a.id],b=S.blocks[a.id],c=b&&obj(b.card)?b.card:{};
  var k=x&&typeof x.keyAlgorithm==='string'?x.keyAlgorithm:typeof c.keyAlgorithm==='string'?c.keyAlgorithm:'';return k==='ed25519'?'Ed25519':str(k,20);}

/* ---------- identity art (D1 D8): hue + guilloche rosette + mirrored sigil, all from the key fingerprint (ART_JS).
   Colors live in the stylesheet (.idc / .idthumb tokens over var(--h)); the script only sets --h through CSSOM and draws with classes.
   SVG nodes take the namespace of the inline <svg> in the markup (no namespace URL literal in the script). ---------- */
function svgEl(tag,attrs){var e=d.createElementNS($('idc-svg').namespaceURI,tag);Object.keys(attrs).forEach(function(k){e.setAttribute(k,String(attrs[k]));});return e;}
/* the key hue and its derived hues (all inside the allowed set — ART_JS artParams) go to CSSOM; CSS never adds angles. */
var HUES=['h','h2','h3','h4'];
function setHue(node,p){HUES.forEach(function(k){if(p)node.style.setProperty('--'+k,String(p[k]));else node.style.removeProperty('--'+k);});}
/* 8x8 cells in the 32x32 middle of the 100 box: left half from fingerprint bytes, mirrored. 2 bits pick empty/square/dot/wedge, 1 bit ink or label tone. */
function sigil(g,hex){for(var r=0;r<8;r++)for(var c=0;c<4;c++){var v=fpByte(hex,(r*4+c)%32),kind=v&3,cls=(v&4)?'k':'m';
  [c,7-c].forEach(function(col,side){var x=34+col*4,y=34+r*4;
    if(kind===1)g.appendChild(svgEl('rect',{x:x,y:y,width:4,height:4,'class':cls}));
    else if(kind===2)g.appendChild(svgEl('circle',{cx:x+2,cy:y+2,r:1.6,'class':cls}));
    else if(kind===3)g.appendChild(svgEl('path',{d:side===0?'M'+x+' '+(y+4)+'L'+(x+4)+' '+y+'L'+(x+4)+' '+(y+4)+'Z':'M'+(x+4)+' '+(y+4)+'L'+x+' '+y+'L'+x+' '+(y+4)+'Z','class':cls}));});}}
function drawCard(svg,hex){clear(svg);var p=artParams(hex);
  if(!p){svg.appendChild(svgEl('circle',{cx:50,cy:50,r:30,'class':'nokey'}));return;}
  for(var j=0;j<p.k;j++){var path=svgEl('path',{d:rosette(50,50,14+j*(26/p.k),p.A,p.n,p.A2,p.m,p.phi,360),'class':'rl'});path.setAttribute('opacity',(0.35+0.06*j).toFixed(2));svg.appendChild(path);}
  svg.appendChild(svgEl('path',{d:rosette(50,50,47,1.2,24,0,1,0,720),'class':'rim'}));
  svg.appendChild(svgEl('circle',{cx:50,cy:50,r:19,'class':'disc'}));
  var g=svgEl('g',{'class':'sig'});sigil(g,hex);svg.appendChild(g);}
/* thumbnail (list rows, switcher, sidebar head, agent head): one rosette ring + a core dot. No key yet: a dashed ring, grey. */
function paintThumb(s,fp){clear(s);var p=artParams(typeof fp==='string'?fp:'');s.classList.toggle('nokey',!p);setHue(s,p);
  var svg=svgEl('svg',{viewBox:'0 0 100 100',focusable:'false'});
  if(p){svg.appendChild(svgEl('path',{d:rosette(50,50,30,9,p.n,0,1,0,180),'class':'rl'}));svg.appendChild(svgEl('circle',{cx:50,cy:50,r:10,'class':'core'}));}
  else svg.appendChild(svgEl('circle',{cx:50,cy:50,r:28,'class':'nokey'}));
  s.appendChild(svg);}
function thumb(a,cls){var s=el('span','idthumb'+(cls?' '+cls:''));s.setAttribute('aria-hidden','true');paintThumb(s,a&&a.keyFingerprint);return s;}
function micro(hex){var u=hex.toUpperCase(),o='';for(var i=0;i<3;i++)o+=u;return o;}
/* foil sheen follows the pointer (CSSOM --mx/--my). Not wired when the reader asked for reduced motion. */
(function(){var art=$('idc-art'),rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;if(rm||!art.getBoundingClientRect)return;
  art.addEventListener('pointermove',function(ev){var r=art.getBoundingClientRect();if(!r.width)return;
    art.style.setProperty('--mx',Math.round((ev.clientX-r.left)/r.width*100)+'%');art.style.setProperty('--my',Math.round((ev.clientY-r.top)/r.height*100)+'%');});})();

function showIdentity(a,soft){var id=a.id;renderIdentity(a);
  loadIdentity(id).then(function(){if(S.cur===id&&S.route.tab==='identity')renderIdentity(a);},sectionErr('ai-msg'));
  if(!soft)loadBlocks(id).then(function(){if(S.cur===id&&S.route.tab==='identity')renderIdentity(a);},sectionErr('ib-msg'));}
function renderIdentity(a){var x=S.ident[a.id]||null,loaded=!!x;x=x||{};var st=idState(x,loaded),pend=obj(x.pending),draft=st==='draft';
  var fp=fpOf(a),p=artParams(fp),card=$('idc'),name=str(a.name,80)||'—',org=str(S.org&&S.org.name,80)||'—';
  card.className='idc'+(st?' st-'+st:'')+(pend?' pending':'')+(p?'':' nokey');setHue(card,p);
  txt('idc-org',org);txt('ai-org',org);txt('idc-name',name);put('idc-addr',addrNode(a.address,true));
  var svg=$('idc-svg');if(svg.getAttribute('data-fp')!==fp){drawCard(svg,fp);svg.setAttribute('data-fp',fp);}
  svg.setAttribute('aria-label',fmt('{n}의 신원 무늬',{n:name}));
  var k=IDST[st];txt('idc-badge',k?k[0]:'—');
  var did=draft?'':str(x.did,300),ds=$('ai-did');
  ds.textContent=did?didShort(did):(draft?'게시하면 정해집니다':'—');ds.title=did;
  var dv=$('ai-did-v');dv.textContent=did||(draft?'게시하면 정해집니다':'—');$('ai-did-copy').hidden=!did;
  var ju=safeIdUrl(x.passportJwsUrl),du=safeIdUrl(x.didDocumentUrl),pu=safeIdUrl(x.passportUrl);
  $('idc-seal').hidden=!(st==='published'&&ju);
  txt('idc-ver',draft||x.version===undefined||x.version===null?'—':'v'+str(x.version,20));
  txt('idc-issued',draft?'—':ymd(x.issuedAt||x.publishedAt));txt('idc-until',draft?'—':ymd(x.validUntil));
  txt('idc-micro',fp?micro(fp):'');
  $('ai-wm').hidden=!draft;$('ai-stamp').hidden=st!=='revoked';
  put('ai-addr',addrNode(a.address,true));txt('ai-agent',str(a.id,80));
  txt('ai-pp',loaded&&!draft?(k?k[0]:'—')+' · v'+str(x.version,20)+' · '+ymd(x.issuedAt||x.publishedAt)+' → '+ymd(x.validUntil):(k?k[0]:'—'));
  var kn=$('ai-key');kn.textContent=fp?algOf(a)+' · '+fpText(fp):'키 준비 중';kn.title=fp;
  var bc=S.blocks[a.id]&&obj(S.blocks[a.id].card)?S.blocks[a.id].card:{},pp=obj(bc.passport)?bc.passport:null,jw=pp&&typeof pp.jwsSha256==='string'?pp.jwsSha256:'';
  var jn=$('ai-jws');jn.textContent=jw?hshort(jw):'—';jn.title=jw;
  idLink($('ai-did-li'),$('ai-did-a'),du);idLink($('ai-pp-li'),$('ai-pp-a'),pu);idLink($('ai-jws-li'),$('ai-jws-a'),ju);
  $('ai-links').hidden=!(du||pu||ju);$('ai-nolinks').hidden=!!(du||pu||ju);
  txt('ai-at',kst(x.publishedAt));txt('ai-issued',kst(x.issuedAt));txt('ai-until',kst(x.validUntil));txt('ai-hash',str(x.contentHash,120)||'—');
  var lr=obj(x.lastResult)?x.lastResult:null;
  txt('ai-last',lr?(IDKIND[lr.kind]||str(lr.kind,20))+' → '+(IDOUT[lr.outcome]||str(lr.outcome,20))+(lr.reason?' ('+str(lr.reason,120)+')':'')+' · '+kst(lr.completedAt):'—');
  $('ai-pending').hidden=!pend;if(pend)txt('ai-pending',(IDKIND[x.pending.kind]||str(x.pending.kind,20))+' 요청을 서명 작업이 처리하고 있습니다. 보통 1분 안에 끝납니다.'+(x.pending.lastError?' 마지막 오류: '+str(x.pending.lastError,160):''));
  renderSwitch(st,loaded,pend);
  renderBlocks(a);
  if(pend)pollIdentity(a.id);}
/* the public-identity switch (s3.6): on = published. Off is draft or suspended (the document stays, re-signed as suspended — never "private").
   Locked (aria-disabled) while loading, when revoked, or before the operator review (publishing is closed then). Busy while a request runs.
   Re-sign (secondary, signature section head): only while published — the same publish request, signed again now (v3 manual re-sign). */
function renderSwitch(st,loaded,pend){var b=$('id-switch'),on=st==='published',orgOk=!!(S.org&&S.org.reviewStatus==='active')&&!S.idOrgBlocked;
  var locked=!loaded||st==='revoked'||(!orgOk&&!on);
  var rs=$('ai-resign');rs.hidden=!(loaded&&on);rs.disabled=!!pend||!orgOk;
  b.setAttribute('aria-checked',String(on));b.setAttribute('aria-disabled',String(locked||!!pend));b.setAttribute('aria-busy',String(!!pend));
  txt('id-sw-st',pend?'처리 중…':st==='suspended'?'게시 중단됨':'');
  if(!can('admin')){rs.disabled=true;rs.title=ROLE_WHY.admin;lockSwitch();}
  txt('id-sw-line',st==='revoked'?'폐기된 신원입니다.':!loaded?'':(!orgOk&&!on)?'운영자 검토가 끝나면 켤 수 있습니다.':st==='suspended'?'공개 문서에는 ‘게시 중단’으로 표시됩니다.':'');}
$('ai-did-copy').addEventListener('click',function(){var x=S.ident[S.cur];copyTo(x&&typeof x.did==='string'?x.did:'','ai-did-copy-st');});
$('ai-agent-copy').addEventListener('click',function(){var a=curAgent();copyTo(a?String(a.id):'','ai-agent-copy-st');});
function pollIdentity(id){if(S.idTimer)return;S.idTimer=setTimeout(function(){S.idTimer=0;
  if(S.route.view!=='agent'||S.route.tab!=='identity'||S.cur!==id)return;
  loadIdentity(id).then(function(){var a=agentById(id);if(a&&S.cur===id)renderIdentity(a);},sectionErr('ai-msg'));},6000);}
function identityAct(kind,b,st){var a=curAgent();if(!a)return;var name=str(a.name,80);
  var o=kind==='publish'&&st==='published'?{kicker:'다시 서명',title:fmt('{n}의 신원 문서를 다시 서명할까요?',{n:name}),ok:'다시 서명',
      body:['DID 문서와 패스포트를 서명해 id.atmark.ai에 게시합니다. 누구나 읽을 수 있는 공개 문서입니다.','목록 내용과 수치, 조직 이름은 싣지 않습니다.']}
    :kind==='suspend'?{kicker:'게시 중단',title:fmt('{n}의 신원 게시를 중단할까요?',{n:name}),danger:true,ok:'게시 중단',
      body:['문서는 남고 ‘게시 중단’ 상태로 바뀝니다. 다시 켜면 게시됨으로 돌아옵니다.'],warn:'받는 쪽은 이 신원을 믿지 않게 됩니다.',ack:'받는 쪽 확인이 실패하는 것을 확인했습니다'}
    :st==='suspended'?{kicker:'다시 게시',title:fmt('{n}의 신원을 다시 게시할까요?',{n:name}),ok:'다시 게시',body:['DID 문서와 패스포트를 서명해 id.atmark.ai에 게시합니다.']}
    :{kicker:'게시',title:fmt('{n}의 신원 문서를 게시할까요?',{n:name}),ok:'게시',
      body:['이름·주소·DID가 공개 문서로 게시됩니다. 조직 이름은 들어가지 않습니다.','DID 문서와 패스포트를 서명해 id.atmark.ai에 게시합니다. 누구나 읽을 수 있는 공개 문서입니다.']};
  ask(o).then(function(y){if(!y)return;return run(b,'ai-msg',function(){return api('POST','/api/agents/'+enc(a.id)+'/identity/'+kind).then(function(j){
    if(j&&obj(j.identity))S.ident[a.id]=j.identity;say('ai-msg',kind==='publish'?'요청했습니다. 서명 작업이 처리하면 상태가 바뀝니다.':'중단을 요청했습니다.','ok');
    if(!(j&&obj(j.identity)))return loadIdentity(a.id).then(function(){renderIdentity(a);});renderIdentity(a);},
    function(e){if(e instanceof ApiError&&e.code==='identity_org_not_active'){S.idOrgBlocked=true;renderIdentity(a);}throw e;});}).then(function(){
    if(S.cur===a.id&&S.route.view==='agent'&&S.route.tab==='identity')renderIdentity(a);});});}
$('ai-resign').addEventListener('click',function(){var a=curAgent();if(!a||this.disabled)return;var x=S.ident[a.id];
  if(idState(x||{},!!x)==='published')identityAct('publish',this,'published');});
$('id-switch').addEventListener('click',function(){var a=curAgent();if(!a||this.getAttribute('aria-disabled')==='true')return;
  var x=S.ident[a.id],st=idState(x||{},!!x);identityAct(st==='published'?'suspend':'publish',this,st);});
/* ---------- identity blocks (US-013): the agent's transparency-log identity leaves, chained per agent ----------
   block_hash = SHA-256(prev_block_hash || leaf_hash); the server computes it from real leaves and the file is checked by pnpm log:verify.
   Display values come from the server (DB, checked against the leaf commitments): matches===false shows a "differs" pill,
   pending===true (row changed after the last leaf, still inside the sequencer grace) shows a "pending" pill (L3).
   missing[] = source.missing leaves that point at this agent (L4) -- shown in seq order as "missing record" entries, outside the chain.
   The download asks for ?proofs=1 so the file carries a signed-checkpoint anchor + a per-block inclusion proof (M4, pnpm log:verify --key). */
var IBK={'identity.agent_created':'생성','identity.agent_updated':'정보 변경','identity.address_assigned':'주소 연결','identity.address_retired':'주소 폐기','identity.key_bound':'키 연결','identity.passport_version':'패스포트'};
var IBF={name:'이름',status:'상태',suspended_by:'정지한 쪽',address:'주소',primary:'대표 주소',key:'공개키 지문',algorithm:'알고리즘',version:'버전',content_hash:'내용 해시'};
var BY={owner:'소유자',operator:'운영자'};
function hshort(h){return typeof h==='string'&&h.length>16?h.slice(0,8)+'…'+h.slice(-4):(str(h,80)||'—');}
function fpText(h){return HEX64.test(h)?h.slice(0,16).replace(/(.{4})(?=.)/g,'$1 ')+' … '+h.slice(-8):'—';}
function loadBlocks(id){return api('GET','/api/agents/'+enc(id)+'/identity-blocks').then(function(j){S.blocks[id]=obj(j)?j:{};return S.blocks[id];});}
function changeText(kind,c){var v=c.value;if(v===null||v===undefined)return '—';
  if(c.field==='status'){var m=kind==='identity.passport_version'?IDST[v]:STATUS[v];return m?m[0]:str(v,30);}
  if(c.field==='suspended_by')return BY[v]||str(v,30);
  if(c.field==='primary')return yesNo(v);
  if(c.field==='key'||c.field==='content_hash')return hshort(v);
  if(c.field==='version')return 'v'+str(v,20);
  return str(v,120)||'—';}
function blockNode(b){var li=el('li','blk'),h=el('div','blk-h'),cp=obj(b.checkpoint)?b.checkpoint:{},id=String(b.entryId);
  h.appendChild(el('strong','blk-k',IBK[b.kind]||str(b.kind,40)));
  h.appendChild(el('span','muted blk-seq',fmt('순번 {n}',{n:num(b.seq)})));
  var t=el('span','muted num blk-t',kstShort(b.at));t.title=kst(b.at);h.appendChild(t);
  h.appendChild(cp.state==='checkpointed'?pillEl(fmt('체크포인트 #{e}',{e:num(cp.epoch)}),''):pillEl('체크포인트 대기','dim'));
  /* hash chain + inclusion proof are expert detail: folded under the block (critique R4-13 — one event reads as head + changed values). */
  var more=el('details','blk-d'),sm=el('summary',null,'기술 정보');more.appendChild(sm);
  /* every block has this disclosure: its accessible name carries the block (critique R6-14), the visible text stays short. */
  sm.appendChild(el('span','sr',', '+(IBK[b.kind]||str(b.kind,40))+' · '+fmt('순번 {n}',{n:num(b.seq)})));
  if(cp.state==='checkpointed'&&/^[1-9][0-9]{0,17}$/.test(id))more.appendChild(button('증명','btn sm link blk-proof',function(bt){run(bt,'ib-msg',function(){
    return api('GET','/api/logs/inclusion-proof?entry='+enc(id),undefined,'atmark-inclusion-'+id+'.json').then(function(f){saveBlob(f.blob,f.name);say('ib-msg',fmt('내려받았습니다: {f}',{f:f.name}),'ok');});});}));
  li.appendChild(h);
  var dl=el('dl','blk-c');arr(b.changes).filter(obj).forEach(function(c){dl.appendChild(el('dt',null,IBF[c.field]||str(c.field,30)));var dd=el('dd');
    if(c.field==='address'&&typeof c.value==='string')dd.appendChild(addrNode(c.value,true));else dd.appendChild(el('span',c.field==='key'||c.field==='content_hash'?'mono':null,changeText(b.kind,c)));
    if(c.field==='key'||c.field==='content_hash')dd.title=str(c.value,80);
    if(c.matches===false)dd.appendChild(pillEl('기록과 다름','bad'));else if(c.pending===true)dd.appendChild(pillEl('기록 대기','dim'));dl.appendChild(dd);});
  li.appendChild(dl);
  var hp=el('p','blk-hash mono');hp.appendChild(el('span','muted',hshort(b.prevBlockHash)));hp.appendChild(d.createTextNode(' → '));hp.appendChild(el('span',null,hshort(b.blockHash)));
  hp.title=str(b.blockHash,80);more.appendChild(hp);li.appendChild(more);return li;}
var MISS={agents:'에이전트 정보',agent_addresses:'주소 연결',agent_keypairs:'키 연결',passport_documents:'패스포트'};
var MISSR={not_found:'원천 행 없음',unrepresentable:'옮길 수 없음'};
function missingNode(m){var li=el('li','blk blk-miss'),h=el('div','blk-h');
  h.appendChild(el('strong','blk-k','빠진 블록'));
  h.appendChild(el('span','muted blk-seq',fmt('순번 {n}',{n:num(m.seq)})));
  var t=el('span','muted num blk-t',kstShort(m.at));t.title=kst(m.at);h.appendChild(t);
  h.appendChild(pillEl(MISSR[m.reason]||'원천 행 없음','bad'));li.appendChild(h);
  var dl=el('dl','blk-c');dl.appendChild(el('dt',null,'원천'));dl.appendChild(el('dd',null,MISS[m.table]||str(m.table,40)));li.appendChild(dl);return li;}
function renderBlocks(a){var x=S.blocks[a.id]||null,list=$('ib-list'),bs=x?arr(x.blocks).filter(function(b){return obj(b)&&typeof b.kind==='string';}):[],
  ms=x?arr(x.missing).filter(function(m){return obj(m)&&typeof m.table==='string';}):[];
  clear(list);$('ib-dl').disabled=!bs.length&&!ms.length;$('ib-empty').hidden=!x||bs.length+ms.length>0;
  var all=bs.map(function(b){return {s:num(b.seq),n:function(){return blockNode(b);}};}).concat(ms.map(function(m){return {s:num(m.seq),n:function(){return missingNode(m);}};}));
  all.sort(function(p,q){return p.s-q.s;});all.forEach(function(e){list.appendChild(e.n());});}
$('ib-dl').addEventListener('click',function(){var a=curAgent();if(!a)return;var b=this;run(b,'ib-msg',function(){
  return api('GET','/api/agents/'+enc(a.id)+'/identity-blocks?proofs=1',undefined,'atmark-identity-blocks-'+a.id+'.json').then(function(f){saveBlob(f.blob,f.name);say('ib-msg',fmt('내려받았습니다: {f}',{f:f.name}),'ok');});});});
`;
