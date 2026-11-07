/**
 * 투명성 로그 — **실제 Postgres**(마이그레이션 202609241600) · 실제 롤 셋(atmark_tlog · atmark_tlog_anchor · atmark_admin) · 가짜 KMS·S3·앵커.
 *
 *   ① 끝에서 끝: 콘솔 행위·정책 버전·발신 판정(+승인·결과 갱신)·수신 판정 → 트리거 outbox → 서열기 → 에폭(모든 조직) → 게시 → 콘솔 증명 API →
 *      번들 → **두 독립 검증기** 통과. 다른 조직 세션은 내 항목에 404.
 *   ② PII 센티넬(A-T3): 주소·제목·승인자·세션 센티넬이 잎·에폭·게시 객체 어디에도 평문으로 없다.
 *   ③ 권한: 제한 롤 두 개의 ACL = 허용 목록 · 앱/admin 은 로그를 못 쓴다 · tlog 롤은 제목·승인자·본문 칸을 못 읽는다.
 *   ④ append-only: 로그 테이블 UPDATE/DELETE/TRUNCATE 거부 · outbox 처리 표시 한 번 · 잎 연속·해시 대조 · 에폭 완전성 · 앵커 영수증 한 번.
 *   ⑤ A-T5 변조 탐지: 소유자 롤이 트리거를 끄고 (a) 감사 사유를 고치고 (b) 콘솔 행위를 지우고 (c) 잎 없는 행을 넣으면 검증기가 **세 가지를
 *      각각 다른 오류로** 보고한다. 역사를 다시 쓴(분기한) 체크포인트는 보관한 상태와의 일관성에서 실패한다.
 *   ⑥ A-T6: 잎 1바이트 · 증명 1노드 · 서명 1바이트 변조를 **두 검증기 모두** 거부한다.
 *   ⑦ Phase B 앵커(가짜 캘린더·Rekor): 예약 → 제출(Rekor 는 고정 샤드 키로 체크포인트 확인) → 업그레이드(bitcoin_claimed) · 실패 백오프 ·
 *      시간 예산 · 번들의 앵커 검증(고정 앵커 키 · 고정 Rekor 키).
 *   ⑨ 게시 수위(H4): 공개 버킷의 체크포인트보다 뒤이거나(되감긴 DB) 그것과 갈라진 역사에는 서명하지 않는다.
 *   ⑩ 키 행 목적(M1): 앵커 롤은 체크포인트 키 행을, 서열 롤은 앵커 키 행을 넣지 못한다 · 표시 키 = 최신 에폭을 서명한 키.
 *   ⑪ 닫힌 범위(M6) · 저장 상태 연결(H2): 번들은 to 헤드까지만 · `since` 링크로 범위 밖 저장 상태와 이어진다 · 링크 없는 범위 밖 번들은 실패.
 *   ⑫ 최종 적대적 검증 L4 · L3: 번들 GET(감사 행을 쓴다)은 CSRF 헤더 없이 403(교차·같은 사이트 모두, 감사 행 0) · 조직당 증명 계산은 한 번에
 *      하나(잠금을 잡은 동안 포함·일관성·번들 429, 다른 조직은 막히지 않는다) · 번들은 조직당 시간당 상한.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainOutboxFully } from '../../support/tlog-drain';
import { endPools, holdEpochTestLock, roleUrlOf } from '../../support/tlog-epoch-test-lock';

import type { AdminDependencies } from '../../../src/admin/context';
import { createPool } from '../../../src/db/client';
import { inspectRestrictedRole, TLOG_ANCHOR_ROLE, TLOG_ROLE } from '../../../src/runtime/role-bootstrap';
import { runAnchorTick } from '../../../src/tlog/anchor';
import { checkpointBody, keyIdOf, openCheckpoint, parseVkey, signedNote, vkeyOf } from '../../../src/tlog/checkpoint';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { closeEpoch } from '../../../src/tlog/epoch';
import { leafHash, verifyConsistency, verifyInclusion } from '../../../src/tlog/merkle';
import { BUNDLE_EXPORTS_PER_HOUR } from '../../../src/admin/routes/integrity';
import { integritySummary, tlogEntryRefFor } from '../../../src/tlog/proofs';
import { publishPendingEpochs } from '../../../src/tlog/publisher';
import { runCli } from '../../../scripts/log-verify';
import { verifyBundle, verifyInclusionProof, type SavedState } from '../../../scripts/tlog-verify/verifier';
import {
  FAKE_REKOR_HOST,
  FAKE_REKOR_VKEY,
  fakeOtsCalendar,
  fakeRekor,
  fakeRekorKey,
  memoryPublished,
  memoryWriter,
  rememberNote,
  testAnchorSigner,
  testNoteSigner,
} from '../../support/tlog-fixtures';
import { secondVerify } from '../../support/tlog-second-verifier';
import {
  adminDeps,
  adminRolePool,
  APP_URL,
  authed,
  AVAILABLE,
  call,
  login,
  loginMailerPool,
  newOrganization,
  ownerPool,
  suffix,
  type Session,
} from '../admin/support';

const SENTINEL = {
  recipient: 'sentinel-rcpt-7f3a@victim.example',
  subject: 'SENTINEL-SUBJECT-7f3a',
  approver: 'sentinel-approver-7f3a@owner.example',
  from: 'sentinel-from-7f3a@partner.example',
  body: 'SENTINEL-BODY-7f3a',
};

interface Fixture {
  readonly org: { id: string; ownerEmail: string };
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
  readonly policyVersionId: string;
}

// 전체 통합 스위트와 함께 돌면 서열기가 다른 테스트의 사건 수천 건을 함께 비운다 — 기본 5초를 넘길 수 있다.
describe.skipIf(!AVAILABLE)('투명성 로그(ADR-0008) — 실제 Postgres', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let tlog: Pool;
  let anchor: Pool;
  let deps: AdminDependencies;
  const signer = testNoteSigner();
  const writer = memoryWriter();
  const published = memoryPublished(writer);

  let releaseEpochLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    owner = ownerPool();
    releaseEpochLock = await holdEpochTestLock(owner);
    admin = adminRolePool();
    mailer = loginMailerPool();
    tlog = createPool(roleUrlOf(APP_URL, 'atmark_tlog'), { max: 2 });
    anchor = createPool(roleUrlOf(APP_URL, 'atmark_tlog_anchor'), { max: 2 });
    deps = adminDeps(admin);
  }, 300_000); // 이웃 파일이 에폭 잠금을 쥔 동안 기다린다(holdEpochTestLock).
  afterAll(async () => {
    await releaseEpochLock?.();
    await endPools(owner, admin, mailer, tlog, anchor);
  });

  /** 서열(다 비울 때까지) → 에폭(부를 때마다) → 게시. 에폭 번호를 돌려준다. `at` 은 마감 시각(기본 지금). */
  async function tick(at?: Date): Promise<number> {
    await drainOutboxFully(tlog);
    const closed = await closeEpoch({ db: tlog, signer, published, now: () => at ?? new Date(), cadence: 'always' });
    await publishPendingEpochs({ db: tlog, writer, maxEpochs: 500 });
    expect(closed.closed).toBe(true);
    return closed.epoch ?? -1;
  }

  async function fixture(): Promise<Fixture> {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'tlog', localPart: `tlog-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    const version = await owner.query<{ id: string }>('SELECT id FROM policy_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1', [agent.id]);
    return { org, session, agentId: agent.id, address: agent.address, policyVersionId: version.rows[0]?.id ?? '' };
  }

  /** 발신 시도 — 메시지·수신자(센티넬)·감사 행. */
  async function outbound(f: Fixture, decision: 'allowed' | 'denied' | 'pending_approval', reasons: string[] = []): Promise<{ auditId: string; messageId: string }> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'agent') RETURNING id`, [f.agentId]);
    const message = await owner.query<{ id: string }>(
      `INSERT INTO messages (agent_id, thread_id, direction, from_address_hash, from_domain, subject, snippet, status, message_id_header,
                             idempotency_key, request_hash, recipient_count)
       VALUES ($1, $2, 'outbound', $3, split_part($4, '@', 2), $5, $6, 'pending', $7, $8, $9, 1) RETURNING id`,
      [
        f.agentId,
        thread.rows[0]?.id,
        createHash('sha256').update(f.address).digest('hex'),
        f.address,
        SENTINEL.subject,
        SENTINEL.body,
        `<${randomUUID()}@atmark.test>`,
        `idem-${randomUUID()}`,
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );
    const messageId = message.rows[0]?.id ?? '';
    await owner.query('INSERT INTO outbound_recipients (message_id, address) VALUES ($1, $2)', [messageId, SENTINEL.recipient]);
    const audit = await owner.query<{ id: string }>(
      `INSERT INTO audit_logs (agent_id, message_id, decision, reasons, policy_version_id, policy_version)
       VALUES ($1, $2, $3::audit_decision, $4::text[], $5, 1) RETURNING id`,
      [f.agentId, messageId, decision, reasons, f.policyVersionId],
    );
    return { auditId: audit.rows[0]?.id ?? '', messageId };
  }

  async function inbound(f: Fixture): Promise<string> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [f.agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const row = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust, quarantine_reason, policy_reason, message_id_header)
       VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), false, $6, false, 'pass', 'pass', 'fail', 'pass', 'pass', false,
               'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(),
               'test-v0', 'none', true, 'unknown', 'policy_blocked', 'sender_not_allowlisted', $7)
       RETURNING id`,
      [f.agentId, f.address, ses, thread.rows[0]?.id, SENTINEL.from, SENTINEL.subject, `<${randomUUID()}@partner.example>`],
    );
    return row.rows[0]?.id ?? '';
  }

  async function bundleOf(session: Session, from: number, to: number, now?: Date, since?: number): Promise<Record<string, unknown>> {
    const d = now === undefined ? deps : adminDeps(admin, { now: () => now });
    const query = `from=${String(from)}&to=${String(to)}${since === undefined ? '' : `&since=${String(since)}`}`;
    const result = await call(d, 'GET', '/api/logs/bundle', authed(session, { query }));
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers['content-disposition']).toMatch(/^attachment; filename="atmark-log-bundle-/);
    return result.json() as Record<string, unknown>;
  }

  async function rejects(client: PoolClient, sql: string, params: unknown[] = []): Promise<string> {
    await client.query('SAVEPOINT probe');
    try {
      await client.query(sql, params);
    } catch (error) {
      return (error as Error).message;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT probe');
    }
    throw new Error(`거부돼야 했다: ${sql.slice(0, 80)}`);
  }

  it('① 끝에서 끝 — outbox → 잎 → 에폭 → 게시 → 증명 API → 번들을 두 검증기가 통과시킨다 · ② PII 센티넬 0', async () => {
    const f = await fixture();
    const denied = await outbound(f, 'denied', ['recipient_not_allowlisted']);
    const pending = await outbound(f, 'pending_approval');
    const allowed = await outbound(f, 'allowed');
    // 승인 대기 → 거절(+거절한 사람 센티넬) · 허용 → 전송 실패 결과(오류 문장에 주소 센티넬 — 모양 밖이라 평문이 아니라 커밋으로). update 사건 둘.
    await owner.query(`UPDATE audit_logs SET decision = 'denied', resolved_at = now(), resolution_reason = 'approval_rejected', approved_by = $2 WHERE id = $1`, [
      pending.auditId,
      SENTINEL.approver,
    ]);
    await owner.query(`UPDATE audit_logs SET resolved_at = now(), resolution_reason = $2 WHERE id = $1`, [
      allowed.auditId,
      `failed:MessageRejected for ${SENTINEL.recipient}`,
    ]);
    await inbound(f);
    const first = await tick();

    // outbox: 이 조직 사건 전부 처리 · 스냅샷 지움.
    const box = await owner.query<{ pending: string; snapshots: string }>(
      `SELECT count(*) FILTER (WHERE processed_at IS NULL)::text AS pending, count(*) FILTER (WHERE snapshot IS NOT NULL)::text AS snapshots
         FROM tlog_outbox WHERE organization_id = $1`,
      [f.org.id],
    );
    expect(box.rows[0]).toEqual({ pending: '0', snapshots: '0' });
    const leaves = await owner.query<{ kind: string; source_table: string | null; event: string | null; rev: number | null; leaf_json: string; id: string }>(
      `SELECT l.id::text AS id, l.kind, l.source_table, l.event, l.rev, l.leaf_json FROM tlog_leaves l JOIN tlog_logs g ON g.org_log_id = l.org_log_id
        WHERE g.organization_id = $1 ORDER BY l.seq`,
      [f.org.id],
    );
    const kinds = leaves.rows.map((row) => row.kind);
    expect(kinds[0]).toBe('org.genesis');
    expect(kinds).toEqual(expect.arrayContaining(['owner.action', 'policy.version', 'audit.evaluated', 'audit.updated', 'inbound.verdict']));
    expect(leaves.rows.filter((row) => row.source_table === 'audit_logs' && row.event === 'update').map((row) => row.rev)).toEqual([1, 1]);
    const pendingUpdate = JSON.parse(leaves.rows.find((row) => row.leaf_json.includes(pending.auditId) && row.kind === 'audit.updated')?.leaf_json ?? '{}') as {
      body: Record<string, unknown>;
      c: Record<string, string>;
    };
    expect(pendingUpdate.body).toMatchObject({ decision: 'denied', resolution_reason: 'approval_rejected' });
    expect(Object.keys(pendingUpdate.c)).toEqual(['approved_by']);
    const failedUpdate = JSON.parse(leaves.rows.find((row) => row.leaf_json.includes(allowed.auditId) && row.kind === 'audit.updated')?.leaf_json ?? '{}') as {
      body: Record<string, unknown>;
      c: Record<string, string>;
    };
    // 모양 밖 결과 문장 → 평문 null + 커밋.
    expect(failedUpdate.body['resolution_reason']).toBeNull();
    expect(Object.keys(failedUpdate.c)).toEqual(['body.resolution_reason']);
    const deniedLeaf = JSON.parse(leaves.rows.find((row) => row.leaf_json.includes(denied.auditId))?.leaf_json ?? '{}') as {
      body: { reasons: string[]; decision: string };
      c: Record<string, string>;
    };
    expect(deniedLeaf.body).toMatchObject({ decision: 'denied', reasons: ['recipient_not_allowlisted'] });
    expect(Object.keys(deniedLeaf.c).sort()).toEqual(['envelope', 'rfc822_id']);

    // ② 센티넬 — 잎 · 에폭 · 게시 객체 어디에도 평문이 없다.
    const everything = [
      ...leaves.rows.map((row) => row.leaf_json),
      ...(await owner.query<{ text: string }>(`SELECT global_leaf || checkpoint AS text FROM tlog_epochs WHERE epoch >= $1`, [first])).rows.map((row) => row.text),
      ...[...writer.objects.values()].map((object) => object.body.toString('latin1')),
    ].join('\n');
    for (const value of Object.values(SENTINEL)) expect(everything).not.toContain(value);
    expect(everything).not.toContain(f.org.ownerEmail);
    expect(everything).not.toContain(f.session.token);

    // 게시: C2SP 경로 · 체크포인트는 짧은 캐시 · 타일은 불변.
    expect(writer.objects.get('checkpoint')?.cacheControl).toBe('public, max-age=60');
    expect(writer.objects.get(`checkpoints/${String(first)}`)?.cacheControl).toContain('immutable');
    expect([...writer.objects.keys()].some((key) => /^tile\/0\/(x\d{3}\/)*\d{3}(\.p\/\d+)?$/.test(key))).toBe(true);
    expect([...writer.objects.keys()].some((key) => key.startsWith('tile/entries/'))).toBe(true);

    // 둘째 에폭.
    await owner.query(`INSERT INTO owner_actions (session_id, organization_id, action) SELECT id, organization_id, 'probe.tlog' FROM owner_sessions WHERE organization_id = $1 LIMIT 1`, [f.org.id]);
    const second = await tick();

    // 콘솔 증명 API.
    const summary = await call(deps, 'GET', '/api/logs/integrity', authed(f.session));
    expect(summary.statusCode, summary.body).toBe(200);
    const panel = summary.json() as { started: boolean; latest: { epoch: number; published: boolean }; vkey: string; log: string };
    expect(panel.started).toBe(true);
    expect(panel.latest.epoch).toBeGreaterThanOrEqual(second);
    const vkey = parseVkey(panel.vkey);
    expect(vkey.publicKey).toEqual(signer.raw);

    const entryId = leaves.rows.find((row) => row.kind === 'audit.evaluated')?.id ?? '';
    const inclusion = await call(deps, 'GET', '/api/logs/inclusion-proof', authed(f.session, { query: `entry=${entryId}&epoch=${String(second)}` }));
    expect(inclusion.statusCode, inclusion.body).toBe(200);
    const proof = inclusion.json() as {
      entry: { seq: number; leaf: string };
      org: { treeSize: number; root: string; proof: string[]; log: string };
      epochTree: { position: number; size: number; epochRoot: string; proof: string[] };
      global: { index: number; treeSize: number; globalLeaf: string; proof: string[] };
      checkpoint: string;
    };
    const unhex = (list: string[]): Buffer[] => list.map((hash) => Buffer.from(hash, 'hex'));
    expect(verifyInclusion(proof.entry.seq, proof.org.treeSize, leafHash(Buffer.from(proof.entry.leaf)), unhex(proof.org.proof), Buffer.from(proof.org.root, 'hex'))).toBe(true);
    // 에폭 트리 잎 = JCS({epoch, log, root, size}) — 형식 v2(에폭 번호가 잎에 있다).
    const headLeaf = leafHash(Buffer.from(JSON.stringify({ epoch: second, log: proof.org.log, root: proof.org.root, size: proof.org.treeSize })));
    expect(verifyInclusion(proof.epochTree.position, proof.epochTree.size, headLeaf, unhex(proof.epochTree.proof), Buffer.from(proof.epochTree.epochRoot, 'hex'))).toBe(true);
    const checkpoint = openCheckpoint(proof.checkpoint, vkey, TLOG_ORIGIN);
    expect(verifyInclusion(proof.global.index, checkpoint.size, leafHash(Buffer.from(proof.global.globalLeaf)), unhex(proof.global.proof), checkpoint.root)).toBe(true);

    const consistency = await call(deps, 'GET', '/api/logs/consistency-proof', authed(f.session, { query: `from=${String(first)}&to=${String(second)}` }));
    expect(consistency.statusCode, consistency.body).toBe(200);
    const link = consistency.json() as {
      org: { from: { treeSize: number; root: string }; to: { treeSize: number; root: string }; proof: string[] };
      global: { fromCheckpoint: string; toCheckpoint: string; proof: string[] };
    };
    expect(verifyConsistency(link.org.from.treeSize, link.org.to.treeSize, Buffer.from(link.org.from.root, 'hex'), Buffer.from(link.org.to.root, 'hex'), unhex(link.org.proof))).toBe(true);
    const a = openCheckpoint(link.global.fromCheckpoint, vkey, TLOG_ORIGIN);
    const b = openCheckpoint(link.global.toCheckpoint, vkey, TLOG_ORIGIN);
    expect(verifyConsistency(a.size, b.size, a.root, b.root, unhex(link.global.proof))).toBe(true);

    // 포함 증명 파일 = `pnpm log:verify` 입력(독립 검증기 — src/** import 0). 고정한 키로 통과 · 잎 1바이트 · 다른 키는 실패.
    const proofFile = inclusion.json() as Record<string, unknown> & { entry: { leaf: string } };
    expect(proofFile['format']).toBe('atmark-tlog-inclusion/v1');
    expect(verifyInclusionProof(proofFile, { pinnedVkey: panel.vkey })).toMatchObject({ ok: true, errors: [], state: null });
    const proofDir = mkdtempSync(join(tmpdir(), 'atmark-inclusion-'));
    const proofPath = join(proofDir, `atmark-inclusion-${entryId}.json`);
    writeFileSync(proofPath, inclusion.body);
    const cliOut: string[] = [];
    expect(runCli([proofPath, '--key', panel.vkey], (line) => cliOut.push(line)), cliOut.join('\n')).toBe(0);
    expect(cliOut[0]).toBe('✓ 포함 증명 검증 통과');
    const tamperedLeaf = { ...proofFile, entry: { ...proofFile.entry, leaf: proofFile.entry.leaf.replace('"seq":', '"seq": ') } };
    expect(verifyInclusionProof(tamperedLeaf, { pinnedVkey: panel.vkey }).errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['leaf_hash_mismatch', 'org_inclusion_invalid']),
    );
    writeFileSync(proofPath, JSON.stringify(tamperedLeaf));
    expect(runCli([proofPath, '--key', panel.vkey], () => undefined)).toBe(1);
    expect(verifyInclusionProof(proofFile, { pinnedVkey: vkeyOf(TLOG_ORIGIN, testNoteSigner(99).raw) }).ok).toBe(false);

    // T3 — 로그 상세가 잎 id 를 준다(체크포인트에 든 가장 최근 잎). 발신은 감사 행의 잎 — 결과가 갱신된 건은 update 잎(rev 1)이 최신이다.
    const leafIdOf = (auditId: string, kind: string): string => leaves.rows.find((row) => row.leaf_json.includes(auditId) && row.kind === kind)?.id ?? '?';
    const deniedDetail = await call(deps, 'GET', `/api/logs/outbound/${denied.messageId}`, authed(f.session));
    expect(deniedDetail.statusCode, deniedDetail.body).toBe(200);
    expect(deniedDetail.json()).toMatchObject({ tlogEntryId: leafIdOf(denied.auditId, 'audit.evaluated'), tlogPending: false });
    const approvedDetail = await call(deps, 'GET', `/api/logs/outbound/${pending.messageId}`, authed(f.session));
    expect(approvedDetail.json()).toMatchObject({ tlogEntryId: leafIdOf(pending.auditId, 'audit.updated'), tlogPending: false });
    const consoleRow = leaves.rows.find((row) => row.kind === 'owner.action');
    const consoleSourceId = (await owner.query<{ source_id: string }>('SELECT source_id FROM tlog_leaves WHERE id = $1::bigint', [consoleRow?.id])).rows[0]?.source_id ?? '';
    const consoleDetail = await call(deps, 'GET', `/api/logs/console/${consoleSourceId}`, authed(f.session));
    expect(consoleDetail.statusCode, consoleDetail.body).toBe(200);
    expect(consoleDetail.json()).toMatchObject({ tlogEntryId: consoleRow?.id, tlogPending: false });
    // 상세가 준 id 로 곧바로 증명을 받는다(단추가 부르는 그 길).
    const fromDetail = await call(deps, 'GET', '/api/logs/inclusion-proof', authed(f.session, { query: `entry=${String((consoleDetail.json() as { tlogEntryId: string }).tlogEntryId)}` }));
    expect(fromDetail.statusCode, fromDetail.body).toBe(200);
    expect(verifyInclusionProof(fromDetail.json(), { pinnedVkey: panel.vkey }).ok).toBe(true);

    // 체크포인트 전 — 잎은 있지만 아직 에폭에 들지 않았다: id 없음 · pending. 다음 에폭 뒤에 id 가 생긴다.
    const late = await owner.query<{ id: string }>(
      `INSERT INTO owner_actions (session_id, organization_id, action) SELECT id, organization_id, 'probe.tlog.late' FROM owner_sessions WHERE organization_id = $1 LIMIT 1 RETURNING id`,
      [f.org.id],
    );
    const lateId = late.rows[0]?.id ?? '';
    await drainOutboxFully(tlog);
    const lateDetail = await call(deps, 'GET', `/api/logs/console/${lateId}`, authed(f.session));
    expect(lateDetail.json()).toMatchObject({ tlogEntryId: null, tlogPending: true });

    // 다른 조직 세션 — 내 항목은 "없음"(증명 404 · 상세 404) · 잎 조회 SQL 자체가 조직으로 가른다(내 원천 id 를 줘도 다른 조직에는 잎이 없다).
    const other = await fixture();
    const foreign = await call(deps, 'GET', '/api/logs/inclusion-proof', authed(other.session, { query: `entry=${entryId}` }));
    expect(foreign.statusCode).toBe(404);
    expect((await call(deps, 'GET', `/api/logs/console/${consoleSourceId}`, authed(other.session))).statusCode).toBe(404);
    expect(await tlogEntryRefFor(admin, other.org.id, { table: 'owner_actions', ids: [consoleSourceId, lateId] })).toEqual({ entryId: null, pending: false });
    expect(await tlogEntryRefFor(admin, other.org.id, { table: 'audit_logs', ids: [denied.auditId, pending.auditId] })).toEqual({ entryId: null, pending: false });
    expect((await tlogEntryRefFor(admin, f.org.id, { table: 'owner_actions', ids: [consoleSourceId] })).entryId).toBe(consoleRow?.id);

    // 번들 → 두 검증기. 내려받기는 감사 1행.
    const bundle = await bundleOf(f.session, first, second);
    const report = verifyBundle(bundle, { pinnedVkey: panel.vkey });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(await secondVerify(bundle as never)).toEqual([]);
    const exported = await owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'logs.bundle_export'`, [f.org.id]);
    expect(exported.rowCount).toBe(1);
  });

  it('③ 권한 — 제한 롤 ACL = 허용 목록 · 앱/admin 쓰기 0 · tlog 롤은 제목·승인자·본문 칸을 못 읽는다', async () => {
    for (const role of [TLOG_ROLE, TLOG_ANCHOR_ROLE] as const) {
      const report = await inspectRestrictedRole(owner, role);
      expect(report.exists).toBe(true);
      expect(report.problems).toEqual([]);
    }
    const app = createPool(APP_URL, { max: 1 });
    try {
      await expect(app.query('SELECT 1 FROM tlog_outbox LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(app.query('SELECT 1 FROM tlog_leaves LIMIT 1')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    await expect(admin.query(`INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ('x-forged-key', 'checkpoint', '\\x00')`)).rejects.toThrow(/permission denied/);
    await expect(admin.query('UPDATE tlog_salt_keys SET salt_key = NULL')).rejects.toThrow(/permission denied/);
    await expect(tlog.query('SELECT subject FROM messages LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(tlog.query('SELECT approved_by FROM audit_logs LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(tlog.query('SELECT subject FROM inbound_messages LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(tlog.query('SELECT owner_email FROM organizations LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(anchor.query('SELECT leaf_json FROM tlog_leaves LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(anchor.query('SELECT salt_key FROM tlog_salt_keys LIMIT 1')).rejects.toThrow(/permission denied/);
  });

  it('④ append-only — 로그 테이블은 소유자 롤로도 고치거나 지울 수 없고, 에폭은 모든 조직을 담아야 한다', async () => {
    const f = await fixture();
    await tick();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const log = (await client.query<{ org_log_id: Buffer }>('SELECT org_log_id FROM tlog_logs WHERE organization_id = $1', [f.org.id])).rows[0]?.org_log_id;
      expect(await rejects(client, `UPDATE tlog_leaves SET leaf_json = leaf_json WHERE org_log_id = $1`, [log])).toBeTruthy();
      expect(await rejects(client, `DELETE FROM tlog_leaves WHERE org_log_id = $1`, [log])).toBeTruthy();
      expect(await rejects(client, `TRUNCATE tlog_leaves CASCADE`)).toBeTruthy();
      expect(await rejects(client, `DELETE FROM tlog_epochs WHERE epoch = (SELECT max(epoch) FROM tlog_epochs)`)).toBeTruthy();
      expect(await rejects(client, `UPDATE tlog_org_heads SET tree_size = tree_size + 1 WHERE org_log_id = $1`, [log])).toBeTruthy();
      expect(await rejects(client, `DELETE FROM tlog_outbox WHERE organization_id = $1`, [f.org.id])).toBeTruthy();
      expect(await rejects(client, `UPDATE tlog_outbox SET processed_at = now() WHERE organization_id = $1`, [f.org.id])).toMatch(/처리 표시/);
      // 잎 해시 대조 · 연속 seq.
      const next = (await client.query<{ n: string }>('SELECT (max(seq) + 1)::text AS n FROM tlog_leaves WHERE org_log_id = $1', [log])).rows[0]?.n;
      const forged = `{"at":"2026-09-24T00:00:00.000000Z","body":{},"c":{},"kind":"source.missing","log":"${log?.toString('hex') ?? ''}","seq":${next ?? '0'},"src":{"e":"insert","id":"00000000-0000-0000-0000-000000000000","r":0,"t":"owner_actions"},"v":1}`;
      expect(
        await rejects(client, `INSERT INTO tlog_leaves (org_log_id, seq, kind, source_table, source_id, event, rev, outbox_id, leaf_json, leaf_hash)
                               VALUES ($1, $2, 'source.missing', 'owner_actions', '00000000-0000-0000-0000-000000000000', 'insert', 0, NULL, $3, $4)`, [log, next, forged, Buffer.alloc(32)]),
      ).toMatch(/tlog_leaves_(hash|source_shape)/);
      // 봉투·사건이 맞아도 해시가 틀리면 거부(DB 가 SHA-256(0x00 ‖ leaf_json) 을 다시 계산) · seq 를 건너뛰면 거부(연속).
      const box = (
        await client.query<{ id: string }>(
          `INSERT INTO tlog_outbox (source_table, source_id, event, rev, organization_id) VALUES ('owner_actions', $1, 'insert', 0, $2) RETURNING id`,
          [randomUUID(), f.org.id],
        )
      ).rows[0]?.id;
      const probeSource = (await client.query<{ source_id: string }>('SELECT source_id FROM tlog_outbox WHERE id = $1', [box])).rows[0]?.source_id ?? '';
      const probeLeaf = (seq: string): string =>
        `{"at":"2026-09-24T00:00:00.000000Z","body":{},"c":{},"kind":"source.missing","log":"${log?.toString('hex') ?? ''}","seq":${seq},"src":{"e":"insert","id":"${probeSource}","r":0,"t":"owner_actions"},"v":1}`;
      const insertLeaf = `INSERT INTO tlog_leaves (org_log_id, seq, kind, source_table, source_id, event, rev, outbox_id, leaf_json, leaf_hash)
                          VALUES ($1, $2, 'source.missing', 'owner_actions', $3, 'insert', 0, $4, $5, $6)`;
      const good = probeLeaf(next ?? '0');
      expect(await rejects(client, insertLeaf, [log, next, probeSource, box, good, Buffer.alloc(32)])).toMatch(/tlog_leaves_hash/);
      const skipped = probeLeaf(String(Number(next) + 1));
      expect(await rejects(client, insertLeaf, [log, Number(next) + 1, probeSource, box, skipped, createHash('sha256').update(Buffer.from([0])).update(skipped).digest()])).toMatch(/연속/);
      // 솔트 키: 다른 키로 바꿀 수 없다(폐기만).
      expect(await rejects(client, `UPDATE tlog_salt_keys SET salt_key = $2 WHERE org_log_id = $1`, [log, Buffer.alloc(32, 1)])).toMatch(/폐기/);
      // 에폭 완전성 — 헤드 없이 에폭을 넣으면 커밋 때 거부(지연 제약).
      await client.query('SAVEPOINT epoch_probe');
      const last = (await client.query<{ epoch: string; checkpoint: string; key_id: string; global_root: Buffer }>('SELECT epoch, checkpoint, key_id, global_root FROM tlog_epochs ORDER BY epoch DESC LIMIT 1')).rows[0];
      expect(last).toBeDefined();
      await client.query('SET CONSTRAINTS tlog_epochs_complete IMMEDIATE');
      const epoch = Number(last?.epoch) + 1;
      const leaf = `{"closed_at":"2099-01-01T00:00:00.000000Z","epoch":${String(epoch)},"epoch_root":"${'00'.repeat(32)}","kind":"epoch","v":1}`;
      const checkpoint = `${TLOG_ORIGIN}\n${String(epoch + 1)}\n${Buffer.alloc(32).toString('base64')}\n\n— x AAAA\n`;
      const message = await client
        .query(
          `INSERT INTO tlog_epochs (epoch, closed_at, epoch_root, org_count, global_leaf, global_leaf_hash, global_root, checkpoint, key_id)
           VALUES ($1, '2099-01-01T00:00:00Z', $2, 0, $3, sha256('\\x00'::bytea || convert_to($3, 'UTF8')), $4, $5, $6)`,
          [epoch, Buffer.alloc(32), leaf, Buffer.alloc(32), checkpoint, last?.key_id],
        )
        .then(() => 'accepted', (error: Error) => error.message);
      expect(message).toMatch(/모든 조직 로그/);
      await client.query('ROLLBACK TO SAVEPOINT epoch_probe');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('⑤ A-T5 — 트리거를 끈 변조 세 가지를 각각 다른 오류로 · 분기한 체크포인트는 보관 상태와 어긋난다', async () => {
    const f = await fixture();
    const start = await tick();
    const x = await outbound(f, 'denied', ['recipient_not_allowlisted']);
    await owner.query(`INSERT INTO owner_actions (session_id, organization_id, action) SELECT id, organization_id, 'probe.tamper' FROM owner_sessions WHERE organization_id = $1 LIMIT 1`, [f.org.id]);
    const y = (await owner.query<{ id: string }>(`SELECT id FROM owner_actions WHERE organization_id = $1 AND action = 'probe.tamper'`, [f.org.id])).rows[0]?.id ?? '';
    const end = await tick();

    const clean = await bundleOf(f.session, start, end);
    const vkey = clean['vkey'] as string;
    const first = verifyBundle(clean, { pinnedVkey: vkey });
    expect(first.errors).toEqual([]);
    const saved = first.state as SavedState;

    // 소유자 롤로 트리거를 끄고 변조(한 트랜잭션 — 다른 세션에는 트리거가 꺼진 순간이 보이지 않는다).
    const client = await owner.connect();
    // 원천 창 = [start 마감 + 1분, 끝 마감 − 1분]. 로컬 DB 의 마감 시각은 앞선 실행 때문에 벽시계보다 앞설 수 있다 — DB 의 start 마감을 기준으로 잡는다.
    const startClosed = (await owner.query<{ closed_at: Date }>('SELECT closed_at FROM tlog_epochs WHERE epoch = $1', [start])).rows[0]?.closed_at ?? new Date();
    const base = Math.max(Date.now(), startClosed.getTime());
    const planted = new Date(startClosed.getTime() + 90 * 1000);
    let plantedId = '';
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_partial_immutability');
      await client.query(`UPDATE audit_logs SET reasons = ARRAY['forged_reason'] WHERE id = $1`, [x.auditId]);
      await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_partial_immutability');
      await client.query('ALTER TABLE owner_actions DISABLE TRIGGER owner_actions_no_delete');
      await client.query('DELETE FROM owner_actions WHERE id = $1', [y]);
      await client.query('ALTER TABLE owner_actions ENABLE TRIGGER owner_actions_no_delete');
      await client.query('ALTER TABLE owner_actions DISABLE TRIGGER owner_actions_tlog_enqueue');
      plantedId =
        (
          await client.query<{ id: string }>(
            `INSERT INTO owner_actions (session_id, organization_id, action, created_at)
             SELECT id, organization_id, 'probe.unlogged', $2 FROM owner_sessions WHERE organization_id = $1 LIMIT 1 RETURNING id`,
            [f.org.id, planted],
          )
        ).rows[0]?.id ?? '';
      await client.query('ALTER TABLE owner_actions ENABLE TRIGGER owner_actions_tlog_enqueue');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // 서열기는 계속 돈다(정상 사건 — 첫 번들 내려받기 감사 행 — 은 잎을 얻는다). 트리거를 끄고 넣은 행은 outbox 가 없어 잎이 없다.
    // 심은 행(start 마감 + 90초)이 창 안에 들도록 다음 에폭을 3분 뒤 시각으로 닫는다(끝 마감 − 1분 > 심은 시각).
    const after = await tick(new Date(base + 3 * 60 * 1000));
    const tampered = await bundleOf(f.session, start, after);
    const report = verifyBundle(tampered, { pinnedVkey: vkey, previous: saved });
    const codes = report.errors.map((issue) => issue.code);
    expect(report.ok).toBe(false);
    expect(codes).toContain('row_leaf_mismatch');
    expect(codes).toContain('leaf_without_row');
    expect(codes).toContain('row_without_leaf');
    expect(report.errors.find((issue) => issue.code === 'row_leaf_mismatch')?.detail).toContain(x.auditId);
    expect(report.errors.find((issue) => issue.code === 'leaf_without_row')?.detail).toContain(y);
    expect(report.errors.filter((issue) => issue.code === 'row_without_leaf').map((issue) => issue.detail).join(' ')).toContain(plantedId);
    // 암호학 골격(서명·증명)은 멀쩡하다 — 두 번째 검증기는 통과시킨다. 원천 대조가 잡는 것이다.
    expect(await secondVerify(tampered as never)).toEqual([]);

    // 역사를 다시 쓴 체크포인트(같은 키로 서명한 분기) — 보관한 상태와 어긋난다.
    const forkedRoot = Buffer.alloc(32, 9);
    const size = start + 1;
    const text = `${TLOG_ORIGIN}\n${String(size)}\n${forkedRoot.toString('base64')}\n`;
    const signature = await signer.sign(Buffer.from(text));
    const keyId = createHash('sha256').update(TLOG_ORIGIN).update(Buffer.from([0x0a, 0x01])).update(signer.raw).digest().subarray(0, 4);
    const forkedNote = `${text}\n— ${TLOG_ORIGIN} ${Buffer.concat([keyId, signature]).toString('base64')}\n`;
    const forked = structuredClone(clean) as { checkpoints: { epoch: number; note: string }[] };
    const target = forked.checkpoints.find((entry) => entry.epoch === start);
    if (target !== undefined) target.note = forkedNote;
    const forkReport = verifyBundle(forked, {
      pinnedVkey: vkey,
      previous: { ...saved, org: null, checkpoint: { epoch: start, size: start + 1, root: 'aa'.repeat(32) } },
    });
    expect(forkReport.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['state_checkpoint_inconsistent', 'global_inclusion_invalid']));
    // 두 번째 검증기도 분기한 체크포인트의 증명 불일치를 잡는다.
    expect((await secondVerify(forked as never)).some((code) => code.startsWith('global_inclusion') || code.startsWith('global_consistency'))).toBe(true);
  });

  it('⑥ A-T6 — 잎 1바이트 · 증명 1노드 · 서명 1바이트 변조를 두 검증기 모두 거부한다', async () => {
    const f = await fixture();
    const a = await tick();
    await outbound(f, 'allowed');
    const b = await tick();
    const bundle = await bundleOf(f.session, a, b);
    const vkey = bundle['vkey'] as string;
    expect(verifyBundle(bundle, { pinnedVkey: vkey }).ok).toBe(true);
    expect(await secondVerify(bundle as never)).toEqual([]);

    const leafTampered = structuredClone(bundle) as { leaves: { leaf: string }[] };
    const victim = leafTampered.leaves.at(-1);
    if (victim !== undefined) victim.leaf = victim.leaf.replace('"v":1', '"v":2');
    const proofTampered = structuredClone(bundle) as { heads: { epoch_proof: string[] }[]; checkpoints: { inclusion: string[] }[] };
    const withProof = proofTampered.checkpoints.find((entry) => entry.inclusion.length > 0);
    if (withProof !== undefined) withProof.inclusion[0] = `${withProof.inclusion[0]?.slice(0, 62) ?? ''}${withProof.inclusion[0]?.endsWith('00') === true ? 'ff' : '00'}`;
    const signatureTampered = structuredClone(bundle) as { checkpoints: { note: string }[] };
    const note = signatureTampered.checkpoints.at(-1);
    if (note !== undefined) {
      const lines = note.note.split('\n');
      const sigLine = lines.at(-2) ?? '';
      const [dash, name, blob] = sigLine.split(' ') as [string, string, string];
      const bytes = Buffer.from(blob, 'base64');
      bytes[10] = (bytes[10] as number) ^ 1;
      lines[lines.length - 2] = `${dash} ${name} ${bytes.toString('base64')}`;
      note.note = lines.join('\n');
    }
    for (const tampered of [leafTampered, proofTampered, signatureTampered]) {
      expect(verifyBundle(tampered, { pinnedVkey: vkey }).ok).toBe(false);
      expect((await secondVerify(tampered as never)).length).toBeGreaterThan(0);
    }
    // 고정하지 않은 다른 키로 서명된 번들 — 고정 키와 다르면 거부.
    const other = testNoteSigner(8);
    const otherVkey = `${TLOG_ORIGIN}+${createHash('sha256').update(TLOG_ORIGIN).update(Buffer.from([0x0a, 0x01])).update(other.raw).digest().subarray(0, 4).toString('hex')}+${Buffer.concat([Buffer.from([1]), other.raw]).toString('base64')}`;
    expect(verifyBundle(bundle, { pinnedVkey: otherVkey }).errors.map((issue) => issue.code)).toContain('vkey_mismatch');
  });

  it('⑦ Phase B 앵커 — 예약 → 제출(OTS 대기 · Rekor 포함 증명) → 업그레이드(Bitcoin) → 번들 검증 · 실패는 백오프', async () => {
    const f = await fixture();
    const epoch = await tick();
    const note = (await owner.query<{ checkpoint: string }>('SELECT checkpoint FROM tlog_epochs WHERE epoch = (SELECT max(epoch) FROM tlog_epochs WHERE published_at IS NOT NULL)')).rows[0]?.checkpoint ?? '';
    rememberNote(note);
    // 지난 실행의 대기 앵커도 이 가짜 서명기로 처리될 수 있게 모든 체크포인트를 기억시킨다.
    for (const row of (await owner.query<{ checkpoint: string }>('SELECT checkpoint FROM tlog_epochs')).rows) rememberNote(row.checkpoint);
    const anchorSigner = testAnchorSigner();
    const ots = fakeOtsCalendar({ upgraded: true });
    const rekor = fakeRekor();
    const anchorWriter = memoryWriter();
    const later = new Date(Date.now() + 30 * 60 * 60 * 1000);
    const anchorDeps = {
      db: anchor,
      ots,
      rekor,
      signer: anchorSigner,
      writer: anchorWriter,
      calendars: ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'],
      rekorUrl: `https://${FAKE_REKOR_HOST}`,
      rekorKey: fakeRekorKey(),
      now: () => later,
    };
    const firstTick = await runAnchorTick(anchorDeps);
    expect(firstTick.scheduled).toBe(3);
    const rows = await owner.query<{ epoch: string; target: string; state: string }>(
      `SELECT epoch::text AS epoch, target, state FROM tlog_anchors WHERE epoch = (SELECT max(epoch) FROM tlog_epochs WHERE published_at IS NOT NULL) ORDER BY target, endpoint`,
    );
    expect(rows.rows.map((row) => `${row.target}:${row.state}`)).toEqual(['opentimestamps:submitted', 'opentimestamps:submitted', 'rekor:confirmed']);
    expect(Number(rows.rows[0]?.epoch)).toBeGreaterThanOrEqual(epoch);
    // 밖으로 나간 것은 다이제스트·서명·공개키뿐.
    expect(JSON.stringify(rekor.requests)).not.toContain(SENTINEL.recipient);

    const upgradeTick = await runAnchorTick({ ...anchorDeps, now: () => new Date(later.getTime() + 2 * 60 * 60 * 1000) });
    // 캘린더가 Bitcoin 증명을 붙였다 = 주장(bitcoin_claimed). 블록 헤더 대조 전이라 confirmed 가 아니다.
    expect(upgradeTick.bitcoinClaimed).toBeGreaterThanOrEqual(2);
    expect(upgradeTick.confirmed).toBe(0);
    const claimed = await owner.query<{ target: string; state: string }>(
      `SELECT target, state FROM tlog_anchors WHERE epoch = (SELECT max(epoch) FROM tlog_epochs WHERE published_at IS NOT NULL) ORDER BY target, endpoint`,
    );
    expect(claimed.rows.map((row) => `${row.target}:${row.state}`)).toEqual(['opentimestamps:bitcoin_claimed', 'opentimestamps:bitcoin_claimed', 'rekor:confirmed']);
    expect(ots.calls.some((entry) => entry.startsWith('upgrade https://alice.btc.calendar.opentimestamps.org'))).toBe(true);
    const anchoredEpoch = Number(rows.rows[0]?.epoch);
    expect([...anchorWriter.objects.keys()]).toEqual(
      expect.arrayContaining([`anchors/ots/${String(anchoredEpoch)}/a.pool.opentimestamps.org.ots`, `anchors/rekor/${String(anchoredEpoch)}.json`]),
    );

    // 영수증은 한 번만 — 앵커 롤로도 바꿀 수 없다.
    await expect(anchor.query(`UPDATE tlog_anchors SET receipt = '\\x00' WHERE epoch = $1 AND target = 'rekor'`, [anchoredEpoch])).rejects.toThrow(/한 번만|허용되지/);
    await expect(anchor.query(`UPDATE tlog_anchors SET state = 'pending' WHERE epoch = $1 AND target = 'rekor'`, [anchoredEpoch])).rejects.toThrow(/허용되지|state_shape/);
    await expect(anchor.query(`INSERT INTO tlog_anchors (epoch, target, endpoint, digest) VALUES ($1, 'rekor', 'https://log2099-1.rekor.sigstore.dev', $2)`, [anchoredEpoch, Buffer.alloc(32)])).rejects.toThrow(/digest/);

    // 번들의 앵커를 검증기가 본다.
    const bundle = await bundleOf(f.session, epoch, anchoredEpoch);
    const anchorKey = (await anchorSigner.publicKeySpki()).toString('base64');
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string, anchorKeys: [anchorKey], rekorVkeys: [FAKE_REKOR_VKEY] });
    expect(report.errors).toEqual([]);
    expect(report.anchors.some((line) => line.includes('Bitcoin 블록 915000') && line.includes('bitcoin_claimed'))).toBe(true);
    expect(report.anchors.some((line) => line.startsWith('Rekor') && line.includes('고정한 샤드 키'))).toBe(true);
    // 앵커 키를 번들이 아니라 고정 채널에서 받는다 — 다른 키를 고정하면 Rekor 항목의 앵커 서명이 맞지 않는다.
    const otherAnchor = (await testAnchorSigner().publicKeySpki()).toString('base64');
    expect(verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string, anchorKeys: [otherAnchor] }).errors.map((issue) => issue.code)).toContain('rekor_invalid');
    // Rekor 샤드 키를 고정하지 않으면 "확인하지 못했다" 고 보고한다(통과로 적지 않는다).
    const unpinned = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string, anchorKeys: [anchorKey] });
    expect(unpinned.anchors.some((line) => line.includes('확인하지 못했다'))).toBe(true);

    // 실패 경로 — 캘린더 장애는 백오프, Rekor 증명이 틀리면 확정하지 않는다.
    await tick();
    for (const row of (await owner.query<{ checkpoint: string }>('SELECT checkpoint FROM tlog_epochs')).rows) rememberNote(row.checkpoint);
    const failing = await runAnchorTick({
      ...anchorDeps,
      ots: fakeOtsCalendar({ failSubmit: true }),
      rekor: fakeRekor({ corruptProof: true }),
      now: () => new Date(later.getTime() + 60 * 60 * 60 * 1000),
    });
    expect(failing.scheduled).toBe(3);
    expect(failing.retried).toBeGreaterThanOrEqual(3);
    const retried = await owner.query<{ state: string; last_error: string | null; attempt_count: number }>(
      `SELECT state, last_error, attempt_count FROM tlog_anchors WHERE epoch = (SELECT max(epoch) FROM tlog_anchors) ORDER BY target, endpoint`,
    );
    expect(retried.rows.map((row) => row.state)).toEqual(['pending', 'pending', 'pending']);
    expect(retried.rows.map((row) => row.last_error)).toEqual(['ots_http_503', 'ots_http_503', 'rekor_inclusion_proof_invalid']);

    // 시간 예산(L8) — 남은 실행 시간이 행 하나의 최악보다 적으면 아무 행도 건드리지 않고 다음 틱에 넘긴다.
    const before = await owner.query<{ attempts: string }>(`SELECT sum(attempt_count)::text AS attempts FROM tlog_anchors`);
    const starved = await runAnchorTick({ ...anchorDeps, now: () => new Date(later.getTime() + 200 * 60 * 60 * 1000), remainingMs: () => 1000 });
    expect(starved.deferred).toBeGreaterThan(0);
    expect(starved.submitted + starved.confirmed + starved.bitcoinClaimed + starved.retried + starved.failed).toBe(0);
    const after = await owner.query<{ attempts: string }>(`SELECT sum(attempt_count)::text AS attempts FROM tlog_anchors`);
    expect(after.rows[0]?.attempts).toBe(before.rows[0]?.attempts);
  });
  it('⑧ 잎 모양으로 옮길 수 없는 원천 행 하나가 로그를 멈추지 않는다 — source.missing(unrepresentable) 로 커밋되고 검증기가 보고한다', async () => {
    const f = await fixture();
    const start = await tick();
    const audit = await owner.query<{ id: string }>(
      `INSERT INTO audit_logs (agent_id, decision, reasons, evaluated_at) VALUES ($1, 'denied', ARRAY['evaluation_error'], 'infinity') RETURNING id`,
      [f.agentId],
    );
    const auditId = audit.rows[0]?.id ?? '';
    const end = await tick();
    const leaf = await owner.query<{ leaf_json: string }>(
      `SELECT l.leaf_json FROM tlog_leaves l WHERE l.source_table = 'audit_logs' AND l.source_id = $1`,
      [auditId],
    );
    expect(JSON.parse(leaf.rows[0]?.leaf_json ?? '{}')).toMatchObject({ kind: 'source.missing', body: { reason: 'unrepresentable' } });
    const pending = await owner.query('SELECT 1 FROM tlog_outbox WHERE source_id = $1 AND processed_at IS NULL', [auditId]);
    expect(pending.rowCount).toBe(0);
    const bundle = await bundleOf(f.session, start, end);
    const report = verifyBundle(bundle, { pinnedVkey: bundle['vkey'] as string });
    expect(report.errors.find((issue) => issue.code === 'leaf_source_missing')?.detail).toContain(auditId);
  });

  it('⑨ 게시 수위(H4) — 공개 버킷의 체크포인트보다 뒤인(되감긴) DB · 그것과 갈라진 역사 · 다른 키로 서명된 게시본에는 서명하지 않는다', async () => {
    await fixture();
    const e = await tick();
    const signedBy = async (text: string, by = signer): Promise<string> =>
      signedNote(text, TLOG_ORIGIN, keyIdOf(TLOG_ORIGIN, by.raw), await by.sign(Buffer.from(text, 'utf8')));
    const attempt = (note: string): Promise<unknown> =>
      closeEpoch({ db: tlog, signer, published: { readCheckpoint: () => Promise.resolve(note) }, now: () => new Date(), cadence: 'always' });
    // (a) 세상에 나간 크기가 DB 보다 크다 — PITR 로 되감긴 DB. DB 로는 그 크기를 증명할 수 없다.
    await expect(attempt(await signedBy(checkpointBody({ origin: TLOG_ORIGIN, size: e + 6, root: Buffer.alloc(32, 5) })))).rejects.toThrow('published_rollback');
    // (b) 같은 크기인데 루트가 다르다 — DB 가 게시본과 갈라졌다(다른 DB · 고친 역사).
    await expect(attempt(await signedBy(checkpointBody({ origin: TLOG_ORIGIN, size: e + 1, root: Buffer.alloc(32, 6) })))).rejects.toThrow('published_inconsistent');
    // (c) 우리 키가 아닌 서명 — 게시 수위를 확인할 수 없으면 서명하지 않는다.
    await expect(attempt(await signedBy(checkpointBody({ origin: TLOG_ORIGIN, size: e + 1, root: Buffer.alloc(32, 6) }), testNoteSigner(8)))).rejects.toThrow(
      'published_checkpoint_unverifiable',
    );
    const latest = await owner.query<{ epoch: string }>('SELECT max(epoch)::text AS epoch FROM tlog_epochs');
    expect(Number(latest.rows[0]?.epoch)).toBe(e);
    // (d) 정직한 게시본(메모리 버킷의 최신 checkpoint) — 이어지므로 다음 에폭을 닫는다.
    expect(await tick()).toBe(e + 1);
  });

  it('⑩ 키 행 목적(M1) — 앵커 롤은 체크포인트 키를, 서열 롤은 앵커 키를 넣지 못한다 · 키 행 모양은 DB 가 다시 계산 · 표시 키 = 최신 에폭의 서명 키', async () => {
    const f = await fixture();
    await tick();
    const rogue = testNoteSigner(9);
    const rogueVkey = `${TLOG_ORIGIN}+${keyIdOf(TLOG_ORIGIN, rogue.raw).toString('hex')}+${Buffer.concat([Buffer.from([1]), rogue.raw]).toString('base64')}`;
    const anchorSpki = await testAnchorSigner().publicKeySpki();
    const anchorKeyId = `ecdsa-p256:${createHash('sha256').update(anchorSpki).digest('hex')}`;
    for (const [pool, keyId, purpose, key] of [
      [anchor, rogueVkey, 'checkpoint', rogue.raw],
      [tlog, anchorKeyId, 'anchor', anchorSpki],
    ] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query('INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ($1, $2, $3)', [keyId, purpose, key])).rejects.toThrow(/목적/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    // 모양: 키 id 가 공개키와 맞지 않는 vkey · 다른 SPKI 해시의 앵커 키 id — 소유자 롤로도 넣을 수 없다.
    const ownerClient = await owner.connect();
    try {
      await ownerClient.query('BEGIN');
      const badVkey = `${TLOG_ORIGIN}+00000000+${Buffer.concat([Buffer.from([1]), rogue.raw]).toString('base64')}`;
      expect(await rejects(ownerClient, `INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ($1, 'checkpoint', $2)`, [badVkey, rogue.raw])).toMatch(/tlog_keys_shape/);
      expect(await rejects(ownerClient, `INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ($1, 'anchor', $2)`, [`ecdsa-p256:${'0'.repeat(64)}`, anchorSpki])).toMatch(
        /tlog_keys_shape/,
      );
    } finally {
      await ownerClient.query('ROLLBACK');
      ownerClient.release();
    }
    const summary = (await call(deps, 'GET', '/api/logs/integrity', authed(f.session))).json() as { vkey: string };
    const signedWith = await owner.query<{ key_id: string }>('SELECT key_id FROM tlog_epochs ORDER BY epoch DESC LIMIT 1');
    expect(summary.vkey).toBe(signedWith.rows[0]?.key_id);
    // 모양이 맞는 다른 체크포인트 키 행이 **더 늦게** 들어와도(소유자 롤 — 되돌린다) 표시·번들 키는 서명한 키다.
    const probe = await owner.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(`INSERT INTO tlog_keys (key_id, purpose, public_key, created_at) VALUES ($1, 'checkpoint', $2, now() + interval '1 day')`, [rogueVkey, rogue.raw]);
      const polluted = await integritySummary(probe, f.org.id);
      expect(polluted.vkey).toBe(signedWith.rows[0]?.key_id);
      expect(polluted.vkey).not.toBe(rogueVkey);
    } finally {
      await probe.query('ROLLBACK');
      probe.release();
    }
  });

  it('⑪ 닫힌 범위(M6) · 저장 상태 연결(H2) — 번들은 to 헤드까지 · since 링크로 범위 밖 저장 상태와 이어진다 · 링크 없으면 실패하고 상태를 갱신하지 않는다', async () => {
    const f = await fixture();
    const probe = (action: string): Promise<unknown> =>
      owner.query(`INSERT INTO owner_actions (session_id, organization_id, action) SELECT id, organization_id, $2 FROM owner_sessions WHERE organization_id = $1 LIMIT 1`, [
        f.org.id,
        action,
      ]);
    const a = await tick();
    await probe('probe.range.b');
    const b = await tick();
    await probe('probe.range.c');
    const c = await tick();
    // 꼬리: c 뒤에 잎이 생겨도(서열만, 에폭 전) 번들 [a, b] 에는 b 헤드까지만 실린다.
    await probe('probe.range.tail');
    await drainOutboxFully(tlog);

    const first = await bundleOf(f.session, a, b);
    const heads = first['heads'] as { epoch: number; size: number }[];
    const start = first['start'] as { size: number };
    expect((first['leaves'] as unknown[]).length).toBe((heads.at(-1)?.size ?? 0) - start.size);
    expect(first['continuation']).toBeNull();
    const vkey = first['vkey'] as string;
    const saved = verifyBundle(first, { pinnedVkey: vkey });
    expect(saved.errors).toEqual([]);
    const state = saved.state as SavedState;
    expect(state.checkpoint.epoch).toBe(b);

    // 저장한 에폭(b) 뒤만 담은 번들 — 링크가 없으면 이어짐을 확인할 수 없다: 실패 · 상태 갱신 없음.
    const unlinked = verifyBundle(await bundleOf(f.session, c, c), { pinnedVkey: vkey, previous: state });
    expect(unlinked.errors.map((issue) => issue.code)).toContain('state_unlinked');
    expect(unlinked.state).toBeNull();
    // since=b — 전역·조직 일관성 링크(b → c)로 이어진다. 상태는 c 로 앞선다.
    const forward = await bundleOf(f.session, c, c, undefined, b);
    expect((forward['link'] as { direction: string }).direction).toBe('forward');
    const linked = verifyBundle(forward, { pinnedVkey: vkey, previous: state });
    expect(linked.errors).toEqual([]);
    expect(linked.state?.checkpoint.epoch).toBe(c);
    expect(await secondVerify(forward as never)).toEqual([]);
    // 링크를 바꿔치면(다른 조직 크기) 실패.
    const tamperedLink = structuredClone(forward) as { link: { org: { from_size: number } } };
    tamperedLink.link.org.from_size += 1;
    expect(verifyBundle(tamperedLink, { pinnedVkey: vkey, previous: state }).ok).toBe(false);
    // 뒤로: 저장한 상태가 c 인데 [a, b] 를 since=c 로 — 이어지고, 상태는 c 에 머문다(되감지 않는다).
    const backward = verifyBundle(await bundleOf(f.session, a, b, undefined, c), { pinnedVkey: vkey, previous: linked.state });
    expect(backward.errors).toEqual([]);
    expect(backward.state?.checkpoint.epoch).toBe(c);
  });

  it('⑫ L4 · L3 — 번들 GET 은 CSRF 헤더를 요구한다 · 조직당 증명 계산은 한 번에 하나(429) · 번들은 시간당 상한', async () => {
    const f = await fixture();
    const other = await fixture();
    const epoch = await tick();
    const exports = async (): Promise<number> =>
      Number(
        (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM owner_actions WHERE organization_id = $1 AND action = 'logs.bundle_export'`, [f.org.id])).rows[0]
          ?.n,
      );
    const before = await exports();
    // L4 — 쿠키만(교차 사이트 폼·링크·no-cors fetch 가 싣는 것) · 같은 사이트(SameSite=Strict 쿠키가 실린다) · 틀린 토큰 → 403, 감사 행 0.
    for (const headers of [
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://id.atmark.ai', 'sec-fetch-site': 'same-site' },
      {},
      { 'x-atmark-csrf': 'not-the-token' },
    ]) {
      const refused = await call(deps, 'GET', '/api/logs/bundle', { cookies: f.session.cookies, headers });
      expect(refused.statusCode, JSON.stringify(headers)).toBe(403);
      expect((refused.json() as { error: string }).error).toBe('csrf_mismatch');
    }
    expect(await exports()).toBe(before);
    // 읽기만 하는 증명 GET 은 CSRF 없이도 된다(쓰지 않는다).
    const entry = (await tlog.query<{ id: string }>('SELECT l.id::text AS id FROM tlog_leaves l JOIN tlog_logs g ON g.org_log_id = l.org_log_id WHERE g.organization_id = $1 ORDER BY l.seq LIMIT 1', [f.org.id])).rows[0]?.id ?? '';
    const proofPaths = [`/api/logs/inclusion-proof`, `/api/logs/consistency-proof`, `/api/logs/bundle`] as const;
    const queryOf = (path: string): string => (path.endsWith('inclusion-proof') ? `entry=${entry}` : `from=${String(epoch)}&to=${String(epoch)}`);
    expect((await call(deps, 'GET', '/api/logs/inclusion-proof', { cookies: f.session.cookies, query: queryOf('inclusion-proof') })).statusCode).toBe(200);

    // L3 — 같은 조직의 증명 계산이 돌고 있으면(잠금을 잡은 채) 기다리지 않고 429. 다른 조직은 막히지 않는다.
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('tlog_proof:' || $1::text, 0))`, [f.org.id]);
      for (const path of proofPaths) {
        const busy = await call(deps, 'GET', path, authed(f.session, { query: queryOf(path) }));
        expect(busy.statusCode, path).toBe(429);
        expect((busy.json() as { error: string }).error).toBe('rate_limited');
      }
      expect(await exports()).toBe(before);
      expect((await call(deps, 'GET', '/api/logs/bundle', authed(other.session, { query: queryOf('bundle') }))).statusCode).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    for (const path of proofPaths) expect((await call(deps, 'GET', path, authed(f.session, { query: queryOf(path) }))).statusCode, path).toBe(200);
    expect(await exports()).toBe(before + 1);

    // 시간당 상한 — 감사 행을 센다(로그인·가입과 같은 창 세기). 상한에 닿으면 429 · 감사 행이 늘지 않는다.
    await owner.query(
      `INSERT INTO owner_actions (session_id, organization_id, action, target_id)
       SELECT a.session_id, a.organization_id, a.action, a.target_id FROM owner_actions a, generate_series(1, $2::int)
        WHERE a.id = (SELECT id FROM owner_actions WHERE organization_id = $1 AND action = 'logs.bundle_export' LIMIT 1)`,
      [f.org.id, BUNDLE_EXPORTS_PER_HOUR - (await exports())],
    );
    expect(await exports()).toBe(BUNDLE_EXPORTS_PER_HOUR);
    const capped = await call(deps, 'GET', '/api/logs/bundle', authed(f.session, { query: queryOf('bundle') }));
    expect(capped.statusCode).toBe(429);
    expect(await exports()).toBe(BUNDLE_EXPORTS_PER_HOUR);
  });
});
