/**
 * src/passport/document.ts — `did.json`(W3C DID Core 1.0) · `passport.json`(클레임 문서) 조립. **순수 함수만** — 키도 DB 도 없다.
 *
 * ## 서명 포맷 (ADR-0003 B1 — 결정)
 *
 * `passport.jws` = **JWS compact, `alg: EdDSA`, `kid` = `did.json` 의 `#key-1`**. 페이로드는 `passport.json` 의 **JCS 바이트 그 자체**다.
 * 그리고 `passport.json` 은 **JWT 등록 클레임**(`iss`·`sub`·`iat`·`nbf`·`exp`·`jti`)을 최상위에 싣는다. 그래서 같은 바이트가
 *   - `jose` `compactVerify` 로는 "Atmark 키로 서명된 바이트" 로,
 *   - `jose` `jwtVerify`(및 어느 JWT 라이브러리든)로는 **만료·발효 시각을 표준 동작으로 검사하는 JWT** 로 읽힌다.
 * 계획 §4B.1b r4 가 삭제한 문장("만료된 passport 는 외부 검증기가 표준 동작으로 거부한다")이 이 포맷에서 **참이 된다** — 우리가 하네스에
 * 만료 검사를 넣어서가 아니라 `exp` 가 등록 클레임이기 때문이다(AC-13 (f)). VC-JWT(1.1 의 `vc` 래퍼)를 고르지 않은 이유와 VC 2.0 필드
 * (`validFrom`·`validUntil`·`credentialSubject`·`credentialStatus`)를 **나란히** 두는 이유는 ADR-0003 에 있다.
 *
 * **해시 대상 = 서명 대상**(§4B.1b 재정의 한 줄): `content_hash = SHA-256(JCS(passport.json))` 이고 JWS 페이로드도 그 JCS 바이트다.
 * DB 가 INSERT 시점에 대조한다(`202609241200` `passport_documents_match_passport`).
 *
 * ## 경로 (ADR-0002 동결)
 * `https://id.atmark.ai/agents/{agentId}/{did.json|passport.json|passport.jws}` — 호스트·세그먼트는 `did.ts` 상수에서만 온다.
 */

import type { AgentId } from '../db/schema';
import type { Attestation } from './attestations';
import { ATMARK_CONTROLLER_DID, DID_PATH_SEGMENT, IDENTITY_HOST } from './did';

/** 문서 파일 이름 — S3 키와 URL 의 말단. **동결**(발급된 문서가 서로를 이 이름으로 가리킨다). */
const IDENTITY_FILES = ['did.json', 'passport.json', 'passport.jws'] as const;
export type IdentityFile = (typeof IDENTITY_FILES)[number];

/** 파일별 Content-Type. `did.json` 은 DID Core 의 미디어 타입, JWS compact 는 `application/jose`(RFC 7515 §9.2.1). */
export const IDENTITY_CONTENT_TYPES: Readonly<Record<IdentityFile, string>> = {
  'did.json': 'application/did+json',
  'passport.json': 'application/json',
  'passport.jws': 'application/jose',
};

/** 버킷 키(`agents/{agentId}/{file}`). URL 경로와 같다 — CloudFront 오리진이 버킷 루트다. */
export function identityObjectKey(agentId: AgentId, file: IdentityFile): string {
  return `${DID_PATH_SEGMENT}/${agentId}/${file}`;
}

export function identityFileUrl(agentId: AgentId, file: IdentityFile): string {
  return `https://${IDENTITY_HOST}/${identityObjectKey(agentId, file)}`;
}

/** 이 에이전트의 문서 셋이 사는 URL 경로 접두사 — CloudFront 무효화 대상. */
export function identityInvalidationPath(agentId: AgentId): string {
  return `/${DID_PATH_SEGMENT}/${agentId}/*`;
}

/** JWS `kid` 가 가리키는 검증 수단(JWK). 승격(AC-13)이 이 id 를 보존해야 한다 — `promotion.ts`. */
const JWK_KEY_FRAGMENT = '#key-1';
/** 같은 공개키의 multibase 표현(Ed25519VerificationKey2020). 라이브러리 호환 폭을 넓히려고 병기한다(§4B.2). */
const MULTIBASE_KEY_FRAGMENT = '#key-2';

/** passport 유효 기간 — 발급 + 90일(ADR-0003 Consequences, §4B.1b). 재서명 워커가 만료 30일 전에 새 버전을 낸다. */
export const PASSPORT_VALIDITY_DAYS = 90;

// ---------------------------------------------------------------------------
// 키 표현
// ---------------------------------------------------------------------------

export interface Ed25519PublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
}

/** `agent_keypairs.public_key`(원시 32바이트 base64url = JWK `x`) → JWK. 변환이 없다(202609221600 주석). */
export function publicJwkOf(publicKey: string): Ed25519PublicJwk {
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) throw new Error('ed25519 공개키는 base64url 43자다.');
  return { kty: 'OKP', crv: 'Ed25519', x: publicKey };
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc(비트코인 알파벳). 앞의 0 바이트는 '1' 로. */
function base58btc(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET.charAt(Number(value % 58n)) + out;
    value /= 58n;
  }
  return '1'.repeat(leadingZeros) + out;
}

/**
 * `publicKeyMultibase` — `z` + base58btc(multicodec `ed25519-pub` 0xed01 + 원시 32바이트). did:key·Ed25519VerificationKey2020 와 같은
 * 표기라 `z6Mk…` 로 시작한다.
 */
export function publicKeyMultibaseOf(publicKey: string): string {
  const raw = Buffer.from(publicJwkOf(publicKey).x, 'base64url');
  if (raw.length !== 32) throw new Error('ed25519 공개키는 32바이트다.');
  return `z${base58btc(Uint8Array.from([0xed, 0x01, ...raw]))}`;
}

// ---------------------------------------------------------------------------
// did.json
// ---------------------------------------------------------------------------

export interface VerificationMethod {
  readonly id: string;
  readonly type: 'JsonWebKey2020' | 'Ed25519VerificationKey2020';
  readonly controller: string;
  readonly publicKeyJwk?: Ed25519PublicJwk;
  readonly publicKeyMultibase?: string;
}

export interface DidDocument {
  readonly '@context': readonly string[];
  readonly id: string;
  readonly controller: string;
  readonly alsoKnownAs?: readonly string[];
  readonly verificationMethod: readonly VerificationMethod[];
  readonly authentication: readonly string[];
  readonly assertionMethod: readonly string[];
  readonly service: readonly DidService[];
}

export interface DidService {
  readonly id: string;
  readonly type: string;
  readonly serviceEndpoint: string;
}

/** 폐기된 DID 의 문서 — 검증 수단·검증 관계가 **없다**(`buildRevokedDidDocument`). */
export interface RevokedDidDocument {
  readonly '@context': readonly string[];
  readonly id: string;
  readonly controller: string;
  readonly service: readonly DidService[];
}

const DID_CONTEXTS = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/jws-2020/v1',
  'https://w3id.org/security/suites/ed25519-2020/v1',
] as const;

/**
 * DID 문서. **결정적**이다(버전과 무관) — 같은 에이전트는 언제나 같은 `did.json` 을 받는다. 키가 불변이므로(§4B.1) 이 문서가
 * 바뀔 이유는 승격(`alsoKnownAs` 추가, AC-13) · controller 이양(Phase 2) · **폐기**(`buildRevokedDidDocument`)뿐이다.
 *
 * DID Core 는 검증 수단 하나에 검증 재료 속성을 둘 이상 두지 못하게 한다 — 그래서 같은 키를 JWK(#key-1)·multibase(#key-2) 두 수단으로
 * 싣는다. JWS 의 `kid` 는 #key-1 이다.
 */
export function buildDidDocument(input: { readonly did: string; readonly agentId: AgentId; readonly publicKey: string }): DidDocument {
  const jwkId = `${input.did}${JWK_KEY_FRAGMENT}`;
  const multibaseId = `${input.did}${MULTIBASE_KEY_FRAGMENT}`;
  return {
    '@context': [...DID_CONTEXTS],
    id: input.did,
    controller: ATMARK_CONTROLLER_DID,
    verificationMethod: [
      { id: jwkId, type: 'JsonWebKey2020', controller: input.did, publicKeyJwk: publicJwkOf(input.publicKey) },
      {
        id: multibaseId,
        type: 'Ed25519VerificationKey2020',
        controller: input.did,
        publicKeyMultibase: publicKeyMultibaseOf(input.publicKey),
      },
    ],
    authentication: [jwkId, multibaseId],
    assertionMethod: [jwkId, multibaseId],
    service: passportServiceOf(input.did, input.agentId),
  };
}

function passportServiceOf(did: string, agentId: AgentId): readonly DidService[] {
  return [{ id: `${did}#passport`, type: 'AtmarkAgentPassport', serviceEndpoint: identityFileUrl(agentId, 'passport.json') }];
}

/**
 * ★ **폐기된 DID 의 문서 — 검증 수단을 내린다** (ADR-0003 "폐기의 효력").
 *
 * 폐기는 키 침해 의심 때의 종단 조치다. 폐기 버전의 `exp` 가 "지금" 이어도 그것은 **그 버전 하나**만 만료시킨다 — 이전에 발급된
 * `published` JWS 는 제 `exp`(최대 90일)까지 서명이 유효하고, 침해된 키는 새 JWS 를 얼마든지 만들 수 있다. did:web 에서 그 서명들을
 * 한꺼번에 무효로 만드는 길은 **해석 결과에서 키를 빼는 것**이다: `verificationMethod`·`authentication`·`assertionMethod` 가 없는
 * 문서로는 `kid`(#key-1)를 해석할 수 없으므로, did.json 을 거쳐 키를 얻는 검증기는 어떤 JWS 도 통과시키지 못한다.
 *
 * 문서 자체는 **지우지 않는다**(§4B.1b — 삭제는 "존재한 적 없다" 로 읽힌다). `id`·`controller`·`service`(폐기된 passport.json 을
 * 가리킨다)가 남아 "이 DID 는 있었고 폐기됐다" 를 말한다. DID Core 1.0 에서 검증 수단이 없는 문서도 적합하다(필수 속성은 `id` 뿐).
 * 정지(suspended)는 되돌릴 수 있는 상태라 키를 **그대로 둔다** — 대신 검증기는 상태를 반드시 확인해야 한다(ADR-0003 "검증 규칙").
 */
export function buildRevokedDidDocument(input: { readonly did: string; readonly agentId: AgentId }): RevokedDidDocument {
  return { '@context': [...DID_CONTEXTS], id: input.did, controller: ATMARK_CONTROLLER_DID, service: passportServiceOf(input.did, input.agentId) };
}

// ---------------------------------------------------------------------------
// passport.json
// ---------------------------------------------------------------------------

/** 문서에 서명되는 passport 상태(draft 는 서명되지 않는다). */
export type SignedPassportStatus = 'published' | 'suspended' | 'revoked';

export interface PassportSubject {
  readonly id: string;
  readonly type: 'AtmarkAgent';
  readonly name: string;
  /**
   * **유효 대표 주소**(ADR-0014 2026-10 개정 · F-7 — 고객 도메인을 대표로 골랐으면 그 주소, 잠든 앵커는 싣지 않는다). 대표가 무효면(도메인을 잃었다 —
   * "주소 없음") `null` 이다 — 칸은 빠지지 않는다(문서 모양이 상태마다 같게 · attestation 순서도 그대로).
   */
  readonly address: string | null;
  /** 월 단위 절사(`YYYY-MM`) — 정확한 시각은 핑거프린팅 벡터(§4B.3). */
  readonly createdMonth: string;
  readonly attestations: readonly Attestation[];
}

/**
 * passport.json 의 모양. **JWT 등록 클레임 + VC 2.0 에 그대로 옮겨 담을 필드**(ADR-0003 B1 · F12).
 * `credentialSubject` 는 VC 2.0 `credentialSubject` 에 **그대로** 들어가는 모양이다(§3.6 "비용 0 의 미래 대비").
 */
export interface PassportDocument {
  readonly type: 'AtmarkAgentPassport';
  readonly iss: string;
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly version: number;
  readonly status: SignedPassportStatus;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validUntil: string;
  /**
   * 상태 슬롯(§4B.1b 긴장 1). Phase 1 의 "상태 목록" 은 **이 에이전트의 현재 passport.json** 이다 — 같은 URL 이 언제나 최신 버전을
   * 서빙하고, 그 문서의 `status` 가 정지·폐기를 말한다. 상태 목록 인프라 없이 제3자가 우리 API 를 부르지 않고 상태를 읽는 길.
   */
  readonly credentialStatus: { readonly type: 'AtmarkCurrentPassport'; readonly statusListUrl: string };
  readonly credentialSubject: PassportSubject;
}

export interface PassportDocumentInput {
  readonly agentId: AgentId;
  readonly did: string;
  /** `passports.id` — `jti`(버전 행마다 다르다). */
  readonly passportId: string;
  readonly version: number;
  readonly status: SignedPassportStatus;
  readonly issuedAt: Date;
  readonly name: string;
  readonly address: string | null;
  readonly agentCreatedAt: Date;
  readonly attestations: readonly Attestation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 초 단위로 내린 시각(JWT NumericDate 는 초). 문서의 ISO 시각도 같은 초에서 만든다 — 두 표기가 1초도 어긋나지 않게. */
export function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function isoOfSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * `revoked` 버전은 **지금 만료된다**(validUntil = 폐기 시각) — `jwtVerify` 가 **그 폐기 버전 JWS 를** 표준 동작으로 거부한다(§4B.1b status 표).
 * 이것만으로는 이전 버전의 JWS 가 무효가 되지 않는다 — 그 일은 did.json 에서 키를 내리는 것이 한다(`buildRevokedDidDocument`).
 */
function validityOf(status: SignedPassportStatus, issuedAt: Date): { readonly nbf: number; readonly exp: number } {
  const nbf = secondsOf(issuedAt);
  return { nbf, exp: status === 'revoked' ? nbf : nbf + PASSPORT_VALIDITY_DAYS * (DAY_MS / 1000) };
}

function createdMonthOf(createdAt: Date): string {
  return createdAt.toISOString().slice(0, 7);
}

export function buildPassportDocument(input: PassportDocumentInput): PassportDocument {
  const { nbf, exp } = validityOf(input.status, input.issuedAt);
  return {
    type: 'AtmarkAgentPassport',
    iss: ATMARK_CONTROLLER_DID,
    sub: input.did,
    jti: `urn:uuid:${input.passportId}`,
    iat: nbf,
    nbf,
    exp,
    version: input.version,
    status: input.status,
    issuer: ATMARK_CONTROLLER_DID,
    validFrom: isoOfSeconds(nbf),
    validUntil: isoOfSeconds(exp),
    credentialStatus: { type: 'AtmarkCurrentPassport', statusListUrl: identityFileUrl(input.agentId, 'passport.json') },
    credentialSubject: {
      id: input.did,
      type: 'AtmarkAgent',
      name: input.name,
      address: input.address,
      createdMonth: createdMonthOf(input.agentCreatedAt),
      attestations: input.attestations,
    },
  };
}

/**
 * 재서명 판정용 — 시각·버전·jti 를 뺀 **내용**. 두 문서의 이 값이 같으면(그리고 만료가 멀면) 새 버전을 낼 이유가 없다.
 */
export function substanceOf(document: Pick<PassportDocument, 'status' | 'credentialSubject'>): unknown {
  return { status: document.status, credentialSubject: document.credentialSubject };
}

/** JWS 보호 헤더. `typ: 'JWT'` — 페이로드가 JWT 클레임 집합이다(RFC 7519 §5.1). */
export function jwsHeaderFor(did: string): { readonly alg: 'EdDSA'; readonly kid: string; readonly typ: 'JWT' } {
  return { alg: 'EdDSA', kid: `${did}${JWK_KEY_FRAGMENT}`, typ: 'JWT' };
}

