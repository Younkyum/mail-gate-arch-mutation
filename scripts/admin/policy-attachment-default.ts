#!/usr/bin/env tsx
/**
 * scripts/admin/policy-attachment-default.ts — 정책 첨부 총량 기본값을 "요금제를 따른다"(null)로 옮기는 **운영 명령**(메일 기본기 2차 · 보안 리뷰 M3).
 *
 *   pnpm admin:policy-attachment-default                      # dry-run(기본) — 옮길 정책 수만 센다
 *   pnpm admin:policy-attachment-default --apply [--by <운영자>] [--yes]
 *
 * 값이 옛 프로비저닝 기본값(10 MiB) 그대로인 정책마다 **정책 새 버전**을 쓴다(`src/admin/ops/policy.ts` `policyAttachmentDefaultOp` — 에이전트마다
 * 한 트랜잭션 · 작성자 `admin:policy-attachment-default:<운영자>` · `policy.version` 투명성 잎 = 감사 기록). 마이그레이션이 아닌 이유: **옛 정책 로더는
 * null 을 읽지 못해** 그 에이전트의 모든 발송이 `evaluation_error` 가 된다 — 새 코드가 모든 λ(api · approval-release · scheduled-sender)에 배포된 **뒤**
 * 운영자가 부른다(런북 deploy §23-2). 운영 DB 면 확인 프롬프트(`--yes` 로 건너뜀). 다시 불러도 안전하다(이미 null 이면 대상이 아니다).
 */

import { parseArgs } from 'node:util';

import { LEGACY_ATTACHMENT_DEFAULT_BYTES, policyAttachmentDefaultOp } from '../../src/admin/ops/policy';
import { actorOf, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

const USAGE = 'pnpm admin:policy-attachment-default [--apply [--by <운영자>] [--yes]]';

export async function policyAttachmentDefault(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: 'boolean', default: false },
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
  return withAdminConnection(deps, async ({ pool, target }) => {
    const preview = await policyAttachmentDefaultOp(pool, { dryRun: true, createdBy: 'dry-run' });
    deps.io.out(`candidates ${String(preview.candidates)} (max_attachment_bytes_total = ${String(LEGACY_ATTACHMENT_DEFAULT_BYTES)})`);
    if (!values.apply) {
      deps.io.out('dry-run — 바꾸지 않았다. 새 코드가 모든 λ 에 배포된 것을 확인한 뒤 --apply 로 다시 부른다.');
      return EXIT_OK;
    }
    await confirmProduction(
      target,
      `정책 ${String(preview.candidates)}개의 첨부 총량을 null(요금제를 따른다)로 — 에이전트마다 정책 새 버전. 새 정책 로더가 배포돼 있어야 한다.`,
      values.yes,
      deps.io,
    );
    const result = await policyAttachmentDefaultOp(pool, { dryRun: false, createdBy: actorOf('admin:policy-attachment-default', values.by, deps.env) });
    deps.io.out(`changed ${String(result.changed.length)} / candidates ${String(result.candidates)}`);
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(policyAttachmentDefault);
