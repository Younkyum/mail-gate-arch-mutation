#!/usr/bin/env tsx
/**
 * scripts/admin/agent-provision.ts — `pnpm admin:agent-provision --org <조직 id> --name <이름> --local-part <주소 앞부분>
 *   [--seeds a@x.com,b@y.com] [--budget-cents 10000] [--custody aws|local] [--by <운영자>] [--yes]`
 *
 * **새 로직이 없다.** `provisionAgent`(src/identity/provisioning.ts)를 프로비저닝 저장소(src/api/provisioning-store.ts)
 * 위에서 그대로 부른다 — 데모(`scripts/demo-p3.ts`)와 같은 호출이다. 그래서 PP-A 원자성이 그대로 온다: 에이전트 ·
 * keypair · draft passport · 주소 · 정책(기본 `approval_required`, AC-a1) · 버전 1 · seed 관계 · 토큰이 **한 트랜잭션**
 * 에서 전부 커밋되거나 전무다.
 *
 * **custody:** 운영 DB 대상이면 AWS(KMS envelope → Secrets Manager `atmark/agent-keypairs/<agentId>`), 로컬이면 개발
 * 파일. 운영 DB + 로컬 custody 는 거부한다(`./custody.ts`). 롤백되면 이미 만든 시크릿 하나가 고아로 남는다 —
 * 아무도 참조하지 않는 암호문이다(`src/passport/custody.ts` `store` 주석의 의도된 방향).
 *
 * **출력 (B5):** agentId · 주소 · 정책 모드 · 토큰(1회). **draft passport 의 DID 는 찍지 않는다** — ADR-0002, P6 전까지
 * DID 는 어떤 표면에도 나가지 않는다(`ProvisionedAgent` 에 passport 필드가 없는 이유와 같다).
 *
 * **프로비저닝 호출은 `src/admin/ops/agents.ts` `provisionAgentOp`** — 관리 API(`POST /api/agents`)와 같은 함수다.
 */

import { parseArgs } from 'node:util';

import { addressConflict, DEFAULT_BUDGET_CENTS, ORGANIZATION_ID_PATTERN, provisionAgentOp } from '../../src/admin/ops/agents';
import { readFeatureFlag, RUNTIME_ENV } from '../../src/runtime/config';
import {
  actorOf,
  AdminInputError,
  confirmProduction,
  EXIT_OK,
  isMain,
  runAdminMain,
  splitList,
  withAdminConnection,
  type AdminDeps,
} from './common';
import { parseCustodyChoice, sdkCustodyPorts, selectCustody, type AwsCustodyPorts } from './custody';

const USAGE =
  'pnpm admin:agent-provision --org <조직 id> --name <이름> --local-part <주소 앞부분> ' +
  '[--seeds a@x.com,b@y.com] [--budget-cents 10000] [--custody aws|local] [--by <운영자>] [--yes]';

export { DEFAULT_BUDGET_CENTS };

export interface ProvisionDeps extends AdminDeps {
  /** AWS 포트. 기본은 실제 SDK — 테스트는 가짜를 준다. */
  readonly awsCustodyPorts?: () => AwsCustodyPorts;
}

export async function agentProvision(argv: readonly string[], deps: ProvisionDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      org: { type: 'string' },
      name: { type: 'string' },
      'local-part': { type: 'string' },
      seeds: { type: 'string', multiple: true },
      'budget-cents': { type: 'string' },
      custody: { type: 'string' },
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
  const org = values.org?.trim() ?? '';
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid)다 — admin:org-create 의 출력. ${USAGE}`);
  if (values.name === undefined || values['local-part'] === undefined) throw new AdminInputError(USAGE);
  const budgetRaw = values['budget-cents'] ?? String(DEFAULT_BUDGET_CENTS);
  if (!/^\d+$/.test(budgetRaw)) throw new AdminInputError(`--budget-cents 는 0 이상의 정수: ${budgetRaw}`);
  const custodyChoice = parseCustodyChoice(values.custody);
  const createdBy = actorOf('admin:agent-provision', values.by, deps.env);
  const seeds = splitList(values.seeds);

  return withAdminConnection(deps, async ({ pool, target }) => {
    // custody 를 먼저 고른다 — 운영 DB + 로컬 custody 는 확인 프롬프트 전에, DB 에 아무것도 쓰기 전에 거부된다.
    const custody = selectCustody(target.target, custodyChoice, deps.env, deps.awsCustodyPorts ?? (() => sdkCustodyPorts(deps.env)));
    await confirmProduction(
      target,
      `에이전트 프로비저닝 "${values.name ?? ''}" <${values['local-part'] ?? ''}@…> · 키 보관 ${custody.kind} · seed ${String(seeds.length)}`,
      values.yes,
      deps.io,
    );

    const provisioned = await provisionAgentOp(
      pool,
      {
        organizationId: org,
        name: values.name ?? '',
        localPart: values['local-part'] ?? '',
        seeds,
        budgetCents: Number(budgetRaw),
        createdBy,
        // 보안 리뷰 M3 — 콘솔(admin λ)과 같은 스위치. 운영자 셸에 `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN=true` 가 있을 때만 null(요금제를 따른다).
        attachmentFollowsPlan: readFeatureFlag(process.env, RUNTIME_ENV.policyAttachmentFollowPlan),
        // 운영자 CLI 로 만든 에이전트는 허용 목록(seed = 발신 allow)으로 태어난다 — "전체" 기본값은 콘솔 세션의 소유자 생성만(적대 검증 I08).
        outboundMode: 'allowlist_only',
      },
      custody,
    );

    // 주소를 지금 쓸 수 없다(사용 중 · 다른 조직의 폐기 뒤 보류 — ADR-0013 2026-09-29 개정). 콘솔과 같은 409 로 멈춘다(키 보관은 돌지 않았다).
    if (provisioned.kind === 'taken') throw addressConflict();
    // B5 — passport·DID 는 찍지 않는다. `provisioned` 에는 애초에 그 필드가 없다.
    deps.io.out(`agent ${provisioned.agent.id}`);
    deps.io.out(`address ${provisioned.agent.address ?? ''}`);
    deps.io.out(`token ${provisioned.token}`);
    deps.io.err(
      `에이전트를 만들었다 — 조직 ${provisioned.organizationId} · 상태 ${provisioned.agent.status} · ` +
        `정책 ${provisioned.agent.outboundMode ?? '?'} v${String(provisioned.policyVersion)} · 키 보관 ${custody.kind} · ` +
        `seed ${String(seeds.length)} · 월 예산 ${budgetRaw}¢`,
    );
    deps.io.err('⚠ token 은 지금 한 번만 보인다(DB 에는 sha256 만 남는다). 잃으면 admin:agent-token 으로 새로 발급한다.');
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain((argv, deps) => agentProvision(argv, deps));
