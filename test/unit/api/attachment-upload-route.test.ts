/**
 * `POST /v1/attachments` 라우트의 **숨긴 404**(보안 리뷰 L-3) — 서비스는 가짜. 실제 DB·S3 위의 흐름은 `test/integration/outbound/attachments.test.ts`.
 *
 *   - 단계 공개(`orgs:`)에서 인증 실패 · 목록 밖 조직은 응답이 꺼짐과 같은 404 `route_not_found` 지만, 거부로 센다 —
 *     `atmark.api.preflight_rejected` 메트릭 + `api.preflight_rejected {http_status: 404, error_code: auth_failed_hidden | rollout_closed}`
 *     (에이전트·조직 id 없음).
 *   - 스위치가 꺼졌으면(false) 로그·메트릭 없이 404 다(경로가 없는 것과 같다) · 켜짐(true)의 인증 실패는 401 그대로 센다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import type { OutboundAttachmentService } from '../../../src/api/outbound-attachments';
import { handleCreateAttachmentUpload } from '../../../src/api/routes/outbound-attachments';
import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import type { FeatureRollout } from '../../../src/runtime/feature-rollout';

afterEach(() => {
  resetLogSink();
});

const AGENT = toAgentId('a'.repeat(32));
const ORG = '11111111-2222-4333-8444-555555555555';
const issued = issueAgentToken(AGENT, ['messages:send']);
const tokens: AgentTokenStore = {
  findByHash: (hash) =>
    Promise.resolve(
      hash === hashAgentToken(issued.plaintext) ? { tokenHash: hash, agentId: AGENT, capabilities: ['messages:send'], revokedAt: null, expiresAt: null } : null,
    ),
};

function deps(rollout: FeatureRollout, enabled: boolean) {
  const attachments = {
    rollout,
    enabledFor: () => Promise.resolve(enabled),
    createUpload: () => Promise.reject(new Error('createUpload 에 닿으면 안 된다')),
  } as unknown as OutboundAttachmentService;
  return { tokens, attachments, now: () => new Date('2026-09-28T00:00:00.000Z') };
}

const request = (authorization: string | null): ApiRequest => ({
  headers: authorization === null ? {} : { authorization },
  query: {},
  body: { agent_id: AGENT, filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) },
});

async function run(rollout: FeatureRollout, enabled: boolean, authorization: string | null) {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const response = await handleCreateAttachmentUpload(deps(rollout, enabled), request(authorization));
  resetLogSink();
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    response,
    logs: parsed.filter((line) => line['event'] === 'api.preflight_rejected'),
    metrics: parsed.filter((line) => line[METRIC_NAMES.preflightRejected] === 1),
    raw: lines.join('\n'),
  };
}

describe('발신 첨부 업로드 — 허용목록 모드의 숨긴 404 는 센다(L-3)', () => {
  const allowlist: FeatureRollout = { organizations: new Set([ORG]) };

  it.each([
    ['토큰 없음', null],
    ['없는 토큰', 'Bearer atk_agent_nope'],
  ])('인증 실패(%s) → 404 route_not_found · api.preflight_rejected {404, auth_failed_hidden} · 메트릭 1', async (_label, authorization) => {
    const { response, logs, metrics } = await run(allowlist, true, authorization);
    expect([response.status, response.body['error']]).toEqual([404, 'route_not_found']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', route_id: 'attachment_upload', http_status: 404, error_code: 'auth_failed_hidden' });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ route_id: 'attachment_upload' });
  });

  it('목록 밖 조직 → 404 route_not_found · api.preflight_rejected {404, rollout_closed} · 메트릭 1 · id 를 싣지 않는다', async () => {
    const { response, logs, metrics, raw } = await run(allowlist, false, `Bearer ${issued.plaintext}`);
    expect([response.status, response.body['error']]).toEqual([404, 'route_not_found']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ http_status: 404, error_code: 'rollout_closed' });
    expect(Object.keys(logs[0] ?? {}).sort()).toEqual(['error_code', 'event', 'http_status', 'level', 'route_id', 'ts']);
    expect(metrics).toHaveLength(1);
    expect(raw).not.toContain(AGENT);
    expect(raw).not.toContain(ORG);
  });

  it('스위치 꺼짐(false) → 404 · 로그·메트릭 없음(경로가 없는 것과 같다)', async () => {
    const { response, logs, metrics } = await run(false, false, null);
    expect(response.status).toBe(404);
    expect(logs).toHaveLength(0);
    expect(metrics).toHaveLength(0);
  });

  it('켜짐(true)의 인증 실패 → 401 그대로 · error_code unauthorized 로 센다', async () => {
    const { response, logs, metrics } = await run(true, true, null);
    expect(response.status).toBe(401);
    expect(logs[0]).toMatchObject({ http_status: 401, error_code: 'unauthorized' });
    expect(metrics).toHaveLength(1);
  });
});

describe('발신 첨부 업로드 — agent_id 생략 = 토큰의 에이전트 (2026-10-11)', () => {
  function capturing() {
    const seen: string[] = [];
    const attachments = {
      rollout: true,
      enabledFor: () => Promise.resolve(true),
      createUpload: (input: { readonly agentId: string }) => {
        seen.push(input.agentId);
        return Promise.resolve({ kind: 'created', attachment: { id: 'x' }, upload: { url: 'u', headers: {}, expiresAt: new Date() } });
      },
    } as unknown as OutboundAttachmentService;
    return { deps: { tokens, attachments, now: () => new Date('2026-09-28T00:00:00.000Z') }, seen };
  }
  const body = { filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) };
  const call = (extra: Record<string, unknown>) => ({ headers: { authorization: `Bearer ${issued.plaintext}` }, query: {}, body: { ...body, ...extra } });

  it('생략 → 토큰의 에이전트 · 자기 id → 그대로 · 남의 id → 403 · 형식 위반 → 400', async () => {
    const c = capturing();
    await handleCreateAttachmentUpload(c.deps, call({})).catch(() => undefined);
    await handleCreateAttachmentUpload(c.deps, call({ agent_id: AGENT })).catch(() => undefined);
    expect(c.seen).toEqual([AGENT, AGENT]);
    expect((await handleCreateAttachmentUpload(c.deps, call({ agent_id: 'b'.repeat(32) }))).status).toBe(403);
    for (const bad of ['X', null, 7]) expect((await handleCreateAttachmentUpload(c.deps, call({ agent_id: bad }))).status, String(bad)).toBe(400);
    expect(c.seen).toEqual([AGENT, AGENT]);
  });
});
