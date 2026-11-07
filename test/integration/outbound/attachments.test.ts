/**
 * 메일 기본기 2차 A2 — **발신 첨부 끝에서 끝까지**(실제 Postgres · 개발 전용 로컬 객체 저장소 · 가짜 전송단 — 실발송 0).
 *
 *   업로드 생성(`POST /v1/attachments`) → 스테이징에 바이트(서명된 PUT 의 자리) → 스캔 판정 → `send` 의 `attachments` → 관문 → 전송단이
 *   영구본을 읽어 체크섬을 대조하고 `multipart/mixed` 로 조립 — 원문을 파서로 되읽어 한글 파일명·바이트를 본다(AC-A2-1).
 *   AC-A2-4 남의 첨부 404 · 스캔 전 409(행 없음) · 위협 400 · MIME 허용목록 밖 400(복사 전 — 보안 리뷰 M2).
 *   AC-A2-5 Free 6 MB → 400 `attachment_bytes_exceeded`(복사 전 · 메시지 행 없음 · SES 0 — 보안 리뷰 M2. Stage 6 은 심층 방어로 남는다) · Beta 6 MB → 발송.
 *   AC-A2-7 영구본이 사라지면 보내지 않는다(`MessageAttachmentIntegrityError`) · 릴리스 메타 = 결속 행 · 영구 키 = 첨부 id.
 *   AC-A2-8 에이전트당 하루 101번째 업로드 429 · DB 천장 트리거 · 조직 하루 1 GiB(보안 리뷰 L7) · 첨부 하나당 결속 50통(M2).
 *   보안 리뷰 M1 — 파일명 확장자·MIME 결속 CHECK · 인코딩된 단어 CHECK.
 *   스위치 꺼짐 → 업로드 404 · 발송 400 `attachments_disabled` · 전달·예약은 400 `attachments_not_supported`.
 *   단계 공개(`orgs:<uuid>,…`) — 목록의 조직은 켜짐과 같고, 목록 밖 조직은 꺼짐과 같다(업로드 404 — 인증 실패도 404 · 발송 400). 이미 결속된
 *   첨부의 릴리스 메타는 스위치와 무관하다.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PostalMime from 'postal-mime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createObjectContentStore, MessageAttachmentIntegrityError } from '../../../src/api/content-store';
import { createOutboundAttachmentService, loadAgentOrganizationId, loadAttachmentLimits, permanentKeyFor, stagingKeyFor } from '../../../src/api/outbound-attachments';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import type { ApiRequest } from '../../../src/api/http';
import { handleCreateAttachmentUpload } from '../../../src/api/routes/outbound-attachments';
import { handleSend } from '../../../src/api/routes/send';
import { handleCreateScheduledMessage } from '../../../src/api/routes/scheduled-messages';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresOutboundAttachmentStore } from '../../../src/db/repositories/outbound-attachment-store';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { buildRawMessage } from '../../../src/mail/mime/build';
import type { OutboundTransport } from '../../../src/policy/gate';
import {
  createLocalMalwareScanner,
  createLocalObjectStore,
  createLocalOutboundAttachmentObjects,
  markLocalMalwareScan,
} from '../../../src/storage/local-object-store';
import type { MalwareScanStatus } from '../../../src/storage/object-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { closeTestPool, DATABASE_AVAILABLE, newAgentId, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const RECIPIENT = 'attach-probe@example.com';
const MIB = 1024 * 1024;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atmark-attach-'));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  if (DATABASE_AVAILABLE) await closeTestPool();
});

interface Harness {
  readonly fixture: Fixture;
  readonly token: string;
  readonly deps: {
    readonly tokens: ReturnType<typeof createPostgresAgentTokenStore>;
    readonly service: OutboundServiceDependencies;
    readonly transport: OutboundTransport;
  };
  readonly uploads: Parameters<typeof handleCreateAttachmentUpload>[0];
  readonly sent: string[];
}

/** 스위치 — 불리언, 또는 단계 공개 허용목록(`own-org` = 이 픽스처의 조직만 · `other-org` = 다른 조직만). */
type Switch = boolean | 'own-org' | 'other-org';
const OTHER_ORG = '0b6f9f8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

async function harness(plan: 'free' | 'beta', enabled: Switch = true): Promise<Harness> {
  const pool = testPool();
  const fixture = await seedFixture(pool, { allowlist: [RECIPIENT], plan: plan === 'free' ? null : 'beta' });
  const rollout = typeof enabled === 'boolean' ? enabled : { organizations: new Set([enabled === 'own-org' ? fixture.organizationId : OTHER_ORG]) };
  // 픽스처의 정책은 text/plain 만 허용한다 — 이 파일은 text/plain 첨부로 시험한다(MIME 허용목록 거부는 png 로).
  const issued = issueAgentToken(fixture.agentId);
  const tokens = createPostgresAgentTokenStore(pool);
  await createPostgresAgentTokenStore(provisioningPool()).insert({ agentId: fixture.agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
  const objects = createLocalOutboundAttachmentObjects({ directory: root });
  const attachments = createOutboundAttachmentService({
    enabled: rollout,
    organizationOf: (agentId) => loadAgentOrganizationId(pool, agentId),
    store: createPostgresOutboundAttachmentStore(pool),
    objects,
    scanner: createLocalMalwareScanner({ directory: root }),
    limitsFor: (agentId, now) => loadAttachmentLimits(pool, agentId, now),
  });
  const content = createObjectContentStore(createLocalObjectStore({ directory: root }), objects);
  const gate = createPostgresGateStores(pool);
  const service: OutboundServiceDependencies = {
    source: gate.source,
    audit: gate.audit,
    dispatchStore: gate.leases,
    serializer: gate.serializer,
    sendEvidence: gate.sendEvidence,
    messages: createPostgresOutboundMessageStore(pool),
    content,
    leaseTtlSeconds: 300,
    riskSignals: inertRiskSignals(),
    dlp: inertDlp(),
    now: () => new Date(),
    attachments,
  };
  const sent: string[] = [];
  // **가짜 전송단** — SES 전송단과 같은 순서(본문 출처 load → 영구본 체크섬 대조 → `buildRawMessage`)로 원문을 조립해 모을 뿐 네트워크로
  // 나가지 않는다(실발송 금지 · 전송단 파일 참조는 arch 허용목록 밖이라 조립 함수를 직접 부른다).
  const transport: OutboundTransport = {
    async send(request) {
      const loaded = await content.load(request.messageId);
      sent.push(
        buildRawMessage({
          fromAddress: request.fromAddress,
          recipients: request.recipients,
          subject: loaded.subject,
          messageIdHeader: request.messageIdHeader,
          date: new Date(),
          text: loaded.text,
          html: loaded.html,
          threading: loaded.threading,
          replyTo: null,
          attachments: loaded.attachments ?? [],
        }),
      );
      return { sesMessageId: `fake-ses-${randomUUID()}` };
    },
  };
  return { fixture, token: issued.plaintext, deps: { tokens, service, transport }, uploads: { tokens, attachments, now: () => new Date() }, sent };
}

function request(h: Harness, body: Record<string, unknown>, key: string | null = `attach-${sha(new TextEncoder().encode(JSON.stringify(body))).slice(0, 16)}`): ApiRequest {
  return {
    headers: { authorization: `Bearer ${h.token}`, ...(key === null ? {} : { 'idempotency-key': key }) },
    query: {},
    body: { agent_id: h.fixture.agentId, ...body },
  };
}

/** 업로드 생성 → 스테이징에 바이트(서명된 PUT 자리) → 스캔 판정. 첨부 id. */
async function upload(h: Harness, bytes: Uint8Array, filename: string, scan: MalwareScanStatus | null = 'NO_THREATS_FOUND', mimeType = 'text/plain'): Promise<string> {
  const created = await handleCreateAttachmentUpload(h.uploads, request(h, { filename, mime_type: mimeType, bytes: bytes.length, sha256: sha(bytes) }, null));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body['attachment_id'] as string;
  const upload = created.body['upload'] as { method: string; url: string; headers: Record<string, string> };
  expect(upload.method).toBe('PUT');
  expect(upload.headers['x-amz-checksum-sha256']).toBe(createHash('sha256').update(bytes).digest('base64'));
  const key = stagingKeyFor(h.fixture.agentId, id);
  await createLocalObjectStore({ directory: root }).putIfAbsent(key, bytes, mimeType);
  if (scan !== null) markLocalMalwareScan(key, scan, { directory: root });
  return id;
}

const send = (h: Harness, attachments: readonly string[], extra: Record<string, unknown> = {}) =>
  handleSend(h.deps, request(h, { from: h.fixture.address, to: [RECIPIENT], subject: '첨부 시험', text: '본문', attachments, ...extra }));

describe.skipIf(!DATABASE_AVAILABLE)('A2 발신 첨부 — 실 Postgres · 로컬 객체 · 가짜 SES', { timeout: 120_000 }, () => {
  it('AC-A2-1 — 업로드 → 검사 → 발송: multipart/mixed · 한글 파일명 · 바이트 왕복 · 결속 행 · audit 1', async () => {
    const h = await harness('beta');
    const note = new TextEncoder().encode('안녕하세요. 첨부 본문입니다.\n');
    const id = await upload(h, note, '회의록 2026-09.txt');
    const response = await send(h, [id]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(h.sent).toHaveLength(1);
    const parsed = await PostalMime.parse(h.sent[0] ?? '');
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType])).toEqual([['회의록 2026-09.txt', 'text/plain']]);
    const content = parsed.attachments[0]?.content;
    expect(typeof content === 'string' ? content : new TextDecoder().decode(content)).toBe('안녕하세요. 첨부 본문입니다.\n');
    const messageId = response.body['message_id'] as string;
    const links = await testPool().query<{ position: number; attachment_id: string; permanent_key: string }>(
      'SELECT position, attachment_id::text AS attachment_id, permanent_key FROM message_attachments WHERE message_id = $1',
      [messageId],
    );
    expect(links.rows).toEqual([{ position: 0, attachment_id: id, permanent_key: `outbound/attachments/${id}` }]);
    expect(permanentKeyFor(id)).toBe(`outbound/attachments/${id}`);
    // 릴리스 메타 = 결속 행(자리 순).
    expect((await h.deps.service.attachments?.metaForMessage(messageId))?.map((meta) => [meta.filename, meta.bytes])).toEqual([['회의록 2026-09.txt', note.length]]);
  });

  it('AC-A2-4 — 남의 첨부 404 · 스캔 전 409(행 없음) · 위협 400 · MIME 허용목록 밖 400(복사 전)', async () => {
    const h = await harness('beta');
    const other = await harness('beta');
    const foreign = await upload(other, new TextEncoder().encode('x'), 'x.txt');
    expect((await send(h, [foreign])).body).toMatchObject({ error: 'attachment_not_found' });
    const pending = await upload(h, new TextEncoder().encode('y'), 'y.txt', null);
    const before = await testPool().query('SELECT count(*)::int AS n FROM messages WHERE agent_id = $1', [h.fixture.agentId]);
    const waiting = await send(h, [pending]);
    expect([waiting.status, waiting.body['error']]).toEqual([409, 'attachment_scan_pending']);
    const after = await testPool().query('SELECT count(*)::int AS n FROM messages WHERE agent_id = $1', [h.fixture.agentId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const eicar = await upload(h, new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), 'eicar.txt', 'THREATS_FOUND');
    expect((await send(h, [eicar])).body).toMatchObject({ error: 'attachment_malicious' });
    const png = await upload(h, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'a.png', 'NO_THREATS_FOUND', 'image/png');
    const denied = await send(h, [png]);
    expect([denied.status, denied.body['error']]).toEqual([400, 'attachment_type_not_allowed']);
    expect(h.sent).toHaveLength(0);
  });

  // ADR-0016 — 텍스트 첨부 6 MB 는 발신 DLP 입력 상한(1,000,000자)을 넘는다: 끝까지 보지 못한 내용을 깨끗하다고 하지 않으므로 Beta 는 발송 대신
  //   `dlp_scan_limit` 보류(202)다. 요금제 한도(Free 400 · Beta 통과)는 그대로 — 관문까지 간 것이 Beta 의 증거다.
  it('AC-A2-5 — Free 6 MB → 400 attachment_bytes_exceeded(복사 전 · 메시지 행 0 · SES 0) · Beta 6 MB → 관문까지(텍스트 6 MB 는 DLP 상한 → 보류)', async () => {
    const MB = new Uint8Array(MIB).fill(0x61);
    for (const [plan, expected] of [['free', 400], ['beta', 202]] as const) {
      const h = await harness(plan);
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) ids.push(await upload(h, MB, `part-${String(i)}.txt`));
      const response = await send(h, ids);
      expect(response.status, `${plan} ${JSON.stringify(response.body).slice(0, 200)}`).toBe(expected);
      if (plan === 'free') {
        expect(response.body['error']).toBe('attachment_bytes_exceeded');
        expect(h.sent).toHaveLength(0);
        const rows = await testPool().query('SELECT count(*)::int AS n FROM messages WHERE agent_id = $1', [h.fixture.agentId]);
        expect(rows.rows[0]).toEqual({ n: 0 });
      } else {
        expect(h.sent).toHaveLength(0);
        const audit = await testPool().query<{ reasons: string[] }>('SELECT reasons FROM audit_logs WHERE message_id = $1', [response.body['message_id']]);
        expect(audit.rows[0]?.reasons).toContain('dlp_scan_limit');
      }
    }
  });

  it('ADR-0016 M1 배선 계약 1 — text/* 첨부 속 비밀도 발신 DLP 가 본다(허용 상대여도 보류) · 깨끗한 첨부는 그대로 발송', async () => {
    const h = await harness('beta');
    const leaked = await upload(h, new TextEncoder().encode('aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n'), 'creds.txt');
    const held = await send(h, [leaked]);
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    const dlp = await testPool().query<{ outbound_dlp: string[] | null }>('SELECT outbound_dlp FROM messages WHERE id = $1', [held.body['message_id']]);
    expect(dlp.rows[0]?.outbound_dlp).toEqual(['third_party_secret']);
    expect(h.sent).toHaveLength(0);
    const clean = await upload(h, new TextEncoder().encode('회의록: 다음 주 화요일 오후 3시.\n'), 'notes.txt');
    expect((await send(h, [clean])).status).toBe(200);
  });

  it('AC-A2-7 — 영구본이 사라지면 전송단이 보내지 않는다(체크섬 대조)', async () => {
    const h = await harness('beta');
    const id = await upload(h, new TextEncoder().encode('keep'), 'keep.txt');
    const response = await send(h, [id]);
    const messageId = response.body['message_id'] as string;
    // 영구본 바이트를 바꿔치기(운영에서는 삭제·변조) — 로컬 파일을 덮어쓴다.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, permanentKeyFor(id)), 'tamp');
    await expect(h.deps.service.content.load(messageId)).rejects.toBeInstanceOf(MessageAttachmentIntegrityError);
    rmSync(join(root, permanentKeyFor(id)));
    await expect(h.deps.service.content.load(messageId)).rejects.toBeInstanceOf(MessageAttachmentIntegrityError);
  });

  it('AC-A2-8 — 에이전트당 하루 101번째 업로드 429 · DB 천장 트리거', async () => {
    const h = await harness('beta');
    const pool = testPool();
    await pool.query(
      `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
       SELECT g.id, $1::text, 'bulk.txt', 'text/plain', 1, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || g.id::text, now() + interval '1 day'
         FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 100)) g`,
      [h.fixture.agentId],
    );
    const created = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) }, null));
    expect([created.status, created.body['error']]).toEqual([429, 'attachment_daily_limit']);
    await expect(
      pool.query(
        `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
         VALUES ($2::uuid, $1::text, 'x.txt', 'text/plain', 1, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || $2::text, now() + interval '1 day')`,
        [h.fixture.agentId, '44444444-4444-4444-8444-444444444444'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('보안 리뷰 L7 — 조직 하루 1 GiB: 업로드 생성 429 attachment_org_daily_limit · DB 트리거 23514', async () => {
    const h = await harness('beta');
    const owner = provisioningPool();
    const org = (await owner.query<{ organization_id: string }>('SELECT organization_id FROM agents WHERE id = $1', [h.fixture.agentId])).rows[0]?.organization_id;
    // 같은 조직의 에이전트 다섯이 각자 하루 상한(200 MiB)까지 — 조직 합 1000 MiB. 이 에이전트가 20 MiB 더 — 1020 MiB.
    for (let i = 0; i < 5; i += 1) {
      const sibling = newAgentId();
      await owner.query(`INSERT INTO agents (id, organization_id, name, status, plan, monthly_budget_cents) VALUES ($1, $2, $3, 'active', 'free', 0)`, [
        sibling,
        org,
        `sibling-${sibling.slice(0, 8)}`,
      ]);
      await owner.query(
        `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
         SELECT g.id, $1::text, 'bulk.pdf', 'application/pdf', 26214400, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || g.id::text, now() + interval '1 day'
           FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 8)) g`,
        [sibling],
      );
    }
    await owner.query(
      `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
       SELECT g.id, $1::text, 'bulk.pdf', 'application/pdf', 10485760, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || g.id::text, now() + interval '1 day'
         FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 2)) g`,
      [h.fixture.agentId],
    );
    const created = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) }, null));
    expect([created.status, created.body['error']]).toEqual([201, undefined]);
    // 남은 여유 4 MiB - 1 바이트보다 큰 파일은 조직 상한에 걸린다(DB 트리거가 최종 방어).
    await expect(
      owner.query(
        `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
         VALUES ($2::uuid, $1::text, 'x.pdf', 'application/pdf', 4194305, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || $2::text, now() + interval '1 day')`,
        [h.fixture.agentId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.query(
      `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
       VALUES ($2::uuid, $1::text, 'x.pdf', 'application/pdf', 4194303, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || $2::text, now() + interval '1 day')`,
      [h.fixture.agentId, randomUUID()],
    );
    const refused = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'y.txt', mime_type: 'text/plain', bytes: 1, sha256: 'b'.repeat(64) }, null));
    expect([refused.status, refused.body['error']]).toEqual([429, 'attachment_org_daily_limit']);
  });

  it('보안 리뷰 M2 — 첨부 하나당 결속 50통: 발송 409 attachment_link_limit · DB 트리거 23514', async () => {
    const h = await harness('beta');
    const id = await upload(h, new TextEncoder().encode('shared'), 'shared.txt');
    const first = await send(h, [id]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const messageId = first.body['message_id'] as string;
    const owner = provisioningPool();
    // 같은 에이전트의 메시지 49통을 더 만들어(첫 통의 복제 — 헤더·멱등 키만 새로) 같은 첨부를 건다 → 50통.
    const addLinks = (n: number) =>
      owner.query(
        `WITH copies AS (
           INSERT INTO messages
           SELECT (jsonb_populate_record(NULL::messages, to_jsonb(m) || jsonb_build_object(
                    'id', g.id, 'message_id_header', '<copy.' || g.id::text || '@atmark.ai>', 'body_storage_key', NULL,
                    'idempotency_key', 'copy-' || g.id::text, 'ses_message_id', 'copy-ses-' || g.id::text))).*
             FROM messages m, (SELECT gen_random_uuid() AS id FROM generate_series(1, $3::int)) g
            WHERE m.id = $1::uuid
           RETURNING id)
         INSERT INTO message_attachments (message_id, position, attachment_id, permanent_key)
         SELECT c.id, 0, $2::uuid, 'outbound/attachments/' || $2::text FROM copies c`,
        [messageId, id, n],
      );
    await addLinks(49);
    await expect(addLinks(1)).rejects.toMatchObject({ code: '23514' });
    const refused = await send(h, [id], { subject: '51번째' });
    expect([refused.status, refused.body['error']]).toEqual([409, 'attachment_link_limit']);
    expect(h.sent).toHaveLength(1);

    // 보안 리뷰 N1 — 선검사(`linkCounts`, 잠금 없음)가 경합에 져 49 를 본 경우: 결속 INSERT 가 트리거(23514)에 막힌다. 선검사를 늦은 값으로
    // 바꿔 그 경합을 재현한다 → 같은 409 · 행은 `denied`(관문 전 · audit 0 · 결속 0) · 같은 멱등 키 재시도도 같은 409(500 이 아니다).
    const realStore = createPostgresOutboundAttachmentStore(testPool());
    const stale = createOutboundAttachmentService({
      enabled: true,
      store: { ...realStore, linkCounts: (ids) => Promise.resolve(new Map(ids.map((linked) => [linked, 49]))) },
      objects: createLocalOutboundAttachmentObjects({ directory: root }),
      scanner: createLocalMalwareScanner({ directory: root }),
      limitsFor: (agentId, now) => loadAttachmentLimits(testPool(), agentId, now),
    });
    const racingBody = { from: h.fixture.address, to: [RECIPIENT], subject: '경합', text: '본문', attachments: [id] };
    const raced = await handleSend({ ...h.deps, service: { ...h.deps.service, attachments: stale } }, request(h, racingBody));
    expect([raced.status, raced.body['error']], JSON.stringify(raced.body)).toEqual([409, 'attachment_link_limit']);
    const racedKey = request(h, racingBody).headers['idempotency-key'];
    const racedRow = await testPool().query<{ id: string; status: string; audits: number; links: number }>(
      `SELECT m.id::text AS id, m.status::text AS status,
              (SELECT count(*)::int FROM audit_logs a WHERE a.message_id = m.id) AS audits,
              (SELECT count(*)::int FROM message_attachments l WHERE l.message_id = m.id) AS links
         FROM messages m WHERE m.agent_id = $1 AND m.idempotency_key = $2`,
      [h.fixture.agentId, racedKey],
    );
    expect(racedRow.rows.map((row) => [row.status, row.audits, row.links])).toEqual([['denied', 0, 0]]);
    const retried = await handleSend(h.deps, request(h, racingBody));
    expect([retried.status, retried.body['error']]).toEqual([409, 'attachment_link_limit']);
    expect(h.sent).toHaveLength(1);
  });

  it('보안 리뷰 M1 — 파일명: 확장자 없으면 붙인다 · MIME 과 어긋나면 400 · DB CHECK(확장자·인코딩된 단어)', async () => {
    const h = await harness('beta');
    const bytes = new TextEncoder().encode('plain');
    const created = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'readme', mime_type: 'text/plain', bytes: bytes.length, sha256: sha(bytes) }, null));
    expect([created.status, created.body['filename']]).toEqual([201, 'readme.txt']);
    const mismatch = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'invoice.pdf', mime_type: 'text/plain', bytes: bytes.length, sha256: sha(bytes) }, null));
    expect([mismatch.status, mismatch.body['error']]).toEqual([400, 'attachment_filename_extension_mismatch']);
    const encoded = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: '=?UTF-8?B?ZXZpbC5leGU=?=.txt', mime_type: 'text/plain', bytes: bytes.length, sha256: sha(bytes) }, null));
    expect([encoded.status, encoded.body['error']]).toEqual([400, 'attachment_filename_invalid']);
    const owner = provisioningPool();
    for (const [filename, mimeType] of [
      ['a.exe', 'text/plain'],
      ['a.pdf', 'image/png'],
      ['a', 'application/pdf'],
      ['=?utf-8?q?x?=.txt', 'text/plain'],
    ] as const) {
      await expect(
        owner.query(
          `INSERT INTO outbound_attachments (id, agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
           VALUES ($2::uuid, $1::text, $3, $4, 1, repeat('a', 64), 'outbound/uploads/' || $1::text || '/' || $2::text, now() + interval '1 day')`,
          [h.fixture.agentId, randomUUID(), filename, mimeType],
        ),
        filename,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('스위치 꺼짐 → 업로드 404 · 발송 400 attachments_disabled · 예약은 400 attachments_not_supported', async () => {
    const h = await harness('beta', false);
    const created = await handleCreateAttachmentUpload(h.uploads, request(h, { filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) }, null));
    expect(created.status).toBe(404);
    const response = await send(h, ['55555555-5555-4555-8555-555555555555']);
    expect([response.status, response.body['error']]).toEqual([400, 'attachments_disabled']);
    const scheduled = await handleCreateScheduledMessage(
      { tokens: h.deps.tokens, schedules: createPostgresScheduledSendStore(testPool()), content: createScheduledContentStore(createLocalObjectStore({ directory: root })), now: () => new Date() } as never,
      request(h, { from: h.fixture.address, to: [RECIPIENT], subject: 's', text: 't', send_at: new Date(Date.now() + 3_600_000).toISOString(), attachments: ['55555555-5555-4555-8555-555555555555'] }),
    );
    expect([scheduled.status, scheduled.body['error']]).toEqual([400, 'attachments_not_supported']);
  });

  it('단계 공개 — 목록의 조직: 업로드 201 · 발송 200 · 목록 밖 조직: 업로드 404(인증 실패도 404) · 발송 400 attachments_disabled', async () => {
    const own = await harness('beta', 'own-org');
    const id = await upload(own, new TextEncoder().encode('allow\n'), 'allow.txt');
    const sent = await send(own, [id]);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(own.sent).toHaveLength(1);

    const other = await harness('beta', 'other-org');
    const body = { filename: 'x.txt', mime_type: 'text/plain', bytes: 1, sha256: 'a'.repeat(64) };
    const created = await handleCreateAttachmentUpload(other.uploads, request(other, body, null));
    expect([created.status, created.body['error']]).toEqual([404, 'route_not_found']);
    const badToken = { ...request(other, body, null), headers: { authorization: 'Bearer atk_agent_nope' } };
    expect((await handleCreateAttachmentUpload(other.uploads, badToken)).status).toBe(404);
    const response = await send(other, [id]);
    expect([response.status, response.body['error']]).toEqual([400, 'attachments_disabled']);
    expect(other.sent).toHaveLength(0);
    // 켜짐(true)에서는 인증 실패가 401 그대로다(허용목록 모드만 404 로 숨긴다).
    const on = await harness('beta', true);
    expect((await handleCreateAttachmentUpload(on.uploads, { ...request(on, body, null), headers: { authorization: 'Bearer atk_agent_nope' } })).status).toBe(401);

    // 이미 결속된 첨부(승인 대기 릴리스의 Stage 6 메타)는 스위치와 무관하다 — 조직이 목록에서 빠져도 읽힌다.
    const messageId = sent.body['message_id'] as string;
    expect((await other.deps.service.attachments?.metaForMessage(messageId))?.map((meta) => meta.filename)).toEqual(['allow.txt']);
  });

  it('DB — 업로드 행 불변 · 남의 첨부 결속 거부 · 파일명·MIME CHECK', async () => {
    const h = await harness('beta');
    const other = await harness('beta');
    const id = await upload(other, new TextEncoder().encode('z'), 'z.txt');
    const pool = provisioningPool();
    await expect(pool.query(`UPDATE outbound_attachments SET bytes = 2 WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    const message = await send(h, [await upload(h, new TextEncoder().encode('m'), 'm.txt')]);
    await expect(
      pool.query(`INSERT INTO message_attachments (message_id, position, attachment_id, permanent_key) VALUES ($1::uuid, 5, $2::uuid, 'outbound/attachments/' || $1::text || '/5')`, [
        message.body['message_id'],
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO outbound_attachments (agent_id, filename, mime_type, bytes, sha256, staging_key, expires_at)
         VALUES ($1, 'a.exe', 'application/x-msdownload', 1, repeat('a', 64), 'outbound/uploads/x', now() + interval '1 day')`,
        [h.fixture.agentId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
