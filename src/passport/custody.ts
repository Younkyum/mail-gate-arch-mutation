/**
 * src/passport/custody.ts — 키 보관 **포트**. 구현은 둘이다 (`custody-aws.ts` 운영, `custody-local.ts` 개발·테스트).
 *
 * 계획 §3.5: 개인키는 생성 직후 KMS CMK 로 envelope 암호화해 Secrets Manager 에 보관하고 `agent_keypairs.key_ref` 에는
 * 참조만 담는다. **로컬 구현이 운영에서 선택되는 경로는 코드로 막는다.**
 *
 * **조용히 평문 보관으로 떨어지는 것이 여기서 유일하게 용납되지 않는 실패다.**
 * 그런 폴백은 사고가 난 뒤에야 드러나고, 그때는 이미 모든 에이전트의 개인키가
 * 평문으로 디스크에 있다. 그래서 `assertNotProduction()` 은 **경고가 아니라 예외**다.
 *
 * ---
 *
 * **개인키가 DB 에 들어가는 경로가 0개** 라는 명제를 이 파일이 타입으로 지탱한다:
 *   - 평문 개인키는 `PrivateKeyMaterial` 안에만 존재한다. 그 클래스는 `toJSON`/
 *     `toString` 이 전부 `'[redacted]'` 라 **구조화 로그·에러 직렬화에 실려도 새지 않는다**.
 *   - `KeyCustody.store` 의 **반환 타입은 `KeyRef`(문자열)** 이고, DB 에 들어가는 것은
 *     그 값뿐이다. `AgentKeypairRow` 에 개인키 필드가 없는 것이 그 대응물이다.
 *   - arch 테스트(`test/arch/keypair-immutability.arch.test.ts`)가 `PrivateKeyMaterial`
 *     의 참조 집합이 `src/passport/**` 를 벗어나지 않음을 단언한다.
 */

import type { AgentId } from '../db/schema';

/**
 * `agent_keypairs.key_ref` 에 저장되는 값. `<scheme>://<locator>` 형식이고
 * 마이그레이션의 CHECK 가 스킴을 닫는다.
 *
 * 브랜디드 타입인 이유: 이 프로젝트에는 문자열 식별자가 많고, 그중 **암호문이 아니라
 * 참조여야 하는 것**은 이것 하나다. `string` 이면 누군가 암호문을 그대로 넣어도
 * 컴파일이 통과한다("참조 대신 값을 넣으면 편하다"는 유혹은 실재한다).
 */
export type KeyRef = string & { readonly __brand: 'KeyRef' };

/** 허용 스킴. 마이그레이션의 `key_ref` CHECK 와 **같은 집합이어야 한다.** */
export const KEY_REF_SCHEMES = ['awssm', 'devfile'] as const;

export type KeyRefScheme = (typeof KEY_REF_SCHEMES)[number];

/** `key_ref` 형식 위반. */
export class KeyRefFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRefFormatError';
  }
}

/** 형식 검증 후 `KeyRef` 로 승격한다. 위반은 예외 — fail closed. */
export function toKeyRef(scheme: KeyRefScheme, locator: string): KeyRef {
  if (locator.length === 0 || locator.length > 512 || /[\u0000-\u001f\u007f]/.test(locator)) {
    throw new KeyRefFormatError(`key_ref locator 형식 위반: ${JSON.stringify(locator)}`);
  }
  return `${scheme}://${locator}` as KeyRef;
}

/**
 * 평문 개인키(PKCS#8 DER).
 *
 * **클래스인 이유는 편의가 아니라 유출 차단이다.** 구조화 로거·`JSON.stringify` 로
 * 찍히는 에러 컨텍스트·vitest 의 diff 출력 어디에 실려도 `'[redacted]'` 만 나간다.
 * 원문을 꺼내는 이름이 `expose()` 인 것도 같은 이유다 — 호출부에 경고가 남는다.
 */
export class PrivateKeyMaterial {
  readonly #pkcs8: Uint8Array;

  public constructor(pkcs8: Uint8Array) {
    if (pkcs8.length === 0) throw new Error('빈 개인키 자료');
    this.#pkcs8 = pkcs8;
  }

  /** 평문 바이트. **이 호출이 보이는 자리가 곧 검토 대상이다.** */
  public expose(): Uint8Array {
    return this.#pkcs8;
  }

  /** 메모리에서 지운다. 보관이 끝나면 즉시 부른다. */
  public wipe(): void {
    this.#pkcs8.fill(0);
  }

  public toJSON(): string {
    return '[redacted]';
  }

  public toString(): string {
    return '[redacted]';
  }
}

/**
 * 키 보관 포트.
 *
 * **`load`/`decrypt` 가 없다** — 복호는 `src/passport/signer.ts`("키를 복호할 수 있는 유일한 파일", §3.5 AC-e2)만 한다.
 * 포트에 복호를 넣으면 그 유일성이 깨진다. **회전·삭제 메서드도 없다** — 있으면 그것이 곧 AC-13 이 막으려는 경로다.
 */
export interface KeyCustody {
  /** 어떤 구현인가. 감사 로그·데모 출력이 "무엇이 키를 들고 있는가"를 말할 수 있게 한다. */
  readonly kind: 'aws-kms-secretsmanager' | 'local-dev';
  /**
   * 개인키를 보관하고 참조를 돌려준다.
   *
   * **DB INSERT 보다 먼저 호출된다** (`keypair.ts`). 순서가 반대면 "키 참조는 커밋됐는데
   * 그 자리에 아무것도 없는" 행이 생길 수 있고, 그 행은 영원히 서명 불가인 데다
   * 불변 트리거 때문에 고칠 수도 없다. 반대 방향의 사고(트랜잭션이 롤백되어 보관된
   * 키가 고아가 되는 것)는 **아무도 참조하지 않는 비밀 하나**로 끝난다.
   */
  store(agentId: AgentId, privateKey: PrivateKeyMaterial): Promise<KeyRef>;
}

// ---------------------------------------------------------------------------
// 운영 가드
// ---------------------------------------------------------------------------

/** 운영 환경에서 개발 전용 구현이 선택됨. **복구하지 말고 죽어야 한다.** */
export class ProductionCustodyGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionCustodyGuardError';
  }
}

/**
 * 운영으로 판정하는 환경변수. `ATMARK_ENV` 를 **먼저** 본다.
 *
 * `NODE_ENV` 만 보지 않는 이유: `NODE_ENV=production` 은 번들러·프레임워크가 성능
 * 목적으로 켜는 값이라 "여기가 운영인가"의 신뢰할 수 있는 답이 아니다. 반대로
 * `NODE_ENV` 를 **무시**하면 `ATMARK_ENV` 를 깜빡한 배포가 개발 구현으로 조용히 돈다.
 * 둘 중 하나라도 운영을 가리키면 운영으로 본다 — 이 판정은 fail closed 여야 한다.
 */
export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const atmark = env['ATMARK_ENV']?.trim().toLowerCase();
  if (atmark !== undefined && atmark !== '') return atmark === 'production' || atmark === 'prod';
  return env['NODE_ENV']?.trim().toLowerCase() === 'production';
}

/**
 * 개발 전용 경로의 진입 가드. **운영이면 던진다.**
 *
 * `custody-local.ts` 가 팩토리와 `store()` **양쪽에서** 부른다. 팩토리에서만 부르면
 * 프로세스가 개발로 떠서 나중에 운영 설정을 받는 구성(장기 실행 워커)에서 통과한다.
 */
export function assertNotProduction(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionEnvironment(env)) return;
  throw new ProductionCustodyGuardError(
    `${what} 은(는) 개발 전용이다. 운영에서는 KMS envelope + Secrets Manager 구현(createAwsKeyCustody)을 ` +
      '써라. 평문 보관으로 조용히 떨어지는 폴백은 존재하지 않는다 (계획 §3.5).',
  );
}
