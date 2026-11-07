#!/usr/bin/env tsx
/**
 * scripts/admin/org-create.ts — `pnpm admin:org-create --name <조직명> --owner-email <소유자 주소> [--yes]`
 *
 * 조직 한 행. 소유자 이메일은 **필수**다 — 승인 알림의 유일한 수신자다(`organizations.owner_email`).
 * 검증·정규화는 `resolveOwnerEmail`(에이전트 도메인 `atmark.ai` 거부), INSERT 는 프로비저닝 저장소의
 * `insertOrganization` 을 그대로 쓴다 — `owner_email` 을 다루는 SQL 이 `src/api/provisioning-store.ts` 밖에
 * 생기지 않는다(`test/arch/gate-chokepoint.arch.test.ts` ⑥).
 *
 * 출력: 조직 id(다음 단계 `admin:agent-provision --org` 의 값). 로직은 `src/admin/ops/agents.ts` `createOrganizationOp`.
 * **관리 API 에는 조직 생성이 없다** — 소유자가 로그인하려면 owner_email 이 먼저 있어야 하므로 조직은 CLI 로 1회 만든다.
 */

import { parseArgs } from 'node:util';

import { createOrganizationOp } from '../../src/admin/ops/agents';
import { resolveOwnerEmail, ProvisioningError } from '../../src/identity/provisioning';
import { AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

const USAGE = 'pnpm admin:org-create --name <조직명> --owner-email <소유자 주소> [--yes]';

export async function orgCreate(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      name: { type: 'string' },
      'owner-email': { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const name = values.name?.trim() ?? '';
  if (name.length < 1 || name.length > 200) throw new AdminInputError(`--name 은 1~200자 (organizations.name CHECK). ${USAGE}`);
  if (values['owner-email'] === undefined) throw new AdminInputError(`--owner-email 이 필요하다 — 승인 알림의 수신자다. ${USAGE}`);
  let ownerEmail: string;
  try {
    // 확인 프롬프트에 정규형을 보여 주려고 먼저 정규화한다 — 같은 검증을 공유 연산이 한 번 더 한다.
    ownerEmail = resolveOwnerEmail(values['owner-email']);
  } catch (error) {
    if (error instanceof ProvisioningError) throw new AdminInputError(error.message, 'invalid_owner_email');
    throw error;
  }

  return withAdminConnection(deps, async ({ pool, target }) => {
    await confirmProduction(target, `조직 생성 "${name}" (소유자 ${ownerEmail})`, values.yes, deps.io);
    const organization = await createOrganizationOp(pool, { name, ownerEmail });
    deps.io.out(`organization ${organization.id}`);
    deps.io.err(`조직 "${organization.name}" 을 만들었다. 소유자(승인 알림·관리 화면 로그인 수신자): ${ownerEmail}`);
    deps.io.err(`다음: pnpm admin:agent-provision --org ${organization.id} --name <이름> --local-part <주소 앞부분>`);
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(orgCreate);
