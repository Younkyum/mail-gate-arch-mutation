/**
 * src/db/repositories/inbound-read-store.ts — **에이전트 컨텍스트**의 수신 조회 (P3c).
 *
 * 계획 §6 P4: *"quarantine → 에이전트 컨텍스트 API 에서 제외"*. 이 파일이 그 문장의 집행 지점이다.
 *
 * ---------------------------------------------------------------------------
 * ★ 격리 메일은 이 파일의 어떤 함수로도 **행째** 나오지 않는다
 * ---------------------------------------------------------------------------
 *
 * 모든 조회가 `inbound_messages` 를 읽을 때 `visibleToAgent(alias)` 를 WHERE 에 건다. 라우트가 격리를 거르는
 * 구조(행을 받아서 `if (row.quarantined) return 404`)가 아니다 — 그 구조는 라우트 하나가 `if` 를 빠뜨리면 샌다.
 * 여기서는 **격리 행이 결과 집합에 들어오지 않으므로** 호출자가 실수할 재료가 없다. 반환 타입에 `quarantined`
 * 필드조차 없다.
 *
 * 술어는 두 겹이다: `NOT quarantined` **그리고** `injection_risk IS NOT NULL`. 판정 없음(스캐너 예외, P4 이전 행)은
 * DB CHECK(`inbound_messages_unscanned_is_quarantined`)가 이미 격리로 묶지만, 그 CHECK 하나에 에이전트 노출을
 * 걸지 않는다 — "판정 없음도 격리다"(D 의 규율)를 이 파일이 따로 한 번 더 말한다.
 *
 * **존재는 개수로만 새어 나간다** (`quarantineSummary`, 스레드의 `quarantinedCount`). 보낸 사람·제목·시각
 * 목록·id 는 없다 — 판단 근거는 `api/inbound-view.ts` 머리말.
 */

import type { Pool } from 'pg';

import type { AgentId, InboundSenderTrust, InjectionRisk, OutboundMessageStatus, SesVerdict, ThreadStarter } from '../schema';
import type { AiWatchBand, AiWatchJobState, AiWatchVerdict } from '../../inbound/ai-watch/contract';
import { aiWatchAgentStatus, type AiWatchAgentView } from '../../inbound/ai-watch/status';

/**
 * 격리 **개수**에 세는 행의 술어(정책 v2). 소유자가 수신 정책으로 막은 메일(`quarantine_reason = 'policy_blocked'`)은 개수에도
 * 들어가지 않는다 — 진윤겸 결정 ③ "에이전트에게 안 보임" 은 존재까지다(injection 격리는 에이전트가 "무언가 걸러졌다" 를 소유자에게
 * 알릴 근거라 개수를 남기지만, 정책 격리는 소유자가 이미 안다 — 콘솔 로그). 행째 나오지 않는 것은 `visibleToAgent` 가 이미 막는다.
 */
export function countedAsQuarantine(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `(NOT ${visibleToAgent(alias)} AND ${alias}.quarantine_reason IS DISTINCT FROM 'policy_blocked')`;
}

/**
 * 에이전트에게 보이는 수신 행의 술어. `alias` 는 SQL 식별자(테스트가 이 함수의 출력 모양을 단언한다).
 * **이 파일의 모든 `inbound_messages` 조회가 이것을 쓴다** — arch 테스트(`inbound-visibility.arch.test.ts`)가
 * 이 파일의 SQL 을 훑어 단언한다.
 */
export function visibleToAgent(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `(NOT ${alias}.quarantined AND ${alias}.injection_risk IS NOT NULL)`;
}

/**
 * AI 의심 메일 감시 보류(ADR-0017 초안 · 설계 §2.1)가 풀린 행의 술어 — `ai_hold_until` 전에는 에이전트에게 행째 보이지 않는다(최대 30초, DB CHECK).
 * `visibleToAgent` 와 **따로** 둔다: 그 술어는 부분 색인(202609260121)의 술어와 글자 그대로 같아야 하고, `now()` 는 색인 술어에 쓸 수 없다. 보류 행은
 * 소수라 필터 비용은 무시할 만하다. **이 파일의 에이전트 조회는 둘 다 건다** — 인증 코드 조회(`listVerificationSources`)의 **확정 모드**(발신 도메인 지정)만 예외다(진윤겸 Q3 · 보안 리뷰 M3 —
 * 코드는 기다리지 않는다, 받은 코드는 ADR-0016 DLP 지문이 지킨다). 격리 개수(`countedAsQuarantine`)는 보류와 무관하다(보류 행은 격리가 아니다).
 */
export function releasedToAgent(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `(${alias}.ai_hold_until IS NULL OR ${alias}.ai_hold_until <= now())`;
}

/**
 * `since` 폴링이 보류가 풀린 메일을 놓치지 않게(보안 리뷰 M5). 보류됐던 행은 `received_at` 이 과거라, "마지막으로 본 received_at" 을 `since` 로 쓰는
 * 에이전트는 그 사이 풀린 행을 건너뛸 수 있다. **AI 감시 작업에 이어진 행만**, 행이 기록된 시각(`created_at`, DB 시계)이 `since − 30초` 이후면 함께 준다.
 * 근거: 폴링 시각 T 에 보이지 않던 행 M 이 뒤에 풀렸다면 풀린 시각 v ≤ created_M + 30초(CHECK)이고 v > T ≥ since 이므로 created_M > since − 30초 —
 * 이 조건은 그런 행을 **전부** 포함한다(λ 지연과 무관 — 보류 상한이 DB 시계 기준이다). 대가: 작업이 있는 행 몇 개가 다음 폴링에 한 번 더 나올 수
 * 있다(id 로 중복 제거 — 문서). 정렬·커서·색인은 그대로다(`received_at` 순서를 바꾸지 않는다 — `visible_at` 정렬은 색인·커서 의미를 바꿔서 택하지 않았다).
 */
function heldOverlap(alias: string, since: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `(${alias}.ai_watch_job_id IS NOT NULL AND ${alias}.created_at >= ${since} - interval '30 seconds')`;
}

/**
 * 풀린 메일의 `since` 겹침(받기 등급 2026-10-08 · 적대적 검증 S-I19/S-H19). 소유자가 풀어 준 메일은 `received_at` 이 과거라 `heldOverlap` 과 같은 이유로 `since` 폴링이
 * 건너뛴다. **풀린 시각이 `since` 이후면** 함께 준다 — 근거는 `heldOverlap` 과 같다: 폴링 시각 T 에 숨어 있던 행이 뒤에 풀렸다면 풀린 시각 v > T ≥ since. 대가도 같다
 * (풀린 행이 다음 폴링에 한 번 더 나올 수 있다 — id 로 중복 제거). 부분 색인 `inbound_messages_released_idx (agent_id, released_at) WHERE released_at IS NOT NULL`(202610081006).
 */
function releasedSince(alias: string, since: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `(${alias}.released_at IS NOT NULL AND ${alias}.released_at >= ${since})`;
}

export interface VisibleInboundSummary {
  readonly id: string;
  readonly agentId: AgentId;
  /** 권한용 스레드. */
  readonly threadId: string;
  /** 이 메일을 받은 에이전트 자신의 주소(기본 주소 또는 별칭) — `inbound_messages.envelope_recipient`, 소문자. */
  readonly receivedAtAddress: string;
  readonly fromAddress: string;
  /** DMARC pass 만 `true`. 에이전트가 "이 발신자는 사칭일 수 있다" 를 알 수 있게 싣는다. */
  readonly fromAuthenticated: boolean;
  readonly subject: string | null;
  readonly receivedAt: Date;
  readonly attachmentCount: number;
  /** 보이는 행은 `none` 또는 `low` 뿐이다(격리 문턱 아래). */
  readonly injectionRisk: InjectionRisk;
  readonly senderTrust: InboundSenderTrust | null;
  /** SES 수신 판정(출처 표시 `provenance.auth` — ADR-0016 C). */
  readonly authVerdicts: { readonly spf: SesVerdict; readonly dkim: SesVerdict; readonly dmarc: SesVerdict };
  /**
   * AI 의심 메일 감시(ADR-0017 초안 · 경고 전용) — provenance `ai_watch`. 조직이 감시를 끈 때는 null(키 자체가 없다). 밴드는 없다(소유자 콘솔만).
   */
  readonly aiWatch: AiWatchAgentView | null;
}

export interface VisibleAttachment {
  readonly index: number;
  /** **표시 전용** — 경로 문자가 있을 수 있다. */
  readonly filename: string | null;
  /** 발신자가 선언한 값. 내용과 일치한다는 보장은 없다. */
  readonly declaredContentType: string;
  readonly disposition: 'attachment' | 'inline' | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
}

/** 첨부가 달린 메일의 신뢰 판정 — `VisibleInboundSummary` 의 같은 이름 필드와 같은 뜻. */
export interface AttachmentMessageTrust {
  readonly fromAuthenticated: boolean;
  readonly injectionRisk: InjectionRisk;
  readonly senderTrust: InboundSenderTrust | null;
}

export interface VisibleAttachmentLookup {
  readonly agentId: AgentId;
  readonly message: AttachmentMessageTrust;
  readonly attachment: VisibleAttachment;
}

export interface VisibleInboundDetail extends VisibleInboundSummary {
  readonly parsedStorageKey: string;
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly headerDate: Date | null;
  readonly attachments: readonly VisibleAttachment[];
}

export interface QuarantineSummary {
  /** 이 에이전트에게 온 격리(판정 없음 포함) 메일 수. **내용·발신자·id 없이 개수만.** */
  readonly count: number;
}

export type ThreadEntry =
  | {
      readonly direction: 'outbound';
      readonly id: string;
      readonly at: Date;
      readonly status: OutboundMessageStatus;
      readonly subject: string | null;
      readonly recipients: readonly string[];
      readonly messageIdHeader: string;
    }
  | {
      readonly direction: 'inbound';
      readonly id: string;
      readonly at: Date;
      readonly fromAddress: string;
      readonly fromAuthenticated: boolean;
      readonly subject: string | null;
      readonly attachmentCount: number;
      readonly injectionRisk: InjectionRisk;
      /** AI 의심 메일 감시(경고 전용) — `VisibleInboundSummary.aiWatch` 와 같다. */
      readonly aiWatch: AiWatchAgentView | null;
    };

export interface ThreadView {
  readonly id: string;
  readonly agentId: AgentId;
  readonly startedBy: ThreadStarter;
  readonly subjectNormalized: string | null;
  readonly createdAt: Date;
  readonly lastMessageAt: Date;
  /** 시간순(오래된 것 → 최근). 격리 수신은 없다. */
  readonly entries: readonly ThreadEntry[];
  readonly quarantinedCount: number;
}

export interface ListCursor {
  readonly receivedAt: Date;
  readonly id: string;
}

/**
 * 수신 목록 필터(메일 기본기 A5). 모두 선택이고 AND 로 묶인다. 격리 필터는 **없다** — 에이전트 표면은 격리를 보지 않는다(D3,
 * 소유자 콘솔만). `fromAddress`·`fromDomain` 은 정확 일치(소문자, 행의 CHECK 와 같은 모양)이고 둘 중 하나만 온다(라우트가 400).
 * 기간은 반열림 `[since, until)` 이다.
 */
export interface InboundListFilters {
  readonly fromAddress?: string;
  readonly fromDomain?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly threadId?: string;
  /** 묶음 B — 이 라벨이 붙은 메일만(`inbound_message_state.labels`). `unlabeled` 와 함께 오지 않는다(라우트가 400). */
  readonly label?: string;
  /** 묶음 B — 라벨이 하나도 없는 메일만. */
  readonly unlabeled?: boolean;
  /** 묶음 B — `true` 면 읽은(`first_read_at` 있음) 메일만, `false` 면 아직 읽지 않은 메일만. */
  readonly read?: boolean;
}

/** 인증코드 조회(메일 기본기 A1)가 읽는 행 — 보이는 행만. 본문은 `parsedStorageKey` 로 따로 읽는다. */
export interface VerificationSource {
  readonly id: string;
  readonly receivedAt: Date;
  /**
   * 발신 주소(소문자 `local@domain`, 행의 CHECK 와 같은 모양). 확정 모드가 알림형 로컬파트·공용 apex 의 사용자 주소를 거르고
   * (2회차 수정 Y1, 보안 R1 · 코드 N2), 응답 `from_address` 로 싣는다.
   */
  readonly fromAddress: string;
  readonly fromDomain: string;
  /** DMARC pass 만 `true`(`inbound_messages_authentication_is_dmarc`). */
  readonly fromAuthenticated: boolean;
  readonly parsedStorageKey: string;
  /** 헤더 제목(없으면 `null`). 확정 모드의 문(제목에 인증 키워드)과 후보 모드의 우선순위 — 본문(S3)을 읽기 **전에** 거른다. */
  readonly subject: string | null;
}

export interface VerificationSourceQuery {
  /** 반열림 `[since, until)`. */
  readonly since: Date;
  readonly until: Date;
  /** 확정 모드의 발신 도메인 — `from_domain` 정확 일치(`includeSubdomains` 면 하위도). 후보 모드는 `null`. */
  readonly sender: { readonly domain: string; readonly includeSubdomains: boolean } | null;
  /** `true` 면 DMARC pass 행만, `false` 면 fail 행만, `null` 이면 둘 다. */
  readonly authenticated: boolean | null;
  readonly limit: number;
  /**
   * 발신 도메인마다 최근 몇 통까지(후보 모드 — 한 도메인이 보낸 스팸 여러 통이 다른 사이트의 진짜 메일을 창 밖으로 밀어내지 않게).
   * 없으면 제한 없음.
   */
  readonly perDomainLimit?: number;
  /** `true` 면 DMARC pass 행을 먼저(각 무리 안에서는 최근 것부터). 기본 `false`(최근 것부터). */
  readonly authenticatedFirst?: boolean;
  /** 도메인별 제한·정렬 전에 보는 최근 행 수(기간 안 행이 아무리 많아도 조회 비용의 상한). 기본 `limit`. */
  readonly recentLimit?: number;
}

export interface InboundReadStore {
  /** 최근 것부터. `cursor` 는 직전 페이지의 마지막 행(그 행은 포함하지 않는다). */
  listVisible(
    agentId: AgentId,
    options: { readonly limit: number; readonly cursor: ListCursor | null; readonly filters?: InboundListFilters },
  ): Promise<readonly VisibleInboundSummary[]>;
  /** 인증코드 조회의 원천 — 이 에이전트의 **보이는** 수신 중 조건에 맞는 것, 최근 것부터. */
  listVerificationSources(agentId: AgentId, query: VerificationSourceQuery): Promise<readonly VerificationSource[]>;
  quarantineSummary(agentId: AgentId): Promise<QuarantineSummary>;
  /** **보이는 행만.** 격리·없음은 똑같이 `null` 이다. 에이전트 범위로 묶지 않는다 — 소유자 판정은 호출자가 행의 `agentId` 로(403). */
  findVisible(inboundMessageId: string): Promise<VisibleInboundDetail | null>;
  /** 스레드 행 + 보이는 항목들. 스레드가 없으면 `null`. */
  threadView(threadId: string): Promise<ThreadView | null>;
  /** 보이는 수신의 첨부 하나 + 그 메일의 신뢰 판정(첨부 내용을 읽는 쪽이 함께 싣는다). 격리 메일의 첨부는 `null`. */
  findVisibleAttachment(inboundMessageId: string, index: number): Promise<VisibleAttachmentLookup | null>;
}

interface SummaryRow {
  id: string;
  agent_id: AgentId;
  thread_id: string;
  envelope_recipient: string;
  from_address: string;
  from_authenticated: boolean;
  subject: string | null;
  received_at: Date;
  attachment_count: number;
  injection_risk: InjectionRisk;
  sender_trust: InboundSenderTrust | null;
  spf_verdict: SesVerdict;
  dkim_verdict: SesVerdict;
  dmarc_verdict: SesVerdict;
  ai_watch_org_enabled: boolean | null;
  ai_watch_job: AiWatchJobRow | null;
}

/** `SUMMARY_COLUMNS` 의 작업 칸 JSON(`json_build_object` — 시각은 ISO 문자열). */
interface AiWatchJobRow {
  state: AiWatchJobState;
  verdict: AiWatchVerdict | null;
  band: AiWatchBand | null;
  model_version: string | null;
  late: boolean;
  shadow: boolean;
  deadline: string;
}

interface AttachmentRow {
  part_index: number;
  filename: string | null;
  content_type: string;
  disposition: 'attachment' | 'inline' | null;
  size_bytes: string;
  sha256: string;
  storage_key: string;
}

/**
 * 요약 칸. AI 감시 두 칸은 **SELECT 목록의 상관 부분질의**다 — WHERE·정렬에 닿지 않아 목록의 색인 계획(AC-A5-4)이 그대로다. 조직 토글은 소유자가 켠
 * 것이고(켜기는 허용 목록 가드), 작업은 `ai_watch_job_id` 하나로 찾는다(PK).
 */
const SUMMARY_COLUMNS = `m.id, m.agent_id, m.thread_id, m.envelope_recipient, m.from_address, m.from_authenticated, m.subject, m.received_at,
       m.attachment_count, m.injection_risk, m.sender_trust, m.spf_verdict, m.dkim_verdict, m.dmarc_verdict,
       (SELECT o.ai_mail_watch_enabled FROM agents ag JOIN organizations o ON o.id = ag.organization_id WHERE ag.id = m.agent_id) AS ai_watch_org_enabled,
       (SELECT json_build_object('state', j.state, 'verdict', j.verdict, 'band', j.band, 'model_version', j.model_version,
                                 'late', j.late, 'shadow', j.shadow, 'deadline', j.deadline)
          FROM ai_watch_jobs j WHERE j.job_id = m.ai_watch_job_id) AS ai_watch_job`;

/**
 * 에이전트 수신 목록 SQL(파라미터: 1 agent · 2·3 커서 · 4 limit · 5 from_address · 6 from_domain · 7 since · 8 until · 9 thread · 10 label · 11 unlabeled · 12 read — 묶음 B).
 * 필터는 **정적 SQL 의 NULL 가지**다 — 값이 바인딩되면 플래너가 `NULL IS NULL` 가지를 접어 발신자 필터가 기존 `inbound_messages_agent_from_idx (agent_id, from_address)` 를, 도메인 필터가 부분 색인(202609260121)을 탄다.
 * export 는 그 EXPLAIN 을 보는 통합 테스트(AC-A5-4)가 같은 글자를 쓰게 하려는 것이다.
 */
/** 목록 두 가지가 같이 쓰는 필터 — 커서 · 발신자 · 도메인 · until · 스레드. 보임 술어 둘과 `since` 는 SQL 본문에 적는다(arch `inbound-visibility` ①). */
function listFilters(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`SQL 별칭이 아니다: ${alias}`);
  return `($2::timestamptz IS NULL OR (${alias}.received_at, ${alias}.id) < ($2::timestamptz, $3::uuid))
            AND ($5::text IS NULL OR ${alias}.from_address = $5::text)
            AND ($6::text IS NULL OR ${alias}.from_domain = $6::text)
            AND ($8::timestamptz IS NULL OR ${alias}.received_at < $8::timestamptz)
            AND ($9::uuid IS NULL OR ${alias}.thread_id = $9::uuid)
            AND ($10::text IS NULL OR EXISTS (SELECT 1 FROM inbound_message_state ls WHERE ls.inbound_message_id = ${alias}.id AND ls.labels @> ARRAY[$10::text]))
            AND ($11::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM inbound_message_state ls WHERE ls.inbound_message_id = ${alias}.id AND cardinality(ls.labels) > 0))
            AND ($12::boolean IS NULL OR EXISTS (SELECT 1 FROM inbound_message_state ls WHERE ls.inbound_message_id = ${alias}.id AND ls.first_read_at IS NOT NULL) = $12::boolean)`;
}

/**
 * 두 가지의 UNION ALL(재검증 M3 — 한 술어의 OR 는 `(agent_id, received_at)` 색인의 범위 탐색을 막는다):
 *   ① 본 가지 — `received_at >= since`(또는 since 없음). `inbound_messages_agent_received_idx` 범위 탐색 그대로.
 *   ② 겹침 가지 — since 가 있을 때만: AI 감시 작업이 이어진 행 중 `received_at < since` 이고 `created_at >= since − 30초`(`heldOverlap`).
 *      부분 색인 `inbound_messages_ai_watch_created_idx (agent_id, created_at) WHERE ai_watch_job_id IS NOT NULL`(202610061103)을 탄다.
 *   ③ 풀린 가지 — since 가 있을 때만: 소유자가 풀어 준 행 중 `received_at < since` 이고 `released_at >= since`(`releasedSince` · 색인 202610081006).
 *   ①·② 는 `received_at` 조건이 서로소라 중복이 없다(UNION ALL). ②·③ 이 겹치면 같은 id 가 두 번 나오지만 바깥 `IN` 이 하나로 본다.
 *   각 가지가 LIMIT 까지 뽑고, 바깥이 같은 순서·LIMIT 으로 다시 자른다.
 */
export const LIST_VISIBLE_SQL = `SELECT ${SUMMARY_COLUMNS}
           FROM inbound_messages m
          WHERE m.id IN (
                  (SELECT a.id FROM inbound_messages a
                    WHERE a.agent_id = $1 AND ${visibleToAgent('a')} AND ${releasedToAgent('a')} AND ${listFilters('a')}
                      AND ($7::timestamptz IS NULL OR a.received_at >= $7::timestamptz)
                    ORDER BY a.received_at DESC, a.id DESC
                    LIMIT $4)
                  UNION ALL
                  (SELECT b.id FROM inbound_messages b
                    WHERE $7::timestamptz IS NOT NULL AND b.agent_id = $1 AND ${visibleToAgent('b')} AND ${releasedToAgent('b')} AND ${listFilters('b')}
                      AND b.received_at < $7::timestamptz AND ${heldOverlap('b', '$7::timestamptz')}
                    ORDER BY b.received_at DESC, b.id DESC
                    LIMIT $4)
                  UNION ALL
                  (SELECT c.id FROM inbound_messages c
                    WHERE $7::timestamptz IS NOT NULL AND c.agent_id = $1 AND ${visibleToAgent('c')} AND ${releasedToAgent('c')} AND ${listFilters('c')}
                      AND c.received_at < $7::timestamptz AND ${releasedSince('c', '$7::timestamptz')}
                    ORDER BY c.received_at DESC, c.id DESC
                    LIMIT $4))
            AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}
          ORDER BY m.received_at DESC, m.id DESC
          LIMIT $4`;

function toSummary(row: SummaryRow): VisibleInboundSummary {
  return {
    id: row.id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    receivedAtAddress: row.envelope_recipient,
    fromAddress: row.from_address,
    fromAuthenticated: row.from_authenticated,
    subject: row.subject,
    receivedAt: row.received_at,
    attachmentCount: row.attachment_count,
    injectionRisk: row.injection_risk,
    senderTrust: row.sender_trust,
    authVerdicts: { spf: row.spf_verdict, dkim: row.dkim_verdict, dmarc: row.dmarc_verdict },
    aiWatch: aiWatchAgentStatus(
      row.ai_watch_org_enabled === true,
      row.ai_watch_job === null
        ? null
        : {
            state: row.ai_watch_job.state,
            verdict: row.ai_watch_job.verdict,
            band: row.ai_watch_job.band,
            modelVersion: row.ai_watch_job.model_version,
            late: row.ai_watch_job.late,
            shadow: row.ai_watch_job.shadow,
            deadline: new Date(row.ai_watch_job.deadline),
          },
    ),
  };
}

function toAttachment(row: AttachmentRow): VisibleAttachment {
  return {
    index: row.part_index,
    filename: row.filename,
    declaredContentType: row.content_type,
    disposition: row.disposition,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageKey: row.storage_key,
  };
}

export function createPostgresInboundReadStore(pool: Pool): InboundReadStore {
  return {
    async listVisible(agentId, options) {
      // 필터는 **정적 SQL 의 NULL 가지**로 건다(문자열 조립 없이 — arch ① 이 이 SQL 을 통째로 본다). 발신자 필터는 `inbound_messages_agent_from_idx`
      // 를, 도메인 필터는 부분 인덱스(202609260121 — 술어가 `visibleToAgent` 와 같다)를 탄다(`LIST_VISIBLE_SQL`).
      const filters = options.filters ?? {};
      const result = await pool.query<SummaryRow>(
        LIST_VISIBLE_SQL,
        [
          agentId,
          options.cursor?.receivedAt ?? null,
          options.cursor?.id ?? null,
          options.limit,
          filters.fromAddress ?? null,
          filters.fromDomain ?? null,
          filters.since ?? null,
          filters.until ?? null,
          filters.threadId ?? null,
          // 묶음 B — 라벨 · 라벨 없음 · 읽음(정적 SQL 의 NULL 가지 — `listFilters`).
          filters.label ?? null,
          filters.unlabeled === true ? true : null,
          filters.read ?? null,
        ],
      );
      return result.rows.map(toSummary);
    },

    async listVerificationSources(agentId, query) {
      // 안쪽: 기간 안의 **보이는** 최근 행 `recentLimit` 개(색인 순서로 멈춘다). 가운데: 발신 도메인별 순위. 바깥: 도메인별 상한 ·
      // (선택) DMARC pass 먼저 · 최근 것부터 · `limit`. 모두 정적 SQL 의 NULL 가지다(문자열 조립 없음 — arch ① 이 이 SQL 을 통째로 본다).
      const result = await pool.query<{
        id: string;
        received_at: Date;
        from_address: string;
        from_domain: string;
        from_authenticated: boolean;
        parsed_storage_key: string;
        subject: string | null;
      }>(
        `SELECT r.id, r.received_at, r.from_address, r.from_domain, r.from_authenticated, r.parsed_storage_key, r.subject
           FROM (SELECT recent.*,
                        row_number() OVER (PARTITION BY recent.from_domain ORDER BY recent.received_at DESC, recent.id DESC) AS domain_rank
                   FROM (SELECT m.id, m.received_at, m.from_address, m.from_domain, m.from_authenticated, m.parsed_storage_key, m.subject
                           FROM inbound_messages m
                          WHERE m.agent_id = $1 AND ${visibleToAgent('m')}
                            -- AI 감시 보류(보안 리뷰 M3): 확정 모드(발신 도메인 지정 — $4)만 보류를 보지 않는다(Q3). 후보 모드는 발신자를 고르지 않아
                            --   보류 중 메일의 id·발신자·토큰을 줄 수 있으므로 보류를 지킨다.
                            AND ($4::text IS NOT NULL OR ${releasedToAgent('m')})
                            AND m.received_at >= $2::timestamptz AND m.received_at < $3::timestamptz
                            AND ($4::text IS NULL OR m.from_domain = $4::text
                                 OR ($5::boolean AND right(m.from_domain, char_length($4::text) + 1) = '.' || $4::text))
                            AND ($6::boolean IS NULL OR m.from_authenticated = $6::boolean)
                          ORDER BY m.received_at DESC, m.id DESC
                          LIMIT $8) recent) r
          WHERE ($9::integer IS NULL OR r.domain_rank <= $9::integer)
          ORDER BY ($10::boolean AND r.from_authenticated) DESC, r.received_at DESC, r.id DESC
          LIMIT $7`,
        [
          agentId,
          query.since,
          query.until,
          query.sender?.domain ?? null,
          query.sender?.includeSubdomains ?? false,
          query.authenticated,
          query.limit,
          Math.max(query.recentLimit ?? query.limit, query.limit),
          query.perDomainLimit ?? null,
          query.authenticatedFirst ?? false,
        ],
      );
      return result.rows.map((row) => ({
        id: row.id,
        receivedAt: row.received_at,
        fromAddress: row.from_address,
        fromDomain: row.from_domain,
        fromAuthenticated: row.from_authenticated,
        parsedStorageKey: row.parsed_storage_key,
        subject: row.subject,
      }));
    },

    async quarantineSummary(agentId) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_messages m WHERE m.agent_id = $1 AND ${countedAsQuarantine('m')}`,
        [agentId],
      );
      return { count: Number(result.rows[0]?.count ?? '0') };
    },

    async findVisible(inboundMessageId) {
      const result = await pool.query<
        SummaryRow & { parsed_storage_key: string; message_id_header: string | null; in_reply_to: string | null; header_date: Date | null }
      >(
        `SELECT ${SUMMARY_COLUMNS}, m.parsed_storage_key, m.message_id_header, m.in_reply_to, m.header_date
           FROM inbound_messages m
          WHERE m.id = $1 AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}`,
        [inboundMessageId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const attachments = await pool.query<AttachmentRow>(
        `SELECT a.part_index, a.filename, a.content_type, a.disposition, a.size_bytes::text AS size_bytes, a.sha256, a.storage_key
           FROM inbound_attachments a
           JOIN inbound_messages m ON m.id = a.inbound_message_id
          WHERE a.inbound_message_id = $1 AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}
          ORDER BY a.part_index`,
        [inboundMessageId],
      );
      return {
        ...toSummary(row),
        parsedStorageKey: row.parsed_storage_key,
        messageIdHeader: row.message_id_header,
        inReplyTo: row.in_reply_to,
        headerDate: row.header_date,
        attachments: attachments.rows.map(toAttachment),
      };
    },

    async threadView(threadId) {
      // ★ 스레드 행의 값은 **그 스레드를 연 메일에서** 왔다(외부 스레드: 제목·생성 시각). 연 메일이 격리면 그 값은
      //   격리 메일의 제목·도착 시각이다 — 같은 발신자가 그 Message-ID 에 평범한 회신 한 통을 붙이면 스레드가
      //   보이게 되고, 격리 메일의 제목이 스레드 제목으로 샌다(검증 V2). 그래서 연 메일(`new_thread_reason` 이
      //   있는 행 — 스레드를 연 수신은 정확히 그 한 행이다)이 **보이는** 경우에만 행의 값을 쓴다. 에이전트가 연
      //   스레드는 에이전트 자신의 값이다.
      const thread = await pool.query<{
        id: string;
        agent_id: AgentId;
        started_by: ThreadStarter;
        subject_normalized: string | null;
        created_at: Date;
        opener_visible: boolean;
      }>(
        `SELECT t.id, t.agent_id, t.started_by, t.subject_normalized, t.created_at,
                (t.started_by = 'agent' OR EXISTS (
                   SELECT 1 FROM inbound_messages o
                    WHERE o.thread_id = t.id AND o.agent_id = t.agent_id AND o.new_thread_reason IS NOT NULL
                      AND ${visibleToAgent('o')} AND ${releasedToAgent('o')})) AS opener_visible
           FROM threads t WHERE t.id = $1`,
        [threadId],
      );
      const head = thread.rows[0];
      if (head === undefined) return null;

      // 발신 — 이 에이전트가 보낸(또는 시도한) 것. 수신자는 `outbound_recipients` 에서.
      const outbound = await pool.query<{
        id: string;
        created_at: Date;
        sent_at: Date | null;
        status: OutboundMessageStatus;
        subject: string | null;
        message_id_header: string;
        recipients: string[] | null;
      }>(
        `SELECT o.id, o.created_at, o.sent_at, o.status, o.subject, o.message_id_header,
                array_agg(r.address ORDER BY r.address) FILTER (WHERE r.address IS NOT NULL) AS recipients
           FROM messages o
           LEFT JOIN outbound_recipients r ON r.message_id = o.id
          WHERE o.thread_id = $1 AND o.agent_id = $2 AND o.direction = 'outbound'
          GROUP BY o.id`,
        [threadId, head.agent_id],
      );
      const inbound = await pool.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}
           FROM inbound_messages m
          WHERE m.thread_id = $1 AND m.agent_id = $2 AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}`,
        [threadId, head.agent_id],
      );
      const hidden = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_messages m
          WHERE m.thread_id = $1 AND m.agent_id = $2 AND ${countedAsQuarantine('m')}`,
        [threadId, head.agent_id],
      );

      const entries: ThreadEntry[] = [
        ...outbound.rows.map(
          (row): ThreadEntry => ({
            direction: 'outbound',
            id: row.id,
            at: row.sent_at ?? row.created_at,
            status: row.status,
            subject: row.subject,
            recipients: row.recipients ?? [],
            messageIdHeader: row.message_id_header,
          }),
        ),
        ...inbound.rows.map(
          (row): ThreadEntry => ({
            direction: 'inbound',
            id: row.id,
            at: row.received_at,
            fromAddress: row.from_address,
            fromAuthenticated: row.from_authenticated,
            subject: row.subject,
            attachmentCount: row.attachment_count,
            injectionRisk: row.injection_risk,
            aiWatch: toSummary(row).aiWatch,
          }),
        ),
      ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));

      // 시각도 보이는 항목에서 만든다. `threads.last_message_at` 은 격리 메일의 도착에도 밀리고(inbound-store 가
      // 격리 여부와 무관하게 갱신한다), 격리 메일로 열린 스레드의 `created_at` 은 그 메일의 도착 시각이다 —
      // 둘 다 "격리 메일이 언제 왔는가" 를 알린다. 존재는 `quarantinedCount` 로만 샌다(머리말).
      const first = entries[0];
      const last = entries[entries.length - 1];
      return {
        id: head.id,
        agentId: head.agent_id,
        startedBy: head.started_by,
        subjectNormalized: head.opener_visible ? head.subject_normalized : null,
        createdAt: head.opener_visible || first === undefined ? head.created_at : first.at,
        lastMessageAt: last === undefined ? head.created_at : last.at,
        entries,
        quarantinedCount: Number(hidden.rows[0]?.count ?? '0'),
      };
    },

    async findVisibleAttachment(inboundMessageId, index) {
      const result = await pool.query<
        AttachmentRow & { agent_id: AgentId; from_authenticated: boolean; injection_risk: InjectionRisk; sender_trust: InboundSenderTrust | null }
      >(
        `SELECT m.agent_id, m.from_authenticated, m.injection_risk, m.sender_trust,
                a.part_index, a.filename, a.content_type, a.disposition, a.size_bytes::text AS size_bytes, a.sha256, a.storage_key
           FROM inbound_attachments a
           JOIN inbound_messages m ON m.id = a.inbound_message_id
          WHERE m.id = $1 AND a.part_index = $2 AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}`,
        [inboundMessageId, index],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        agentId: row.agent_id,
        message: { fromAuthenticated: row.from_authenticated, injectionRisk: row.injection_risk, senderTrust: row.sender_trust },
        attachment: toAttachment(row),
      };
    },
  };
}
