/**
 * src/site/abuse.ts — `GET /abuse`(영어)·`GET /kr/abuse`(한국어) 남용 신고(게이트 B 2026-10-01, 마케팅 계획 §5.1).
 *
 * 모든 에이전트가 한 도메인(`@atmark.ai`)을 함께 쓰므로, 그 도메인에서 온 원치 않는 메일을 **받은 사람**이 알릴 곳이 있어야 한다. 내용:
 * 보낼 곳(abuse@ — 크게) · 원본 헤더 첨부 안내 · 24시간 안 검토(계획 §5.1 이 정한 약속 — 이 페이지의 유일한 시간 문장) · 그다음 할 수 있는
 * 조치 · postmaster@ 도 닿는다. abuse@·postmaster@ 는 수신 전용 역할 주소다(RFC 2142 — `src/contact/intake.ts` `CONTACT_RECIPIENT_ADDRESSES`,
 * 운영자 메일함으로 전달). 꼬리의 안내 열에서 링크한다.
 *
 * 외부 링크는 문서의 "Atmark로 하면 안 되는 일" 하나뿐(같은 언어). 흑백 · 스크립트 없음.
 */

import { CONTACT_EMAIL, docsUrl, type SiteLang } from './constants';
import { buildSitePage, contactHtml, sitePath, type SitePage } from './page';

/** 신고 주소(수신 전용 역할 주소). 정본은 `src/identity/address.ts` `RECEIVE_ONLY_ADDRESSES` — 홈 번들은 `src/identity/**` 를 import 하지 않는다. */
export const ABUSE_EMAIL = 'abuse@atmark.ai';
export const POSTMASTER_EMAIL = 'postmaster@atmark.ai';

const mail = (address: string): string => `<a class="addr" href="mailto:${address}">${address}</a>`;

const COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '남용 신고 | Atmark',
    description: '@atmark.ai 주소에서 원치 않는 메일을 받았다면 abuse@atmark.ai로 원본 헤더와 함께 알려 주세요. 모든 신고를 24시간 안에 검토합니다.',
    kicker: '신뢰와 안전',
    h1: '남용 신고',
    intro:
      'Atmark의 모든 에이전트는 공유 도메인 @atmark.ai에서 메일을 보냅니다. @atmark.ai 주소에서 원치 않는 메일, 속이는 메일, 괴롭히는 메일을 받았다면 알려 주세요. 보낸 에이전트에 조치하겠습니다.',
    toLabel: '신고 보낼 곳',
    toNote: '모든 신고를 24시간 안에 검토합니다.',
    s1h: '함께 보내 주세요',
    s1a: '원본 메일을 첨부 파일(.eml)로 보내거나, 원본 헤더 전체를 본문에 붙여 넣어 주세요. 헤더에 어느 에이전트가 언제 보냈는지 나옵니다.',
    s1b: '대부분의 메일 앱에서는 &lsquo;원본 보기&rsquo;나 &lsquo;소스 보기&rsquo;에서 헤더를 볼 수 있습니다.',
    s1c: '무슨 일이 있었는지 한 줄 적어 주시면 도움이 됩니다.',
    s2h: '그다음',
    s2: '에이전트가 규칙을 어겼다면 그 에이전트의 발신을 멈추거나, 에이전트를 운영하는 조직을 정지할 수 있습니다. 조치 결과는 알려 드리지 못할 수 있습니다.',
    s2rules: `규칙은 <a href="${sitePath('ko', 'terms')}">이용약관</a>과 <a href="${docsUrl('ko')}/get-started/not-for">Atmark로 하면 안 되는 일</a>에 있습니다.`,
    s3h: '다른 주소',
    s3: `${mail(POSTMASTER_EMAIL)}로 보내도 저희에게 닿습니다. @atmark.ai의 메일 전달이나 메일 서버 문제는 이 주소로 보내 주세요.`,
    s3other: '그 밖의 문의: {contact}',
  },
  en: {
    title: 'Report abuse | Atmark',
    description: 'Got unwanted mail from an @atmark.ai address? Send it to abuse@atmark.ai with the original headers. We review every report within 24 hours.',
    kicker: 'Trust and safety',
    h1: 'Report abuse',
    intro:
      'Every agent on Atmark sends from the shared domain @atmark.ai. If mail from an @atmark.ai address was unwanted, deceptive or abusive, tell us and we will act on the agent that sent it.',
    toLabel: 'Send reports to',
    toNote: 'We review every report within 24 hours.',
    s1h: 'What to include',
    s1a: 'The original message as an attachment (.eml), or its full original headers pasted into your email. The headers show which agent sent it and when.',
    s1b: 'Most mail apps show the headers under &ldquo;Show original&rdquo; or &ldquo;View source&rdquo;.',
    s1c: 'A line about what happened, if you want to add one.',
    s2h: 'What happens next',
    s2: 'If an agent broke the rules, we can stop it from sending or suspend the organization that runs it. We may not be able to tell you the outcome.',
    s2rules: `The rules are in the <a href="${sitePath('en', 'terms')}">Terms</a> and in <a href="${docsUrl('en')}/get-started/not-for">What Atmark is not for</a>.`,
    s3h: 'Other addresses',
    s3: `${mail(POSTMASTER_EMAIL)} also reaches us. Use it for delivery or mail-server problems with @atmark.ai.`,
    s3other: 'Anything else: {contact}',
  },
};

function abusePage(lang: SiteLang): SitePage {
  const c = (key: string): string => COPY[lang][key] ?? '';
  return buildSitePage({
    lang,
    id: 'abuse',
    title: c('title'),
    description: c('description'),
    main:
      '<article class="wrap doc abuse">' +
      `<p class="kicker">${c('kicker')}</p>` +
      `<h1>${c('h1')}</h1>` +
      `<p class="intro">${c('intro')}</p>` +
      '<div class="ab-to">' +
      `<p class="ab-l">${c('toLabel')}</p>` +
      `<p class="ab-addr">${mail(ABUSE_EMAIL)}</p>` +
      `<p class="ab-n">${c('toNote')}</p>` +
      '</div>' +
      `<section><h2>${c('s1h')}</h2><ul class="list"><li>${c('s1a')}</li><li>${c('s1b')}</li><li>${c('s1c')}</li></ul></section>` +
      `<section><h2>${c('s2h')}</h2><p>${c('s2')}</p><p>${c('s2rules')}</p></section>` +
      `<section><h2>${c('s3h')}</h2><p>${c('s3')}</p>` +
      (CONTACT_EMAIL === null ? '' : `<p>${c('s3other').replace('{contact}', contactHtml(lang))}</p>`) +
      '</section>' +
      '</article>',
  });
}

export const ABUSE_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: abusePage('ko'), en: abusePage('en') };

/** 문구 키 집합(테스트 — 두 언어가 같다). */
export const ABUSE_COPY = COPY;
