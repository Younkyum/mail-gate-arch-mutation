/**
 * test/support/tlog-fixtures.ts — 투명성 로그 테스트의 가짜 부품. **AWS·외부 호출 0.**
 *   - 체크포인트 서명기: 고정 시드 Ed25519(로컬 DB 에 쌓이는 에폭이 모두 같은 키로 서명되게 — 번들 검증이 실행마다 새 키를 만나지 않는다).
 *   - 앵커 서명기: 로컬 P-256.
 *   - 공개 로그 쓰기: 메모리(경로 → 바이트).
 *   - 게시된 체크포인트 읽기: 메모리 쓰기의 `checkpoint` 를 돌려준다.
 *   - OTS 캘린더·Rekor: 형식이 맞는 응답을 만드는 가짜(호출 기록). 가짜 Rekor 는 체크포인트를 고정 시드 Ed25519 **샤드 키**로 서명한다
 *     (`FAKE_REKOR_VKEY` — 앵커 워커·검증기가 이 키를 고정한다).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

import type { OtsCalendarClient, RekorClient } from '../../src/tlog/anchor-http';
import { checkpointBody, keyIdOf, parseVkey, signedNote, vkeyOf, type VerifierKey } from '../../src/tlog/checkpoint';
import { TLOG_ORIGIN } from '../../src/tlog/constants';
import { serializeTimestamp, type OtsTimestamp } from '../../src/tlog/ots';
import type { TlogObjectWriter, TlogPublishedReader } from '../../src/tlog/publisher';
import type { AnchorSigner, NoteSigner } from '../../src/tlog/signing';
import { refLeafHash, refNodeHash } from './tlog-reference';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 고정 시드 Ed25519 체크포인트 서명기(테스트 전용). */
export function testNoteSigner(seedByte = 7): NoteSigner & { readonly raw: Buffer } {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  const x = (createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x;
  const raw = Buffer.from(x, 'base64url');
  return {
    keyName: TLOG_ORIGIN,
    raw,
    publicKey: () => Promise.resolve(raw),
    sign: (message: Uint8Array) => Promise.resolve(sign(null, message, privateKey)),
  };
}

export function testAnchorSigner(): AnchorSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKeySpki: () => Promise.resolve(spki),
    // KMS 는 `ECDSA_SHA_256` + `MessageType: DIGEST` 로 다이제스트를 바로 서명한다. Node 에는 다이제스트를 바로 서명하는 API 가 없어
    //   가짜는 기억해 둔 원문(`rememberNote`)을 sha256 으로 서명한다 — 결과(원문의 SHA-256 에 대한 DER 서명)는 KMS 와 같은 뜻이다.
    signDigest: (digest: Uint8Array) => {
      const note = notes.get(Buffer.from(digest).toString('hex'));
      if (note === undefined) throw new Error('fake anchor signer: 다이제스트의 원문을 모른다');
      return Promise.resolve(sign('sha256', Buffer.from(note, 'utf8'), privateKey));
    },
  };
}

const notes = new Map<string, string>();
/** 가짜 앵커 서명기가 다이제스트 → 원문을 찾게 체크포인트 원문을 기억시킨다. */
export function rememberNote(note: string): void {
  notes.set(createHash('sha256').update(note, 'utf8').digest('hex'), note);
}

export function memoryWriter(): TlogObjectWriter & { readonly objects: Map<string, { body: Buffer; contentType: string; cacheControl: string }> } {
  const objects = new Map<string, { body: Buffer; contentType: string; cacheControl: string }>();
  return {
    objects,
    put(path: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
      objects.set(path, { body: Buffer.from(body), contentType, cacheControl });
      return Promise.resolve();
    },
  };
}

/** 메모리 쓰기가 받은 `checkpoint`(최신 게시본)를 읽는다 — 에폭 마감의 게시 수위. */
export function memoryPublished(writer: { readonly objects: Map<string, { body: Buffer }> }): TlogPublishedReader {
  return { readCheckpoint: () => Promise.resolve(writer.objects.get('checkpoint')?.body.toString('utf8') ?? null) };
}

export const FAKE_CALENDAR_URI = 'https://alice.btc.calendar.opentimestamps.org';

/** 가짜 캘린더 — 제출: append(nonce) → sha256 → pending. 업그레이드: commitment → sha256 → bitcoin(height). */
export function fakeOtsCalendar(options: { readonly failSubmit?: boolean; readonly upgraded?: boolean } = {}): OtsCalendarClient & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    submit(endpoint: string, digest: Buffer): Promise<Buffer> {
      calls.push(`submit ${endpoint}`);
      if (options.failSubmit === true) return Promise.reject(new Error('ots_http_503'));
      const nonce = createHash('sha256').update(endpoint).digest().subarray(0, 16);
      const appended = Buffer.concat([digest, nonce]);
      const commitment = createHash('sha256').update(appended).digest();
      const stamp: OtsTimestamp = {
        msg: digest,
        attestations: [],
        ops: [
          {
            op: { op: 'append', arg: nonce },
            child: {
              msg: appended,
              attestations: [],
              ops: [{ op: { op: 'sha256' }, child: { msg: commitment, attestations: [{ kind: 'pending', uri: FAKE_CALENDAR_URI }], ops: [] } }],
            },
          },
        ],
      };
      return Promise.resolve(serializeTimestamp(stamp));
    },
    upgrade(calendarUri: string, commitment: Buffer): Promise<Buffer | null> {
      calls.push(`upgrade ${calendarUri}`);
      if (options.upgraded !== true) return Promise.resolve(null);
      const root = createHash('sha256').update(commitment).digest();
      const stamp: OtsTimestamp = {
        msg: commitment,
        attestations: [],
        ops: [{ op: { op: 'sha256' }, child: { msg: root, attestations: [{ kind: 'bitcoin', height: 915000 }], ops: [] } }],
      };
      return Promise.resolve(serializeTimestamp(stamp));
    },
  };
}

/** 가짜 Rekor 샤드 — 호스트 · 고정 시드 Ed25519 체크포인트 키(C2SP vkey, 이름 = 호스트). */
export const FAKE_REKOR_HOST = 'log2026-1.rekor.sigstore.dev';
function rekorShardKey(seedByte: number): { readonly privateKey: ReturnType<typeof createPrivateKey>; readonly raw: Buffer } {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  return { privateKey, raw: Buffer.from((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x, 'base64url') };
}
const REKOR_SHARD = rekorShardKey(0x52);
export const FAKE_REKOR_VKEY = vkeyOf(FAKE_REKOR_HOST, REKOR_SHARD.raw);
export function fakeRekorKey(): VerifierKey {
  return parseVkey(FAKE_REKOR_VKEY);
}

/**
 * 가짜 Rekor v2 — 받은 요청을 본문에 담고, 이웃 잎 둘과 함께 크기 3 트리의 포함 증명과 **샤드 키로 서명한 체크포인트**를 돌려준다.
 * `corruptProof` 는 증명 해시를, `foreignCheckpointKey` 는 체크포인트를 다른 키로 서명한다(자기 참조 "확인" 을 잡는지).
 */
export function fakeRekor(options: { readonly corruptProof?: boolean; readonly foreignCheckpointKey?: boolean } = {}): RekorClient & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  const shard = options.foreignCheckpointKey === true ? rekorShardKey(0x53) : REKOR_SHARD;
  return {
    requests,
    submit(_endpoint: string, body: unknown): Promise<unknown> {
      requests.push(body);
      const request = (body as { hashedRekordRequestV002: { digest: string; signature: { content: string } } }).hashedRekordRequestV002;
      const canonical = Buffer.from(
        JSON.stringify({ apiVersion: '0.0.2', kind: 'hashedrekord', spec: { hashedRekordV002: { data: { algorithm: 'SHA2_256', digest: request.digest }, signature: request.signature } } }),
        'utf8',
      );
      const neighbours = [refLeafHash(Buffer.from('rekor-0')), refLeafHash(Buffer.from('rekor-1'))];
      const leaf = refLeafHash(canonical);
      // 크기 3: root = node(node(l0, l1), leaf) — 우리 잎은 index 2, 증명 = [node(l0,l1)].
      const left = refNodeHash(neighbours[0] as Buffer, neighbours[1] as Buffer);
      const root = refNodeHash(left, leaf);
      const proofHash = options.corruptProof === true ? refLeafHash(Buffer.from('x')) : left;
      const text = checkpointBody({ origin: FAKE_REKOR_HOST, size: 3, root });
      const envelope = signedNote(text, FAKE_REKOR_HOST, keyIdOf(FAKE_REKOR_HOST, shard.raw), sign(null, Buffer.from(text, 'utf8'), shard.privateKey));
      return Promise.resolve({
        logIndex: '2',
        logId: { keyId: 'ZmFrZQ==' },
        kindVersion: { kind: 'hashedrekord', version: '0.0.2' },
        inclusionProof: { logIndex: '2', rootHash: root.toString('base64'), treeSize: '3', hashes: [proofHash.toString('base64')], checkpoint: { envelope } },
        canonicalizedBody: canonical.toString('base64'),
      });
    },
  };
}
