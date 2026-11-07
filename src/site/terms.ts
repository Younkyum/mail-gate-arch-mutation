/**
 * src/site/terms.ts — `GET /terms`(한국어)·`GET /en/terms`(영어) 이용약관.
 *
 * **두 언어 모두 법률 검토 전 초안이다** — 페이지에는 "초안" 표시를 하지 않고(계약 §6), 저장소 문서(`docs/runbooks/site.md`)에 기록한다.
 * 공개 전에 진윤겸 검토가 필요하다. 서비스가 실제로 하는 일(운영자 검토 뒤 외부 발송, 관문·승인, 운영자 동결)만 조항에 적는다.
 *
 * 2026-09-26 개정(진윤겸 승인) — '베타 서비스' 조의 "이용 요금이 생기면 알린다" 문장을 빼고 '요금제와 결제' 조를 새로 뒀다(Paddle 이
 * 판매자 · 월 자동 갱신 · 해지 · 환불 정책 · 가격 변경 통지 · 무료 베타 요금제). 제1조에 운영자(샤카, 대표 진윤겸)를 적는다 — Paddle 웹사이트
 * 심사가 약관에서 법적 판매자 이름을 본다. 사업자등록번호·주소는 공개 여부가 정해지지 않아 적지 않는다.
 * **금액·보상 수치·가용성 약속은 적지 않는다** — 금액은 가격 페이지(`/pricing`, `PLAN_MONTHLY_PRICE_USD`) 한 곳에만 두고 약관은 그리로 링크한다.
 */

import { effectiveDateText, REFUND_POLICY_APPROVED, TERMS_EFFECTIVE_DATE, type SiteLang } from './constants';
import { buildSitePage, contactHtml, sitePath, type SitePage } from './page';

type Article = readonly [title: string, body: string];

/** 약관 안의 다른 홈 문서 링크. 환불 정책은 공개 스위치(`REFUND_POLICY_APPROVED`)가 꺼지면 404 이므로 그때는 글자만 남긴다(가격 페이지와 같은 규칙). */
function docLink(lang: SiteLang, id: 'pricing' | 'refund', label: string): string {
  return id === 'refund' && !REFUND_POLICY_APPROVED ? label : `<a href="${sitePath(lang, id)}">${label}</a>`;
}

const KO: readonly Article[] = [
  [
    '목적',
    '<p>이 약관은 Atmark(이하 “서비스”)의 이용 조건과 절차, 서비스와 이용자의 권리·의무를 정합니다.</p>' +
      '<p>서비스 운영자: 샤카(개인사업자, 대표 진윤겸)</p>',
  ],
  [
    '정의',
    '<ol class="list">' +
      '<li>“소유자”는 서비스에 가입해 조직을 만들고 그 조직의 에이전트를 관리하는 사람입니다.</li>' +
      '<li>“조직”은 소유자가 가입할 때 만드는 단위로, 에이전트와 발송 정책이 여기에 속합니다.</li>' +
      '<li>“에이전트”는 소유자가 서비스에 등록해 @atmark.ai 주소로 메일을 주고받게 하는 소프트웨어입니다.</li>' +
      '<li>“토큰”은 에이전트가 서비스에 접속할 때 쓰는 비밀 값입니다.</li>' +
      '<li>“관문”은 에이전트의 모든 발송이 지나는 서비스의 정책 판정 단계입니다.</li>' +
      '</ol>',
  ],
  [
    '약관의 효력과 변경',
    '<p>이 약관은 서비스 화면에 게시해 효력이 생깁니다. 서비스는 관계 법령을 어기지 않는 범위에서 약관을 바꿀 수 있으며, 바꿀 때는 시행일과 이유를 시행 전에 게시합니다. 이용자에게 불리한 변경은 충분한 기간을 두고 알립니다. 바뀐 약관에 동의하지 않으면 이용을 멈추고 탈퇴할 수 있습니다.</p>',
  ],
  [
    '가입과 대기자 명단',
    '<ol class="list">' +
      '<li>서비스는 지금 <b>대기자 명단</b>으로 가입을 받습니다. 이메일 주소를 대기자 명단에 올리면, 운영자가 그 주소로 초대 메일을 보냅니다. 초대는 보낸 날로부터 14일 동안 유효합니다.</li>' +
      '<li>대기자 명단에 올렸다고 해서 초대를 약속하지는 않습니다. 운영자는 신청할 때 적은 이용 목적을 보고 초대를 조금씩 보냅니다.</li>' +
      '<li>가입은 초대받은 이메일 주소와 조직 이름을 적고, 그 주소로 온 확인 링크를 여는 것으로 이루어집니다. 가입한 조직은 별도의 검토 없이 바로 이용할 수 있습니다.</li>' +
      '<li>서비스는 남용이 우려되거나 가입 정보가 사실과 다른 경우 초대나 가입을 거절하거나, 가입한 조직의 외부 발송을 멈출 수 있습니다.</li>' +
      '</ol>',
  ],
  [
    '베타 서비스',
    '<p>서비스는 베타 단계입니다. 기능, 발송 한도, 화면은 예고 없이 바뀔 수 있고, 서비스가 중단되거나 지연될 수 있습니다. 서비스는 안정적으로 운영하려고 노력하지만 특정 수준의 가용성을 약속하지 않습니다.</p>',
  ],
  [
    '요금제와 결제',
    '<ol class="list">' +
      '<li>유료 요금제(Pro·Team·Scale)는 월 단위로 자동 갱신됩니다. 결제·세금·청구는 Paddle.com이 판매자(Merchant of Record)로서 처리하며, 결제에는 Paddle의 구매자 약관이 함께 적용됩니다.</li>' +
      `<li>유료 요금제는 콘솔의 결제 관리에서 언제든 해지할 수 있습니다. 해지해도 이미 결제한 기간이 끝날 때까지는 요금제가 유지됩니다. 환불은 ${docLink('ko', 'refund', '환불 정책')}을 따릅니다.</li>` +
      `<li>가격을 바꾸면 다음 갱신 전에 알립니다. 요금제와 가격은 ${docLink('ko', 'pricing', '가격 페이지')}에서 볼 수 있습니다.</li>` +
      '<li>베타 요금제는 운영자가 따로 정한 조직에 무료로 제공하며, 베타를 마치기 전에 미리 알립니다.</li>' +
      '</ol>',
  ],
  [
    '소유자의 책임',
    '<ol class="list">' +
      '<li>소유자는 자기 조직의 에이전트가 보내는 메일과 그 결과에 책임을 집니다.</li>' +
      '<li>소유자는 토큰을 안전하게 관리해야 하며, 유출이 의심되면 곧바로 토큰을 폐기하거나 에이전트를 정지해야 합니다.</li>' +
      '<li>소유자는 에이전트가 주고받는 메일에 포함된 상대방의 개인정보를 관계 법령에 따라 다뤄야 합니다.</li>' +
      '</ol>',
  ],
  [
    '금지 행위',
    '<p>이용자는 서비스로 다음 행위를 하거나 에이전트에게 시켜서는 안 됩니다.</p>' +
      '<ul class="list">' +
      '<li>수신자의 동의 없는 영리 목적의 광고성 정보 전송 등 「정보통신망 이용촉진 및 정보보호 등에 관한 법률」을 위반하는 메일 발송</li>' +
      '<li>피싱, 악성 코드 유포, 다른 사람이나 기관을 사칭하는 메일 발송</li>' +
      '<li>관문과 발송 정책을 우회하거나 무력화하려는 시도</li>' +
      '<li>다른 이용자나 서비스의 정상적인 운영을 방해하는 행위</li>' +
      '<li>그 밖에 관계 법령을 위반하는 행위</li>' +
      '</ul>',
  ],
  [
    '이용 제한',
    '<p>서비스는 이용자가 이 약관이나 관계 법령을 위반했거나, 발송이 수신자와 다른 이용자에게 피해를 줄 우려가 있으면 에이전트나 조직의 발송을 정지하거나 동결할 수 있습니다. 긴급하지 않은 경우에는 미리 알리고, 긴급한 경우에는 조치한 뒤 알립니다.</p>',
  ],
  [
    '서비스의 변경과 중단',
    '<p>서비스는 운영상·기술상 필요에 따라 서비스의 전부 또는 일부를 바꾸거나 중단할 수 있습니다. 서비스를 종료할 때는 상당한 기간을 두고 미리 알립니다.</p>',
  ],
  [
    '책임의 제한',
    '<p>서비스는 천재지변, 이용자의 귀책 사유, 외부 메일 서버의 수신 거부나 스팸 분류처럼 서비스가 통제할 수 없는 사유로 생긴 손해에 책임을 지지 않습니다. 다만 서비스의 고의나 중대한 과실로 생긴 손해는 예외로 합니다.</p>',
  ],
  [
    '탈퇴',
    '<p>소유자는 언제든 탈퇴를 요청할 수 있습니다. 탈퇴 요청을 받으면 그 조직의 에이전트 발송을 멈추고, 개인정보는 개인정보 처리 안내에 따라 처리합니다.</p>' +
      `<p>문의처: ${contactHtml('ko')}</p>`,
  ],
  [
    '준거법과 관할',
    '<p>이 약관은 대한민국 법에 따라 해석합니다. 서비스와 이용자 사이의 분쟁은 「민사소송법」에 따른 관할 법원에서 다룹니다.</p>',
  ],
];

const EN: readonly Article[] = [
  [
    'Purpose',
    '<p>These terms set out the conditions and procedures for using Atmark (&ldquo;the service&rdquo;) and the rights and obligations of the service and its users.</p>' +
      '<p>The service is operated by SHAKA, a sole proprietorship represented by Younkyum Jin, in the Republic of Korea.</p>',
  ],
  [
    'Definitions',
    '<ol class="list">' +
      '<li>&ldquo;Owner&rdquo; means the person who signs up, creates an organization and manages that organization&rsquo;s agents.</li>' +
      '<li>&ldquo;Organization&rdquo; means the unit an owner creates at sign-up; agents and sending policies belong to it.</li>' +
      '<li>&ldquo;Agent&rdquo; means software an owner registers with the service so that it can send and receive mail from an @atmark.ai address.</li>' +
      '<li>&ldquo;Token&rdquo; means the secret value an agent uses to connect to the service.</li>' +
      '<li>&ldquo;Gate&rdquo; means the policy-decision step that every message an agent sends passes through.</li>' +
      '</ol>',
  ],
  [
    'Effect and changes',
    '<p>These terms take effect when posted on the service. We may change them to the extent permitted by law; when we do, we will post the new terms, their effective date and the reason before they take effect, and give ample notice of changes that are unfavorable to you. If you do not agree to the changes, you may stop using the service and close your account.</p>',
  ],
  [
    'Sign-up and the waitlist',
    '<ol class="list">' +
      '<li>Sign-up is currently by <b>waitlist</b>. When you add your email address to the waitlist, we send an invitation to that address. An invitation is valid for 14 days from the day we send it.</li>' +
      '<li>Joining the waitlist does not mean you will be invited. We send invitations gradually, based on the intended use you tell us when you join.</li>' +
      '<li>You sign up by entering the invited email address and an organization name, then opening the confirmation link sent to that address. Your organization can start using the service right away, without a separate review.</li>' +
      '<li>We may decline an invitation or a sign-up, or stop outside email for an organization, where we suspect abuse or where sign-up details are not accurate.</li>' +
      '</ol>',
  ],
  [
    'Beta service',
    '<p>The service is in beta. Features, sending limits and screens may change without notice, and the service may be interrupted or delayed. We work to keep it running reliably but do not promise any particular level of availability.</p>',
  ],
  [
    'Plans and payment',
    '<ol class="list">' +
      '<li>Paid plans (Pro, Team and Scale) renew automatically every month. Paddle.com processes payments, tax and billing as our Merchant of Record, and Paddle&rsquo;s buyer terms also apply to your payment.</li>' +
      `<li>You can cancel a paid plan at any time from billing in the console. After you cancel, your plan stays active until the end of the period you have already paid for. Refunds follow our ${docLink('en', 'refund', 'Refund Policy')}.</li>` +
      `<li>If we change prices, we will tell you before your next renewal. Plans and prices are listed on our ${docLink('en', 'pricing', 'Pricing page')}.</li>` +
      '<li>The Beta plan is free for organizations we choose to grant it to. We will tell you before the beta ends.</li>' +
      '</ol>',
  ],
  [
    'Owner responsibilities',
    '<ol class="list">' +
      '<li>You are responsible for the mail your organization&rsquo;s agents send and for its consequences.</li>' +
      '<li>You must keep tokens secure, and revoke the token or suspend the agent right away if you suspect a leak.</li>' +
      '<li>You must handle the personal information of the people your agents correspond with in accordance with applicable law.</li>' +
      '</ol>',
  ],
  [
    'Prohibited use',
    '<p>You must not use the service, or have your agents use it, to:</p>' +
      '<ul class="list">' +
      '<li>send mail that violates the Act on Promotion of Information and Communications Network Utilization and Information Protection of Korea or similar laws, such as commercial advertising sent without the recipient&rsquo;s consent</li>' +
      '<li>send phishing, distribute malware, or impersonate another person or organization</li>' +
      '<li>bypass or disable the gate or the sending policy</li>' +
      '<li>interfere with other users or with the normal operation of the service</li>' +
      '<li>do anything else that violates applicable law</li>' +
      '</ul>',
  ],
  [
    'Restrictions',
    '<p>If you breach these terms or the law, or if your sending risks harming recipients or other users, we may suspend or freeze sending for an agent or for your organization. We will notify you in advance where possible, and afterwards when action has to be taken urgently.</p>',
  ],
  [
    'Changes to and suspension of the service',
    '<p>We may change or suspend all or part of the service for operational or technical reasons. If we shut the service down, we will give reasonable advance notice.</p>',
  ],
  [
    'Limitation of liability',
    '<p>We are not liable for losses caused by events beyond our control, such as natural disasters, causes attributable to you, or outside mail servers rejecting messages or classifying them as spam, except where the loss results from our intent or gross negligence.</p>',
  ],
  [
    'Closing your account',
    '<p>You may ask to close your account at any time. When we receive the request, we stop sending for your organization&rsquo;s agents and handle your personal information as described in the Privacy Notice.</p>' +
      `<p>Contact: ${contactHtml('en')}</p>`,
  ],
  [
    'Governing law and jurisdiction',
    '<p>These terms are governed by the laws of the Republic of Korea. Disputes between the service and its users are handled by the court with jurisdiction under the Civil Procedure Act of Korea.</p>' +
      '<p>This English version is provided for convenience. If it differs from the Korean version, the Korean version prevails.</p>',
  ],
];

const ARTICLES: Readonly<Record<SiteLang, readonly Article[]>> = { ko: KO, en: EN };

const PAGE_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '이용약관 | Atmark',
    description: 'Atmark 이용약관 — 가입과 대기자 명단, 베타 서비스, 소유자의 책임, 금지 행위.',
    kicker: '약관',
    toc: '목차',
    h1: '이용약관',
    meta: `시행일 ${effectiveDateText('ko', TERMS_EFFECTIVE_DATE)}`,
    addendum: '부칙',
    addendumBody: `이 약관은 ${effectiveDateText('ko', TERMS_EFFECTIVE_DATE)}부터 시행합니다.`,
  },
  en: {
    title: 'Terms of Service | Atmark',
    description: 'Atmark Terms of Service: sign-up and the waitlist, the beta service, owner responsibilities and prohibited use.',
    kicker: 'Legal',
    toc: 'Contents',
    h1: 'Terms of Service',
    meta: `Effective ${effectiveDateText('en', TERMS_EFFECTIVE_DATE)}`,
    addendum: 'Effective date',
    addendumBody: `These terms take effect on ${effectiveDateText('en', TERMS_EFFECTIVE_DATE)}.`,
  },
};

function heading(lang: SiteLang, index: number, title: string): string {
  return lang === 'ko' ? `제${String(index)}조 (${title})` : `${String(index)}. ${title}`;
}

/**
 * 목차(비평 R1-22 · 리드 승인 2026-09-27) — 개인정보 안내와 같은 모양. 조마다 `id="art-{n}"`, 부칙은 `art-effective`.
 * 조 번호는 법적 조항 번호(데이터)라 그대로 둔다 — 장식 번호가 아니다.
 */
function termsToc(lang: SiteLang): string {
  const c = PAGE_COPY[lang];
  const items = ARTICLES[lang].map(([title], i) => `<li><a href="#art-${String(i + 1)}">${heading(lang, i + 1, title)}</a></li>`).join('');
  return (
    `<nav class="toc" aria-label="${c['toc'] ?? ''}"><p class="toc-h" aria-hidden="true">${c['toc'] ?? ''}</p><ol>` +
    `${items}<li><a href="#art-effective">${c['addendum'] ?? ''}</a></li></ol></nav>`
  );
}

function termsPage(lang: SiteLang): SitePage {
  const c = PAGE_COPY[lang];
  return buildSitePage({
    lang,
    id: 'terms',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main:
      '<article class="wrap doc">' +
      `<p class="kicker">${c['kicker'] ?? ''}</p>` +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="meta">${c['meta'] ?? ''}</p>` +
      termsToc(lang) +
      ARTICLES[lang].map(([title, body], i) => `<section id="art-${String(i + 1)}"><h2>${heading(lang, i + 1, title)}</h2>${body}</section>`).join('') +
      `<section id="art-effective"><h2>${c['addendum'] ?? ''}</h2><p>${c['addendumBody'] ?? ''}</p></section>` +
      '</article>',
  });
}

export const TERMS_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: termsPage('ko'), en: termsPage('en') };
