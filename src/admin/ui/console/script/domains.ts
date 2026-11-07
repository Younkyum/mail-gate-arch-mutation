/**
 * src/admin/ui/console/script/domains.ts — 앱 스크립트 조각: 도메인 화면(ADR-0014 단계 4 M4 · 2026-10-05 사이드바 1단 항목).
 *
 *   - 잠김: `GET /api/plan` 의 `features.customDomains` 가 거짓이면 목록 대신 "초대받은 조직에만 열린 베타" 상태 한 장(세션에 한 번 읽는다 —
 *     별칭 스위치 `features.addressAliases` 와 같은 요청). 그때는 `/api/domains` 를 부르지 않는다. 잠긴 조직의 `#/domains/{id}` 는 목록으로.
 *   - 목록 `#/domains` · 한 도메인 `#/domains/{id}`(DNS 레코드 표 · 레코드별 상태 · 지금 확인 60초 · 정지 배너 · 남은 시간 · 제거).
 *   - 레코드별 상태는 `DomainView.checks`(ownership · dkim · mailFrom · inboundMx — ok | pending | failed | not_checked). 없으면(옛 서버)
 *     같은 규칙으로 행의 칸(status · dkimStatus · mailFromStatus · inboundMxStatus)에서 접는다(`domChecks` — 서버 `domainChecksOf` 와 같은 표).
 *   - 다른 화면이 쓰는 `verifiedDomains()` — 에이전트 만들기 · 별칭 추가 대화상자의 도메인 고르기(확인이 끝난 도메인만).
 * 서버 값(도메인 · 레코드)은 전부 `textContent` 로만 그린다. 다른 조직의 존재는 어떤 문장도 말하지 않는다(`registrable_taken` 은 "남은 TXT 를
 * 지우세요" 로만). 스크립트는 ASCII 만 — 한국어는 문자열 안에만(`app.ts` 가 순서대로 잇는다, `SHELL_JS` 보다 앞).
 *   - 레코드 한 번에 넣기(2026-10-05): 표 위 `레코드 파일 받기`(BIND 존 파일 `<domain>.atmark-dns.txt` — `saveBlob`) · `모두 복사`(같은 글).
 *     글은 순수 함수 `buildZoneFile`(`../zonefile.ts` — 이 조각 앞에 붙여 싣는다)이 표와 같은 레코드로 만든다.
 *   - **한 번에 설정(2026-10 one-shot)**: 추가한 순간부터 레코드 전부(소유 TXT · 수신 MX · MAIL FROM MX · SPF · DKIM CNAME 셋)를 보인다. 서버가 DKIM
 *     토큰을 아직 못 받았으면(`recordsReady:false` — 즉시 실행이 `waiting`/`busy`) 서명 무리에 "레코드를 준비하고 있습니다…" 한 줄을 두고
 *     `PROVISION_POLL_INTERVAL_MS` 마다 상세를 조용히 다시 읽는다 — `PROVISION_POLL_MAX_MS` 가 지나면 "새로고침" 한 줄(누르면 다시 30초). 그동안
 *     파일 받기 · 모두 복사는 잠긴다(빠진 파일을 들고 가지 않게).
 *   - **Domain Connect**: 확인 전(pending · verifying)이고 레코드가 다 나왔고 admin 이면 `GET /api/domains/{id}/connect`(발견만 — 서명 · 감사 없음)를
 *     도메인마다 한 번 묻고, `supported` 일 때만 `{업체}로 연결` 단추 하나. **누르면** `POST …/connect` 가 서명 URL 을 발급하고(감사 · 조직 시간당 10 —
 *     429 면 "잠시 뒤 다시" 한 줄) https 일 때만 그리로 간다. 서브도메인에 다른 메일 서버가 있으면
 *     (`subdomain_has_mail` · MX `other` — 보안 리뷰 M3) 묻지 않고 단추 대신 한 줄. 서버는 409 `domain_connect_existing_mail` · 시간당 상한 429 · 발급마다 감사. 돌아오는 주소 `/app?dc=1&d=<id>` 는 부팅 전에
 *     읽어 `#/domains/<id>` 로 고치고(쿼리는 지운다 — `history.replaceState`), 그 도메인을 처음 읽을 때 `지금 확인` 을 한 번 부르고 알린다.
 *     업체가 `error=`(취소 · 거부)를 붙여 돌려보내면 확인을 부르지 않고 "직접 넣어도 된다" 고만 알린다.
 */

import { PROVISION_POLL_INTERVAL_MS, PROVISION_POLL_MAX_MS } from '../../../../domains/contract';
import { ZONEFILE_JS } from '../zonefile';

export const DOMAINS_JS = ZONEFILE_JS + String.raw`/* ---------- custom domains (ADR-0014 stage 4, M4) ---------- */
var DM={feat:null,list:null,item:null,seq:0,dseq:0,cool:{},tick:0,rm:'',poll:0,pollId:'',pollUntil:0,prepOver:{},dc:{},back:null};
var DM_POLL_MS=${String(PROVISION_POLL_INTERVAL_MS)},DM_POLL_MAX_MS=${String(PROVISION_POLL_MAX_MS)};
/* back from a DNS provider (Domain Connect redirect_uri /app?dc=1&d=<id>[&error=...]): read before the first route, rewrite the address to
   the domain's screen without the query (a reload must not check again), and remember it - loadDomain() checks once when that domain opens. */
DM.back=(function(){var q=String(location.search||'');if(!/[?&]dc=/.test(q))return null;var m=/[?&]d=([A-Za-z0-9-]{1,64})(?:&|$)/.exec(q);
  try{history.replaceState(null,'',location.pathname+(m?routeHref({view:'domains',domain:m[1]}):(location.hash||'')));}catch(e){}
  return m?{id:m[1],err:/[?&]error=/.test(q)}:null;})();
var DM_STATUS={pending:['확인 대기','wait'],verifying:['확인 중','wait'],verified:['사용 중','on'],suspended:['정지됨','bad'],removed:['제거됨','dim']};
var DM_SUSP={ownership_lost:'소유 확인 실패',dkim_failed:'서명 확인 실패',reputation:'발송 평판',operator:'운영자 정지',plan_limit:'요금제 한도'};
/* the name judge's reasons (src/domains/names.ts) are the 400 codes of POST /api/domains - their sentences live here, not in CODES
   (generic names like "empty" must not leak into other screens' errors). */
var DM_NAME={
  empty:'도메인을 적어 주세요.',
  too_long:'도메인은 100자까지입니다.',
  trailing_dot:'끝의 점(.)을 빼고 적어 주세요.',
  invalid_label:'도메인 모양이 아닙니다. 영문 소문자 · 숫자 · 하이픈과 점만 씁니다(예: agents.example.com).',
  idn_label:'국제화 도메인(xn--)은 아직 쓸 수 없습니다. 영문 도메인을 적어 주세요.',
  ip_address:'IP 주소는 쓸 수 없습니다. 도메인 이름을 적어 주세요.',
  single_label:'점(.)이 들어간 전체 도메인을 적어 주세요(예: agents.example.com).',
  public_suffix:'공용 접미사(예: co.kr)는 쓸 수 없습니다. 내가 가진 도메인 아래의 서브도메인을 적어 주세요.',
  registrable_apex:'에이전트 전용 서브도메인을 쓰세요(예: agents.example.com). 최상위 도메인에는 사람이 받는 메일이 있을 수 있어 연결하지 않습니다.',
  platform_domain:'atmark.ai 도메인은 추가할 수 없습니다.',
  shared_mailbox_domain:'공용 메일 서비스의 도메인은 쓸 수 없습니다. 회사 도메인을 적어 주세요.'
};
var DM_FIELD={domain_exists:1,domain_unavailable:1,invalid_domain:1};
/* featRaw rejects when /api/plan fails (the domains screen must tell "failed" from "off"); features() is the forgiving form the dialogs
   use (a failed read = no extras). A failed read is not cached: the next call asks again. */
function featRaw(){if(DM.feat)return DM.feat;
  var p=S.plan&&obj(S.plan.features)?Promise.resolve(S.plan):api('GET','/api/plan');
  DM.feat=p.then(function(j){return obj(j)&&obj(j.features)?j.features:{};},function(e){DM.feat=null;throw e;});
  return DM.feat;}
function features(){return featRaw().catch(function(){return {};});}
function domainsOn(){return features().then(function(f){return f.customDomains===true;});}
function domItems(j){return arr(j&&j.items).filter(function(x){return obj(x)&&typeof x.id==='string'&&typeof x.domain==='string';});}
function loadDomains(){return api('GET','/api/domains').then(function(j){j=obj(j)?j:{};
  DM.list={enabled:j.enabled===true,limit:num(j.limit),live:num(j.live),items:domItems(j)};return DM.list;});}
/* verified customer domains for the create / alias dialogs: [] when the menu is off or the read fails (the dialogs then offer atmark.ai only). */
function verifiedDomains(){return domainsOn().then(function(on){if(!on)return [];
  return loadDomains().then(function(l){return l.items.filter(function(x){return x.status==='verified';}).map(function(x){return clean(x.domain,100);});});})
  .catch(function(){return [];});}
function domPill(x){var st=DM_STATUS[x.status]||[str(x.status,20),'dim'],t=st[0];
  if(x.status==='suspended'&&DM_SUSP[x.suspendedReason])t+=' · '+DM_SUSP[x.suspendedReason];return [t,st[1]];}
function domReady(x){return x.status==='verified'&&x.mailFromStatus==='success'&&x.inboundMxStatus==='ses'&&x.dkimStatus==='success';}
/* one quiet second line under the name in the list: what the domain is waiting for, or that it is ready. */
function domSub(x){if(x.status==='pending')return x.pendingReason==='subdomain_has_mail'?'다른 메일 서버가 있습니다':x.pendingReason==='registrable_taken'?'남은 확인 레코드를 지워야 합니다':'DNS 레코드를 기다립니다';
  if(x.status==='verifying')return '서명 레코드를 확인하고 있습니다';
  if(x.status==='verified')return domReady(x)?'수신 · 발신 준비됨':'';
  if(x.status==='removed')return x.removedAt?fmt('{t}에 제거',{t:kstDate(x.removedAt)}):'';
  return '';}
function domHref(x){return routeHref({view:'domains',domain:x.id});}
/* the sidebar item is always there (a main tab, 2026-10-05). An org without the feature sees one calm "beta, invite-only" state instead
   of the list, and /api/domains is never called; its #/domains/{id} goes to the list. Until /api/plan answers the list keeps its skeleton. */
function domLocked(on){$('dm-locked').hidden=on;$('dm-list-b').hidden=!on;if(!on){$('dm-add').hidden=true;txt('dm-count','');}}
function showDomainsView(r,prev){var first=prev.view!=='domains';say('dm-msg','');
  return featRaw().then(function(f){if(S.route!==r)return;var on=f.customDomains===true;domLocked(on);
    if(!on){$('dm-list-w').hidden=false;$('dm-detail').hidden=true;if(r.domain)location.hash=routeHref({view:'domains'});return;}
    return showDomains(r,first);},
  /* the feature read failed: neither "locked" nor a redirect - the section's error line (and the address stays, so a reload retries) */
  function(e){if(S.route!==r)return;$('dm-locked').hidden=true;$('dm-list-b').hidden=false;$('dm-list-w').hidden=false;$('dm-detail').hidden=true;
    $('dm-add').hidden=true;txt('dm-count','');clear($('dm-body'));$('dm-tbl').hidden=true;$('dm-empty').hidden=true;sectionErr('dm-msg')(e);});}
function showDomains(r,first){var one=!!r.domain;$('dm-list-w').hidden=one;$('dm-detail').hidden=!one;
  if(!one){DM.item=null;coolStop();pollStop();if(DM.list)renderDomains();if(first||!DM.list)return loadDomains().then(renderDomains).catch(sectionErr('dm-msg'));return Promise.resolve();}
  return loadDomain(r.domain);}
function renderDomains(){var L=DM.list,tb=$('dm-body');if(!L)return;clear(tb);
  var live=L.items.filter(function(x){return x.status!=='removed';}),gone=L.items.filter(function(x){return x.status==='removed';}),all=live.concat(gone);
  txt('dm-count',grp(L.live)+' / '+grp(L.limit));
  var admin=can('admin'),full=L.live>=L.limit;
  var b=$('dm-add');b.hidden=!L.enabled;b.disabled=!admin||full;b.title=!admin?ROLE_WHY.admin:full?CODES.plan_custom_domains_exceeded:'';
  $('dm-off').hidden=L.enabled;$('dm-empty').hidden=all.length>0;$('dm-tbl').hidden=all.length===0;
  all.forEach(function(x){var tr=el('tr','rl'+(x.status==='removed'?' gone':'')),c=cell(tr,'도메인'),w=el('span','nmt');
    w.appendChild(link(clean(x.domain,100),domHref(x),'strong addr'));var sub=domSub(x);if(sub)w.appendChild(el('span','sub',sub));c.appendChild(w);
    var p=domPill(x);cell(tr,'상태','status').appendChild(pillEl(p[0],p[1]));
    var dc=cell(tr,'만든 날');dc.className='cv num';dc.textContent=fmtDate(x.createdAt);dc.title=kst(x.createdAt);
    tr.addEventListener('click',function(ev){if(ev&&ev.target&&ev.target.tagName==='A')return;location.hash=domHref(x);});
    tb.appendChild(tr);});}
/* ---------- one domain ---------- */
function loadDomain(id){var seq=++DM.dseq;say('dd-msg','');
  if(!DM.item||DM.item.id!==id){DM.item=null;coolStop();pollStop();txt('dd-name','');pill('dd-pill','','');$('dd-steps').hidden=true;$('dd-dz').hidden=true;$('dd-alert').hidden=true;$('dd-ready').hidden=true;}
  else renderDomain();
  return api('GET','/api/domains/'+enc(id)).then(function(j){if(seq!==DM.dseq)return;var it=obj(j)&&obj(j.item)?j.item:null;
    if(!it||typeof it.id!=='string'){say('dd-msg',CODES.domain_not_found,'err');return;}DM.item=it;renderDomain();
    if(DM.back&&DM.back.id===it.id){var back=DM.back;DM.back=null;dcReturned(it,back);}},
    function(e){if(seq!==DM.dseq)return;sectionErr('dd-msg')(e);});}
/* "2 days 5 hours" / "5 hours" / "40 minutes" until iso (never negative). */
function leftOf(iso,now){var t=new Date(iso).getTime();if(!iso||isNaN(t))return '—';var m=Math.max(0,Math.floor((t-now)/60000)),dd=Math.floor(m/1440),h=Math.floor(m%1440/60);
  if(dd>0)return h>0?fmt('{d}일 {h}시간',{d:dd,h:h}):fmt('{d}일',{d:dd});if(h>0)return fmt('{h}시간',{h:h});return fmt('{m}분',{m:Math.max(1,m%60)});}
function nextOf(iso,now){var t=new Date(iso).getTime();if(!iso||isNaN(t))return '—';return t-now<60000?'곧':kstShort(iso);}
/* the zone a DNS provider usually appends is the registrable domain: what is left in front is what goes into the "name" box. */
function relName(name,zone){if(!zone||name===zone)return '@';var tail='.'+zone;return name.length>tail.length&&name.slice(-tail.length)===tail?name.slice(0,-tail.length):name;}
/* per-record state. checks (server, 2026-10) wins; an older server's row is folded the same way as the server's domainChecksOf. */
var DM_CHECK={ok:['확인됨','on'],pending:['대기 중','wait'],failed:['실패','bad rsfail'],not_checked:['확인 전','dim']};
/* a recommended record (required:false - DMARC) is never checked: no state, just the word (no new DNS lookups for it) */
var DM_REC=['권장','tag'];
var DM_SES={success:'ok',failed:'failed',temporary_failure:'failed',pending:'pending',not_started:'not_checked',unknown:'not_checked'};
var DM_MX={ses:'ok',other:'failed',missing:'pending',unknown:'not_checked'};
var DM_CHECK_KEYS=['ownership','dkim','mailFrom','inboundMx'];
function domChecks(x){var c=obj(x.checks)?x.checks:{},st=x.status,out={},fb;
  if(st==='removed')fb={ownership:'not_checked',dkim:'not_checked',mailFrom:'not_checked',inboundMx:'not_checked'};
  else fb={ownership:st==='suspended'&&x.suspendedReason==='ownership_lost'?'failed':st==='verified'||st==='verifying'||st==='suspended'?'ok':'pending',
    dkim:DM_SES[x.dkimStatus]||'not_checked',mailFrom:DM_SES[x.mailFromStatus]||'not_checked',inboundMx:DM_MX[x.inboundMxStatus]||'not_checked'};
  DM_CHECK_KEYS.forEach(function(k){out[k]=Object.prototype.hasOwnProperty.call(DM_CHECK,c[k])?c[k]:fb[k];});return out;}
/* the table, in the order a person adds them: ownership TXT, inbound MX, MAIL FROM MX + SPF TXT, DKIM CNAME x3, then DMARC TXT (recommended). */
var DM_GROUPS=[['소유 확인',['ownership']],['메일 받기',['inbound_mx']],['반송 주소(MAIL FROM)',['mail_from_mx','mail_from_spf']],['서명(DKIM)',['dkim']],['DMARC(권장)',['dmarc']]];
var DM_CHECK_OF={ownership:'ownership',inbound_mx:'inboundMx',mail_from_mx:'mailFrom',mail_from_spf:'mailFrom',dkim:'dkim'};
var DM_COLS=['형식','이름','콘텐츠','우선순위','TTL','프록시 상태','상태'];
function recCopy(td,value,label,cls){var w=el('div','dvw'),c=el('code','dv'+(cls?' '+cls:''),value),b=el('button','icon-btn dcp');b.type='button';
  b.setAttribute('aria-label',label);b.title=label;b.appendChild(ico('copy'));b.addEventListener('click',function(){copy(value,b,function(){selectText(c);});});
  w.appendChild(c);w.appendChild(b);td.appendChild(w);return w;}
function recTd(tr,k,i){var td=el('td','dk-'+k);td.setAttribute('data-label',DM_COLS[i]);tr.appendChild(td);return td;}
function recRow(r,zone,state){var tr=el('tr','drr'),name=clean(r.name,260),val=clean(r.value,300),type=str(r.type,8),mx=type==='MX'?/^(\d+) (\S+)$/.exec(val):null;
  recTd(tr,'type',0).appendChild(el('span','cap',type));
  var n=recTd(tr,'name',1),rel=relName(name,clean(zone,100));recCopy(n,rel,'이름 복사','rel');if(rel!==name)n.appendChild(el('span','dfq',name));
  recCopy(recTd(tr,'val',2),mx?mx[2]:val,'콘텐츠 복사');
  recTd(tr,'prio',3).textContent=mx?mx[1]:'—';
  recTd(tr,'ttl',4).textContent='자동';
  /* proxy: plain text (the provider's own word); a ! only when a CNAME failed its check - a proxied CNAME is the usual cause */
  recTd(tr,'proxy',5).appendChild(type==='CNAME'&&state==='failed'?pillEl('DNS 전용으로 바꾸세요','warn'):el('span','dpx','DNS 전용'));
  var s=r.required===false?DM_REC:DM_CHECK[state]||DM_CHECK.not_checked;recTd(tr,'st',6).appendChild(pillEl(s[0],s[1]));
  tr.setAttribute('data-purpose',str(r.purpose,20));return tr;}
/* every record is there from the start (one-shot); only the three DKIM CNAMEs wait for SES - for a few seconds, rarely minutes. */
function recReady(x){if(x.recordsReady===true)return true;if(x.recordsReady===false)return false;
  return arr(x.records).filter(function(r){return obj(r)&&r.purpose==='dkim';}).length>=3;}
function prepping(x){return !!x&&(x.status==='pending'||x.status==='verifying')&&!recReady(x);}
function prepRow(x){var w=el('tr','dprep'),t=el('td');t.appendChild(el('span','cap','CNAME'));w.appendChild(t);
  var d=el('td');d.colSpan=6;w.appendChild(d);
  if(!DM.prepOver[x.id]){d.appendChild(el('span','dprep-t','레코드를 준비하고 있습니다…'));return w;}
  d.appendChild(el('span','dprep-t over','레코드가 아직 준비되지 않았습니다. 잠시 뒤 새로고침하세요.'));
  var b=el('button','btn sm ghost dprep-b','새로고침');b.type='button';b.id='dd-prep-retry';
  b.addEventListener('click',function(){var it=DM.item;if(!it)return;delete DM.prepOver[it.id];DM.pollId='';loadDomain(it.id);});
  d.appendChild(b);return w;}
function renderRecords(x){var recs=arr(x.records).filter(obj),zone=x.registrableDomain,tb=$('dd-recs'),ck=domChecks(x);clear(tb);
  DM_GROUPS.forEach(function(g){var rows=[];g[1].forEach(function(p){recs.forEach(function(r){if(r.purpose===p)rows.push(r);});});
    var gr=el('tr','dgrp'),th=el('th',null,g[0]);th.setAttribute('scope','rowgroup');th.colSpan=7;gr.appendChild(th);tb.appendChild(gr);
    rows.forEach(function(r){tb.appendChild(recRow(r,zone,ck[DM_CHECK_OF[r.purpose]]));});
    if(!rows.length&&g[1][0]==='dkim'&&prepping(x))tb.appendChild(prepRow(x));});}
/* ---------- records not ready yet: re-read the detail quietly every DM_POLL_MS for DM_POLL_MAX_MS, then offer "refresh" ---------- */
function pollStop(){if(DM.poll)clearTimeout(DM.poll);DM.poll=0;}
function pollStart(x){if(!prepping(x)||$('dm-detail').hidden){pollStop();return;}if(DM.prepOver[x.id])return;
  if(DM.pollId!==x.id){DM.pollId=x.id;DM.pollUntil=Date.now()+DM_POLL_MAX_MS;}
  if(!DM.poll)DM.poll=setTimeout(pollStep,DM_POLL_MS);}
function pollStep(){DM.poll=0;var x=DM.item,id=DM.pollId;if(!x||x.id!==id||$('dm-detail').hidden)return;
  if(Date.now()>=DM.pollUntil){DM.prepOver[id]=true;renderDomain();return;}
  api('GET','/api/domains/'+enc(id)).then(function(j){var it=obj(j)&&obj(j.item)?j.item:null;if(!DM.item||DM.item.id!==id)return;
    if(it&&it.id===id)DM.item=it;renderDomain();},
    function(){if(DM.item&&DM.item.id===id)pollStart(DM.item);});}
var SUPPORT='support@atmark.ai';
/* the alert above the steps: [title, what to do, extra line] or null. Never names another organization. */
function domAlert(x){var now=Date.now(),apex=clean(x.registrableDomain,100);
  if(x.status==='removed')return ['제거된 도메인입니다','이 도메인으로는 메일을 보내거나 받지 않습니다. 다시 쓰려면 도메인을 새로 추가하세요.',''];
  if(x.status==='suspended'){var r=x.suspendedReason;
    if(r==='ownership_lost')return ['소유 확인 레코드가 사라졌습니다','아래 _atmark-challenge TXT 레코드를 값 그대로 다시 넣으면 저절로 복구됩니다. 그동안 이 도메인으로는 메일을 보내거나 받지 않습니다.',x.removalDueAt?fmt('{t}까지 복구되지 않으면 도메인이 제거되고, 이 도메인의 주소도 폐기됩니다.',{t:kst(x.removalDueAt)}):''];
    if(r==='dkim_failed')return ['서명(DKIM) 레코드를 확인할 수 없습니다','아래 CNAME 레코드 3개가 값 그대로 있는지 확인하세요. 고치면 저절로 복구됩니다. 그동안 이 도메인으로는 메일을 보내거나 받지 않습니다.',''];
    if(r==='reputation')return ['반송이나 스팸 신고가 많아 보내기를 멈췄습니다','받는 메일은 계속 받습니다. 다시 보내려면 지원팀에 문의하세요.',fmt('문의: {s}',{s:SUPPORT})];
    if(r==='operator')return ['Atmark 운영자가 이 도메인의 보내기를 멈췄습니다','받는 메일은 계속 받습니다. 자세한 내용은 지원팀에 문의하세요.',fmt('문의: {s}',{s:SUPPORT})];
    if(r==='plan_limit')return ['요금제의 도메인 한도를 넘어 보내기를 멈췄습니다','받는 메일은 계속 받습니다. 요금제를 올리거나 다른 도메인을 제거하면 저절로 다시 열립니다.',''];
    return ['정지된 도메인입니다','지원팀에 문의하세요.',fmt('문의: {s}',{s:SUPPORT})];}
  if(x.status==='pending'&&x.pendingReason==='subdomain_has_mail')return ['이 서브도메인에는 이미 다른 메일 서버가 있습니다','사람이 메일을 받는 서브도메인은 연결할 수 없습니다. 에이전트만 쓸 새 서브도메인을 추가하거나, 이 서브도메인의 MX 레코드를 아래 값으로 바꾸세요.',''];
  if(x.status==='pending'&&x.pendingReason==='registrable_taken')return ['이 도메인은 아직 확인할 수 없습니다',fmt('{a} 아래에 남아 있는 다른 _atmark-challenge TXT 레코드를 지운 뒤 지금 확인을 누르세요. 그래도 안 되면 지원팀에 문의하세요.',{a:apex}),fmt('문의: {s}',{s:SUPPORT})];
  if((x.status==='pending'||x.status==='verifying')&&x.expiresAt){var left=new Date(x.expiresAt).getTime()-now;
    if(left<24*3600000)return [fmt('{t} 안에 확인이 끝나지 않으면 도메인이 지워집니다',{t:leftOf(x.expiresAt,now)}),'아래 레코드를 넣었는지 확인하고 지금 확인을 누르세요. 지워지면 다시 추가할 수 있습니다.',''];}
  return null;}
function renderDomain(){var x=DM.item;if(!x)return;var now=Date.now(),gone=x.status==='removed';
  txt('dd-name',clean(x.domain,100));var p=domPill(x);pill('dd-pill',p[0],p[1]);$('dd-ready').hidden=!domReady(x);
  txt('dd-created',kstDate(x.createdAt));
  var lc=$('dd-last');lc.textContent=x.lastCheckedAt?fmtDateTime(x.lastCheckedAt,now):EMPTY;lc.title=x.lastCheckedAt?kst(x.lastCheckedAt):'아직 확인하지 않았습니다';
  $('dd-next-w').hidden=!x.nextCheckAt;var nc=$('dd-next');nc.textContent=x.nextCheckAt?nextOf(x.nextCheckAt,now):'—';nc.title=x.nextCheckAt?kst(x.nextCheckAt):'';
  $('dd-left-w').hidden=!x.expiresAt;var lf=$('dd-left');lf.textContent=x.expiresAt?leftOf(x.expiresAt,now):'—';lf.title=x.expiresAt?kst(x.expiresAt):'';
  $('dd-due-w').hidden=!x.removalDueAt;txt('dd-due',x.removalDueAt?kst(x.removalDueAt):'—');
  var a=domAlert(x),box=$('dd-alert');box.hidden=!a;box.classList.toggle('neutral',gone);
  if(a){txt('dd-alert-t',a[0]);txt('dd-alert-d',a[1]);$('dd-alert-a').hidden=!a[2];txt('dd-alert-a',a[2]||'');}
  $('dd-steps').hidden=gone;if(!gone)renderRecords(x);
  /* a file without the DKIM lines would be imported and forgotten: the two buttons wait until every record is there */
  var full=!gone&&recReady(x);$('dd-zone-dl').disabled=!full;$('dd-zone-cp').disabled=!full;
  $('dd-check').hidden=gone;$('dd-dz').hidden=gone;
  gate($('dd-remove'),'admin');coolStart();pollStart(x);dcShow(x);}
/* ---------- Domain Connect: one button, one consent at the DNS provider (only when the server signs a URL for this domain) ---------- */
/* a subdomain that already receives mail elsewhere (security review M3): the template's MX would replace it - no button, one line instead.
   The server refuses too (409 domain_connect_existing_mail); the console does not even ask. */
function dcMail(x){return !!x&&(x.status==='pending'||x.status==='verifying')&&(x.pendingReason==='subdomain_has_mail'||x.inboundMxStatus==='other');}
function dcWanted(x){return !!x&&(x.status==='pending'||x.status==='verifying')&&recReady(x)&&can('admin')&&!dcMail(x);}
function dcShow(x){var b=$('dd-dc'),c=dcWanted(x)?DM.dc[x.id]:null;b.hidden=!(c&&c.supported);$('dd-dc-mail').hidden=!(dcMail(x)&&can('admin'));
  if(c&&c.supported)txt('dd-dc-t',fmt('{p}로 연결',{p:c.name}));
  /* opening the screen only asks whether to show the button (discovery - no signature, no audit, no count) */
  if(dcWanted(x)&&!c){DM.dc[x.id]={supported:false,pending:true};var id=x.id;
    api('GET','/api/domains/'+enc(id)+'/connect').then(function(j){var ok=obj(j)&&j.supported===true;
      DM.dc[id]=ok?{supported:true,name:clean(j.providerName,40)||'DNS'}:{supported:false};
      if(DM.item&&DM.item.id===id)dcShow(DM.item);},
      /* 409 existing mail: the line instead of the button (the row changed since it was read) · anything else: no button */
      function(e){DM.dc[id]={supported:false,mail:e instanceof ApiError&&e.code==='domain_connect_existing_mail'};
        if(DM.dc[id].mail&&DM.item&&DM.item.id===id)$('dd-dc-mail').hidden=false;});}}
/* the press issues the signed URL (POST - audited, 10 an hour per organization); only an https URL is followed */
$('dd-dc').addEventListener('click',function(){var x=DM.item,c=x?DM.dc[x.id]:null,b=this;if(!c||!c.supported||!dcWanted(x))return;var id=x.id;
  run(b,'dd-msg',function(){return api('POST','/api/domains/'+enc(id)+'/connect',{}).then(function(j){
      if(obj(j)&&j.supported===true&&typeof j.applyUrl==='string'&&/^https:\/\/[^\s"<>]+$/.test(j.applyUrl)){location.href=j.applyUrl;return;}
      DM.dc[id]={supported:false};if(DM.item&&DM.item.id===id)dcShow(DM.item);
      say('dd-msg','지금은 자동 입력을 쓸 수 없습니다. 아래 레코드를 직접 넣으세요.','err');},
    function(e){if(e instanceof ApiError&&e.status===429){say('dd-msg','자동 입력을 너무 자주 눌렀습니다. 잠시 뒤 다시 시도하세요.','err');return;}
      if(e instanceof ApiError&&e.code==='domain_connect_existing_mail'){DM.dc[id]={supported:false,mail:true};$('dd-dc').hidden=true;$('dd-dc-mail').hidden=false;return;}
      throw e;});});});
/* back from the provider: one check (the records are probably all there now), the 60 s cooldown, and a toast. A cancel only says so. */
function dcReturned(x,back){if(back.err){toast('DNS 업체에서 연결을 마치지 않았습니다. 아래 레코드를 직접 넣어도 됩니다.');return;}
  if(!can('admin')||x.status==='removed')return;var id=x.id;
  api('POST','/api/domains/'+enc(id)+'/check',{}).then(function(){DM.cool[id]=Date.now()+60000;toast('DNS 업체에서 레코드를 넣었습니다. 확인을 시작했습니다.');},
    function(e){if(e instanceof ApiError&&e.code==='domain_check_rate_limited')DM.cool[id]=Date.now()+60000;toast('DNS 업체에서 돌아왔습니다. 잠시 뒤 지금 확인을 누르세요.');})
    .then(function(){if(DM.item&&DM.item.id===id)coolStart();});}
/* ---------- all records at once: the same BIND text the table shows, as a file or on the clipboard ---------- */
function domZone(){var x=DM.item;return x?buildZoneFile(clean(x.domain,100),arr(x.records).filter(obj),Date.now()):'';}
$('dd-zone-dl').addEventListener('click',function(){var x=DM.item;if(!x||x.status==='removed'||!recReady(x))return;var name=zoneFileName(clean(x.domain,100));
  saveBlob(new Blob([domZone()],{type:'text/plain;charset=utf-8'}),name);toast(fmt('내려받았습니다: {f}',{f:name}));});
function zoneCopyFail(){toast('복사하지 못했습니다. 레코드 파일을 받아 쓰세요.');}
$('dd-zone-cp').addEventListener('click',function(){var x=DM.item;if(!x||x.status==='removed'||!recReady(x))return;var z=domZone();
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(z).then(function(){toast('복사했습니다.');},zoneCopyFail);
  else zoneCopyFail();});
/* ---------- check now: 202, then 60 s on the same domain (the server's own rule); the countdown is shown beside the button ---------- */
function coolLeft(){var x=DM.item;return x?Math.ceil(((DM.cool[x.id]||0)-Date.now())/1000):0;}
function coolPaint(){var b=$('dd-check'),n=coolLeft();
  if($('dm-detail').hidden||!DM.item||n<=0){coolStop();b.disabled=!can('admin');if(!can('admin'))b.title=ROLE_WHY.admin;else b.title='';return;}
  b.disabled=true;b.title='';txt('dd-cool',fmt('{n}초 뒤 다시 확인할 수 있습니다',{n:n}));}
function coolStart(){coolStop();coolPaint();if(coolLeft()>0)DM.tick=setTimeout(coolStep,1000);}
function coolStep(){if(!DM.tick)return;DM.tick=0;coolPaint();if(coolLeft()>0&&!$('dm-detail').hidden)DM.tick=setTimeout(coolStep,1000);}
function coolStop(){if(DM.tick)clearTimeout(DM.tick);DM.tick=0;txt('dd-cool','');}
$('dd-check').addEventListener('click',function(){var x=DM.item,b=this;if(!x||!can('admin'))return;var id=x.id;
  run(b,'dd-msg',function(){return api('POST','/api/domains/'+enc(id)+'/check',{}).then(function(){DM.cool[id]=Date.now()+60000;
      say('dd-msg','확인을 요청했습니다. 몇 분 안에 결과가 이 화면에 반영됩니다.','ok');},
    function(e){if(e instanceof ApiError&&e.code==='domain_check_rate_limited'&&!DM.cool[id])DM.cool[id]=Date.now()+60000;throw e;});})
  .then(function(){if(DM.item&&DM.item.id===id)coolStart();});});
/* ---------- add ---------- */
function domAddOpen(){var b=$('dm-add');if(!can('admin')||b.disabled||b.hidden)return;var L=DM.list,inp=$('dad-name');inp.value='';fieldErr(inp,'');say('dad-msg','');
  txt('dad-n',L?grp(L.live)+' / '+grp(L.limit):'—');$('dlg-domadd').showModal();inp.focus();}
$('dm-add').addEventListener('click',domAddOpen);
dlgBind('dlg-domadd','dad-go','dad-cancel');
$('dad-form').addEventListener('submit',function(ev){ev.preventDefault();var inp=$('dad-name'),v=inp.value.trim().toLowerCase();fieldErr(inp,'');say('dad-msg','');
  if(!v){fieldErr(inp,DM_NAME.empty);return;}
  if(/[\s@\/:]/.test(v)){fieldErr(inp,'도메인 이름만 적어 주세요(예: agents.example.com).');return;}
  run($('dad-go'),'dad-msg',function(){return api('POST','/api/domains',{domain:v}).then(function(j){var it=obj(j)&&obj(j.item)?j.item:null;
    $('dlg-domadd').close();DM.list=null;toast('도메인을 추가했습니다. 아래 레코드를 모두 DNS 공급자에 넣으세요.');
    if(it&&typeof it.id==='string'){DM.item=it;location.hash=domHref(it);}else location.hash=routeHref({view:'domains'});},
    function(e){if(e instanceof ApiError&&(DM_NAME[e.code]||DM_FIELD[e.code])){fieldErr(inp,DM_NAME[e.code]||human(e));return;}throw e;});});});
/* ---------- remove (danger): counts from the detail read; addresses stay unless the box is ticked ---------- */
function domRemoveOpen(){var x=DM.item;if(!x||!can('admin'))return;DM.rm=x.id;txt('dr-name',clean(x.domain,100));
  var pa=num(x.primaryAgents),la=num(x.liveAddresses);
  $('dr-primary').hidden=pa<=0;txt('dr-primary-t',fmt('에이전트 {n}개가 이 도메인 주소를 대표 주소로 씁니다.',{n:grp(pa)}));
  $('dr-release-w').hidden=la<=0;$('dr-release').checked=false;txt('dr-release-t',fmt('이 도메인의 주소 {n}개도 함께 폐기합니다',{n:grp(la)}));
  say('dr-msg','');$('dlg-domrm').showModal();$('dr-cancel').focus();}
$('dd-remove').addEventListener('click',domRemoveOpen);
dlgBind('dlg-domrm','dr-go','dr-cancel');
$('dr-form').addEventListener('submit',function(ev){ev.preventDefault();var id=DM.rm;if(!id)return;
  run($('dr-go'),'dr-msg',function(){return api('DELETE','/api/domains/'+enc(id),{releaseAddresses:$('dr-release').checked===true}).then(function(j){
    $('dlg-domrm').close();DM.list=null;DM.item=null;var pa=num(j&&j.primaryAgents);
    location.hash=routeHref({view:'domains'});
    say('dm-msg',pa>0?fmt('도메인을 제거했습니다. 에이전트 {n}개는 이제 대표 주소가 없습니다.',{n:grp(pa)}):'도메인을 제거했습니다.','ok');
    return refreshAgents();});});});
`;
