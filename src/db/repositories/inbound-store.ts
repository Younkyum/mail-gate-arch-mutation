/**
 * src/db/repositories/inbound-store.ts — 수신 메일 **메타**의 기록 (P3a).
 *
 * **본문·원문을 받는 인자가 없다.** 이 파일이 아는 것은 S3 키와 판정 메타뿐이다(PRD). 받을 자리가 없으면
 * 넣을 수도 없다 — 컬럼 화이트리스트(스키마 테스트)와 같은 방향의 두 번째 층이다.
 *
 * **멱등성은 유니크 인덱스가 집행한다** (`inbound_messages_agent_ses_message_key`,
 * `inbound_rejections_ses_reason_key`). 선조회(`existingAgentIds`)는 S3 작업을 건너뛰는 최적화일 뿐이고
 * 판정이 아니다 — 동시에 도는 두 소비자는 둘 다 "없다" 를 본다. 진 쪽은 INSERT 가 0행이 되고,
 * 그 트랜잭션은 **통째로 되돌린다**(새로 만든 스레드가 고아로 남지 않게).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../client';
import type {
  InboundPolicyReason,
  InboundQuarantineReason,
  InboundRejectionReason,
  InboundSenderTrust,
  InboundWatchLevel,
  InjectionRisk,
  SesVerdict,
} from '../schema';
import { messageReceivedEvent } from '../../webhooks/events';
import { dormantAnchorSql, hasPrimaryChanges } from './primary-changes-probe';
import { insertSecurityFindings, type SecurityFindingRecord } from './security-finding-store';
import { enqueueWebhookEvent } from './webhook-store';

export interface AgentAddressMatch {
  readonly agentId: string;
  readonly address: string;
  /** 에이전트의 조직 — AI 감시 승격 규칙 2·3·7(조직 단위 사실)과 작업 키(조직 × SES 메시지)의 재료. */
  readonly organizationId: string;
  /**
   * 그 에이전트의 조직이 운영자 검토를 통과했는가(`organizations.review_status = 'active'`). 검토 전·거절 조직의 에이전트는
   * 수신을 받지 않는다(보안 검증 M3 — 소비자가 `org_not_active` 결말로 남긴다).
   */
  readonly organizationActive: boolean;
  /**
   * 주소의 도메인이 메일을 받을 수 있는가(ADR-0014 결정 6 · 계획 §3.6) — `atmark.ai` 는 늘 참, 고객 도메인은 **같은 조직**의 `custom_domains` 행이
   * verified 이거나 suspended(reputation·operator·plan_limit)일 때만(계약 `domainAcceptsInboundOf` 와 같은 표). 거짓이면 소비자가 원문을 읽기
   * **전에** `domain_not_active` 로 남긴다. 고객 도메인 행이 0 인 운영에서는 모든 주소가 `atmark.ai` 라 늘 참이다.
   */
  readonly domainActive: boolean;
}

/** 권한용 스레드 — 기존에 잇거나, 이 메일로 새로 연다. */
export type InboundThreadPlacement =
  | {
      readonly kind: 'existing';
      readonly threadId: string;
      readonly matchedBy: 'message_id_header' | 'ses_message_id';
      /** 근거 행의 id — `messages` 또는 `inbound_messages`. 어느 쪽인지는 저장소가 가린다(`matched_direction`). */
      readonly matchedMessageId: string;
    }
  | {
      readonly kind: 'new';
      readonly reason: string;
      /** 새 외부 스레드의 표시용 제목(`normalizeSubject`). */
      readonly subjectNormalized: string | null;
    };

export interface InboundAttachmentRecord {
  readonly partIndex: number;
  readonly filename: string | null;
  readonly contentType: string;
  readonly disposition: 'attachment' | 'inline' | null;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly storageKey: string;
  readonly sha256: string;
}

/**
 * injection 스캔의 결말 (P4). **둘뿐이다** — "스캔하지 않음" 은 표현할 수 없다(DB INSERT 트리거도 막는다).
 *
 * `scanner_error` 는 판정이 없다는 뜻이고, 저장소는 그 행을 **무조건 격리**로 쓴다(fail-closed — DB CHECK
 * `inbound_messages_unscanned_is_quarantined` 가 한 번 더).
 */
export type InboundScanRecord =
  | {
      readonly kind: 'scanned';
      readonly scannerVersion: string;
      readonly injectionRisk: InjectionRisk;
      readonly quarantined: boolean;
      readonly findings: readonly SecurityFindingRecord[];
    }
  | { readonly kind: 'scanner_error'; readonly scannerVersion: string };

/** 수신 시점의 Sender Trust 판정(`computeTrust`). */
export interface InboundSenderTrustRecord {
  readonly category: InboundSenderTrust;
  /** 등급을 정한 신호 종류. `unknown` 이면 `null`. */
  readonly decidedBy: string | null;
}

export interface InboundMessageRecord {
  readonly agentId: string;
  readonly envelopeRecipient: string;
  readonly sesMessageId: string;
  readonly thread: InboundThreadPlacement;
  /** **표시용.** 정책이 읽지 않는다. */
  readonly displayThreadId: string | null;
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  /** 소문자. */
  readonly fromAddress: string;
  readonly fromAuthenticated: boolean;
  readonly subject: string | null;
  readonly headerDate: Date | null;
  readonly autoSubmitted: boolean;
  readonly envelopeSender: string | null;
  readonly forwardedForHeader: string | null;
  readonly forwardedToHeader: string | null;
  readonly verdicts: {
    readonly spf: SesVerdict;
    readonly dkim: SesVerdict;
    readonly dmarc: SesVerdict;
    readonly spam: SesVerdict;
    readonly virus: SesVerdict;
  };
  readonly headersTruncated: boolean;
  readonly rawStorageKey: string;
  readonly parsedStorageKey: string;
  readonly textSource: 'plain' | 'html' | 'none';
  readonly hasHtmlText: boolean;
  readonly attachments: readonly InboundAttachmentRecord[];
  readonly receivedAt: Date;
  /** P4 — 저장 전 스캔 결과. */
  readonly scan: InboundScanRecord;
  /** P4 — 수신 시점 신뢰 판정. */
  readonly senderTrust: InboundSenderTrustRecord;
  /**
   * 정책 v2 — 수신 정책이 막았으면 그 사유(`src/policy/inbound-policy.ts`), 보여도 되면 `null`. 막힌 행은 **격리**로 쓰이고
   * (`quarantine_reason = 'policy_blocked'`) 웹훅도 없다 — 저장소가 정한다(아래 `quarantineOf`).
   */
  readonly policyBlocked: InboundPolicyReason | null;
  /**
   * 복사 지문(ADR-0016 B `inbound_copy` — `security/dlp/shingle.ts`). 메일 행과 **같은 트랜잭션**에서 `inbound_fingerprints` 에 적는다 — 행은 있는데
   * 지문이 없는 메일이 생기지 않게(그 메일은 발신 DLP 의 복사 판정에서 조용히 빠진다). `null` = 지문을 만들 텍스트가 없다(빈 본문).
   */
  readonly copyFingerprints: InboundCopyFingerprints | null;
  /**
   * AI 의심 메일 감시(ADR-0017 초안 · 경고 전용) — 승격된 행이면 계획, 아니면 없음/null. 같은 트랜잭션에서 작업(조직 × SES 메시지 하나)을 찾거나
   * 만들고 행에 잇는다. `hold` 면 `ai_hold_until`(작업 마감, 최대 30초)을 찍고 `message.received` 웹훅도 그 시각으로 미룬다.
   * **격리·정책·신뢰·웹훅 발화 여부는 이 칸과 무관하다** — 보이는 시각만 늦춘다.
   */
  readonly aiWatch?: InboundAiWatchPlan | null;
  /**
   * 받기 등급(ADR-0016 2026-10-08 — `src/security/levels.ts`) · 감시 탭 설정의 결과. 소비자가 에이전트마다 정한다. 생략하면 오늘 동작(등급 기록 없음 ·
   * 우회 없음 · 보류 없음 — 테스트 · 옛 호출자). 격리 · 웹훅은 `quarantineOf` 가 이 값까지 읽어 한 번에 정한다.
   */
  readonly watch?: InboundWatchRecord;
}

/** 받기 등급 기록 — 소비자가 `classifyInboundLevel` 과 에이전트 설정으로 정한 셋. */
export interface InboundWatchRecord {
  /** 수신 시점 등급(위험 보류를 정하기 **전**의 판정 — 보류해도 `risk`). */
  readonly level: InboundWatchLevel;
  /** 신뢰 발신자 우회 — 스캐너 격리(`injection_risk`)를 지운다. 판정 없음 · 정책 차단은 지우지 못한다. DB CHECK 가 DMARC 인증을 다시 본다. */
  readonly trustedBypass: boolean;
  /** 위험 등급 + 에이전트 설정 `hold` — 격리 사유 `risk_hold` 로 숨긴다. */
  readonly riskHold: boolean;
}

export interface InboundAiWatchPlan {
  readonly organizationId: string;
  readonly hold: boolean;
  readonly shadow: boolean;
}

/** 기록된 행에 이어진 작업. `created` 면 이 호출이 만들었다 — 커밋 뒤 요청 큐에 보낼 쪽이다. */
export interface InboundAiWatchJobLink {
  readonly jobId: string;
  readonly created: boolean;
  readonly enqueuedAt: Date;
  readonly deadline: Date;
  /** 이 행에 찍힌 보류(없으면 null). */
  readonly holdUntil: Date | null;
}

/** 받은 메일 한 통의 복사 지문 — HMAC 값뿐(원문 없음). */
export interface InboundCopyFingerprints {
  readonly kid: string;
  /** 16 hex, 최대 256. */
  readonly fingerprints: readonly string[];
  /** DMARC 통과 메일이면 From·To·Cc(소문자, 최대 64), 아니면 빈 배열 — 스레드 참여자 제외(ADR-0016 M1 배선 계약 5)의 재료. */
  readonly participants: readonly string[];
}

export type InboundRecordOutcome =
  | {
      readonly kind: 'recorded';
      readonly inboundMessageId: string;
      readonly threadId: string;
      /** AI 감시 작업 연결(승격 행만). */
      readonly aiWatchJob?: InboundAiWatchJobLink | null;
    }
  | { readonly kind: 'duplicate' };

export interface InboundRejectionRecord {
  readonly sesMessageId: string;
  readonly reason: InboundRejectionReason;
  /** 이유 코드·숫자만. 메일 내용 금지(200자 CHECK). */
  readonly detail: string | null;
  readonly envelopeRecipients: readonly string[];
  readonly virusVerdict: SesVerdict;
  readonly spamVerdict: SesVerdict;
  readonly rawStorageKey: string;
  readonly receivedAt: Date;
}

export interface InboundStore {
  /** 봉투 수신 주소 → 에이전트. `agent_addresses.address` 정확 일치(소문자). */
  findAgentsByAddresses(addresses: readonly string[]): Promise<readonly AgentAddressMatch[]>;
  /** 이 SES 메시지를 이미 기록한 에이전트들. **최적화용** — 멱등성의 판정은 INSERT 가 한다. */
  existingAgentIds(sesMessageId: string): Promise<ReadonlySet<string>>;
  recordMessage(record: InboundMessageRecord): Promise<InboundRecordOutcome>;
  recordRejection(record: InboundRejectionRecord): Promise<'recorded' | 'duplicate'>;
}

/**
 * 이 행이 에이전트 컨텍스트에서 가려지는가 — 그리고 **왜**. **INSERT 의 `quarantined`·`quarantine_reason` 과 웹훅 발화가 같은
 * 함수를 읽는다** — 둘이 따로 판정하면 "격리됐는데 이벤트는 나갔다" 가 가능해진다. 판정 없음(`scanner_error`)은 격리다.
 *
 * 사유가 겹치면 **정책이 이긴다**: 소유자가 막은 상대의 메일은 스캐너 판정과 무관하게 안 보이고, 로그(T3)는 "소유자가 막았다" 로
 * 읽어야 누가 풀지가 정해진다. 스캐너 판정 자체는 `injection_risk` 에 그대로 남는다.
 *
 * 받기 등급(2026-10-08): 신뢰 발신자 우회는 **스캐너 격리만** 지운다(판정 없음은 그대로 격리 — fail closed). 위험 보류(`riskHold`)는 그 밖에 보일
 * 메일을 `risk_hold` 로 숨긴다(좁히기만).
 */
export function quarantineOf(record: Pick<InboundMessageRecord, 'scan' | 'policyBlocked' | 'watch'>): InboundQuarantineReason | null {
  if (record.policyBlocked !== null) return 'policy_blocked';
  if (record.scan.kind === 'scanner_error') return 'scanner_error';
  if (record.scan.quarantined && record.watch?.trustedBypass !== true) return 'injection_risk';
  return record.watch?.riskHold === true ? 'risk_hold' : null;
}

/** 경합에서 졌다 — 트랜잭션을 되돌리기 위한 신호. 밖으로 새지 않는다. */
class DuplicateInbound extends Error {
  constructor() {
    super('duplicate inbound');
    this.name = 'DuplicateInbound';
  }
}

export function createPostgresInboundStore(pool: Pool): InboundStore {
  return {
    async findAgentsByAddresses(addresses: readonly string[]): Promise<readonly AgentAddressMatch[]> {
      if (addresses.length === 0) return [];
      const dormant = (await hasPrimaryChanges(pool, pool)) ? dormantAnchorSql('aa') : 'false';
      // 고객 도메인(ADR-0014 결정 6) — JOIN 이 아니라 **EXISTS**(행이 늘지 않는다). 술어는 계약 `domainAcceptsInboundOf` 의 표 그대로이고 **같은
      // 조직**의 행만 본다(다른 조직이 같은 도메인을 쥐었어도 옛 주소로 받지 않는다). `atmark.ai` 주소는 EXISTS 와 무관하게 참이다 — 고객 도메인
      // 행이 0 이면 모든 주소가 참이라 수신 결말이 이전과 같다.
      const result = await pool.query<{
        agent_id: string;
        address: string;
        organization_id: string;
        organization_active: boolean;
        domain_active: boolean;
      }>(
        `SELECT aa.agent_id, aa.address, a.organization_id, (o.review_status = 'active') AS organization_active,
                (aa.domain = 'atmark.ai' OR EXISTS (
                   SELECT 1 FROM custom_domains cd
                    WHERE cd.domain = aa.domain AND cd.organization_id = a.organization_id
                      AND (cd.status = 'verified'
                           OR (cd.status = 'suspended' AND cd.suspended_reason IN ('reputation', 'operator', 'plan_limit'))))) AS domain_active
           FROM agent_addresses aa
           JOIN agents a ON a.id = aa.agent_id
           JOIN organizations o ON o.id = a.organization_id
          WHERE aa.address = ANY($1::text[])
            -- 메일 기본기 2차 A6 — 폐기한 별칭은 받지 않는다(모르는 주소와 같다 — 수신 거부). 행 JSON 에서 읽는다(202609270110 전 스키마에서도 돈다).
            AND (to_jsonb(aa) ->> 'retired_at') IS NULL
            -- 잠든 앵커(ADR-0014 2026-10 개정 · 202610021100) — 마지막 대표 선택이 앵커가 아닌 에이전트의 @atmark.ai 앵커는 모르는 주소와 똑같이 거부한다
            -- (unknown_recipient — 존재를 밝히지 않는다). 계약 anchorDormantOf · 정책 소스 usable 과 같은 술어.
            AND NOT ${dormant}
          ORDER BY aa.address`,
        [[...addresses]],
      );
      return result.rows.map((row) => ({
        agentId: row.agent_id,
        address: row.address,
        organizationId: row.organization_id,
        organizationActive: row.organization_active,
        domainActive: row.domain_active,
      }));
    },

    async existingAgentIds(sesMessageId: string): Promise<ReadonlySet<string>> {
      const result = await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM inbound_messages WHERE ses_message_id = $1',
        [sesMessageId],
      );
      return new Set(result.rows.map((row) => row.agent_id));
    },

    async recordMessage(record: InboundMessageRecord): Promise<InboundRecordOutcome> {
      try {
        return await withTransaction(pool, async (client) => {
          let threadId: string;
          if (record.thread.kind === 'existing') {
            // 에이전트 범위로 묶어 갱신한다 — 0행이면 스레드가 이 에이전트의 것이 아니다. 해석기와 복합 FK 가
            // 이미 막지만, 여기서 조용히 넘어가면 INSERT 의 FK 오류가 원인을 가린다.
            const updated = await client.query(
              `UPDATE threads SET last_message_at = greatest(last_message_at, $3)
                WHERE id = $1 AND agent_id = $2`,
              [record.thread.threadId, record.agentId, record.receivedAt],
            );
            if (updated.rowCount !== 1) {
              throw new Error(`스레드가 없거나 이 에이전트의 것이 아니다 (thread=${record.thread.threadId})`);
            }
            threadId = record.thread.threadId;
          } else {
            const created = await client.query<{ id: string }>(
              `INSERT INTO threads (agent_id, started_by, starter_address, subject_normalized, created_at, last_message_at)
               VALUES ($1, 'external', $2, $3, $4, $4)
               RETURNING id`,
              [record.agentId, record.fromAddress, record.thread.subjectNormalized, record.receivedAt],
            );
            const id = created.rows[0]?.id;
            if (id === undefined) throw new Error('threads INSERT 가 행을 돌려주지 않았다');
            threadId = id;
          }

          // 근거 행이 어느 테이블의 것인가 — 해석기 출력에는 방향이 없다(권한 판정에 필요 없으므로).
          // 에이전트 범위로 찾고, 어디에도 없으면 던진다: 근거 없는 권한 연결을 기록하지 않는다.
          let matched: { matchedBy: string; matchedMessageId: string; matchedDirection: string } | null = null;
          if (record.thread.kind === 'existing') {
            const direction = await client.query<{ direction: string | null }>(
              `SELECT CASE
                        WHEN EXISTS (SELECT 1 FROM messages WHERE id = $1 AND agent_id = $2) THEN 'outbound'
                        WHEN EXISTS (SELECT 1 FROM inbound_messages WHERE id = $1 AND agent_id = $2) THEN 'inbound'
                      END AS direction`,
              [record.thread.matchedMessageId, record.agentId],
            );
            const matchedDirection = direction.rows[0]?.direction ?? null;
            if (matchedDirection === null) {
              throw new Error(`권한 연결의 근거 행이 이 에이전트에 없다 (matched=${record.thread.matchedMessageId})`);
            }
            matched = {
              matchedBy: record.thread.matchedBy,
              matchedMessageId: record.thread.matchedMessageId,
              matchedDirection,
            };
          }
          const quarantine = quarantineOf(record);
          // AI 감시 작업 — 메일 행보다 **먼저**(FK). 조직 × SES 메시지 하나(승격 규칙 8): 있으면 그것에 잇는다. 보류는 작업 마감까지(최대 30초 —
          //   DB CHECK), 이미 결말 난 작업에는 찍지 않는다. 경합에서 진 쪽이 아직 보이지 않는 행을 만나면 던진다(일시 장애 → 재전달).
          const aiWatch = record.aiWatch ?? null;
          let job: { job_id: string; created: boolean; enqueued_at: Date; deadline: Date; state: string } | null = null;
          if (aiWatch !== null) {
            const found = await client.query<{ job_id: string; created: boolean; enqueued_at: Date; deadline: Date; state: string }>(
              `WITH ins AS (
                 INSERT INTO ai_watch_jobs (organization_id, ses_message_id, shadow) VALUES ($1, $2, $3)
                 ON CONFLICT (organization_id, ses_message_id) DO NOTHING
                 RETURNING job_id, enqueued_at, deadline, state
               )
               SELECT job_id, true AS created, enqueued_at, deadline, state FROM ins
               UNION ALL
               SELECT j.job_id, false, j.enqueued_at, j.deadline, j.state FROM ai_watch_jobs j
                WHERE j.organization_id = $1 AND j.ses_message_id = $2 AND NOT EXISTS (SELECT 1 FROM ins)`,
              [aiWatch.organizationId, record.sesMessageId, aiWatch.shadow],
            );
            job = found.rows[0] ?? null;
            if (job === null) throw new Error('ai_watch_jobs: 경합 — 다른 소비자의 작업 행이 아직 보이지 않는다');
          }
          const holdDeadline = aiWatch !== null && aiWatch.hold && job !== null && job.state === 'pending' ? job.deadline : null;
          const inserted = await client.query<{ id: string; ai_hold_until: Date | null }>(
            `INSERT INTO inbound_messages
               (agent_id, envelope_recipient, ses_message_id, thread_id, display_thread_id,
                matched_by, matched_message_id, matched_direction, new_thread_reason,
                message_id_header, in_reply_to, from_address, from_domain, from_authenticated,
                subject, header_date, auto_submitted,
                envelope_sender, forwarded_for_header, forwarded_to_header,
                spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
                raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
                scanner_version, injection_risk, quarantined, sender_trust, sender_trust_decided_by,
                quarantine_reason, policy_reason, ai_watch_job_id, ai_hold_until, watch_level, trusted_bypass)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, split_part($12, '@', 2), $13,
                     $14, $15, $16, $17, $18, $19,
                     $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
                     $32, $33, $34, $35, $36, $37, $38, $39,
                     -- 보류는 DB 시계로: 작업 마감과 now()+30s 중 이른 쪽(CHECK inbound_messages_ai_hold_max_30s 가 상한을 다시 본다).
                     CASE WHEN $40::timestamptz IS NULL THEN NULL ELSE LEAST($40::timestamptz, now() + interval '30 seconds') END,
                     $41, $42)
             ON CONFLICT (agent_id, ses_message_id) DO NOTHING
             RETURNING id, ai_hold_until`,
            [
              record.agentId,
              record.envelopeRecipient,
              record.sesMessageId,
              threadId,
              record.displayThreadId,
              matched?.matchedBy ?? null,
              matched?.matchedMessageId ?? null,
              matched?.matchedDirection ?? null,
              record.thread.kind === 'new' ? record.thread.reason : null,
              record.messageIdHeader,
              record.inReplyTo,
              record.fromAddress,
              record.fromAuthenticated,
              record.subject,
              record.headerDate,
              record.autoSubmitted,
              record.envelopeSender,
              record.forwardedForHeader,
              record.forwardedToHeader,
              record.verdicts.spf,
              record.verdicts.dkim,
              record.verdicts.dmarc,
              record.verdicts.spam,
              record.verdicts.virus,
              record.headersTruncated,
              record.rawStorageKey,
              record.parsedStorageKey,
              record.textSource,
              record.hasHtmlText,
              record.attachments.length,
              record.receivedAt,
              record.scan.scannerVersion,
              record.scan.kind === 'scanned' ? record.scan.injectionRisk : null,
              // ★ fail-closed — 판정이 없으면 격리, 정책이 막았으면 격리. 호출자가 무엇을 원하든 여기서 정한다.
              quarantine !== null,
              record.senderTrust.category,
              record.senderTrust.decidedBy,
              quarantine,
              record.policyBlocked,
              job?.job_id ?? null,
              holdDeadline,
              record.watch?.level ?? null,
              // 우회가 실제로 격리를 지웠거나 등급을 none 으로 둔 행만 — 정책 차단 · 판정 없음 행에는 적지 않는다(우회가 아무 효과도 없었다).
              record.watch?.trustedBypass === true && quarantine !== 'policy_blocked' && quarantine !== 'scanner_error',
            ],
          );
          const inboundMessageId = inserted.rows[0]?.id;
          const holdUntil = inserted.rows[0]?.ai_hold_until ?? null;
          // 0행 = 같은 (agent_id, ses_message_id) 가 이미 있다. 이 트랜잭션이 만든 스레드·갱신을 되돌린다.
          if (inboundMessageId === undefined) throw new DuplicateInbound();

          if (record.scan.kind === 'scanned') {
            await insertSecurityFindings(client, inboundMessageId, record.scan.scannerVersion, record.scan.findings);
          }

          // ADR-0016 B — 복사 지문. 같은 트랜잭션: 메일 행이 되돌려지면 지문도 없다.
          if (record.copyFingerprints !== null && record.copyFingerprints.fingerprints.length > 0) {
            await client.query(
              `INSERT INTO inbound_fingerprints (inbound_message_id, agent_id, thread_id, sender, participants, kid, fingerprints)
               VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[])`,
              [
                inboundMessageId,
                record.agentId,
                threadId,
                record.fromAddress,
                record.copyFingerprints.participants,
                record.copyFingerprints.kid,
                record.copyFingerprints.fingerprints,
              ],
            );
          }

          if (record.attachments.length > 0) {
            await client.query(
              `INSERT INTO inbound_attachments
                 (inbound_message_id, part_index, filename, content_type, disposition, size_bytes,
                  content_id, storage_key, sha256)
               SELECT $1, a.part_index, a.filename, a.content_type, a.disposition, a.size_bytes,
                      a.content_id, a.storage_key, a.sha256
                 FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[], $8::text[], $9::text[])
                   AS a(part_index, filename, content_type, disposition, size_bytes, content_id, storage_key, sha256)`,
              [
                inboundMessageId,
                record.attachments.map((a) => a.partIndex),
                record.attachments.map((a) => a.filename),
                record.attachments.map((a) => a.contentType),
                record.attachments.map((a) => a.disposition),
                record.attachments.map((a) => a.sizeBytes),
                record.attachments.map((a) => a.contentId),
                record.attachments.map((a) => a.storageKey),
                record.attachments.map((a) => a.sha256),
              ],
            );
          }
          // P3c — `message.received` 웹훅. **같은 트랜잭션**(outbox): 행이 되돌려지면 이벤트도 없다.
          // ★ 격리 행(판정 없음 포함 — 위 INSERT 가 판정 없음을 격리로 썼다)은 발화하지 않는다: 에이전트
          //   컨텍스트에서 제외된 메일의 존재를 이벤트로 알리면 에이전트는 읽을 수 없는 id 를 받는다
          //   (202609230300 머리말). 판정은 **이 함수가 쓴 값**으로 한다 — 호출자의 기록(record.scan)이 아니다.
          if (quarantine === null) {
            await enqueueWebhookEvent(
              client,
              messageReceivedEvent({
                agentId: record.agentId,
                inboundMessageId,
                threadId,
                receivedAt: record.receivedAt,
              }),
              // AI 감시 보류 행은 보류가 풀리는 시각까지 미룬다 — 결과 λ(또는 전송 실패의 skip)가 풀면서 앞당긴다(`ai_watch_release`).
              //   이벤트를 받은 에이전트가 곧바로 읽어도 보이는 상태가 된다. 보류가 없으면 예전 그대로 받은 시각.
              holdUntil ?? record.receivedAt,
            );
          }
          const aiWatchJob: InboundAiWatchJobLink | null =
            job === null
              ? null
              : { jobId: job.job_id, created: job.created, enqueuedAt: job.enqueued_at, deadline: job.deadline, holdUntil };
          return { kind: 'recorded' as const, inboundMessageId, threadId, aiWatchJob };
        });
      } catch (error) {
        if (error instanceof DuplicateInbound) return { kind: 'duplicate' };
        throw error;
      }
    },

    async recordRejection(record: InboundRejectionRecord): Promise<'recorded' | 'duplicate'> {
      const result = await pool.query(
        `INSERT INTO inbound_rejections
           (ses_message_id, reason, detail, envelope_recipients, virus_verdict, spam_verdict, raw_storage_key, received_at)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)
         ON CONFLICT (ses_message_id, reason) DO NOTHING`,
        [
          record.sesMessageId,
          record.reason,
          record.detail,
          [...record.envelopeRecipients],
          record.virusVerdict,
          record.spamVerdict,
          record.rawStorageKey,
          record.receivedAt,
        ],
      );
      return result.rowCount === 1 ? 'recorded' : 'duplicate';
    },
  };
}

// ---------------------------------------------------------------------------
// P3b 용 조회 포트 — "이 회신이 답하는 수신 메일의 판정"
// ---------------------------------------------------------------------------

/**
 * 스레드의 **최신 인증 수신 메일**의 판정. P3b Stage 7 이 `auto_approve_reply_within_thread`(외부 시작 스레드)·
 * `auto_approve_verification_senders` 의 전제(`injection_risk == none AND sender_trust >= seen`)를 볼 때 읽는다.
 *
 * - **권한용 `thread_id` 로만 찾는다.** 표시용(`display_thread_id`)은 보지 않는다(resolve.ts 규율).
 * - **인증된(DMARC pass) 수신만.** 사칭된 From 의 메일이 "이 스레드의 최신 메일" 이 되어 판정을 대신하지 않게.
 * - **에이전트 범위로 묶는다.** 다른 에이전트의 스레드 id 를 넣어도 `null`.
 * - `injectionRisk === null` 은 **판정 없음**(스캐너 예외·P4 이전 행)이다 — `'none'` 이 아니다. 전제는 불성립.
 *   `senderTrust === null` 도 같다(P4 이전 행).
 * - 결과가 `null`(인증 수신이 없는 스레드)이면 판정 근거가 없다 — 소비자는 승인 쪽으로 떨어져야 한다.
 */
export interface InboundVerdict {
  readonly inboundMessageId: string;
  readonly injectionRisk: InjectionRisk | null;
  readonly senderTrust: InboundSenderTrust | null;
  readonly quarantined: boolean;
  readonly scannerVersion: string | null;
  readonly fromAddress: string;
  readonly receivedAt: Date;
}

export interface InboundVerdictLookup {
  latestAuthenticatedInbound(agentId: string, threadId: string): Promise<InboundVerdict | null>;
}

export function createPostgresInboundVerdictLookup(pool: Pool): InboundVerdictLookup {
  return {
    async latestAuthenticatedInbound(agentId: string, threadId: string): Promise<InboundVerdict | null> {
      const result = await pool.query<{
        id: string;
        injection_risk: InjectionRisk | null;
        sender_trust: InboundSenderTrust | null;
        quarantined: boolean;
        scanner_version: string | null;
        from_address: string;
        received_at: Date;
      }>(
        `SELECT id, injection_risk, sender_trust, quarantined, scanner_version, from_address, received_at
           FROM inbound_messages
          WHERE agent_id = $1 AND thread_id = $2 AND from_authenticated
            AND quarantine_reason IS DISTINCT FROM 'policy_blocked'
          ORDER BY received_at DESC, created_at DESC
          LIMIT 1`,
        [agentId, threadId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        inboundMessageId: row.id,
        injectionRisk: row.injection_risk,
        senderTrust: row.sender_trust,
        quarantined: row.quarantined,
        scannerVersion: row.scanner_version,
        fromAddress: row.from_address,
        receivedAt: row.received_at,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AI 의심 메일 감시(ADR-0017 초안) — 수신 소비자의 승격 사실 · 전송 실패 skip
// ---------------------------------------------------------------------------

/**
 * 승격 규칙 2·3·7 의 사실과 워커 상태, 그리고 요청 큐 전송 실패의 fail-skip. **전부 정의 함수다** — 앱 롤은 `org_features`·`ai_watch_runtime` 권한이
 * 없고 `ai_watch_jobs` UPDATE 도 없다(202610061100). `ai_watch_jobs` 를 쓰는 프로덕션 파일은 이 파일(작업 생성 · skip)과 결과 λ 저장소 둘뿐이다.
 */
export interface AiWatchInboundPort {
  orgContext(organizationId: string): Promise<{ readonly featureAllowed: boolean; readonly ownerEnabled: boolean; readonly jobsLastHour: number }>;
  workerHealthy(): Promise<boolean>;
  /** 전송 실패 — 작업 skipped · 보류 풀기 · 웹훅 앞당기기. pending 이 아니었으면 false. */
  skipJob(jobId: string): Promise<boolean>;
}

export function createPostgresAiWatchInboundPort(pool: Pool): AiWatchInboundPort {
  return {
    async orgContext(organizationId) {
      const result = await pool.query<{ feature_allowed: boolean; owner_enabled: boolean; jobs_last_hour: number }>(
        'SELECT feature_allowed, owner_enabled, jobs_last_hour FROM ai_watch_org_context($1)',
        [organizationId],
      );
      const row = result.rows[0];
      return {
        featureAllowed: row?.feature_allowed === true,
        ownerEnabled: row?.owner_enabled === true,
        jobsLastHour: row?.jobs_last_hour ?? 0,
      };
    },
    async workerHealthy() {
      const result = await pool.query<{ healthy: boolean }>('SELECT ai_watch_worker_healthy() AS healthy');
      return result.rows[0]?.healthy === true;
    },
    async skipJob(jobId) {
      const result = await pool.query<{ skipped: boolean }>('SELECT ai_watch_skip_job($1) AS skipped', [jobId]);
      return result.rows[0]?.skipped === true;
    },
  };
}
