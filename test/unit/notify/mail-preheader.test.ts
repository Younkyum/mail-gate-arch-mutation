/**
 * 미리보기 · 머리(2026-10-10 6차) — 모든 HTML 시스템 메일에서
 *   - 숨은 미리보기 문장은 제목 · 머리 · 본문(text 파트)에 그대로 없다(새 사실 하나를 더한다).
 *   - 머리(h1)는 제목과 글자 그대로 같지 않다.
 * 문의 전달(운영자 메일)은 text 만이라 대상이 아니다.
 */

import { describe, expect, it } from 'vitest';

import { CUSTOM_DOMAIN_SUSPENDED_REASONS } from '../../../src/domains/contract';
import { SUPPORTED_MAIL_LOCALES, type MailLocale } from '../../../src/i18n/locales';
import { renderApprovalNotification } from '../../../src/notify/approval-notification-template';
import { renderDomainNotice } from '../../../src/notify/domain-notice-template';
import { renderInviteMail } from '../../../src/notify/invite-template';
import { renderOpsCodeMail } from '../../../src/notify/ops-code-template';
import { renderOwnerLoginMail } from '../../../src/notify/owner-login-template';
import { renderQuarantineNotice } from '../../../src/notify/quarantine-notice-template';
import { renderSignupMail } from '../../../src/notify/signup-template';
import { renderWaitlistMail } from '../../../src/notify/waitlist-template';
import { renderWelcomeMail } from '../../../src/notify/welcome-template';

const EXP = new Date('2026-10-12T09:30:00Z');
const AID = '0123456789abcdef0123456789abcdef';

function unescape(value: string): string {
  return value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function mails(locale: MailLocale): [string, { subject: string; text: string; html: string }][] {
  const q = { agentId: AID, agentName: 'r', agentAddress: 'research@atmark.ai', messageCount: 3, scannerErrorCount: 0, firstAt: EXP, lastAt: EXP, senderDomains: ['github.com'], senderDomainCount: 2, unverifiedSenderCount: 0, suppressedCount: 0, suppressedAgentCount: 0, capReached: false };
  const d = { domain: 'shop.example.com', suspendedReason: null, daysLeft: null, primaryAgents: [], primaryAgentCount: 0 };
  const a = { approvalId: '9f3c2a7e-1b4d-4c8e-a5f0-2d6b7c8e9a01', agentName: 'b', agentAddress: 'billing@atmark.ai', expiresAt: EXP, link: 'https://api.atmark.ai/approve#atk_link_k1.a.b', items: [], itemCount: 1 };
  return [
    ['login', renderOwnerLoginMail({ code: '123456', expiresAt: EXP }, locale)],
    ['signup', renderSignupMail({ code: '123456', expiresAt: EXP }, locale)],
    ['invite', renderInviteMail({ link: 'https://console.atmark.ai/invite#t=x', inviterEmail: 'o@example.com', expiresAt: EXP }, locale)],
    ['waitlist', renderWaitlistMail({ kind: 'confirmation', email: 'j@example.com' }, locale)],
    ['waitlist-hold', renderWaitlistMail({ kind: 'confirmation', email: 'j@example.com', hold: true }, locale)],
    ['invitation', renderWaitlistMail({ kind: 'invitation', email: 'j@example.com' }, locale)],
    ['welcome', renderWelcomeMail(locale)],
    ['approval', renderApprovalNotification(a, locale)],
    ['approval-risk', renderApprovalNotification({ ...a, risk: { reasons: ['tainted_context'], sources: [] } }, locale)],
    ['block', renderQuarantineNotice(q, locale)],
    ['risk', renderQuarantineNotice({ ...q, kind: 'risk' }, locale)],
    ['signup-notice', renderQuarantineNotice({ ...q, kind: 'signup' }, locale)],
    ['enroll', renderQuarantineNotice({ ...q, kind: 'enroll', enrolledAgents: [{ name: 'x', address: 'x@atmark.ai' }] }, locale)],
    ...CUSTOM_DOMAIN_SUSPENDED_REASONS.map((reason): [string, ReturnType<typeof renderDomainNotice>] => [`domain-${reason}`, renderDomainNotice({ ...d, kind: 'suspended', suspendedReason: reason }, locale)]),
    ['domain-removal', renderDomainNotice({ ...d, kind: 'removal_d3' }, locale)],
    ['domain-removed', renderDomainNotice({ ...d, kind: 'removed' }, locale)],
    ['domain-verified', renderDomainNotice({ ...d, kind: 'verified' }, locale)],
    ['domain-recovered', renderDomainNotice({ ...d, kind: 'verified', recovered: true }, locale)],
    ['domain-expiry', renderDomainNotice({ ...d, kind: 'expiry_warning', daysLeft: 30 }, locale)],
    ['ops-login', renderOpsCodeMail({ purpose: 'login', code: '123456', expiresAt: EXP }, locale)],
    ['ops-access', renderOpsCodeMail({ purpose: 'access_request', code: '123456', expiresAt: EXP }, locale)],
    ['ops-step-up', renderOpsCodeMail({ purpose: 'step_up', code: '123456', expiresAt: EXP, action: 'org.activate', targetRef: 'K7QM' }, locale)],
  ];
}

describe.each(SUPPORTED_MAIL_LOCALES)('미리보기 · 머리 (%s)', (locale) => {
  it.each(mails(locale))('%s', (_id, mail) => {
    const preheader = unescape(/<div class="ph"[^>]*>([\s\S]*?)&#847;/.exec(mail.html)?.[1] ?? '');
    expect(preheader.length).toBeGreaterThan(0);
    expect(mail.subject).not.toContain(preheader);
    expect(mail.text).not.toContain(preheader);
    const h1 = unescape((/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(mail.html)?.[1] ?? '').replace(/<[^>]+>/g, ''));
    if (h1 !== '') expect(h1).not.toBe(mail.subject);
  });
});
