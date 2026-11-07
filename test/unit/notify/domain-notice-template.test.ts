/**
 * 고객 도메인 알림 템플릿(ADR-0014 단계 4 M3b) — 순수 함수. 종류 · 사유마다 **한 통에 한 언어**(2026-10-10 — 받는 사람별) · 링크 하나(콘솔 도메인 설정) ·
 * 에이전트 이름 정화(`cleanAgentName` — 다른 알림이 쓴다) · HTML 이스케이프 · 과장 금지(copy-guard) · 여권 `domain_verified` 근거 문구(F-7)도 같은 금지어를 지난다.
 * 2026-10-10 개편 — "지금 상황 → 할 일" 두 문단, 레코드 이름 · 에이전트 목록 같은 자세한 내용은 콘솔에(본문에 없다).
 */

import { describe, expect, it } from 'vitest';

import { CUSTOM_DOMAIN_SUSPENDED_REASONS, DOMAIN_NOTICE_KINDS } from '../../../src/domains/contract';
import { SUPPORTED_MAIL_LOCALES } from '../../../src/i18n/locales';
import {
  AGENT_NAME_MAX,
  cleanAgentName,
  DOMAIN_SETTINGS_URL,
  MAX_AGENTS_SHOWN,
  renderDomainNotice as renderOne,
  type DomainNoticeView,
} from '../../../src/notify/domain-notice-template';
import { computeAttestations, DOMAIN_VERIFIED_BASIS } from '../../../src/passport/attestations';
import { copyGuardHits, visibleText } from '../../support/copy-guard';

const base: DomainNoticeView = {
  kind: 'removed',
  domain: 'agents.example.com',
  suspendedReason: null,
  daysLeft: null,
  primaryAgents: [],
  primaryAgentCount: 0,
};

/** 두 언어 메일을 함께 본다(각각 한 통) — 문구 단언은 어느 언어의 것이든 그 언어 메일에 있다. */
function renderDomainNotice(view: DomainNoticeView): { subject: string; text: string; html: string } {
  const ko = renderOne(view, 'ko');
  const en = renderOne(view, 'en');
  return { subject: `${ko.subject}\n${en.subject}`, text: `${ko.text}\n${en.text}`, html: `${ko.html}\n${en.html}` };
}

function views(): DomainNoticeView[] {
  const out: DomainNoticeView[] = [];
  for (const kind of DOMAIN_NOTICE_KINDS) {
    if (kind === 'suspended') for (const reason of CUSTOM_DOMAIN_SUSPENDED_REASONS) out.push({ ...base, kind, suspendedReason: reason });
    else if (kind === 'expiry_warning') for (const days of [30, 7]) out.push({ ...base, kind, daysLeft: days });
    else if (kind === 'verified') for (const recovered of [false, true]) out.push({ ...base, kind, recovered });
    else out.push({ ...base, kind });
  }
  return out;
}

describe('도메인 알림 템플릿', () => {
  it('종류 · 사유 전부 — 한 통에 한 언어 · 도메인 · 콘솔 링크 하나 · 영어 메일에 한글 없음', () => {
    for (const view of views()) {
      for (const locale of SUPPORTED_MAIL_LOCALES) {
        const mail = renderOne(view, locale);
        const label = `${view.kind}:${String(view.suspendedReason ?? view.daysLeft)}:${locale}`;
        expect(mail.text, label).not.toMatch(/^─{20,}$/m);
        expect(mail.html, label).toContain(`<div lang="${locale}">`);
        expect(mail.html, label).not.toContain(`<div lang="${locale === 'ko' ? 'en' : 'ko'}">`);
        expect(mail.text, label).toContain('agents.example.com');
        expect(mail.text.split(DOMAIN_SETTINGS_URL).length - 1, label).toBe(1);
        expect([...mail.subject].length, label).toBeLessThanOrEqual(60);
        expect(mail.subject, label).not.toContain(' · ');
        expect(`${mail.subject}\n${mail.text}`, label).not.toMatch(/DMARC|DKIM|TXT|CNAME|MX record|MX 레코드/);
        if (locale === 'en') expect(`${mail.subject}\n${mail.text}`, label).not.toMatch(/[가-힣]/);
        else expect(mail.subject, label).toMatch(/[가-힣]/);
      }
    }
  });

  it('기한은 남긴다 — 소유 확인 상실 14일 · 제거 3일', () => {
    expect(renderDomainNotice({ ...base, kind: 'suspended', suspendedReason: 'ownership_lost' }).text).toMatch(/14일 안에[\s\S]*within 14 days/);
    expect(renderDomainNotice({ ...base, kind: 'removal_d3' }).text).toMatch(/3일 뒤[\s\S]*in 3 days/);
  });

  it('종류마다 본문이 다르다 — 정지 사유 다섯 · 제거 예고 · 제거 · 만료 예고(30 · 7)', () => {
    const texts = views().map((view) => renderDomainNotice(view).text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(renderDomainNotice({ ...base, kind: 'expiry_warning', daysLeft: 7 }).text).toContain('약 7일');
    expect(renderDomainNotice({ ...base, kind: 'expiry_warning', daysLeft: 7 }).text).toContain('about 7 days');
  });

  it('콘솔과 같은 낱말 — "소유 확인" · "stopped"(소유 증명 · paused 없음) · 대표를 잃은 에이전트는 "대표 주소" 가 없다(별칭은 그대로)', () => {
    for (const view of views()) {
      const mail = renderDomainNotice(view);
      const all = `${mail.subject}\n${mail.text}`;
      expect(all, view.kind).not.toMatch(/소유 증명|paused|\bpause\b/i);
      expect(all, view.kind).not.toMatch(/(?<!대표 )주소가 없는 상태|have no address/);
    }
    const lost = renderDomainNotice({ ...base, kind: 'suspended', suspendedReason: 'ownership_lost' });
    expect(lost.subject).toContain('소유 확인');
    expect(renderDomainNotice({ ...base, kind: 'suspended', suspendedReason: 'operator' }).subject).toContain('stopped');
  });

  it('에이전트 목록은 싣지 않는다(콘솔) · cleanAgentName 은 다른 알림을 위해 그대로 정화한다', () => {
    const agents = Array.from({ length: MAX_AGENTS_SHOWN + 2 }, (_, i) => ({ name: `<script>Agent ${String(i)}</script>`, address: `a${String(i)}@agents.example.com` }));
    const mail = renderDomainNotice({ ...base, primaryAgents: agents.slice(0, MAX_AGENTS_SHOWN), primaryAgentCount: agents.length });
    expect(mail.text).not.toContain('a0@agents.example.com');
    expect(mail.html).not.toMatch(/<script>|&lt;script&gt;/);
    expect(cleanAgentName('<script>alert(1)</script>‮evil\u0000')).not.toContain('‮');
    expect(cleanAgentName('a'.repeat(100))).toHaveLength(AGENT_NAME_MAX);
    expect(cleanAgentName('​​')).toBe('—');
    expect(cleanAgentName('see https://evil.example now')).toBe('see hxxps[:]//evil[.]example now');
  });

  it('확인 완료(verified) — 제목에 도메인 이름(두 언어) · 이제 할 수 있는 일(주소 만들기) · 받는 데 남은 DNS 설정 안내 · 링크는 최상위 도메인 화면', () => {
    const mail = renderDomainNotice({ ...base, kind: 'verified' });
    // 제목은 호스트 이름이 먼저(2026-10-10 7차) · 머리는 일어난 일.
    expect(renderOne({ ...base, kind: 'verified' }, 'ko').subject).toBe('agents.example.com 확인 완료');
    expect(renderOne({ ...base, kind: 'verified' }, 'en').subject).toBe('agents.example.com is verified');
    expect(renderOne({ ...base, kind: 'verified' }, 'en').text.startsWith('Domain verified\n\nagents.example.com is verified and ready to use.')).toBe(true);
    expect(renderOne({ ...base, kind: 'verified', domain: 'a-very-long-subdomain-name.example.com' }, 'en').subject).toBe('a-very-long-subdomain-n… is verified');
    expect(mail.text).toContain('도메인 확인이 끝나 바로 쓸 수 있습니다.');
    expect(mail.html).toContain('Create agent addresses on it now.');
    expect(DOMAIN_SETTINGS_URL).toBe('https://console.atmark.ai/app#/domains');
    expect(renderOne({ ...base, kind: 'verified' }, 'en').text.split(DOMAIN_SETTINGS_URL).length - 1).toBe(1);
  });

  it('확인 완료 — 복귀 회차(recovered)는 문구가 따로 · DKIM 을 확인했다고 말하지 않는다 · 폐기된 주소는 저절로 돌아오지 않는다', () => {
    const mail = renderDomainNotice({ ...base, kind: 'verified', recovered: true });
    expect(renderOne({ ...base, kind: 'verified', recovered: true }, 'ko').subject).toBe('agents.example.com 다시 사용 가능');
    expect(renderOne({ ...base, kind: 'verified', recovered: true }, 'en').subject).toBe('agents.example.com can be used again');
    expect(mail.text).toContain('다시 쓸 수 있습니다');
    expect(mail.text).toContain('can be used again');
    expect(mail.text).toContain('필요한 주소는 콘솔에서 다시 만들어 주세요.');
    expect(mail.text).toContain('Create the addresses you need again in the console.');
    expect(mail.text).not.toMatch(/저절로|on their own/);
    expect(mail.text).not.toMatch(/DKIM/);
    expect(mail.text).not.toContain('도메인 확인이 끝났습니다.');
    expect(copyGuardHits(`${mail.subject}\n${mail.text}\n${visibleText(mail.html)}`)).toEqual([]);
    expect(renderDomainNotice({ ...base, kind: 'verified', recovered: false }).text).toBe(renderDomainNotice({ ...base, kind: 'verified' }).text);
  });

  it('도메인 모양이 아니면 던진다(보내지 않는다)', () => {
    expect(() => renderDomainNotice({ ...base, domain: 'Evil <x>.com' })).toThrow();
  });

  it('copy-guard — 알림 전부와 여권 domain_verified 근거 문구(두 언어)에 과장 금지어가 없다', () => {
    for (const view of views()) {
      const mail = renderDomainNotice(view);
      expect(copyGuardHits(`${mail.subject}\n${mail.text}\n${visibleText(mail.html)}`), view.kind).toEqual([]);
    }
    expect(copyGuardHits(`${DOMAIN_VERIFIED_BASIS.ko}\n${DOMAIN_VERIFIED_BASIS.en}`)).toEqual([]);
    expect(DOMAIN_VERIFIED_BASIS.en).toBe('Atmark verified TXT ownership and DKIM at signing time.');
  });
});

describe('여권 attestation — domain_verified(F-7)', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const facts = { agentCreatedAt: now, policyViolationCount: 0, conversationCount: 0, now };

  it('DB 판정(domainVerified)이 있으면 그것 · 없으면 atmark.ai 목록(옛 호출 그대로)', () => {
    expect(computeAttestations({ ...facts, addressDomain: 'agents.example.com', domainVerified: true })[0]).toMatchObject({ value: true, domain: 'agents.example.com' });
    expect(computeAttestations({ ...facts, addressDomain: 'agents.example.com' })[0]).toMatchObject({ value: false });
    expect(computeAttestations({ ...facts, addressDomain: 'atmark.ai' })[0]).toMatchObject({ value: true, domain: 'atmark.ai' });
  });

  it('대표 주소가 없으면 domain null · 거짓 · 넷의 순서는 그대로', () => {
    const list = computeAttestations({ ...facts, addressDomain: null, domainVerified: true });
    expect(list.map((attestation) => attestation.type)).toEqual(['domain_verified', 'no_policy_violations', 'account_age_bucket', 'successful_conversations_bucket']);
    expect(list[0]).toMatchObject({ type: 'domain_verified', value: false, domain: null });
  });
});
