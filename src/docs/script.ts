/**
 * src/docs/script.ts — 문서 페이지의 인라인 스크립트 하나(해시 하나 — `layout.ts` CSP). **점진적 향상만** 한다: 스크립트가 없어도 모든 링크·
 * 검색(`/search?q=`)·서랍(popover)·접기(details)가 동작하고, 여기서 여는 것은 다음뿐이다.
 *   - 테마: 시스템 / 밝게 / 어둡게(`localStorage` — 실패해도 조용히 시스템). `<head>` 에서 돌아 첫 그림부터 맞는 테마다.
 *   - 검색 대화상자(⌘K · Ctrl+K · `/`): 같은 출처의 색인 JSON(`/_search/<해시>/<lang>.json`)을 한 번 받아 브라우저에서 찾는다. 서버 검색
 *     (`site.ts` `searchDocs`)과 같은 규칙. 결과는 DOM API 로만 만든다(`innerHTML` 없음 — CSP 의 Trusted Types 가 막는다).
 *   - 코드 복사 · "페이지 복사"(`.md` 판을 받아 클립보드에) · 탭 묶음 · 목차의 현재 위치 표시.
 * ASCII 만(`asciiScript` — 해시가 응답 인코딩에 흔들리지 않게).
 */

const SOURCE = String.raw`(function(){
var d=document,root=d.documentElement,KEY='atmark-docs-theme';
function getTheme(){try{var v=localStorage.getItem(KEY);return v==='light'||v==='dark'?v:'system';}catch(e){return 'system';}}
function applyTheme(t){if(t==='light'||t==='dark'){root.setAttribute('data-theme',t);}else{root.removeAttribute('data-theme');}root.setAttribute('data-tc',t);}
applyTheme(getTheme());
var KO=root.lang==='ko';
function terms(q){return q.normalize('NFC').toLowerCase().split(/\s+/).map(function(s){return s.trim();}).filter(function(s){return s!=='';}).slice(0,8);}
var HANGUL=/[가-힣]/;
function field(s){var p=s.normalize('NFC').toLowerCase();return {plain:p,compact:p.replace(/\s+/g,''),grams:null};}
function gramsOf(s){var o=[];for(var i=0;i+1<s.length;i++)o.push(s.slice(i,i+2));return o;}
function match(f,term){if(f.plain.indexOf(term)>=0)return 1;var t=term.replace(/\s+/g,'');if(t!==''&&f.compact.indexOf(t)>=0)return 0.8;
if(t.length>=3&&HANGUL.test(t)){if(!f.grams)f.grams=new Set(gramsOf(f.compact));var g=gramsOf(t),n=0;for(var i=0;i<g.length;i++)if(f.grams.has(g[i]))n++;var hit=n/g.length;if(hit>=0.6)return 0.4*hit;}return 0;}
var PREP=[];
function prep(items,i){var p=PREP[i];if(!p){var it=items[i];p=PREP[i]={t:field(it.t),k:field(it.k||''),h:field(it.h),x:field(it.x),th:field(it.t+' '+it.h)};}return p;}
function search(items,q){var ts=terms(q);if(!ts.length)return [];var out=[];
for(var i=0;i<items.length;i++){var it=items[i],p=prep(items,i),score=0,ok=true;
for(var k=0;k<ts.length;k++){var term=ts[k],mt=match(p.t,term),mh=match(p.h,term),s=10*mt+8*match(p.k,term)+5*mh+match(p.x,term)+(mt===0&&mh===0&&it.h!==''?6*match(p.th,term):0);if(s===0){ok=false;break;}score+=s;}
if(!ok)continue;if(it.h===''&&ts.every(function(term){return match(p.t,term)>0;}))score+=5;out.push({it:it,score:Math.round(score*100)*10000-i,snip:snippet(it.x,ts)});}
out.sort(function(a,b){return b.score-a.score;});out=out.slice(0,60);
var groups=[],byPage={};out.forEach(function(r){var page=r.it.u.split('#')[0];var g=byPage[page];if(!g){g=byPage[page]={best:r,more:[]};groups.push(g);}else if(g.more.length<2&&r.it.h!=='')g.more.push(r);});return groups.slice(0,10);}
function snippet(text,ts){var low=text.normalize('NFC').toLowerCase(),at=-1;for(var k=0;k<ts.length&&at<0;k++)at=low.indexOf(ts[k]);if(at<0)return text.length>120?text.slice(0,120)+'…':text;var st=Math.max(0,at-40);return (st>0?'…':'')+text.slice(st,st+140)+(st+140<text.length?'…':'');}
function el(tag,cls,text){var e=d.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function copyText(text,btn,done){if(!navigator.clipboard)return;navigator.clipboard.writeText(text).then(function(){var old=btn.textContent;btn.textContent=done;setTimeout(function(){btn.textContent=old;},1600);},function(){});}
d.addEventListener('DOMContentLoaded',function(){
var DONE=KO?'복사했습니다':'Copied';
var tbs=Array.prototype.slice.call(d.querySelectorAll('.theme-b'));
function label(t){tbs.forEach(function(tb){tb.setAttribute('aria-label',tb.getAttribute('data-l-theme')+': '+tb.getAttribute('data-l-'+t));var sl=tb.querySelector('.theme-l');if(sl)sl.textContent=tb.getAttribute('data-l-'+t);});}
tbs.forEach(function(tb){tb.hidden=false;tb.addEventListener('click',function(){var cur=getTheme(),nx=cur==='system'?'light':cur==='light'?'dark':'system';try{if(nx==='system')localStorage.removeItem(KEY);else localStorage.setItem(KEY,nx);}catch(e){}applyTheme(nx);label(nx);});});
label(getTheme());
Array.prototype.forEach.call(d.querySelectorAll('[data-copy]'),function(b){b.hidden=false;b.addEventListener('click',function(){var pre=b.parentNode&&b.parentNode.parentNode?b.parentNode.parentNode.querySelector('pre'):null;if(pre)copyText(pre.textContent,b,DONE);});});
var cm=d.getElementById('copy-md');
if(cm&&navigator.clipboard){cm.hidden=false;cm.addEventListener('click',function(){fetch(cm.getAttribute('data-md'),{credentials:'omit'}).then(function(r){return r.ok?r.text():Promise.reject(r.status);}).then(function(t){copyText(t,cm,cm.getAttribute('data-done'));},function(){});});}
Array.prototype.forEach.call(d.querySelectorAll('.tabs[data-tabs]'),function(box){var id=box.getAttribute('data-tabs');var panels=Array.prototype.filter.call(box.children,function(c){return c.classList.contains('tab');});if(panels.length<2)return;
var list=el('div','tablist');list.setAttribute('role','tablist');var btns=[];
panels.forEach(function(p,i){var lab=p.querySelector('.tab-l');var b=el('button',null,lab?lab.textContent:String(i+1));b.type='button';b.id='tb-'+id+'-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls','tp-'+id+'-'+i);
p.id='tp-'+id+'-'+i;p.setAttribute('role','tabpanel');p.setAttribute('aria-labelledby',b.id);p.tabIndex=0;btns.push(b);list.appendChild(b);});
function sel(i,focus){btns.forEach(function(b,k){var on=k===i;b.setAttribute('aria-selected',on?'true':'false');b.tabIndex=on?0:-1;panels[k].hidden=!on;});if(focus)btns[i].focus();}
btns.forEach(function(b,i){b.addEventListener('click',function(){sel(i,false);});b.addEventListener('keydown',function(e){var n=e.key==='ArrowRight'?(i+1)%btns.length:e.key==='ArrowLeft'?(i-1+btns.length)%btns.length:e.key==='Home'?0:e.key==='End'?btns.length-1:-1;if(n>=0){e.preventDefault();sel(n,true);}});});
box.insertBefore(list,box.firstChild);box.classList.add('js');sel(0,false);});
var HINT=KO?'표를 옆으로 밀어 보세요 →':'Scroll the table sideways →';
function hints(){Array.prototype.forEach.call(d.querySelectorAll('.prose .tbl'),function(t){var over=t.scrollWidth>t.clientWidth+2,h=t.previousElementSibling,has=h&&h.classList.contains('tbl-hint');if(over&&!has){var p=el('p','tbl-hint',HINT);p.setAttribute('aria-hidden','true');t.parentNode.insertBefore(p,t);}else if(!over&&has)h.parentNode.removeChild(h);});}
hints();window.addEventListener('resize',hints);
var tocLinks=Array.prototype.slice.call(d.querySelectorAll('.toc a[href^="#"]'));
if(tocLinks.length&&'IntersectionObserver' in window){var heads=tocLinks.map(function(a){return d.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));});var vis={};
var mark=function(){var first=-1;for(var i=0;i<heads.length;i++){if(vis[i]){first=i;break;}}if(first<0)return;tocLinks.forEach(function(a,k){if(k===first)a.setAttribute('aria-current','true');else a.removeAttribute('aria-current');});};
var io=new IntersectionObserver(function(es){es.forEach(function(e){var i=heads.indexOf(e.target);if(i>=0)vis[i]=e.isIntersecting;});mark();},{rootMargin:'-64px 0px -60% 0px'});heads.forEach(function(h){if(h)io.observe(h);});}
var side=d.querySelector('.side [aria-current="page"]');if(side){var box2=d.getElementById('side');if(box2&&side.offsetTop>box2.clientHeight-80)box2.scrollTop=side.offsetTop-box2.clientHeight/2;}
var dlg=d.getElementById('search-d'),open=d.getElementById('search-open'),q=d.getElementById('search-q'),res=d.getElementById('search-r'),xb=d.getElementById('search-x');
if(!dlg||!open||!q||!res||typeof dlg.showModal!=='function')return;
var items=null,loading=null,cur=-1;
function load(){if(items||loading)return loading;loading=fetch(dlg.getAttribute('data-index'),{credentials:'omit'}).then(function(r){return r.json();}).then(function(j){items=j.items||[];render();},function(){items=[];});return loading;}
function links(){return Array.prototype.slice.call(res.querySelectorAll('a'));}
function select(i){var ls=links();cur=ls.length?Math.max(0,Math.min(i,ls.length-1)):-1;ls.forEach(function(a,k){if(k===cur){a.setAttribute('aria-selected','true');a.scrollIntoView({block:'nearest'});}else a.removeAttribute('aria-selected');});}
function render(){while(res.firstChild)res.removeChild(res.firstChild);cur=-1;var v=q.value.trim();if(!v||!items)return;var groups=search(items,v);
if(!groups.length){res.appendChild(el('li','r-none',dlg.getAttribute('data-empty')));return;}
groups.forEach(function(g){var h=g.best,li=el('li');var a=el('a');a.href=h.it.u;a.appendChild(el('span','r-t',h.it.t));a.appendChild(el('span','r-h',h.it.h?h.it.g+' › '+h.it.h:h.it.g));if(h.snip)a.appendChild(el('span','r-x',h.snip));li.appendChild(a);
g.more.forEach(function(m){var b=el('a','r-sub',m.it.h||m.it.t);b.href=m.it.u;li.appendChild(b);});res.appendChild(li);});select(0);}
function show(){if(dlg.open)return;dlg.showModal();q.focus();q.select();load();}
open.addEventListener('click',function(e){if(e.metaKey||e.ctrlKey||e.shiftKey)return;e.preventDefault();show();});
d.addEventListener('keydown',function(e){var t=e.target,typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable);
if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){e.preventDefault();show();return;}
if(e.key==='/'&&!typing&&!dlg.open){e.preventDefault();show();}});
q.addEventListener('input',render);
q.addEventListener('keydown',function(e){if(e.key==='ArrowDown'){e.preventDefault();select(cur+1);}else if(e.key==='ArrowUp'){e.preventDefault();select(cur-1);}else if(e.key==='Enter'){var ls=links();if(cur>=0&&ls[cur]){e.preventDefault();location.href=ls[cur].href;dlg.close();}}});
if(xb)xb.addEventListener('click',function(){dlg.close();});
dlg.addEventListener('click',function(e){if(e.target===dlg)dlg.close();});
dlg.addEventListener('close',function(){open.focus();});
});
})();`;

/** 스크립트 소스를 ASCII 로 — 비ASCII 글자는 `\uXXXX` 이스케이프(홈 `asciiScript` 와 같은 규칙). */
export function asciiScript(source: string): string {
  return source.replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const DOCS_SCRIPT = asciiScript(SOURCE);
