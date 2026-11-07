/**
 * 실제 문서 콘텐츠(`src/docs/content/**` → `src/docs/generated/content.json`) 전체에 대한 게이트:
 *   ① 생성 파일이 콘텐츠 폴더와 같다(콘텐츠를 고치고 `pnpm gen:docs` 를 안 돌리면 빨갛다).
 *   ② 엄격 빌드가 통과한다(문법 · ko/en 짝 · 링크·앵커 · related) · 참조한 스크린샷이 전부 찍혀 있다.
 *   ③ **가림(veil) 금지어 0** — 원문 두 언어(숨긴 기능 페이지 포함) + 렌더된 HTML · `.md` · llms 두 파일 · 사이트맵 · 검색 색인 전부.
 *      그리고 그 검사가 공허하지 않다(금지어를 넣으면 잡는다).
 *   ④ 접근성 기본 — 페이지마다 h1 하나 · 헤딩 단계를 건너뛰지 않는다 · 이미지에 대체 글 · JSON-LD 하나.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CONTENT_OUT, contentJson, readContentSources } from '../../../scripts/gen-docs';
import { veilHits, veilTextOfHtml, VEIL_ENV_PATTERN, VEIL_PATTERN } from '../../../scripts/docs-veil';
import { DOCS_LANGS } from '../../../src/docs/constants';
import { docsRuntime } from '../../../src/docs/http';
import { DOCS_SCRIPT } from '../../../src/docs/script';
import { buildDocsSite, groupHits, searchDocs } from '../../../src/docs/site';

const sources = readContentSources();

describe('① 생성 파일', () => {
  it('src/docs/generated/content.json 이 콘텐츠 폴더와 같다 (pnpm gen:docs)', () => {
    expect(readFileSync(CONTENT_OUT, 'utf8')).toBe(contentJson(sources));
  });

  it('두 언어에 페이지가 있고 짝이 맞는다', () => {
    expect(Object.keys(sources.ko).length).toBeGreaterThan(2);
    expect(Object.keys(sources.ko).sort()).toEqual(Object.keys(sources.en).sort());
  });
});

describe('② 엄격 빌드', () => {
  it('문법 · 링크 · 앵커 · related 가 전부 맞다', () => {
    const site = buildDocsSite(sources);
    expect(site.problems).toEqual([]);
    expect(site.ordered.ko.length).toBe(site.ordered.en.length);
  });

  it('문서 플래그를 켜도 엄격 빌드가 통과한다 — 숨긴 기능 페이지(별칭 · 첨부 · 고객 도메인)와 그리로 가는 링크 · 요금제 표 행 · 가림 0', () => {
    const on = buildDocsSite(sources, { features: { aliases: true, attachments: true, customDomains: true } });
    expect(on.problems).toEqual([]);
    const off = buildDocsSite(sources, { features: { aliases: false, attachments: false, customDomains: false } });
    for (const lang of DOCS_LANGS) {
      const ids = (site: typeof on) => site.ordered[lang].map((p) => p.id);
      for (const id of ['email/aliases', 'email/attachments', 'api/attachments', 'email/custom-domains']) {
        expect(ids(on), `${lang} ${id}`).toContain(id);
        expect(ids(off), `${lang} ${id}`).not.toContain(id);
      }
      const plans = (site: typeof on) => site.markdown.get(`${lang === 'en' ? '/en' : ''}/plans/plans-and-limits.md`) ?? '';
      const aliasRow = lang === 'en' ? 'Alias addresses per agent' : '에이전트당 별칭 주소';
      const attachRow = lang === 'en' ? 'Attachments per email' : '메일당 첨부 용량';
      expect(plans(on)).toContain(aliasRow);
      expect(plans(on)).toContain(attachRow);
      expect(plans(off)).not.toContain(aliasRow);
      expect(plans(off)).not.toContain(attachRow);
      // 켜진 페이지 쪽 절(:::feature)도 꺼지면 사라진다.
      const messages = (site: typeof on) => site.markdown.get(`${lang === 'en' ? '/en' : ''}/api/messages.md`) ?? '';
      expect(messages(on)).toContain('/api/attachments');
      expect(messages(off)).not.toContain('/api/attachments');
      // 고객 도메인(M4 — 기본은 꺼짐): 다른 페이지의 절도 꺼지면 사라진다.
      const addresses = (site: typeof on) => site.markdown.get(`${lang === 'en' ? '/en' : ''}/email/addresses.md`) ?? '';
      expect(addresses(on)).toContain('/email/custom-domains');
      expect(addresses(off)).not.toContain('/email/custom-domains');
    }
    const hits = [...on.pages.values()].flatMap((p) => veilHits(veilTextOfHtml(p.html)).map((h) => `${p.page.path}: ${h.match}`));
    expect(hits).toEqual([]);
  });

  it('참조한 스크린샷이 전부 찍혀 있다 (pnpm gen:docs-shots)', () => {
    expect(docsRuntime().site.missingShots).toEqual([]);
  });
});

describe('③ 가림(veil) 금지어', () => {
  it('원문 — 두 언어 모든 파일(꺼진 기능 페이지 포함)', () => {
    const hits = DOCS_LANGS.flatMap((lang) =>
      Object.entries(sources[lang]).flatMap(([id, text]) => veilHits(text).map((h) => `${lang}/${id}.md:${String(h.line)} "${h.match}" …${h.context}…`)),
    );
    expect(hits).toEqual([]);
  });

  it('생성물 — 페이지 HTML(스타일·스크립트 코드 제외) · .md · llms.txt · llms-full.txt · sitemap · 검색 색인 · 404', () => {
    const rt = docsRuntime();
    const outputs: [string, string][] = [
      ...[...rt.site.pages.entries()].map(([path, p]): [string, string] => [path, veilTextOfHtml(p.html)]),
      ...[...rt.site.markdown.entries()],
      ['/llms.txt', rt.crawl.llms],
      ['/llms-full.txt', rt.crawl.llmsFull],
      ['/sitemap.xml', rt.crawl.sitemap],
      ['/robots.txt', rt.crawl.robots],
      ...DOCS_LANGS.map((lang): [string, string] => [rt.site.search[lang].path, rt.site.search[lang].json]),
      ...DOCS_LANGS.map((lang): [string, string] => [`404 ${lang}`, veilTextOfHtml(rt.notFound[lang].html)]),
    ];
    expect(outputs.length).toBeGreaterThan(10);
    const hits = outputs.flatMap(([name, text]) => veilHits(text).map((h) => `${name}:${String(h.line)} "${h.match}" …${h.context}…`));
    expect(hits).toEqual([]);
  });

  it('공허하지 않다 — 금지어 표본마다 잡고, 허용 문구는 통과시킨다', () => {
    const caught = [
      'runs on AWS',
      'Amazon SES',
      'a Lambda function',
      'λ 하나',
      'stored in S3',
      'RDS Postgres',
      'PostgreSQL',
      'behind CloudFront',
      'see ADR-0013',
      'the runbook',
      '런북 참고',
      'src/policy/gate.ts',
      'run pnpm admin:plan',
      'ATMARK_BILLING_ENABLED',
      'org_entitlements table',
      'Stage 6 of the gate',
      'the outbox',
      'tlog anchor',
      'kill switch',
      'kill-switch',
      'warmup',
      'Paddle Billing API',
      '블록체인 신원',
      'NFT',
      'minted',
      '독립 검증',
      'independently verifiable',
      '변조 불가',
      'tamper-proof',
      'SOC 2',
      'ISO 27001',
      '99.9%',
      '99 %',
      'SLA',
      'uptime',
      'execute-api',
      'ap-northeast-2',
      'us-east-1',
      'a migration',
      'Cloudflare',
    ];
    for (const text of caught) expect(veilHits(text).length, text).toBeGreaterThan(0);
    const allowed = [
      'Paddle processes payments, tax and refunds as our Merchant of Record.',
      '결제와 세금, 환불은 Paddle이 판매자(Merchant of Record)로서 처리합니다.',
      'export ATMARK_AGENT_TOKEN=…',
      'mcp__atmark__send_email',
      '긴급 정지 · Emergency stop',
      'atk_agent_ 로 시작합니다',
      'api.atmark.ai/mcp · id.atmark.ai · console.atmark.ai',
      'Missions',
      'amazing',
    ];
    for (const text of allowed) expect(veilHits(text), text).toEqual([]);
    // 렌더된 HTML 에서도 잡는다(스타일·스크립트 코드만 뺀다).
    expect(veilHits(veilTextOfHtml('<style>a{width:100%}</style><p>stored in S3</p>'))).toHaveLength(1);
    expect(veilHits(veilTextOfHtml('<img alt="AWS console">'))).toHaveLength(1);
    expect(VEIL_PATTERN.flags).toContain('i');
    expect(VEIL_ENV_PATTERN.flags).not.toContain('i');
  });
});

describe('④ 접근성 기본 — 모든 페이지', () => {
  it('h1 하나 · 헤딩 단계를 건너뛰지 않는다 · 이미지 대체 글 · JSON-LD 하나', () => {
    const rt = docsRuntime();
    const problems: string[] = [];
    for (const [path, p] of rt.site.pages) {
      const main = /<main[\s\S]*?<\/main>/.exec(p.html)?.[0] ?? '';
      const levels = [...main.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
      if (levels.filter((l) => l === 1).length !== 1 || levels[0] !== 1) problems.push(`${path}: h1 하나로 시작하지 않는다`);
      for (let i = 1; i < levels.length; i += 1) {
        const prev = levels[i - 1] ?? 1;
        const cur = levels[i] ?? 1;
        if (cur > prev + 1) problems.push(`${path}: h${String(prev)} 다음 h${String(cur)}`);
      }
      for (const img of p.html.matchAll(/<img\b[^>]*>/g)) if (!/\salt="[^"]+"/.test(img[0])) problems.push(`${path}: 대체 글 없는 이미지`);
      if ((p.html.match(/<script type="application\/ld\+json">/g) ?? []).length !== 1) problems.push(`${path}: JSON-LD 가 하나가 아니다`);
      if (/\sstyle\s*=|\son[a-z]+\s*=|javascript:/i.test(p.html)) problems.push(`${path}: CSP 가 막을 마크업`);
    }
    expect(problems).toEqual([]);
  });
});

describe('⑤ 검색 — 한국어 띄어쓰기·음절 2-gram · 동의어 · 페이지별 묶음 · 서버와 브라우저가 같은 규칙', () => {
  const rt = docsRuntime();
  const ko = rt.site.search.ko.items;

  it.each([
    ['허용목록', '/email/allow-block-lists'],
    ['토큰교체', '/connect/tokens'],
    ['긴급정지', '/email/emergency-stop'],
  ])('"%s" 는 %s 를 찾는다(상위 셋 안)', (q, page) => {
    const groups = groupHits(searchDocs(ko, q));
    expect(groups.slice(0, 3).map((g) => g.best.item.u.split('#')[0])).toContain(page);
  });

  it('페이지별로 묶는다 — 한 페이지는 한 번, 더 맞은 절은 둘까지', () => {
    const groups = groupHits(searchDocs(ko, '토큰'));
    const pages = groups.map((g) => g.best.item.u.split('#')[0]);
    expect(new Set(pages).size).toBe(pages.length);
    for (const g of groups) {
      expect(g.more.length).toBeLessThanOrEqual(2);
      for (const m of g.more) expect(m.item.u.split('#')[0]).toBe(g.best.item.u.split('#')[0]);
    }
  });

  it('동의어(keywords)는 검색에만 — 본문에 없는 말로도 찾는다', () => {
    const items = [
      { t: '안전하게 설정하기', g: '시작하기', h: '', u: '/get-started/safe-setup', x: '처음 설정을 점검합니다.', k: '체크리스트' },
      { t: '다른 페이지', g: '시작하기', h: '', u: '/x', x: '아무 말' },
    ];
    expect(searchDocs(items, '체크리스트').map((h) => h.item.u)).toEqual(['/get-started/safe-setup']);
  });

  it('요약 글 — 표 칸·목록 항목은 " · " 로 잇고 점 줄임표(···)는 뺀다', () => {
    for (const item of ko) expect(item.x, item.u).not.toMatch(/···|⋯/);
    expect(ko.some((i) => i.x.includes(' · '))).toBe(true);
  });

  it('브라우저 검색(script.ts)이 서버 검색과 같은 순서를 낸다', () => {
    const src = /function terms\(q\)[\s\S]*?(?=function el\()/.exec(DOCS_SCRIPT)?.[0] ?? '';
    expect(src).not.toBe('');
    const clientSearch = new Function(`${src}; return search;`)() as (items: unknown, q: string) => { best: { it: { u: string } }; more: { it: { u: string } }[] }[];
    for (const q of ['허용목록', '토큰 교체', '긴급정지', 'webhook', '승인 링크', 'zzzz']) {
      const server = groupHits(searchDocs(ko, q)).map((g) => [g.best.item.u, ...g.more.map((m) => m.item.u)]);
      const client = clientSearch(ko, q).map((g) => [g.best.it.u, ...g.more.map((m) => m.it.u)]);
      expect(client, q).toEqual(server);
    }
  });
});
