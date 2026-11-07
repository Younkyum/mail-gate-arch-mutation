/**
 * AC-0 상대 식별 — 활동 분모·관측 표본이 "서로 다른 외부 상대" 를 세는 규칙 (V3 H1·H2②③).
 */

import { describe, expect, it } from 'vitest';

import { internalAddressPredicate } from '../../../src/gate/ac0-report';
import type { Ac0Gate } from '../../../src/gate/ac0-store';
import { contactKey } from '../../../src/gate/forwarded';

const GATE: Ac0Gate = {
  id: '00000000-0000-0000-0000-000000000000',
  organizationId: '00000000-0000-0000-0000-000000000001',
  agentId: null,
  humanMailboxes: ['owner@gmail.com'],
  createdAt: new Date(0),
};

describe('contactKey — 한 상대는 한 키', () => {
  it('+태그 변형은 한 상대(normalizeAddress 와 같은 절단)', () => {
    const keys = new Set(['bob+1@x.kr', 'bob+2@x.kr', 'BOB+3@X.KR', 'bob@x.kr', '<bob+5@x.kr>'].map(contactKey));
    expect([...keys]).toEqual(['bob@x.kr']);
  });

  it('Gmail 은 점·googlemail 무시, 다른 도메인은 점이 의미가 있다', () => {
    expect(contactKey('b.o.b@gmail.com')).toBe('bob@gmail.com');
    expect(contactKey('bob+x@googlemail.com')).toBe('bob@gmail.com');
    expect(contactKey('b.o.b@x.kr')).toBe('b.o.b@x.kr');
  });
});

describe('internalAddressPredicate — atmark.ai 는 항상 내부 (H2③)', () => {
  it('조직이 커스텀 도메인만 써도 다른 조직의 @atmark.ai 에이전트는 외부 상대가 아니다', () => {
    const isInternal = internalAddressPredicate(GATE, ['acme.co.kr']);
    expect(isInternal('other-org-agent@atmark.ai')).toBe(true);
    expect(isInternal('x@mail.atmark.ai')).toBe(true);
    expect(isInternal('me@acme.co.kr')).toBe(true);
    expect(isInternal('o.w.n.e.r+tag@gmail.com')).toBe(true);
    expect(isInternal('partner@notatmark.ai')).toBe(false);
    expect(isInternal('partner@vendor.kr')).toBe(false);
  });
});
