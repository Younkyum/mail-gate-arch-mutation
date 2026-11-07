/**
 * 운영자 콘솔 코드 메일 템플릿(`src/notify/ops-code-template.ts`) — 순수 함수. `.omc/plans/ops-console.md` §3.4 "메일".
 *
 * 되돌리면 빨개져야 하는 것: 코드는 본문에 한 번 + 제목에 한 번(2026-10-10 문구 개편) · 링크 0 · **한 통에 한 언어**(2026-10-10 — 운영자 사용자의 설정 → 요청 화면 언어 → en) ·
 * step-up 은 행위 라벨과 대상 참조를 제목·본문에 · 줄표(em dash) 0 · 모양이 틀린 코드·대상 참조·행위는 던진다.
 */

import { describe, expect, it } from 'vitest';

import type { OpsAction } from '../../../src/ops/contract';
import { OPS_ACTIONS } from '../../../src/ops/contract';
import { OPS_ACTION_LABELS, renderOpsCodeMail } from '../../../src/notify/ops-code-template';

const EXPIRES = new Date('2026-09-28T03:10:00.000Z');

describe('운영자 콘솔 코드 메일', () => {
  for (const purpose of ['login', 'access_request'] as const) {
    it(`${purpose}: 코드는 본문에 한 번 · 제목에 한 번 · 링크 없음 · 줄표 없음 · 한 언어 · 만료 10분`, () => {
      const ko = renderOpsCodeMail({ purpose, code: '024680', expiresAt: EXPIRES }, 'ko');
      const en = renderOpsCodeMail({ purpose, code: '024680', expiresAt: EXPIRES }, 'en');
      for (const mail of [ko, en]) {
        expect(mail.subject.split('024680')).toHaveLength(2);
        expect(mail.text.split('024680')).toHaveLength(2);
        expect(`${mail.text}\n${mail.html}`).not.toMatch(/https?:/);
        expect(`${mail.subject}\n${mail.text}`).not.toMatch(/[—–]/);
        expect(mail.text).not.toMatch(/^─{20,}$/m);
      }
      expect(ko.text).toContain('10분 뒤 만료됩니다');
      expect(en.text).toContain('It expires in 10 minutes.');
      expect(`${en.subject}\n${en.text}`).not.toMatch(/[가-힣]/);
      expect(ko.subject).toMatch(/^024680 Atmark 운영 콘솔 /);
      expect(en.subject).toMatch(/^024680 (is your Atmark ops login code|confirms: ops access request)$/);
    });
  }

  it('언어마다 그 언어의 첫 문장', () => {
    expect(renderOpsCodeMail({ purpose: 'login', code: '111111', expiresAt: EXPIRES }, 'ko').text.startsWith('운영 콘솔 로그인 코드\n')).toBe(true);
    expect(renderOpsCodeMail({ purpose: 'login', code: '111111', expiresAt: EXPIRES }, 'en').text.startsWith('Your ops console login code\n')).toBe(true);
  });

  it('step-up: 행위 라벨과 대상 참조가 제목·본문에(그 언어로) · 코드도 제목에', () => {
    for (const action of OPS_ACTIONS) {
      const ko = renderOpsCodeMail({ purpose: 'step_up', code: '975310', expiresAt: EXPIRES, action, targetRef: 'PH5K' }, 'ko');
      const en = renderOpsCodeMail({ purpose: 'step_up', code: '975310', expiresAt: EXPIRES, action, targetRef: 'PH5K' }, 'en');
      expect(ko.subject).toBe(`975310 운영 작업 확인: ${OPS_ACTION_LABELS[action].ko} [PH5K]`);
      const en0 = OPS_ACTION_LABELS[action].en;
      expect(en.subject).toBe(`975310 confirms: ${en0.charAt(0).toLowerCase()}${en0.slice(1)} [PH5K]`);
      expect(ko.text).toContain(`작업: ${OPS_ACTION_LABELS[action].ko}`);
      expect(en.text).toContain(`Action: ${OPS_ACTION_LABELS[action].en}`);
      expect(ko.text).toContain('참조: PH5K');
      expect(en.text).toContain('Reference: PH5K');
      for (const mail of [ko, en]) {
        expect(mail.text.split('975310')).toHaveLength(2);
        expect(`${mail.subject}\n${mail.text}`).not.toMatch(/[—–]/);
      }
    }
  });

  it('모양이 틀리면 던진다 — 코드 6자리 숫자 · 대상 참조 base32 4자리 · step-up 행위 필수', () => {
    expect(() => renderOpsCodeMail({ purpose: 'login', code: '12345', expiresAt: EXPIRES }, 'ko')).toThrow();
    expect(() => renderOpsCodeMail({ purpose: 'login', code: '12345a', expiresAt: EXPIRES }, 'en')).toThrow();
    expect(() => renderOpsCodeMail({ purpose: 'step_up', code: '123456', expiresAt: EXPIRES, action: 'org.reject', targetRef: 'ph5k' }, 'ko')).toThrow();
    expect(() => renderOpsCodeMail({ purpose: 'step_up', code: '123456', expiresAt: EXPIRES, action: 'org.reject', targetRef: '<a>' }, 'ko')).toThrow();
    expect(() => renderOpsCodeMail({ purpose: 'step_up', code: '123456', expiresAt: EXPIRES, action: null, targetRef: 'PH5K' }, 'ko')).toThrow();
  });

  it('step-up 행위는 계약의 own property 만 — 객체 프로토타입의 키(toString·__proto__ 등)는 거절한다', () => {
    for (const rogueAction of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(() =>
        renderOpsCodeMail(
          {
            purpose: 'step_up',
            code: '123456',
            expiresAt: EXPIRES,
            // OPS_ACTION_LABELS 에 없는(그러나 Object.prototype 에는 있는) 키가 통과하지 않는지 본다.
            action: rogueAction as unknown as OpsAction,
            targetRef: 'PH5K',
          },
          'en',
        ),
      ).toThrow('step-up 메일에는 계약의 행위가 있어야 한다');
    }
  });
});
