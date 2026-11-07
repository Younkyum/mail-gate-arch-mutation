/**
 * 홈 SEO·AEO(`.omc/research/seo-aeo-checklist.md` · 리드 판정 2026-09-27) — robots.txt · sitemap.xml(XML 파싱 · hreflang 쌍) · noindex ·
 * Open Graph/Twitter 필수 태그 · JSON-LD(JSON.parse + @type · 가격 표와 1:1) · 홈 FAQ 본문 = FAQPage · llms.txt · 제목·설명 길이 ·
 * 이미지 라우트(OG PNG 1200×630 · 히어로 WebP).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PLAN_CODES } from '../../../src/billing/plans';
import { CONTACT_EMAIL, SITE_CONTENT_DATE, SITE_LANGS, SITE_ORIGIN, type SiteLang } from '../../../src/site/constants';
import { AI_CRAWLERS, INDEXED_DOCUMENTS, LLMS_TXT, ROBOTS_TXT, SITEMAP_XML } from '../../../src/site/crawl';
import { HOME_COPY, HOME_FAQ_KEYS, homeFaq } from '../../../src/site/home';
import { handleSiteRequest, SITE_ROUTES, type SiteHttpEvent } from '../../../src/site/http';
import { OG_IMAGES } from '../../../src/site/image-data';
import { OG_IMAGE_HASH } from '../../../src/ui/og-version';
import { SITE_PHOTOS } from '../../../src/site/photo-data';
import { isIndexed, sitePath, type SiteDocumentId } from '../../../src/site/page';
import { PAY_INFO_PAGES } from '../../../src/site/pay';
import { planMonthlyUsd, pricingOffers } from '../../../src/site/pricing';
import { plainText } from '../../../src/site/seo';
import { metaContents } from '../../support/site-html';

const event = (path: string, method = 'GET', host = 'atmark.ai'): SiteHttpEvent => ({
  rawPath: path,
  headers: { host },
  requestContext: { domainName: host, http: { method } },
});

const ALL_IDS: readonly SiteDocumentId[] = ['home', 'use-cases', 'pricing', 'privacy', 'terms', 'refund', 'login', 'signup', 'abuse', 'changelog'];
const page = (lang: SiteLang, id: SiteDocumentId): string => SITE_ROUTES[sitePath(lang, id)]?.html ?? '';
// 2026-09-30 — 영어가 기본(접두어 없음), 한국어는 /kr 아래.
const notFound = (lang: SiteLang): string => handleSiteRequest(event(lang === 'ko' ? '/kr/nope' : '/nope')).body;


// ---------------------------------------------------------------------------
// 작은 XML 파서 — 잘 짜였는지(well-formed: 선언 · 여닫는 짝 · 속성 따옴표 · 알려진 엔티티) 보고 요소 트리를 돌려준다. 의존성 없이.
// ---------------------------------------------------------------------------

interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode {
  let rest = xml;
  const decl = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/.exec(rest);
  if (decl === null) throw new Error('XML 선언 없음');
  rest = rest.slice(decl[0].length);
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const token = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/y;
  while (rest.length > 0) {
    token.lastIndex = 0;
    const m = token.exec(rest);
    if (m === null) throw new Error(`XML 이 깨졌다: ${rest.slice(0, 40)}`);
    rest = rest.slice(m[0].length);
    const top = stack[stack.length - 1];
    if (top === undefined) throw new Error('스택이 비었다');
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error(`모르는 엔티티: ${m[5]}`);
      if (stack.length === 1 && m[5].trim() !== '') throw new Error('루트 밖 글자');
      top.text += m[5];
      continue;
    }
    const [, close, name = '', rawAttrs = '', selfClose] = m;
    if (close === '/') {
      if (top.name !== name) throw new Error(`짝이 안 맞는다: </${name}> (열린 것 ${top.name})`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      if (a[1] === undefined || Object.prototype.hasOwnProperty.call(attrs, a[1])) throw new Error('속성이 겹친다');
      attrs[a[1]] = a[2] ?? '';
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (selfClose !== '/') stack.push(node);
  }
  if (stack.length !== 1) throw new Error('닫히지 않은 요소');
  if (root.children.length !== 1) throw new Error('루트 요소는 하나');
  const only = root.children[0];
  if (only === undefined) throw new Error('루트 없음');
  return only;
}

describe('robots.txt', () => {
  it('200 · text/plain · 전부 허용 · AI 크롤러 이름별 허용 · Disallow 없음(로그인·가입도 크롤 허용 — noindex 를 읽게) · Sitemap 한 줄', () => {
    const res = handleSiteRequest(event('/robots.txt'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBe(ROBOTS_TXT);
    const lines = ROBOTS_TXT.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines.filter((l) => /^disallow:/i.test(l))).toEqual([]);
    const groups = ROBOTS_TXT.split(/\n\n+/).filter((g) => g.startsWith('User-agent:'));
    const agents = groups.map((g) => /^User-agent: (.+)$/m.exec(g)?.[1]);
    expect(agents).toEqual(['*', ...AI_CRAWLERS]);
    for (const g of groups) expect(g.trim().split('\n')[1]).toBe('Allow: /');
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot']) expect(AI_CRAWLERS).toContain(bot);
    expect(lines.filter((l) => l.startsWith('Sitemap:'))).toEqual([`Sitemap: ${SITE_ORIGIN}/sitemap.xml`]);
    expect(ROBOTS_TXT).toMatch(/^[\x0a\x20-\x7e]*$/);
    expect(handleSiteRequest(event('/robots.txt', 'HEAD')).body).toBe('');
  });
});

describe('sitemap.xml', () => {
  const tree = parseXml(SITEMAP_XML);
  // 블로그 항목(공개 글이 있을 때만 — 언어 짝이 없는 글은 hreflang 이 없다)은 `blog.test.ts` 가 따로 본다. 여기서는 두 언어 문서만.
  const isBlog = (u: XmlNode): boolean => /^https:\/\/atmark\.ai(\/kr)?\/blog(\/|$)/.test(u.children.find((c) => c.name === 'loc')?.text ?? '');
  const urls = tree.children.filter((u) => !isBlog(u));

  it('잘 짜인 XML · urlset 네임스페이스 둘 · 200 application/xml', () => {
    const res = handleSiteRequest(event('/sitemap.xml'));
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'application/xml; charset=utf-8', SITEMAP_XML]);
    expect(tree.name).toBe('urlset');
    expect(tree.attrs).toEqual({ xmlns: 'http://www.sitemaps.org/schemas/sitemap/0.9', 'xmlns:xhtml': 'http://www.w3.org/1999/xhtml' });
    expect(() => parseXml(SITEMAP_XML.replace('</loc>', '</lock>'))).toThrow();
    expect(() => parseXml(SITEMAP_XML.replace('https://', 'https://a&b'))).toThrow();
  });

  it('색인하는 페이지만(두 언어 각각) — 로그인·가입·404 없음 · lastmod 는 내용 날짜 상수', () => {
    expect([...INDEXED_DOCUMENTS].sort()).toEqual(ALL_IDS.filter((id) => isIndexed(id) && SITE_ROUTES[sitePath('ko', id)] !== undefined).sort());
    const locs = urls.map((u) => u.children.find((c) => c.name === 'loc')?.text);
    expect(locs).toEqual(INDEXED_DOCUMENTS.flatMap((id) => SITE_LANGS.map((l) => `${SITE_ORIGIN}${sitePath(l, id)}`)));
    expect(SITEMAP_XML).not.toMatch(/\/(login|signup)\b/);
    for (const u of urls) expect(u.children.find((c) => c.name === 'lastmod')?.text).toBe(SITE_CONTENT_DATE);
    expect(SITE_CONTENT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('hreflang 쌍 — 항목마다 ko·en·x-default=en(영어가 기본 — 2026-09-30), 그 값이 페이지 HTML 의 대안 링크·canonical 과 같다 · 모든 loc 가 200 · index', () => {
    for (const u of urls) {
      const loc = u.children.find((c) => c.name === 'loc')?.text ?? '';
      const links = u.children.filter((c) => c.name === 'xhtml:link');
      expect(links.map((l) => [l.attrs['rel'], l.attrs['hreflang']])).toEqual([
        ['alternate', 'ko'],
        ['alternate', 'en'],
        ['alternate', 'x-default'],
      ]);
      const path = loc.slice(SITE_ORIGIN.length) || '/';
      const res = handleSiteRequest(event(path));
      expect(res.statusCode, loc).toBe(200);
      expect(res.body).toContain(`<link rel="canonical" href="${loc}">`);
      expect(res.body).toContain('<meta name="robots" content="index,follow">');
      for (const l of links) expect(res.body).toContain(`<link rel="alternate" hreflang="${l.attrs['hreflang'] ?? ''}" href="${l.attrs['href'] ?? ''}">`);
      // 쌍: ko 항목과 en 항목의 묶음이 같다(서로를 가리킨다). x-default 는 영어(접두어 없는 경로), ko 는 /kr.
      expect(links.find((l) => l.attrs['hreflang'] === 'x-default')?.attrs['href']).toBe(links.find((l) => l.attrs['hreflang'] === 'en')?.attrs['href']);
      expect(links.find((l) => l.attrs['hreflang'] === 'en')?.attrs['href']).not.toMatch(/^https:\/\/atmark\.ai\/(kr|en)(\/|$)/);
      expect(links.find((l) => l.attrs['hreflang'] === 'ko')?.attrs['href']).toMatch(/^https:\/\/atmark\.ai\/kr(\/|$)/);
    }
    const bundles = urls.map((u) => JSON.stringify(u.children.filter((c) => c.name === 'xhtml:link').map((l) => l.attrs)));
    for (let i = 0; i < bundles.length; i += 2) expect(bundles[i]).toBe(bundles[i + 1]);
  });
});

describe('noindex', () => {
  it('로그인·가입·404·결제 안내는 noindex,follow · 나머지는 index,follow · noindex 페이지엔 JSON-LD 없음', () => {
    for (const lang of SITE_LANGS) {
      for (const id of ALL_IDS) {
        const html = page(lang, id);
        expect(metaContents(html, 'name', 'robots'), `${lang} ${id}`).toEqual([isIndexed(id) ? 'index,follow' : 'noindex,follow']);
        expect(html.includes('application/ld+json'), `${lang} ${id}`).toBe(isIndexed(id));
      }
      expect(metaContents(notFound(lang), 'name', 'robots')).toEqual(['noindex,follow']);
      expect(metaContents(PAY_INFO_PAGES[lang].html, 'name', 'robots')).toEqual(['noindex,follow']);
    }
    expect(isIndexed('login') || isIndexed('signup')).toBe(false);
  });
});

describe('Open Graph · Twitter 카드', () => {
  it.each(SITE_LANGS.flatMap((lang) => ALL_IDS.map((id) => [lang, id] as const)))('%s %s — 필수 태그 · 정본 URL · 언어별 로캘·이미지', (lang, id) => {
    const html = page(lang, id);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    const description = metaContents(html, 'name', 'description')[0] ?? '';
    const canonical = `${SITE_ORIGIN}${sitePath(lang, id)}`;
    const one = (attr: 'name' | 'property', key: string): string => {
      const v = metaContents(html, attr, key);
      expect(v, key).toHaveLength(1);
      return v[0] ?? '';
    };
    expect(one('property', 'og:type')).toBe('website');
    expect(one('property', 'og:site_name')).toBe('Atmark');
    expect(one('property', 'og:title')).toBe(title);
    expect(one('property', 'og:description')).toBe(description);
    expect(one('property', 'og:url')).toBe(canonical);
    expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
    expect(one('property', 'og:locale')).toBe(lang === 'ko' ? 'ko_KR' : 'en_US');
    expect(one('property', 'og:locale:alternate')).toBe(lang === 'ko' ? 'en_US' : 'ko_KR');
    expect(one('property', 'og:image')).toBe(`${SITE_ORIGIN}/og/${OG_IMAGES[lang].hash}/${lang}.png`);
    expect([one('property', 'og:image:type'), one('property', 'og:image:width'), one('property', 'og:image:height')]).toEqual(['image/png', '1200', '630']);
    expect(one('property', 'og:image:alt')).not.toBe('');
    expect(one('name', 'twitter:card')).toBe('summary_large_image');
    expect(one('name', 'twitter:title')).toBe(title);
    expect(one('name', 'twitter:description')).toBe(description);
    expect(one('name', 'twitter:image')).toBe(`${SITE_ORIGIN}/og/${OG_IMAGES[lang].hash}/${lang}.png`);
  });

  it('404 에는 없다 · 두 언어의 값이 서로 다르다', () => {
    for (const lang of SITE_LANGS) expect(notFound(lang)).not.toMatch(/og:|twitter:/);
    for (const id of ALL_IDS) {
      for (const key of ['og:title', 'og:description', 'og:url', 'og:image', 'og:locale']) {
        expect(metaContents(page('ko', id), 'property', key)).not.toEqual(metaContents(page('en', id), 'property', key));
      }
    }
  });
});

describe('JSON-LD', () => {
  const graph = (html: string): Record<string, unknown>[] => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('<');
    const doc = JSON.parse(blocks[0] ?? '') as { '@context': string; '@graph': Record<string, unknown>[] };
    expect(doc['@context']).toBe('https://schema.org');
    return doc['@graph'];
  };
  const TYPES: Readonly<Partial<Record<SiteDocumentId, readonly string[]>>> = {
    home: ['Organization', 'WebSite', 'FAQPage'],
    pricing: ['Organization', 'SoftwareApplication'],
    privacy: ['Organization'],
    terms: ['Organization'],
    refund: ['Organization'],
    'use-cases': ['Organization'],
    abuse: ['Organization'],
    changelog: ['Organization'],
  };

  it('JSON.parse · 페이지별 @type · 조직(이름·운영 주체·URL·로고·문의) — 로고 URL 이 실제로 열린다', () => {
    for (const lang of SITE_LANGS) {
      for (const id of INDEXED_DOCUMENTS) {
        const g = graph(page(lang, id));
        expect(g.map((n) => n['@type'])).toEqual(TYPES[id]);
        const org = g[0] ?? {};
        expect(org).toMatchObject({ name: 'Atmark', legalName: 'SHAKA', url: `${SITE_ORIGIN}/`, logo: `${SITE_ORIGIN}/favicon.svg` });
        if (CONTACT_EMAIL !== null) expect(org['email']).toBe(CONTACT_EMAIL);
      }
    }
    expect(handleSiteRequest(event('/favicon.svg')).statusCode).toBe(200);
    // 운영 주체는 약관 제1조와 이 조직 노드에만 있다 — 꼬리·홈 FAQ 에는 적지 않는다(진윤겸 2026-09-30, 운영자 질문을 뺐다).
    for (const lang of SITE_LANGS) {
      const visible = page(lang, 'home').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
      expect(visible).not.toMatch(/SHAKA|샤카|Younkyum|진윤겸/);
      expect(page(lang, 'home')).toContain('"legalName":"SHAKA"');
    }
  });

  it('SoftwareApplication 의 Offer = 가격 표 다섯 칸(이름·금액 · USD) — 가격 상수 하나에서', () => {
    for (const lang of SITE_LANGS) {
      const html = page(lang, 'pricing');
      const app = graph(html).find((n) => n['@type'] === 'SoftwareApplication') ?? {};
      expect(app['url']).toBe(`${SITE_ORIGIN}${sitePath(lang, 'pricing')}`);
      const offers = app['offers'] as { '@type': string; name: string; price: string; priceCurrency: string }[];
      expect(offers.map((o) => o.name)).toEqual(['Free', 'Beta', 'Pro', 'Team', 'Scale']);
      expect(offers).toEqual(pricingOffers().map((o) => ({ '@type': 'Offer', name: o.name, price: o.price, priceCurrency: 'USD' })));
      expect(offers.map((o) => Number(o.price))).toEqual(PLAN_CODES.map(planMonthlyUsd));
      // 표에 그 금액이 보인다(Beta 는 "베타 기간 무료" 글자 — 금액 칸이 아니다).
      for (const plan of ['free', 'pro', 'team', 'scale'] as const) expect(html).toContain(`<span class="amt">$${String(planMonthlyUsd(plan))}</span>`);
    }
  });
});

describe('홈 FAQ(AEO)', () => {
  const faqOf = (html: string): { q: string; a: string }[] =>
    [...html.matchAll(/<details><summary><h3>([\s\S]*?)<\/h3>[\s\S]*?<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => ({
      q: plainText(m[1] ?? ''),
      a: plainText(m[2] ?? ''),
    }));

  it.each(SITE_LANGS)('%s — 4~6개 · 질문형 · 첫 화면 아님(단계 절 뒤) · 본문 = FAQPage JSON-LD(1:1)', (lang) => {
    const html = page(lang, 'home');
    const body = faqOf(html);
    expect(body.length).toBeGreaterThanOrEqual(4);
    expect(body.length).toBeLessThanOrEqual(6);
    expect(body).toHaveLength(HOME_FAQ_KEYS.length);
    for (const e of body) expect(e.q.endsWith('?')).toBe(true);
    expect(html.indexOf('id="faq-title"')).toBeGreaterThan(html.indexOf('id="how-title"'));
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const faq = (JSON.parse(ld) as { '@graph': { '@type': string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] }[] })['@graph'].find(
      (n) => n['@type'] === 'FAQPage',
    );
    expect(faq?.mainEntity?.map((e) => ({ q: e.name, a: e.acceptedAnswer.text }))).toEqual(body);
    expect(homeFaq(lang).map((e) => ({ q: e.question, a: e.answer }))).toEqual(body);
    // 엔티티·태그가 새지 않는다(평문).
    for (const e of body) expect(`${e.q} ${e.a}`).not.toMatch(/[<>]|&[a-z]+;/);
  });

  it('첫 답은 정의문(Atmark 가 무엇인지) · 두 언어 키 집합이 같다', () => {
    // 2026-09-30 — 자기만의 이메일 주소가 먼저.
    expect(homeFaq('ko')[0]?.answer).toMatch(/^Atmark는 AI 에이전트에게 자기만의 이메일 주소와 신원을 발급하는 서비스입니다\./);
    expect(homeFaq('en')[0]?.answer).toMatch(/^Atmark is a service that gives AI agents an email address and an identity of their own\./);
    const keys = (lang: SiteLang): string[] => Object.keys(HOME_COPY[lang]).filter((k) => /^(q|a)\d$|^faq/.test(k)).sort();
    expect(keys('en')).toEqual(keys('ko'));
    expect(keys('ko')).toHaveLength(HOME_FAQ_KEYS.length * 2 + 2);
  });
});

describe('llms.txt', () => {
  it('200 text/plain · 제품 한 단락(두 언어 — 홈 FAQ 첫 답) · 주요 페이지 링크(두 언어, 색인 대상만)', () => {
    const res = handleSiteRequest(event('/llms.txt'));
    expect([res.statusCode, res.headers['content-type'], res.body]).toEqual([200, 'text/plain; charset=utf-8', LLMS_TXT]);
    expect(LLMS_TXT.startsWith('# Atmark\n\n> ')).toBe(true);
    for (const lang of SITE_LANGS) {
      expect(LLMS_TXT).toContain(`> ${homeFaq(lang)[0]?.answer ?? '∅'}`);
      for (const id of INDEXED_DOCUMENTS) expect(LLMS_TXT).toContain(`](${SITE_ORIGIN}${sitePath(lang, id)})`);
    }
    expect(LLMS_TXT).not.toMatch(/\/(login|signup)\)/);
    expect(LLMS_TXT).not.toMatch(/<|&[a-z]+;/);
  });
});

describe('제목·설명 길이(체크리스트 §1.7)', () => {
  const titleOf = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const descOf = (html: string): string => metaContents(html, 'name', 'description')[0] ?? '';
  const len = (s: string): number => [...s].length;

  it('홈·가격(유입 페이지)은 권장 범위 안 — ko 제목 28–34 · 설명 70–90 / en 제목 50–60 · 설명 120–156', () => {
    for (const id of ['home', 'pricing'] as const) {
      expect(len(titleOf(page('ko', id))), `ko ${id} title`).toBeGreaterThanOrEqual(28);
      expect(len(titleOf(page('ko', id))), `ko ${id} title`).toBeLessThanOrEqual(34);
      expect(len(descOf(page('ko', id))), `ko ${id} desc`).toBeGreaterThanOrEqual(70);
      expect(len(descOf(page('ko', id))), `ko ${id} desc`).toBeLessThanOrEqual(90);
      expect(len(titleOf(page('en', id))), `en ${id} title`).toBeGreaterThanOrEqual(50);
      expect(len(titleOf(page('en', id))), `en ${id} title`).toBeLessThanOrEqual(60);
      expect(len(descOf(page('en', id))), `en ${id} desc`).toBeGreaterThanOrEqual(120);
      expect(len(descOf(page('en', id))), `en ${id} desc`).toBeLessThanOrEqual(156);
    }
  });

  it('모든 페이지가 상한 안(잘리지 않게) · 제목·설명이 페이지·언어마다 고유하다', () => {
    const titles: string[] = [];
    const descs: string[] = [];
    for (const lang of SITE_LANGS) {
      for (const id of ALL_IDS) {
        const html = page(lang, id);
        expect(len(titleOf(html)), `${lang} ${id}`).toBeLessThanOrEqual(lang === 'ko' ? 34 : 60);
        expect(len(descOf(html)), `${lang} ${id}`).toBeLessThanOrEqual(lang === 'ko' ? 90 : 156);
        expect(len(descOf(html)), `${lang} ${id}`).toBeGreaterThan(20);
        titles.push(titleOf(html));
        descs.push(descOf(html));
      }
    }
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descs).size).toBe(descs.length);
  });
});

describe('이미지 라우트', () => {
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 16);

  it.each(SITE_LANGS)('OG %s — /og/<해시>/<lang>.png · 200 image/png · PNG 1200×630 · 1MB 미만 · 1년 immutable · 해시·크기 일치', (lang) => {
    const img = OG_IMAGES[lang];
    const hashed = `/og/${img.hash}/${lang}.png`;
    const res = handleSiteRequest(event(hashed));
    expect([res.statusCode, res.headers['content-type'], res.headers['cache-control'], res.isBase64Encoded]).toEqual([200, 'image/png', 'public, max-age=31536000, immutable', true]);
    const bytes = Buffer.from(res.body, 'base64');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect([img.width, img.height, img.bytes]).toEqual([1200, 630, bytes.length]);
    expect(bytes.length).toBeLessThan(1024 * 1024);
    expect(sha(bytes)).toBe(img.hash);
    const head = handleSiteRequest(event(hashed, 'HEAD'));
    expect([head.statusCode, head.body]).toEqual([200, '']);
  });

  it.each(SITE_LANGS)('OG %s — 옛 고정 경로 /og/<lang>.png 는 같은 바이트를 하루 캐시로 준다', (lang) => {
    const img = OG_IMAGES[lang];
    expect(img.path).toBe(`/og/${lang}.png`);
    const legacy = handleSiteRequest(event(img.path));
    expect([legacy.statusCode, legacy.headers['content-type'], legacy.headers['cache-control'], legacy.isBase64Encoded]).toEqual([200, 'image/png', 'public, max-age=86400', true]);
    const hashed = handleSiteRequest(event(`/og/${img.hash}/${lang}.png`));
    expect(legacy.body).toBe(hashed.body);
    expect(sha(Buffer.from(legacy.body, 'base64'))).toBe(img.hash);
    expect(handleSiteRequest(event(img.path, 'HEAD')).body).toBe('');
  });

  it('og-version.ts 의 OG_IMAGE_HASH 는 image-data.ts 의 OG_IMAGES[lang].hash 와 같다 — 두 생성 파일이 어긋나지 않는다', () => {
    for (const lang of SITE_LANGS) expect(OG_IMAGE_HASH[lang]).toBe(OG_IMAGES[lang].hash);
    expect(Object.keys(OG_IMAGE_HASH).sort()).toEqual([...SITE_LANGS].sort());
  });

  it('홈 사진 WebP — 사진마다 폭 두 벌 이상 · /img/<해시>/<사진>-<폭>.webp · 1년 immutable · RIFF/WEBP · 해시·크기가 경로·본문과 맞다 · 벌마다 같은 비율', () => {
    const names = Object.keys(SITE_PHOTOS) as (keyof typeof SITE_PHOTOS)[];
    expect(names.sort()).toEqual(['desk-window', 'post-boxes', 'window-light']);
    for (const name of names) {
      const set = SITE_PHOTOS[name];
      expect(set.length).toBeGreaterThanOrEqual(2);
      for (const img of set) {
        expect(img.path).toBe(`/img/${img.hash}/${name}-${String(img.width)}.webp`);
        const res = handleSiteRequest(event(img.path));
        expect([res.statusCode, res.headers['content-type'], res.headers['cache-control'], res.isBase64Encoded]).toEqual([200, 'image/webp', 'public, max-age=31536000, immutable', true]);
        const bytes = Buffer.from(res.body, 'base64');
        expect([bytes.subarray(0, 4).toString('latin1'), bytes.subarray(8, 12).toString('latin1')]).toEqual(['RIFF', 'WEBP']);
        expect([bytes.length, sha(bytes)]).toEqual([img.bytes, img.hash]);
        expect(bytes.length).toBeLessThan(500 * 1024);
        expect(img.width / img.height).toBeCloseTo((set[0]?.width ?? 0) / (set[0]?.height ?? 1), 2);
      }
    }
  });

  it('표에 없는 이미지 경로는 404 한 줄 · 결제 호스트에는 없다', () => {
    for (const path of ['/og/de.png', '/og/0000000000000000/ko.png', '/og/0000000000000000/de.png', `/og/${OG_IMAGES.en.hash}/ko.png`, '/img/0000/console-ko-light.webp', '/img/0000/desk-window-1200.webp', '/og/']) {
      const res = handleSiteRequest(event(path));
      expect([res.statusCode, res.body]).toEqual([404, 'Not Found\n']);
    }
    expect(handleSiteRequest(event('/og/ko.png', 'GET', 'pay.atmark.ai')).statusCode).toBe(404);
    expect(handleSiteRequest(event(`/og/${OG_IMAGES.ko.hash}/ko.png`, 'GET', 'pay.atmark.ai')).statusCode).toBe(404);
  });
});
