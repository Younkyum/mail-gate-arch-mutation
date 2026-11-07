/**
 * 콘솔 용어 사전(`src/admin/ui/console/terms.ts` — 2026-10-15 UI 일관성 감사 §3.15). 두 언어 여섯 페이지의 렌더 결과(마크업 + 스크립트 문구)에
 * 사전의 `avoid` 가 나오지 않는지 본다. 같은 개념에 다른 낱말이 다시 들어오면 여기서 빨갛다.
 */
import { describe, expect, it } from 'vitest';

import { TERMS } from '../../../src/admin/ui/console/terms';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import {
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  type Lang,
} from '../../../src/admin/ui/index';

import { inlined } from './console-harness';

const PAGES = [renderAppPage, renderLoginPage, renderLoginLandingPage, renderSignupPage, renderSignupLandingPage, renderInvitePage] as const;
const html = (lang: Lang): string => PAGES.map((render) => inlined(render(lang))).join('\n');

describe('콘솔 용어 사전', () => {
  it('Ⓣ-1 사전 모양 — 한국어 이름이 있다(ID 처럼 라틴 그대로인 것도) · 영어 이름에 한글 없음 · 같은 한국어 이름이 두 번 없음', () => {
    const seen = new Set<string>();
    for (const t of TERMS) {
      expect(t.ko.trim().length, t.use).toBeGreaterThan(0);
      expect(/[가-힣]/.test(t.en), t.en).toBe(false);
      expect(seen.has(t.ko), t.ko).toBe(false);
      seen.add(t.ko);
      for (const a of t.allowKo ?? []) expect(t.avoidKo.some((w) => a.includes(w)), a).toBe(true);
    }
  });

  it('Ⓣ-2 한국어 페이지에 사전의 다른 이름이 없다', () => {
    const page = html('ko');
    const hits: string[] = [];
    for (const t of TERMS) {
      let text = page;
      for (const a of t.allowKo ?? []) text = text.split(a).join('');
      for (const w of t.avoidKo) if (text.includes(w)) hits.push(`${t.ko}: ${w}`);
    }
    expect(hits).toEqual([]);
  });

  // 영어 화면 글은 사전 값(Ⓣ-4)과 마크업이다 — 스크립트 코드의 이름(`x.epoch` 등)은 화면 글이 아니라 빼고 본다.
  it('Ⓣ-3 영어 페이지 마크업에 사전의 다른 이름이 없다', () => {
    const page = html('en').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    const hits = TERMS.flatMap((t) => t.avoidEn.filter((re) => re.test(page)).map((re) => `${t.en}: ${String(re)}`));
    expect(hits).toEqual([]);
  });

  it('Ⓣ-4 영어 사전 값에도 다른 이름이 없다(쓰이지 않는 화면 문구까지)', () => {
    const values = Object.values(MESSAGES.en).join('\n');
    const hits = TERMS.flatMap((t) => t.avoidEn.filter((re) => re.test(values)).map((re) => `${t.en}: ${String(re)}`));
    expect(hits).toEqual([]);
  });
});
