/**
 * P0(`.omc/plans/ops-console.md` §3.9) — 운영자 연산·화면 코어를 `src/ops/**` 로 옮겼다. 쓰기 함수가 **하나**라는 것(CLI · 로컬 화면이 같은 참조)과
 * 화면 소스의 HTML 싱크 0 을 새 자리에서 다시 본다(기존 `test/unit/ops-web/*` 은 옛 경로의 다시 내보내기를 통해 그대로 돈다).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as cliPlan from '../../../scripts/admin/plan';
import * as cliReview from '../../../scripts/admin/org-review';
import * as shimApi from '../../../scripts/ops-web/api';
import { setAgentSuspendedOp, setOrganizationFreezeAuditedOp } from '../../../src/admin/ops/agents';
import { OPS } from '../../../src/ops/console/api';
import { buildOpsPage } from '../../../src/ops/console/page';
import { releaseToProviderOp, setOrgPlanOp } from '../../../src/ops/core/plan';
import { listPendingReviewOp, reviewOrganizationOp } from '../../../src/ops/core/review';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('ops 코어 이전(P0)', () => {
  it('OPS 는 코어 함수 그 자체 — CLI 가 다시 내보내는 것과 같은 참조', () => {
    expect(OPS.reviewOrganization).toBe(reviewOrganizationOp);
    expect(OPS.setOrgPlan).toBe(setOrgPlanOp);
    expect(OPS.releaseToProvider).toBe(releaseToProviderOp);
    expect(OPS.setOrganizationFreeze).toBe(setOrganizationFreezeAuditedOp);
    expect(OPS.setAgentSuspended).toBe(setAgentSuspendedOp);
    expect(cliReview.reviewOrganizationOp).toBe(reviewOrganizationOp);
    expect(cliReview.listPendingReviewOp).toBe(listPendingReviewOp);
    expect(cliPlan.setOrgPlanOp).toBe(setOrgPlanOp);
    expect(shimApi.OPS).toBe(OPS);
  });

  it('src/ops 는 scripts 를 import 하지 않는다', () => {
    for (const file of tsFiles(join(process.cwd(), 'src/ops'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from '[^']*scripts\//);
      expect(source, file).not.toMatch(/import\(\s*['"`][^'"`]*scripts\//);
    }
  });

  it('화면 소스에 HTML 문자열 싱크가 없다(innerHTML · outerHTML · insertAdjacentHTML · document.write · eval · new Function)', () => {
    const files = tsFiles(join(process.cwd(), 'src/ops'));
    expect(files.some((file) => file.endsWith('console/page.ts'))).toBe(true);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
    expect(buildOpsPage().html).toContain('<script>');
  });
});
