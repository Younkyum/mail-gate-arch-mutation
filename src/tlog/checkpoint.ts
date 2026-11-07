/**
 * src/tlog/checkpoint.ts — **C2SP 체크포인트 + signed note** (ADR-0008 §2.4, c2sp.org/tlog-checkpoint · c2sp.org/signed-note,
 * 2026-09-24 확인).
 *
 *   체크포인트 본문(note text) = "<origin>\n<tree size 십진>\n<base64(root)>\n"         — 확장 줄 없음(비권장)
 *   signed note              = <note text> "\n" ("— " <key name> " " base64(key_id[4] ‖ sig[64]) "\n")+
 *   key_id                   = SHA-256(<key name> ‖ 0x0A ‖ 0x01 ‖ 32바이트 Ed25519 공개키)[:4]   (0x01 = Ed25519 서명 종류)
 *   서명                      = Ed25519(RFC 8032) over note text(마지막 개행 포함, 빈 줄 제외)
 *   vkey                     = <key name> "+" hex(key_id) "+" base64(0x01 ‖ 공개키)
 *
 * 서명 여러 개를 허용한다(키 교체 기간의 공동 서명 — 모르는 서명은 무시). 검증은 **고정한 키**의 서명 하나가 맞아야 통과다.
 * 여기는 서명을 **만들지 않는다** — 서명은 KMS(`checkpoint-signer.ts`, 비추출 키)가 하고, 이 파일은 바이트 형식과 검증만 안다.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { sha256 } from './merkle';

export const ED25519_SIGNATURE_TYPE = 0x01;
const EM_DASH = '—';

export interface Checkpoint {
  readonly origin: string;
  readonly size: number;
  readonly root: Buffer;
}

export function checkpointBody(checkpoint: Checkpoint): string {
  if (checkpoint.origin === '' || /[\s+]/u.test(checkpoint.origin)) throw new TypeError('origin 모양이 아니다');
  if (!Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0) throw new TypeError('size 는 0 이상 정수다');
  if (checkpoint.root.length !== 32) throw new TypeError('root 는 32바이트다');
  return `${checkpoint.origin}\n${String(checkpoint.size)}\n${checkpoint.root.toString('base64')}\n`;
}

export function parseCheckpointBody(text: string): Checkpoint {
  const lines = text.split('\n');
  if (lines.length < 4 || lines.at(-1) !== '') throw new TypeError('체크포인트 본문은 개행으로 끝나는 세 줄 이상이다');
  const [origin, size, root] = lines as [string, string, string];
  if (origin === '' || /[\s+]/u.test(origin)) throw new TypeError('origin 줄 모양이 아니다');
  if (!/^(0|[1-9][0-9]{0,15})$/.test(size) || !Number.isSafeInteger(Number(size))) throw new TypeError('tree size 줄 모양이 아니다');
  const rootBytes = Buffer.from(root, 'base64');
  if (rootBytes.length !== 32 || rootBytes.toString('base64') !== root) throw new TypeError('root 줄 모양이 아니다');
  return { origin, size: Number(size), root: rootBytes };
}

export function keyIdOf(keyName: string, publicKey: Uint8Array): Buffer {
  if (publicKey.length !== 32) throw new TypeError('Ed25519 공개키는 32바이트다');
  return sha256(Buffer.from(keyName, 'utf8'), Uint8Array.of(0x0a, ED25519_SIGNATURE_TYPE), publicKey).subarray(0, 4);
}

export function vkeyOf(keyName: string, publicKey: Uint8Array): string {
  return `${keyName}+${keyIdOf(keyName, publicKey).toString('hex')}+${Buffer.concat([Uint8Array.of(ED25519_SIGNATURE_TYPE), publicKey]).toString('base64')}`;
}

export interface VerifierKey {
  readonly name: string;
  readonly keyId: Buffer;
  readonly publicKey: Buffer;
}

/**
 * vkey → 키. Go `golang.org/x/mod/sumdb/note` `NewVerifier` 와 같은 자르기: 이름 = 첫 `+` 앞 · 키 id = 첫 `+` 와 둘째 `+` 사이 ·
 * 키 자료 = **나머지 전부**. base64 키 자료에는 `+` 가 들어갈 수 있다(약 절반의 키) — `split('+')` 로 자르면 그런 키를 거부한다.
 * 이름은 C2SP 규칙대로 비어 있지 않고 공백·`+` 가 없다(첫 `+` 앞이라 `+` 는 이미 없다).
 */
export function parseVkey(vkey: string): VerifierKey {
  const first = vkey.indexOf('+');
  const second = first < 0 ? -1 : vkey.indexOf('+', first + 1);
  if (first < 0 || second < 0) throw new TypeError('vkey 는 이름+키id+키 세 부분이다');
  const name = vkey.slice(0, first);
  const idHex = vkey.slice(first + 1, second);
  const material = vkey.slice(second + 1);
  if (name === '' || /\s/u.test(name)) throw new TypeError('vkey 이름 모양이 아니다');
  if (!/^[0-9a-f]{8}$/.test(idHex)) throw new TypeError('vkey 키 id 는 hex 8자다');
  const bytes = Buffer.from(material, 'base64');
  if (bytes.toString('base64') !== material) throw new TypeError('vkey 키 자료가 정규 base64 가 아니다');
  if (bytes.length !== 33 || bytes[0] !== ED25519_SIGNATURE_TYPE) throw new TypeError('Ed25519 vkey 가 아니다');
  const publicKey = bytes.subarray(1);
  const keyId = keyIdOf(name, publicKey);
  if (keyId.toString('hex') !== idHex) throw new TypeError('vkey 의 키 id 가 공개키와 맞지 않는다');
  return { name, keyId, publicKey };
}

/** 원시 Ed25519 공개키(32바이트) → Node KeyObject(SPKI DER). */
export function ed25519PublicKeyObject(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  if (raw.length !== 32) throw new TypeError('Ed25519 공개키는 32바이트다');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' });
}

export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  return cryptoVerify(null, message, ed25519PublicKeyObject(publicKey), signature);
}

/** note text + 서명 한 줄(키 이름·키 id·서명). */
export function signedNote(text: string, keyName: string, keyId: Uint8Array, signature: Uint8Array): string {
  if (!text.endsWith('\n')) throw new TypeError('note text 는 개행으로 끝난다');
  if (keyId.length !== 4 || signature.length !== 64) throw new TypeError('키 id 4 · 서명 64 바이트');
  return `${text}\n${EM_DASH} ${keyName} ${Buffer.concat([keyId, signature]).toString('base64')}\n`;
}

export interface NoteSignature {
  readonly keyName: string;
  readonly keyId: Buffer;
  readonly signature: Buffer;
}

export interface ParsedNote {
  readonly text: string;
  readonly signatures: readonly NoteSignature[];
}

export function parseSignedNote(note: string): ParsedNote {
  const separator = note.lastIndexOf('\n\n');
  if (separator < 0) throw new TypeError('signed note 가 아니다(빈 줄 없음)');
  const text = note.slice(0, separator + 1);
  const block = note.slice(separator + 2);
  if (!block.endsWith('\n')) throw new TypeError('서명 줄은 개행으로 끝난다');
  const signatures = block
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      const match = /^— (\S+) ([A-Za-z0-9+/=]+)$/u.exec(line);
      if (match === null) throw new TypeError('서명 줄 모양이 아니다');
      const bytes = Buffer.from(match[2] as string, 'base64');
      if (bytes.length < 5) throw new TypeError('서명이 너무 짧다');
      return { keyName: match[1] as string, keyId: bytes.subarray(0, 4), signature: bytes.subarray(4) };
    });
  if (signatures.length === 0) throw new TypeError('서명이 없다');
  return { text, signatures };
}

/** 고정한 vkey 로 signed note 를 검증하고 본문(체크포인트)을 돌려준다. 맞는 서명이 없으면 던진다. */
export function openCheckpoint(note: string, vkey: VerifierKey, expectedOrigin: string): Checkpoint {
  const parsed = parseSignedNote(note);
  const ok = parsed.signatures.some(
    (candidate) =>
      candidate.keyName === vkey.name &&
      candidate.keyId.equals(vkey.keyId) &&
      verifyEd25519(vkey.publicKey, Buffer.from(parsed.text, 'utf8'), candidate.signature),
  );
  if (!ok) throw new Error('checkpoint_signature_invalid');
  const checkpoint = parseCheckpointBody(parsed.text);
  if (checkpoint.origin !== expectedOrigin) throw new Error('checkpoint_origin_mismatch');
  return checkpoint;
}
