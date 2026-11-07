/**
 * src/api/outbound-service.ts — 발송 경로 4종이 **공유하는 전후처리**.
 *
 * 관문 호출 자체는 여기 없다. `dispatch(...)` 는 각 라우트 파일 안에 있고, 그것이
 * Layer C 가 요구하는 "등록된 진입점은 실제로 관문을 import 한다" 를 **타입 import 가
 * 아니라 실제 호출로** 만족시킨다. 이 파일이 `dispatch` 를 감싸 버리면 라우트들은
 * 관문을 타입으로만 알게 되고, 매니페스트 등록은 알리바이가 된다.
 *
 * 그래서 이 파일은 관문의 **앞**과 **뒤**만 맡는다:
 *
 *   앞 (`prepareOutbound`)  — 멱등 키로 `messages` 행을 만들거나(최초) 기존 결과를 찾고(재호출),
 *                             `Message-ID` 를 전송 **전에** 확정하고, 본문을 저장한다.
 *   뒤 (`finalizeOutbound`) — 관문이 **반환만 한** 결과를 `messages` 행에 확정한다.
 *
 * **관문은 결과를 저장하지 않는다.** `gate.dispatch` 는 `{kind:'sent'|'failed'}` 를
 * 돌려줄 뿐이고, `settleSent`/`settleFailed` 를 부르는 것은 호출자다. `lease_id` 가
 * 그 UPDATE 의 WHERE 에 들어가므로 **lease 를 잃은 워커는 0행을 바꾼다** — 만료 후
 * 다른 워커가 가져간 메시지의 결과를 돌아온 워커가 덮어쓰지 못한다.
 */

import { randomUUID } from 'node:crypto';

import { SNIPPET_MAX_LENGTH, type AgentId } from '../db/schema';
import { isReceiveOnlyAddress } from '../identity/address';
import type { MessageDispatchStore } from '../db/repositories/lease-store';
import { AttachmentLinkLimitError } from '../db/repositories/outbound-attachment-store';
import { log } from '../observability/logger';
import { countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import { domainOf, generateMessageIdHeader } from '../mail/message-id';
import type {
  AuditSink,
  DispatchOutcome,
  DispatchRequest,
  DispatchSerializer,
  GateDependencies,
  OutboundTransport,
  SendEvidenceLookup,
} from '../policy/gate';
import { comparableAddress, type PolicySource } from '../policy/policy-loader';
import { resolveRiskHold, type RiskSignalSource } from '../policy/risk-signals';
import type { ContentShape, Decision } from '../policy/types';
import type { DlpSignalStore } from '../db/repositories/dlp-signal-store';
import { registrableDomainOf } from '../domains/psl';
import { DLP_HOLD_REASON } from '../policy/rules/risk-hold';
import { fingerprintCode, fingerprintLink } from '../security/dlp/codes';
import { DLP_FAMILIES, scanOutbound, type DlpFamily, type InboundCopySource } from '../security/dlp/scan';
import { inboundShingles } from '../security/dlp/shingle';
import { fold } from '../security/injection/normalize';
import type { HmacKeyring } from '../security/hmac-keyring';
import { MessageContentAlreadyStoredError, type MessageContentStore, type MessageContentThreading } from './content-store';
import { isAttachmentRejection, linkLimitRejection, type OutboundAttachmentService, type ValidatedAttachments } from './outbound-attachments';
import {
  hashOutboundRequest,
  type OutboundMessageSnapshot,
  type OutboundMessageStore,
} from './outbound-store';

/** `messages.subject` 컬럼의 CHECK 상한. SMTP 헤더 한 줄의 한계이기도 하다. */
export const MAX_SUBJECT_LENGTH = 998;

/**
 * 관문 **앞** 구간(INSERT → 본문 저장 → 관문의 audit)의 임대 길이(초). 이 시간 안의 같은 키 재호출은 첫 시도가 아직
 * 가는 중이라고 보고 재생한다. 관문 앞 구간은 초 단위이고(SES 호출은 이 구간 밖 — lease 가 따로 덮는다) 요청
 * 타임아웃보다 길면 된다. 넘기면 생기는 일은 중복 **평가**(audit 2행)이지 중복 **발송**이 아니다(lease).
 */
export const PREPARE_CLAIM_SECONDS = 60;

export interface OutboundServiceDependencies {
  readonly source: PolicySource;
  readonly audit: AuditSink;
  /** lease 취득(관문이 쓴다) + 결과 확정(이 파일이 쓴다). 같은 저장소여야 한다. */
  readonly dispatchStore: MessageDispatchStore;
  /** 평가~lease 구간의 조직 단위 직렬화(R22). 없으면 워밍업 캡은 순차 실행에서만 성립한다. */
  readonly serializer: DispatchSerializer;
  /**
   * lease 만료 재전송 전 SES 이벤트 조회(ADR-0004). **`GateDependencies` 에서는
   * optional 이지만 여기서는 필수다.**
   *
   * 관문은 미배선을 `unknown` 으로 읽어 재전송을 유보하므로 안전하게 실패한다. 그런데
   * 그 안전은 **아무 메일도 재전송되지 않는 상태**이고, 조용하다. 서비스 조립 루트는
   * 운영 배포가 지나는 유일한 지점이므로 여기서는 타입이 배선을 강제한다 — 실수할 수
   * 있는 자리를 실수할 수 없게 만드는 게 이 저장소가 `DenyOnly` 에서 한 것과 같은 일이다.
   */
  readonly sendEvidence: SendEvidenceLookup;
  readonly messages: OutboundMessageStore;
  readonly content: MessageContentStore;
  /** lease TTL. 워커 최대 실행시간보다 길면 만료 전에 죽은 워커의 메시지가 묶인다. */
  readonly leaseTtlSeconds: number;
  readonly now: () => Date;
  /**
   * 발신 첨부(메일 기본기 2차 A2). **없으면 첨부를 받지 않는다**(`attachments` 가 있는 요청은 400 `attachments_disabled`). 스위치가 꺼져
   * 있어도 조립한다 — 승인 릴리스가 이미 결속된 첨부의 Stage 6 메타를 읽어야 한다(`metaForMessage`).
   */
  readonly attachments?: OutboundAttachmentService;
  /**
   * **위험 신호**(ADR-0016 A — `policy/risk-signals.ts`). 관문(`GateDependencies.riskSignals`)으로 넘긴다. `sendEvidence` 와 같은 규율로 **여기서는
   * 필수**다 — 운영 조립 루트가 지나는 유일한 지점에서 타입이 배선을 강제한다(관문 쪽 optional 은 단위 테스트 대역을 위한 것).
   */
  readonly riskSignals: RiskSignalSource;
  /** **발신 DLP**(ADR-0016 B). 관문 앞에서 서버가 조립한 최종 내용을 본다(`prepare`). 필수 — 위와 같은 이유. */
  readonly dlp: OutboundDlpDependencies;
}

/** 발신 DLP 의 재료 — 지문 키(`atmark/dlp-keys`)와 지문 저장소(코드 24시간 · 받은 메일 30일). */
export interface OutboundDlpDependencies {
  readonly keyring: HmacKeyring;
  readonly signals: DlpSignalStore;
}

/** 한 번의 발송 시도. 라우트가 HTTP 본문에서 여기까지 번역한다. */
export interface OutboundSendRequest {
  /** `OUTBOUND_ROUTES` 의 `id`. 관문이 매니페스트와 대조한다. */
  readonly routeId: string;
  readonly agentId: AgentId;
  readonly idempotencyKey: string;
  readonly fromAddress: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  /**
   * **리터럴 `false` 다 — 호출자가 스레드 회신을 주장할 자리가 없다** (P3b). 회신은 `prepareReplyOutbound` 로만 만들고 스레드는
   * 주장으로만 싣는다 — 회신 여부는 로더가 DB 에서 다시 확인한다(`policy-loader.resolveThreadReply`). 호출자가 적는 `false` 한 줄이
   * "이 경로는 회신이 아니다" 를 말하게 필드를 남긴다.
   */
  readonly isThreadReply: false;
  readonly traceId: string | null;
  /** Stage 5 가 예산에 더해 판정한다. 0 이면 이 시도는 예산을 소비하지 않는다. */
  readonly costCents: number;
  /**
   * 첨부 id(업로드 생성이 준 것) — **새 메일(`send`)·답장(`reply`)만**(D8). 다른 경로는 라우트가 400 으로 끊는다. 없거나 비면 첨부 없는 메일
   * (요청 해시도 예전과 같다).
   */
  readonly attachmentIds?: readonly string[];
  /**
   * **예약 행에 고정된 위험**(ADR-0016 리뷰 H1) — 예약 발송 워커만 싣는다(`scheduled_sends.risk_tainted` · `risk_dlp`). 발송 때의 판정과 합친다
   * (엄한 쪽): 계열은 합집합, 오염 맥락은 OR. 다른 경로는 비운다.
   */
  readonly pinnedRisk?: PinnedRisk;
  /**
   * **결정론적 DLP 계열**(리뷰 H3) — 라우트가 지문 비교 없이 확정한 계열(전달: 원 발신자가 아닌 수신자 → `inbound_copy`, 원문 코드 → `verification_code`).
   * 스캔 결과와 합친다. 서버 코드만 싣는다(요청 본문에는 자리가 없다).
   */
  readonly extraDlp?: readonly DlpFamily[];
  /**
   * **복사 비교에 무조건 넣을 받은 메일**(재검증 N2 ①) — 회신 라우트가, 수신자 중 대상 메일 발신자가 아닌 주소가 있을 때 그 대상 메일을 싣는다.
   * 저장된 복사 지문(`inbound_fingerprints`)의 유무와 무관하게 이 자리에서 지문화해 비교한다(전달 H3 와 같은 취지). 서버 코드만 싣는다.
   */
  readonly copyTargets?: readonly CopyTarget[];
}

/** 복사 비교에 넣을 받은 메일 한 통(재검증 N2 ①). 원문은 이 요청 안에서만 쓰고 저장하지 않는다. */
export interface CopyTarget {
  readonly inboundMessageId: string;
  readonly threadId: string;
  /** 그 메일의 발신 주소(소문자). */
  readonly senderAddress: string;
  /** 제목 · text · HTML 변환 텍스트를 이은 것 — 8-gram 지문용. */
  readonly text: string;
  /** 그 메일의 코드 후보와 URL 토큰(라우트가 추출기로 뽑는다 — 발송 폐포는 추출기를 import 하지 않는다). */
  readonly secrets: readonly { readonly code: string; readonly kind?: 'code' | 'link' }[];
}

/** 예약을 만들 때 고정하는 위험(리뷰 H1). 값 없음 — 계열 이름과 참/거짓뿐. */
export interface PinnedRisk {
  readonly tainted: boolean;
  readonly dlp: readonly DlpFamily[];
}

/**
 * 발송 시도의 결말. **HTTP 를 모른다** — 워커도 같은 타입을 돌려주기 때문이다.
 * 상태코드 번역은 `toApiResponse`(아래)가 하고, 워커는 이 값을 그대로 쓴다.
 */
export type OutboundOutcome =
  | { readonly kind: 'sent'; readonly messageId: string; readonly messageIdHeader: string; readonly sesMessageId: string; readonly decision: Decision; readonly settled: boolean }
  | { readonly kind: 'denied'; readonly messageId: string; readonly decision: Decision }
  | {
      readonly kind: 'pending_approval';
      readonly messageId: string;
      readonly decision: Decision;
      /** 이 시도가 연 승인 요청(§3.4 1조 — 응답에 `approval_id`·`expires_at`). 릴리스 무효면 `null`. */
      readonly approval: { readonly approvalId: string; readonly expiresAt: Date } | null;
    }
  | { readonly kind: 'failed'; readonly messageId: string; readonly reason: string; readonly decision: Decision }
  /** 같은 멱등 키의 재호출. **새 평가도 새 발송도 없다** (§4.5-1). */
  | { readonly kind: 'replayed'; readonly message: OutboundMessageSnapshot }
  /** 같은 멱등 키인데 요청이 다르다. 최초 결과를 조용히 돌려주면 차이가 어디에도 안 남는다. */
  | { readonly kind: 'conflict'; readonly messageId: string; readonly detail: string }
  /** 입력이 규격 밖이다. 관문에 닿기 전에 끝난다. */
  | { readonly kind: 'invalid'; readonly detail: string }
  /**
   * 첨부 검증에서 멈췄다(A2 — 소유·만료·업로드·스캔·내용 모양). 관문에 닿기 전이고 메시지 행도 없다 — 결속 천장 경합(409
   * `attachment_link_limit`, 보안 리뷰 N1)만 행이 생긴 뒤이고, 그 행은 `denied` 로 굳는다.
   */
  | { readonly kind: 'attachment_rejected'; readonly status: 400 | 403 | 404 | 409 | 429 | 503; readonly code: string; readonly detail: string };

/**
 * 회신의 대상 — **라우트가 DB 에서 찾은** 수신 메일 (P3b, `routes/reply.ts`).
 *
 * `threadId` 는 그 메일의 **권한용** `thread_id` 다(`display_thread_id` 가 아니다). 그래도 관문에는 주장으로만
 * 간다 — 로더가 에이전트 소유·인증 발신자·수신자 대조를 다시 한다. 라우트의 조회와 로더의 검증이 둘인
 * 이유: 라우트는 "무엇에 답하는가(헤더·수신자)" 를 정하고, 로더는 "그래서 승인이 필요한가" 를 정한다.
 */
export interface OutboundReplyTarget {
  readonly threadId: string;
  /** `inbound_messages.id`. 멱등 해시에 들어간다 — 같은 키로 다른 메일에 답하면 409. */
  readonly inboundMessageId: string;
  /** `In-Reply-To`·`References`. 받은 메일의 `Message-ID` 가 모양이 아니면 `null`(헤더 없이 보낸다). */
  readonly threading: MessageContentThreading | null;
}

/**
 * 본문 모양 — **실제로 나갈 본문에서** 계산한다(호출자의 주장이 아니다). `auto_approve_verification_senders`
 * 의 "본문에 코드 회신만"(§3.4 3조) 전제가 이 값 하나를 읽는다.
 *
 * `code_only` 는 좁게 정의한다: html 파트 없음, 앞뒤 공백을 뺀 평문이 **한 토큰**(영숫자와 `-`, 4~32자,
 * 숫자 1개 이상). 링크(`:`·`/`·`.`)·공백·문장은 전부 `other` 다. 판단이 애매하면 `other` — 그 문은 닫힌다.
 */
const CODE_ONLY = /^(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]{3,31}$/;

export function classifyContentShape(text: string, html: string | null, attachmentCount = 0): ContentShape {
  // 첨부가 있으면 "코드 한 줄" 이 아니다(AC-A2-8) — 인증 발신자 자동 승인 문이 첨부 달린 메일에 열리지 않는다.
  return attachmentCount === 0 && html === null && CODE_ONLY.test(text.trim()) ? 'code_only' : 'other';
}

/** 본문 미리보기의 모양을 흐리는 문자 — C0·C1 제어문자(개행·탭 포함)와 줄/문단 구분자. 공백 하나로 접는다. */
const SNIPPET_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/**
 * `messages.snippet` 의 값 (US-004) — **실제로 나갈 평문 본문**의 앞 ≤ `SNIPPET_MAX_LENGTH`(512) 코드포인트, 한 줄로 접은 것.
 * 빈 본문이면 `null`. 여기서 하는 것은 **모양 정규화**뿐이다(제어문자·연속 공백 → 공백 하나) — 보이지 않는/양방향 문자
 * 제거는 **표시할 때**(`sanitizeDisplayText`) 한다. 저장값은 에이전트가 보낸 것에 가깝게, 표시값은 안전하게.
 * 본문 전체는 Postgres 에 없다(§5.2 V5) — 512 는 그 규칙이 허락하는 미리보기의 상한이다.
 */
export function snippetOf(text: string): string | null {
  const oneLine = text.replace(SNIPPET_BREAKING, ' ').replace(/\s+/gu, ' ').trim();
  if (oneLine === '') return null;
  return [...oneLine].slice(0, SNIPPET_MAX_LENGTH).join('').trimEnd();
}

/** 준비 결과 — 관문으로 갈 것인가, 여기서 끝날 것인가. */
export type PreparedOutbound =
  | { readonly kind: 'ready'; readonly message: OutboundMessageSnapshot; readonly dispatchRequest: DispatchRequest }
  | { readonly kind: 'settled'; readonly outcome: OutboundOutcome };

/**
 * 관문에 주입할 의존성. **전송단은 호출자가 넘긴다** — 미구현 스텁이 자기 요청에만
 * `unimplementedTransport` 를 끼울 수 있어야 하고, 그 교체가 서비스 전역이면
 * `send` 까지 함께 막힌다.
 */
export function gateDependenciesFor(
  deps: OutboundServiceDependencies,
  transport: OutboundTransport,
): GateDependencies {
  return {
    source: deps.source,
    audit: deps.audit,
    leases: deps.dispatchStore,
    transport,
    serializer: deps.serializer,
    sendEvidence: deps.sendEvidence,
    leaseTtlSeconds: deps.leaseTtlSeconds,
    riskSignals: deps.riskSignals,
  };
}

/** 첨부 MIME 이 텍스트인가 — DLP 가 내용을 보는 종류(ADR-0016 M1 배선 계약 1). */
function isTextAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('text/');
}

/** DLP 스캔이 읽는 요청의 부분 — 발송·예약 생성이 같은 함수를 쓴다. */
type DlpScanRequest = Pick<
  OutboundSendRequest,
  'routeId' | 'agentId' | 'traceId' | 'recipients' | 'subject' | 'text' | 'html' | 'extraDlp' | 'copyTargets'
>;

/** 그 자리에서 지문화한 복사 비교 대상(재검증 N2 ①). 참여자 제외는 저장된 지문과 같다(배선 계약 5). */
function copySourceOf(keyring: HmacKeyring, target: CopyTarget, participants: readonly string[]): InboundCopySource {
  const secrets = target.secrets.flatMap((secret) => {
    const print = secret.kind === 'link' ? fingerprintLink(keyring, secret.code, '') : fingerprintCode(keyring, secret.code, '');
    return print === null ? [] : [print];
  });
  return {
    inboundMessageId: target.inboundMessageId,
    senderAddress: target.senderAddress.toLowerCase(),
    threadId: target.threadId,
    threadParticipants: participants,
    shingles: inboundShingles(keyring, fold(target.text).text),
    secrets,
  };
}

/**
 * **발신 DLP**(ADR-0016 B) — 서버가 조립한 최종 내용(제목 · text · html · text/* 첨부)을 본다. 전달은 라우트가 원문을 붙인 본문이 이미 `text` 다
 * (배선 계약 2). 수신자는 허용 비교형(`+tag` 보존), 수신자 도메인은 등록 도메인(PSL). 계열마다 `dlp.findings` 1 — 차원은 사유 하나(알람이 본다).
 * 결과에 값·위치는 없다 — 계열 이름뿐이고, 그 이름도 에이전트에게는 `risk_review` 하나로 접힌다(`public-codes.ts`).
 */
async function scanOutboundContent(
  deps: Pick<OutboundServiceDependencies, 'dlp' | 'now'>,
  request: DlpScanRequest,
  validated: ValidatedAttachments | null,
  /** 계열 메트릭 — 발송은 `dlp.findings`(알람), 예약 생성의 고정은 `dlp.pinned`(재검증 N5 — 같은 발송을 두 번 세지 않게). */
  metric: 'dlpFindings' | 'dlpPinned' = 'dlpFindings',
): Promise<DlpFamily[]> {
  const recipients = request.recipients.map(comparableAddress);
  const recipientDomains = [
    ...new Set(
      recipients.map((address) => {
        const domain = address.slice(address.lastIndexOf('@') + 1);
        return registrableDomainOf(domain) ?? domain;
      }),
    ),
  ];
  const targets = request.copyTargets ?? [];
  const signals = await deps.dlp.signals.load(
    request.agentId,
    deps.now(),
    targets.map((target) => ({ inboundMessageId: target.inboundMessageId, threadId: target.threadId })),
  );
  const pinned = new Set(targets.map((target) => target.inboundMessageId));
  const inboundCopies = [
    ...targets.map((target) => copySourceOf(deps.dlp.keyring, target, signals.targetParticipants?.get(target.inboundMessageId) ?? [])),
    ...signals.inboundCopies.filter((source) => !pinned.has(source.inboundMessageId)),
  ];
  const attachments = (validated?.rows ?? []).flatMap((row, index) =>
    isTextAttachment(row.mimeType) ? [{ text: validated?.texts?.[index] ?? null }] : [],
  );
  const result = scanOutbound(
    { subject: request.subject, text: request.text, html: request.html, attachments },
    {
      keyring: deps.dlp.keyring,
      recipients,
      recipientDomains,
      codeFingerprints: signals.codeFingerprints,
      inboundCopies,
    },
  );
  const families = mergeDlp(result.families, request.extraDlp ?? []);
  for (const family of families) countMetric(METRIC_NAMES[metric], { reason: DLP_HOLD_REASON[family] });
  if (result.droppedFingerprints > 0) {
    emitMetric(METRIC_NAMES.dlpDroppedFingerprints, result.droppedFingerprints, 'Count');
    log('warn', 'outbound.dlp_fingerprints_dropped', {
      route_id: request.routeId,
      agent_id: request.agentId,
      trace_id: request.traceId,
      detail: `dropped=${String(result.droppedFingerprints)} — DLP 키를 지문 보존 기간(30일)보다 일찍 뺐다`,
    });
  }
  const [first] = families;
  if (first !== undefined) {
    log('info', 'outbound.dlp', {
      route_id: request.routeId,
      agent_id: request.agentId,
      trace_id: request.traceId,
      reason: DLP_HOLD_REASON[first],
      detail: families.join(','),
    });
  }
  return families;
}

/** 계열 합집합 — 닫힌 순서로. */
function mergeDlp(...lists: readonly (readonly DlpFamily[])[]): DlpFamily[] {
  const present = new Set(lists.flat());
  return DLP_FAMILIES.filter((family) => present.has(family));
}

/**
 * **예약 생성 때의 위험 고정**(ADR-0016 리뷰 H1). 예약은 최대 30일 뒤에 나간다 — 발송 때만 판정하면 오염 창(4시간)·코드 지문(24시간)이 그사이
 * 닫혀, 위험한 메일을 읽은 직후의 발송을 미뤄서 통과시킬 수 있다. 그래서 만들 때 오염 맥락(에이전트 창 · 수신자 중 오염 발신자)과 DLP 계열을
 * 행에 고정하고, 발송 때 그때의 판정과 합친다(`pinnedRisk`). 킬 스위치와 무관하게 고정한다 — 강제 여부는 발송 때 정한다.
 */
export async function pinScheduledRisk(
  deps: Pick<OutboundServiceDependencies, 'riskSignals' | 'dlp' | 'now'>,
  request: DlpScanRequest,
): Promise<PinnedRisk> {
  const now = deps.now();
  const risk = resolveRiskHold(await deps.riskSignals.load({ agentId: request.agentId, now }), null, now);
  const senders = new Set(risk.taintedSenders);
  const tainted = risk.agentTainted || request.recipients.map(comparableAddress).some((recipient) => senders.has(recipient));
  return { tainted, dlp: await scanOutboundContent(deps, request, null, 'dlpPinned') };
}

function invalid(detail: string): PreparedOutbound {
  return { kind: 'settled', outcome: { kind: 'invalid', detail } };
}

/**
 * 관문 **앞**의 전부.
 *
 * 순서가 중요하다: `Message-ID` 생성 → INSERT → 본문 저장 → (호출자가) dispatch.
 * 헤더를 전송 후에 기록하면 "전송 성공 직후 프로세스 사망" 이라는 최악 케이스에서
 * 정확히 값이 없다(§4.5-4). 본문을 INSERT 전에 저장할 수 없는 이유는 키가 `messages.id`
 * 이기 때문이고, dispatch 전에 저장해야 하는 이유는 전송단이 그때 읽기 때문이다.
 */
export async function prepareOutbound(
  deps: OutboundServiceDependencies,
  request: OutboundSendRequest,
): Promise<PreparedOutbound> {
  return prepare(deps, request, null);
}

/**
 * 회신의 관문 **앞** (P3b). `prepareOutbound` 와 같은 절차에 셋이 더해진다:
 *   ① `messages` 행이 새 스레드를 열지 않고 **답하는 메일의 권한용 스레드**에 붙는다.
 *   ② 본문 객체에 `In-Reply-To`·`References` 가 함께 저장된다(릴리스가 몇 시간 뒤 같은 헤더로 보낸다).
 *   ③ 관문의 시도에 `threadId` 가 **주장으로** 실린다 — 스레드 회신인지는 로더가 DB 에서 정한다.
 */
export async function prepareReplyOutbound(
  deps: OutboundServiceDependencies,
  request: OutboundSendRequest,
  target: OutboundReplyTarget,
): Promise<PreparedOutbound> {
  return prepare(deps, request, target);
}

async function prepare(
  deps: OutboundServiceDependencies,
  request: OutboundSendRequest,
  reply: OutboundReplyTarget | null,
): Promise<PreparedOutbound> {
  if (request.recipients.length === 0) {
    // 수신자 0명 발송은 표현 불가능해야 한다(DB CHECK `messages_outbound_has_recipients`).
    // 여기서 끊지 않으면 `recipient_count = 0` 인 행이 캡에 한 명도 기여하지 않으면서
    // SES 호출을 내는 경로가 된다.
    return invalid('At least one recipient is required.');
  }
  if (request.subject.trim() === '') {
    return invalid('subject must not be empty.');
  }
  // 수신 전용 주소(`abuse@`·`postmaster@atmark.ai`, 202609301540)는 발신 주소가 될 수 없다 — 행·audit 를 만들기 전에 끊는다(발송 역할 IAM 도 Deny).
  if (isReceiveOnlyAddress(request.fromAddress)) {
    return invalid(`${request.fromAddress.trim().toLowerCase()} is receive-only and cannot be used as from. Send from the agent's primary address.`);
  }
  if (request.subject.length > MAX_SUBJECT_LENGTH) {
    return invalid(`subject must be at most ${String(MAX_SUBJECT_LENGTH)} characters.`);
  }

  // 첨부(A2) — 메시지 행을 만들기 **전에** 검증한다(소유·만료·업로드·스캔·내용 모양). 여기서 멈추면 행도 audit 도 없다 — 스캔 중(409)인
  // 요청은 같은 멱등 키로 다시 보내면 된다. 영구 복사는 행 id 가 필요해 INSERT 뒤(`proceed`).
  const attachmentIds = request.attachmentIds ?? [];
  let validated: ValidatedAttachments | null = null;
  if (attachmentIds.length > 0) {
    // 꺼짐 · 이 조직이 단계 공개 목록 밖 — 같은 400(다른 조직에 열려 있는지 드러내지 않는다).
    if (deps.attachments === undefined || !(await deps.attachments.enabledFor(request.agentId))) {
      return { kind: 'settled', outcome: { kind: 'attachment_rejected', status: 400, code: 'attachments_disabled', detail: 'Outbound attachments are not available.' } };
    }
    const checked = await deps.attachments.validate(request.agentId, attachmentIds, deps.now());
    if (isAttachmentRejection(checked)) {
      countMetric(METRIC_NAMES.preflightRejected, { route_id: request.routeId });
      log('warn', 'outbound.attachment_rejected', {
        route_id: request.routeId,
        agent_id: request.agentId,
        trace_id: request.traceId,
        http_status: checked.status,
        error_code: checked.code,
      });
      return { kind: 'settled', outcome: { kind: 'attachment_rejected', ...checked } };
    }
    validated = checked;
  }

  // 발신 DLP(ADR-0016 B) — 관문 앞, 행을 만들기 전에(계열은 INSERT 때 `messages.outbound_dlp` 로 적힌다). 지문 저장소를 읽지 못하면 던진다 —
  // 검사하지 못한 발송을 깨끗하다고 보내지 않는다.
  const dlp = mergeDlp(await scanOutboundContent(deps, request, validated), request.pinnedRisk?.dlp ?? []);

  const requestHash = hashOutboundRequest({
    routeId: request.routeId,
    fromAddress: request.fromAddress,
    recipients: request.recipients,
    subject: request.subject,
    text: request.text,
    html: request.html,
    inReplyTo: reply?.inboundMessageId ?? null,
    attachmentIds,
  });

  let messageIdHeader: string;
  try {
    messageIdHeader = generateMessageIdHeader(domainOf(request.fromAddress));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }

  const insert = await deps.messages.insertOrReplay({
    agentId: request.agentId,
    fromAddress: request.fromAddress,
    subject: request.subject,
    messageIdHeader,
    idempotencyKey: request.idempotencyKey,
    requestHash,
    // **캡의 눈금.** 수신자 수이지 메시지 수가 아니다(§3.3 · R22).
    recipientCount: request.recipients.length,
    // **스레드 권한의 근거** (P3a). 같은 트랜잭션에서 `outbound_recipients` 와 이 발송이 여는
    // 에이전트 스레드(`threads.started_by='agent'`)가 만들어진다. 상대의 회신은 이 목록에 있어야만
    // 이 스레드에 권한으로 이어진다(`mail/thread/resolve.ts`).
    recipients: request.recipients,
    // 회신이면 답하는 메일의 권한용 스레드에 붙는다. 저장소가 에이전트 소유를 다시 확인한다.
    threadId: reply?.threadId ?? null,
    // 관리 로그의 미리보기(US-004). 본문 전체는 아래 `content.put` 이 S3 에 쓰고, 행은 그 키만 갖는다.
    snippet: snippetOf(request.text),
    outboundDlp: dlp,
  });

  if (insert.kind === 'replayed') {
    if (insert.message.requestHash !== requestHash) {
      return {
        kind: 'settled',
        outcome: {
          kind: 'conflict',
          messageId: insert.message.id,
          detail:
            'This Idempotency-Key was already used for a different request. Use a new key to send a different email.',
        },
      };
    }
    // ★ **관문에 한 번도 닿지 못한 `pending`** 은 재생할 결과가 없다 — 첫 시도가 INSERT 뒤·관문 전에 실패했다
    //   (본문 저장 실패, 프로세스 사망). 재생으로 끝내면 아무도 그 행을 관문으로 데려가지 않고 메일은 조용히
    //   사라진다(검증 V2: `scheduled_sends=dispatched/replayed`, `messages=pending`, SES 0). 그래서 **이어서 진행**한다
    //   — 단 한 명만(`claimUngated`, 202609230510 머리말: 둘이 관문에 가면 거부·승인 대기의 audit 이 두 행이 된다).
    //   못 잡으면(첫 시도가 아직 가는 중) 예전처럼 재생이다.
    if (insert.message.status === 'pending' && !insert.message.gated) {
      const generation = await deps.messages.claimUngated(insert.message.id, deps.now(), PREPARE_CLAIM_SECONDS);
      if (generation !== null) {
        log('warn', 'outbound.prepare_resumed', {
          route_id: request.routeId,
          agent_id: request.agentId,
          trace_id: request.traceId,
          message_id: insert.message.id,
          reason: 'ungated_pending',
          detail: `generation=${String(generation)}`,
        });
        return proceed(deps, request, reply, insert.message, generation, validated, dlp);
      }
    }
    // 같은 요청의 재호출 — **새 평가도, 새 발송도, 새 audit 행도 없다.**
    return { kind: 'settled', outcome: { kind: 'replayed', message: insert.message } };
  }

  return proceed(deps, request, reply, insert.message, 0, validated, dlp);
}

/**
 * INSERT(또는 이어받기) 뒤의 앞단 — 본문 저장 → 관문 시도 구성. `generation` 은 이 시도가 쥔 관문 앞 임대의 세대
 * (0 = INSERT 한 시도의 암묵 임대).
 */
async function proceed(
  deps: OutboundServiceDependencies,
  request: OutboundSendRequest,
  reply: OutboundReplyTarget | null,
  message: OutboundMessageSnapshot,
  generation: number,
  validated: ValidatedAttachments | null,
  dlp: readonly DlpFamily[],
): Promise<PreparedOutbound> {
  try {
    // 첨부(A2): 스테이징 → 영구 복사 · 결속 행. 본문 객체가 영구 키를 싣는다 — 승인 릴리스는 몇 시간 뒤 그 키를 읽는다.
    const attachments = validated === null || deps.attachments === undefined ? [] : await deps.attachments.persist(message.id, validated);
    await deps.content.put(message.id, {
      subject: request.subject,
      text: request.text,
      html: request.html,
      threading: reply?.threading ?? null,
      ...(attachments.length === 0 ? {} : { attachments }),
    });
  } catch (error) {
    if (error instanceof AttachmentLinkLimitError) {
      // 보안 리뷰 N1 — 선검사(`validate` 의 `linkCounts`)는 잠금 없이 센다. 같은 첨부를 동시에 보내면 DB 결속 천장 트리거가 막는다(23514 →
      // 저장소가 이 오류로 옮김). 선검사와 **같은** 409 로 끝내고, 행은 관문 없이 갈 수 있는 유일한 종단 `denied` 로 굳힌다(`pending` 으로
      // 두면 아무도 데려가지 않는 행이 된다). 결속 행은 지워지지 않으므로(트리거) 같은 멱등 키의 재시도는 선검사에서 같은 409 를 받는다.
      await deps.dispatchStore.settleDenied(message.id);
      const index = error.attachmentId === null ? -1 : (request.attachmentIds ?? []).indexOf(error.attachmentId);
      const rejection = linkLimitRejection(index >= 0 ? index : null);
      countMetric(METRIC_NAMES.preflightRejected, { route_id: request.routeId });
      log('warn', 'outbound.attachment_rejected', {
        route_id: request.routeId,
        agent_id: request.agentId,
        trace_id: request.traceId,
        message_id: message.id,
        http_status: rejection.status,
        error_code: rejection.code,
      });
      return { kind: 'settled', outcome: { kind: 'attachment_rejected', ...rejection } };
    }
    // 이어받은 시도라면 첫 시도가 본문을 이미 썼을 수 있다(본문 저장 뒤·관문 전에 죽은 경우). 본문은 write-once 이고
    // 요청 해시가 같으므로 **같은 본문**이다 — 그대로 관문으로 간다.
    if (!(generation > 0 && error instanceof MessageContentAlreadyStoredError)) {
      // 알고 실패했다 — 임대를 놓아 같은 키의 다음 재시도가 기다리지 않고 이어받게 한다. 놓기가 실패해도 원래 오류를
      // 올린다(임대는 시간이 풀어 준다).
      await deps.messages.releaseClaim(message.id, generation).catch(() => undefined);
      throw error;
    }
  }

  const dispatchRequest: DispatchRequest = {
    agentId: request.agentId,
    attempt: {
      routeId: request.routeId,
      fromAddress: request.fromAddress,
      recipients: request.recipients,
      // 첨부 **메타만**(A2 — 바이트는 관문에 들어오지 않는다, R10). 빈 배열은 "이 시도에 없다" 이며 Stage 6 은 그 배열을 그대로 평가한다.
      attachments: (validated?.rows ?? []).map((row) => ({ filename: row.filename, mimeType: row.mimeType, bytes: row.bytes })),
      // **주장이다.** 회신이 아니면 `null`. 회신이면 라우트가 찾은 권한용 스레드이고, 로더가 다시 검증한다 —
      // 이 값만으로 열리는 문은 없다(`policy-loader.resolveThreadReply`).
      threadId: reply?.threadId ?? null,
      contentShape: classifyContentShape(request.text, request.html, validated?.rows.length ?? 0),
      // 발신 DLP 계열(ADR-0016 B) — 위에서 실제로 나갈 내용으로 계산했다. 호출자가 주장할 자리가 없다.
      dlp,
      // 예약 행에 고정된 오염 맥락(리뷰 H1) — 워커만 싣는다.
      pinnedTaint: request.pinnedRisk?.tainted === true,
    },
    now: deps.now(),
    traceId: request.traceId,
    thisAttemptCostCents: request.costCents,
    messageId: message.id,
    // **INSERT 가 돌려준 값을 쓴다.** 위에서 만든 지역 변수를 쓰면 재호출 경로에서
    // 두 값이 갈라질 수 있고, 그러면 재시도가 다른 Message-ID 로 나간다.
    messageIdHeader: message.messageIdHeader,
    leaseId: randomUUID(),
    // 새 시도는 릴리스가 아니다. 릴리스는 `workers/approval-release` 가 기존 행으로 만든다.
    release: null,
  };

  return { kind: 'ready', message, dispatchRequest };
}

/**
 * 관문 **뒤**의 전부 — 관문이 반환한 결과를 `messages` 행에 확정한다.
 *
 * **`settleSent` 가 `false` 를 돌려줘도 던지지 않는다.** 그 경우 메일은 이미 나갔고,
 * 여기서 실패로 바꾸면 호출자가 재시도해 같은 메일이 두 번 나간다 — 기록 실패가
 * 중복 발송의 원인이 되는 것은 방향이 뒤집힌 것이다. 대신 `settled: false` 로 드러낸다.
 */
export async function finalizeOutbound(
  deps: OutboundServiceDependencies,
  prepared: { readonly dispatchRequest: DispatchRequest },
  outcome: DispatchOutcome,
): Promise<OutboundOutcome> {
  const { messageId, leaseId } = prepared.dispatchRequest;
  if (messageId === null) {
    // `prepareOutbound` 는 항상 messageId 를 채운다. 여기 오면 호출자가 다른 경로로
    // DispatchRequest 를 만든 것이고, 그 경로는 검토되지 않았다.
    throw new Error('finalizeOutbound 는 messageId 가 있는 시도에만 쓴다.');
  }
  const now = deps.now();

  switch (outcome.kind) {
    case 'denied': {
      // **행을 종단(`denied`)으로 확정한다** (P1b 리뷰 MAJOR 3). `pending` 으로 두면 같은 멱등 키의 재호출이 최초의 403 대신
      // 202 를 받아(§4.5-1 위반) 나가지 않을 메일을 기다린다. `denied` 는 `COUNTED_STATUSES` 밖이라 한도·캡을 소비하지 않는다.
      // 재시도는 새 키로 한다(같은 키 = 같은 시도). 반환값을 버리는 것이 의도다 — 0행이면 누가 lease 를 잡았고, 그 행의 진실은 그쪽이 쓴다.
      await deps.dispatchStore.settleDenied(messageId);
      return { kind: 'denied', messageId, decision: outcome.decision };
    }

    case 'pending_approval':
      // **여기서는 행을 확정하지 않는다.** `pending_approval` 은 종단이 아니다 —
      // P2 의 릴리스 경로가 같은 행에 lease 를 걸어 실제로 보낸다(§4.5-6). 종단으로
      // 굳히면 승인이 떨어져도 보낼 행이 없다. 그리고 계약 모순도 없다: 최초 응답과
      // 재호출 응답이 모두 202 이고 둘 다 "아직 나가지 않았다" 로 참이다.
      return { kind: 'pending_approval', messageId, decision: outcome.decision, approval: outcome.approval };

    case 'duplicate_suppressed': {
      // 다른 워커가 이미 잡았다. 우리가 확정할 것이 없다 — 그쪽이 확정한다.
      const message = await deps.messages.findById(messageId);
      if (message === null) throw new Error(`messages 행이 사라졌다 (id=${messageId})`);
      return { kind: 'replayed', message };
    }

    case 'sent': {
      const settled = await deps.dispatchStore.settleSent(messageId, leaseId, outcome.sesMessageId, now);
      if (!settled) {
        // **메일은 나갔는데 `messages` 행이 그 사실을 모른다** — lease 를 잃은 뒤
        // 돌아온 워커다. 알람 1(audit 구멍)의 형제이지만 **법적 기록은 온전하다**:
        // audit 행은 관문이 이미 해소했고, 갈라진 것은 운영 상태기계 쪽이다.
        // 그래서 페이지(page)가 아니라 대시보드 수치로 둔다.
        countMetric(METRIC_NAMES.outboundUnsettled, { route_id: prepared.dispatchRequest.attempt.routeId });
        log('warn', 'outbound.unsettled', {
          route_id: prepared.dispatchRequest.attempt.routeId,
          message_id: messageId,
          lease_id: leaseId,
          ses_message_id: outcome.sesMessageId,
          settled: false,
        });
      }
      return {
        kind: 'sent',
        messageId,
        messageIdHeader: prepared.dispatchRequest.messageIdHeader,
        sesMessageId: outcome.sesMessageId,
        decision: outcome.decision,
        settled,
      };
    }

    case 'failed': {
      await deps.dispatchStore.settleFailed(messageId, leaseId, outcome.reason, now);
      return { kind: 'failed', messageId, reason: outcome.reason, decision: outcome.decision };
    }
  }
}
