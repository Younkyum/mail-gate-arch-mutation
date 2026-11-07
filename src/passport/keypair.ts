/**
 * src/passport/keypair.ts — **`agent_keypairs` 에 쓰는 유일한 코드 경로.**
 *
 * 계획 §4B.1 이 이 파일에 요구하는 것은 하나다:
 *
 *     "키 생성 시점 = 에이전트 프로비저닝 트랜잭션 내부. Agent row 와 Keypair row 가
 *      같은 트랜잭션에서 생성되거나, 둘 다 생성되지 않는다. 키 재생성 경로 없음."
 *
 * 그래서 이 파일에는 **함수가 하나뿐이다.** `rotate`·`reissue`·`regenerate`·
 * `deleteKeypair` 가 없고 앞으로도 없어야 한다 —
 * `test/arch/keypair-immutability.arch.test.ts` 가 그 부재를 단언하고,
 * DB 쪽 대응물은 `202609221600_agent_keypairs_and_passports.sql` 의
 * `agent_keypairs_immutable` / `agent_keypairs_no_delete` 트리거다.
 *
 * **왜 소급 발급 경로가 "있으면 안 되는" 것이 아니라 "존재하지 않아야" 하는가:**
 * 소급 발급 함수가 한 번 존재하면 AC-13 의 전제(재생성 경로 부재)가 **코드로 반증된다.**
 * 그 함수를 아무도 부르지 않는다는 사실은 증거가 아니다 — 다음 사람이 부르면 되기 때문이다.
 */

import { generateKeyPairSync } from 'node:crypto';

import {
  INITIAL_PASSPORT_STATUS,
  type AgentId,
  type AgentKeypairRow,
  type KeypairAlgorithm,
  type PassportRow,
} from '../db/schema';
import { PrivateKeyMaterial, type KeyCustody, type KeyRef } from './custody';
import { ATMARK_CONTROLLER_DID, didForAgent } from './did';

/**
 * 알고리즘. **ed25519 확정** (계획 §3.5) — AWS KMS 가 ed25519 서명을 지원하지 않으므로
 * HSM 비수출성을 포기하고 **AC-11 의 외부 라이브러리 호환성**을 얻은 선택이다.
 * DID/VC 생태계에서 `EdDSA`/`Ed25519VerificationKey2020` 이 가장 널리 구현돼 있고,
 * AC-11 의 증거 능력이 거기 달려 있다.
 */
const KEYPAIR_ALGORITHM: KeypairAlgorithm = 'ed25519';

/** PP-A 가 만드는 최초 passport 버전. 재서명은 새 **행**이다(§4B.1b). */
export const INITIAL_PASSPORT_VERSION = 1;

export interface InsertAgentKeypairInput {
  readonly agentId: AgentId;
  /** ed25519 공개키 원시 32바이트의 base64url = JWK 의 `x`. */
  readonly publicKey: string;
  readonly algorithm: KeypairAlgorithm;
  /** **참조만.** 이 인터페이스에 개인키·암호문 필드가 없는 것이 요점이다 (§3.5 AC-e1). */
  readonly keyRef: KeyRef;
}

export interface InsertPassportInput {
  readonly agentId: AgentId;
  readonly did: string;
  readonly controller: string;
  readonly version: number;
}

/**
 * 프로비저닝 트랜잭션이 PP-A 를 위해 제공해야 하는 연산.
 *
 * `ProvisioningTransaction` 이 이 인터페이스를 확장한다 — 즉 **트랜잭션 핸들 없이
 * keypair 를 만드는 타입이 존재하지 않는다.** 원자성을 규율이 아니라 타입으로 둔다.
 * `update*`/`delete*` 가 없는 것도 같은 이유다.
 */
export interface KeypairIssueTransaction {
  insertAgentKeypair(input: InsertAgentKeypairInput): Promise<AgentKeypairRow>;
  insertPassport(input: InsertPassportInput): Promise<PassportRow>;
}

/** 발급 결과. **개인키는 여기 없다** — `store()` 이후 메모리에서 지워졌다. */
export interface IssuedAgentIdentity {
  readonly keypair: AgentKeypairRow;
  /** `status = 'draft'`. **B5: 이 행의 `did` 는 외부 표면으로 나가지 않는다.** */
  readonly passport: PassportRow;
}

/**
 * ★ **프로비저닝 트랜잭션 안에서 keypair 와 draft passport 를 만든다.**
 * `agent_keypairs` 에 쓰는 경로는 이 함수 하나뿐이다.
 *
 * 순서가 설계다:
 *   1. ed25519 생성 — 평문 개인키는 `PrivateKeyMaterial` 안에만 존재한다.
 *   2. custody 보관 → `key_ref`. **DB INSERT 보다 먼저다.** 반대 순서면 "참조는
 *      커밋됐는데 그 자리에 아무것도 없는" 행이 생기고, 그 행은 영원히 서명 불가인 데다
 *      불변 트리거 때문에 고칠 수도 없다. 이 순서의 실패 모드는 **아무도 참조하지 않는
 *      고아 비밀 하나**이고, 그쪽이 압도적으로 싸다.
 *   3. 평문 개인키 즉시 소거.
 *   4. `agent_keypairs` INSERT → `passports` INSERT (draft).
 *
 * **`agentId` 를 받기만 하고 만들지 않는다.** 생성은 `src/identity/provisioning.ts` 가
 * 트랜잭션 안에서 하고, 그 값이 곧 `agents.id` 다(§4B.1 — 별도 내부 PK 없음).
 */
export async function issueAtProvisioning(
  tx: KeypairIssueTransaction,
  custody: KeyCustody,
  agentId: AgentId,
): Promise<IssuedAgentIdentity> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  // JWK 로 뽑는 이유: OKP/Ed25519 의 `x` 가 **원시 32바이트의 base64url** 이고, 그것이
  // 그대로 DB 컬럼 값이자 PP-B 의 `publicKeyJwk.x` 다. DER/PEM 을 거치면 두 소비처가
  // 모두 파싱 단계를 지나게 되고, 파싱은 실패할 수 있는 단계다.
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') {
    throw new Error('ed25519 공개키 JWK 에 x 가 없다 — Node 의 키 export 규약이 바뀌었다.');
  }

  // export 가 준 Buffer 를 **복사하지 않고** 감싼다 — 복사하면 원본 DER 이 지워지지 않은 채 힙에 남는다.
  // 지우기는 최선 노력이다: `generateKeyPairSync` 의 KeyObject 안 사본은 GC 가 거둘 때까지 산다.
  const exported = privateKey.export({ format: 'der', type: 'pkcs8' });
  const material = new PrivateKeyMaterial(new Uint8Array(exported.buffer, exported.byteOffset, exported.byteLength));

  let keyRef: KeyRef;
  try {
    keyRef = await custody.store(agentId, material);
  } finally {
    // 성공·실패 어느 쪽이든 지운다. 예외 경로에서 평문 키가 힙에 남으면 그 힙이 덤프다.
    material.wipe();
  }

  const keypair = await tx.insertAgentKeypair({
    agentId,
    publicKey: jwk.x,
    algorithm: KEYPAIR_ALGORITHM,
    keyRef,
  });

  const passport = await tx.insertPassport({
    agentId,
    // 문자열 조립은 `did.ts` 하나가 한다. DB 의 `passports.did` CHECK 가 같은 규칙으로
    // 다시 대조하므로, 조립이 틀리면 INSERT 가 죽는다(이중화).
    did: didForAgent(agentId),
    controller: ATMARK_CONTROLLER_DID,
    version: INITIAL_PASSPORT_VERSION,
  });

  // `status` 를 넘기지 않는다 — 컬럼 기본값이 `'draft'` 이고 그 근거는 마이그레이션
  // 주석에 있다. 여기서 값을 지정하면 근거가 둘이 된다.
  if (passport.status !== INITIAL_PASSPORT_STATUS) {
    throw new Error(
      `PP-A 는 draft 만 만든다 (§4B.2). 받은 값: ${passport.status} — passports.status 기본값이 바뀌었다.`,
    );
  }

  return { keypair, passport };
}
