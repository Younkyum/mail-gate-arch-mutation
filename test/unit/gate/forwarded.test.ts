/**
 * `forwarded_from_human_mailbox` 판정식 (B2③) — 오탐·미탐 경계를 **결과로 고정**한다.
 *
 * "실측 대기" 절의 기대값은 **알려진 형태**(`owner+caf_=agent=atmark.ai@gmail.com`)에 대한 것이다.
 * 실측(`docs/runbooks/ac0-shadow-log.md` §4)이 다르면 `isForwardedFormOf` 와 이 절의 입력을 실측값으로 바꾼다.
 */

import { describe, expect, it } from 'vitest';

import { classifyForwarded, isForwardedFormOf, isHumanMailbox, type ForwardedEvidence } from '../../../src/gate/forwarded';

const OWNER = 'jinyounkyum@gmail.com';
const AGENT = 'jin-agent@atmark.ai';
const PARTNER = 'alice@partner.co.kr';

function evidence(overrides: Partial<ForwardedEvidence>): ForwardedEvidence {
  return {
    envelopeSender: PARTNER,
    fromAddress: PARTNER,
    forwardedForHeader: null,
    forwardedToHeader: null,
    envelopeRecipient: AGENT,
    ...overrides,
  };
}

describe('실측 대기 — Gmail `+caf_=` 꼬리 (알려진 형태, 실측 아님)', () => {
  it('Gmail 필터 전달: envelope = owner+caf_=agent=atmark.ai@gmail.com, From = 제3자 → 전달(caf_rewrite)', () => {
    const verdict = classifyForwarded(
      evidence({
        envelopeSender: 'jinyounkyum+caf_=jin-agent=atmark.ai@gmail.com',
        forwardedForHeader: `${OWNER} ${AGENT}`,
        forwardedToHeader: AGENT,
      }),
      [OWNER],
    );
    expect(verdict).toEqual({ forwarded: true, basis: 'caf_rewrite', mailbox: OWNER });
  });

  it('꼬리의 대상 부분은 검사하지 않는다(실측 전에는 넓게) — 다른 대상 인코딩도 전달', () => {
    expect(isForwardedFormOf('jinyounkyum+caf_=jin-agent=atmark.ai=x@gmail.com', OWNER)).toBe('caf_rewrite');
    expect(isForwardedFormOf('<JinYounkyum+CAF_=whatever@GMAIL.com>', OWNER)).toBe('caf_rewrite');
  });

  it('Gmail 점·googlemail.com 은 같은 계정이다', () => {
    expect(isForwardedFormOf('jin.youn.kyum+caf_=a=atmark.ai@googlemail.com', OWNER)).toBe('caf_rewrite');
  });

  it('caf_ 가 아닌 다른 꼬리는 전달 흔적이 아니다', () => {
    expect(isForwardedFormOf('jinyounkyum+newsletter@gmail.com', OWNER)).toBeNull();
  });

  it('다른 사람의 caf_ 형태는 우리 대표의 전달이 아니다', () => {
    const verdict = classifyForwarded(evidence({ envelopeSender: 'someoneelse+caf_=jin-agent=atmark.ai@gmail.com' }), [OWNER]);
    expect(verdict.forwarded).toBe(false);
  });
});

describe('계획 B2③ 원형 — Return-Path == 창업자 주소 AND From == 제3자', () => {
  it('꼬리 없는 대표 주소 + 제3자 From → 전달(mailbox_itself)', () => {
    expect(classifyForwarded(evidence({ envelopeSender: OWNER }), [OWNER])).toEqual({
      forwarded: true,
      basis: 'mailbox_itself',
      mailbox: OWNER,
    });
  });
});

describe('오탐 방지 — 전달이 아닌 것', () => {
  it('대표가 에이전트에게 **직접** 쓴 메일(envelope = 대표, From = 대표) → 전달 아님(owner_authored)', () => {
    const verdict = classifyForwarded(evidence({ envelopeSender: OWNER, fromAddress: OWNER }), [OWNER]);
    expect(verdict).toEqual({ forwarded: false, reason: 'owner_authored', auxiliarySignal: false });
  });

  it('대표가 자기 메일을 자기에게 전달한 것(From = 대표, caf 꼬리) → 전달 아님 — 상대가 옛 주소로 보낸 메일이 아니다', () => {
    const verdict = classifyForwarded(
      evidence({ envelopeSender: 'jinyounkyum+caf_=jin-agent=atmark.ai@gmail.com', fromAddress: 'jin.younkyum@gmail.com' }),
      [OWNER],
    );
    expect(verdict.forwarded).toBe(false);
  });

  it('"다른 주소에서 보내기" 별칭으로 직접 쓴 메일 — 별칭이 목록에 있으면 전달 아님', () => {
    const alias = 'jin@mycompany.kr';
    const direct = evidence({ envelopeSender: OWNER, fromAddress: alias });
    expect(classifyForwarded(direct, [OWNER, alias]).forwarded).toBe(false);
  });

  it('…별칭이 목록에 **없으면 오탐**(전달로 센다) — 런북이 별칭 전부를 넣으라고 하는 이유를 고정한다', () => {
    const direct = evidence({ envelopeSender: OWNER, fromAddress: 'jin@mycompany.kr' });
    expect(classifyForwarded(direct, [OWNER]).forwarded).toBe(true);
  });

  it('제3자가 에이전트 주소로 직접 보낸 메일(전환 완료 상태) → 전달 아님', () => {
    expect(classifyForwarded(evidence({}), [OWNER])).toEqual({
      forwarded: false,
      reason: 'envelope_not_human_mailbox',
      auxiliarySignal: false,
    });
  });

  it('Gmail 전달 주소 확인 메일(forwarding-noreply@google.com) → 전달 아님', () => {
    const verdict = classifyForwarded(
      evidence({ envelopeSender: 'bounce-abc@google.com', fromAddress: 'forwarding-noreply@google.com' }),
      [OWNER],
    );
    expect(verdict.forwarded).toBe(false);
  });

  it('반송(널 발신자) → 전달 아님', () => {
    expect(classifyForwarded(evidence({ envelopeSender: null }), [OWNER])).toMatchObject({
      forwarded: false,
      reason: 'no_envelope_sender',
    });
    expect(classifyForwarded(evidence({ envelopeSender: '<>' }), [OWNER]).forwarded).toBe(false);
  });
});

describe('Google Workspace', () => {
  const WORKSPACE = 'jin.yk@mycompany.kr';

  it('사용자 수준 전달(Gmail 설정 화면): 같은 caf 재작성 → 전달. Workspace 도메인의 점은 의미가 있다', () => {
    expect(classifyForwarded(evidence({ envelopeSender: 'jin.yk+caf_=jin-agent=atmark.ai@mycompany.kr' }), [WORKSPACE])).toEqual({
      forwarded: true,
      basis: 'caf_rewrite',
      mailbox: WORKSPACE,
    });
    expect(isForwardedFormOf('jinyk+caf_=x@mycompany.kr', WORKSPACE)).toBeNull();
  });

  it('관리자 라우팅(봉투 발신자 = 원 발신자 그대로) → **미탐.** 이 판정식으로는 볼 수 없다(런북이 금지)', () => {
    const routed = evidence({ envelopeSender: PARTNER, fromAddress: PARTNER });
    expect(classifyForwarded(routed, [WORKSPACE]).forwarded).toBe(false);
  });
});

describe('필터 전달 vs 전체 전달 — 봉투가 같다, 구분하지 않는다', () => {
  it('두 경우 모두 같은 판정', () => {
    const filter = classifyForwarded(evidence({ envelopeSender: 'jinyounkyum+caf_=jin-agent=atmark.ai@gmail.com' }), [OWNER]);
    const everything = classifyForwarded(
      evidence({ envelopeSender: 'jinyounkyum+caf_=jin-agent=atmark.ai@gmail.com', fromAddress: 'newsletter@shop.example' }),
      [OWNER],
    );
    expect(filter).toEqual(everything);
    expect(filter.forwarded).toBe(true);
  });
});

describe('X-Forwarded-* — 보조 신호(발신자가 쓸 수 있으므로 단독 근거 아님)', () => {
  it('봉투는 전달 형태가 아닌데 X-Forwarded-For 가 대표를 가리킨다 → 전달 아님 + auxiliarySignal', () => {
    const verdict = classifyForwarded(evidence({ forwardedForHeader: `${OWNER} ${AGENT}` }), [OWNER]);
    expect(verdict).toEqual({ forwarded: false, reason: 'envelope_not_human_mailbox', auxiliarySignal: true });
  });

  it('X-Forwarded-To 가 에이전트 주소 → auxiliarySignal', () => {
    const verdict = classifyForwarded(evidence({ forwardedToHeader: AGENT.toUpperCase() }), [OWNER]);
    expect(verdict).toMatchObject({ forwarded: false, auxiliarySignal: true });
  });

  it('무관한 X-Forwarded-For → 신호 없음', () => {
    const verdict = classifyForwarded(evidence({ forwardedForHeader: 'x@y.com' }), [OWNER]);
    expect(verdict).toMatchObject({ forwarded: false, auxiliarySignal: false });
  });
});

describe('isHumanMailbox', () => {
  it('Gmail 점·대소문자·+태그를 무시한다', () => {
    expect(isHumanMailbox('Jin.Younkyum+x@GMAIL.com', [OWNER])).toBe(true);
    expect(isHumanMailbox('other@gmail.com', [OWNER])).toBe(false);
    expect(isHumanMailbox('not-an-address', [OWNER])).toBe(false);
  });
});
