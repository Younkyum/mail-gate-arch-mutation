/**
 * 대기자 명단 신청서(202609301530) — admin 입력 모양(`src/admin/waitlist.ts`)과 등급 후보(`src/ops/console/reads.ts` `waitlistGradeHint`). 순수 함수.
 *
 * 되돌리면 빨개져야 하는 것: 용도는 필수 · 닫힌 값 넷(DB CHECK 와 같은 순서) · 알게 된 곳은 선택 · 닫힌 값 일곱 · ref 는 허용목록 값만 그대로이고 나머지는
 * 전부 none(400 없음) · 등급 후보 A = 보고·알림/답장 + 메모 · B = 그 밖의 수신 · 보류 = 먼저 발송 · 용도 없음 = 후보 없음.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AdminInputError } from '../../../src/admin/ops/errors';
import { WAITLIST_HEARD_FROM, WAITLIST_USE_CASES, waitlistHeardFromOf, waitlistRefOf, waitlistUseCaseOf } from '../../../src/admin/waitlist';
import { waitlistGradeHint } from '../../../src/ops/console/reads';

const MIGRATION = readFileSync(join(__dirname, '../../../src/db/migrations/202609301530_waitlist_intake.sql'), 'utf8');

describe('신청서 입력 모양', () => {
  it('용도 — 닫힌 값 넷만, 없거나 목록 밖이면 invalid_use_case', () => {
    for (const value of WAITLIST_USE_CASES) expect(waitlistUseCaseOf(value)).toBe(value);
    for (const bad of [undefined, null, '', 'Alerts', 'spam', 1, ['alerts'], { v: 'alerts' }]) {
      expect(() => waitlistUseCaseOf(bad), JSON.stringify(bad)).toThrow(AdminInputError);
      try {
        waitlistUseCaseOf(bad);
      } catch (error) {
        expect((error as AdminInputError).code).toBe('invalid_use_case');
      }
    }
  });

  it('알게 된 곳 — 선택(비면 null) · 닫힌 값 일곱 · 목록 밖이면 invalid_heard_from', () => {
    for (const value of WAITLIST_HEARD_FROM) expect(waitlistHeardFromOf(value)).toBe(value);
    for (const empty of [undefined, null, '']) expect(waitlistHeardFromOf(empty)).toBeNull();
    for (const bad of ['hn', 'X', 0, true]) expect(() => waitlistHeardFromOf(bad), String(bad)).toThrow(/heard_from/);
  });

  it('ref — 허용목록(github · devto · referral · none · recipe-<슬러그 1~40>)만 그대로, 그 밖은 전부 none', () => {
    for (const ok of ['github', 'devto', 'referral', 'none', 'recipe-a', 'recipe-alert-routing', `recipe-${'a'.repeat(40)}`]) expect(waitlistRefOf(ok)).toBe(ok);
    for (const bad of [undefined, null, '', 'GitHub', 'recipe-', `recipe-${'a'.repeat(41)}`, 'recipe-Bad', 'recipe-a b', 'utm_source=x', 'twitter', 42, ['github']]) {
      expect(waitlistRefOf(bad), JSON.stringify(bad)).toBe('none');
    }
  });

  it('값 목록은 마이그레이션의 CHECK 와 같다(용도 넷 · 알게 된 곳 일곱 · recipe 모양)', () => {
    expect(MIGRATION).toContain(`use_case IN (${WAITLIST_USE_CASES.map((v) => `'${v}'`).join(', ')})`);
    expect(MIGRATION).toContain(`heard_from IN (${WAITLIST_HEARD_FROM.map((v) => `'${v}'`).join(', ')})`);
    expect(MIGRATION).toContain(`ref IN ('github', 'devto', 'referral', 'none') OR ref ~ '^recipe-[a-z0-9-]{1,40}$'`);
  });
});

describe('등급 후보(운영자가 메모를 읽고 최종 등급을 정한다)', () => {
  it('A = 보고·알림/답장 + 메모 · B = 인증코드 또는 메모 없는 보고·알림/답장 · 보류 = 먼저 발송 · 용도 없음 = null', () => {
    expect(waitlistGradeHint('alerts', 'CI 실패 알림을 받는 에이전트')).toBe('A');
    expect(waitlistGradeHint('replies', 'support replies')).toBe('A');
    expect(waitlistGradeHint('alerts', null)).toBe('B');
    expect(waitlistGradeHint('replies', '   ')).toBe('B');
    expect(waitlistGradeHint('codes', '가입 코드 받기')).toBe('B');
    expect(waitlistGradeHint('codes', null)).toBe('B');
    expect(waitlistGradeHint('outreach', '영업 메일')).toBe('hold');
    expect(waitlistGradeHint('outreach', null)).toBe('hold');
    expect(waitlistGradeHint(null, '1520 시절 메모')).toBeNull();
    expect(waitlistGradeHint(null, null)).toBeNull();
  });
});
