/**
 * src/identity/org-api-key.ts — **조직 API 키**(`atk_org_*`)의 형식·해시·권한 이름 (확장성 P1 R-6, 창업자 결정 F-4).
 *
 * 에이전트 토큰(`agent-token.ts`)과 **다른 접두사·다른 테이블·다른 호스트**다:
 *   - 에이전트 토큰은 api 호스트(`api.atmark.ai`)에서 자기 에이전트의 발신·읽기만 한다(self-scope).
 *   - 조직 키는 콘솔 호스트의 `/org-api/v1/*`(admin Lambda)에서 조직의 에이전트 **목록·생성**만 한다 — 프로비저닝 보관소(KMS·Secrets
 *     Manager)가 admin Lambda 역할에만 있기 때문이다(계획 F7 · H1). api 호스트는 이 접두사를 보면 안내와 함께 401 이다(`src/api/auth.ts`).
 *
 * 이 파일은 규칙만 있다(행 접근 없음) — admin(`src/admin/ops/org-keys.ts`)과 api(`src/api/auth.ts` 의 거부 안내)가 **같이** import 한다.
 * `src/admin/**` 를 import 하지 않는다(api 번들 폐포에 admin 이 들어가면 `admin-separation` arch 테스트가 깨진다).
 *
 * 해시에 salt 를 쓰지 않는 이유는 에이전트 토큰과 같다(256비트 무작위 값 — 해시가 곧 조회 키).
 */

import { createHash, randomBytes } from 'node:crypto';

/** 접두사 — 비밀이 아니라 분류자. 유출 스캐너·사람이 에이전트 토큰(`atk_agent_`)과 눈으로 구별한다. */
export const ORG_API_KEY_PREFIX = 'atk_org_';

/** 비밀부 바이트(256비트) → base64url 43자. */
export const ORG_API_KEY_SECRET_BYTES = 32;

export const ORG_API_KEY_PATTERN = new RegExp(`^${ORG_API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

/** 끝 4자 표시값 — 에이전트 토큰 `hint` 와 같은 절충(비밀부 256비트 중 24비트). */
export const ORG_API_KEY_HINT_LENGTH = 4;

/**
 * 조직 키 권한 — **닫힌 목록 셋**(F-4 · ADR-0014 M3b `domains:manage`). 정책·토큰·발송·조직 키 관리는 이 목록에 이름이 없다(권한을 요구하는 코드가
 * 컴파일되지 않는다). DB CHECK(`org_api_keys_capabilities_check`, 202609250150 → 202610021200)가 같은 집합이다.
 */
export type OrgApiKeyCapability = 'agents:read' | 'agents:create' | 'domains:manage';

export const ORG_API_KEY_CAPABILITIES = ['agents:read', 'agents:create', 'domains:manage'] as const satisfies readonly OrgApiKeyCapability[];

export function isOrgApiKeyCapability(value: unknown): value is OrgApiKeyCapability {
  return typeof value === 'string' && (ORG_API_KEY_CAPABILITIES as readonly string[]).includes(value);
}

/** 평문 → sha256 hex 64. DB 에는 이 값만 들어간다. */
export function hashOrgApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** 모양이 조직 키인가(접두사 + 43자). */
export function isOrgApiKeyShape(value: string): boolean {
  return ORG_API_KEY_PATTERN.test(value);
}

/** 접두사만 조직 키인가 — api 호스트가 "여기가 아니다" 안내를 고르는 데 쓴다(모양 검사 아님). */
export function looksLikeOrgApiKey(value: string): boolean {
  return value.startsWith(ORG_API_KEY_PREFIX);
}

export interface IssuedOrgApiKey {
  /** **평문 1회.** 저장·로깅 금지. */
  readonly plaintext: string;
  readonly keyHash: string;
  readonly hint: string;
}

/** 새 키. 평문은 이 반환값에만 있다. */
export function issueOrgApiKey(): IssuedOrgApiKey {
  const plaintext = `${ORG_API_KEY_PREFIX}${randomBytes(ORG_API_KEY_SECRET_BYTES).toString('base64url')}`;
  return { plaintext, keyHash: hashOrgApiKey(plaintext), hint: plaintext.slice(-ORG_API_KEY_HINT_LENGTH) };
}
