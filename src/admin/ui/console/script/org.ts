/**
 * src/admin/ui/console/script/org.ts — 앱 스크립트 조각: 역할(F-1) · 조직 스위처 · 조직 전환 · 새 조직 · 조직 고르기 · 다른 탭 알림
 * (`extensibility-p0-p1.md` §4-1·2·3·5·10).
 *
 *   - 역할은 `/api/me` 의 `organization.role`(없으면 현재 조직의 멤버십 행, 그것도 없으면 옛 서버 — 소유자). member 는 읽기 전용:
 *     변경 컨트롤을 잠그고(`disabled` + 이유 `title`) 맨 위에 `읽기 전용` 한 줄 + ⓘ. 최종 판정은 서버다(403 `forbidden_role`).
 *   - 조직 전환 = 새 세션(O1): `POST /api/session/org` → 새 쿠키 · 새 CSRF → `BroadcastChannel('atmark-console')` 로 다른 탭에 알리고
 *     전체 새로고침. 다른 탭이 옛 CSRF 로 변경을 보내면 서버가 403 `csrf_mismatch` 로 닫힌 채 실패하고, 이 탭은 `/api/me` 를 다시 읽어
 *     조직이 바뀌었으면 한 줄 알리고 새로고침한다.
 */

export const ORG_JS = String.raw`/* ---------- roles (F-1): member reads, admin changes agents/tokens/policy, owner also members/invites/org keys/org-pause release ---------- */
var RANK={member:1,admin:2,owner:3};
var ROLE_NAME={owner:'소유자',admin:'관리자',member:'멤버'};
var ROLE_WHY={admin:'멤버는 바꿀 수 없습니다.',owner:'소유자만 할 수 있습니다.'};
function roleOf(r){return typeof r==='string'&&RANK[r]?r:'';}
function can(min){return (RANK[S.role]||0)>=RANK[min];}
/* lock one control the current role may not use (disabled + why). Render functions call it again after they set disabled themselves. */
function gate(n,min){if(!n||can(min))return n;n.disabled=true;n.title=ROLE_WHY[min];return n;}
function roleChip(r){var k=roleOf(r);return el('span','rolechip'+(k?' r-'+k:''),ROLE_NAME[k]||'—');}
var MUT_ADMIN=['na-open','na-cta','na-go','ov-new','swa-new','tk-new','tk-bulk','dz-kill','dz-del','org-kill-on','ol-edit','ol-go','o-go','o-cancel','i-go','i-cancel',
  'o-allow-add','o-block-add','i-allow-add','i-block-add','sn-add','sn-go','ai-resign','fwd-on','fwd-off','iv-open','iv-go','gs-open','gs-go','wh-add','wh-add-empty','wa-go'];
var MUT_OWNER=['org-kill-off','mb-invite','ok-new','ok-cta'];
function applyRole(){var ro=!can('admin');d.body.classList.toggle('role-ro',ro);$('ro-bar').hidden=!ro;
  MUT_ADMIN.forEach(function(i){gate($(i),'admin');});MUT_OWNER.forEach(function(i){gate($(i),'owner');});
  MKEYS.forEach(function(m){gate($('om-'+m+'-i'),'admin');gate($('im-'+m+'-i'),'admin');});
  lockSwitch();
  var k=roleOf(S.role);txt('me-role',ROLE_NAME[k]||'');txt('acct-role',ROLE_NAME[k]||'');txt('so-role',ROLE_NAME[k]||'—');}
function lockSwitch(){if(can('admin'))return;var b=$('id-switch');b.setAttribute('aria-disabled','true');b.title=ROLE_WHY.admin;}

/* ---------- org switcher (P0 s4-1): rows from /api/me memberships; another org -> POST /api/session/org -> new cookie -> full reload ---------- */
function membershipOf(id){for(var i=0;i<S.memberships.length;i++)if(S.memberships[i].organizationId===id)return S.memberships[i];return null;}
function renderOrgMenu(){var ul=$('swo-list');clear(ul);
  S.memberships.forEach(function(m){var li=el('li'),cur=!!S.org&&m.organizationId===S.org.id,x=el(cur?'a':'button','mi'),t=el('span','mt');
    li.setAttribute('role','none');x.setAttribute('role','menuitem');
    if(cur){x.href='#/overview';x.setAttribute('aria-current','true');}
    else{x.type='button';x.addEventListener('click',function(){switchOrg(m.organizationId,'#/overview').catch(function(){});});}
    t.appendChild(el('span','nm',str(m.name,60)||'—'));if(m.reviewStatus==='pending_review')t.appendChild(el('span','msub','운영자 검토 중'));
    x.appendChild(t);x.appendChild(roleChip(m.role));if(cur)x.appendChild(ckEl());li.appendChild(x);ul.appendChild(li);});}
/* the whole app reloads on the new session (cookie and CSRF rotated): the hash first, then a real reload (a hash-only replace would not reload). */
function reloadApp(hash){try{history.replaceState(null,'','/app'+(hash||'#/overview'));}catch(e){}location.reload();}
var BC=null;
try{if(typeof BroadcastChannel==='function'){BC=new BroadcastChannel('atmark-console');
  BC.onmessage=function(ev){var m=ev&&ev.data;if(obj(m)&&m.type==='org-switched')movedElsewhere();};}}catch(e){BC=null;}
function tellTabs(){try{if(BC)BC.postMessage({type:'org-switched'});}catch(e){}}
function movedElsewhere(){if(S.moving)return;S.moving=true;$('org-moved').hidden=false;setTimeout(function(){reloadApp('#/overview');},1200);}
function switchOrg(id,hash){if(!id)return Promise.resolve();if(S.org&&id===S.org.id){location.hash=hash||'#/overview';return Promise.resolve();}
  banner('');return api('POST','/api/session/org',{organizationId:id}).then(function(j){if(j&&typeof j.csrf==='string')S.csrf=j.csrf;S.moving=true;tellTabs();reloadApp(hash);},
    function(e){banner(human(e));throw e;});}
/* another tab switched (the shared cookie now names another org): the old CSRF fails closed with 403 csrf_mismatch. Read /api/me again. */
function staleCheck(){if(S.moving||S.staleBusy)return;S.staleBusy=true;
  api('GET','/api/me').then(function(j){S.staleBusy=false;var o=j&&obj(j.organization)?j.organization:{};
    if(S.org&&typeof o.id==='string'&&o.id!==S.org.id)movedElsewhere();else if(j&&typeof j.csrf==='string')S.csrf=j.csrf;},function(){S.staleBusy=false;});}
$('org-other-go').addEventListener('click',function(){var b=this;busy(b,true);switchOrg(S.otherOrg,S.otherHref).catch(function(){busy(b,false);});});

/* ---------- new organization (F-3: an existing user's new org is made here; the session moves to it) ---------- */
function orgNameOk(v){var n=Array.from(v).length;return n>=1&&n<=80&&!TKBAD.test(v);}
function newOrgOpen(){$('no-name').value='';say('no-msg','');fieldErr($('no-name'),'');$('dlg-neworg').showModal();$('no-name').focus();}
$('swo-new').addEventListener('click',newOrgOpen);
$('so-new').addEventListener('click',newOrgOpen);
$('no-cancel').addEventListener('click',function(){$('dlg-neworg').close();});
$('no-form').addEventListener('submit',function(ev){ev.preventDefault();var name=$('no-name').value.trim();
  say('no-msg','');if(!orgNameOk(name)){fieldErr($('no-name'),CODES.invalid_organization_name);return;}fieldErr($('no-name'),'');
  run($('no-go'),'no-msg',function(){return api('POST','/api/organizations',{name:name}).then(function(j){if(j&&typeof j.csrf==='string')S.csrf=j.csrf;
    S.moving=true;say('no-msg','만들었습니다. 새 조직으로 엽니다.','ok');tellTabs();reloadApp('#/overview');});});});

/* ---------- choose an organization (#/select-org: the login landing sends a user with several orgs here) ---------- */
function showSelectOrg(){var ul=$('so-list');clear(ul);
  S.memberships.forEach(function(m){var li=el('li'),cur=!!S.org&&m.organizationId===S.org.id,b=el('button','orgpick'),t=el('span','op-t'),meta=el('span','op-m');b.type='button';
    var av=el('span','av org lg');av.setAttribute('data-i',initial(str(m.name,80)));av.setAttribute('aria-hidden','true');b.appendChild(av);
    t.appendChild(el('span','op-n',str(m.name,80)||'—'));meta.appendChild(roleChip(m.role));
    var rv=REVIEW[m.reviewStatus];if(rv&&m.reviewStatus!=='active')meta.appendChild(el('span','small muted',rv));
    if(cur)meta.appendChild(el('span','small strong','지금 조직'));t.appendChild(meta);b.appendChild(t);
    var go=el('span','op-go');go.appendChild(ico('arrowRight'));go.setAttribute('aria-hidden','true');b.appendChild(go);
    b.addEventListener('click',function(){if(cur){location.hash='#/overview';return;}busy(b,true);say('so-msg','');
      switchOrg(m.organizationId,'#/overview').catch(function(e){busy(b,false);say('so-msg',human(e),'err');});});
    li.appendChild(b);ul.appendChild(li);});}
`;
