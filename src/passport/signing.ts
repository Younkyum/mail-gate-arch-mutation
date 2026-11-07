/**
 * src/passport/signing.ts — 서명 **포트**(타입과 오류)만. 구현(개인키 복호·서명)은 `signer.ts` 하나다.
 *
 * 왜 따로 두는가: `signer.ts` 를 import 할 수 있는 곳은 서명 Lambda 의 조립 루트 하나다(`.dependency-cruiser.cjs`
 * `passport-signer-only-from-signer-composition`). 게시 워커(`publisher.ts`)는 서명기를 **받아서 부를 뿐**이므로 이 파일의 타입만 안다 —
 * 그러면 복호 코드를 품은 모듈의 import 그래프가 조립 루트 하나로 닫힌다.
 */

import type { AgentId } from '../db/schema';

/** 서명 실패. **메시지는 단계 코드뿐이다**(outbox `last_error` 에 그대로 들어간다 — `^[a-z0-9_:.-]+$`). */
export class PassportSigningError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'PassportSigningError';
    this.code = code;
  }
}

export interface SignRequest {
  readonly agentId: AgentId;
  /** `agent_keypairs.key_ref`. */
  readonly keyRef: string;
  /** `agent_keypairs.public_key` — 복호한 키가 이 공개키의 짝이어야 서명한다. */
  readonly expectedPublicKey: string;
  /** JWS 보호 헤더(객체). `alg` 는 `EdDSA` 여야 한다. */
  readonly header: Readonly<Record<string, string>>;
  /** 페이로드 문자열(= passport.json 의 JCS). UTF-8 로 서명된다. */
  readonly payload: string;
}

export interface PassportSigner {
  readonly kind: 'aws' | 'local-dev';
  /** JWS compact(`base64url(header).base64url(payload).base64url(signature)`). **밖으로 나가는 것은 이것뿐이다.** */
  signCompact(request: SignRequest): Promise<string>;
}
