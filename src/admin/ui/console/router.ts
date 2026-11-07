/**
 * src/admin/ui/console/router.ts — 콘솔 라우터 · 시각 조각. 순수 함수(DOM 없음)라 앱 스크립트가 그대로 싣고, 테스트가 vm 으로 돌린다.
 *
 * v4 라우트 표(`console-v4-design.md` §2.3):
 *   조직 스코프  `#/overview` · `#/agents` · `#/domains[/{id}]` · `#/logs[/{type}[/{entry}]]` · `#/settings[/{section}]`(사이드바 1단 항목 — 비평 R10-11)
 *   에이전트 스코프  `#/agents/{id}` · `/connect` · `/email[/{outbound|inbound}]` · `/addresses` · `/webhooks` · `/logs[/{type}[/{entry}]]` · `/identity` · `/tokens`
 *   (`/addresses` — 대표 주소 + 별칭, 2026-09-29 이메일 화면에서 뺀 탭 · `/webhooks` — 엔드포인트 + 전달 기록, 2026-09-30)
 * v3 경로는 **리다이렉트**한다 — `parseRoute` 가 새 경로 모양에 `redirect:true` 를 붙여 돌려주고, 앱이 `history.replaceState` 로 주소를
 * 고친다(한 번): `/outbound` → `/email/outbound` · `/inbound` → `/email/inbound` · `/danger` → 개요(`scroll:'danger'` — 정지 행으로 스크롤) ·
 * `#/identity` → `#/agents`. 모르는 경로는 개요(`unknown:true`, 주소는 그대로 — v3 와 같다).
 * 예약: `#/o/{orgId}/…` — 다중 조직의 정규 경로 자리. 지금은 나머지를 해석해 `org` 를 붙여 돌려주고, 앱이 현재 조직과 비교한다
 * (같으면 주소를 고치고, 멤버십에 있는 다른 조직이면 배너 + `이 조직으로 전환` 버튼 — 자동 전환은 하지 않는다).
 * P0/P1(`extensibility-p0-p1.md` §4): 조직 고르기 `#/select-org`(로그인 착지가 `next:'select-org'` 일 때) · 설정 섹션 `members`·`keys`.
 * 고객 도메인(ADR-0014 M4): 사이드바 1단 항목 `#/domains` · 한 도메인 `#/domains/{id}`(2026-10-05 진윤겸 — 설정 섹션에서 꺼냈다).
 *   예전 경로 `#/settings/domains[/{id}]`(알림 메일 · 북마크)은 새 경로로 **리다이렉트**한다.
 * 설정(2026-09-27 — 섹션마다 한 화면): `#/settings/{section}` 이 그 섹션 하나만 보인다. `#/settings` 와 모르는 섹션(`#/settings/x` ·
 * `#/settings/org/x`)은 첫 섹션 `#/settings/org` 로 **리다이렉트**한다(`redirect:true` → `history.replaceState` — 주소만 고친다).
 * 채널: 새 채널은 `CHANNELS` 배열 + `CHANNEL_SUB` 한 줄 + 화면 모듈 하나(§R-5).
 * 감시(2026-10-08 — 사이드바 1단 항목, 개요 · 에이전트 · 도메인 · **감시** · 로그 · 설정): `#/watch/{section}` 이 그 섹션 하나만 보인다(설정과 같은 모양).
 *   `#/watch` 와 모르는 섹션은 첫 섹션 `#/watch/held` 로 **리다이렉트**. 예전 `#/settings/aiwatch`(AI 의심 메일 감시)는 `#/watch/ai` 로 리다이렉트한다.
 */

export const ROUTER_JS = String.raw`var VIEWS_TOP=['overview','agents','domains','watch','settings','logs','select-org'];
var SETTINGS_SECTIONS=['org','members','keys','plan','pause','tlog','gate','display','mail','session'];
var WATCH_SECTIONS=['held','trusted','ai','agents','signups','enroll'];
var CHANNELS=['email'];
var TABS=['overview','connect'].concat(CHANNELS,['addresses','webhooks','logs','identity','tokens']);
var CHANNEL_SUB={email:['outbound','inbound']};
var OLD_TABS={outbound:['email','outbound'],inbound:['email','inbound'],danger:['overview',null]};
var LOGT=['outbound','inbound','console','scheduled'];
function rdec(s){try{return decodeURIComponent(s);}catch(e){return null;}}
function parseParts(p){
  var unknown={view:'overview',unknown:true};
  if(!p.length)return {view:'overview'};
  var top=p[0];
  if(top==='agents'){
    if(p.length===1)return {view:'agents'};
    var r={view:'agent',agent:p[1],tab:'overview'};
    if(p.length===2)return r;
    var t=p[2];
    if(Object.prototype.hasOwnProperty.call(OLD_TABS,t)){
      if(p.length!==3)return unknown;
      r.tab=OLD_TABS[t][0];if(OLD_TABS[t][1])r.sub=OLD_TABS[t][1];if(t==='danger')r.scroll='danger';r.redirect=true;return r;}
    if(TABS.indexOf(t)<0)return unknown;
    r.tab=t;
    if(CHANNEL_SUB[t]){if(p.length===3)return r;if(p.length===4&&CHANNEL_SUB[t].indexOf(p[3])>=0){r.sub=p[3];return r;}return unknown;}
    if(t!=='logs')return p.length===3?r:unknown;
    r.log='outbound';
    if(p.length>=4){if(LOGT.indexOf(p[3])<0)return unknown;r.log=p[3];}
    if(p.length>=5)r.entry=p[4];
    return p.length<=5?r:unknown;
  }
  if(top==='logs'){
    var l={view:'logs',log:'outbound'};
    if(p.length>=2){if(LOGT.indexOf(p[1])<0)return unknown;l.log=p[1];}
    if(p.length>=3)l.entry=p[2];
    return p.length<=3?l:unknown;
  }
  if(top==='domains'){
    if(p.length===1)return {view:'domains'};
    return p.length===2?{view:'domains',domain:p[1]}:unknown;
  }
  if(top==='watch'){
    if(p.length===2&&WATCH_SECTIONS.indexOf(p[1])>=0)return {view:'watch',section:p[1]};
    return {view:'watch',section:WATCH_SECTIONS[0],redirect:true};
  }
  if(top==='settings'){
    if(p.length===2&&SETTINGS_SECTIONS.indexOf(p[1])>=0)return {view:'settings',section:p[1]};
    /* the AI suspicious-mail watch moved from settings to the watch tab (2026-10-08): old links land on its new screen */
    if(p[1]==='aiwatch'&&p.length===2)return {view:'watch',section:'ai',redirect:true};
    /* domains moved out of settings to a sidebar item (2026-10-05): old links (notice mails, bookmarks) land on the new screen */
    if(p[1]==='domains'&&p.length<=3)return p.length===3?{view:'domains',domain:p[2],redirect:true}:{view:'domains',redirect:true};
    return {view:'settings',section:SETTINGS_SECTIONS[0],redirect:true};
  }
  if(top==='identity'&&p.length===1)return {view:'agents',redirect:true};
  if(VIEWS_TOP.indexOf(top)>=0&&p.length===1)return {view:top};
  return unknown;
}
function parseRoute(h){
  var raw=String(h||'').replace(/^#/,'').replace(/^\//,'');
  var p=raw.split('/').filter(function(x){return x!=='';}).map(rdec);
  if(p.indexOf(null)>=0)return {view:'overview',unknown:true};
  if(p[0]==='o'&&p.length>=2){var r=parseParts(p.slice(2));r.org=p[1];return r;}
  return parseParts(p);
}
function routeHref(r){
  var e=encodeURIComponent;
  if(r.view==='agent'){
    var s='#/agents/'+e(r.agent);
    if(r.tab&&r.tab!=='overview')s+='/'+r.tab;
    if(r.sub&&CHANNEL_SUB[r.tab]&&CHANNEL_SUB[r.tab].indexOf(r.sub)>=0)s+='/'+r.sub;
    if(r.tab==='logs'&&(r.log&&r.log!=='outbound'||r.entry))s+='/'+(r.log||'outbound');
    if(r.tab==='logs'&&r.entry)s+='/'+e(r.entry);
    return s;
  }
  if(r.view==='logs'){
    var t='#/logs';
    if(r.log&&r.log!=='outbound'||r.entry)t+='/'+(r.log||'outbound');
    if(r.entry)t+='/'+e(r.entry);
    return t;
  }
  if(r.view==='domains')return '#/domains'+(r.domain?'/'+e(r.domain):'');
  if(r.view==='watch')return '#/watch/'+(r.section&&WATCH_SECTIONS.indexOf(r.section)>=0?r.section:WATCH_SECTIONS[0]);
  if(r.view==='settings'){var sec=r.section&&SETTINGS_SECTIONS.indexOf(r.section)>=0?r.section:SETTINGS_SECTIONS[0];
    return '#/settings/'+sec;}
  return '#/'+(VIEWS_TOP.indexOf(r.view)>=0?r.view:'overview');
}
`;

/**
 * 시각 조각 — 순수 함수(DOM 없음). 앱 스크립트가 그대로 싣고, 테스트가 두 언어로 번역한 뒤 vm 으로 경계값을 단언한다.
 *   - `ymd` · `mdhm` · `ymdhm` — KST 달력, 언어별 포매터 하나(ko `2026.09.24` · en `Sep 24, 2026` — 비평 R9-06).
 *   - `fmt('{n}분 전',{n:5})` — 틀 전체가 사전 키 하나라 언어마다 어순이 달라도 된다(조각을 이어 붙이지 않는다).
 *   - `fmtDate(iso)` · `fmtDateTime(iso, now)` · `EMPTY`(2026-10-15 UI 감사 §3.10 — 표의 날짜·시각은 이 둘로만): 날짜만 = `ymd`.
 *     시각 포함 = 지난 60분 안이면 상대(`방금` · `n분 전`), 아니면 같은 KST 해 `MM.DD HH:mm`(en `Sep 30, 10:58`) · 다른 해 `YYYY.MM.DD HH:mm`.
 *     빈 칸은 늘 `EMPTY`(—) 하나 — 뜻은 칸의 title 이 푼다("만료 없음"처럼 뜻이 있는 값만 낱말로 쓴다).
 *   - `ago(iso, now)` — 상대 시각(US-007 "마지막 사용"): 1분 미만(또는 이 브라우저 시계가 서버보다 늦어 미래로 보이면) `방금` ·
 *     1시간 미만 `n분 전` · 24시간 미만 `n시간 전` · 그 밖에는 KST 날짜. `now` 는 호출하는 쪽이 넘긴다(화면을 그릴 때마다 다시 잰다 —
 *     타이머로 갱신하지 않는다).
 */
export const TIME_JS = String.raw`function p2(n){return (n<10?'0':'')+n;}
function kstParts(iso){if(!iso)return null;var t=new Date(iso);if(isNaN(t.getTime()))return null;var k=new Date(t.getTime()+32400000);
  return [k.getUTCFullYear(),p2(k.getUTCMonth()+1),p2(k.getUTCDate())];}
/* one date format per language (critique R9-06): ko 2026.09.24 / 09.24 11:00, en Sep 24, 2026 / Sep 24, 11:00. Parts are built by hand,
   never Intl's locale output (ko-KR gives "09. 24." with spaces). */
var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function isEn(){return typeof LANG!=='undefined'&&LANG==='en';}
function kstHm(iso){var t=new Date(iso);if(!iso||isNaN(t.getTime()))return null;var k=new Date(t.getTime()+32400000);return [p2(k.getUTCHours()),p2(k.getUTCMinutes())];}
function ymd(iso){var k=kstParts(iso);if(!k)return '—';return isEn()?MON[+k[1]-1]+' '+(+k[2])+', '+k[0]:k.join('.');}
function mdhm(iso){var k=kstParts(iso),h=kstHm(iso);if(!k||!h)return '—';return (isEn()?MON[+k[1]-1]+' '+(+k[2])+',':k[1]+'.'+k[2])+' '+h[0]+':'+h[1];}
function ymdhm(iso){var h=kstHm(iso);return h?ymd(iso)+(isEn()?', ':' ')+h[0]+':'+h[1]:'—';}
/* thousands separator, both languages (critique R9-07) - the same rule as the site's groupDigits */
function grp(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function fmt(s,o){return String(s).replace(/\{([a-zA-Z]+)\}/g,function(_,k){return Object.prototype.hasOwnProperty.call(o,k)?String(o[k]):'';});}
var EMPTY='\u2014';
function fmtDate(iso){return ymd(iso);}
function fmtDateTime(iso,now){var t=typeof iso==='string'&&iso?new Date(iso).getTime():NaN;if(isNaN(t))return EMPTY;var s=Math.floor((now-t)/1000);
  if(s>=-60&&s<60)return '방금';if(s>=60&&s<3600)return fmt('{n}분 전',{n:Math.floor(s/60)});
  var k=kstParts(iso),y=kstParts(new Date(now).toISOString());return k&&y&&k[0]===y[0]?mdhm(iso):ymdhm(iso);}
function ago(iso,now){if(typeof iso!=='string'||!iso)return '';var t=new Date(iso).getTime();if(isNaN(t))return '';var s=Math.floor((now-t)/1000);
  if(s<60)return '방금';
  if(s<3600)return fmt('{n}분 전',{n:Math.floor(s/60)});
  if(s<86400)return fmt('{n}시간 전',{n:Math.floor(s/3600)});
  return ymd(iso);}
`;

/**
 * 신원 무늬(§3.3) — 키 지문(SHA-256 hex 64자)에서 결정적으로 뽑는 값. 순수 함수라 테스트가 vm 으로 전수 단언한다.
 *   - `artHue(hex)` — `u = (b0<<8 | b1) % 195; h = u < 25 ? u : u < 130 ? u + 50 : u + 165` → `[0,25) ∪ [75,180) ∪ [295,360)`.
 *     **주황 대역 25–75° 는 나오지 않는다**(주황은 브랜드에서도 빠졌다 — D1 · C3). **파랑·청록·남색 대역 180–295° 도 나오지 않는다**(창업자
 *     규칙 "파랑 0" — 비평 R1-23 · R4-06, 2026-09-27: hue 는 OKLCH 라 순수 파랑이 264°, 남색이 ~277° 다 — HSL 감각의 260 경계로는
 *     파랑이 남았다). 두 대역을 건너뛰고 남은 195개 hue 를 고르게 쓴다(결정적 · 겹침 없음).
 *   - **파생 hue**(`h2` 두 번째 면 · `h3`·`h4` 포일)도 같은 허용 집합 안에서만 — 각도를 더하지 않고 허용 인덱스 공간에서 옮긴다:
 *     `hueAt((u + k) % 195)`, k = 20 · 60 · 165(= −30). CSS 에는 `calc(var(--h) + N)` 이 없다(비평 R5-01 — +40·+120·−60 이 제외 대역으로 돌아갔다).
 *     사이트(`src/site/**`)에 hue 계산이 생기면 같은 공식이어야 한다(같은 지문 = 같은 색).
 *   - `artParams(hex)` — 로제트 `n·m·A·A2·phi·k` 와 `h`. 지문이 아니면 `null`(→ 회색 카드 · 점선 원).
 *   - `rosette(cx,cy,R,A,n,A2,m,phi,steps)` — 곡선 `r(θ) = R + A·sin(nθ + φ) + A2·sin(mθ)` 의 SVG path(소수 둘째 자리).
 */
export const ART_JS = String.raw`var HEX64=/^[0-9a-f]{64}$/;
function fpByte(hex,i){return parseInt(hex.substr(i*2,2),16);}
function hueAt(i){return i<25?i:i<130?i+50:i+165;}
function artIndex(hex){return ((fpByte(hex,0)<<8)|fpByte(hex,1))%195;}
function artHue(hex){if(!HEX64.test(hex))return null;return hueAt(artIndex(hex));}
function artParams(hex){if(!HEX64.test(hex))return null;var b=function(i){return fpByte(hex,i);},u=artIndex(hex);
  return {h:hueAt(u),h2:hueAt((u+20)%195),h3:hueAt((u+60)%195),h4:hueAt((u+165)%195),n:5+b(2)%8,m:2+b(3)%3,A:4+b(4)%6,A2:1+b(5)%3,phi:b(6)/255*2*Math.PI,k:7+b(7)%5};}
function r2(v){return Math.round(v*100)/100;}
function rosette(cx,cy,R,A,n,A2,m,phi,steps){var s='';for(var i=0;i<=steps;i++){var t=i/steps*2*Math.PI,r=R+A*Math.sin(n*t+phi)+A2*Math.sin(m*t);
  s+=(i?'L':'M')+r2(cx+r*Math.cos(t))+' '+r2(cy+r*Math.sin(t));}return s+'Z';}
`;
