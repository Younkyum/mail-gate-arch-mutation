/**
 * src/tlog/signing.ts — 서명 **포트**(타입과 오류)만. KMS 를 부르는 구현은 `checkpoint-signer.ts` 하나다(A-T4 arch).
 *
 * 서열기·에폭·앵커 워커는 서명기를 **받아서 부를 뿐**이다. 테스트는 이 포트에 로컬 Ed25519/P-256 키로 만든 가짜를 넣는다
 * (`src/**` 에는 로컬 서명 구현이 없다 — 개인키를 만지는 파일을 늘리지 않는다, ADR-0003 F11 과 같은 규율).
 */

/** 체크포인트 서명기 — Ed25519(`ECC_NIST_EDWARDS25519` / `ED25519_SHA_512` · `MessageType: RAW`). */
export interface NoteSigner {
  /** signed note 의 키 이름 = 로그 origin. */
  readonly keyName: string;
  /** 원시 Ed25519 공개키 32바이트. */
  publicKey(): Promise<Buffer>;
  /** note text 전체(≤ 4096바이트 — KMS RAW 한도)에 대한 Ed25519 서명 64바이트. */
  sign(message: Uint8Array): Promise<Buffer>;
}

/**
 * 앵커 서명기 — Rekor v2 `hashedrekord` 전용 ECDSA P-256(`ECC_NIST_P256` / `ECDSA_SHA_256` · `MessageType: DIGEST`).
 * 왜 로그 키(Ed25519)가 아닌가: `hashedrekord` 는 다이제스트만 올리므로 순수 Ed25519 는 검증될 수 없고(원문이 필요하다),
 * Ed25519ph 는 KMS 가 DIGEST 입력을 한 번 더 해시한다(AWS 문서 — "the input is hashed twice") — 두 쪽 구현이 같은 바이트를 서명하는지
 * 확인할 수 없다. ADR-0008 F25 의 대안(P-256 앵커 전용 키)을 쓴다. Rekor 문서가 예로 든 키 종류가 이것이다(2026-09-24 확인).
 */
export interface AnchorSigner {
  /** SubjectPublicKeyInfo DER. */
  publicKeySpki(): Promise<Buffer>;
  /** SHA-256 다이제스트(32바이트)에 대한 ECDSA 서명(DER). */
  signDigest(digest: Uint8Array): Promise<Buffer>;
}

/** 서명 실패 — 메시지는 단계 코드뿐(키 자료·응답 본문을 싣지 않는다). */
export class TlogSigningError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TlogSigningError';
    this.code = code;
  }
}
