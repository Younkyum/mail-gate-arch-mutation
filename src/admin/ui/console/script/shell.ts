/**
 * src/admin/ui/console/script/shell.ts — 앱 스크립트 조각: 라우팅(리다이렉트 · 예약 `#/o/{org}`) · 스코프 사이드바(요금제 카드 ·
 * 접기/겹침/서랍) · 설정 섹션(한 화면에 하나) · 상단 바 스위처 · 세션 · 테마 · 부팅.
 *
 * 사이드바(명세 §4.3): ≥1150 은 `#side-toggle` 이 레일 ↔ 펼침을 바꾸고 이 브라우저에 저장한다(`SIDE_STORAGE_KEY` — 첫 칠 전 적용은 `THEME_BOOT_JS`).
 * 그보다 좁으면 `#menu-btn`/`#side-toggle` 이 겹침 패널(768–1149)·서랍(≤767)을 연다(`body.nav-open` + `#side-scrim`). 바깥 클릭·Esc·
 * 항목 선택(라우트 변경)으로 닫히고, Esc·닫기 버튼은 포커스를 `#menu-btn` 으로 돌려준다. `matchMedia`·`localStorage` 는 있을 때만 쓴다.
 * 계정·테마·언어는 사이드바 아래 계정 블록(`#acct-btn` → `#acct-menu`, 2026-09-30)이다 — 상단 바에는 스위처만 남았다.
 */

import { DEFAULT_MAIL_LOCALE } from '../../../../i18n/locales';
import { MAIL_LOCALE_ORDER } from '../markup/settings';
import { SIDE_STORAGE_KEY, THEME_STORAGE_KEY } from '../../page';

export const SHELL_JS = String.raw`/* ---------- routing ---------- */
var VIEW_IDS={overview:'v-overview',agents:'v-agents',domains:'v-domains',watch:'v-watch',logs:'v-logs',settings:'v-settings',agent:'v-agent','select-org':'v-select-org'};
var HEAD_IDS={overview:'h-overview',agents:'h-agents',domains:'h-domains',watch:'h-watch',logs:'h-logs',settings:'h-settings','select-org':'h-select-org'};
var PANE_HEAD={overview:'a-name',connect:'h-ag-connect',email:'h-ag-email',addresses:'h-ag-addr',webhooks:'h-ag-wh',logs:'h-ag-logs',identity:'h-ag-identity',tokens:'h-ag-tokens'};
/* org sidebar: overview, agents, domains, watch, logs, settings - the org logs are a first-level item (critique R10-11); domains moved up from
   settings on 2026-10-05; watch (mail levels, held mail, trusted senders, self-enroll) on 2026-10-08. */
var NAV_ORG=['overview','agents','domains','watch','logs','settings'],NAV_OF={overview:'overview',agents:'agents',domains:'domains',watch:'watch',logs:'logs',settings:'settings'};
/* ---------- sidebar: rail (>=1150, kept in this browser) · overlay panel (768-1149) · drawer (<=767) ---------- */
var SIDE_KEY='${SIDE_STORAGE_KEY}';
function wide(){try{return !!(window.matchMedia&&window.matchMedia('(min-width:1150px)').matches);}catch(e){return false;}}
function railOn(){return d.documentElement.getAttribute('data-side')==='rail';}
function sideShow(){var b=$('side-toggle'),x=wide()?!railOn():d.body.classList.contains('nav-open');
  b.setAttribute('aria-expanded',String(x));txt('side-toggle-t',x?'사이드바 접기':'사이드바 펼치기');}
function phone(){try{return !!(window.matchMedia&&window.matchMedia('(max-width:767px)').matches);}catch(e){return false;}}
/* drawer (<=767) and overlay panel (768-1149) are modal (critique R6-02): while open, what lies behind the scrim is inert and the panel is a
   dialog. On a tablet the header's menu button stays live (it is the close control); on a phone the drawer covers the header too. */
function navOpen(on,focus){var was=d.body.classList.contains('nav-open'),modal=on&&!wide();
  d.body.classList.toggle('nav-open',on);$('menu-btn').setAttribute('aria-expanded',String(on));$('side-scrim').hidden=!on;sideShow();
  ['main','skip','crumb','top-home'].forEach(function(i){var n=$(i);if(n)n.inert=modal;});$('top').inert=modal&&phone();
  var sd=$('side');if(modal){sd.setAttribute('role','dialog');sd.setAttribute('aria-modal','true');}else{sd.removeAttribute('role');sd.removeAttribute('aria-modal');}
  if(on&&focus){var f=$(S.route.view==='agent'?'na-back':'n-overview');if(f)f.focus();}
  return was&&!on;}
function sideSet(rail){var r=d.documentElement;if(rail)r.setAttribute('data-side','rail');else r.removeAttribute('data-side');
  try{localStorage.setItem(SIDE_KEY,rail?'rail':'full');}catch(e){}sideShow();}
$('side-toggle').addEventListener('click',function(){if(wide())sideSet(!railOn());else navOpen(!d.body.classList.contains('nav-open'),true);});
$('side-close').addEventListener('click',function(){navOpen(false);$('menu-btn').focus();});
$('side-scrim').addEventListener('click',function(){navOpen(false);$('menu-btn').focus();});
/* Esc closes an open drawer wherever focus is (critique R6-03) — after a dialog, menu or tip has had its turn. */
d.addEventListener('keydown',function(ev){if(ev.key!=='Escape'||!d.body.classList.contains('nav-open'))return;
  if(ev.defaultPrevented||anyDialog()||S.menu)return;navOpen(false);$('menu-btn').focus();});
/* skip link: focus the content without touching the hash (the hash is the route). */
$('skip').addEventListener('click',function(ev){if(ev&&ev.preventDefault)ev.preventDefault();$('main').focus();});
window.addEventListener('resize',function(){var open=d.body.classList.contains('nav-open');if(open&&wide())navOpen(false);else if(open)navOpen(true);else sideShow();}); /* a phone drawer that becomes a tablet overlay gets its inert/role recomputed (review) */
/* the org avatar and my avatar: the first character (a Hangul name gives its first syllable; a surrogate pair stays whole).
   Drawn by CSS from data-i (content:attr) so it never joins a button's text or accessible name. */
function initial(v){var s=String(v||''),c=s.charCodeAt(0);return (c>=0xD800&&c<=0xDBFF?s.slice(0,2):s.slice(0,1)).toUpperCase();}
function sideMe(){$('org-av').setAttribute('data-i',initial(str(S.org&&S.org.name,80)));$('acct-av').setAttribute('data-i',initial(str(S.user&&S.user.email,254)));}
/* settings menu (one screen per section, 2026-09-27): the route's section is the current page; as a phone tab row it keeps the current tab in view. */
function secMark(k){SETTINGS_SECTIONS.forEach(function(s){var x=$('ns-'+s);if(s===k)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  var n=$('snav'),a=$('ns-'+k);if(!a||!n||!(n.scrollWidth>n.clientWidth)||!a.getBoundingClientRect)return;
  var nb=n.getBoundingClientRect(),ab=a.getBoundingClientRect();if(ab.left<nb.left||ab.right>nb.right)n.scrollLeft+=ab.left-nb.left-(nb.width-ab.width)/2;}
/* language links carry the route (the 302 keeps the fragment): settings > display (lg-*) and the account menu's segment (acct-*, menuitemradio). */
function langHref(){var h=location.hash;['ko','en'].forEach(function(l){$('lg-'+l).href='?lang='+l+h;var a=$('acct-'+l);a.href='?lang='+l+h;a.setAttribute('aria-checked',String(l===LANG));});
  $('lg-'+LANG).setAttribute('aria-current','true');}
/* scope: the whole sidebar swaps between org and agent (Cloudflare); the top bar gains the agent crumb (Vercel). */
function renderScope(){var r=S.route,a=r.view==='agent'?agentById(r.agent):null,ag=r.view==='agent'&&!(S.agentsLoaded&&!a&&S.agMiss[r.agent]==='gone');
  $('nav-org').hidden=ag;$('nav-agent').hidden=!ag;$('sep-ag').hidden=!ag;$('sw-ag-w').hidden=!ag;d.body.classList.toggle('scope-agent',ag);
  /* settings always shows one section, and the settings menu marks that section as the page; the sidebar item is where you are (location). */
  NAV_ORG.forEach(function(k){var x=$('n-'+k);if(!ag&&NAV_OF[r.view]===k)x.setAttribute('aria-current',(r.view==='settings'||r.view==='watch')&&r.section||r.view==='domains'&&r.domain?'location':'page');else x.removeAttribute('aria-current');});
  if(!ag)return;
  /* a deleted agent keeps only its overview and logs (read-only); the other screens leave the sidebar. */
  var gone=!!a&&a.status==='disabled';
  TABS.forEach(function(t){var x=$('na-'+t);x.href=routeHref({view:'agent',agent:r.agent,tab:t});x.hidden=gone&&GONE_TABS.indexOf(t)<0;if(r.tab===t)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  /* before the agent is known the name slots stay empty (CSS draws a skeleton bar), never a dash that reads as "broken" (critique R7-01). */
  var nm=a?str(a.name,80)||'—':'';txt('sw-ag-name',nm);txt('sc-name',nm);$('sc-name').title=nm;
  if(a)put('sc-addr',addrNode(a.address,true));else clear($('sc-addr'));
  paintThumb($('sw-ag-dot'),a&&a.keyFingerprint);paintThumb($('sc-thumb'),a&&a.keyFingerprint);
  var sv=a?(STATUS[a.status]||[str(a.status,30),'dim']):['','dim'],g=sv[1];$('sc-dot').className='dot'+(g==='on'?'':g==='dim'?' off':' '+g);
  /* F58: the dot names itself (tooltip + accessible name) - the same word as the list's status pill */
  $('sc-dot').title=sv[0];$('sc-dot').setAttribute('aria-label',sv[0]?fmt('상태: {s}',{s:sv[0]}):'상태');} /* same glyph as the list pill (critique R10-09) */
/* agent switcher: search + agents (same page on switch: /tokens stays /tokens) + all agents + new agent. At most SW_PAGE rows.
   While every agent is loaded the search filters here; otherwise the server answers GET /api/agents?limit=20&q= (250 ms after the last key). */
var SWQ_T=0;
function swSearch(){var q=$('sw-q').value.trim().toLowerCase().slice(0,64);clearTimeout(SWQ_T);
  if(!q||!S.agNext){S.swq=null;renderAgentMenu();return;}
  renderAgentMenu();
  SWQ_T=setTimeout(function(){var mine={q:q,items:null};S.swq=mine;
    api('GET','/api/agents?limit='+SW_PAGE+'&q='+enc(q)).then(function(j){if(S.swq!==mine)return;mine.items=keepAgents(agentsPage(j).items);renderAgentMenu();},function(){});},250);}
function renderAgentMenu(){var q=$('sw-q').value.trim().toLowerCase().slice(0,64),ul=$('swa-list'),r=S.route,shown=0;clear(ul);
  var src=S.swq&&S.swq.q===q&&S.swq.items?S.swq.items:S.agents;
  src.forEach(function(a){if(shown>=SW_PAGE||(q&&!agentMatch(a,q)))return;shown++;var nm=str(a.name,80);
    var li=el('li'),x=el('a','mi'),t=el('span','mt');li.setAttribute('role','none');x.setAttribute('role','menuitem');
    var to={view:'agent',agent:a.id,tab:r.view==='agent'?r.tab:'overview'};if(r.view==='agent'&&r.tab==='email'&&r.sub)to.sub=r.sub;x.href=routeHref(to);
    var cur=r.view==='agent'&&r.agent===a.id;if(cur)x.setAttribute('aria-current','true');
    x.appendChild(thumb(a,'dot'));t.appendChild(el('span','nm',nm||'—'));t.appendChild(addrNode(a.address,true));x.appendChild(t);if(cur)x.appendChild(ckEl());li.appendChild(x);ul.appendChild(li);});
  $('swa-none').hidden=shown>0;}
bindMenu($('sw-org'));
/* the account block (sidebar foot, bottom left): the menu opens upward (to the right on the rail); the same menu button as the switchers. */
bindMenu($('acct-btn'));
bindMenu($('sw-ag'),function(){$('sw-q').value='';S.swq=null;renderAgentMenu();$('sw-q').focus();});
$('sw-q').addEventListener('input',swSearch);
$('swa-new').addEventListener('click',newAgent);
/* a route change closes the form and confirm dialogs (review 2026-09-29: a dialog opened for one agent must not submit for the next).
   Not the log sheet (the route itself opens and closes it) and not the shown-once windows (closing wipes the token / key). */
var ROUTE_DLGS=['dlg-confirm','dlg-newtok','dlg-neworg','dlg-invite','dlg-orgkey','dlg-sched-cancel','dlg-rule','dlg-sender','dlg-alias','dlg-webhook',
  'dlg-newagent','dlg-limit','dlg-iv','dlg-gstart','dlg-domadd','dlg-domrm','dlg-wagent','dlg-wtrust','dlg-wcap'];
function go(){
  ROUTE_DLGS.forEach(function(i){var dl=$(i);if(dl&&dl.open)dl.close();});
  /* the skip link's own target (#main - no script, or opened in a new tab) is not a route: keep the screen, focus the content (review) */
  if(location.hash==='#main'){try{history.replaceState(null,'',S.route&&S.route.view?routeHref(S.route):'#/overview');}catch(e){}
    setTimeout(function(){var m=$('main');if(m&&m.focus)m.focus();},0);}
  var r=parseRoute(location.hash),prev=S.route;
  /* reserved #/o/{orgId}/...: the current org's link resolves (and is rewritten); another org's link shows the overview with one line,
     plus "switch to this org" when I am a member there (never an automatic switch). */
  if(r.org&&S.org&&typeof S.org.id==='string'){if(r.org===S.org.id){delete r.org;r.redirect=true;}
    else{var mem=membershipOf(r.org);S.otherOrg=mem?r.org:'';delete r.org;S.otherHref=routeHref(r);r={view:'overview',other:true};}}
  if(r.redirect){delete r.redirect;try{history.replaceState(null,'',routeHref(r));}catch(e){}}
  /* a scroll target survives the rewrite (the agents may still be loading on the first pass). */
  if(r.scroll){S.scrollTo=r.scroll;delete r.scroll;}
  S.route=r;$('org-other').hidden=!r.other;$('org-other-go').hidden=!(r.other&&S.otherOrg);
  /* until /api/me and /api/agents answer, one page skeleton stands in for every screen (no derived "get started", no false zeros). */
  Object.keys(VIEW_IDS).forEach(function(k){$(VIEW_IDS[k]).hidden=!S.ready||k!==r.view;});$('boot-skel').hidden=S.ready||!$('boot-err').hidden;
  /* an unknown address shows the overview and says so once; the address is rewritten so a reload is not unknown again (critique R7-10). */
  if(S.unk&&!r.unknown){S.unk=false;banner('');}
  if(S.part&&moved0(prev,r)){S.part=false;$('part-banner').hidden=true;}
  if(r.unknown&&S.ready){S.unk=true;banner('없는 화면이라 개요를 보여 줍니다.');try{history.replaceState(null,'','#/overview');}catch(e){}}
  navOpen(false);langHref();renderScope();closeTip();closeMenu(false);
  if(!r.entry&&$('dlg-log').open)$('dlg-log').close();
  /* a new screen: the title takes focus once the screen is shown (below — agent panes become visible in showAgent), else the content itself. */
  var moved=prev.view&&(prev.view!==r.view||prev.agent!==r.agent||prev.tab!==r.tab||prev.section!==r.section||prev.domain!==r.domain);if(moved)window.scrollTo(0,0);
  /* before /api/me and /api/agents answer, only the frame is drawn: the boot calls go() again once they have, and the view loads then (one fan-out, not two). */
  if(!S.ready)return;
  if(r.view==='overview')showOverview();
  else if(r.view==='agents')renderAgents();
  else if(r.view==='domains')showDomainsView(r,prev);
  else if(r.view==='watch')showWatch(r,prev);
  else if(r.view==='logs')showLogs(r,'');
  else if(r.view==='settings')showSettings(r,prev);
  else if(r.view==='agent')showAgent(r,false);
  else if(r.view==='select-org')showSelectOrg();
  if(moved)focusHead(r);
  /* one-shot work that needs the new screen rendered (the copy fallback selects the connect text) - after go(), not a timer race (review) */
  if(S.afterRoute){var after=S.afterRoute;S.afterRoute=null;after();}
}
function moved0(p,r){return !!p.view&&(p.view!==r.view||p.agent!==r.agent||p.tab!==r.tab||p.section!==r.section||p.domain!==r.domain);}
function shown(n){for(var x=n;x&&x!==d.body;x=x.parentNode)if(x.hidden)return false;return true;}
function focusHead(r){var h=$(r.view==='agent'?PANE_HEAD[r.tab]:r.view==='settings'?SEC_HEAD[r.section]:r.view==='watch'?WATCH_HEAD[r.section]:r.view==='domains'&&r.domain?'dd-name':HEAD_IDS[r.view]);(h&&shown(h)?h:$('main')).focus({preventScroll:true});}
/* settings: only the route's section is shown, and its data is read when it is shown - once per visit to settings (moving between sections
   does not re-read; leaving settings and coming back does; a section whose read failed tries again when it is opened). */
var SEC_HEAD={org:'h-org',members:'h-members',keys:'h-keys',plan:'h-plan',pause:'h-pause',tlog:'h-it',gate:'h-gate',display:'h-display',mail:'h-mail',session:'h-account'};
function showSettings(r,prev){var k=SETTINGS_SECTIONS.indexOf(r.section)>=0?r.section:SETTINGS_SECTIONS[0];
  if(prev.view!=='settings'||!S.secSeen)S.secSeen={};var first=!S.secSeen[k];S.secSeen[k]=true;
  SETTINGS_SECTIONS.forEach(function(s){$('s-'+s).hidden=s!==k;});secMark(k);
  if(k==='org')renderOrgFacts();
  else if(k==='members'){renderMembers();if(first||!S.mb)loadMembers().catch(sectionErr('mb-msg'));}
  else if(k==='keys'){renderOrgKeys();if(first||!S.ok)loadOrgKeys().catch(sectionErr('ok-msg'));}
  else if(k==='plan'){renderPlan();if(first||!S.plan)loadPlan().catch(sectionErr('pl-msg'));}
  else if(k==='pause')renderOrgKill();
  else if(k==='tlog'){if(first||!S.integ)loadIntegrity();else renderIntegrity();}
  else if(k==='gate'){if(first||!S.report)loadGate().catch(sectionErr('g-msg'));}
  else if(k==='mail'){if(first||!S.mailLocale)loadMailLocale().catch(sectionErr('ml-msg'));else mailLocaleShow(S.mailLocale);}}
window.addEventListener('hashchange',go);
$('menu-btn').addEventListener('click',function(){navOpen(!d.body.classList.contains('nav-open'),true);});

/* ---------- session ---------- */
function logout(b){busy(b,true);forgetPlace();api('POST','/api/logout').catch(function(){}).then(function(){location.replace('/');});}
function logoutAll(b){
  ask({kicker:'모든 기기에서 로그아웃',title:'모든 기기에서 로그아웃할까요?',ok:'로그아웃',
    body:['모든 조직의 콘솔 세션을 끊습니다. 다른 브라우저·기기와 이 브라우저도 로그아웃됩니다.','세션이 샜다고 의심될 때 씁니다. 다시 들어오려면 로그인 코드를 새로 받습니다.']})
  .then(function(y){if(!y)return;busy(b,true);
    return api('POST','/api/logout-all').then(function(){forgetPlace();location.replace('/');},function(e){busy(b,false);banner(human(e));});});}
$('logout').addEventListener('click',function(){logout(this);});
$('logout-s').addEventListener('click',function(){logout(this);});
$('logout-all').addEventListener('click',function(){logoutAll(this);});
$('logout-all-s').addEventListener('click',function(){logoutAll(this);});

/* ---------- theme (system / light / dark: kept in this browser; the head script applies it before first paint).
   Two controls: settings > display (th-*, a radio group) and the account menu's theme segment (sbt-*, menuitemradio - 2026-09-30). ---------- */
var THEME_KEY='${THEME_STORAGE_KEY}',THEMES=['system','light','dark'];
function themeGet(){try{var t=localStorage.getItem(THEME_KEY);return t==='light'||t==='dark'?t:'system';}catch(e){return 'system';}}
function themeShow(t){var r=d.documentElement;if(t==='light'||t==='dark')r.setAttribute('data-theme',t);else r.removeAttribute('data-theme');
  radioSet(['th-system','th-light','th-dark'],'th-'+t);THEMES.forEach(function(k){$('sbt-'+k).setAttribute('aria-checked',String(k===t));});}
function themeSet(t){try{if(t==='system')localStorage.removeItem(THEME_KEY);else localStorage.setItem(THEME_KEY,t);}catch(e){}themeShow(t);}
THEMES.forEach(function(k){$('th-'+k).addEventListener('click',function(){themeSet(k);});$('sbt-'+k).addEventListener('click',function(){themeSet(k);});});
radioKeys(['th-system','th-light','th-dark']);
window.addEventListener('storage',function(e){if(!e||e.key===null||e.key===THEME_KEY)themeShow(themeGet());});
themeShow(themeGet());

/* ---------- system email language (202610101000): one value per person, kept on the server (GET/PATCH /api/me/preferences) - it is not
   this browser's screen language. Each choice is written in its own language. ---------- */
var MAIL_LOCALES=${JSON.stringify(MAIL_LOCALE_ORDER)},ML_IDS=MAIL_LOCALES.map(function(c){return 'ml-'+c;});
function mailLocaleShow(c){radioSet(ML_IDS,'ml-'+(MAIL_LOCALES.indexOf(c)>=0?c:'${DEFAULT_MAIL_LOCALE}'));}
function loadMailLocale(){return api('GET','/api/me/preferences').then(function(j){j=obj(j)?j:{};S.mailLocale=MAIL_LOCALES.indexOf(j.mailLocale)>=0?j.mailLocale:'${DEFAULT_MAIL_LOCALE}';mailLocaleShow(S.mailLocale);});}
MAIL_LOCALES.forEach(function(c){$('ml-'+c).addEventListener('click',function(){var b=this;if(S.mailLocale===c){mailLocaleShow(c);return;}
  var was=S.mailLocale;mailLocaleShow(c);
  run(b,'ml-msg',function(){return api('PATCH','/api/me/preferences',{mailLocale:c}).then(function(j){S.mailLocale=(obj(j)&&MAIL_LOCALES.indexOf(j.mailLocale)>=0)?j.mailLocale:c;
    mailLocaleShow(S.mailLocale);say('ml-msg','메일 언어를 바꿨습니다.','ok');},function(e){if(was)mailLocaleShow(was);throw e;});});});});
radioKeys(ML_IDS);

/* ---------- boot ---------- */
/* boot: /api/me then the first agents page. A failure is a page state with the reason and "try again" (critique R7-03), not a banner over
   an empty frame; going back online retries by itself. A kept place (session expired on this screen) reopens once. */
function boot(){$('boot-err').hidden=true;d.body.classList.remove('boot-failed');$('boot-skel').hidden=false;$('main').setAttribute('aria-busy','true');
  return loadMe().then(function(){sideMe();placeBack();return loadAgents();}).then(function(){S.ready=true;$('main').removeAttribute('aria-busy');go();})
    .catch(function(e){$('main').removeAttribute('aria-busy');Object.keys(VIEW_IDS).forEach(function(k){$(VIEW_IDS[k]).hidden=true;});$('boot-skel').hidden=true;
      d.body.classList.add('boot-failed');txt('boot-err-t',human(e));$('boot-err-t').title=errMeta(e);$('boot-err').hidden=false;if(!S.ready)$('boot-retry').focus();});}
$('boot-retry').addEventListener('click',function(){boot();});
window.addEventListener('online',function(){if(!$('boot-err').hidden)boot();});
ivHint();
sideShow();
/* opened without a place (the login landing sends /app): once /api/me says which organization this is, go back to where the session ended */
var WANT_PLACE=(function(){var h=location.hash;return !h||h==='#'||h==='#/';})();
function placeBack(){var org=S.org&&typeof S.org.id==='string'?S.org.id:'';if(org)lsSet(ORG_KEY,org);var nx=takePlace(org);
  if(nx&&WANT_PLACE&&!S.ready){WANT_PLACE=false;try{history.replaceState(null,'',nx);}catch(e){}}}
go();
boot();
`;
