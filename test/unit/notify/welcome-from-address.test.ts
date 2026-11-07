/**
 * 환영 메일 발신 주소(`onve@atmark.ai`, 202609301510 · ADR-0006 2026-09-30 개정) — 일반 에이전트에게 발급될 수 없어야 한다(예약 로컬파트).
 * 운영자만 지원 에이전트의 별칭으로 붙인다(`OPERATOR_ASSIGNABLE_ADDRESSES`) — 그래서 환영 메일의 답장은 지원 에이전트로 간다.
 * 헤더 From 은 상수 하나(`WELCOME_FROM_HEADER`)이고 그 안의 주소가 발신 주소와 글자 그대로 같다.
 */

import { describe, expect, it } from 'vitest';

import { OPERATOR_ASSIGNABLE_ADDRESSES, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { APPROVAL_NOTIFY_FROM_ADDRESS } from '../../../src/notify/approval-notifier';
import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';
import { WELCOME_FROM_ADDRESS, WELCOME_FROM_HEADER } from '../../../src/notify/welcome-notifier';

describe('환영 메일 발신 주소', () => {
  it('onve@atmark.ai · 헤더는 "Onve (Atmark)" <onve@atmark.ai> · 다른 시스템 메일 발신과 겹치지 않는다', () => {
    expect(WELCOME_FROM_ADDRESS).toBe('onve@atmark.ai');
    expect(WELCOME_FROM_HEADER).toBe(`"Onve (Atmark)" <${WELCOME_FROM_ADDRESS}>`);
    expect(WELCOME_FROM_ADDRESS).not.toBe(OWNER_LOGIN_FROM_ADDRESS);
    expect(WELCOME_FROM_ADDRESS).not.toBe(APPROVAL_NOTIFY_FROM_ADDRESS);
  });

  it('로컬파트 onve 는 예약어다 — 운영자만 지정 조직의 에이전트에 붙일 수 있다', () => {
    expect(RESERVED_LOCAL_PARTS).toContain(WELCOME_FROM_ADDRESS.split('@')[0]);
    expect(OPERATOR_ASSIGNABLE_ADDRESSES).toContain(WELCOME_FROM_ADDRESS);
  });
});
