/**
 * src/site/changelog.ts — `GET /changelog`(영어)·`GET /kr/changelog`(한국어) 변경 내역(게이트 B 2026-10-01, 마케팅 계획 §5.1).
 *
 * **배포한 것만** 날짜와 한 줄로 적는다 — 예정 기능 · 메일 구독 · RSS 알림은 두지 않는다(계획 §5.1). 값은 `changelog-data.ts` 한 곳이고, 이
 * 파일은 그리기만 한다: 같은 날 항목을 한 묶음으로(날짜 = `<h2><time>`), 최신이 위. 넓은 화면은 왼쪽 날짜 칸 · 오른쪽 항목(가는 세로 선),
 * 좁은 화면은 날짜가 항목 위로 온다. 흑백 · 스크립트 없음 · 외부 링크 없음.
 */

import { CHANGELOG, type ChangelogEntry } from './changelog-data';
import { effectiveDateText, type SiteLang } from './constants';
import { buildSitePage, type SitePage } from './page';

const COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '변경 내역 | Atmark',
    description: 'Atmark에 배포한 변경을 날짜와 한 줄로 적습니다. 최신이 위에 있습니다.',
    kicker: '제품',
    h1: '변경 내역',
    lede: '배포한 것만 날짜와 한 줄로 적습니다. 최신이 위에 있습니다.',
  },
  en: {
    title: 'Changelog | Atmark',
    description: 'What we have shipped to Atmark, one line per change with its date. Newest first.',
    kicker: 'Product',
    h1: 'Changelog',
    lede: 'What we have shipped, one line per change with its date. Newest first.',
  },
};

/** 같은 날 항목끼리 — 값 파일의 순서(최신이 위)를 그대로 지킨다. */
export function changelogDays(entries: readonly ChangelogEntry[] = CHANGELOG): readonly (readonly [string, readonly ChangelogEntry[]])[] {
  const days: [string, ChangelogEntry[]][] = [];
  for (const entry of entries) {
    const last = days[days.length - 1];
    if (last !== undefined && last[0] === entry.date) last[1].push(entry);
    else days.push([entry.date, [entry]]);
  }
  return days;
}

function changelogPage(lang: SiteLang): SitePage {
  const c = COPY[lang];
  const days = changelogDays()
    .map(
      ([date, entries]) =>
        '<li class="cl-day">' +
        `<h2 class="cl-date"><time datetime="${date}">${effectiveDateText(lang, date)}</time></h2>` +
        `<ul class="cl-items">${entries.map((e) => `<li>${e.text[lang]}</li>`).join('')}</ul>` +
        '</li>',
    )
    .join('');
  return buildSitePage({
    lang,
    id: 'changelog',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main:
      '<article class="wrap cl">' +
      '<header class="cl-head">' +
      `<p class="kicker">${c['kicker'] ?? ''}</p>` +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="cl-lede">${c['lede'] ?? ''}</p>` +
      '</header>' +
      `<ol class="cl-list">${days}</ol>` +
      '</article>',
  });
}

export const CHANGELOG_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: changelogPage('ko'), en: changelogPage('en') };

/** 문구 키 집합(테스트 — 두 언어가 같다). */
export const CHANGELOG_COPY = COPY;
