/**
 * src/db/repositories/index.ts — 관문이 쓸 구현체의 조립 지점.
 *
 * `gate.dispatch` 의 `GateDependencies` 중 **전송단(`transport`)을 제외한 DB 쪽 협력자**가
 * 여기서 나온다 — 전송단은 Layer B 가
 * "`ses-transport.ts` 의 export 를 참조하는 프로덕션 파일은 `gate.ts` 뿐" 이라고
 * 단언하므로 **이 파일이 전송단을 조립할 수 없다.** 그 분리는 불편이 아니라 AC-8 의 형태다.
 */

export {
  createPostgresAgentTokenStore,
  type AgentApiKeyInsert,
  type AgentApiKeyRepository,
} from './agent-token-store';
export { createPostgresApprovalStore, createPostgresApprovalStoreOn } from './approval-store';
export { createPostgresAuditSink, toResolutionReason } from './audit-sink';
export {
  createPostgresLeaseStore,
  MessageNotFoundError,
  type MessageDispatchStore,
} from './lease-store';
export { ADVISORY_LOCK_NAMESPACE, createPostgresOutboundSerializer } from './outbound-serializer';
export { createPostgresPolicySource } from './policy-source';
export {
  createPostgresSesEventStore,
  type RecordOutcome,
  type SesEventStore,
} from './ses-event-store';
export {
  createPostgresSendingClock,
  noopSendingClock,
  type SendingClock,
} from './sending-clock';
// P3a — 수신 파이프라인. 관문의 협력자가 아니다(`workers/inbound-consumer` 가 쓴다).
export {
  createPostgresInboundStore,
  type InboundMessageRecord,
  type InboundRejectionRecord,
  type InboundStore,
} from './inbound-store';
export { createPostgresThreadLookup } from './thread-store';
// P4 — 스캐너 판정 · Sender Trust. `createPostgresInboundVerdictLookup` 은 P3b Stage 7 이 읽는 포트다.
export {
  createPostgresInboundVerdictLookup,
  type InboundVerdict,
  type InboundVerdictLookup,
} from './inbound-store';
export { insertSecurityFindings, listSecurityFindings, type SecurityFindingRecord } from './security-finding-store';
export { createPostgresTrustFacts } from './trust-facts-store';
export { createPostgresInboundPolicySource, type InboundPolicyPort } from './inbound-policy-store';
export { loadEffectiveSeenMarks } from './sender-marks-store';
// P3c — 에이전트 컨텍스트 조회(격리 행은 결과에 없다) · 예약 발송.
export {
  createPostgresInboundReadStore,
  visibleToAgent,
  type InboundReadStore,
  type ThreadView,
  type VisibleInboundDetail,
  type VisibleInboundSummary,
} from './inbound-read-store';
export {
  createPostgresScheduledSendStore,
  MAX_SCHEDULED_ATTEMPTS,
  type ScheduledSendRecord,
  type ScheduledSendStore,
} from './scheduled-send-store';
// P3b — 회신 라우트의 "무엇에 답하는가" 조회. **권한을 주지 않는다** — 판정은 `policy-source` 가 따로 읽는다.
export { createPostgresReplyTargetLookup, type ReplyTarget, type ReplyTargetLookup } from './reply-target-store';

import type { Pool } from 'pg';

import type { AuditSink, DispatchSerializer, SendEvidenceLookup } from '../../policy/gate';
import type { PolicySource } from '../../policy/policy-loader';
import { createPostgresAuditSink } from './audit-sink';
import { createPostgresLeaseStore, type MessageDispatchStore } from './lease-store';
import { createPostgresOutboundSerializer } from './outbound-serializer';
import { createPostgresPolicySource } from './policy-source';
import { createPostgresSesEventStore } from './ses-event-store';

/** 관문에 주입할 DB 쪽 협력자. */
export interface PostgresGateStores {
  readonly source: PolicySource;
  readonly audit: AuditSink;
  readonly leases: MessageDispatchStore;
  /** 평가~lease 구간의 조직 단위 직렬화(R22). 같은 풀이어야 한다 — 다른 풀이면 잠금과
   *  잠금 안의 조회가 서로 다른 커넥션 예산을 쓰게 되어 굶는 조건이 둘로 갈라진다. */
  readonly serializer: DispatchSerializer;
  /**
   * **"그 메일은 나갔는가" 를 물을 곳** (ADR-0004). lease 만료 재전송 직전에 관문이 읽는다.
   *
   * 같은 풀인 것이 중요하다 — 다른 풀이면 조회가 자기 커넥션 예산으로 굶을 수 있고,
   * 그 굶음은 관문에서 `unknown` 으로 보인다. `unknown` 은 fail-closed 라 메일이 안 나가는
   * 쪽이지만, 원인이 "커넥션 풀이 둘" 인 상태는 진단에 오래 걸린다.
   */
  readonly sendEvidence: SendEvidenceLookup;
}

/** 풀 하나로 다섯을 한 번에 만든다. 풀이 둘이 되면 트랜잭션 경계도 둘이 된다. */
export function createPostgresGateStores(pool: Pool): PostgresGateStores {
  return {
    source: createPostgresPolicySource(pool),
    audit: createPostgresAuditSink(pool),
    leases: createPostgresLeaseStore(pool),
    serializer: createPostgresOutboundSerializer(pool),
    sendEvidence: createPostgresSesEventStore(pool),
  };
}
