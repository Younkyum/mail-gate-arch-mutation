/**
 * src/admin/ui/console/zonefile.ts — DNS 레코드를 BIND 존 파일 글 한 벌로(2026-10-05 진윤겸 요청 — "레코드를 한 번에 넣게").
 *
 * 도메인 화면의 `레코드 파일 받기` · `모두 복사` 가 같은 글을 쓴다. 순수 함수(DOM 없음)라 앱 스크립트가 그대로 싣고(`app.ts` —
 * `ROUTER_JS` 와 같은 자리), 테스트가 `node:vm` 으로 돌린다(`ROUTER_JS` 와 같은 방법 — 원본은 이 문자열 하나다).
 *
 * 규칙:
 *   - 표와 같은 레코드 · 같은 순서: 소유 확인 TXT(`_atmark-challenge.<서브도메인>`) → 수신 MX → MAIL FROM MX · SPF TXT → DKIM CNAME →
 *     DMARC TXT(`_dmarc.<서브도메인>`, 권장 — 2026-10-06. 확인과 무관하지만 파일에 넣어 두면 Gmail·Yahoo 의 DMARC 요구를 채운다) —
 *     **파일 하나에 전부**(2026-10 one-shot). 레코드가 없는 무리는 머리 주석째 뺀다. 콘솔은 DKIM 이 아직 없으면 받기 · 복사를 잠그므로
 *     (`script/domains.ts` `recReady`) 빠진 파일이 나가지 않는다 — 이 함수는 받은 레코드만 충실히 옮긴다.
 *   - 이름 · 대상은 끝에 점이 붙은 절대 이름(FQDN) — `$ORIGIN` 이 필요 없다. 이름 모양이 아닌 값(서버를 믿지 않는다)은 그 줄을 뺀다
 *     (줄바꿈 · 공백이 든 값이 파일의 다른 줄을 만들지 못하게).
 *   - TTL 3600 · 클래스 IN. TXT 는 따옴표로 감싸고 `\` · `"` 를 이스케이프, 255자마다 조각으로 나눈다(`"…" "…"`). 인쇄 가능한 ASCII 만 남긴다.
 *   - CNAME 줄 끝에 `; cf_tags=cf-proxied:false` — Cloudflare 내보내기와 같은 주석이라, 가져오기가 프록시를 끈 채로 넣는다(다른 공급자에게는
 *     그냥 주석이다).
 *   - 머리 주석은 **ASCII 영어만**(가져오기 도구가 다른 인코딩에서 넘어지지 않게) — 한국어 안내는 화면에 둔다.
 *   - `now` 가 같으면 같은 글(결정적) · 줄 끝 `\n` · 마지막 줄도 `\n` 으로 끝난다.
 * 스크립트는 ASCII 만(`admin-ui.test.ts` ④) · URL 모양 글 없음(⑤).
 */

export const ZONEFILE_JS = String.raw`/* ---------- DNS zone file (BIND) for the domain screen: download / copy all ---------- */
var ZONE_TTL=3600;
var ZONE_GROUPS=[['Ownership',['ownership']],['Receiving mail',['inbound_mx']],['Bounce address (MAIL FROM)',['mail_from_mx','mail_from_spf']],['Signing (DKIM)',['dkim']],['DMARC (recommended)',['dmarc']]];
var ZONE_HOST=/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)+$/;
function zoneStr(v){return (v===null||v===undefined)?'':String(v).replace(/[^\x20-\x7e]/g,'').trim();}
/* "Agents.Example.com." -> "agents.example.com." ; anything that is not a host name -> '' (the line is dropped) */
function zoneHost(v){var s=zoneStr(v).toLowerCase().replace(/\.$/,'');return s.length<=253&&ZONE_HOST.test(s)?s+'.':'';}
/* TXT: quoted, backslash and quote escaped, split into 255-character strings */
function zoneTxt(v){var s=zoneStr(v),out=[],i;for(i=0;i<s.length;i+=255)out.push('"'+s.slice(i,i+255).replace(/[\\"]/g,'\\$&')+'"');return out.join(' ');}
function zoneRec(r){var type=zoneStr(r.type).toUpperCase(),name=zoneHost(r.name),v=zoneStr(r.value),m,h;if(!name)return null;
  if(type==='TXT')return v?{n:name,t:'TXT',r:zoneTxt(v)}:null;
  if(type==='MX'){m=/^(\d{1,5})\s+(\S+)$/.exec(v);h=m?zoneHost(m[2]):'';return h&&+m[1]<=65535?{n:name,t:'MX',r:String(+m[1])+' '+h}:null;}
  if(type==='CNAME'){h=zoneHost(v);return h?{n:name,t:'CNAME',r:h,c:'cf_tags=cf-proxied:false'}:null;}
  return null;}
function zoneWhen(now){var t=new Date(now);return isNaN(t.getTime())?'':t.toISOString().slice(0,16).replace('T',' ')+' UTC';}
function zoneHasDkim(records){return (Array.isArray(records)?records:[]).some(function(r){return r!==null&&typeof r==='object'&&r.purpose==='dkim'&&!!zoneRec(r);});}
function zoneFileName(domain){var h=zoneHost(domain);return (h?h.slice(0,-1):'domain')+'.atmark-dns.txt';}
function buildZoneFile(domain,records,now){var recs=Array.isArray(records)?records:[],dom=zoneHost(domain),w=0,groups,out,when=zoneWhen(now);
  groups=ZONE_GROUPS.map(function(g){var rows=[];g[1].forEach(function(p){recs.forEach(function(r){if(r===null||typeof r!=='object'||r.purpose!==p)return;
      var x=zoneRec(r);if(x){rows.push(x);if(x.n.length>w)w=x.n.length;}});});return {title:g[0],rows:rows};});
  out=['; Atmark DNS records for '+(dom?dom.slice(0,-1):'(unknown domain)')];
  if(when)out.push('; Generated '+when);
  out.push(';','; Cloudflare: DNS > Records > Import and Export > Import, then upload this file.',
    '; Keep every record DNS only (proxy off). CNAME records must not be proxied.',
    '; TTL is '+ZONE_TTL+' seconds here. Auto TTL at your DNS provider works too.');
  groups.forEach(function(g){if(!g.rows.length)return;out.push('','; '+g.title);
    g.rows.forEach(function(x){out.push(x.n.padEnd(w)+' '+ZONE_TTL+' IN '+x.t.padEnd(5)+' '+x.r+(x.c?' ; '+x.c:''));});});
  return out.join('\n')+'\n';}
`;
