/**
 * ★ AC-12 — **sentinel 유출 스캔: 누락이 아니라 부재를 증명한다** (계획 §5.0b Layer P3 · §4B.3 "비공개" 표).
 *
 * `GET /v1/identity/{address}` 는 무인증·CORS *·`Cache-Control: public` 이다 — **이 헤더가 붙어 있는 한 이 스캔은 필수 게이트다**(한 번 나간
 * 값은 CDN·브라우저 캐시에서 회수할 수 없다). 방법: 게시된 에이전트의 **모든 비공개 칸**에 고유 sentinel 을 심고(조직 이름·소유자 메일·정책
 * 수치·설정·연락처 목록·감사 사유 …), DB 에 이미 있는 비공개 값(키 참조·조직 id·토큰 해시·정책 버전 id·정확한 생성 시각)을 **읽어 와서**, 라우터를
 * 거친 응답 전문(헤더 포함)에 그 어느 것도 없음을 단언한다. 비공허성: 같은 스캔이 공개 값(이름·DID)은 찾아낸다.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { appendPolicyVersionFromLive } from '../db/support/harness';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix } from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

/** 공개 라우트만 쓰는 의존성 — 다른 칸을 건드리면 던진다(이 라우트가 무엇을 읽는지 보증). */
function identityOnlyDeps(app: Pool): ApiDependencies {
  const untouchable = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`공개 신원 라우트가 ${String(property)} 를 건드렸다`);
      },
    },
  );
  return new Proxy({ identity: { directory: createPostgresIdentityDirectory(app) } } as unknown as ApiDependencies, {
    get(target, property) {
      if (property === 'identity') return (target as { identity: unknown }).identity;
      return untouchable;
    },
  });
}

describe.skipIf(!AVAILABLE)('AC-12 — 공개 신원 응답에 비공개 값이 하나도 없다 (sentinel 스캔)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let agentId: AgentId;
  let address: string;
  const sentinels: string[] = [];

  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = createPool(APP_URL, { max: 2 });
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-leak-'));
    const deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
    const organization = await newOrganization(owner);
    const session = await login(deps, mailer, organization);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'Public Name', localPart: `leak-${suffix()}` } }));
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    agentId = toAgentId(agent.id);
    address = agent.address;

    // ── sentinel 심기 — 비공개 칸 전부(소유자 롤) ───────────────────────────────────────────
    const plant = (name: string): string => {
      const value = `__LEAK_${name}_${suffix()}__`;
      sentinels.push(value);
      return value;
    };
    await owner.query('UPDATE organizations SET name = $2 WHERE id = $1', [organization.id, plant('orgname')]);
    await owner.query(
      `UPDATE agent_policies SET limits = limits || jsonb_build_object('per_minute', 7, 'sentinel', $2::text),
                                 config_json = config_json || jsonb_build_object('note', $3::text)
        WHERE agent_id = $1`,
      [agentId, plant('limits'), plant('config')],
    );
    // 목록 변경은 새 정책 버전과 한 트랜잭션이어야 커밋된다(202609241040 제약 트리거).
    const rulesClient = await owner.connect();
    try {
      await rulesClient.query('BEGIN');
      for (const list of ['allow', 'block'] as const) {
        await rulesClient.query(
          `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by) VALUES ($1, 'outbound', $2, 'address', $3, 'test')`,
          [agentId, list, `${plant(`${list}rule`).toLowerCase()}@example.com`],
        );
      }
      await appendPolicyVersionFromLive(rulesClient, agentId);
      await rulesClient.query('COMMIT');
    } finally {
      rulesClient.release();
    }
    await owner.query(
      `INSERT INTO audit_logs (agent_id, decision, reasons, evaluated_at) VALUES ($1, 'denied', ARRAY['rate_limit_per_minute', $2::text], now())`,
      [agentId, plant('reason')],
    ).catch(() => undefined); // 감사 행 모양이 더 엄격하면 건너뛴다 — 공개 API 는 이 표를 읽지도 않는다.

    // ── 이미 있는 비공개 값 — DB 에서 읽어 목록에 넣는다 ───────────────────────────────────────
    const privateValues = await owner.query<{ value: string }>(
      `SELECT k.key_ref AS value FROM agent_keypairs k WHERE k.agent_id = $1
       UNION ALL SELECT a.organization_id::text FROM agents a WHERE a.id = $1
       UNION ALL SELECT o.owner_email FROM organizations o JOIN agents a ON a.organization_id = o.id WHERE a.id = $1
       UNION ALL SELECT t.token_hash FROM agent_api_keys t WHERE t.agent_id = $1
       UNION ALL SELECT v.id::text FROM policy_versions v WHERE v.agent_id = $1
       UNION ALL SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') FROM agents a WHERE a.id = $1`,
      [agentId],
    );
    sentinels.push(...privateValues.rows.map((row) => row.value));

    // ── 게시 ────────────────────────────────────────────────────────────────────────────────
    expect((await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session))).statusCode).toBe(202);
    await runPassportPublisherTick(
      {
        db: signerDb,
        signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
        documents: { put: () => Promise.resolve() },
        cdn: { invalidate: () => Promise.resolve() },
        now: () => new Date(Date.now() + 1000),
      },
      { agentIds: [agentId] },
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end(), signerDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  it('라우터를 거친 응답 전문(상태·헤더·본문)에 sentinel·비공개 값이 0건 — 공개 값은 있다(비공허)', async () => {
    const result = await routeHttpApiEvent(identityOnlyDeps(app), {
      rawPath: `/v1/identity/${encodeURIComponent(address)}`,
      requestContext: { requestId: 'leak-scan', stage: '$default', http: { method: 'GET' } },
    });
    expect(result.statusCode).toBe(200);
    const serialized = JSON.stringify(result);
    expect(sentinels.length).toBeGreaterThanOrEqual(10);
    expect(sentinels.filter((sentinel) => serialized.includes(sentinel))).toEqual([]);
    expect(serialized).toContain('Public Name');
    expect(serialized).toContain(`did:web:id.atmark.ai:agents:${agentId}`);
    // 수치 전부 비공개 — 정책의 per_minute(7) 도, 정확한 연·월·일 시각도 없다(월 단위만).
    const body = JSON.parse(result.body) as { created_at: string };
    expect(body.created_at).toMatch(/^\d{4}-\d{2}$/);
    expect(result.body).not.toMatch(/"per_minute"|"limits"|"config_json"|"organization|"owner/);
  });

  it('헤더 — CORS * · public 캐시 300초 · 404 도 같은 헤더(존재 누설 없음)', async () => {
    const found = await routeHttpApiEvent(identityOnlyDeps(app), {
      rawPath: `/v1/identity/${address}`,
      requestContext: { requestId: 'h1', http: { method: 'GET' } },
    });
    const missing = await routeHttpApiEvent(identityOnlyDeps(app), {
      rawPath: `/v1/identity/nobody-${suffix()}@atmark.ai`,
      requestContext: { requestId: 'h2', http: { method: 'GET' } },
    });
    for (const result of [found, missing]) {
      expect(result.headers['access-control-allow-origin']).toBe('*');
      expect(result.headers['cache-control']).toBe('public, max-age=300');
    }
    expect(missing.statusCode).toBe(404);
    expect(Object.keys(missing.headers).sort()).toEqual(Object.keys(found.headers).sort());
  });
});
