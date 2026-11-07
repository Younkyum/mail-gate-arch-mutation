/**
 * ★ AC-13 — **승격 가능성 픽스처 증명 (앵커 미구현)** (계획 §5.0b Layer P2).
 *
 * 명제: 같은 `agentId`·같은 keypair 로 `alsoKnownAs` 에 체인 신원을 추가하는 변경이 **이미 발급된 passport 를 폐기하지 않는다.**
 * "이미 발급된 passport" = 리포에 동결된 `test/fixtures/passport/v1-pre-anchor/`(TEST 키 — 운영 아님). 승격은 `src/passport/promotion.ts`
 * 의 순수 함수(체인·SDK·네트워크 없음). 검증은 외부 라이브러리(`jose`)와 **독립 did:web 리졸버**(DIF `did-resolver` + `web-did-resolver`)로 —
 * 리졸버는 가짜 HTTPS 오리진(전역 `fetch` 대역)에서 승격된 did.json 바이트를 받는다(네트워크 0).
 *
 * 단언 (a)~(h): 실제로 반증 가능한 것은 (c)·(e)·(g)다(계획 r3 정정). (b)는 (c)에 종속된 회귀 가드, (f)는 ADR-0003 B1 의 포맷에서 JWT
 * 검증기가 만료를 표준 동작으로 거부한다는 것, (h)는 승격이 재서명과 직교한다는 것.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resolver, parse as parseDidUrl } from 'did-resolver';
import { compactVerify, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { getResolver as getWebResolver } from 'web-did-resolver';
import { afterEach, describe, expect, it } from 'vitest';

import { toAgentId } from '../../../src/db/schema';
import type { DidDocument } from '../../../src/passport/document';
import { parseCaip10, promote, PromotionWouldBreakContinuity } from '../../../src/passport/promotion';
import { serveOverFakeHttps, type FakeHttps } from './support/fake-https';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'passport', 'v1-pre-anchor');
const read = (...path: string[]): string => readFileSync(join(FIXTURE, ...path), 'utf8');

const ORIGINAL = JSON.parse(read('did.json')) as DidDocument;
const AGENT_ID = toAgentId(ORIGINAL.id.split(':').at(-1) ?? '');
const JWS = { v1: read('passport.jws'), v2: read('v2', 'passport.jws') };
const CHAIN = { chainId: 'eip155:8453', agentId: AGENT_ID } as const;
const DID_URL = `https://id.atmark.ai/agents/${AGENT_ID}/did.json`;

let origin: FakeHttps | undefined;
afterEach(() => {
  origin?.restore();
  origin = undefined;
});

/** 승격된 문서를 **독립 리졸버**로 재해석한다 — 가짜 오리진이 그 바이트를 did:web 경로에 서빙한다. */
async function resolveIndependently(document: DidDocument) {
  origin = serveOverFakeHttps(new Map([[DID_URL, JSON.stringify(document)]]));
  const resolver = new Resolver(getWebResolver());
  const result = await resolver.resolve(ORIGINAL.id);
  expect(result.didResolutionMetadata.error).toBeUndefined();
  expect(origin.requested).toEqual([DID_URL]); // 경로 스킴(ADR-0002 동결)대로 불렀다.
  return result.didDocument;
}

async function verifyWith(document: { verificationMethod?: { id: string; publicKeyJwk?: JWK }[] } | null, jws: string) {
  const { kid } = decodeProtectedHeader(jws);
  const method = document?.verificationMethod?.find((entry) => entry.id === kid);
  if (method?.publicKeyJwk === undefined) throw new Error(`kid ${String(kid)} 가 해석된 문서에 없다`);
  return compactVerify(jws, await importJWK(method.publicKeyJwk, 'EdDSA'));
}

describe('AC-13 — 동결 passport 는 승격 뒤에도 검증된다', () => {
  const promoted = promote(ORIGINAL, CHAIN);

  it('(a) promoted.id === original.id — 기존 URL 참조가 그대로 해석된다', () => {
    expect(promoted.id).toBe(ORIGINAL.id);
  });

  it('(b) [회귀 가드] 동결 passport.jws 가 승격된 문서의 키로 여전히 검증된다(jose)', async () => {
    await expect(verifyWith(promoted as never, JWS.v1)).resolves.toBeDefined();
  });

  it('(c) ★ 구조적 diff 가 정확히 최상위 키 alsoKnownAs 하나의 추가뿐이다', () => {
    const before = ORIGINAL as unknown as Record<string, unknown>;
    const after = promoted as unknown as Record<string, unknown>;
    const added = Object.keys(after).filter((key) => !(key in before));
    const removed = Object.keys(before).filter((key) => !(key in after));
    const changed = Object.keys(before).filter((key) => key in after && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    expect({ added, removed, changed }).toEqual({ added: ['alsoKnownAs'], removed: [], changed: [] });
    // 원본은 바뀌지 않았다(순수 함수).
    expect(JSON.stringify(ORIGINAL)).toBe(JSON.stringify(JSON.parse(read('did.json'))));
  });

  it('(d) alsoKnownAs[0] 은 유효한 CAIP-10 이고 말단(bytes32)이 agentId 와 일치한다', () => {
    const parsed = parseCaip10(promoted.alsoKnownAs?.[0] ?? '');
    expect(parsed).toMatchObject({ namespace: 'eip155', reference: '8453' });
    expect(parsed?.account).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(parsed?.account ?? '0')).toBe(BigInt(`0x${AGENT_ID}`));
  });

  it('(e) ★ 부정: 새 키를 요구하는 승격 · 다른 에이전트의 체인 신원 → PromotionWouldBreakContinuity', () => {
    expect(() => promote(ORIGINAL, { ...CHAIN, publicKeyJwkX: 'A'.repeat(43) })).toThrow(PromotionWouldBreakContinuity);
    expect(() => promote(ORIGINAL, { ...CHAIN, agentId: toAgentId('0123456789abcdef0123456789abcdef') })).toThrow(PromotionWouldBreakContinuity);
    // 같은 키를 요구하는 승격은 받는다 — 거부가 "항상 던짐" 이 아니다.
    const x = ORIGINAL.verificationMethod[0]?.publicKeyJwk?.x ?? '';
    expect(promote(ORIGINAL, { ...CHAIN, publicKeyJwkX: x }).alsoKnownAs).toHaveLength(1);
  });

  it('(f) 만료 — validUntil 이 지나면 JWT 검증기가 표준 동작으로 거부한다(승격과 무관하게 · ADR-0003 B1)', async () => {
    const claims = JSON.parse(read('passport.json')) as { exp: number };
    const jwk = promoted.verificationMethod[0]?.publicKeyJwk as JWK;
    await expect(jwtVerify(JWS.v1, await importJWK(jwk, 'EdDSA'), { currentDate: new Date((claims.exp + 60) * 1000) })).rejects.toMatchObject({
      code: 'ERR_JWT_EXPIRED',
    });
  });

  it('(g) ★ 승격된 문서를 독립 did:web 리졸버로 재해석해도 동결 JWS 의 kid 가 **같은 검증 수단**으로 해석된다', async () => {
    const resolved = await resolveIndependently(promoted);
    const { kid } = decodeProtectedHeader(JWS.v1);
    const parsed = parseDidUrl(kid ?? '');
    expect(parsed?.did).toBe(ORIGINAL.id);
    const before = ORIGINAL.verificationMethod.find((method) => method.id === kid);
    const after = resolved?.verificationMethod?.find((method) => method.id === kid);
    expect(after).toEqual(before);
    expect(resolved?.alsoKnownAs).toEqual(promoted.alsoKnownAs);
    await expect(verifyWith(resolved as never, JWS.v1)).resolves.toBeDefined();
  });

  it('(g) 비공허: id 를 건드린 "승격" 이면 재해석이 깨진다 — 이 단언은 실패할 수 있다', async () => {
    const broken = { ...promoted, id: `${ORIGINAL.id}x` } as DidDocument;
    origin = serveOverFakeHttps(new Map([[DID_URL, JSON.stringify(broken)]]));
    const result = await new Resolver(getWebResolver()).resolve(ORIGINAL.id);
    // web-did-resolver 는 문서 id 가 요청 DID 와 다르면 해석 실패(notFound)를 메타데이터로 알린다 — 규격을 따르는 검증기는 여기서 멈춘다
    //   (위 `resolveIndependently` 가 바로 그 검사를 한다). 즉 id 를 건드린 승격은 (g) 를 빨갛게 만든다.
    expect(result.didResolutionMetadata.error).toBe('notFound');
    // 검증 수단 배열 순서를 바꾼 "승격" 도 (c) 가 잡는다(구조 diff 에 verificationMethod 가 changed 로 나온다).
    const reordered = { ...promoted, verificationMethod: [...promoted.verificationMethod].reverse() };
    expect(JSON.stringify(reordered.verificationMethod)).not.toBe(JSON.stringify(ORIGINAL.verificationMethod));
  });

  it('(h) ★ 버전 2 로 재서명된 passport 도 승격 뒤 검증된다 — 승격은 재서명과 직교한다', async () => {
    const resolved = await resolveIndependently(promoted);
    for (const jws of [JWS.v1, JWS.v2]) {
      const { payload } = await verifyWith(resolved as never, jws);
      expect(JSON.parse(new TextDecoder().decode(payload)) as { sub: string }).toMatchObject({ sub: ORIGINAL.id });
    }
    const versions = [JWS.v1, JWS.v2].map((jws) => (JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString('utf8')) as { version: number }).version);
    expect(versions).toEqual([1, 2]);
  });
});
