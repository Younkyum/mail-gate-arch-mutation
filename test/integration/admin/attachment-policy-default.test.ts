/**
 * 메일 기본기 2차 — 정책 첨부 총량 기본값 = "요금제를 따른다"(JSON null, 리드 판정 2026-09-27). 실제 Postgres · 실제 프로비저닝 경로(콘솔
 * `POST /api/agents`) · 실제 정책 소스(앱 롤).
 *
 *   **플래그 `ATMARK_POLICY_ATTACHMENT_FOLLOW_PLAN`(기본 false)** 이 켜져 있을 때만 새로 만든 에이전트의 `config_json.max_attachment_bytes_total`
 *   이 null 이고 버전 1 스냅샷도 같다 → 로더의 Stage 6 한도는 min(요금제, 25 MiB): beta 10 MiB → team 20 MiB · scale 25 MiB. 정책 버전을 새로
 *   올리는 관리 연산도 null 정책을 받는다(평가 가능 검사). 꺼져 있으면 예전 명시값 10 MiB(보안 리뷰 M3).
 *   기존 에이전트는 운영 명령(`pnpm admin:policy-attachment-default` = `policyAttachmentDefaultOp`)이 옮긴다 — dry-run 은 쓰지 않고, 적용은
 *   에이전트마다 정책 새 버전(작성자 기록) · 값이 이미 바뀐 정책은 건너뛴다 · 다시 돌려도 대상 0.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setOrgPlanOp } from '../../../scripts/admin/plan';
import type { AdminDependencies } from '../../../src/admin/context';
import { changePolicyOp, LEGACY_ATTACHMENT_DEFAULT_BYTES, policyAttachmentDefaultOp } from '../../../src/admin/ops/policy';
import { createPostgresPolicySource } from '../../../src/db/repositories';
import { toAgentId } from '../../../src/db/schema';
import { loadEvaluationInput } from '../../../src/policy/policy-loader';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix } from './support';

const MIB = 1024 * 1024;

describe.skipIf(!AVAILABLE)('정책 첨부 총량 기본값 null — 요금제를 따른다', () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    deps = adminDeps(admin, { features: { addressAliases: false, policyAttachmentFollowPlan: true } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end()]);
  });

  it('새 에이전트 정책·버전 1 스냅샷이 null · Stage 6 한도 = 요금제(beta 10 → team 20 → scale 25 MiB) · 관리 연산이 null 정책으로 새 버전을 쓴다', async () => {
    const org = await newOrganization(owner, 'beta');
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'attach-default', localPart: `ad-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agentId = toAgentId((created.json() as { agent: { id: string } }).agent.id);

    const policy = await owner.query<{ live: unknown; snap: unknown }>(
      `SELECT p.config_json -> 'max_attachment_bytes_total' AS live, v.snapshot -> 'config_json' -> 'max_attachment_bytes_total' AS snap
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version WHERE p.agent_id = $1`,
      [agentId],
    );
    expect(policy.rows[0]).toEqual({ live: null, snap: null });

    const limit = async (): Promise<number> => {
      const input = await loadEvaluationInput(createPostgresPolicySource(app), {
        agentId,
        attempt: { routeId: 'send', fromAddress: 'x@atmark.ai', recipients: ['to@example.com'], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
        now: new Date(),
        traceId: null,
        thisAttemptCostCents: 0,
        release: null,
      });
      return input.policy.content.maxAttachmentBytesTotal;
    };
    expect(await limit()).toBe(10 * MIB);
    for (const [plan, expected] of [['team', 20 * MIB], ['scale', 25 * MIB]] as const) {
      await setOrgPlanOp(owner, { organizationId: org.id, plan, overrides: {}, graceUntil: undefined, actor: 'admin:plan:test', note: null });
      expect(await limit(), plan).toBe(expected);
    }

    // 관리 연산(분당 한도 바꾸기)이 null 정책으로 새 버전을 쓴다 — 평가 가능 검사(`assertEvaluable`)가 null 을 받는다.
    await changePolicyOp(admin, agentId, { outboundMode: undefined, inboundMode: undefined, perMinute: 5, verificationSenders: undefined }, 'test');
    expect(await limit()).toBe(25 * MIB);
  });

  const createAgent = async (d: AdminDependencies): Promise<string> => {
    const org = await newOrganization(owner, 'beta');
    const session = await login(d, mailer, org);
    const created = await call(d, 'POST', '/api/agents', authed(session, { body: { name: 'attach-default', localPart: `ad-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { agent: { id: string } }).agent.id;
  };
  const liveValue = async (agentId: string): Promise<{ live: unknown; snap: unknown; version: number }> => {
    const row = await owner.query<{ live: unknown; snap: unknown; version: number }>(
      `SELECT p.config_json -> 'max_attachment_bytes_total' AS live, v.snapshot -> 'config_json' -> 'max_attachment_bytes_total' AS snap, p.current_version AS version
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version WHERE p.agent_id = $1`,
      [agentId],
    );
    const found = row.rows[0];
    if (found === undefined) throw new Error('정책 없음');
    return found;
  };

  it('플래그 꺼짐(기본) → 새 에이전트는 예전 명시값 10 MiB', async () => {
    const agentId = await createAgent(adminDeps(admin));
    expect(await liveValue(agentId)).toMatchObject({ live: LEGACY_ATTACHMENT_DEFAULT_BYTES, snap: LEGACY_ATTACHMENT_DEFAULT_BYTES });
  });

  it('운영 명령 — dry-run 은 쓰지 않는다 · 적용은 새 버전(작성자) · null 정책은 대상 아님 · 다시 돌리면 대상 0', async () => {
    const legacy = await createAgent(adminDeps(admin));
    const following = await createAgent(deps);
    const before = await liveValue(legacy);
    const scope = { agentIds: [legacy, following] };

    const dry = await policyAttachmentDefaultOp(admin, { dryRun: true, createdBy: 'admin:policy-attachment-default:test', ...scope });
    expect(dry.changed).toEqual([]);
    expect(dry.candidates).toBe(1);
    expect(await liveValue(legacy)).toEqual(before);

    const applied = await policyAttachmentDefaultOp(admin, { dryRun: false, createdBy: 'admin:policy-attachment-default:test', ...scope });
    expect(applied.changed).toEqual([legacy]);
    const after = await liveValue(legacy);
    expect(after).toMatchObject({ live: null, snap: null, version: before.version + 1 });
    const author = await owner.query<{ created_by: string }>('SELECT created_by FROM policy_versions WHERE agent_id = $1 AND version = $2', [legacy, after.version]);
    expect(author.rows[0]?.created_by).toBe('admin:policy-attachment-default:test');

    const again = await policyAttachmentDefaultOp(admin, { dryRun: false, createdBy: 'admin:policy-attachment-default:test', ...scope });
    expect(again).toEqual({ candidates: 0, changed: [] });
  });
});
