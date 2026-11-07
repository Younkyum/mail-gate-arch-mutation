/**
 * src/tlog/ots.ts — **OpenTimestamps 증명 형식**(python-opentimestamps `core/timestamp.py`·`op.py`·`notary.py`, 2026-09-24 확인).
 *
 * 캘린더(`POST <calendar>/digest`, 본문 = 32바이트 다이제스트)는 **그 다이제스트에서 시작하는 Timestamp 직렬화**를 돌려준다.
 * 대기(pending) 증명의 잎에는 `PendingAttestation(uri)` 이 있고, 몇 시간 뒤 `GET <calendar>/timestamp/<commitment hex>` 가
 * 그 commitment 에서 시작하는 Bitcoin 쪽 증명을 준다 — 받아서 같은 자리에 **합친다**(upgrade).
 *
 *   Timestamp  = ( 0xff (0x00 attestation | op child) )* ( 0x00 attestation | op child )
 *   attestation = tag[8] ‖ varbytes(payload)       pending = 83dfe30d2ef90c8e, payload = varbytes(uri)
 *                                                   bitcoin = 0588960d73d71901, payload = varuint(height)
 *   op          = 0xf0 append(varbytes) | 0xf1 prepend(varbytes) | 0x08 sha256 | 0x02 sha1 | 0x03 ripemd160 | 0xf2 reverse | 0xf3 hexlify
 *   .ots 파일    = "\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94" ‖ 0x01 ‖ 0x08(sha256) ‖ digest[32] ‖ Timestamp
 *
 * 받은 바이트는 **다시 계산해 본다** — 증명이 우리 다이제스트에서 시작하고, 연산 결과가 합리적 크기(≤ 4096)를 넘지 않으며,
 * 끝에 증명(attestation)이 있는지. 캘린더를 믿지 않는다(가용성만 믿는다 — ADR-0008 §2.7). Bitcoin 블록 헤더와의 대조는
 * 이 코드가 하지 않는다(노드가 필요하다) — 번들 검증기와 `ots verify` 의 몫이다(런북).
 */

import { createHash } from 'node:crypto';

export const OTS_HEADER_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
export const OTS_MAJOR_VERSION = 1;
export const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
export const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');
const MAX_RESULT = 4096;
const MAX_DEPTH = 256;

export type OtsAttestation =
  | { readonly kind: 'pending'; readonly uri: string }
  | { readonly kind: 'bitcoin'; readonly height: number }
  | { readonly kind: 'unknown'; readonly tag: Buffer; readonly payload: Buffer };

export type OtsOp =
  | { readonly op: 'append' | 'prepend'; readonly arg: Buffer }
  | { readonly op: 'sha256' | 'sha1' | 'ripemd160' | 'reverse' | 'hexlify' };

export interface OtsTimestamp {
  readonly msg: Buffer;
  readonly attestations: OtsAttestation[];
  readonly ops: { readonly op: OtsOp; readonly child: OtsTimestamp }[];
}

export class OtsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtsFormatError';
  }
}

class Reader {
  offset = 0;

  constructor(private readonly bytes: Buffer) {}

  byte(): number {
    if (this.offset >= this.bytes.length) throw new OtsFormatError('ots_truncated');
    return this.bytes[this.offset++] as number;
  }

  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length) throw new OtsFormatError('ots_truncated');
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(out);
  }

  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 49) throw new OtsFormatError('ots_varuint_too_large');
    }
    return value;
  }

  varbytes(max: number): Buffer {
    const length = this.varuint();
    if (length > max) throw new OtsFormatError('ots_varbytes_too_large');
    return this.take(length);
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function varuint(value: number): Buffer {
  const out: number[] = [];
  let rest = value;
  do {
    let b = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) b |= 0x80;
    out.push(b);
  } while (rest > 0);
  return Buffer.from(out);
}

function varbytes(bytes: Uint8Array): Buffer {
  return Buffer.concat([varuint(bytes.length), bytes]);
}

export function applyOp(op: OtsOp, msg: Buffer): Buffer {
  let out: Buffer;
  switch (op.op) {
    case 'append':
      out = Buffer.concat([msg, op.arg]);
      break;
    case 'prepend':
      out = Buffer.concat([op.arg, msg]);
      break;
    case 'sha256':
      out = createHash('sha256').update(msg).digest();
      break;
    case 'sha1':
      out = createHash('sha1').update(msg).digest();
      break;
    case 'ripemd160':
      out = createHash('ripemd160').update(msg).digest();
      break;
    case 'reverse':
      out = Buffer.from(msg).reverse();
      break;
    case 'hexlify':
      out = Buffer.from(msg.toString('hex'), 'ascii');
      break;
  }
  if (out.length > MAX_RESULT) throw new OtsFormatError('ots_result_too_large');
  return out;
}

function readOp(reader: Reader, tag: number): OtsOp {
  switch (tag) {
    case 0xf0:
      return { op: 'append', arg: reader.varbytes(MAX_RESULT) };
    case 0xf1:
      return { op: 'prepend', arg: reader.varbytes(MAX_RESULT) };
    case 0x08:
      return { op: 'sha256' };
    case 0x02:
      return { op: 'sha1' };
    case 0x03:
      return { op: 'ripemd160' };
    case 0xf2:
      return { op: 'reverse' };
    case 0xf3:
      return { op: 'hexlify' };
    default:
      throw new OtsFormatError(`ots_unknown_op_${tag.toString(16)}`);
  }
}

function readAttestation(reader: Reader): OtsAttestation {
  const tag = reader.take(8);
  const payload = reader.varbytes(8192);
  const inner = new Reader(payload);
  if (tag.equals(PENDING_TAG)) {
    const uri = inner.varbytes(1000).toString('utf8');
    if (!/^[A-Za-z0-9._/:-]+$/.test(uri)) throw new OtsFormatError('ots_pending_uri_charset');
    return { kind: 'pending', uri };
  }
  if (tag.equals(BITCOIN_TAG)) return { kind: 'bitcoin', height: inner.varuint() };
  return { kind: 'unknown', tag, payload };
}

function readTimestamp(reader: Reader, msg: Buffer, depth: number): OtsTimestamp {
  if (depth > MAX_DEPTH) throw new OtsFormatError('ots_too_deep');
  const stamp: OtsTimestamp = { msg, attestations: [], ops: [] };
  const handle = (tag: number): void => {
    if (tag === 0x00) {
      stamp.attestations.push(readAttestation(reader));
      return;
    }
    const op = readOp(reader, tag);
    stamp.ops.push({ op, child: readTimestamp(reader, applyOp(op, msg), depth + 1) });
  };
  let tag = reader.byte();
  while (tag === 0xff) {
    handle(reader.byte());
    tag = reader.byte();
  }
  handle(tag);
  return stamp;
}

/** `msg` 에서 시작하는 Timestamp 직렬화를 읽는다. 뒤에 남는 바이트가 있으면 거부한다. */
export function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): OtsTimestamp {
  const reader = new Reader(Buffer.from(bytes));
  const stamp = readTimestamp(reader, Buffer.from(msg), 0);
  if (!reader.done()) throw new OtsFormatError('ots_trailing_bytes');
  return stamp;
}

function writeAttestation(attestation: OtsAttestation): Buffer {
  switch (attestation.kind) {
    case 'pending':
      return Buffer.concat([PENDING_TAG, varbytes(varbytes(Buffer.from(attestation.uri, 'utf8')))]);
    case 'bitcoin':
      return Buffer.concat([BITCOIN_TAG, varbytes(varuint(attestation.height))]);
    case 'unknown':
      return Buffer.concat([attestation.tag, varbytes(attestation.payload)]);
  }
}

function writeOp(op: OtsOp): Buffer {
  switch (op.op) {
    case 'append':
      return Buffer.concat([Uint8Array.of(0xf0), varbytes(op.arg)]);
    case 'prepend':
      return Buffer.concat([Uint8Array.of(0xf1), varbytes(op.arg)]);
    case 'sha256':
      return Buffer.of(0x08);
    case 'sha1':
      return Buffer.of(0x02);
    case 'ripemd160':
      return Buffer.of(0x03);
    case 'reverse':
      return Buffer.of(0xf2);
    case 'hexlify':
      return Buffer.of(0xf3);
  }
}

export function serializeTimestamp(stamp: OtsTimestamp): Buffer {
  const items: Buffer[] = [
    ...stamp.attestations.map((attestation) => Buffer.concat([Uint8Array.of(0x00), writeAttestation(attestation)])),
    ...stamp.ops.map(({ op, child }) => Buffer.concat([writeOp(op), serializeTimestamp(child)])),
  ];
  if (items.length === 0) throw new OtsFormatError('ots_empty_timestamp');
  return Buffer.concat(items.map((item, index) => (index < items.length - 1 ? Buffer.concat([Uint8Array.of(0xff), item]) : item)));
}

function sameOp(a: OtsOp, b: OtsOp): boolean {
  if (a.op !== b.op) return false;
  if ((a.op === 'append' || a.op === 'prepend') && (b.op === 'append' || b.op === 'prepend')) return a.arg.equals(b.arg);
  return true;
}

function sameAttestation(a: OtsAttestation, b: OtsAttestation): boolean {
  if (a.kind === 'pending' && b.kind === 'pending') return a.uri === b.uri;
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height === b.height;
  if (a.kind === 'unknown' && b.kind === 'unknown') return a.tag.equals(b.tag) && a.payload.equals(b.payload);
  return false;
}

/** `other` 를 `target` 에 합친다(같은 msg 여야 한다). 제자리. */
export function mergeTimestamp(target: OtsTimestamp, other: OtsTimestamp): void {
  if (!target.msg.equals(other.msg)) throw new OtsFormatError('ots_merge_msg_mismatch');
  for (const attestation of other.attestations) {
    if (!target.attestations.some((existing) => sameAttestation(existing, attestation))) target.attestations.push(attestation);
  }
  for (const entry of other.ops) {
    const existing = target.ops.find((candidate) => sameOp(candidate.op, entry.op));
    if (existing === undefined) target.ops.push(entry);
    else mergeTimestamp(existing.child, entry.child);
  }
}

export interface FoundAttestation {
  readonly attestation: OtsAttestation;
  /** 증명이 붙은 자리의 메시지(pending 이면 commitment, bitcoin 이면 블록 머클 루트 — 내부 바이트 순서). */
  readonly msg: Buffer;
}

export function attestationsOf(stamp: OtsTimestamp): FoundAttestation[] {
  return [
    ...stamp.attestations.map((attestation) => ({ attestation, msg: stamp.msg })),
    ...stamp.ops.flatMap(({ child }) => attestationsOf(child)),
  ];
}

/** 대기 증명의 commitment 자리를 찾아 업그레이드 조각을 합친다. 합친 곳 수를 돌려준다. */
export function mergeAt(stamp: OtsTimestamp, commitment: Buffer, upgrade: OtsTimestamp): number {
  let merged = 0;
  if (stamp.msg.equals(commitment)) {
    mergeTimestamp(stamp, upgrade);
    merged += 1;
  }
  for (const { child } of stamp.ops) merged += mergeAt(child, commitment, upgrade);
  return merged;
}

export function detachedOts(digest: Uint8Array, stamp: OtsTimestamp): Buffer {
  if (digest.length !== 32 || !stamp.msg.equals(Buffer.from(digest))) throw new OtsFormatError('ots_detached_digest_mismatch');
  return Buffer.concat([OTS_HEADER_MAGIC, Uint8Array.of(OTS_MAJOR_VERSION, 0x08), digest, serializeTimestamp(stamp)]);
}

export function parseDetachedOts(bytes: Uint8Array): { readonly digest: Buffer; readonly stamp: OtsTimestamp } {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, OTS_HEADER_MAGIC.length).equals(OTS_HEADER_MAGIC)) throw new OtsFormatError('ots_bad_magic');
  let offset = OTS_HEADER_MAGIC.length;
  if (buffer[offset] !== OTS_MAJOR_VERSION) throw new OtsFormatError('ots_bad_version');
  offset += 1;
  if (buffer[offset] !== 0x08) throw new OtsFormatError('ots_file_hash_not_sha256');
  offset += 1;
  const digest = buffer.subarray(offset, offset + 32);
  if (digest.length !== 32) throw new OtsFormatError('ots_truncated');
  return { digest: Buffer.from(digest), stamp: parseTimestamp(buffer.subarray(offset + 32), digest) };
}
