/**
 * 게이트 B(2026-10-01, 마케팅 계획 §5.1 · §2.4) — 새 페이지 둘(남용 신고 `/abuse` · 변경 내역 `/changelog`)과 공통 꼬리의 비제휴·상표 고지.
 * CSP · 외부 URL · 색 · 과장 금지 같은 공통 규율은 `site-pages.test.ts` 가 이 두 페이지에도 그대로 건다(RENDER 표). 여기서는 내용만 본다.
 */

import { describe, expect, it } from 'vitest';

import { ABUSE_COPY, ABUSE_EMAIL, POSTMASTER_EMAIL } from '../../../src/site/abuse';
import { CHANGELOG_COPY, changelogDays } from '../../../src/site/changelog';
import { CHANGELOG } from '../../../src/site/changelog-data';
import { docsUrl, effectiveDateText, SITE_ORIGIN, type SiteLang } from '../../../src/site/constants';
import { LLMS_TXT, SITEMAP_XML } from '../../../src/site/crawl';
import { SITE_ROUTES } from '../../../src/site/http';
import { renderAbusePage, renderChangelogPage, renderHomePage, renderPricingPage } from '../../../src/site/index';
import { CHROME_COPY, sitePath } from '../../../src/site/page';
import { RECEIVE_ONLY_ADDRESSES } from '../../../src/identity/address';

const LANGS = ['ko', 'en'] as const;

const text = (html: string): string =>
  html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');

const main = (html: string): string => /<main id="main">([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
const footer = (html: string): string => /<footer class="foot">[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';

describe('남용 신고 /abuse · /kr/abuse', () => {
  it('두 경로가 라우트에 있고, 문구 키 집합이 두 언어에서 같다', () => {
    expect(SITE_ROUTES['/abuse']).toBe(renderAbusePage('en'));
    expect(SITE_ROUTES['/kr/abuse']).toBe(renderAbusePage('ko'));
    expect(Object.keys(ABUSE_COPY.en).sort()).toEqual(Object.keys(ABUSE_COPY.ko).sort());
  });

  it('신고 주소는 수신 전용 역할 주소(abuse@ · postmaster@)와 같다 — 정본 `RECEIVE_ONLY_ADDRESSES`', () => {
    expect([...RECEIVE_ONLY_ADDRESSES].sort()).toEqual([ABUSE_EMAIL, POSTMASTER_EMAIL].sort());
  });

  it.each(LANGS)('%s — abuse@ 를 크게 · 원본 헤더 · 24시간 안 검토 · postmaster@ 도 닿는다 · 규칙 링크', (lang) => {
    const html = renderAbusePage(lang).html;
    const m = main(html);
    const t = text(m);
    expect(m).toContain(`<p class="ab-addr"><a class="addr" href="mailto:${ABUSE_EMAIL}">${ABUSE_EMAIL}</a></p>`);
    expect(m).toContain(`href="mailto:${POSTMASTER_EMAIL}"`);
    expect(t).toMatch(lang === 'en' ? /original headers/ : /원본 헤더/);
    expect(t).toMatch(lang === 'en' ? /within 24 hours/ : /24시간 안에 검토/);
    // 시간 문장은 하나뿐(보내는 곳 바로 아래) — 다른 약속을 늘리지 않는다.
    expect(t.match(/24/g)).toHaveLength(1);
    expect(m).toContain(`href="${sitePath(lang, 'terms')}"`);
    expect(m).toContain(`href="${docsUrl(lang)}/get-started/not-for"`);
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${sitePath(lang, 'abuse')}">`);
  });
});

describe('변경 내역 /changelog · /kr/changelog', () => {
  it('값 — ISO 날짜 · 최신이 위 · 두 언어 한 줄씩 · 10~15개 · 예정·구독 이야기 없음', () => {
    expect(CHANGELOG.length).toBeGreaterThanOrEqual(10);
    expect(CHANGELOG.length).toBeLessThanOrEqual(30);
    for (const entry of CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`))).toBe(false);
      for (const lang of LANGS) {
        const line = entry.text[lang];
        expect(line.trim(), `${entry.date} ${lang}`).not.toBe('');
        // 한 줄 — 블록 태그·줄바꿈 없음, 인라인은 <code> 만.
        expect(line, line).not.toMatch(/\n|<(?!\/?code>)[a-z/]/i);
        // 배포한 것만 — 예정·구독·알림 신청 금지(계획 §5.1).
        expect(line, line).not.toMatch(/\b(?:coming|launching) soon\b|\bplanned\b|roadmap|subscribe|\bRSS\b|예정|곧 |로드맵|구독|알림 신청/i);
      }
    }
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('같은 날 항목은 한 묶음 — 묶음 수 = 서로 다른 날짜 수, 순서는 값 파일 그대로', () => {
    const days = changelogDays();
    expect(days.map(([d]) => d)).toEqual([...new Set(CHANGELOG.map((e) => e.date))]);
    expect(days.flatMap(([, entries]) => entries)).toEqual([...CHANGELOG]);
  });

  it.each(LANGS)('%s — 날짜 머리(<time datetime>) · 항목 수 · 두 언어 같은 뼈대', (lang) => {
    const html = renderChangelogPage(lang).html;
    expect(SITE_ROUTES[sitePath(lang, 'changelog')]).toBe(renderChangelogPage(lang));
    const m = main(html);
    const days = changelogDays();
    expect(m.match(/<li class="cl-day">/g)).toHaveLength(days.length);
    for (const [date] of days) expect(m).toContain(`<h2 class="cl-date"><time datetime="${date}">${effectiveDateText(lang, date)}</time></h2>`);
    expect(m.match(/<ul class="cl-items"><li>|<\/li><li>/g)?.length).toBeGreaterThanOrEqual(CHANGELOG.length);
    expect(Object.keys(CHANGELOG_COPY.en).sort()).toEqual(Object.keys(CHANGELOG_COPY.ko).sort());
    const skeleton = (h: string): string => main(h).replace(/>[^<]*</g, '><');
    expect(skeleton(renderChangelogPage('en').html)).toBe(skeleton(renderChangelogPage('ko').html));
  });
});

describe('공통 꼬리 — 변경 내역 · 남용 신고 링크 · 비제휴·상표 고지', () => {
  it.each(LANGS)('%s — 모든 페이지의 꼬리에 링크 둘(변경 내역 · 남용 신고)', (lang: SiteLang) => {
    const c = CHROME_COPY[lang];
    for (const render of [renderHomePage, renderPricingPage, renderAbusePage, renderChangelogPage]) {
      const foot = footer(render(lang).html);
      expect(foot).toContain(`<a href="${sitePath(lang, 'changelog')}">${c['changelog'] ?? ''}</a>`);
      expect(foot).toContain(`<a href="${sitePath(lang, 'abuse')}">${c['abuse'] ?? ''}</a>`);
      expect(foot).toContain(`<p class="fcopy muted">${c['copyright'] ?? ''}</p>`);
    }
    // 상표 비제휴 고지는 넣지 않는다(2026-10-01 진윤겸).
    expect(c['trademark']).toBeUndefined();
  });
});

describe('사이트맵 · llms.txt', () => {
  it('두 페이지가 두 언어로 사이트맵과 llms.txt 에 있다', () => {
    for (const id of ['abuse', 'changelog'] as const) {
      for (const lang of LANGS) {
        expect(SITEMAP_XML).toContain(`<loc>${SITE_ORIGIN}${sitePath(lang, id)}</loc>`);
        expect(LLMS_TXT).toContain(`(${SITE_ORIGIN}${sitePath(lang, id)})`);
      }
    }
    expect(LLMS_TXT).toContain('- [Report abuse](https://atmark.ai/abuse): ');
    expect(LLMS_TXT).toContain('- [남용 신고](https://atmark.ai/kr/abuse): ');
    expect(LLMS_TXT).toContain('- [Changelog](https://atmark.ai/changelog): ');
  });
});
