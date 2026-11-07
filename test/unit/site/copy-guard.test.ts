/**
 * copy-guard — 검증할 수 없는 주장·경쟁사 겨냥 문구(마케팅 계획 2026-09-30 §9.1)가 사용자에게 보이는 글자에 다시 들어오지 않게 한다.
 * 금지어 목록은 `test/support/copy-guard.ts` 의 `COPY_GUARD_BANNED` 한 곳이다.
 *
 * 훑는 곳: 렌더된 홈 사이트 페이지(두 언어) · `/llms.txt` · 문서 값 파일(`src/docs/generated/content.json`, 두 언어 전 페이지) ·
 * 시스템 메일 템플릿(text/plain + text/html 의 보이는 글자) · 콘솔 문구 사전(`MESSAGES`) · MCP 도구 설명.
 *
 * 약관·개인정보 안내(`terms.ts`·`privacy.ts`)는 다른 작업이 고치는 중이라, 지금 걸리는 항목(`PENDING_OWNER_EDIT`)만 빼고 나머지 금지어를 건다 —
 * 그 파일이 고쳐지면 이 표에서 지운다(빠진 항목이 다시 들어오면 그대로 잡힌다).
 */

import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../../../src/admin/ui/i18n';
import { decodeDocsContent } from '../../../src/docs/content-data';
import DOCS_CONTENT from '../../../src/docs/generated/content.json';
import { MCP_TOOLS } from '../../../src/mcp/tools';
import { renderInviteMail } from '../../../src/notify/invite-template';
import { renderOpsCodeMail } from '../../../src/notify/ops-code-template';
import { renderOwnerLoginMail } from '../../../src/notify/owner-login-template';
import { renderSignupMail } from '../../../src/notify/signup-template';
import { renderWaitlistMail } from '../../../src/notify/waitlist-template';
import { renderWelcomeMail } from '../../../src/notify/welcome-template';
import { join } from 'node:path';

import { buildBlog, readBlogSources } from '../../../scripts/blog/build';
import { BLOG_SITE, buildBlogSite } from '../../../src/site/blog';
import { LLMS_TXT } from '../../../src/site/crawl';
import { SITE_ROUTES } from '../../../src/site/http';
import {
  renderAbusePage,
  renderChangelogPage,
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
  renderPricingPage,
  renderPrivacyPage,
  renderRefundPage,
  renderSignupPage,
  renderTermsPage,
  renderWaitlistPage,
} from '../../../src/site/index';
import { buildPayInfoPage } from '../../../src/site/pay';
import { COPY_GUARD_BANNED, copyGuardHits, ONVE_MAIL_BANNED, visibleText } from '../../support/copy-guard';

const LANGS = ['ko', 'en'] as const;
const EXPIRES = new Date('2026-09-24T01:02:03.000Z');
const CODE = '042917';

/** 다른 작업이 고치는 중인 페이지에서 지금 걸리는 항목 — 고쳐지면 지운다. */
const PENDING_OWNER_EDIT: Readonly<Record<string, readonly string[]>> = {
  privacy: [],
  terms: [],
};

describe('copy-guard — 사용자에게 보이는 글자에 금지어가 없다', () => {
  it.each(LANGS)('%s 홈 사이트 페이지(홈 · 가격 · 환불 · 로그인 · 가입 · 대기자 명단 · 남용 신고 · 변경 내역 · 404 · 결제 안내)', (lang) => {
    const pages = {
      home: renderHomePage(lang).html,
      pricing: renderPricingPage(lang).html,
      refund: renderRefundPage(lang).html,
      login: renderLoginPage(lang).html,
      signup: renderSignupPage(lang).html,
      waitlist: renderWaitlistPage(lang).html,
      // 게이트 B(2026-10-01) — 남용 신고 · 변경 내역.
      abuse: renderAbusePage(lang).html,
      changelog: renderChangelogPage(lang).html,
      notFound: renderNotFoundPage(lang).html,
      payInfo: buildPayInfoPage(lang).html,
    };
    for (const [name, html] of Object.entries(pages)) expect(copyGuardHits(visibleText(html)), `${lang}/${name}`).toEqual([]);
  });

  it.each(LANGS)('%s 약관 · 개인정보 안내 — 고치는 중인 항목만 빼고', (lang) => {
    for (const [name, html] of [
      ['terms', renderTermsPage(lang).html],
      ['privacy', renderPrivacyPage(lang).html],
    ] as const) {
      const pending = new Set(PENDING_OWNER_EDIT[name] ?? []);
      expect(copyGuardHits(visibleText(html)).filter((hit) => !pending.has(hit)), `${lang}/${name}`).toEqual([]);
    }
  });

  it('블로그 — 렌더된 목록·글(운영 공개 글 · 픽스처 · 초안 포함 원문 미리보기)과 RSS', () => {
    const sitePaths = new Set(Object.keys(SITE_ROUTES));
    const fixture = buildBlogSite(buildBlog(readBlogSources(join(__dirname, '../../fixtures/blog')), { drafts: false, sitePaths }).posts);
    // 초안도 렌더해 건다 — 공개 전에 걸리게(생성기도 같은 목록으로 글을 막는다).
    const drafts = buildBlogSite(buildBlog(readBlogSources(), { drafts: true, sitePaths }).posts, { drafts: true });
    let pages = 0;
    for (const site of [BLOG_SITE, fixture, drafts]) {
      for (const [path, page] of site.routes) {
        pages += 1;
        expect(copyGuardHits(visibleText(page.html)), path).toEqual([]);
      }
      for (const [path, feed] of site.feeds) expect(copyGuardHits(feed), path).toEqual([]);
    }
    expect(pages).toBeGreaterThanOrEqual(4);
    // 공허하지 않다 — 금지어가 든 본문은 잡힌다.
    expect(copyGuardHits(visibleText('<p>Our log is <b>immutable</b>.</p>'))).toEqual(['immutable']);
  });

  it('/llms.txt', () => {
    expect(copyGuardHits(LLMS_TXT)).toEqual([]);
  });

  it('문서 — 값 파일(content.json)의 두 언어 전 페이지', () => {
    const sources = decodeDocsContent(DOCS_CONTENT);
    let pages = 0;
    for (const lang of LANGS) {
      for (const [id, text] of Object.entries(sources[lang])) {
        pages += 1;
        expect(copyGuardHits(text), `${lang}/${id}`).toEqual([]);
      }
    }
    expect(pages).toBeGreaterThan(100);
  });

  it('시스템 메일 템플릿 — text/plain 과 text/html 의 보이는 글자', () => {
    const mails = Object.fromEntries(
      (['ko', 'en'] as const).flatMap((lang) => [
        [`welcome-${lang}`, renderWelcomeMail(lang)],
        [`waitlistConfirm-${lang}`, renderWaitlistMail({ kind: 'confirmation', email: 'a@example.com' }, lang)],
        [`waitlistInvite-${lang}`, renderWaitlistMail({ kind: 'invitation', email: 'a@example.com' }, lang)],
        [`invite-${lang}`, renderInviteMail({ link: 'https://console.atmark.ai/invite#t=atk_invite_k1.payload.sig', inviterEmail: 'lead@example.com', expiresAt: EXPIRES }, lang)],
        [`signup-${lang}`, renderSignupMail({ code: CODE, expiresAt: EXPIRES }, lang)],
        [`login-${lang}`, renderOwnerLoginMail({ code: CODE, expiresAt: EXPIRES }, lang)],
        [`opsLogin-${lang}`, renderOpsCodeMail({ purpose: 'login', code: CODE, expiresAt: EXPIRES }, lang)],
        [`opsAccess-${lang}`, renderOpsCodeMail({ purpose: 'access_request', code: CODE, expiresAt: EXPIRES }, lang)],
      ]),
    );
    for (const [name, mail] of Object.entries(mails)) {
      expect(copyGuardHits(`${mail.subject}\n${mail.text}`), `${name} text`).toEqual([]);
      expect(copyGuardHits(visibleText(mail.html)), `${name} html`).toEqual([]);
    }
    // onve@ 가 보내는 메일(환영 · 대기자 명단)은 거래성 메일 — 권유·기능 소개·요금제 이름이 없다.
    for (const [name, mail] of Object.entries(mails).filter(([key]) => key.startsWith('welcome') || key.startsWith('waitlist'))) {
      expect(copyGuardHits(`${mail.subject}\n${mail.text}`, ONVE_MAIL_BANNED), name).toEqual([]);
    }
  });

  it('콘솔 문구 사전(두 언어)', () => {
    for (const lang of LANGS) {
      const hits = Object.values(MESSAGES[lang]).flatMap((value) => copyGuardHits(value).map((hit) => `${hit}: ${value.slice(0, 80)}`));
      expect(hits, lang).toEqual([]);
    }
  });

  it('MCP 도구 설명', () => {
    for (const tool of MCP_TOOLS) expect(copyGuardHits(JSON.stringify(tool)), tool.name).toEqual([]);
  });
});

describe('copy-guard 검사기는 공허하지 않다', () => {
  it('금지어마다 걸리는 예문이 있다', () => {
    const samples: readonly string[] = [
      'An immutable log',
      '불변 기록',
      '기록은 고칠 수 없습니다',
      "Records can't be altered later",
      'Tamper-proof logs',
      '변조 불가능한 기록',
      'Safe by default',
      'Atmark blocks prompt injection',
      '인젝션을 막습니다',
      'Anyone can verify it',
      '누구나 검증할 수 있습니다',
      'Cryptographically proven',
      'The only email platform for agents',
      'Atmark is the first agent mail service',
      'Unlike others, we sign',
      '유일한 서비스',
      '업계 최초',
      'Launching soon',
      '곧 공개됩니다',
      "You're in!",
      "We'll email you when it's your turn",
      '차례가 오면 알려 드립니다',
      'AI가 위험한 메일을 막습니다',
      '수상한 메일은 자동으로 걸러 줍니다',
      'AI blocks malicious mail',
      'It catches all injection attempts',
      '100% 탐지',
      '완벽한 방어',
      'Perfect protection for your agents',
    ];
    const caught = new Set(samples.flatMap((sample) => copyGuardHits(sample)));
    for (const sample of samples) expect(copyGuardHits(sample), sample).not.toEqual([]);
    expect([...caught].sort()).toEqual(COPY_GUARD_BANNED.map((item) => item.name).sort());
    for (const sample of ['Upgrade to Pro', '새 기능을 소개합니다', 'Check out our new feature']) expect(copyGuardHits(sample, ONVE_MAIL_BANNED), sample).not.toEqual([]);
  });

  it('기능 설명의 only · first · 유일 · 차례, 공개 로그에 대한 tamper-evident 는 걸리지 않는다', () => {
    for (const sample of [
      'It replies only to people you allow.',
      'The only address people outside can look up is the primary one.',
      'it is the only Atmark link in this email',
      'For new organizations this limit rises over the first weeks after the first send.',
      '이 메일의 유일한 Atmark 링크입니다',
      '아래 여섯 가지를 차례로 확인합니다.',
      'Every message in and out is kept in a hash-chained record.',
      "If you're in the console, open Logs.",
      // 공개 투명성 로그가 운영 중이라 허용되는 말(리드 확인 2026-09-30).
      'Tamper-evident records',
      '변조 흔적이 남는 기록',
      'a rewritten past shows',
      '과거가 바뀌었을 때 드러납니다',
      // AI 의심 메일 감시 — 경고 전용이라고 말하는 문장(ADR-0017)은 걸리지 않는다.
      'AI 의심 메일 감시 — 경고만 붙이며 메일을 막지 않습니다.',
      'It adds a warning and never blocks or deletes mail.',
      'width: 100px · 99.100% 아님 · 1100%',
    ]) {
      expect(copyGuardHits(sample), sample).toEqual([]);
    }
  });

  it('보이는 글자로 풀어서 본다 — 엔티티·보이지 않는 글자·태그로 쪼갠 금지어도 잡는다', () => {
    expect(copyGuardHits(visibleText('<p>Tamper&shy;proof</p>'))).toContain('tamper-proof');
    expect(copyGuardHits(visibleText('<p>Immu\u200btable</p>'))).toContain('immutable');
    expect(copyGuardHits(visibleText('<meta name="description" content="Launching&nbsp;soon">'))).toContain('launching soon');
  });
});
