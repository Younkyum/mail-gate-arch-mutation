#!/usr/bin/env tsx
/**
 * scripts/admin/ops-operator.ts — 호스팅 운영자 콘솔(ops.atmark.ai)의 **부트스트랩 · break-glass**(`.omc/plans/ops-console.md` §3.3 · §5).
 *
 *   pnpm admin:ops-operator --list                              # 운영자: 주소 · 상태 · 출처 · 살아 있는 세션 수 · 설정(열림 · 하드 잠금)
 *   pnpm admin:ops-operator --add <주소> [--by <운영자>] [--yes]        # active · origin cli(콘솔에서 폐기되지 않는다 — H1)
 *   pnpm admin:ops-operator --revoke <주소> [--by …] [--yes]           # → revoked · 세션 폐기 · 코드 무효(CLI 출신도 된다)
 *   pnpm admin:ops-operator --reinstate <주소> [--by …] [--yes]        # revoked·denied·expired → active
 *   pnpm admin:ops-operator --unlock <주소> [--yes]                    # 주소 실패 잠금(하루 50 → 24시간) 해제
 *   pnpm admin:ops-operator --enable-console | --disable-console [--yes]   # 소프트 킬 스위치(ops_settings.console_enabled)
 *   pnpm admin:ops-operator --hard-lock | --hard-unlock [--yes]            # 하드 킬 스위치의 영속 칸(ops_settings.hard_locked)
 *   pnpm admin:ops-operator --hard-lock-status                     # hard_locked · atmark_ops 의 LOGIN 여부
 *
 * **소유자 롤이다**(`DATABASE_MIGRATION_URL` — `common.ts`). `atmark_ops` 는 운영자·설정 표 쓰기 권한이 0 이고, CLI 출신 운영자 행은 소유자 롤
 * 세션만 바꾼다(`ops_operators_guard` — session_user). 운영 DB 면 바꾸기 전에 확인한다(`--yes` 또는 대화형 `yes`).
 *
 * 하드 킬 스위치 순서(런북 ops-console): `--hard-lock` → migrate `{"action":"ops-role-lock"}`(RDS 마스터 — NOLOGIN + 백엔드 종료) →
 * Compute 재배포(`atmark:opsLocked=true`). 해제는 반대: `ops-role-unlock` → `--hard-unlock` → `opsLocked=false` 재배포. `hard_locked` 가 참이면
 * migrate `bootstrap-roles` 가 LOGIN 을 되돌리지 않고, `status` 는 `hard_locked && LOGIN` 을 ok=false 로 본다.
 *
 * 출력의 주소는 정화한다(`sanitizeDisplayText`) — 접근 요청 주소는 요청자가 입력한 문자열이다.
 */

import { parseArgs } from 'node:util';

import {
  addOperatorOp,
  addressLockedUntilOp,
  listOperatorsOp,
  normalizeOperatorEmail,
  opsRoleCanLoginOp,
  readOpsSettingsOp,
  reinstateOperatorOp,
  revokeOperatorOp,
  setConsoleEnabledOp,
  setHardLockedOp,
  unlockAddressOp,
  type OpsOperatorChange,
} from '../../src/db/repositories/ops-operators';
import { sanitizeDisplayText } from '../../src/notify/approval-notification-template';
import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

const USAGE =
  'pnpm admin:ops-operator (--list | --add <주소> | --revoke <주소> | --reinstate <주소> | --unlock <주소> | --enable-console | --disable-console | ' +
  '--hard-lock | --hard-unlock | --hard-lock-status) [--by <운영자>] [--yes]';

const COMMANDS = [
  'list',
  'add',
  'revoke',
  'reinstate',
  'unlock',
  'enable-console',
  'disable-console',
  'hard-lock',
  'hard-unlock',
  'hard-lock-status',
] as const;
type Command = (typeof COMMANDS)[number];

function emailOf(raw: string | undefined, flag: string): string {
  const email = normalizeOperatorEmail(raw ?? '');
  if (email === null) throw new AdminInputError(`${flag} 는 이메일 주소. ${USAGE}`, 'invalid_email');
  return email;
}

function describeChange(email: string, change: OpsOperatorChange): string {
  const shown = sanitizeDisplayText(email, 254);
  if (change.kind === 'not_found') return `operator ${shown} not_found`;
  if (change.kind === 'unchanged') return `operator ${shown} id=${change.id} status=${change.status} unchanged`;
  return `operator ${shown} id=${change.id} status=${change.to}${change.from === null ? ' (new)' : ` (from ${change.from})`}`;
}

export async function opsOperator(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      list: { type: 'boolean', default: false },
      add: { type: 'string' },
      revoke: { type: 'string' },
      reinstate: { type: 'string' },
      unlock: { type: 'string' },
      'enable-console': { type: 'boolean', default: false },
      'disable-console': { type: 'boolean', default: false },
      'hard-lock': { type: 'boolean', default: false },
      'hard-unlock': { type: 'boolean', default: false },
      'hard-lock-status': { type: 'boolean', default: false },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const chosen = COMMANDS.filter((command) => {
    const value = values[command];
    return typeof value === 'string' || value === true;
  });
  if (chosen.length !== 1) throw new AdminInputError(`명령은 정확히 하나. ${USAGE}`);
  const command: Command = chosen[0] as Command;
  const actor = actorOf('admin:ops-operator', values.by, deps.env);

  return withAdminConnection(deps, async ({ pool, target }) => {
    const confirm = (action: string): Promise<void> => confirmProduction(target, action, values.yes, deps.io);
    switch (command) {
      case 'list': {
        const settings = await readOpsSettingsOp(pool);
        for (const row of await listOperatorsOp(pool)) {
          deps.io.out(
            [
              row.id,
              sanitizeDisplayText(row.email, 254),
              row.status,
              `origin=${row.origin}`,
              row.createdAt.toISOString(),
              `sessions=${String(row.activeSessions)}`,
            ].join('\t'),
          );
        }
        deps.io.err(`console_enabled=${String(settings.consoleEnabled)} hard_locked=${String(settings.hardLocked)}`);
        return EXIT_OK;
      }
      case 'add': {
        const email = emailOf(values.add, '--add');
        await confirm(`운영자 추가 ${email} (active · origin cli)`);
        deps.io.out(describeChange(email, await addOperatorOp(pool, email, actor)));
        return EXIT_OK;
      }
      case 'revoke': {
        const email = emailOf(values.revoke, '--revoke');
        await confirm(`운영자 폐기 ${email} (세션 폐기 · 코드 무효)`);
        const change = await revokeOperatorOp(pool, email, actor);
        deps.io.out(describeChange(email, change));
        if (change.kind === 'not_found') throw new AdminInputError(`운영자가 없다: ${sanitizeDisplayText(email, 254)}`, 'operator_not_found');
        return EXIT_OK;
      }
      case 'reinstate': {
        const email = emailOf(values.reinstate, '--reinstate');
        await confirm(`운영자 복귀 ${email} (→ active)`);
        const change = await reinstateOperatorOp(pool, email, actor);
        deps.io.out(describeChange(email, change));
        if (change.kind === 'not_found') throw new AdminInputError(`운영자가 없다: ${sanitizeDisplayText(email, 254)}`, 'operator_not_found');
        return EXIT_OK;
      }
      case 'unlock': {
        const email = emailOf(values.unlock, '--unlock');
        const before = await addressLockedUntilOp(pool, email);
        await confirm(`주소 실패 잠금 해제 ${email}`);
        const rows = await unlockAddressOp(pool, email);
        deps.io.out(`address ${sanitizeDisplayText(email, 254)} unlocked rows=${String(rows)}`);
        if (before !== null) deps.io.err(`잠금(${before.toISOString()} 까지)을 풀었다 — 다시 코드가 나간다.`);
        else deps.io.err(rows === 0 ? '잠겨 있지 않았고 실패 기록도 없다.' : '잠겨 있지 않았다(실패 수만 0 으로).');
        return EXIT_OK;
      }
      case 'enable-console':
      case 'disable-console': {
        const enabled = command === 'enable-console';
        await confirm(`운영자 콘솔 ${enabled ? '열기' : '닫기'} (console_enabled=${String(enabled)})`);
        const changed = await setConsoleEnabledOp(pool, enabled);
        deps.io.out(`console_enabled=${String(enabled)}${changed ? '' : ' unchanged'}`);
        if (enabled && (await readOpsSettingsOp(pool)).hardLocked) deps.io.err('hard_locked=true 다 — 하드 잠금이 풀리기 전까지 콘솔은 계속 닫혀 있다(503).');
        return EXIT_OK;
      }
      case 'hard-lock':
      case 'hard-unlock': {
        const locked = command === 'hard-lock';
        await confirm(`하드 킬 스위치 ${locked ? '영속' : '해제'} (hard_locked=${String(locked)})`);
        const changed = await setHardLockedOp(pool, locked);
        deps.io.out(`hard_locked=${String(locked)}${changed ? '' : ' unchanged'}`);
        deps.io.err(
          locked
            ? '다음: migrate {"action":"ops-role-lock"} → Compute 재배포(atmark:opsLocked=true).'
            : '먼저 migrate {"action":"ops-role-unlock"} 을 했는지 확인한다 → Compute 재배포(atmark:opsLocked=false).',
        );
        return EXIT_OK;
      }
      case 'hard-lock-status': {
        const settings = await readOpsSettingsOp(pool);
        const canLogin = await opsRoleCanLoginOp(pool);
        deps.io.out(`hard_locked=${String(settings.hardLocked)} atmark_ops_login=${canLogin === null ? 'missing' : String(canLogin)} console_enabled=${String(settings.consoleEnabled)}`);
        if (settings.hardLocked && canLogin === true) deps.io.err('⚠ hard_locked 인데 atmark_ops 가 로그인할 수 있다 — migrate ops-role-lock 을 돌린다(status 는 ok=false).');
        return EXIT_OK;
      }
    }
  });
}

if (isMain(import.meta.url)) await runAdminMain(opsOperator);
