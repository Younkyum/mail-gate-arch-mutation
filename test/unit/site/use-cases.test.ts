/**
 * 사용 예시(`/use-cases` · `/kr/use-cases`, 2026-10-01) — 여섯 가지의 순서 · 문서 링크가 실제 페이지·앵커 · 흐름 그림이 CSP 규칙을 지킨다 ·
 * 금지어 없음 · 머리·꼬리 링크 · 홈 카드 셋. CSP·외부 URL 허용 목록·hreflang 은 `site-pages.test.ts`(페이지 표에 들어 있다).
 */

import { describe, expect, it } from 'vitest';

import { docsIndex } from '../../../scripts/blog/build';
import { SITE_LANGS } from '../../../src/site/constants';
import { renderHomePage, renderUseCasesPage } from '../../../src/site/index';
import { CHROME_COPY, sitePath } from '../../../src/site/page';
import { flowLabel, USE_CASES, USE_CASES_COPY, useCaseDocsHref } from '../../../src/site/use-cases';
import { COPY_GUARD_BANNED, copyGuardHits, visibleText } from '../../support/copy-guard';

describe('사용 예시', () => {
  it('여섯 가지 · 이 순서 · 칩 2–3개 · 흐름 3–4칸(에이전트 하나)', () => {
    expect(USE_CASES.map((u) => u.id)).toEqual(['newsletter', 'digest', 'support', 'alerts', 'receipts', 'sign-ups']);
    for (const uc of USE_CASES) {
      expect(uc.features.length).toBeGreaterThanOrEqual(2);
      expect(uc.features.length).toBeLessThanOrEqual(3);
      expect(uc.flow.length).toBeGreaterThanOrEqual(3);
      expect(uc.flow.filter((n) => n.kind === 'agent')).toHaveLength(1);
    }
  });

  it('문서 링크는 실제 문서 페이지와 앵커다(두 언어)', () => {
    const docs = docsIndex();
    for (const uc of USE_CASES) {
      for (const lang of SITE_LANGS) {
        const [id = '', anchor] = uc.docs[lang].split('#');
        const page = docs[lang].get(id);
        expect(page, `${lang} ${uc.id} ${id}`).toBeDefined();
        if (anchor !== undefined) expect(page?.has(anchor), `${lang} ${uc.id} #${anchor}`).toBe(true);
      }
    }
  });

  it.each(SITE_LANGS)('%s 페이지 — 제목·상황·칩·시작 링크·흐름 그림(가로·세로, aria-hidden) · 하면 안 되는 일 링크 · CTA 하나', (lang) => {
    const html = renderUseCasesPage(lang).html;
    const main = /<main id="main">([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
    for (const uc of USE_CASES) {
      expect(main).toContain(`<li class="case" id="${uc.id}">`);
      expect(main).toContain(`<a href="${useCaseDocsHref(uc, lang)}">`);
      for (const f of uc.features) expect(main).toContain(`<li>${f[lang]}</li>`);
    }
    expect(main.match(/<svg class="fig-svg fh"/g)).toHaveLength(6);
    expect(main.match(/<svg class="fig-svg fv"/g)).toHaveLength(6);
    expect(main.match(/<div class="flow" role="img" aria-label="[^"]+">/g)).toHaveLength(6);
    for (const svg of main.matchAll(/<svg\b[^>]*>/g)) expect(svg[0]).toContain('aria-hidden="true"');
    // CSP: 그림 안에 style·이벤트·외부 참조·글자 색 없음.
    expect(main).not.toMatch(/\sstyle=|\son[a-z]+=|<style|<script|url\(|href="(?!https?:|\/|#)/);
    expect(main).not.toMatch(/(fill|stroke)="(?!none|currentColor)[^"]*"/);
    expect(main).toContain(`/get-started/not-for">${USE_CASES_COPY[lang]['notFor'] ?? ''}</a>`);
    expect(main.match(/class="btn"/g)).toHaveLength(1);
    expect(main).toContain(`href="${sitePath(lang, 'waitlist')}"`);
    expect(html).toContain(`<a href="${sitePath(lang, 'use-cases')}" aria-current="page">${CHROME_COPY[lang]['useCases'] ?? ''}</a>`);
  });

  it.each(SITE_LANGS)('%s 금지어 없음(렌더된 페이지) · 실제 사용 여부·인용 표시 없음', (lang) => {
    const html = renderUseCasesPage(lang).html;
    expect(copyGuardHits(visibleText(html), COPY_GUARD_BANNED)).toEqual([]);
    expect(visibleText(html)).not.toMatch(/“|”|real usage|실제 사용|we use|저희가 씁니다/i);
  });

  it('흐름 이름(보조기술)은 칸 이름을 화살표로 잇는다', () => {
    expect(flowLabel(USE_CASES[0]?.flow ?? [], 'en')).toBe('Sources (feeds, newsletters) → Agent (scout@atmark.ai) → Daily issue (written by the agent) → Your inbox (on its send allowlist)');
  });

  it.each(SITE_LANGS)('%s 홈 — 작동 방식 절에 카드 셋(앞의 세 가지) + 여섯 가지 보기 · 머리·꼬리에 사용 예시 링크', (lang) => {
    const html = renderHomePage(lang).html;
    const how = /<section class="sec tone" aria-labelledby="how-title">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(how.match(/<a class="ucard" href="[^"]+">/g)).toEqual(USE_CASES.slice(0, 3).map((uc) => `<a class="ucard" href="${sitePath(lang, 'use-cases')}#${uc.id}">`));
    expect(how).toContain(`<a class="uc-all" href="${sitePath(lang, 'use-cases')}">`);
    // 주 메뉴 · 모바일 메뉴 · 꼬리.
    expect(html.split(`<a href="${sitePath(lang, 'use-cases')}">${CHROME_COPY[lang]['useCases'] ?? ''}</a>`)).toHaveLength(4);
  });

  it('언어별 문구 키 집합이 같다', () => {
    expect(Object.keys(USE_CASES_COPY.ko).sort()).toEqual(Object.keys(USE_CASES_COPY.en).sort());
  });
});
