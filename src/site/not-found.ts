/** src/site/not-found.ts — 없는 경로(404). 언어별 두 벌(`/en/…` 아래는 영어). 색인하지 않는다(대안 링크도 없다). */

import type { SiteLang } from './constants';
import { buildSitePage, sitePath, type SitePage } from './page';

const COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '페이지를 찾을 수 없습니다 | Atmark',
    description: '요청한 페이지가 없습니다.',
    h1: '페이지를 찾을 수 없습니다',
    body: '주소를 다시 확인하거나 홈으로 돌아가세요.',
    home: '홈으로',
  },
  en: {
    title: 'Page not found | Atmark',
    description: 'The page you asked for does not exist.',
    h1: 'Page not found',
    body: 'Check the address, or head back to the home page.',
    home: 'Back to home',
  },
};

function notFoundPage(lang: SiteLang): SitePage {
  const c = COPY[lang];
  return buildSitePage({
    lang,
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main:
      '<section class="wrap nf">' +
      '<p class="code" aria-hidden="true">404</p>' +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="muted">${c['body'] ?? ''}</p>` +
      `<div class="actions"><a class="btn" href="${sitePath(lang, 'home')}">${c['home'] ?? ''}</a></div>` +
      '</section>',
  });
}

export const NOT_FOUND_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: notFoundPage('ko'), en: notFoundPage('en') };
