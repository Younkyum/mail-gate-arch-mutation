/**
 * 문서 핸들러(`src/docs/http.ts`) — 라우트·헤더·CSP·gzip·크롤러 파일·검색. 콘텐츠는 **고정 픽스처**(작성 중인 실제 콘텐츠와 무관하게 라우팅을 본다).
 * 실제 콘텐츠 전체에 대한 단언은 `docs-content.test.ts`.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createDocsRuntime, handleDocsRequest, type DocsHttpEvent } from '../../../src/docs/http';
import { DOCS_PAGE_CSP, SCRIPT_HASH, STYLE_HASH } from '../../../src/docs/layout';
import { DOCS_SCRIPT } from '../../../src/docs/script';
import { DOCS_CSS } from '../../../src/docs/styles';
import { fontPath } from '../../../src/ui/font-faces';
import { OG_IMAGE_HASH } from '../../../src/ui/og-version';
import { PRETENDARD_CHUNKS } from '../../../src/ui/pretendard-data';

const front = (title: string, group: string, order: number, extra = ''): string =>
  `---\ntitle: ${title}\ndescription: ${title} description.\ngroup: ${group}\norder: ${String(order)}\nupdated: 2026-09-2${String(order)}\n${extra}---\n\n`;

const KO = {
  index: '---\ntitle: Atmark 문서\ndescription: 에이전트 신원과 이메일.\n---\n\n:::cards\n- [빠른 시작](/get-started/quickstart): 15분\n:::\n',
  'get-started/quickstart': `${front('빠른 시작', 'get-started', 1, 'related: [email/sending]\n')}## 준비물\n\n토큰이 필요합니다.\n\n:::steps\n### 가입\n가입합니다.\n:::\n\n:::tabs\n@tab A\n하나\n@tab B\n둘\n:::\n`,
  'email/sending': `${front('보내기', 'email', 1)}## 발신 모드 {#modes}\n\n허용 목록 모드는 [빠른 시작](/get-started/quickstart)을 보세요.\n\n\`\`\`bash\ncurl https://api.atmark.ai/v1\n\`\`\`\n`,
  'help/faq': `${front('자주 묻는 질문', 'help', 1)}:::details 승인은?\n링크로 합니다.\n:::\n`,
};
const EN = {
  index: '---\ntitle: Atmark Docs\ndescription: Identity and email for agents.\n---\n\n:::cards\n- [Quickstart](/get-started/quickstart): 15 minutes\n:::\n',
  'get-started/quickstart': `${front('Quickstart', 'get-started', 1, 'related: [email/sending]\n')}## Before you start\n\nYou need a token.\n\n:::steps\n### Sign up\nSign up.\n:::\n`,
  'email/sending': `${front('Sending', 'email', 1)}## Sending modes {#modes}\n\nSee [Quickstart](/get-started/quickstart).\n`,
  'help/faq': `${front('FAQ', 'help', 1)}:::details Approvals?\nBy link.\n:::\n`,
};

const rt = createDocsRuntime({ ko: KO, en: EN });

function req(path: string, init: { method?: string; headers?: Record<string, string>; query?: string } = {}): ReturnType<typeof handleDocsRequest> {
  const event: DocsHttpEvent = {
    rawPath: path,
    rawQueryString: init.query ?? '',
    headers: { host: 'docs.atmark.ai', ...init.headers },
    requestContext: { http: { method: init.method ?? 'GET' } },
  };
  return handleDocsRequest(event, rt);
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');

describe('라우트', () => {
  it.each([
    ['/', 'ko'],
    ['/en', 'en'],
    ['/get-started/quickstart', 'ko'],
    ['/en/get-started/quickstart', 'en'],
    ['/email/sending', 'ko'],
    ['/en/help/faq', 'en'],
  ])('%s → 200 HTML (%s)', (path, lang) => {
    const r = req(path);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body).toContain(`<html lang="${lang}">`);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.headers['vary']).toBe('accept-encoding');
  });

  it('끝 슬래시는 301 로 정본 경로(쿼리 유지) · 정본 출처 고정', () => {
    const r = req('/email/sending/', { query: 'x=1' });
    expect(r.statusCode).toBe(301);
    expect(r.headers['location']).toBe('https://docs.atmark.ai/email/sending?x=1');
    expect(req('/en/').headers['location']).toBe('https://docs.atmark.ai/en');
    expect(req('//evil.example/').statusCode).toBe(404);
  });

  it('없는 경로는 404 문서 — /en 아래는 영어, noindex', () => {
    const ko = req('/nope');
    expect(ko.statusCode).toBe(404);
    expect(ko.body).toContain('<html lang="ko">');
    expect(ko.body).toContain('noindex,follow');
    const en = req('/en/nope');
    expect(en.statusCode).toBe(404);
    expect(en.body).toContain('<html lang="en">');
    // 대소문자 변형도 404.
    expect(req('/Email/Sending').statusCode).toBe(404);
  });

  it('GET·HEAD 만 — 그 밖 405, HEAD 는 빈 본문 같은 헤더', () => {
    const post = req('/', { method: 'POST' });
    expect(post.statusCode).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
    const head = req('/email/sending', { method: 'HEAD' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-security-policy']).toBe(DOCS_PAGE_CSP);
  });

  it('.md 판 — 제목·요약·본문(지시어는 평범한 마크다운으로)·원문 링크, 내부 링크는 절대 URL', () => {
    const r = req('/email/sending.md');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.body).toContain('# 보내기\n\n> 보내기 description.\n\n## 발신 모드');
    expect(r.body).toContain('[빠른 시작](https://docs.atmark.ai/get-started/quickstart)');
    expect(r.body).toContain('```bash\ncurl https://api.atmark.ai/v1\n```');
    expect(r.body).toContain('원문: https://docs.atmark.ai/email/sending · 마지막 수정 2026-09-21');
    expect(req('/index.md').body).toContain('# Atmark 문서');
    expect(req('/en/get-started/quickstart.md').body).toContain('## 1. Sign up');
    expect(req('/en/help/faq.md').body).toContain('**Approvals?**\n\nBy link.');
  });

  it('검색 — /search?q= 서버 렌더(noindex) · 결과 링크 · 빈 질의 · 결과 없음', () => {
    const r = req('/search', { query: `q=${encodeURIComponent('발신 모드')}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('noindex,follow');
    expect(r.body).toContain('<a href="/email/sending#modes">보내기</a>');
    expect(req('/en/search', { query: 'q=Sending' }).body).toContain('<a href="/en/email/sending">Sending</a>');
    expect(req('/search').body).toContain('제목과 본문에서 찾습니다.');
    expect(req('/search', { query: 'q=zzzz' }).body).toContain('찾는 결과가 없습니다.');
    // 질의는 이스케이프된다.
    const x = req('/search', { query: `q=${encodeURIComponent('"><script>')}` }).body;
    expect(x).not.toContain('"><script>');
    expect(x).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('검색 색인 JSON — 내용 해시 경로 · 1년 immutable · 페이지와 절', () => {
    const page = req('/').body;
    const path = /data-index="([^"]+)"/.exec(page)?.[1] ?? '';
    expect(path).toMatch(/^\/_search\/[0-9a-f]{16}\/ko\.json$/);
    const r = req(path);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const json = JSON.parse(r.body) as { items: { t: string; h: string; u: string }[] };
    expect(json.items.some((i) => i.u === '/email/sending#modes' && i.h === '발신 모드')).toBe(true);
    expect(req('/_search/0000000000000000/ko.json').statusCode).toBe(404);
  });

  it('크롤러 파일 — robots · sitemap(hreflang 쌍·lastmod) · llms.txt(.md 링크) · llms-full.txt', () => {
    expect(req('/robots.txt').body).toContain('Sitemap: https://docs.atmark.ai/sitemap.xml');
    const sm = req('/sitemap.xml').body;
    expect(sm).toContain('<loc>https://docs.atmark.ai/en/email/sending</loc>');
    expect(sm).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://docs.atmark.ai/email/sending"/>');
    expect(sm).toContain('<lastmod>2026-09-21</lastmod>');
    expect(sm.split('<url>').length - 1).toBe(8);
    const llms = req('/llms.txt').body;
    expect(llms).toContain('- [Sending](https://docs.atmark.ai/en/email/sending.md): Sending description.');
    expect(llms).toContain('- [보내기](https://docs.atmark.ai/email/sending.md): 보내기 description.');
    const full = req('/llms-full.txt').body;
    expect(full.indexOf('# Sending')).toBeLessThan(full.indexOf('# 보내기'));
  });

  it('자산 — 폰트(같은 출처, 1년 immutable, base64) · 파비콘 · 없는 자산은 404 한 줄', () => {
    const chunk = PRETENDARD_CHUNKS[0];
    if (chunk === undefined) throw new Error('폰트 청크 없음');
    const f = req(fontPath(chunk));
    expect(f.statusCode).toBe(200);
    expect(f.isBase64Encoded).toBe(true);
    expect(f.headers['content-type']).toBe('font/woff2');
    expect(f.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(f.headers['access-control-allow-origin']).toBeUndefined();
    expect(req('/_fonts/nope/x.woff2').statusCode).toBe(404);
    expect(req('/_img/nope/x.webp').body).toBe('Not Found\n');
    expect(req('/favicon.svg').headers['content-type']).toBe('image/svg+xml');
  });

  it('gzip — accept-encoding 에 gzip 이 있으면 HTML 만 줄인다', () => {
    const r = req('/email/sending', { headers: { 'accept-encoding': 'br, gzip' } });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.isBase64Encoded).toBe(true);
    expect(gunzipSync(Buffer.from(r.body, 'base64')).toString('utf8')).toBe(req('/email/sending').body);
    expect(req('/email/sending', { headers: { 'accept-encoding': 'gzip;q=0' } }).headers['content-encoding']).toBeUndefined();
    expect(req('/llms.txt', { headers: { 'accept-encoding': 'gzip' } }).headers['content-encoding']).toBeUndefined();
  });
});

describe('보안 헤더 · CSP', () => {
  it('모든 응답: HSTS · nosniff · CSP 가 있다', () => {
    for (const path of ['/', '/nope', '/llms.txt', '/email/sending.md', '/favicon.svg', '/email/sending/']) {
      const r = req(path);
      expect(r.headers['strict-transport-security'], path).toBe('max-age=63072000; includeSubDomains');
      expect(r.headers['x-content-type-options'], path).toBe('nosniff');
      expect(r.headers['content-security-policy'], path).toBeDefined();
    }
    const page = req('/');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });

  it('페이지 CSP — 스크립트·스타일 해시 하나씩, 같은 출처만, Trusted Types, 프레임 금지', () => {
    expect(DOCS_PAGE_CSP).toBe(
      `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'sha256-${STYLE_HASH}'; font-src 'self'; img-src 'self'; connect-src 'self'; ` +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    );
    for (const path of ['/', '/en/get-started/quickstart', '/nope', '/search']) {
      const html = req(path).body;
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
      expect(styles).toEqual([DOCS_CSS]);
      expect(scripts).toEqual([DOCS_SCRIPT]);
      expect(sha(styles[0] ?? '')).toBe(STYLE_HASH);
      expect(sha(scripts[0] ?? '')).toBe(SCRIPT_HASH);
      // 다른 <script> 는 JSON-LD 데이터 블록뿐(페이지당 하나 이하).
      const others = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '').filter((a) => a !== '');
      expect(others.every((a) => a === ' type="application/ld+json"')).toBe(true);
      expect(others.length).toBeLessThanOrEqual(1);
    }
  });

  it('스타일·스크립트는 ASCII 만(해시가 인코딩에 흔들리지 않게)', () => {
    expect(/^[\x00-\x7f]*$/.test(DOCS_CSS)).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(DOCS_SCRIPT)).toBe(true);
  });

  it('CSP 가 조용히 막을 마크업이 없다 — style= · on*= · javascript: · 외부 스크립트·이미지·스타일시트', () => {
    for (const path of ['/', '/en', '/get-started/quickstart', '/email/sending', '/help/faq', '/nope', '/search']) {
      const html = req(path).body;
      expect(html, path).not.toMatch(/\sstyle\s*=/i);
      expect(html, path).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, path).not.toMatch(/javascript:/i);
      expect(html, path).not.toMatch(/<script\b[^>]*\bsrc=/i);
      expect(html, path).not.toMatch(/<link\b[^>]*rel="stylesheet"/i);
      for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) expect(m[1], path).toMatch(/^\/_img\//);
      expect(html, path).not.toMatch(/<iframe|<object|<embed/i);
    }
  });

  it('스크립트는 innerHTML 류 싱크를 쓰지 않는다(Trusted Types none)', () => {
    expect(DOCS_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe('SEO · 언어', () => {
  it('canonical · hreflang(ko·en·x-default=ko) · 보이는 언어 전환 · OG', () => {
    const ko = req('/email/sending').body;
    expect(ko).toContain('<link rel="canonical" href="https://docs.atmark.ai/email/sending">');
    expect(ko).toContain('<link rel="alternate" hreflang="en" href="https://docs.atmark.ai/en/email/sending">');
    expect(ko).toContain('<link rel="alternate" hreflang="x-default" href="https://docs.atmark.ai/email/sending">');
    expect(ko).toContain('<a class="plain lang" href="/en/email/sending" hreflang="en" lang="en">English</a>');
    expect(ko).toContain(`<meta property="og:image" content="https://atmark.ai/og/${OG_IMAGE_HASH.ko}/ko.png">`);
    const en = req('/en').body;
    expect(en).toContain('<link rel="canonical" href="https://docs.atmark.ai/en">');
    expect(en).toContain('<a class="plain lang" href="/" hreflang="ko" lang="ko">한국어</a>');
  });

  it('JSON-LD 는 페이지당 하나 — 문서는 TechArticle + BreadcrumbList, 홈은 WebSite', () => {
    const blocks = (html: string): unknown[] => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1] ?? ''));
    const doc = blocks(req('/email/sending').body);
    expect(doc).toHaveLength(1);
    const graph = (doc[0] as { '@graph': { '@type': string }[] })['@graph'];
    expect(graph.map((n) => n['@type'])).toEqual(['TechArticle', 'BreadcrumbList']);
    const home = blocks(req('/en').body);
    expect(((home[0] as { '@graph': { '@type': string }[] })['@graph'][0] ?? {})['@type']).toBe('WebSite');
    expect(blocks(req('/nope').body)).toHaveLength(0);
  });

  it('언어 누수 — 영어 페이지의 문구에 한글이 없다(언어 전환 링크 밖)', () => {
    const en = req('/en/email/sending').body.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '').replace(/lang="ko">한국어</g, '');
    expect(en.replace(/<[^>]+>/g, ' ')).not.toMatch(/[가-힣]/);
  });
});

describe('접근성 기본', () => {
  it('건너뛰기 링크 · 랜드마크(header·nav·main·footer) · main 하나 · h1 하나', () => {
    for (const path of ['/', '/en/get-started/quickstart', '/email/sending', '/nope', '/search']) {
      const html = req(path).body;
      expect(html, path).toContain('<a class="skip" href="#main">');
      expect(html.match(/<main id="main"/g)?.length, path).toBe(1);
      expect(html.match(/<h1[ >]/g)?.length, path).toBe(1);
      expect(html, path).toMatch(/<header class="top">/);
      expect(html, path).toMatch(/<footer class="foot">/);
      for (const nav of html.matchAll(/<nav\b([^>]*)>/g)) expect(nav[1], path).toMatch(/aria-label(ledby)?="/);
    }
  });

  it('현재 위치 표시 — 사이드바 aria-current="page" · 탭 aria-current · 이동 경로', () => {
    const html = req('/email/sending').body;
    expect(html).toContain('<li><a href="/email/sending" aria-current="page">보내기</a></li>');
    expect(html).toContain('<a href="/get-started/quickstart" aria-current="true">가이드</a>');
    expect(html).toContain('<li><span aria-current="page">보내기</span></li>');
  });

  it('목차 링크는 본문의 id 를 가리킨다', () => {
    const html = req('/get-started/quickstart').body;
    const toc = /<aside class="toc"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
    const targets = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(html).toContain(`id="${t}"`);
  });

  it('검색 대화상자 · 서랍 — 스크립트 없이도 링크·폼으로 동작한다', () => {
    const html = req('/email/sending').body;
    expect(html).toContain('<a class="search-b" href="/search" id="search-open"');
    expect(html).toContain('<form class="sd-f" action="/search" method="get" role="search">');
    expect(html).toContain('popovertarget="side"');
    expect(html).toContain('<nav class="side" id="side" popover aria-label="문서 목차">');
  });
});

describe('비평 4라운드 — 검색 · 서랍 · 스크린샷 · 기타', () => {
  it('/en.md 는 영어 홈의 마크다운 판과 같다', () => {
    expect(req('/en.md').body).toBe(req('/en/index.md').body);
  });

  it('검색 결과가 없으면 띄어쓰기 안내와 자주 찾는 문서(있는 것만)', () => {
    const html = req('/search', { query: 'q=zzzz' }).body;
    expect(html).toContain('띄어쓰기를 바꾸거나 더 짧은 낱말로 찾아 보세요.');
    expect(html).toContain('자주 찾는 문서');
    expect(html).toContain('<a href="/get-started/quickstart">빠른 시작</a>');
  });

  it('서랍 — 닫기 버튼(보이는 글자) · 언어 링크 · 테마 버튼', () => {
    const html = req('/email/sending').body;
    expect(html).toContain('<div class="side-x"><button type="button" popovertarget="side" popovertargetaction="hide">닫기</button></div>');
    expect(html).toContain('<div class="side-f"><a href="/en/email/sending" hreflang="en" lang="en">English</a><button type="button" class="theme-b theme-bl" hidden');
  });

  it('헤딩에 # 링크(보조기술에는 이름만)', () => {
    expect(req('/email/sending').body).toContain('<h2 id="modes">발신 모드<a class="ha" href="#modes" aria-label="이 절로 가는 링크"><span aria-hidden="true">#</span></a></h2>');
  });

  it('홈 — 탭 이름과 같은 그룹 이름은 되풀이하지 않는다(도움말 › 도움말)', () => {
    const html = req('/').body;
    const help = /<section class="idx-t" aria-labelledby="idx-help">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(help).toContain('<h2 id="idx-help">도움말</h2>');
    expect(help).not.toContain('<h3>도움말</h3>');
  });

  it('모바일 누름 영역 44px — 검색·테마·메뉴·작은 버튼·사이드바 링크 · 코드 복사 32–36px · 표 안 코드는 줄바꿈하지 않는다', () => {
    const mobile = [...DOCS_CSS.matchAll(/@media \(max-width:767px\)\{\n([\s\S]*?)\n\}/g)].map((m) => m[1] ?? '').join('\n');
    expect(mobile).toContain('.search-b{min-width:0;width:44px;height:44px');
    expect(mobile).toContain('.theme-b,.menu-b{width:44px;height:44px}');
    expect(mobile).toContain('.btn.sm{height:44px}');
    expect(mobile).toContain('.copy{height:36px}');
    expect(DOCS_CSS).toContain('.side li a{min-height:44px;');
    expect(DOCS_CSS).toContain('.copy{height:32px;');
    expect(DOCS_CSS).toContain('.tbl code,.prose .tbl :not(pre)>code{overflow-wrap:normal;word-break:normal;white-space:nowrap}');
    // 표는 칸이 좁아지면 글자 단위로 쪼개지지 않고 가로로 스크롤한다(코드는 한 줄 · 글 칸은 최소 13em).
    expect(DOCS_CSS).toContain('.tbl td:not(:first-child),.tbl th:not(:first-child){min-width:13em}');
  });
});

describe('보안 검토 · 비평 5라운드', () => {
  it('I4 — 모든 응답에 Permissions-Policy(강력 기능 끔)와 COOP same-origin', () => {
    for (const path of ['/', '/email/sending', '/nope', '/llms.txt', '/email/sending.md', '/search']) {
      const r = req(path);
      expect(r.headers['cross-origin-opener-policy'], path).toBe('same-origin');
      expect(r.headers['permissions-policy'], path).toMatch(/camera=\(\).*geolocation=\(\).*microphone=\(\)/);
    }
    expect(req('/favicon.svg').headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('L6 — 검색어를 화면에 되풀이할 때 60자에서 자른다', () => {
    const long = '가'.repeat(150);
    const html = req('/search', { query: `q=${encodeURIComponent(long)}` }).body;
    expect(html).toContain(`“${'가'.repeat(60)}…”`);
    expect(html).not.toContain('가'.repeat(61) + '”');
  });

  it('넓은 화면 사이드바는 머리 아래에 붙어 있다(sticky — popover 기본값 inset:0 을 top 으로 덮는다)', () => {
    const side = /\n\.side\{[^}]*\}/.exec(DOCS_CSS)?.[0] ?? '';
    expect(side).toContain('position:sticky;top:var(--header-h)');
    expect(side).toContain('right:auto;bottom:auto;left:auto');
    expect(side).not.toMatch(/inset:auto/);
  });

  it('검색 대화상자 — 고른 결과는 떠 있는 면과 다른 채움 + 왼쪽 선(어두운 테마에서도 보인다)', () => {
    expect(DOCS_CSS).toContain('.sd-r a:focus-visible,.sd-r a[aria-selected="true"]{background:var(--gray-200);box-shadow:inset 3px 0 0 var(--gray-1000)');
  });

  it('오른쪽 목차에 단계 제목(h3)을 넣지 않는다', () => {
    const html = req('/get-started/quickstart').body;
    const toc = /<aside class="toc"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? '';
    expect(toc).toContain('href="#준비물"');
    expect(toc).not.toContain('href="#가입"');
  });
});
