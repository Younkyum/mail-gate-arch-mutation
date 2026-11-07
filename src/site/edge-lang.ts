/**
 * src/site/edge-lang.ts — 홈(`atmark.ai`) 앞 CloudFront 의 **뷰어 요청 함수**(CloudFront Functions, `cloudfront-js-2.0`) 소스(2026-09-30).
 * 배선은 `infra/cdk/stacks/site-cdn-stack.ts`(기본 동작 — HTML 페이지)이고, 로컬 미리보기(`scripts/ui/preview.ts`)는 **같은 소스**를
 * Node 에서 그대로 돌려 흉내 낸다. 사이트 λ 번들은 이 파일을 import 하지 않는다(엣지에서만 돈다).
 *
 * 언어 규칙(진윤겸 2026-09-30): 영어가 기본(접두어 없는 경로), 한국어는 `/kr…`.
 *   1. 쿼리 `hl=ko|en` 이 있는 페이지 요청(보이는 언어 전환 링크 — `page.ts` `langSwitchHref`) → 선택 쿠키 `atmark_lang=<값>`(Path=/ · 1년 ·
 *      SameSite=Lax · Secure)를 적고 **`hl` 을 뺀 같은 경로**로 302. 그래서 한국어 방문자가 English 를 고르면 그 뒤로는 영어에 머문다.
 *   2. 접두어 없는 페이지 경로(`/`·`/pricing`·`/privacy`·`/terms`·`/refund`·`/login`·`/signup`·`/waitlist`)의 GET·HEAD:
 *        - 쿠키 `en` → 그대로(영어).
 *        - 쿠키 `ko` → `/kr` 같은 페이지로 302.
 *        - 쿠키 없음(또는 모르는 값) + Accept-Language 의 **가장 높은 q** 가 한국어(`ko`·`ko-KR`…) → `/kr` 같은 페이지로 302.
 *        - 그 밖 → 그대로(영어).
 *   3. `/kr…`·자산(`/_fonts/`·`/img/`·`/og/`·파비콘·크롤러 파일)·그 밖의 경로는 **절대 옮기지 않는다** — 크롤러(Accept-Language 없음)는 늘 영어를
 *      보고, `/kr` 문서도 리다이렉트 없이 색인된다(hreflang: en = 접두어 없음 · ko = `/kr` · x-default = 접두어 없음).
 * 302 응답은 `cache-control: no-store`(방문자마다 다르다). 쿼리는 `hl` 만 빼고 받은 모양 그대로 다시 잇는다(CloudFront 가 넘기는 키·값은
 * 요청 줄의 퍼센트 인코딩 그대로라 다시 인코딩하지 않는다 — AWS 예제 `objectToQueryString` 과 같은 방식). 쿠키·헤더 값은 되비추지 않는다
 * (Location = 고정 표의 경로 + 원래 쿼리, 쿠키 값은 `ko`·`en` 둘 중 하나뿐).
 *
 * ES5 만 쓴다(`var`·`function` — 런타임 2.0 이 더 받지만 가장 좁은 문법으로). 크기 한도 10KB — 테스트가 잰다.
 */

import { blogNegotiatedEnPaths, PUBLISHED_POSTS } from './blog-nav';
import { KO_PREFIX, SITE_LANG_COOKIE, SITE_LANG_QUERY } from './constants';

/** 언어 협상 대상 — 두 언어에 다 있는 페이지의 **영어(접두어 없는) 경로**. `SITE_ROUTES` 와 맞는지는 테스트가 본다. */
export const NEGOTIATED_EN_PATHS: readonly string[] = ['/', '/pricing', '/privacy', '/terms', '/refund', '/login', '/signup', '/waitlist', '/use-cases', '/abuse', '/changelog'];

/** 선택 쿠키의 속성 — 1년 · 사이트 전체 · 같은 사이트 탐색에도 실림(Lax) · HTTPS 만. */
export const SITE_LANG_COOKIE_ATTRIBUTES = 'Path=/; Max-Age=31536000; SameSite=Lax; Secure';

/**
 * 블로그(2026-10-01)의 협상 대상 — 공개 글 중 **한국어 짝이 있는** 영어 경로(목록 `/blog` · 글 `/blog/<slug>`)만(`blog-nav.ts`). 영어만 있는 글은
 * 옮기지 않는다(한국어 방문자를 `/kr/…` 404 로 보내지 않게). 생성 값 파일에서 정해지므로 글을 공개하면 다음 배포의 엣지 함수에 들어간다.
 */
export const BLOG_NEGOTIATED_EN_PATHS: readonly string[] = blogNegotiatedEnPaths(PUBLISHED_POSTS);

/** 엣지 함수 표에 싣는 영어 경로 전부. */
const EDGE_EN_PATHS: readonly string[] = [...NEGOTIATED_EN_PATHS, ...BLOG_NEGOTIATED_EN_PATHS];

const table = (paths: readonly string[]): string => `{${paths.map((p) => `'${p}':1`).join(',')}}`;

/** 한국어 페이지 경로 — `/` → `/kr`, `/pricing` → `/kr/pricing`, `/blog/x` → `/kr/blog/x`. */
const koPaths = EDGE_EN_PATHS.map((p) => (p === '/' ? KO_PREFIX : `${KO_PREFIX}${p}`));

export const SITE_LANG_FUNCTION_CODE = `var EN=${table(EDGE_EN_PATHS)};
var KO=${table(koPaths)};
var KO_PREFIX='${KO_PREFIX}',COOKIE='${SITE_LANG_COOKIE}',Q='${SITE_LANG_QUERY}';
function koPath(uri){return uri==='/'?KO_PREFIX:KO_PREFIX+uri;}
function rest(qs){
  var out=[];
  for(var k in qs){
    if(k===Q)continue;
    var e=qs[k],vs=(e&&e.multiValue)?e.multiValue:[e];
    for(var i=0;i<vs.length;i++){var v=vs[i]&&vs[i].value;out.push(k+(v===undefined||v===''?'':'='+v));}
  }
  return out.length?'?'+out.join('&'):'';
}
function prefersKo(h){
  if(!h||!h.value)return false;
  var best='',bq=-1,parts=h.value.split(',');
  for(var i=0;i<parts.length;i++){
    var seg=parts[i].split(';'),tag=seg[0].trim().toLowerCase(),q=1;
    if(!tag)continue;
    for(var j=1;j<seg.length;j++){var p=seg[j].trim();if(p.indexOf('q=')===0){q=parseFloat(p.slice(2));if(isNaN(q))q=0;}}
    if(q>bq){bq=q;best=tag;}
  }
  return bq>0&&(best==='ko'||best.indexOf('ko-')===0);
}
function go(location,cookie){
  var res={statusCode:302,statusDescription:'Found',headers:{'location':{value:location},'cache-control':{value:'no-store'}}};
  if(cookie)res.cookies={};
  if(cookie)res.cookies[COOKIE]={value:cookie,attributes:'${SITE_LANG_COOKIE_ATTRIBUTES}'};
  return res;
}
function handler(event){
  var req=event.request,uri=req.uri,m=req.method;
  if(m!=='GET'&&m!=='HEAD')return req;
  var page=EN[uri]===1,ko=KO[uri]===1;
  if(!page&&!ko)return req;
  var qs=req.querystring||{},h=qs[Q],hl=h&&h.value;
  if(hl==='ko'||hl==='en')return go(uri+rest(qs),hl);
  if(!page)return req;
  var c=req.cookies&&req.cookies[COOKIE],cv=c&&c.value;
  if(cv==='en')return req;
  if(cv==='ko'||prefersKo(req.headers&&req.headers['accept-language']))return go(koPath(uri)+rest(qs));
  return req;
}
`;
