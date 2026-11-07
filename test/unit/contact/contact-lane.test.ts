/**
 * 문의 전달 차선(`laneOf`, 202610021000) — 순수 함수. 2026-10-02(안 A).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - support@ 만 → `support` · abuse@·postmaster@ 만 → `role` · support@ 와 역할 주소가 함께 → `role`(하나라도면 역할 차선).
 *   - 상한 표: support 30 · role 10 · 같은 발신자 5(차선과 무관).
 */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_ADDRESS,
  CONTACT_FORWARD_LANE_HOURLY_CAP,
  CONTACT_FORWARD_SENDER_HOURLY_CAP,
  laneOf,
} from '../../../src/contact/intake';

describe('문의 전달 차선 — laneOf', () => {
  it('support@ 만 → support', () => {
    expect(laneOf([CONTACT_ADDRESS])).toBe('support');
  });

  it('abuse@ 만 · postmaster@ 만 → role', () => {
    expect(laneOf(['abuse@atmark.ai'])).toBe('role');
    expect(laneOf(['postmaster@atmark.ai'])).toBe('role');
  });

  it('support@ + postmaster@ 가 함께 → role(하나라도 역할 주소면) · 순서·대소문자 무관', () => {
    expect(laneOf([CONTACT_ADDRESS, 'postmaster@atmark.ai'])).toBe('role');
    expect(laneOf(['Abuse@Atmark.AI', CONTACT_ADDRESS])).toBe('role');
  });

  it('비었으면 support(소비자는 문의 주소가 있을 때만 부른다)', () => {
    expect(laneOf([])).toBe('support');
  });

  it('상한 표 — support 30 · role 10 · 같은 발신자 5', () => {
    expect(CONTACT_FORWARD_LANE_HOURLY_CAP).toEqual({ support: 30, role: 10 });
    expect(CONTACT_FORWARD_SENDER_HOURLY_CAP).toBe(5);
  });
});
