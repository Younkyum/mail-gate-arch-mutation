/**
 * 운영 콘솔 코드 메일 워커(`src/workers/ops-code-mailer.ts`)의 **격리**(M1 · H10) — 가짜 DB·알림기, AWS 0. 실제 DB 경로는
 * `test/integration/ops/mailer-isolation.test.ts`.
 *
 * 되돌리면 빨개져야 하는 것: 어떤 이유로도 던지지 않는다 · 표 없음/권한 없음/설정 없음/자리표시/키 형식 오류는 건너뛰고 메트릭
 * (`atmark.ops.mailer_skipped{reason}`) · 보낼 것이 없으면 키링을 읽지 않는다 · 예산(10행 · 5초) · 한 도전의 권한 오류는 그 틱의 운영 쪽을 멈춘다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logger from '../../../src/observability/logger';
import { OPS_METRIC_NAMES } from '../../../src/ops/metrics';
import { runLoginMailer } from '../../../src/runtime/handlers/login-mailer';
import { OPS_CODE_MAIL_BATCH, runOpsCodeMailer, skipReasonOf } from '../../../src/workers/ops-code-mailer';

const pgError = (code: string): Error => Object.assign(new Error(code), { code });
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function metrics(spy: ReturnType<typeof vi.spyOn>): { name: string; reason: unknown }[] {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('"_aws"'))
    .map((line: string) => JSON.parse(line) as Record<string, unknown>)
    .map((record: Record<string, unknown>) => ({ name: Object.keys(record).find((key) => key.startsWith('atmark.ops.')) ?? '', reason: record['reason'] }));
}

describe('운영 코드 메일 워커 — 던지지 않는다 · 건너뛰면 메트릭', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skipReasonOf: 42P01·42883 → schema · 42501 → permission · 57014(예산 초과) → config · 그 밖 null', () => {
    expect(skipReasonOf(pgError('42P01'))).toBe('schema');
    expect(skipReasonOf(pgError('42883'))).toBe('schema');
    expect(skipReasonOf(pgError('42501'))).toBe('permission');
    expect(skipReasonOf(pgError('57014'))).toBe('config');
    expect(skipReasonOf(pgError('40001'))).toBeNull();
    expect(skipReasonOf(null)).toBeNull();
  });

  for (const [code, reason] of [
    ['42P01', 'schema'],
    ['42501', 'permission'],
  ] as const) {
    it(`기한 조회가 ${code} 면 ${reason} 로 건너뛴다 — 키링을 읽지 않는다`, async () => {
      const spy = vi.spyOn(logger, 'writeLine');
      const loader = vi.fn();
      const report = await runOpsCodeMailer({ db: { query: () => Promise.reject(pgError(code)) } as never, loadNotifier: loader, now: () => new Date() });
      expect(report).toEqual({ skipped: 1 });
      expect(loader).not.toHaveBeenCalled();
      expect(metrics(spy)).toEqual([{ name: OPS_METRIC_NAMES.mailerSkipped, reason }]);
    });
  }

  it('보낼 것이 없으면 키링을 읽지 않는다(메트릭 없음)', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    const loader = vi.fn();
    const report = await runOpsCodeMailer({ db: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as never, loadNotifier: loader, now: () => new Date() });
    expect(report).toEqual({});
    expect(loader).not.toHaveBeenCalled();
    expect(metrics(spy)).toEqual([]);
  });

  for (const reason of ['config', 'placeholder', 'key_invalid'] as const) {
    it(`키링이 ${reason} 면 건너뛴다(보낸 것 0)`, async () => {
      const spy = vi.spyOn(logger, 'writeLine');
      const report = await runOpsCodeMailer({
        db: { query: () => Promise.resolve({ rows: [{ id: ID(1) }], rowCount: 1 }) } as never,
        loadNotifier: () => Promise.resolve(reason),
        now: () => new Date(),
      });
      expect(report).toEqual({ skipped: 1 });
      expect(metrics(spy)).toEqual([{ name: OPS_METRIC_NAMES.mailerSkipped, reason }]);
    });
  }

  it('키링 읽기가 던지면 config 로 본다 · 다른 DB 오류는 failed 로 삼킨다', async () => {
    expect(
      await runOpsCodeMailer({
        db: { query: () => Promise.resolve({ rows: [{ id: ID(1) }], rowCount: 1 }) } as never,
        loadNotifier: () => Promise.reject(new Error('secrets down')),
        now: () => new Date(),
      }),
    ).toEqual({ skipped: 1 });
    expect(await runOpsCodeMailer({ db: { query: () => Promise.reject(new Error('db down')) } as never, loadNotifier: vi.fn(), now: () => new Date() })).toEqual({
      failed: 1,
    });
  });

  it('도전마다 notify · 결말을 센다 · 권한 오류(42501)가 나면 그 틱의 나머지를 멈추고 건너뛴다 · 다른 오류는 그 도전만 failed', async () => {
    const ids = [ID(1), ID(2), ID(3), ID(4)];
    const outcomes = new Map<string, () => Promise<'sent' | 'dead'>>([
      [ID(1), () => Promise.resolve('sent')],
      [ID(2), () => Promise.reject(new Error('ses down'))],
      [ID(3), () => Promise.reject(pgError('42501'))],
      [ID(4), () => Promise.resolve('sent')],
    ]);
    const report = await runOpsCodeMailer({
      db: { query: () => Promise.resolve([{ rows: [{ set_config: '5000' }] }, { rows: ids.map((id) => ({ id })), rowCount: 4 }]) } as never,
      loadNotifier: () => Promise.resolve({ notify: (id: string) => (outcomes.get(id) ?? (() => Promise.resolve('sent' as const)))() }),
      now: () => new Date(),
    });
    expect(report).toEqual({ sent: 1, failed: 1, skipped: 1 });
  });

  it('기한 조회는 한 왕복 — 남은 예산을 statement_timeout(그 조회에만)으로 걸고 LIMIT 10 · 값은 코드가 만든 것뿐', async () => {
    const texts: string[] = [];
    await runOpsCodeMailer({
      db: {
        query: (text: string, values?: unknown[]) => {
          texts.push(text);
          expect(values).toBeUndefined();
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      } as never,
      loadNotifier: vi.fn(),
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^SELECT set_config\('statement_timeout', '\d+', true\);/);
    expect(texts[0]).toContain(`LIMIT ${String(OPS_CODE_MAIL_BATCH)}`);
    expect(texts[0]).toContain(`'2026-09-28T00:00:00.000Z'::timestamptz`);
    expect(OPS_CODE_MAIL_BATCH).toBe(10);
  });

  it('기한 조회가 예산을 넘으면(57014 statement_timeout) config 로 건너뛴다', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    expect(await runOpsCodeMailer({ db: { query: () => Promise.reject(pgError('57014')) } as never, loadNotifier: vi.fn(), now: () => new Date() })).toEqual({
      skipped: 1,
    });
    expect(metrics(spy)).toEqual([{ name: OPS_METRIC_NAMES.mailerSkipped, reason: 'config' }]);
  });

  it('키링 읽기가 예산 안에 끝나지 않으면 config 로 건너뛴다 — 틱의 소유자 메일 워커는 예산 이상 늦지 않는다', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    const never = new Promise<never>(() => undefined);
    const polled: string[] = [];
    const recorder = (name: string) =>
      ({
        query: () => {
          polled.push(name);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      }) as never;
    const started = Date.now();
    const notifier = { notify: () => Promise.resolve('sent' as const) };
    const counts = await runLoginMailer({
      ops: {
        db: { query: () => Promise.resolve({ rows: [{ id: ID(1) }], rowCount: 1 }) } as never,
        loadNotifier: () => never,
        now: () => new Date(),
        budgetMs: 150,
      },
      login: { db: recorder('login'), notifier, now: () => new Date() },
      signup: { db: recorder('signup'), notifier, now: () => new Date() },
      invite: { db: recorder('invite'), notifier, now: () => new Date() },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(counts['ops.skipped']).toBe(1);
    expect(polled).toEqual(['login', 'signup', 'invite']);
    expect(metrics(spy)).toEqual([{ name: OPS_METRIC_NAMES.mailerSkipped, reason: 'config' }]);
  });
});
