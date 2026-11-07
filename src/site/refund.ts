/**
 * src/site/refund.ts — **환불 정책** `atmark.ai/refund` · `/en/refund`(WP-2 · 계획 §3-9 M6). Paddle 운영 도메인 승인은 약관·개인정보 안내·
 * **환불 정책** 페이지를 요구한다(계획 §0 P18).
 *
 * **결제 스위치와 무관하다.** 공개 여부는 `REFUND_POLICY_APPROVED`(`constants.ts`) 하나가 정한다 — 거짓이면 두 경로 모두 404 이고 푸터·가격
 * 페이지에 링크가 없다. 진윤겸이 이 초안 문안을 그대로 승인해(2026-09-26) 상수를 `true` 로 커밋했다(계획 §8-7). 결제를 끄고 켜는 일
 * (`atmark:billingEnabled`)이 이미 공개한 환불 정책을 내리지 않게 두 스위치를 나눴다.
 *
 * 내용의 뼈대(판매자 = Paddle · 환불 요청 창구 · 해지와 환불의 차이 · 문의처)는 Paddle 이 판매자(Merchant of Record)라는 사실에서 온다.
 * 외부 링크를 싣지 않는다(홈 페이지 공통 규칙 — `site-pages.test.ts` ④). Paddle 주문 조회 주소는 글자로만 적는다.
 */

import { effectiveDateText, type SiteLang } from './constants';
import { buildSitePage, contactHtml, type SitePage } from './page';

const COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '환불 정책 | Atmark',
    description: 'Atmark 유료 요금제의 결제·해지·환불 안내.',
    kicker: '안내',
    h1: '환불 정책',
    effective: '시행일',
    s1h: '1. 판매자',
    s1: 'Atmark 유료 요금제의 결제는 Paddle.com이 판매자(Merchant of Record)로서 처리합니다. 청구서·세금·결제 수단·환불 지급은 Paddle이 맡고, 카드 명세서에는 Paddle이 표시될 수 있습니다.',
    s2h: '2. 해지',
    s2: '구독은 콘솔의 결제 관리에서 언제든 해지할 수 있습니다. 해지하면 이미 결제한 기간이 끝날 때까지 요금제가 유지되고, 그 뒤에는 다시 청구되지 않습니다.',
    s3h: '3. 환불',
    s3: '첫 결제일로부터 14일 안에 요청하면 그 결제 금액 전액을 환불합니다. 갱신 결제는 갱신일로부터 14일 안에, 그 기간에 유료 요금제를 쓰지 않았다면 환불합니다. 법이 더 넓은 권리를 주는 경우에는 법을 따릅니다.',
    s4h: '4. 요청 방법',
    s4: 'Paddle이 보낸 영수증 메일의 안내나 paddle.net의 주문 조회에서 요청하거나, 아래 문의처로 조직 이름과 결제일을 알려 주세요. 환불은 원래 결제 수단으로 Paddle이 지급합니다.',
    s5h: '5. 환불되지 않는 경우',
    s5: '이용약관을 어겨 계정이 정지된 경우의 남은 기간, 그리고 위 기간이 지난 결제는 환불하지 않습니다.',
    s6h: '6. 문의',
  },
  en: {
    title: 'Refund Policy | Atmark',
    description: 'Payment, cancellation and refunds for Atmark paid plans.',
    kicker: 'Legal',
    h1: 'Refund Policy',
    effective: 'Effective',
    s1h: '1. Seller',
    s1: 'Payments for Atmark paid plans are processed by Paddle.com as Merchant of Record. Paddle handles invoices, tax, payment methods and refund payouts, and may appear on your card statement.',
    s2h: '2. Cancellation',
    s2: 'You can cancel a subscription at any time from billing in the console. After cancelling, your plan stays active until the end of the period you already paid for, and you are not charged again.',
    s3h: '3. Refunds',
    s3: 'If you ask within 14 days of your first payment, we refund that payment in full. A renewal payment is refunded if you ask within 14 days of the renewal date and have not used the paid plan in that period. Where the law gives you broader rights, the law applies.',
    s4h: '4. How to ask',
    s4: 'Use the link in the receipt email from Paddle or the order lookup at paddle.net, or write to the contact below with your organization name and payment date. Paddle pays refunds to the original payment method.',
    s5h: '5. When we do not refund',
    s5: 'We do not refund the remaining period of an account suspended for breaching the Terms, or payments outside the windows above.',
    s6h: '6. Contact',
  },
};

function refundPage(lang: SiteLang): SitePage {
  const c = COPY[lang];
  const section = (n: string): string => `<section><h2>${c[`s${n}h`] ?? ''}</h2><p>${c[`s${n}`] ?? ''}</p></section>`;
  return buildSitePage({
    lang,
    id: 'refund',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main:
      '<article class="wrap doc">' +
      `<p class="kicker">${c['kicker'] ?? ''}</p>` +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="meta">${c['effective'] ?? ''} ${effectiveDateText(lang)}</p>` +
      ['1', '2', '3', '4', '5'].map(section).join('') +
      `<section><h2>${c['s6h'] ?? ''}</h2><p>${contactHtml(lang)}</p></section>` +
      '</article>',
  });
}

/** 두 언어 한 벌 — 공개 여부는 `http.ts` 가 `REFUND_POLICY_APPROVED` 로 정한다. */
export const REFUND_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: refundPage('ko'), en: refundPage('en') };

/** 문구 키 집합(테스트 — 두 언어가 같다). */
export const REFUND_COPY = COPY;
