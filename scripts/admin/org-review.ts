#!/usr/bin/env tsx
/**
 * scripts/admin/org-review.ts — 셀프 가입 조직의 **운영자 검토**(`.omc/handoffs/signup-contract.md` §3).
 *
 *   pnpm admin:org-review --list                         # 검토 대기(pending_review) 조직: id · 이름 · 소유자 · 가입 시각 · 에이전트 수
 *   pnpm admin:org-review --org <조직 id> --activate [--yes]   # → active (외부 발송이 열린다 — Stage 0 이 더는 거부하지 않는다)
 *   pnpm admin:org-review --org <조직 id> --reject [--yes]     # → rejected + 그 조직 에이전트 전부 **운영자 정지**
 *
 * **소유자 롤이다**(`DATABASE_MIGRATION_URL` — `common.ts`). `organizations.review_status`·`reviewed_at` 은 테이블 소유자만 바꿀 수
 * 있다(트리거 `organizations_review_guard`, 202609240800) — admin 롤(콘솔)이나 앱 롤로는 이 전이가 DB 에서 거부된다. 그래서
 * 이 CLI 가 검토 상태를 바꾸는 **유일한 경로**다.
 *
 * `--reject` 가 에이전트를 운영자 정지(`suspended_by='operator'`)로 거는 이유: 거절 조직의 발송은 Stage 0 이 이미 거부하지만
 * (`org_review_rejected`), 정지를 함께 걸면 나중에 누가 검토 상태를 되돌려도 에이전트는 운영자가 따로 풀기 전까지 멈춰 있다
 * (두 겹). 소유자(콘솔)는 운영자 정지를 풀 수 없다(`agents_operator_suspension_guard`). 이미 소유자가 정지한 에이전트는 운영자
 * 정지로 넘겨받는다(`admin:kill-switch` 와 같은 규칙). `provisioning`·`disabled` 는 그대로 둔다 — 활성이 아니다.
 * 같은 트랜잭션에서 그 조직 에이전트의 **살아 있는 API 토큰을 전부 폐기**한다(`agent_api_keys.revoked_at`, 보안 검증 M3) — 정지는
 * 발송을 막지만 토큰이 살아 있으면 조회 API(수신함·감사)는 계속 열린다. 폐기는 되돌릴 수 없다(`agent_api_keys_revoked_once`) —
 * 되살린 조직은 `admin:agent-token --rotate` 로 새 토큰을 받는다.
 *
 * `--activate` 는 `pending_review`·`rejected` 에서 `active` 로. 거절했던 조직을 되살려도 **에이전트 운영자 정지는 풀지 않는다** —
 * 에이전트마다 `pnpm admin:kill-switch --agent <id> off` 로 따로 푼다(되살리는 판단과 에이전트를 다시 여는 판단을 나눈다).
 *
 * **베타 기간 자동 부여**(ADR-0011 §10, 창업자 결정 2026-09-25): 활성화 전이와 **같은 트랜잭션**에서 조직이 `beta` 를 받는다(출처 `operator` ·
 * 원인 `review` · `billing_audit` 한 행 · 투명성 잎 `billing.entitlement`) — SQL 코어 `ops_org_activate_core`(202609290510, 호스팅 콘솔과 같은 코어 —
 * `src/ops/core/review.ts` 가 부른다). 행이 없거나 백필이
 * 준 Free 일 때만이고, 운영자·공급자가 정한 행은 그대로 둔다. 스위치는 `BETA_ON_ACTIVATION`(src/billing/plans.ts)과 SQL
 * `ops_activation_beta_enabled()` 한 쌍 — 베타 종료(GA + 60일)에 커밋 + 마이그레이션으로 함께 끈다(테스트가 둘을 묶는다). 이미 active 인 조직에 다시 `--activate` 하면 아무것도 쓰지 않는다. 거절은 요금제를 바꾸지 않는다.
 * 쓰기는 `writeEntitlementVersion` 과 같은 규칙(같은 잠금 키 · 감사 행 · v1/v+1 — 차분 테스트 `test/integration/ops/review-differential.test.ts`)이다. 이 CLI 는
 * **소유자 롤 그대로**다(WP-2 D-7 — 검토 상태 전이는 소유자만 할 수 있어서 좁은 롤로 옮기지 않았다, `admin:plan` 만 `atmark_billing_operator`).
 *
 * **출력의 이름·주소는 정화한다**(`sanitizeDisplayText` — 제어문자·양방향 제어·폭 없는 문자 제거, 한 줄) — 조직 이름은 가입한
 * 사람이 고른 문자열이고, 운영자 터미널에 ANSI 이스케이프·줄바꿈으로 가짜 줄을 그릴 수 있다.
 */

import { parseArgs } from 'node:util';

import { ORGANIZATION_ID_PATTERN } from '../../src/admin/ops/agents';
import { sanitizeDisplayText } from '../../src/notify/approval-notification-template';
import { listPendingReviewOp, reviewOrganizationOp, type PendingRow, type ReviewOutcome } from '../../src/ops/core/review';
import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

/** 연산은 `src/ops/core/review.ts` 로 옮겼다(P0 — 운영자 화면 코어가 같이 쓴다). 이 CLI 는 그것을 부르고, 기존 import 경로를 위해 다시 내보낸다. */
export { listPendingReviewOp, reviewOrganizationOp, type PendingRow, type ReviewOutcome };

const USAGE = 'pnpm admin:org-review (--list | --org <조직 id> (--activate | --reject)) [--yes]';

export async function orgReview(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      list: { type: 'boolean', default: false },
      org: { type: 'string' },
      activate: { type: 'boolean', default: false },
      reject: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }

  if (values.list) {
    if (values.org !== undefined || values.activate || values.reject) throw new AdminInputError(`--list 는 혼자 쓴다. ${USAGE}`);
    return withAdminConnection(deps, async ({ pool }) => {
      const pending = await listPendingReviewOp(pool);
      for (const row of pending) {
        deps.io.out(
          [
            row.id,
            sanitizeDisplayText(row.name, 80),
            sanitizeDisplayText(row.owner_email ?? '-', 254),
            row.created_at.toISOString(),
            `agents=${String(row.agents)}`,
          ].join('\t'),
        );
      }
      deps.io.err(`검토 대기 ${String(pending.length)}개. 활성화: pnpm admin:org-review --org <id> --activate`);
      return EXIT_OK;
    });
  }

  if (values.activate === values.reject) throw new AdminInputError(`--activate 와 --reject 중 정확히 하나. ${USAGE}`);
  const org = values.org?.trim() ?? '';
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid). ${USAGE}`);
  const target: 'active' | 'rejected' = values.activate ? 'active' : 'rejected';

  return withAdminConnection(deps, async ({ pool, target: where }) => {
    await confirmProduction(
      where,
      values.activate ? `조직 ${org} 활성화(review_status=active — 외부 발송이 열린다)` : `조직 ${org} 거절(review_status=rejected + 에이전트 전부 운영자 정지)`,
      values.yes,
      deps.io,
    );
    const outcome = await reviewOrganizationOp(pool, org, target, actorOf('admin:org-review', undefined, deps.env));

    deps.io.out(`organization ${org} review_status=${target}`);
    if (!outcome.changed) {
      deps.io.err('이미 그 상태다 — 바꾸지 않았다.');
      return EXIT_OK;
    }
    if (target === 'active') {
      deps.io.err(`${outcome.from} → active. 이 조직의 외부 발송이 Stage 0 에서 더는 거부되지 않는다(에이전트·정책 규칙은 그대로).`);
      const plan = outcome.plan;
      if (plan?.granted === true) {
        deps.io.err(`요금제 ${plan.fromPlan ?? '(행 없음 = free)'} → beta (version ${String(plan.version)}, 원인 review · 베타 기간 자동 부여 BETA_ON_ACTIVATION).`);
      } else if (plan?.granted === false) {
        deps.io.err(plan.reason === 'disabled' ? '요금제는 그대로다(BETA_ON_ACTIVATION 꺼짐 — 필요하면 pnpm admin:plan).' : `요금제는 그대로다(이미 ${String(plan.plan)} — 운영자·공급자가 정한 행).`);
      }
      if (outcome.from === 'rejected') {
        deps.io.err('거절 때 건 에이전트 운영자 정지는 그대로다 — 에이전트마다 pnpm admin:kill-switch --agent <id> off 로 푼다.');
      }
      return EXIT_OK;
    }
    for (const id of outcome.suspended) deps.io.out(`agent ${id} status=suspended suspended_by=operator`);
    deps.io.out(`agent_api_keys revoked=${String(outcome.revokedTokens)}`);
    deps.io.err(`${outcome.from} → rejected. 에이전트 ${String(outcome.suspended.length)}개를 운영자 정지했다(org_review_rejected · agent_not_active).`);
    deps.io.err(`API 토큰 ${String(outcome.revokedTokens)}개를 폐기했다(되돌릴 수 없다 — 되살리면 admin:agent-token --rotate).`);
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(orgReview);
