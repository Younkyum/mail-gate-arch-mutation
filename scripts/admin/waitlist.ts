#!/usr/bin/env tsx
/**
 * scripts/admin/waitlist.ts — **대기자 명단 운영**(202609301520, 초대 전용 가입).
 *
 *   pnpm admin:waitlist list [--status waiting|invited|expired|joined|all] [--limit 50]   # 기본 waiting · 오래 기다린 순
 *   pnpm admin:waitlist invite --email <주소> [--yes]       # 한 사람 초대(대기 · 초대 만료 · 살아 있는 초대 = 다시 보냄, 새 14일)
 *   pnpm admin:waitlist invite --oldest <N> [--yes]         # 가장 오래 기다린 waiting N 명(1~50) 초대
 *   pnpm admin:waitlist remove --email <주소> [--yes]       # 항목을 지운다(행 DELETE — 주소·메모가 남지 않는다. 삭제 요청도 이것)
 *
 * **소유자 롤이다**(`DATABASE_MIGRATION_URL` — `common.ts`). 쓰기는 SQL 코어(`waitlist_invite_core` · `waitlist_invite_oldest_core` ·
 * `waitlist_remove_core`, `src/ops/core/waitlist.ts` 가 부른다)를 부른다 — 운영자 화면(로컬 · 호스팅)과 **같은 코어**다. 초대는 초대 메일 한 통을
 * 쌓고(보내는 것은 login-mailer — 1분 틱) 감사 `waitlist_events` 에 한 행(행위자 `admin:waitlist:<운영자>`). 전역 하루 초대 5(202609301530) · 한 번에 50 ·
 * 지우기 하루 200 은 SQL 이 건다. 운영 DB 면 쓰기 전에 `yes` 확인(`--yes` 로 건너뛴다).
 *
 * `list` 는 신청서 답(202609301530 — 용도 · 알게 된 곳 · ref)과 **등급 후보**(A · B · 보류 — `waitlistGradeHint`)를 함께 찍는다. 최종 등급은 운영자가
 * 메모를 읽고 정한다(메모·주소를 어떤 모델에도 넣지 않는다).
 *
 * **출력의 주소·메모는 정화한다**(`sanitizeDisplayText` — 제어문자·양방향 제어·폭 없는 문자 제거, 한 줄) — 대기자가 쓴 문자열이 운영자 터미널에
 * ANSI 이스케이프·줄바꿈으로 가짜 줄을 그리지 못하게.
 */

import { parseArgs } from 'node:util';

import { sanitizeDisplayText } from '../../src/notify/approval-notification-template';
import { waitlistGradeHint } from '../../src/ops/console/reads';
import {
  findWaitlistEntryOp,
  inviteOldestWaitlistOp,
  inviteWaitlistEntryOp,
  listWaitlistOp,
  removeWaitlistEntryOp,
} from '../../src/ops/core/waitlist';
import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

const USAGE =
  'pnpm admin:waitlist (list [--status waiting|invited|expired|joined|all] [--limit N] | invite (--email <주소> | --oldest <N>) | remove --email <주소>) [--yes] [--by <이름>]';

const STATUSES = ['waiting', 'invited', 'expired', 'joined', 'all'] as const;
type Status = (typeof STATUSES)[number];

/** 그 주소를 처음 적은 사람이 쓴 답 — 주소 주인이 썼는지 확인하지 않았다. */
const UNVERIFIED_TAG = '[본인 확인 안 됨 · unverified]';

function gradeLabel(grade: ReturnType<typeof waitlistGradeHint>): string {
  return grade === null ? '-' : grade === 'hold' ? '보류' : grade;
}

export async function waitlist(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      status: { type: 'string' },
      limit: { type: 'string' },
      email: { type: 'string' },
      oldest: { type: 'string' },
      yes: { type: 'boolean', default: false },
      by: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new AdminInputError(`명령은 하나. ${USAGE}`);

  if (command === 'list') {
    if (values.email !== undefined || values.oldest !== undefined) throw new AdminInputError(`list 는 --status · --limit 만. ${USAGE}`);
    const status = (values.status ?? 'waiting') as Status;
    if (!(STATUSES as readonly string[]).includes(status)) throw new AdminInputError(`--status 는 ${STATUSES.join('|')}.`);
    const limit = values.limit === undefined ? 50 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new AdminInputError('--limit 는 1~1000 정수.');
    return withAdminConnection(deps, async ({ pool }) => {
      const rows = await listWaitlistOp(pool, status, limit);
      for (const row of rows) {
        const grade = waitlistGradeHint(row.use_case, row.note);
        deps.io.out(
          [
            row.id,
            row.email === null ? '(가입함 — 주소 지움)' : sanitizeDisplayText(row.email, 254),
            row.lang,
            row.status === 'invited' && row.invite_expires_at !== null && row.invite_expires_at.getTime() <= Date.now() ? 'expired' : row.status,
            row.created_at.toISOString(),
            row.invite_expires_at === null ? '-' : row.invite_expires_at.toISOString(),
            // 신청서(202609301530) — 닫힌 값(CHECK). 비면 '-'. 등급은 후보다(보류 = 먼저 발송). 용도 · 등급 후보는 메모처럼 본인 확인이 없는 답에서 나온다 —
            //   값이 있으면 같은 표지를 붙인다.
            `use_case=${row.use_case === null ? '-' : `${row.use_case} ${UNVERIFIED_TAG}`}`,
            `heard_from=${row.heard_from ?? '-'}`,
            `ref=${row.ref ?? '-'}`,
            `grade?=${gradeLabel(grade)}${grade === null ? '' : ` ${UNVERIFIED_TAG}`}`,
            // 메모는 그 주소를 처음 적은 사람이 쓴 문자열이다 — 주소 주인이 썼는지 확인하지 않았다.
            row.note === null ? '-' : `${UNVERIFIED_TAG} ${sanitizeDisplayText(row.note, 200)}`,
          ].join('\t'),
        );
      }
      deps.io.err(`${status} ${String(rows.length)}건. 초대: pnpm admin:waitlist invite --email <주소> | --oldest <N>`);
      return EXIT_OK;
    });
  }

  if (command !== 'invite' && command !== 'remove') throw new AdminInputError(USAGE);
  if (values.status !== undefined || values.limit !== undefined) throw new AdminInputError(`--status · --limit 는 list 에만. ${USAGE}`);
  const actor = actorOf('admin:waitlist', values.by, deps.env);

  if (command === 'invite' && values.oldest !== undefined) {
    if (values.email !== undefined) throw new AdminInputError(`--email 과 --oldest 중 하나. ${USAGE}`);
    const n = Number(values.oldest);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new AdminInputError('--oldest 는 1~50 정수.');
    return withAdminConnection(deps, async ({ pool, target }) => {
      await confirmProduction(target, `대기자 명단에서 가장 오래 기다린 ${String(n)}명 초대(초대 메일 발송 · 14일)`, values.yes, deps.io);
      const invited = await inviteOldestWaitlistOp(pool, n, actor);
      for (const row of invited) deps.io.out(`${row.entryId}\tinvited\t${row.inviteExpiresAt}`);
      deps.io.err(`${String(invited.length)}명을 초대했다(대기 ${String(n)}명 요청). 초대 메일은 login-mailer 가 보낸다.`);
      return EXIT_OK;
    });
  }

  const email = values.email?.trim().toLowerCase() ?? '';
  if (email === '' || values.oldest !== undefined) throw new AdminInputError(`${command} 는 --email <주소>. ${USAGE}`);
  return withAdminConnection(deps, async ({ pool, target }) => {
    const entry = await findWaitlistEntryOp(pool, email);
    if (entry === null) throw new AdminInputError(`대기 항목이 없다: ${sanitizeDisplayText(email, 254)}`, 'entry_not_found');
    if (command === 'invite') {
      await confirmProduction(target, `${sanitizeDisplayText(email, 254)} 초대(초대 메일 발송 · 14일)`, values.yes, deps.io);
      const result = await inviteWaitlistEntryOp(pool, entry.id, actor);
      deps.io.out(`${result.entryId}\tinvited\t${result.inviteExpiresAt}`);
      deps.io.err(result.fromStatus === 'waiting' ? '초대했다. 초대 메일은 login-mailer 가 보낸다.' : `다시 초대했다(이전 상태 ${result.fromStatus}) — 새 14일.`);
      return EXIT_OK;
    }
    await confirmProduction(target, `${sanitizeDisplayText(email, 254)} 대기 항목 지우기(행 삭제 — 되돌릴 수 없다)`, values.yes, deps.io);
    const result = await removeWaitlistEntryOp(pool, entry.id, actor);
    deps.io.out(`${result.entryId}\tremoved`);
    deps.io.err(`지웠다(이전 상태 ${result.fromStatus}). 주소·메모가 남지 않는다 — 감사에는 항목 id 만 남는다.`);
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(waitlist);
