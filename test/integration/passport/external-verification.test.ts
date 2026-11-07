/**
 * ★ AC-11 — **외부 라이브러리 검증 (자기 검증기 금지)** (계획 §5.0b Layer P1).
 *
 * **이 파일은 `src/**` 를 import 하지 않는다**(`test/arch/passport-public-surface.arch.test.ts` ⑤가 강제). 입력은 **바이트뿐**이다 —
 * 리포에 동결된 픽스처(`test/fixtures/passport/v1-pre-anchor/` — "이미 세상에 나가 있는 passport")의 did.json · passport.json · passport.jws.
 * 검증기는 둘이고 작성자·구현이 서로 다르다:
 *   - **A — `jose`(panva)**: did.json 에서 `kid` 의 JWK 를 꺼내 `importJWK` → `compactVerify`(서명) → `jwtVerify`(발급자·주체·**만료**).
 *   - **B — `@noble/ed25519`**: `publicKeyMultibase`(`@scure/base` base58 로 디코드, multicodec 0xed01 확인)로 원시 서명 검증.
 * 부정 테스트 3종(페이로드 1바이트 · 서명 1바이트 · 다른 에이전트의 키)을 **A·B 둘 다** 거부해야 한다 — 없으면 "항상 true" 인 공허한
 * 통과를 잡지 못한다. 그리고 `content_hash` 규칙(JCS + SHA-256)을 외부 JCS 구현(`canonicalize`)으로 다시 계산한다.
 *
 * (f) 만료: ADR-0003 B1 에서 `passport.jws` 의 페이로드가 JWT 등록 클레임(`exp`)을 싣게 됐다 — 그래서 **JWT 검증기(A)** 가 표준 동작으로 만료를
 * 거부한다. 원시 서명 검증기(B)는 정의상 시각을 보지 않는다(서명은 여전히 유효하다) — 그것을 숨기지 않고 여기 단언으로 적는다.
 * 비-JS 검증기(pyca/cryptography)는 thin slice 로 미뤘다(계획 §6 P6 "Thin slice", ADR-0003 Follow-ups).
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ed from '@noble/ed25519';
import { base58 } from '@scure/base';
import canonicalize from 'canonicalize';
import { compactVerify, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'passport', 'v1-pre-anchor');
const read = (...path: string[]): string => readFileSync(join(FIXTURE, ...path), 'utf8');

interface DidDocumentBytes {
  readonly id: string;
  readonly verificationMethod: readonly { readonly id: string; readonly publicKeyJwk?: JWK; readonly publicKeyMultibase?: string }[];
}

const didDocument = JSON.parse(read('did.json')) as DidDocumentBytes;
const keypairInfo = JSON.parse(read('TEST-KEYPAIR-NOT-PRODUCTION.json')) as { contentHash: { v1: string; v2: string } };

const VERSIONS = [
  { label: 'v1', json: read('passport.json'), jws: read('passport.jws'), hash: keypairInfo.contentHash.v1 },
  { label: 'v2 (재서명)', json: read('v2', 'passport.json'), jws: read('v2', 'passport.jws'), hash: keypairInfo.contentHash.v2 },
];

/** 발효 이후·만료 이전의 한 시각(초). 동결 픽스처라 "지금" 을 쓰면 날짜가 지나 빨개진다 — 문서가 말하는 창 안의 시각을 쓴다. */
function insideValidity(json: string): Date {
  const claims = JSON.parse(json) as { nbf: number; exp: number };
  return new Date((claims.nbf + 3600) * 1000);
}

async function verifierA(jws: string, jwk: JWK): Promise<Uint8Array> {
  const key = await importJWK(jwk, 'EdDSA');
  return (await compactVerify(jws, key)).payload;
}

function multibaseKey(multibase: string): Uint8Array {
  expect(multibase.startsWith('z')).toBe(true);
  const decoded = base58.decode(multibase.slice(1));
  expect([...decoded.slice(0, 2)]).toEqual([0xed, 0x01]);
  return decoded.slice(2);
}

async function verifierB(jws: string, publicKey: Uint8Array): Promise<boolean> {
  const [header, payload, signature] = jws.split('.');
  return ed.verifyAsync(Buffer.from(signature ?? '', 'base64url'), Buffer.from(`${header ?? ''}.${payload ?? ''}`, 'ascii'), publicKey);
}

function methodOf(kid: string) {
  const method = didDocument.verificationMethod.find((entry) => entry.id === kid);
  if (method === undefined) throw new Error(`kid ${kid} 가 did.json 에 없다`);
  return method;
}

function jwkOfHeader(jws: string): JWK {
  const { kid } = decodeProtectedHeader(jws);
  const jwk = methodOf(kid ?? '').publicKeyJwk;
  if (jwk === undefined) throw new Error('kid 가 JWK 검증 수단이 아니다');
  return jwk;
}

function multibaseMethod(): Uint8Array {
  const method = didDocument.verificationMethod.find((entry) => entry.publicKeyMultibase !== undefined);
  return multibaseKey(method?.publicKeyMultibase ?? '');
}

/** 세 부분 중 하나의 1바이트를 바꾼다(디코드 → XOR → 재인코드). */
function tamper(jws: string, part: 1 | 2): string {
  const parts = jws.split('.');
  const bytes = Buffer.from(parts[part] ?? '', 'base64url');
  bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe.each(VERSIONS)('AC-11 — 동결 passport $label 을 외부 라이브러리 둘이 독립적으로 검증한다', ({ json, jws, hash }) => {
  it('A(jose): kid → did.json 의 JWK → 서명 검증 · 페이로드 = passport.json 바이트 그대로', async () => {
    const payload = await verifierA(jws, jwkOfHeader(jws));
    expect(Buffer.from(payload).toString('utf8')).toBe(json);
    expect(decodeProtectedHeader(jws)).toEqual({ alg: 'EdDSA', kid: `${didDocument.id}#key-1`, typ: 'JWT' });
  });

  it('A(jose JWT): 발급자 = Atmark 조직 DID · 주체 = 이 DID · 유효 창 안에서 통과', async () => {
    const key = await importJWK(jwkOfHeader(jws), 'EdDSA');
    const { payload } = await jwtVerify(jws, key, { issuer: 'did:web:id.atmark.ai', subject: didDocument.id, currentDate: insideValidity(json) });
    expect(payload['status']).toBe('published');
  });

  it('B(@noble/ed25519): publicKeyMultibase 로 원시 서명 검증 — A 와 같은 키다', async () => {
    const key = multibaseMethod();
    expect(Buffer.from(key).toString('base64url')).toBe(jwkOfHeader(jws).x);
    expect(await verifierB(jws, key)).toBe(true);
  });

  it('content_hash = SHA-256(외부 JCS(passport.json)) — 서명 대상 바이트가 곧 해시 대상 바이트', () => {
    expect(canonicalize(JSON.parse(json))).toBe(json);
    expect(createHash('sha256').update(json, 'utf8').digest('hex')).toBe(hash);
  });

  it('부정 ① 페이로드 1바이트 변조 — A·B 모두 거부', async () => {
    const bad = tamper(jws, 1);
    await expect(verifierA(bad, jwkOfHeader(jws))).rejects.toThrow();
    expect(await verifierB(bad, multibaseMethod())).toBe(false);
  });

  it('부정 ② 서명 1바이트 변조 — A·B 모두 거부', async () => {
    const bad = tamper(jws, 2);
    await expect(verifierA(bad, jwkOfHeader(jws))).rejects.toThrow();
    expect(await verifierB(bad, multibaseMethod())).toBe(false);
  });

  it('부정 ③ 다른 에이전트의 키 — A·B 모두 거부', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as JWK;
    await expect(verifierA(jws, other)).rejects.toThrow();
    expect(await verifierB(jws, Buffer.from(other.x ?? '', 'base64url'))).toBe(false);
  });

  it('(f) 만료 — validUntil 이 지나면 JWT 검증기(A)가 **표준 동작으로** 거부한다 · 원시 서명(B)은 시각을 보지 않는다', async () => {
    const key = await importJWK(jwkOfHeader(jws), 'EdDSA');
    const claims = JSON.parse(json) as { exp: number; validUntil: string };
    expect(Date.parse(claims.validUntil) / 1000).toBe(claims.exp);
    await expect(jwtVerify(jws, key, { currentDate: new Date((claims.exp + 1) * 1000) })).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    expect(await verifierB(jws, multibaseMethod())).toBe(true);
  });
});
