/**
 * `pnpm admin:web` 진입점 — 인자와 시작 거부(DB 없음).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 기본: 무작위 포트(0) · 유휴 30분 · 절대 수명 8시간 · 브라우저 열기. 포트는 0 또는 1024~65535, 유휴는 1~240분, 수명은 1~12시간.
 *   - `admin:db-env` 의 소유자 URL(`DATABASE_MIGRATION_URL`)이 없으면 서버를 띄우지 않는다(입력 오류) — 앱 롤 URL·결제 운영자 URL 만으로는 안 된다.
 *   - 행위자는 `admin:web:<--by 또는 USER>`.
 */

import { describe, expect, it } from 'vitest';

import { actorOf, AdminInputError, type AdminIo } from '../../../scripts/admin/common';
import { DEFAULT_IDLE_MINUTES, DEFAULT_MAX_HOURS, parseWebArgs, web } from '../../../scripts/admin/web';

const io = (): AdminIo => ({ out: () => undefined, err: () => undefined, interactive: false, ask: async () => '' });

describe('admin:web 인자', () => {
  it('기본값', () => {
    expect(parseWebArgs([])).toEqual({ port: 0, idleMinutes: DEFAULT_IDLE_MINUTES, maxHours: DEFAULT_MAX_HOURS, by: undefined, open: true });
    expect(DEFAULT_MAX_HOURS).toBe(8);
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
    expect(parseWebArgs(['--port', '48080', '--idle-minutes', '5', '--max-hours', '12', '--by', 'jin', '--no-open'])).toEqual({ port: 48080, idleMinutes: 5, maxHours: 12, by: 'jin', open: false });
    expect(parseWebArgs(['--help'])).toBe('help');
  });

  it.each([
    [['--port', '80']],
    [['--port', '70000']],
    [['--port', 'abc']],
    [['--idle-minutes', '0']],
    [['--idle-minutes', '241']],
    [['--max-hours', '0']],
    [['--max-hours', '13']],
    [['--max-hours', '1.5']],
  ])('거부: %j', (argv) => {
    expect(() => parseWebArgs(argv)).toThrow(AdminInputError);
  });

  it('모르는 옵션(예: --host)은 거부 — 바인드 주소를 바꾸는 길이 없다', () => {
    expect(() => parseWebArgs(['--host', '0.0.0.0'])).toThrow();
  });

  it('행위자 규칙', () => {
    expect(actorOf('admin:web', 'jin', {})).toBe('admin:web:jin');
    expect(actorOf('admin:web', undefined, { USER: 'younkyum' })).toBe('admin:web:younkyum');
  });
});

describe('admin:web 시작 거부', () => {
  it('소유자 URL 이 없으면 띄우지 않는다(앱 롤·결제 운영자 URL 만으로는 안 된다)', async () => {
    await expect(web(['--no-open'], { env: {}, io: io() })).rejects.toThrow(/DATABASE_MIGRATION_URL/);
    await expect(
      web(['--no-open'], { env: { DATABASE_URL: 'postgres://atmark_app@localhost/x', DATABASE_BILLING_OPERATOR_URL: 'postgres://atmark_billing_operator@localhost/x' }, io: io() }),
    ).rejects.toThrow(AdminInputError);
  });

  it('운영 DB 인데 TLS 검증 파라미터가 없으면 접속 전에 거부(CLI 와 같은 가드)', async () => {
    await expect(
      web(['--no-open'], { env: { DATABASE_MIGRATION_URL: 'postgres://owner:pw@localhost:15432/atmark' }, io: io() }),
    ).rejects.toThrow(/TLS 검증 없이/);
  });
});
