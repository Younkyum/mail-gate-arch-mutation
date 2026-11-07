/**
 * 감시 알림 메일(ADR-0016 2026-10-07 개정) — **한 통에 한 언어**(2026-10-10 — 받는 사람별) · 링크는 그 에이전트의 콘솔 수신 로그(차단 · 위험) 또는 감시 탭 하나 ·
 * **공격자가 고른 글자는 가입 감지의 검사한 도메인뿐**(자동 링크를 끊어 싣는다) · 도메인 모양 검사 · 과장 금지(copy-guard).
 * 2026-10-10 개편(진윤겸) — 짧게: 지금 상황 → 할 일. 판정 방식 · 묶음 간격 · 상한 규칙 · 보낸 곳 목록 같은 시스템 설명은 본문에 없다(콘솔).
 */

import { describe, expect, it } from 'vitest';

import {
  CONSOLE_AGENT_URL_PREFIX,
  defangDomain,
  isDisplayableSenderDomain,
  QUARANTINE_NOTICES_PER_ORG_PER_DAY,
  renderQuarantineNotice as renderOne,
  type QuarantineNoticeView,
} from '../../../src/notify/quarantine-notice-template';
import { copyGuardHits, visibleText } from '../../support/copy-guard';

const AGENT_ID = '0123456789abcdef0123456789abcdef';
const LINK = `${CONSOLE_AGENT_URL_PREFIX}${AGENT_ID}/logs/inbound`;

function view(overrides: Partial<QuarantineNoticeView> = {}): QuarantineNoticeView {
  return {
    agentId: AGENT_ID,
    agentName: 'Billing bot',
    agentAddress: 'billing-bot@atmark.ai',
    messageCount: 3,
    scannerErrorCount: 0,
    firstAt: new Date('2026-10-07T01:02:00.000Z'),
    lastAt: new Date('2026-10-07T01:09:00.000Z'),
    senderDomains: ['evil.example', 'mailer.test.co'],
    senderDomainCount: 2,
    unverifiedSenderCount: 0,
    suppressedCount: 0,
    suppressedAgentCount: 0,
    capReached: false,
    ...overrides,
  };
}

type Mail = ReturnType<typeof renderOne>;

/** 같은 창을 두 언어로(각각 한 통). `text` · `html` 은 둘을 이어 본다(어느 언어에도 없어야 하는 것을 볼 때). */
function both(input: QuarantineNoticeView): { ko: Mail; en: Mail; text: string; html: string } {
  const ko = renderOne(input, 'ko');
  const en = renderOne(input, 'en');
  return { ko, en, text: `${ko.text}\n${en.text}`, html: `${ko.html}\n${en.html}` };
}

function texts(mails: { ko: Mail; en: Mail }): { ko: string; en: string } {
  return { ko: mails.ko.text, en: mails.en.text };
}

describe('보낸 사람 도메인 검사', () => {
  it.each(['example.com', 'a.b.example.co.kr', 'xn--9n2bp8q.xn--3e0b707e', 'mail-1.example.io'])('받는다: %s', (domain) => {
    expect(isDisplayableSenderDomain(domain)).toBe(true);
  });

  it.each([
    '',
    'localhost',
    'Example.com',
    'exa mple.com',
    'example.com.',
    '-bad.example.com',
    'bad-.example.com',
    '10.0.0.1',
    'example.123',
    'ignore-previous-instructions.example.com/click',
    'evil.com"><script>',
    'evil‮.com',
    'a'.repeat(64) + '.com',
    `${'a.'.repeat(130)}com`,
  ])('버린다: %j', (domain) => {
    expect(isDisplayableSenderDomain(domain)).toBe(false);
  });

  it('자동 링크를 끊는다 — 점을 [.] 로', () => {
    expect(defangDomain('evil.example')).toBe('evil[.]example');
  });
});

describe('격리 알림 — 한 통에 한 언어 · 짧게', () => {
  const mail = both(view());

  it('제목은 상황 · 그 언어 하나 · 구분선 없음 · 링크 한 번 · 다른 URL 없음', () => {
    // 제목에 에이전트 짧은 이름(대표 주소의 로컬파트 — 2026-10-10 7차).
    expect(mail.ko.subject).toBe('billing-bot: 의심스러운 메일 3통 격리');
    expect(mail.en.subject).toBe('billing-bot: 3 suspicious emails quarantined');
    expect(renderOne(view({ agentAddress: null }), 'en').subject).toBe('3 suspicious emails quarantined');
    expect(renderOne(view({ agentAddress: null, messageCount: 1 }), 'en').subject).toBe('Suspicious email quarantined');
    for (const one of [mail.ko, mail.en]) {
      expect(one.text).not.toMatch(/^─{20,}$/m);
      expect(one.text.match(/https?:\/\/\S*/g)).toEqual([LINK]);
      expect(one.html).toContain(`href="${LINK}"`);
    }
    expect(`${mail.en.subject}\n${mail.en.text}`).not.toMatch(/[가-힣]/);
  });

  it('지금 상황(에이전트 주소 · 자동 격리) → 할 일(수신 로그에서 판정 확인) · 시스템 설명 없음', () => {
    const { ko, en } = texts(mail);
    expect(ko).toContain('billing-bot@atmark.ai 앞으로 온 메일 3통이 의심스러워 격리했습니다. 수신\u00a0로그에서 판정을 확인해 주세요.');
    expect(en).toContain('3 incoming emails to billing-bot@atmark.ai were quarantined as suspicious. Check the verdicts in the inbound log.');
    expect(en).not.toMatch(/[가-힣]/);
    // 보낸 곳 · 기간 · 사유 · 묶음 간격 · 상한 규칙 · 인젝션 용어는 본문에 없다(콘솔).
    expect(mail.text).not.toMatch(/evil|mailer|KST|UTC|15분|15 minutes|웹훅|webhook|프롬프트 인젝션|prompt injection|scanner|DMARC/i);
  });

  it('한 통이면 단수', () => {
    const one = both(view({ messageCount: 1, scannerErrorCount: 1 }));
    expect(one.ko.subject).toBe('billing-bot: 의심스러운 메일 1통 격리');
    expect(one.en.subject).toBe('billing-bot: suspicious email quarantined');
    expect(one.en.text).toContain('An incoming email to billing-bot@atmark.ai was quarantined as suspicious. Check the verdict in the inbound log.');
  });

  it('본문 낱말 수 — 꼬리 앞까지 60 이하', () => {
    for (const one of [mail.ko, mail.en]) {
      const body = one.text.split('\nAtmark · atmark.ai')[0] ?? '';
      const words = body.split('\n').filter((line) => !line.startsWith('https://')).join(' ').split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(60);
    }
  });

  it('상한 — 어느 감시 알림에도 상한 줄이 없다(2026-10-10 5차) · 규칙 · 못 알린 수도 없다', () => {
    const last = both(view({ capReached: true, suppressedCount: 7, suppressedAgentCount: 2 }));
    for (const kind of ['block', 'risk', 'signup', 'enroll', 'policy_request'] as const) {
      expect(both(view({ kind, capReached: true })).text, kind).not.toMatch(/More may follow|이후 건은/);
      expect(both(view({ kind, capReached: true })).text, kind).toBe(both(view({ kind, capReached: false })).text);
    }
    // 버튼(링크) 위에 선다.
    expect(last.text).not.toMatch(/24|paused|멈춥니다/);
    expect(last.text).not.toMatch(/7통|7 more|에이전트 2곳|2 agents/);
    expect(mail.text).not.toContain('24');
    expect(QUARANTINE_NOTICES_PER_ORG_PER_DAY).toBe(20);
  });

  it('에이전트 주소 모양이 아니면 이름을 정화해 싣는다 · HTML 은 이스케이프', () => {
    const odd = both(view({ agentName: 'bot‮<b>x</b>\u0007', agentAddress: 'not an address' }));
    const { ko, en } = texts(odd);
    expect(ko).toContain('bot<b>x</b> 앞으로');
    expect(en).toContain('to bot<b>x</b> were quarantined');
    expect(odd.text).not.toContain('not an address');
    expect(odd.text).not.toContain('‮');
    expect(odd.html).not.toContain('<b>x</b>');
    expect(odd.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('입력 모양을 닫는다 — 에이전트 id 32 hex · 수 1 이상', () => {
    expect(() => both(view({ agentId: 'x' }))).toThrow(/에이전트 id/);
    expect(() => both(view({ agentId: `${AGENT_ID}?q=1` }))).toThrow(/에이전트 id/);
    expect(() => both(view({ messageCount: 0 }))).toThrow(/격리 수/);
  });

  it('copy-guard — 과장 금지어가 없다(격리했다고만 말한다 · 막았다 · 공격이라 단정하지 않는다)', () => {
    const worst = both(view({ messageCount: 1, scannerErrorCount: 1, suppressedCount: 2, suppressedAgentCount: 1, capReached: true, unverifiedSenderCount: 1 }));
    for (const kind of ['block', 'risk', 'signup', 'enroll', 'policy_request'] as const) {
      const k = both(view({ kind, capReached: true }));
      for (const rendered of [k.ko, k.en]) expect(copyGuardHits(`${rendered.subject}\n${rendered.text}\n${visibleText(rendered.html)}`), kind).toEqual([]);
    }
    for (const rendered of [mail.ko, mail.en, worst.ko, worst.en]) {
      const all = `${rendered.subject}\n${rendered.text}\n${visibleText(rendered.html)}`;
      expect(copyGuardHits(all)).toEqual([]);
      expect(all).not.toMatch(/막았|차단했|공격|blocked|attack/i);
    }
  });
});

describe('위험 · 가입 감지 · 자가 등록 알림 — 짧게', () => {
  it('위험 — 상황 → 수신 로그 · 보류/전달 수 · 판정 설명 없음', () => {
    const risk = both(view({ kind: 'risk', heldCount: 1 }));
    expect(risk.ko.subject).toBe('billing-bot: 의심스러운 메일 3통이 에이전트에 도착했습니다');
    expect(risk.en.subject).toBe('billing-bot: 3 suspicious emails reached your agent');
    expect(risk.ko.text).toContain('billing-bot@atmark.ai 앞으로 의심스러운 메일 3통이 왔습니다. 수신\u00a0로그에서 확인해 주세요.');
    expect(risk.en.text).toContain('3 incoming emails to billing-bot@atmark.ai look suspicious. Review them in the inbound log.');
    // 받은 메일에는 "보류(hold)" 를 쓰지 않는다 — 보류는 보내는 메일의 낱말.
    expect(risk.text).not.toMatch(/보류|held|risky/i);
    expect(risk.ko.text.match(/https?:\/\/\S*/g)).toEqual([LINK]);
    expect(risk.text).not.toMatch(/보류 1통|Held 1|프롬프트 인젝션|prompt injection|감시 탭|Watch tab/);
  });

  it('가입 감지 — "에이전트가 <도메인> 외 N곳에 가입한 것 같습니다. 직접 시킨 일인지 확인해 주세요." · 도메인은 검사 · 끊어서 · 1개 + 나머지 수', () => {
    const many = both(
      view({ kind: 'signup', senderDomains: ['a.example', 'b.example', 'BAD.example', 'c.example', 'd.example', 'e.example', 'f.example'], senderDomainCount: 9 }),
    );
    expect(many.ko.subject).toBe('billing-bot: 서비스에 가입한 것 같습니다');
    expect(many.en.subject).toBe('billing-bot: may have signed up for a service');
    expect(many.ko.text).toContain('에이전트(billing-bot@atmark.ai)가 a[.]example 외 8곳에 가입한 것 같습니다. 감시 탭에서 확인해 주세요.');
    expect(many.en.text).toContain('Your agent billing-bot@atmark.ai seems to have signed up for a[.]example and 8 other services. Review it in the Watch tab.');
    expect(many.text).not.toContain('BAD');
    expect(many.text).not.toContain('b[.]example');
    expect(many.text).not.toMatch(/a\.example/);
    expect(visibleText(many.ko.html)).not.toMatch(/a\.example/);
    const none = both(view({ kind: 'signup', senderDomains: ['<x>'], senderDomainCount: 1 }));
    expect(none.ko.text).toContain('바깥 서비스에 가입한 것 같습니다');
    expect(none.en.text).toContain('signed up for an outside service.');
    expect(none.text).not.toContain('<x>');
  });

  it('자가 등록 — 만든 에이전트 · 새 주소(모양 검사) · 이름은 주소가 없을 때만 끊어서 · 콘솔에서 확인', () => {
    const enroll = both(
      view({
        kind: 'enroll',
        messageCount: 3,
        enrolledAgents: [
          { name: 'Click https://evil.example', address: 'helper-one@atmark.ai' },
          { name: 'Two', address: 'not an address' },
        ],
      }),
    );
    expect(enroll.ko.subject).toBe('billing-bot: 새 에이전트 3개 생성');
    expect(enroll.en.subject).toBe('billing-bot: created 3 new agents');
    expect(enroll.text).toContain('· helper-one@atmark[.]ai');
    expect(enroll.text).not.toContain('evil');
    expect(enroll.text).toContain('· Two');
    expect(enroll.ko.text).toContain('· Two\n외 1개\n');
    expect(enroll.en.text).toContain('· Two\nand 1 other agent\n');
    // 수는 제목에만 — 본문은 "…가 만든 에이전트:"(2026-10-10 6차).
    expect(enroll.en.text).toContain('Your agent billing-bot@atmark.ai created:\n');
    expect(enroll.ko.text).toContain('에이전트(billing-bot@atmark.ai)가 만든 에이전트:\n');
    expect(enroll.en.subject).toContain('3 new agents');
    expect(enroll.en.text).not.toContain('3 new agents');
    expect(enroll.text).not.toMatch(/organization:|조직에/);
    expect(enroll.ko.text).toContain('예상하지 못한 일이라면 콘솔에서 확인해 주세요.');
    expect(enroll.text).not.toMatch(/허용 목록|allowlist|안전 기본값|safe defaults/);
  });
});

/**
 * 도메인 표시(2026-10-10 진윤겸 결정):
 *   - 격리 · 위험(M8 · M9): 보낸 곳 도메인을 싣지 않는다 — 실린다면 두 파트 모두 `[.]`.
 *   - 가입 감지 · 자가 등록(M10 · M11): HTML 은 자연스러운 이름(점마다 인라인 요소 — 자동 링크 방지, 보이지 않는 문자 없음) · text 는 `[.]`.
 */
describe('도메인 표시 — HTML 자연스럽게(자동 링크 없이) · text 는 [.]', () => {
  const hostSpans = (html: string): string[] => [...html.matchAll(/<span class="host"[^>]*>((?:[^<]|<span class="hd">\.<\/span>)*)<\/span>/g)].map((m) => m[1] ?? '');
  const visible = (fragment: string): string => fragment.replace(/<[^>]+>/g, '');

  it.each(['ko', 'en'] as const)('가입 감지(%s) — HTML 은 github.com 으로 보이고 · 연속한 이름.이름 이 없다 · text 는 github[.]com', (locale) => {
    const mail = renderOne(view({ kind: 'signup', senderDomains: ['github.com', 'notion.so'], senderDomainCount: 3 }), locale);
    const spans = hostSpans(mail.html);
    expect(spans.length).toBe(1);
    for (const span of spans) {
      // 자동 링크기가 잡을 연속 `\w.\w` 가 한 텍스트 조각 안에 없다.
      expect(span.replace(/<span class="hd">\.<\/span>/g, '|')).not.toMatch(/\w\.\w/);
      expect(visible(span)).toBe('github.com');
      // 보이지 않는 문자(제로폭 · 단어 결합자)를 넣지 않는다 — 복사하면 그대로.
      expect(span).not.toMatch(/[\u200b-\u200d\u2060\ufeff]|&#8203;|&zwnj;|&#8288;/);
    }
    expect(mail.html).not.toMatch(/>[^<]*github\.com/);
    expect(mail.text).toContain('github[.]com');
    expect(mail.text).not.toContain('github.com');
  });

  it.each(['ko', 'en'] as const)('자가 등록(%s) — 새 에이전트 주소도 같은 규칙', (locale) => {
    const mail = renderOne(view({ kind: 'enroll', messageCount: 1, enrolledAgents: [{ name: 'x', address: 'helper-one@atmark.ai' }] }), locale);
    const spans = hostSpans(mail.html);
    expect(spans.map(visible)).toEqual(['helper-one@atmark.ai']);
    for (const span of spans) expect(span.replace(/<span class="hd">\.<\/span>/g, '|')).not.toMatch(/\w\.\w/);
    expect(mail.text).toContain('helper-one@atmark[.]ai');
  });

  it('도메인 모양 검사 · HTML 이스케이프는 그대로(모양이 틀린 값은 실리지 않는다)', () => {
    const mail = renderOne(view({ kind: 'signup', senderDomains: ['evil.com"><script>', 'ok.example'], senderDomainCount: 2 }), 'en');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('evil');
    expect(visible(hostSpans(mail.html)[0] ?? '')).toBe('ok.example');
  });

  it.each(['block', 'risk'] as const)('%s — 보낸 곳 도메인을 싣지 않는다(두 파트 모두) · host 조각 없음', (kind) => {
    for (const locale of ['ko', 'en'] as const) {
      const mail = renderOne(view({ kind, senderDomains: ['evil.example'] }), locale);
      expect(mail.html).not.toContain('class="host"');
      expect(`${mail.text}${mail.html}`).not.toMatch(/evil(\.|\[\.\])example/);
    }
  });
});

describe('정책 변경 요청 알림(ADR-0007 2026-10-13) — 수와 링크뿐', () => {
  it('한 건 · 여러 건 — 제목 · 본문 · 링크는 그 에이전트의 이메일 화면 · "승인하기 전에는 바뀌지 않는다"', () => {
    const one = both(view({ kind: 'policy_request', messageCount: 1 }));
    expect(one.en.subject).toBe('billing-bot: asks to change its email policy');
    expect(one.ko.subject).toBe('billing-bot: 메일 정책 변경 요청');
    expect(one.en.text).toContain('Your agent billing-bot@atmark.ai asked to change its email policy. Nothing changes until you approve.');
    expect(one.ko.text).toContain('승인하기 전에는 아무것도 바뀌지 않습니다.');
    expect(one.text).toContain(`${CONSOLE_AGENT_URL_PREFIX}${AGENT_ID}/email`);
    expect(one.text).not.toContain('/logs/inbound');
    const many = both(view({ kind: 'policy_request', messageCount: 3 }));
    expect(many.en.subject).toBe('billing-bot: asks to change its email policy (3 requests)');
    expect(many.ko.subject).toBe('billing-bot: 메일 정책 변경 요청 3건');
    expect(many.en.text).toContain('made 3 requests to change its email policy');
  });

  it('보낸 사람 도메인 · 격리 문구를 싣지 않는다(입력에 에이전트가 쓴 값 · 이유의 칸이 없다)', () => {
    const mail = both(view({ kind: 'policy_request', messageCount: 2 }));
    expect(mail.text).not.toContain('evil');
    expect(mail.text).not.toMatch(/quarantin|격리/i);
  });
});
