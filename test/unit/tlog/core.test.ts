/**
 * 투명성 로그 순수 부품 — 잎·커밋 · 체크포인트(C2SP signed note) · 타일 경로 · OTS 형식 · 에폭 계획 · 앵커 HTTP 문(가짜 fetch) · S3 쓰기 면.
 * DB·AWS·외부 호출 0.
 */

import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PutObjectCommand } from '@aws-sdk/client-s3';

import { createS3TransparencyLogWriter, TLOG_OBJECT_KEY } from '../../../src/storage/s3-object-store';
import { backoffMs, checkRekorResponse } from '../../../src/tlog/anchor';
import { AnchorHttpError, anchorEndpoint, createHttpOtsClient, createHttpRekorClient } from '../../../src/tlog/anchor-http';
import {
  checkpointBody,
  keyIdOf,
  openCheckpoint,
  parseCheckpointBody,
  parseSignedNote,
  parseVkey,
  signedNote,
  vkeyOf,
} from '../../../src/tlog/checkpoint';
import { commitmentOf, leafIdOf, saltFor } from '../../../src/tlog/commit';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { EpochIntegrityError, planEpoch, type OrgHead } from '../../../src/tlog/epoch';
import { buildOrgLeaf, type OrgEvent } from '../../../src/tlog/leaf';
import { leafHash, rootOf } from '../../../src/tlog/merkle';
import { attestationsOf, detachedOts, mergeAt, parseDetachedOts, parseTimestamp, serializeTimestamp, type OtsTimestamp } from '../../../src/tlog/ots';
import { drainOutbox } from '../../../src/tlog/sequencer';
import { encodeTileIndex, rightmostTiles, tilePath } from '../../../src/tlog/tiles';
import { fakeOtsCalendar, fakeRekor, fakeRekorKey } from '../../support/tlog-fixtures';
import { refRoot } from '../../support/tlog-reference';

const LOG = 'ab'.repeat(16);
const SALT = Buffer.alloc(32, 3);
const AT = '2026-09-24T01:02:03.456789Z';
const src = (t: 'audit_logs' | 'owner_actions' | 'policy_versions' | 'inbound_messages', e: 'insert' | 'update' = 'insert', r = 0) => ({
  t,
  id: '11111111-2222-4333-8444-555555555555',
  e,
  r,
});

describe('잎 · 커밋', () => {
  it('같은 입력 → 같은 바이트 · 해시 = SHA-256(0x00 ‖ JCS) · 키 정렬된 JCS', () => {
    const event: OrgEvent = { kind: 'owner.action', src: src('owner_actions'), at: AT, action: 'agent.create', targetId: null, sessionId: randomBytes(8).toString('hex') };
    const a = buildOrgLeaf({ log: LOG, seq: 3, saltKey: SALT }, event);
    const b = buildOrgLeaf({ log: LOG, seq: 3, saltKey: SALT }, event);
    expect(a.json).toBe(b.json);
    expect(a.hash).toEqual(createHash('sha256').update(Buffer.from([0])).update(a.json).digest());
    expect(Object.keys(JSON.parse(a.json) as object)).toEqual(['at', 'body', 'c', 'kind', 'log', 'seq', 'src', 'v']);
  });

  it('커밋은 잎·필드마다 다른 솔트 — 솔트 키가 없으면 열 수 없다', () => {
    const one = commitmentOf(saltFor(SALT, leafIdOf(LOG, 1), 'from'), 'a@b.example');
    const two = commitmentOf(saltFor(SALT, leafIdOf(LOG, 2), 'from'), 'a@b.example');
    const other = commitmentOf(saltFor(Buffer.alloc(32, 4), leafIdOf(LOG, 1), 'from'), 'a@b.example');
    expect(new Set([one, two, other]).size).toBe(3);
    expect(() => saltFor(Buffer.alloc(16), 'x', 'f')).toThrow(RangeError);
  });

  it('코드 칸의 모양 밖 값(주소가 섞인 오류 문장)은 평문이 아니라 커밋으로 간다 — 버리지도 않는다', () => {
    const leaf = buildOrgLeaf(
      { log: LOG, seq: 1, saltKey: SALT },
      {
        kind: 'audit.updated',
        src: src('audit_logs', 'update', 1),
        at: AT,
        auditId: '11111111-2222-4333-8444-555555555555',
        decision: 'allowed',
        resolutionReason: 'failed:bounce for victim@x.example',
        resolvedAt: AT,
        approvedBy: null,
      },
    );
    const parsed = JSON.parse(leaf.json) as { body: Record<string, unknown>; c: Record<string, string> };
    expect(parsed.body['resolution_reason']).toBeNull();
    expect(parsed.c['body.resolution_reason']).toBe(
      commitmentOf(saltFor(SALT, leafIdOf(LOG, 1), 'body.resolution_reason'), 'failed:bounce for victim@x.example'),
    );
    expect(leaf.json).not.toContain('victim@x.example');
  });

  it('봉투 모양이 틀린 입력은 던진다(log·seq·시각)', () => {
    const genesis: OrgEvent = { kind: 'org.genesis', at: AT };
    expect(() => buildOrgLeaf({ log: 'zz', seq: 0, saltKey: SALT }, genesis)).toThrow();
    expect(() => buildOrgLeaf({ log: LOG, seq: -1, saltKey: SALT }, genesis)).toThrow();
    expect(() => buildOrgLeaf({ log: LOG, seq: 0, saltKey: SALT }, { kind: 'org.genesis', at: '2026-09-24' })).toThrow();
  });
});

describe('C2SP 체크포인트 · signed note', () => {
  const seed = Buffer.alloc(32, 5);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = Buffer.from(
    (privateKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  );

  it('본문 세 줄 + 개행 · 서명 줄 = "— 이름 base64(keyid4‖sig64)" · vkey 왕복 · 고정 키로 연다', () => {
    const root = rootOf([leafHash(Buffer.from('a'))]);
    const text = checkpointBody({ origin: TLOG_ORIGIN, size: 1, root });
    expect(text).toBe(`${TLOG_ORIGIN}\n1\n${root.toString('base64')}\n`);
    expect(parseCheckpointBody(text)).toEqual({ origin: TLOG_ORIGIN, size: 1, root });
    const keyId = keyIdOf(TLOG_ORIGIN, publicKey);
    expect(keyId).toEqual(createHash('sha256').update(`${TLOG_ORIGIN}\n`).update(Buffer.from([1])).update(publicKey).digest().subarray(0, 4));
    const note = signedNote(text, TLOG_ORIGIN, keyId, sign(null, Buffer.from(text), privateKey));
    expect(note.split('\n').at(-2)).toMatch(/^— id\.atmark\.ai\/log\/v1 [A-Za-z0-9+/]+={0,2}$/u);
    const vkey = parseVkey(vkeyOf(TLOG_ORIGIN, publicKey));
    expect(openCheckpoint(note, vkey, TLOG_ORIGIN).root).toEqual(root);
    expect(parseSignedNote(note).signatures).toHaveLength(1);
    // 서명 한 바이트 · 본문 한 글자 · 다른 origin → 거부.
    const tampered = note.replace(`\n1\n`, `\n2\n`);
    expect(() => openCheckpoint(tampered, vkey, TLOG_ORIGIN)).toThrow('checkpoint_signature_invalid');
    expect(() => openCheckpoint(note, vkey, 'example.com/other')).toThrow('checkpoint_origin_mismatch');
    expect(() => parseVkey(`${TLOG_ORIGIN}+00000000+${Buffer.concat([Buffer.from([1]), publicKey]).toString('base64')}`)).toThrow();
  });

  it('origin 에 공백·+ 가 있으면 본문을 만들지 않는다', () => {
    expect(() => checkpointBody({ origin: 'a b', size: 0, root: Buffer.alloc(32) })).toThrow();
    expect(() => checkpointBody({ origin: 'a+b', size: 0, root: Buffer.alloc(32) })).toThrow();
  });
});

describe('서열기 시각(L1 — 창세 잎의 at 은 advisory lock 뒤)', () => {
  it('시각은 잠금을 잡은 뒤에 읽는다 — 잠금을 기다리는 동안 닫힌 에폭보다 창세 잎이 앞서지 않게', async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string): Promise<{ rows: unknown[] }> => {
        events.push(text.includes('pg_advisory_xact_lock') ? 'lock' : text.trim().split(/\s+/)[0] ?? '');
        return { rows: [] };
      },
      release: (): void => undefined,
    };
    await drainOutbox({
      db: { connect: async () => client } as never,
      now: () => {
        events.push('now');
        return new Date('2026-09-24T00:00:00Z');
      },
    });
    expect(events.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('now')).toBeGreaterThan(events.indexOf('lock'));
  });
});

describe('C2SP tlog-tiles', () => {
  it('타일 번호 인코딩 · 경로', () => {
    expect(encodeTileIndex(0)).toBe('000');
    expect(encodeTileIndex(1234067)).toBe('x001/x234/067');
    expect(tilePath(0, 5, 256)).toBe('tile/0/005');
    expect(tilePath(1, 1000, 17)).toBe('tile/1/x001/000.p/17');
    expect(tilePath('entries', 0, 3)).toBe('tile/entries/000.p/3');
  });

  it('레벨 L 해시 = 완전 부분 트리의 MTH · 잎 묶음 = uint16 길이 접두', () => {
    const entries = Array.from({ length: 600 }, (_, i) => Buffer.from(`entry-${String(i)}`));
    const hashes = entries.map((entry) => leafHash(entry));
    const tiles = rightmostTiles(hashes, entries, 600);
    const byPath = new Map(tiles.map((tile) => [tile.path, tile.bytes]));
    expect([...byPath.keys()].sort()).toEqual(['tile/0/002.p/88', 'tile/1/000.p/2', 'tile/entries/002.p/88']);
    const level1 = byPath.get('tile/1/000.p/2') as Buffer;
    expect(level1.subarray(0, 32)).toEqual(refRoot(hashes.slice(0, 256)));
    expect(level1.subarray(32, 64)).toEqual(refRoot(hashes.slice(256, 512)));
    const bundle = byPath.get('tile/entries/002.p/88') as Buffer;
    expect(bundle.readUInt16BE(0)).toBe(entries[512]?.length);
    expect(bundle.subarray(2, 2 + (entries[512]?.length ?? 0)).toString()).toBe('entry-512');
  });
});

describe('OpenTimestamps 형식', () => {
  it('캘린더 응답 → 파싱 → 직렬화 왕복 · 업그레이드 병합 → Bitcoin 증명 · .ots 파일 헤더', async () => {
    const digest = createHash('sha256').update('checkpoint').digest();
    const calendar = fakeOtsCalendar({ upgraded: true });
    const bytes = await calendar.submit('https://a.pool.opentimestamps.org', digest);
    const stamp = parseTimestamp(bytes, digest);
    expect(serializeTimestamp(stamp)).toEqual(bytes);
    const pending = attestationsOf(stamp).filter((found) => found.attestation.kind === 'pending');
    expect(pending).toHaveLength(1);
    const commitment = pending[0]?.msg as Buffer;
    const upgrade = parseTimestamp((await calendar.upgrade('x', commitment)) as Buffer, commitment);
    expect(mergeAt(stamp, commitment, upgrade)).toBe(1);
    expect(attestationsOf(stamp).map((found) => found.attestation.kind).sort()).toEqual(['bitcoin', 'pending']);
    const file = detachedOts(digest, stamp);
    expect(file.subarray(0, 31).toString('latin1')).toContain('OpenTimestamps');
    const reread = parseDetachedOts(file);
    expect(reread.digest).toEqual(digest);
    expect(serializeTimestamp(reread.stamp)).toEqual(serializeTimestamp(stamp));
  });

  it('다른 다이제스트로 시작 · 남는 바이트 · 모르는 연산은 거부', () => {
    const digest = Buffer.alloc(32, 1);
    const stamp: OtsTimestamp = { msg: digest, attestations: [{ kind: 'bitcoin', height: 1 }], ops: [] };
    const bytes = serializeTimestamp(stamp);
    expect(() => parseTimestamp(Buffer.concat([bytes, Buffer.from([0])]), digest)).toThrow('ots_trailing_bytes');
    expect(() => parseTimestamp(Buffer.from([0x67, 0x00]), digest)).toThrow(/ots_unknown_op/);
    expect(() => detachedOts(Buffer.alloc(32, 2), stamp)).toThrow('ots_detached_digest_mismatch');
  });
});

describe('에폭 계획 — 완전성 · 일관성(서명 전에 스스로 본다)', () => {
  const headOf = (log: string, leaves: readonly Buffer[]): OrgHead => ({ log, size: leaves.length, root: rootOf(leaves) });
  const leavesA = [leafHash(Buffer.from('a0')), leafHash(Buffer.from('a1'))];
  const leavesB = [leafHash(Buffer.from('b0'))];
  const logs = ['aa'.repeat(16), 'bb'.repeat(16)];

  it('모든 조직 로그에 헤드 하나 — 바뀌지 않은 조직도 담는다(빠지면 epoch_incomplete)', () => {
    const plan = planEpoch({
      epoch: 0,
      closedAt: AT,
      logs,
      heads: [headOf(logs[1] as string, leavesB), headOf(logs[0] as string, leavesA)],
      previousHeads: [],
      globalLeafHashes: [],
      previousRoot: null,
      leafHashesOf: () => undefined,
    });
    expect(plan.heads.map((head) => head.log)).toEqual(logs);
    expect(() =>
      planEpoch({ epoch: 0, closedAt: AT, logs, heads: [headOf(logs[0] as string, leavesA)], previousHeads: [], globalLeafHashes: [], previousRoot: null, leafHashesOf: () => undefined }),
    ).toThrow(EpochIntegrityError);
  });

  it('되감긴 전역 루트 · 줄어든 조직 로그 · 바뀐 과거 잎에는 서명하지 않는다', () => {
    const first = planEpoch({ epoch: 0, closedAt: AT, logs, heads: [headOf(logs[0] as string, leavesA), headOf(logs[1] as string, leavesB)], previousHeads: [], globalLeafHashes: [], previousRoot: null, leafHashesOf: () => undefined });
    const base = {
      epoch: 1,
      closedAt: '2026-09-24T02:00:00.000000Z',
      logs,
      heads: first.heads,
      previousHeads: first.heads,
      globalLeafHashes: [first.globalLeafHash],
      leafHashesOf: () => undefined,
    };
    expect(planEpoch({ ...base, previousRoot: first.globalRoot }).treeSize).toBe(2);
    expect(() => planEpoch({ ...base, previousRoot: Buffer.alloc(32, 7) })).toThrow('checkpoint_inconsistent');
    expect(() => planEpoch({ ...base, previousRoot: first.globalRoot, heads: [headOf(logs[0] as string, leavesA.slice(0, 1)), first.heads[1] as OrgHead] })).toThrow('org_head_shrunk');
    const rewritten = [leafHash(Buffer.from('rewritten')), ...leavesA.slice(1), leafHash(Buffer.from('a2'))];
    expect(() =>
      planEpoch({ ...base, previousRoot: first.globalRoot, heads: [headOf(logs[0] as string, rewritten), first.heads[1] as OrgHead], leafHashesOf: () => rewritten }),
    ).toThrow('org_head_inconsistent');
  });
});

describe('앵커 HTTP 문 — 허용 호스트만 · 가짜 fetch', () => {
  it('엔드포인트 모양: https + 이름으로 고정한 호스트뿐', () => {
    expect(anchorEndpoint('https://a.pool.opentimestamps.org', 'opentimestamps')).toBe('https://a.pool.opentimestamps.org');
    expect(anchorEndpoint('https://log2026-1.rekor.sigstore.dev/', 'rekor')).toBe('https://log2026-1.rekor.sigstore.dev');
    expect(anchorEndpoint('https://alice.btc.calendar.opentimestamps.org', 'ots-upgrade')).toBe('https://alice.btc.calendar.opentimestamps.org');
    for (const [raw, kind] of [
      ['http://a.pool.opentimestamps.org', 'opentimestamps'],
      ['https://evil.example', 'opentimestamps'],
      ['https://alice.btc.calendar.opentimestamps.org', 'opentimestamps'],
      ['https://a.pool.opentimestamps.org:8443', 'opentimestamps'],
      ['https://rekor.sigstore.dev', 'rekor'],
      ['https://calendar.opentimestamps.org.evil.example', 'ots-upgrade'],
      ['https://u:p@a.pool.opentimestamps.org', 'opentimestamps'],
    ] as const) {
      expect(() => anchorEndpoint(raw, kind)).toThrow(AnchorHttpError);
    }
  });

  it('OTS: POST /digest(32바이트) · 404 업그레이드는 null · 크기 상한 · 리다이렉트 금지 · Rekor: POST /api/v2/log/entries', async () => {
    const seen: { url: string; method: string; redirect: string; bodyLength: number }[] = [];
    const reply = (status: number, body: Buffer | string) => {
      const bytes = Buffer.from(body);
      return { status, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer) };
    };
    const fetchImpl = (url: string, init: { method: string; redirect: string; body?: Uint8Array | string }) => {
      seen.push({ url, method: init.method, redirect: init.redirect, bodyLength: init.body === undefined ? 0 : Buffer.from(init.body).length });
      if (url.endsWith('/digest')) return Promise.resolve(reply(200, Buffer.from([0x00, ...Buffer.from('83dfe30d2ef90c8e', 'hex'), 1, 0])));
      if (url.includes('/timestamp/')) return Promise.resolve(reply(404, ''));
      if (url.endsWith('/api/v2/log/entries')) return Promise.resolve(reply(201, '{"logIndex":"1"}'));
      return Promise.resolve(reply(500, ''));
    };
    const ots = createHttpOtsClient(fetchImpl as never);
    await ots.submit('https://a.pool.opentimestamps.org', Buffer.alloc(32));
    expect(await ots.upgrade('https://alice.btc.calendar.opentimestamps.org', Buffer.alloc(32))).toBeNull();
    const rekor = createHttpRekorClient(fetchImpl as never);
    expect(await rekor.submit('https://log2026-1.rekor.sigstore.dev', { a: 1 })).toEqual({ logIndex: '1' });
    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://a.pool.opentimestamps.org/digest',
      `GET https://alice.btc.calendar.opentimestamps.org/timestamp/${'00'.repeat(32)}`,
      'POST https://log2026-1.rekor.sigstore.dev/api/v2/log/entries',
    ]);
    expect(seen.every((call) => call.redirect === 'error')).toBe(true);
    expect(seen[0]?.bodyLength).toBe(32);
    const huge = createHttpOtsClient((() => Promise.resolve(reply(200, Buffer.alloc(20_000)))) as never);
    await expect(huge.submit('https://a.pool.opentimestamps.org', Buffer.alloc(32))).rejects.toThrow('anchor_http_response_too_large');
    const down = createHttpOtsClient((() => Promise.resolve(reply(503, ''))) as never);
    await expect(down.submit('https://a.pool.opentimestamps.org', Buffer.alloc(32))).rejects.toThrow('ots_http_503');
    await expect(ots.submit('https://evil.example', Buffer.alloc(32))).rejects.toThrow('anchor_endpoint_not_allowed');
  });

  it('Rekor 응답 검증 — 고정한 샤드 키로 체크포인트를 연다(응답의 루트를 스스로 믿지 않는다) · 백오프', async () => {
    const request = { hashedRekordRequestV002: { digest: 'ZGlnZXN0', signature: { content: 'c2ln' } } };
    const key = fakeRekorKey();
    const response = await fakeRekor().submit('x', request);
    expect(() => checkRekorResponse(response, 'ZGlnZXN0', 'c2ln', key)).not.toThrow();
    expect(() => checkRekorResponse(response, 'b3RoZXI=', 'c2ln', key)).toThrow('rekor_entry_body_mismatch');
    const corrupt = await fakeRekor({ corruptProof: true }).submit('x', request);
    expect(() => checkRekorResponse(corrupt, 'ZGlnZXN0', 'c2ln', key)).toThrow('rekor_inclusion_proof_invalid');
    // 다른 키가 서명한 체크포인트 — 포함 증명이 응답 안에서 맞아도 "기록됐다" 고 적지 않는다.
    const foreign = await fakeRekor({ foreignCheckpointKey: true }).submit('x', request);
    expect(() => checkRekorResponse(foreign, 'ZGlnZXN0', 'c2ln', key)).toThrow('rekor_checkpoint_signature_invalid');
    // 체크포인트는 맞는데 증명이 다른 루트를 가리킨다.
    const swapped = structuredClone(response) as { inclusionProof: { rootHash: string } };
    swapped.inclusionProof.rootHash = Buffer.alloc(32, 1).toString('base64');
    expect(() => checkRekorResponse(swapped, 'ZGlnZXN0', 'c2ln', key)).toThrow('rekor_checkpoint_mismatch');
    const bare = structuredClone(response) as { inclusionProof: { checkpoint?: unknown } };
    delete bare.inclusionProof.checkpoint;
    expect(() => checkRekorResponse(bare, 'ZGlnZXN0', 'c2ln', key)).toThrow('rekor_checkpoint_missing');
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([300_000, 600_000, 1_200_000, 21_600_000]);
  });
});

describe('S3 공개 로그 쓰기 면', () => {
  it('로그 경로 모양만 · Object Lock 체크섬(SHA-256) · 소유 계정 고정', async () => {
    const sent: PutObjectCommand[] = [];
    const writer = createS3TransparencyLogWriter({
      client: { send: (command: PutObjectCommand) => (sent.push(command), Promise.resolve({ $metadata: {} })) } as never,
      bucket: 'atmark-tlog-123456789012',
      expectedBucketOwner: '123456789012',
    });
    await writer.put('checkpoint', Buffer.from('x'), 'text/plain; charset=utf-8', 'public, max-age=60');
    await writer.put('tile/0/x001/000.p/5', Buffer.alloc(160), 'application/octet-stream', 'public, max-age=31536000, immutable');
    await writer.put('anchors/ots/12/a.pool.opentimestamps.org.ots', Buffer.from('x'), 'application/octet-stream', 'x');
    expect(sent.map((command) => command.input.Key)).toEqual(['log/checkpoint', 'log/tile/0/x001/000.p/5', 'log/anchors/ots/12/a.pool.opentimestamps.org.ots']);
    expect(sent.every((command) => command.input.ChecksumAlgorithm === 'SHA256' && command.input.ExpectedBucketOwner === '123456789012')).toBe(true);
    for (const bad of ['../agents/x/did.json', 'checkpoint/../../x', 'agents/0/did.json', 'tile/0/1', 'anchors/rekor/x.json']) {
      await expect(writer.put(bad, Buffer.from('x'), 'text/plain', 'x')).rejects.toThrow('투명성 로그 경로가 아니다');
    }
    expect(TLOG_OBJECT_KEY.test('log/checkpoints/0')).toBe(true);
  });
});
