/**
 * ★ 신원 게시 e2e — **콘솔(관리 API) → outbox → 서명 Lambda 틱 → S3·CloudFront(가짜) → 공개 API** (계약 §3 · 계획 §4B.1b · §4B.2 · §4B.3).
 *
 * 실제 Postgres 롤 넷으로 돈다: 콘솔 = `atmark_admin`, 서명 워커 = `atmark_passport_signer`, 공개 API = `atmark_app`, 지반·검사 = 소유자.
 * AWS 호출 0 — S3 쓰기면·CloudFront 무효화면은 기록만 하는 가짜, 서명은 개발 키 파일(`devfile://`)로. 실메일 0.
 *
 * 흐름: draft(공개 404·콘솔 DID 없음) → publish(멱등 — 두 번 눌러도 요청 하나·감사 하나) → 틱(서명·업로드·무효화) → **업로드된 바이트를 외부
 * 라이브러리로 검증** → 공개 API 200 → 다시 틱(아무 일 없음) → 같은 내용 publish(unchanged, 버전 그대로) → suspend(v2, 문서 유지) →
 * publish(v3) → revoke(v4, JWT 만료 즉시) → 이후 publish 409 · 문서 0건 삭제. 그리고 실패 경로: 업로드 실패 → signed 로 남았다가 다음 틱에 완료,
 * 서명 실패 → 버전 행 0 · 재시도 대기.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compactVerify, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleGetIdentity as handlePublicIdentity } from '../../../src/api/routes/identity';
import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { PUBLIC_IDENTITY_FIELDS } from '../../../src/passport/public-view';
import { runPassportPublisherTick, type PassportPublisherDependencies } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import {
  adminDeps,
  adminRolePool,
  APP_URL,
  authed,
  AVAILABLE,
  call,
  loginMailerPool,
  newOrganization,
  ownerPool,
  suffix,
  login,
  type Session,
} from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

interface Upload {
  readonly key: string;
  readonly body: string;
  readonly contentType: string;
}

function fakeAws() {
  const uploads: Upload[] = [];
  const invalidations: { readonly paths: readonly string[]; readonly ref: string }[] = [];
  let failUploads = false;
  return {
    uploads,
    invalidations,
    setFailUploads(value: boolean) {
      failUploads = value;
    },
    latest(key: string): string | undefined {
      return uploads.filter((upload) => upload.key === key).at(-1)?.body;
    },
    documents: {
      put(key: string, body: string, contentType: string) {
        if (failUploads) return Promise.reject(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));
        uploads.push({ key, body, contentType });
        return Promise.resolve();
      },
    },
    cdn: {
      invalidate(paths: readonly string[], ref: string) {
        invalidations.push({ paths, ref });
        return Promise.resolve();
      },
    },
  };
}

function deepKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => deepKeys(item, `${prefix}[]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...deepKeys(child, path)];
  });
}

describe.skipIf(!AVAILABLE)('신원 게시 e2e — 관리 API → outbox → 서명 Lambda → S3·CloudFront(가짜) → 공개 API', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let session: Session;
  let deps: ReturnType<typeof adminDeps>;
  let agentId: AgentId;
  let address: string;
  const aws = fakeAws();
  let clock = new Date();

  const publisher = (): PassportPublisherDependencies => ({
    db: signerDb,
    signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
    documents: aws.documents,
    cdn: aws.cdn,
    now: () => clock,
  });
  /**
   * 한 틱. 시계는 기본으로 **지금 + 1초**다 — 요청 행의 기한은 DB `now()`(마이크로초)로 찍히고 JS 시계는 밀리초라, 같은 순간이면 "아직 기한 전" 으로
   * 읽힐 수 있다(운영에서는 다음 틱이 집는다). 기한 뒤를 흉내 낼 때만 `at` 을 준다.
   */
  const tick = (agents: readonly AgentId[] = [agentId], at: Date = new Date(Date.now() + 1000)) => {
    clock = at;
    return runPassportPublisherTick(publisher(), { agentIds: agents });
  };
  const publicGet = async (raw: string) => handlePublicIdentity({ directory: createPostgresIdentityDirectory(app) }, { address: raw });
  const identity = async (id: AgentId = agentId) => (await call(deps, 'GET', `/api/agents/${id}/identity`, authed(session))).json() as Record<string, unknown>;
  const versions = async (id: AgentId = agentId) =>
    (await owner.query<{ version: number; status: string; superseded: boolean }>(
      'SELECT version, status, superseded_at IS NOT NULL AS superseded FROM passports WHERE agent_id = $1 ORDER BY version',
      [id],
    )).rows;

  async function createAgent(name: string): Promise<{ id: AgentId; address: string }> {
    const localPart = `id-${name}-${suffix()}`;
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: `Agent ${name}`, localPart } }));
    expect(created.statusCode).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { id: toAgentId(agent.id), address: agent.address };
  }

  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = createPool(APP_URL, { max: 2 });
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-passport-flow-'));
    deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
    const organization = await newOrganization(owner);
    session = await login(deps, mailer, organization);
    const agent = await createAgent('main');
    agentId = agent.id;
    address = agent.address;
  });

  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end(), signerDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  it('draft — 콘솔은 DID·URL 을 주지 않는다(B5) · 공개 API 는 없는 주소와 **같은** 404', async () => {
    const view = await identity();
    expect(view).toMatchObject({ status: 'draft', did: null, version: 1, didDocumentUrl: null, passportUrl: null, contentHash: null, pending: null });
    const draft = await publicGet(address);
    const unknown = await publicGet(`nobody-${suffix()}@atmark.ai`);
    const malformed = await publicGet('not an address');
    expect(draft).toEqual(unknown);
    expect(malformed).toEqual(unknown);
    expect(draft.status).toBe(404);
  });

  it('publish — CSRF 필수 · 두 번 눌러도 요청 하나·감사 하나 · 정지는 draft 에서 409', async () => {
    const noCsrf = await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, { cookies: session.cookies });
    expect(noCsrf.statusCode).toBe(403);
    const first = await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session));
    const second = await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session));
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const a = first.json() as { request: { id: string; kind: string; status: string }; identity: { pending: { id: string } } };
    const b = second.json() as { request: { id: string } };
    expect(a.request).toMatchObject({ kind: 'publish', status: 'pending' });
    expect(b.request.id).toBe(a.request.id);
    expect(a.identity.pending.id).toBe(a.request.id);
    const audits = await owner.query('SELECT 1 FROM owner_actions WHERE action = $1 AND target_id = $2', ['agent.identity.publish', agentId]);
    expect(audits.rowCount).toBe(1);
    const suspend = await call(deps, 'POST', `/api/agents/${agentId}/identity/suspend`, authed(session));
    expect(suspend.statusCode).toBe(409);
    expect((suspend.json() as { error: string }).error).toBe('identity_not_published');
  });

  it('틱 — 서명(v1 draft→published 제자리) · 세 파일 업로드 · 무효화(요청 id 가 CallerReference)', async () => {
    const counts = await tick();
    expect(counts).toMatchObject({ 'signed.published': 1, uploaded: 1 });
    expect(await versions()).toEqual([{ version: 1, status: 'published', superseded: false }]);
    expect(aws.uploads.map((upload) => upload.key).sort()).toEqual(
      [`agents/${agentId}/did.json`, `agents/${agentId}/passport.json`, `agents/${agentId}/passport.jws`].sort(),
    );
    expect(aws.uploads.find((upload) => upload.key.endsWith('passport.jws'))?.contentType).toBe('application/jose');
    const request = (await owner.query<{ id: string; status: string }>('SELECT id, status FROM passport_publish_requests WHERE agent_id = $1', [agentId])).rows;
    expect(request).toHaveLength(1);
    expect(request[0]?.status).toBe('done');
    // 공개 API 는 와일드카드 하나 — 주소 수·표기(`@`·`%40`)와 무관하게 전부 지운다(2026-09-24 검증).
    expect(aws.invalidations.at(-1)).toEqual({
      paths: [`/agents/${agentId}/*`, '/v1/identity/*'],
      ref: `passport-request-${request[0]?.id ?? ''}`,
    });
  });

  it('업로드된 바이트를 **외부 라이브러리(jose)** 로 검증 — kid → did.json JWK · JWT 발급자·주체 · passport.json = JWS 페이로드 · SHA-256 = content_hash', async () => {
    const didJson = JSON.parse(aws.latest(`agents/${agentId}/did.json`) ?? '{}') as { id: string; verificationMethod: { id: string; publicKeyJwk?: JWK }[] };
    const jws = aws.latest(`agents/${agentId}/passport.jws`) ?? '';
    const passportJson = aws.latest(`agents/${agentId}/passport.json`) ?? '';
    const { kid } = decodeProtectedHeader(jws);
    const jwk = didJson.verificationMethod.find((method) => method.id === kid)?.publicKeyJwk;
    expect(jwk).toBeDefined();
    const key = await importJWK(jwk as JWK, 'EdDSA');
    const { payload } = await compactVerify(jws, key);
    expect(new TextDecoder().decode(payload)).toBe(passportJson);
    const claims = (await jwtVerify(jws, key, { issuer: 'did:web:id.atmark.ai', subject: didJson.id, currentDate: new Date(Date.now() + 5000) })).payload;
    expect(claims['status']).toBe('published');
    const view = await identity();
    expect(view).toMatchObject({ status: 'published', did: didJson.id, version: 1, pending: null });
    expect(view['contentHash']).toBe(createHash('sha256').update(passportJson, 'utf8').digest('hex'));
    expect((view['lastResult'] as { outcome: string }).outcome).toBe('published');
  });

  it('공개 API 200 — 키 집합 ⊆ allowlist · CORS·캐시 헤더는 라우터 표가 붙인다 · 비정규 주소(대문자·공백·개행)는 없는 주소와 같은 404', async () => {
    const response = await publicGet(address);
    expect(response.status).toBe(200);
    const allowed = new Set<string>(PUBLIC_IDENTITY_FIELDS);
    expect(deepKeys(response.body).filter((key) => !allowed.has(key))).toEqual([]);
    expect(response.body).toMatchObject({ address, passport: { status: 'published', version: 1 }, agent: { status: 'active' } });
    expect((response.body as { attestations: unknown[] }).attestations).toHaveLength(4);
    // 비정규형은 고쳐 받지 않는다 — 변형마다 다른 CDN 캐시 키가 정지·폐기 뒤에도 옛 응답을 남기기 때문이다(2026-09-24 검증).
    const unknown = await publicGet(`nobody-${suffix()}@atmark.ai`);
    for (const variant of [address.toUpperCase(), ` ${address}`, `${address}\t`, `${address}\n`, address.replace(/@.*$/, '@ATMARK.AI')]) {
      expect(await publicGet(variant), JSON.stringify(variant)).toEqual(unknown);
    }
    expect(unknown.status).toBe(404);
  });

  it('★ 멱등 — 다시 틱: 요청 없음 · 새 버전 없음 · 업로드 없음', async () => {
    const before = aws.uploads.length;
    const counts = await tick();
    expect(counts['uploaded'] ?? 0).toBe(0);
    expect(counts['resign_enqueued']).toBe(0); // 24시간 안에 요청이 있었다.
    expect(await versions()).toHaveLength(1);
    expect(aws.uploads.length).toBe(before);
  });

  it('같은 내용으로 다시 publish → unchanged(버전 그대로) · 그래도 업로드로 수렴', async () => {
    const before = aws.uploads.length;
    expect((await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session))).statusCode).toBe(202);
    expect(await tick()).toMatchObject({ 'signed.unchanged': 1, uploaded: 1 });
    expect(await versions()).toHaveLength(1);
    expect(aws.uploads.length).toBe(before + 3);
  });

  it('suspend → v2 suspended(문서는 내리지 않고 재서명) · 공개 API 는 200 + suspended', async () => {
    expect((await call(deps, 'POST', `/api/agents/${agentId}/identity/suspend`, authed(session))).statusCode).toBe(202);
    expect(await tick()).toMatchObject({ 'signed.suspended': 1, uploaded: 1 });
    expect(await versions()).toEqual([
      { version: 1, status: 'published', superseded: true },
      { version: 2, status: 'suspended', superseded: false },
    ]);
    expect(JSON.parse(aws.latest(`agents/${agentId}/passport.json`) ?? '{}')).toMatchObject({ status: 'suspended', version: 2 });
    expect(await publicGet(address)).toMatchObject({ status: 200, body: { passport: { status: 'suspended', version: 2 } } });
  });

  it('publish → v3 published · operator revoke → v4 revoked(JWT 즉시 만료 · did.json 에서 키를 내림) · 이후 publish 409 · 문서는 한 건도 지워지지 않는다', async () => {
    expect((await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session))).statusCode).toBe(202);
    expect(await tick()).toMatchObject({ 'signed.published': 1 });
    // 폐기 전: did.json 의 키로 v3(published) JWS 가 JWT 로 통과한다 — 이 JWS 를 폐기 뒤에 다시 검증해 본다.
    const liveDid = JSON.parse(aws.latest(`agents/${agentId}/did.json`) ?? '{}') as { id: string; verificationMethod: { id: string; publicKeyJwk?: JWK }[] };
    const liveKey = await importJWK(liveDid.verificationMethod[0]?.publicKeyJwk as JWK, 'EdDSA');
    const publishedJws = aws.latest(`agents/${agentId}/passport.jws`) ?? '';
    await expect(jwtVerify(publishedJws, liveKey, { currentDate: new Date(Date.now() + 5000) })).resolves.toBeDefined();

    await owner.query(`INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'revoke', 'operator:test')`, [agentId]);
    expect(await tick()).toMatchObject({ 'signed.revoked': 1, uploaded: 1 });
    expect((await versions()).map((row) => row.status)).toEqual(['published', 'suspended', 'published', 'revoked']);

    const jws = aws.latest(`agents/${agentId}/passport.jws`) ?? '';
    await expect(compactVerify(jws, liveKey)).resolves.toBeDefined(); // 폐기 문서도 (옛) 키의 진짜 서명이다.
    // 그러나 JWT 로는 이미 만료다(exp = 폐기 시각). 틱 시계가 +1초라 검증 시각도 그 뒤로 둔다.
    await expect(jwtVerify(jws, liveKey, { currentDate: new Date(Date.now() + 5000) })).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    // ★ 폐기의 효력 — did.json 에 검증 수단이 없다: 폐기 **전**에 발급된 published JWS(아직 exp 전)도 did.json 을 거쳐서는 키를 얻지 못한다.
    const revokedDid = JSON.parse(aws.latest(`agents/${agentId}/did.json`) ?? '{}') as Record<string, unknown>;
    expect(revokedDid['id']).toBe(liveDid.id);
    for (const key of ['verificationMethod', 'authentication', 'assertionMethod']) expect(revokedDid, key).not.toHaveProperty(key);
    const { kid } = decodeProtectedHeader(publishedJws);
    expect((revokedDid['verificationMethod'] as { id: string }[] | undefined)?.find((method) => method.id === kid)).toBeUndefined();

    const refused = await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session));
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toBe('identity_revoked');
    const documents = await owner.query('SELECT 1 FROM passport_documents d JOIN passports p ON p.id = d.passport_id WHERE p.agent_id = $1', [agentId]);
    expect(documents.rowCount).toBe(4);
    expect(await publicGet(address)).toMatchObject({ status: 200, body: { passport: { status: 'revoked' }, public_key: null, capabilities: { can_send: false } } });
  });

  it('업로드 실패 → signed 로 남아 재시도(last_error 코드만) → 다음 틱(기한 뒤)에 done · 버전은 하나', async () => {
    const other = await createAgent('upload');
    expect((await call(deps, 'POST', `/api/agents/${other.id}/identity/publish`, authed(session))).statusCode).toBe(202);
    aws.setFailUploads(true);
    expect(await tick([other.id])).toMatchObject({ 'signed.published': 1, upload_retry: 1 });
    const stuck = (await owner.query<{ status: string; attempt_count: number; last_error: string }>(
      'SELECT status, attempt_count, last_error FROM passport_publish_requests WHERE agent_id = $1',
      [other.id],
    )).rows[0];
    expect(stuck).toEqual({ status: 'signed', attempt_count: 1, last_error: 'upload:serviceunavailable' });
    aws.setFailUploads(false);
    expect(await tick([other.id], new Date())).not.toHaveProperty('uploaded'); // 기한(백오프 2분) 전 — 아직 아니다.
    expect(await tick([other.id], new Date(Date.now() + 5 * 60_000))).toMatchObject({ uploaded: 1 });
    expect(await versions(other.id)).toEqual([{ version: 1, status: 'published', superseded: false }]);
  });

  it('서명 실패(개발 키 파일 없음) → 트랜잭션 롤백 — 버전 행 0 · 요청은 pending + 재시도 대기', async () => {
    const other = await createAgent('nokey');
    rmSync(join(keyDir, `${other.id}.pkcs8`));
    expect((await call(deps, 'POST', `/api/agents/${other.id}/identity/publish`, authed(session))).statusCode).toBe(202);
    expect(await tick([other.id])).toMatchObject({ sign_retry: 1 });
    expect(await versions(other.id)).toEqual([{ version: 1, status: 'draft', superseded: false }]);
    const request = (await owner.query<{ status: string; last_error: string; delayed: boolean }>(
      `SELECT status, last_error, next_attempt_at > now() AS delayed FROM passport_publish_requests WHERE agent_id = $1`,
      [other.id],
    )).rows[0];
    expect(request).toEqual({ status: 'pending', last_error: 'sign:dev_key_unreadable', delayed: true });
    expect((await identity(other.id))['pending']).toMatchObject({ kind: 'publish', lastError: 'sign:dev_key_unreadable' });
  });

  it('다른 조직의 에이전트 → 404 agent_not_found(없는 것과 구별 없음)', async () => {
    const otherOrg = await newOrganization(owner);
    const otherSession = await login(deps, mailer, otherOrg);
    const response = await call(deps, 'GET', `/api/agents/${agentId}/identity`, authed(otherSession));
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('agent_not_found');
    const publish = await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(otherSession));
    expect(publish.statusCode).toBe(404);
  });
});
