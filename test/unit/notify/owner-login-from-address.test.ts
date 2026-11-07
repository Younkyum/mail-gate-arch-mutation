/**
 * 로그인 메일 발신 주소(`login@atmark.ai`, ADR-0006) — **에이전트에게 발급될 수 없어야 한다.**
 *
 * login-mailer 역할의 SES 권한은 이 주소 하나에 묶여 있고, 발송 역할은 이 주소를 명시 Deny 한다. 그런데 에이전트가 같은
 * 주소(`login@atmark.ai`)를 받으면 ① 그 에이전트의 발신이 Deny 에 걸려 전부 실패하고, ② 에이전트가 받은 메일·보낸 메일이
 * 로그인 메일과 같은 발신자로 보인다(피싱 입구). 그래서 로컬파트 `login` 은 예약어여야 한다.
 *
 * `src/identity/address.ts` 는 다른 작업자의 파일이다 — 이 단언은 그쪽 변경이 들어오기 전까지 **빨갛다**(의도).
 */

import { describe, expect, it } from 'vitest';

import { RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { OWNER_LOGIN_FROM_ADDRESS } from '../../../src/notify/owner-login-notifier';
import { APPROVAL_NOTIFY_FROM_ADDRESS } from '../../../src/notify/approval-notifier';

describe('로그인 메일 발신 주소', () => {
  it('login@atmark.ai 이고 승인 알림 주소(notify@)와 다르다 — 두 발송 주체의 발신 주소가 겹치지 않는다', () => {
    expect(OWNER_LOGIN_FROM_ADDRESS).toBe('login@atmark.ai');
    expect(OWNER_LOGIN_FROM_ADDRESS).not.toBe(APPROVAL_NOTIFY_FROM_ADDRESS);
  });

  it('로컬파트 login 은 예약어다 — 에이전트 주소로 발급될 수 없다', () => {
    const localPart = OWNER_LOGIN_FROM_ADDRESS.split('@')[0];
    expect(RESERVED_LOCAL_PARTS).toContain(localPart);
  });
});
