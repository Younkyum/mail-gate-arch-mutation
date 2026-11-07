/**
 * src/passport/did.ts — DID 문자열 계산. **경로 스킴이 영구 동결된 파일이다.**
 *
 * ADR-0002: `did:web:id.atmark.ai:agents:{agentId}` → `https://id.atmark.ai/agents/{agentId}/did.json`.
 *
 * **이 파일은 리팩터 금지 구역이다.** 아래 세 상수를 바꾸면 이미 발급된 DID 가 전부
 * 깨진다 — did:web 은 문자열이 곧 해석 경로이고, 해석 경로가 바뀌면 옛 문자열은
 * 아무 데도 가리키지 않게 된다. 동결 사실은 ADR-0002 Consequences 와
 * `202609221600_agent_keypairs_and_passports.sql` 의 `passports.did` CHECK 두 곳에
 * 이중으로 적혀 있다(코드가 틀리게 조립하면 DB 가 INSERT 에서 죽는다).
 *
 * **문서 조립·서빙은 여기 없다** — `document.ts`(조립) · `publisher.ts`(서명·게시).
 */

import { toAgentId, type AgentId, type PassportStatus } from '../db/schema';

/** DID 문서를 서빙할 호스트명. `infra/cdk/stacks/identity-cdn-stack.ts` 와 같은 값이다. */
export const IDENTITY_HOST = 'id.atmark.ai';

/** 경로 세그먼트. **동결** — `/agents/{agentId}/did.json` 의 `agents`. */
export const DID_PATH_SEGMENT = 'agents';

/**
 * DID 접두사. did:web 은 호스트의 `.` 은 그대로 두고 **경로 구분자를 `:` 로** 쓴다.
 * 즉 `did:web:id.atmark.ai:agents:{id}` 의 마지막 두 `:` 가 URL 의 `/` 다.
 */
export const DID_WEB_PREFIX = `did:web:${IDENTITY_HOST}:${DID_PATH_SEGMENT}:`;

/**
 * Atmark 조직 DID. Phase 1 의 모든 passport `controller` 가 이 값이다 (§3.5 표).
 *
 * controller 이양(Phase 2)은 **키 교체가 아니다** — 같은 `agentId`·같은
 * `verificationMethod` 를 유지한 채 이 필드만 바뀌므로 기존 서명은 그대로 유효하다.
 * custody 이양과 앵커 승격이 독립된 축이라는 §3.5 의 관찰이 여기 들어 있다.
 */
export const ATMARK_CONTROLLER_DID = `did:web:${IDENTITY_HOST}`;

/** DID 문자열이 `agentId` 와 어긋남. */
export class DidMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DidMismatchError';
  }
}

/** `agentId` → DID 문자열. **생성 경로는 이 함수 하나뿐이다.** */
export function didForAgent(agentId: AgentId): string {
  return `${DID_WEB_PREFIX}${agentId}`;
}

/**
 * DID 문자열 → `agentId`. 접두사가 다르거나 말단이 형식 위반이면 던진다.
 *
 * 관대하게 파싱하지 않는 이유: 이 함수의 출력은 DB 조회 키가 된다. 형식이 느슨하면
 * `did:web:evil.example:agents:{id}` 도 우리 에이전트로 해석되고, 그 해석은
 * 승격(AC-13)이 전제하는 "동일성"을 조용히 무너뜨린다.
 */
export function agentIdFromDid(did: string): AgentId {
  if (!did.startsWith(DID_WEB_PREFIX)) {
    throw new DidMismatchError(`DID 접두사가 다르다: ${JSON.stringify(did)}`);
  }
  return toAgentId(did.slice(DID_WEB_PREFIX.length));
}

/** DID 문서의 해석 URL. 게시 워커(`publisher.ts`)가 이 경로에 파일을 올린다 — draft 에는 아무것도 없다(`externalDidOf`). */
export function didDocumentUrl(agentId: AgentId): string {
  return `https://${IDENTITY_HOST}/${DID_PATH_SEGMENT}/${agentId}/did.json`;
}

/**
 * ★ **B5 — 외부 표면에 나갈 수 있는 DID 인가.**
 *
 * **한 번도 게시되지 않은(`draft`) passport 의 DID 는 `null` 이다.** draft 의 DID 는 `id.atmark.ai` 에서 404 이고, 그 문자열이
 * API 응답·웹훅·로그·대시보드로 새면 **해석되지 않는 DID 가 외부로 나간다** — 받은 쪽은 검증에 실패하고 그 실패를 "이 에이전트는
 * 가짜"로 읽는다. 해석 불가 DID 는 DID 가 없는 것보다 나쁘다.
 *
 * 정지·폐기는 통과시킨다 — 계획 §4B.1b 가 **어떤 상태에서도 문서를 내리지 않는다**고 정했으므로 그 DID 는 해석된다(문서가
 * `status:"suspended"|"revoked"` 로 재서명돼 서빙된다).
 *
 * **예외가 아니라 `null` 을 돌려주는 이유:** 직렬화 경로에서 던지면 호출자는 try/catch
 * 로 감싸고 그 catch 가 곧 우회가 된다. `null` 은 타입이 강제하는 분기이고,
 * `exactOptionalPropertyTypes` 아래에서 "필드를 빼는" 선택을 명시하게 만든다.
 */
export function externalDidOf(passport: {
  readonly did: string;
  readonly status: PassportStatus;
}): string | null {
  return passport.status === 'draft' ? null : passport.did;
}
