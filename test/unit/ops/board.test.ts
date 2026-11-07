/**
 * 주간 운영판(202610010900)의 **판정 규칙** — 순수 함수(DB 없음). 숫자는 계획 2026-09-30 §9.2 · §6.2.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 분모 20 미만이면 퍼센트를 싣지 않는다(`ratio().pct = null` · `ratioText` 에 `%` 없음).
 *   - 하한(14일 외부 발신 200통) 미달 + 신호 0 = **판정 불가**(초록 L0 이 아니다). 하한을 넘으면 L0.
 *   - 사다리: 불만 1 → L1 · 2 → L2 · 하드 바운스 2% → L2 · Gmail 일 최대 1,000 초과 → L2 · 조직 신호 넷 → L1 · 신규 조직 비중은 주간 200통 미만이면 평가하지 않는다 ·
 *     get_verification_code 호출 수는 "미관측".
 *   - ISO 주 열쇠 → 월요일 00:00 KST · 코호트 창 미종료 판정.
 */

import { describe, expect, it } from 'vitest';

import {
  BOARD_MANUAL_CHECKS,
  BOARD_RULES,
  cohortRowOf,
  INTERNAL_ORG_IDS,
  isoWeekStartKst,
  ladderOf,
  ratio,
  ratioText,
  type BoardGuardRaw,
} from '../../../src/ops/console/board-rules';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function guard(over: Partial<BoardGuardRaw> = {}): BoardGuardRaw {
  return {
    externalSends: { d7: 150, d14: 300, d28: 600, newOrgD7: 0 },
    sesComplaints: 0,
    sesBounces: 0,
    systemComplaints: 0,
    systemHardBounces: 0,
    waitlistHardBounces: 0,
    gmailDailyPeak: 0,
    allModeCount: 0,
    allModeOrgs: [],
    dailyRecipientsTop: [],
    harvestTop: [],
    ...over,
  };
}

const status = (g: BoardGuardRaw, key: string): string | undefined => ladderOf(g).signals.find((s) => s.key === key)?.status;

describe('ratio — 분모 20 미만이면 퍼센트 없음', () => {
  it('19 → null · 20 → 정수 퍼센트 · 0 → null', () => {
    expect(ratio(3, 19)).toEqual({ n: 3, d: 19, pct: null });
    expect(ratio(5, 20)).toEqual({ n: 5, d: 20, pct: 25 });
    expect(ratio(0, 0)).toEqual({ n: 0, d: 0, pct: null });
    expect(ratioText(ratio(3, 12))).toBe('3/12');
    expect(ratioText(ratio(30, 40))).toBe('30/40 (75%)');
    expect(BOARD_RULES.percentMinDenominator).toBe(20);
  });
});

describe('ladderOf — 사다리와 발송량 하한', () => {
  it('신호 0 + 14일 200통 미만 → 판정 불가(초록 아님) · 0건 신호는 insufficient', () => {
    const l = ladderOf(guard({ externalSends: { d7: 40, d14: 199, d28: 300, newOrgD7: 0 } }));
    expect(l.level).toBe('L0');
    expect(l.verdict).toBe('insufficient');
    expect(l.belowFloor).toBe(true);
    expect(l.signals.find((s) => s.key === 'complaints')?.status).toBe('insufficient');
    expect(l.signals.find((s) => s.key === 'hard_bounce_rate')?.status).toBe('insufficient');
  });

  it('신호 0 + 14일 200통 이상 → L0', () => {
    const l = ladderOf(guard({ externalSends: { d7: 120, d14: 200, d28: 300, newOrgD7: 0 } }));
    expect(l).toMatchObject({ level: 'L0', verdict: 'L0', belowFloor: false });
    expect(status(guard({ externalSends: { d7: 120, d14: 200, d28: 300, newOrgD7: 0 } }), 'complaints')).toBe('clear');
  });

  it('불만 — 1건 L1 · 2건 L2(에이전트 FBL + 시스템 메일을 더한다) · 하한 미달이어도 신호는 신호다', () => {
    const below = { externalSends: { d7: 1, d14: 1, d28: 1, newOrgD7: 0 } };
    expect(ladderOf(guard({ ...below, sesComplaints: 1 }))).toMatchObject({ level: 'L1', verdict: 'L1' });
    expect(ladderOf(guard({ sesComplaints: 1, systemComplaints: 1 }))).toMatchObject({ level: 'L2', verdict: 'L2' });
    const text = ladderOf(guard({ sesComplaints: 1 })).signals.find((s) => s.key === 'complaints')?.value ?? '';
    expect(text).toContain('관측된 불만 1건(SES FBL 기준, Gmail 미포함');
    expect(text).toContain('외부 발신 150통/7일');
  });

  it('하드 바운스 2% → L2(1.99% 는 아니다) · 분모 20 미만이면 문장에 % 없음', () => {
    expect(ladderOf(guard({ externalSends: { d7: 100, d14: 300, d28: 300, newOrgD7: 0 }, sesBounces: 2 })).level).toBe('L2');
    expect(ladderOf(guard({ externalSends: { d7: 201, d14: 300, d28: 300, newOrgD7: 0 }, sesBounces: 4 })).level).toBe('L0');
    // 문턱 옆은 소수 한 자리 — 1/64 = 1.6%(정수 반올림이면 "2%" 로 보여 "아님" 과 어긋난다).
    expect(ladderOf(guard({ externalSends: { d7: 64, d14: 300, d28: 300, newOrgD7: 0 }, sesBounces: 1 })).signals.find((s) => s.key === 'hard_bounce_rate')).toMatchObject({
      status: 'clear',
      value: expect.stringMatching(/^반송 1\/64 \(1\.6%\)/),
    });
    const small = ladderOf(guard({ externalSends: { d7: 10, d14: 300, d28: 300, newOrgD7: 0 }, sesBounces: 1 }));
    expect(small.level).toBe('L2');
    expect(small.signals.find((s) => s.key === 'hard_bounce_rate')?.value).toMatch(/^반송 1\/10\(/);
  });

  it('조직 신호 넷 → L1 · 넘은 조직 id 만 싣는다', () => {
    expect(ladderOf(guard({ allModeCount: 1, allModeOrgs: [ORG_A] })).signals.find((s) => s.key === 'all_mode_switch')).toMatchObject({ status: 'fired', organizations: [ORG_A] });
    const daily = ladderOf(guard({ dailyRecipientsTop: [{ organizationId: ORG_A, value: 20 }, { organizationId: ORG_B, value: 19 }] }));
    expect(daily.level).toBe('L1');
    expect(daily.signals.find((s) => s.key === 'org_daily_recipients')?.organizations).toEqual([ORG_A]);
    expect(ladderOf(guard({ harvestTop: [{ organizationId: ORG_B, value: 30 }] })).signals.find((s) => s.key === 'harvest_domains')?.organizations).toEqual([ORG_B]);
    expect(ladderOf(guard({ harvestTop: [{ organizationId: ORG_B, value: 29 }] })).level).toBe('L0');
    expect(ladderOf(guard({ waitlistHardBounces: 3 })).level).toBe('L1');
    expect(ladderOf(guard({ waitlistHardBounces: 2, systemHardBounces: 9 })).level).toBe('L0');
  });

  it('신규 조직 비중 — 주간 200통 미만이면 평가하지 않는다 · 200통 이상에서 30% → L1', () => {
    expect(status(guard({ externalSends: { d7: 199, d14: 300, d28: 300, newOrgD7: 199 } }), 'new_org_share')).toBe('not_evaluated');
    expect(ladderOf(guard({ externalSends: { d7: 200, d14: 300, d28: 300, newOrgD7: 60 } })).level).toBe('L1');
    expect(ladderOf(guard({ externalSends: { d7: 200, d14: 300, d28: 300, newOrgD7: 59 } })).level).toBe('L0');
  });

  it('Gmail 일 최대 1,000 초과 → L2 · get_verification_code 는 미관측', () => {
    expect(ladderOf(guard({ gmailDailyPeak: 1001 })).level).toBe('L2');
    expect(ladderOf(guard({ gmailDailyPeak: 1000 })).level).toBe('L0');
    expect(status(guard(), 'harvest_code_calls')).toBe('unobserved');
  });

  it('수동 확인 셋(Postmaster · Spamhaus · SES)은 https 링크 · 내부 조직 목록은 Chronostasis', () => {
    const urls = Object.fromEntries(BOARD_MANUAL_CHECKS.map((c) => [c.key, c.url]));
    expect(urls['postmaster']).toBe('https://postmaster.google.com');
    expect(urls['spamhaus']).toMatch(/^https:\/\/check\.spamhaus\.org\//);
    expect(urls['ses']).toMatch(/^https:\/\/ap-northeast-2\.console\.aws\.amazon\.com\/ses\/.*reputation/);
    expect(INTERNAL_ORG_IDS).toContain('f37fa0fd-231f-4cfe-8540-067eee3e7538');
  });
});

describe('코호트 — ISO 주(KST) · 창 미종료', () => {
  it('2026-W41 → 2026-10-05 00:00 KST(= 10-04 15:00Z) · 2027-W01 → 2027-01-04 · 모양이 아니면 null', () => {
    expect(isoWeekStartKst('2026-W41')?.toISOString()).toBe('2026-10-04T15:00:00.000Z');
    expect(isoWeekStartKst('2027-W01')?.toISOString()).toBe('2027-01-03T15:00:00.000Z');
    expect(isoWeekStartKst('2026-W40')?.toISOString()).toBe('2026-09-27T15:00:00.000Z');
    expect(isoWeekStartKst('2026-41')).toBeNull();
  });

  const zero = { signedUp: 0, agent: 0, mcp: 0, inbound: 0, read: 0, deny: 0, reply: 0, retained: 0 };
  const raw = { week: '2026-W41', invited: 12, open7: 0, open14: 0, global: { ...zero, signedUp: 5, agent: 4, mcp: 3 }, beta: { ...zero, signedUp: 2, agent: 2 } };

  it('주 시작 + 21일 전이면 창 미종료 · 그 뒤엔 가입 7일이 안 된 조직이 있을 때만 · 2주차는 28일', () => {
    const start = isoWeekStartKst('2026-W41')?.getTime() ?? 0;
    const day = 24 * 60 * 60 * 1000;
    expect(cohortRowOf(raw, new Date(start + 20 * day))).toMatchObject({ windowOpen: true, retentionOpen: true });
    expect(cohortRowOf(raw, new Date(start + 21 * day))).toMatchObject({ windowOpen: false, retentionOpen: true });
    expect(cohortRowOf({ ...raw, open7: 1, open14: 1 }, new Date(start + 30 * day))).toMatchObject({ windowOpen: true, retentionOpen: true, openOrgs: 1 });
    expect(cohortRowOf(raw, new Date(start + 28 * day))).toMatchObject({ windowOpen: false, retentionOpen: false });
  });

  it('분모 — 가입은 초대 수, 단계는 가입 수 · Beta 는 Beta 가입 수 · 20 미만은 퍼센트 없음', () => {
    const row = cohortRowOf(raw, new Date('2026-12-01T00:00:00Z'));
    expect(row.global.signedUp).toEqual({ n: 5, d: 12, pct: null });
    expect(row.global.agent).toEqual({ n: 4, d: 5, pct: null });
    expect(row.beta.signedUp).toEqual({ n: 2, d: 2, pct: null });
    expect(row.beta.agent).toEqual({ n: 2, d: 2, pct: null });
    const big = cohortRowOf({ ...raw, invited: 40, global: { ...zero, signedUp: 30, agent: 21 } }, new Date('2026-12-01T00:00:00Z'));
    expect(big.global.signedUp).toEqual({ n: 30, d: 40, pct: 75 });
    expect(big.global.agent).toEqual({ n: 21, d: 30, pct: 70 });
  });
});
