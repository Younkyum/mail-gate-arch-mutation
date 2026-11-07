/**
 * src/api/inbound-view.ts — 수신 조회 표면(목록·상세·스레드·첨부)의 **응답 모양**과 파싱 결과 문서의 해석 (P3c).
 *
 * 라우트 셋(`inbound-messages.ts`·`threads.ts`·`attachments.ts`)과 `forward.ts` 가 함께 쓴다. 이 파일은 관문을
 * import 하지 않는다 — 조회 라우트들이 `NON_SENDING_ENTRYPOINTS` 로 분류돼 있어 관문을 전이적으로도 끌어오면
 * 안 된다(Layer C 는 직접 import 만 보지만, 분류의 뜻은 그렇다).
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * **① 격리 메일의 존재 — 개수만 알린다.** 계획 §6 P4 는 "에이전트 컨텍스트 API 에서 제외" 를 요구한다. 행째
 *   숨기면(목록·상세·스레드·첨부·웹훅 전부에서 없음) 에이전트는 "확인 메일이 안 왔다" 로 읽고 재발송을 요청한다 —
 *   공격자 메일 한 통이 에이전트를 외부 서비스에 재요청 루프로 모는 것이고, 재발송된 메일도 같은 이유로 격리될 수
 *   있다. 반대로 발신자·제목·시각을 알리면 그 문자열이 곧 injection 의 운반체다(제목·표시 이름·로컬 파트는
 *   공격자가 쓴다). 그래서 **목록 응답에 `quarantined.count` 하나**(스레드 뷰에는 그 스레드의 개수)를 싣는다:
 *   "메일은 왔지만 소유자 검토 대기다" 까지는 말하고, 무엇이 왔는지는 말하지 않는다. id 도 싣지 않는다 —
 *   id 가 있으면 에이전트가 그 id 로 조회·전달을 시도하고, 그 경로마다 방어가 한 겹 더 필요해진다.
 *   상세·첨부·전달에서 격리 id 는 **없는 id 와 같은 404** 다.
 *
 * **② 본문 — `text` 와 `html_text` 둘 다, HTML 원본은 없다.** 확인 코드가 HTML 파트에만 있는 메일이 있다
 *   (p3-integration.md). 파서가 HTML 을 텍스트로 바꾼 `htmlText` 는 돌려주고, HTML **원본**은 돌려주지 않는다 —
 *   원본은 에이전트에게 새 정보(코드·링크)를 거의 더하지 않으면서 스크립트·숨김 요소·추적 픽셀을 그대로 넘긴다.
 *   파싱 결과 문서에는 애초에 원본 HTML 이 없다(원문은 `inbound/raw/` 에만). 본문 응답에서는 확인 코드를 뽑지 않는다 —
 *   에이전트가 본문을 읽는다(AC-3). 코드 추출은 **따로 부르는** 조회(`routes/verification-code.ts`, 메일 기본기 A1)의 일이다 — 에이전트가
 *   고르지 않은 메일의 값이 본문 응답에 "검증된 코드" 처럼 섞이지 않게.
 *
 * **③ 첨부 — presigned GET(5분).** 이유는 `storage/s3-object-store.ts` 의 `createS3DownloadSigner`. 그 URL 을 직접 받지 못하는
 *   MCP 클라이언트가 많아서, **내용 조회**(`…/attachments/{index}/content`)가 따로 있다 — 서버가 바이트를 읽어 텍스트·PDF 텍스트·
 *   이미지로 돌려준다(`api/attachment-content.ts`). 종류는 바이트로 정하고 모든 해석에 크기·쪽·시간 상한이 있다.
 */

import type { ExposureRecorder } from '../db/repositories/exposure-store';
import type { MessageFacts, MessageStateStore } from '../db/repositories/message-state-store';
import { classifyInboundLevel } from '../security/levels';
import type { TaintLevel } from '../security/taint';
import type { AgentTokenStore } from '../identity/agent-token';
import type { RiskHoldMode } from '../policy/risk-signals';
import type {
  InboundReadStore,
  ListCursor,
  ThreadEntry,
  ThreadView,
  VisibleAttachment,
  VisibleInboundDetail,
  VisibleInboundSummary,
} from '../db/repositories/inbound-read-store';
import type { PdfParseSlots } from '../db/repositories/pdf-parse-slots';
import type { InboundArtifactReader, InboundAttachmentReader } from '../storage/inbound-artifact-store';
import type { ObjectDownloadSigner } from '../storage/object-store';
import type { AiWatchAgentView } from '../inbound/ai-watch/status';
import { UUID_PATTERN } from './http';

/** 조회 라우트 셋의 공용 의존성. */
export interface InboundReadDependencies {
  readonly tokens: AgentTokenStore;
  readonly inbound: InboundReadStore;
  readonly artifacts: InboundArtifactReader;
  readonly now: () => Date;
  /**
   * 노출 기록(ADR-0016 A — `api/exposure.ts`). 상세 · 스레드 · 첨부 content · 첨부 URL · 인증 코드가 본문을 돌려주기 **전에** 적는다(실패 503).
   * 필수다 — 없으면 발송 판정이 에이전트가 읽은 것을 모른다(열리는 쪽).
   */
  readonly exposures: ExposureRecorder;
  /**
   * 운영자 킬 스위치(`ATMARK_RISK_HOLD_ENFORCE`). `enforce` 면 위험도 `medium` 이상의 첨부 텍스트를 에이전트에게 주지 않는다(`withheld:
   * "injection_risk"`, 진윤겸 결정 4). `observe` 면 주고 판정만 싣는다.
   */
  readonly riskHoldMode: RiskHoldMode;
  /**
   * 받은 메일의 에이전트 상태(라벨 · 읽음)와 응답 `risk` 의 재료(묶음 B — `db/repositories/message-state-store.ts`). 목록 · 상세 · 스레드가 보인 메일 id
   * 로 한 번 읽는다. 상세 조회는 처음 읽은 시각도 여기 적는다(최선 노력 — 실패해도 본문은 준다, 노출 기록과 다르다).
   */
  readonly messageState: MessageStateStore;
}

export interface AttachmentRouteDependencies extends InboundReadDependencies {
  readonly signer: ObjectDownloadSigner;
  /** 첨부 바이트 읽기 — 내용 조회(`…/content`)만 쓴다. 다운로드 URL 라우트는 바이트에 닿지 않는다. */
  readonly contents: InboundAttachmentReader;
  /** 함대 전체 PDF 해석 칸(`db/repositories/pdf-parse-slots.ts`) — 내용 조회가 PDF 를 풀 때만 잡는다. */
  readonly pdfSlots: PdfParseSlots;
}

// ---------------------------------------------------------------------------
// 파싱 결과 문서 — `workers/inbound-consumer.ts` 의 `InboundParsedDocument` (version 1)
// ---------------------------------------------------------------------------

/** 에이전트에게 돌려줄 본문. 파싱 결과 문서에서 **이름 붙인 필드만** 옮긴다. */
export interface InboundBody {
  readonly text: string;
  readonly textSource: 'plain' | 'html' | 'none';
  readonly htmlText: string | null;
  readonly from: { readonly address: string; readonly name: string | null };
  readonly to: readonly { readonly address: string; readonly name: string | null }[];
  readonly cc: readonly { readonly address: string; readonly name: string | null }[];
  readonly replyTo: readonly { readonly address: string; readonly name: string | null }[];
  readonly subject: string | null;
  readonly date: string | null;
}

class ParsedDocumentError extends Error {
  constructor(why: string) {
    super(`수신 파싱 결과 문서를 해석할 수 없다: ${why}`);
    this.name = 'ParsedDocumentError';
  }
}

function address(value: unknown, field: string): { address: string; name: string | null } {
  if (typeof value !== 'object' || value === null) throw new ParsedDocumentError(`${field} 가 객체가 아니다`);
  const record = value as Record<string, unknown>;
  if (typeof record['address'] !== 'string') throw new ParsedDocumentError(`${field}.address`);
  const name = record['name'];
  if (name !== null && name !== undefined && typeof name !== 'string') throw new ParsedDocumentError(`${field}.name`);
  return { address: record['address'], name: typeof name === 'string' ? name : null };
}

function addresses(value: unknown, field: string): { address: string; name: string | null }[] {
  if (!Array.isArray(value)) throw new ParsedDocumentError(`${field} 가 배열이 아니다`);
  return value.map((item, index) => address(item, `${field}[${String(index)}]`));
}

/** 문서 바이트 → 본문. 모양이 다르면 던진다(빈 본문으로 메우지 않는다 — 확인 코드가 "없다" 로 읽힌다). */
export function decodeParsedDocument(bytes: Uint8Array): InboundBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ParsedDocumentError(error instanceof Error ? error.message : String(error));
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ParsedDocumentError('객체가 아니다');
  const doc = parsed as Record<string, unknown>;
  if (doc['version'] !== 1) throw new ParsedDocumentError(`version ${String(doc['version'])}`);
  const message = doc['message'];
  if (typeof message !== 'object' || message === null) throw new ParsedDocumentError('message');
  const m = message as Record<string, unknown>;
  const text = m['text'];
  const textSource = m['textSource'];
  const htmlText = m['htmlText'];
  const subject = m['subject'];
  const date = m['date'];
  if (typeof text !== 'string') throw new ParsedDocumentError('text');
  if (textSource !== 'plain' && textSource !== 'html' && textSource !== 'none') throw new ParsedDocumentError('textSource');
  if (htmlText !== null && typeof htmlText !== 'string') throw new ParsedDocumentError('htmlText');
  if (subject !== null && typeof subject !== 'string') throw new ParsedDocumentError('subject');
  if (date !== null && typeof date !== 'string') throw new ParsedDocumentError('date');
  return {
    text,
    textSource,
    htmlText,
    from: address(m['from'], 'from'),
    to: addresses(m['to'], 'to'),
    cc: addresses(m['cc'], 'cc'),
    replyTo: addresses(m['replyTo'], 'replyTo'),
    subject,
    date,
  };
}

// ---------------------------------------------------------------------------
// 커서 — (received_at, id[, 필터 지문]) 의 불투명 인코딩
// ---------------------------------------------------------------------------

/** 필터 지문 모양(메일 기본기 A5) — `filterFingerprint` 의 출력. 필터 없는 목록은 지문이 없다(예전 커서와 같은 두 칸). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 커서. `fingerprint` 는 그 커서를 만든 요청의 필터 지문이다 — 다른 필터로 이어 읽으면 라우트가 400 을 낸다(AC-A5-3: 필터를 바꾸고
 * 옛 커서를 쓰면 사이가 비거나 겹친다). 필터가 없으면 빈 문자열이고 인코딩은 예전 두 칸 그대로다(이미 나간 커서가 계속 맞다).
 */
export function encodeCursor(cursor: ListCursor, fingerprint = ''): string {
  const parts = [cursor.receivedAt.toISOString(), cursor.id, ...(fingerprint === '' ? [] : [fingerprint])];
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

/** 모양이 틀리면 `null`(호출자가 400). */
export function decodeCursor(value: string): (ListCursor & { readonly fingerprint: string }) | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const [at, id, fingerprint, ...rest] = decoded.split('|');
  if (at === undefined || id === undefined || rest.length > 0 || !UUID_PATTERN.test(id)) return null;
  if (fingerprint !== undefined && !FINGERPRINT_PATTERN.test(fingerprint)) return null;
  const receivedAt = new Date(at);
  if (Number.isNaN(receivedAt.getTime()) || receivedAt.toISOString() !== at) return null;
  return { receivedAt, id, fingerprint: fingerprint ?? '' };
}

// ---------------------------------------------------------------------------
// 응답 모양
// ---------------------------------------------------------------------------

/**
 * **출처 표시**(ADR-0016 C — 추가만, 하위 호환). 에이전트가 이 메일을 "어디서 온 무엇" 으로 다룰지의 근거 — 전부 닫힌 어휘다(발신자가 고른 문자열이
 * 없다 — MCP 는 meta 에 그대로 싣는다).
 *   - `scanner_verdict` — 수신 스캐너 위험도 등급(`injection_risk`). **적중 계열은 싣지 않는다**(리뷰 Info — 어느 룰이 걸렸는지 알려 주면 피해 갈 표현을
 *     고르는 단서가 된다, `risk_review` 접기와 같은 취지). 계열은 소유자 콘솔에만 보인다.
 *   - `auth` — SES 의 SPF·DKIM·DMARC 판정.
 *   - `sender_trust` — 수신 시점의 발신자 신뢰.
 *   - `data_class` — 언제나 `external_untrusted`: 받은 메일은 지시가 아니라 바깥 데이터다.
 *   - `ai_watch` — AI 의심 메일 감시(ADR-0017 초안 · **경고 전용**). 조직이 감시를 켠 때만 키가 있다: `status`(`flagged`|`clear`|`unavailable`) ·
 *     `model_version`(flagged·clear 일 때만). 밴드는 싣지 않는다(소유자 콘솔만 — 회피 단서).
 * 숨김 텍스트 표지(`hidden_text_suspected`)는 파싱 문서 v2(M3)에서 더한다.
 */
function provenanceBody(summary: Pick<VisibleInboundSummary, 'injectionRisk' | 'authVerdicts' | 'senderTrust' | 'aiWatch'>): Record<string, unknown> {
  return {
    scanner_verdict: summary.injectionRisk,
    auth: { spf: summary.authVerdicts.spf, dkim: summary.authVerdicts.dkim, dmarc: summary.authVerdicts.dmarc },
    sender_trust: summary.senderTrust,
    data_class: 'external_untrusted',
    ...((summary.aiWatch ?? null) === null ? {} : { ai_watch: aiWatchBody(summary.aiWatch as AiWatchAgentView) }),
  };
}

/** provenance `ai_watch` — 닫힌 어휘 둘(상태 · 모델 버전 모양 `^[a-z0-9][a-z0-9._-]{0,63}$`). */
function aiWatchBody(view: AiWatchAgentView): Record<string, unknown> {
  return { status: view.status, model_version: view.modelVersion };
}

/**
 * **`risk` 객체**(계획 §1 계약 — 모든 받은 메일 표현: 목록 · 상세 · 스레드 · MCP). 등급은 `classifyInboundLevel` 하나가 매긴다(콘솔 감시 탭 · 알림과 같은
 * 함수 — 같은 메일이 면마다 다른 등급으로 보이지 않게). `untrusted_content` 는 늘 참이다 — 받은 메일은 지시가 아니라 바깥 데이터다. `taint` 는 이번 읽기의
 * 노출 등급(`security/taint.ts` — T2 면 그 뒤 새 상대에게 보내는 메일이 소유자 승인으로 간다)이고, 모르면 `null`.
 *
 * 재료가 없으면(보인 직후 사라진 행 — 일어나지 않아야 한다) **닫힌 쪽**이다: 판정이 `low` 이상이면 `risk`, 계열은 비운다.
 */
export function riskBody(
  facts: MessageFacts | undefined,
  fallbackRisk: VisibleInboundSummary['injectionRisk'] | null,
  taint: TaintLevel | null,
): Record<string, unknown> {
  if (facts === undefined) {
    const level = fallbackRisk === null || fallbackRisk === 'none' ? 'none' : 'risk';
    return { level, trusted_bypass: false, untrusted_content: true, taint };
  }
  const result = classifyInboundLevel({
    quarantined: facts.quarantined,
    quarantineReason: facts.quarantineReason,
    injectionRisk: facts.injectionRisk,
    findings: facts.findings,
    trustedBypass: facts.trustedBypass,
    releasedFrom: facts.releasedFrom,
  });
  // 적중 계열(`families`)은 에이전트에게 싣지 않는다(리드 결정 2026-10-08 — provenance 와 같은 방침: 어느 규칙이 걸렸는지는 회피 단서다).
  // 소유자는 콘솔 감시 탭에서 계열까지 본다.
  return { level: result.level, trusted_bypass: result.trustedBypass, released: facts.releasedFrom !== null, untrusted_content: true, taint };
}

/** 에이전트 상태 칸(묶음 B) — 라벨(에이전트가 붙인 것 · 정렬) · 읽음. 재료가 없으면 빈 라벨 · 안 읽음. */
export function stateBody(facts: MessageFacts | undefined): Record<string, unknown> {
  return { labels: [...(facts?.labels ?? [])], read: (facts?.firstReadAt ?? null) !== null };
}

export function summaryBody(summary: VisibleInboundSummary): Record<string, unknown> {
  return {
    id: summary.id,
    thread_id: summary.threadId,
    received_at_address: summary.receivedAtAddress,
    from: summary.fromAddress,
    from_authenticated: summary.fromAuthenticated,
    subject: summary.subject,
    received_at: summary.receivedAt.toISOString(),
    attachment_count: summary.attachmentCount,
    injection_risk: summary.injectionRisk,
    sender_trust: summary.senderTrust,
    provenance: provenanceBody(summary),
  };
}

export function attachmentBody(attachment: VisibleAttachment): Record<string, unknown> {
  return {
    index: attachment.index,
    filename: attachment.filename,
    declared_content_type: attachment.declaredContentType,
    disposition: attachment.disposition,
    size_bytes: attachment.sizeBytes,
    sha256: attachment.sha256,
  };
}

export function detailBody(detail: VisibleInboundDetail, body: InboundBody): Record<string, unknown> {
  return {
    ...summaryBody(detail),
    message_id_header: detail.messageIdHeader,
    in_reply_to: detail.inReplyTo,
    header_date: detail.headerDate === null ? null : detail.headerDate.toISOString(),
    from_name: body.from.name,
    to: body.to.map((a) => a.address),
    cc: body.cc.map((a) => a.address),
    reply_to: body.replyTo.map((a) => a.address),
    text: body.text,
    text_source: body.textSource,
    html_text: body.htmlText,
    attachments: detail.attachments.map(attachmentBody),
  };
}

function entryBody(entry: ThreadEntry): Record<string, unknown> {
  if (entry.direction === 'outbound') {
    return {
      direction: 'outbound',
      id: entry.id,
      at: entry.at.toISOString(),
      status: entry.status,
      subject: entry.subject,
      to: [...entry.recipients],
      message_id_header: entry.messageIdHeader,
    };
  }
  return {
    direction: 'inbound',
    id: entry.id,
    at: entry.at.toISOString(),
    from: entry.fromAddress,
    from_authenticated: entry.fromAuthenticated,
    subject: entry.subject,
    attachment_count: entry.attachmentCount,
    injection_risk: entry.injectionRisk,
    ...((entry.aiWatch ?? null) === null ? {} : { ai_watch: aiWatchBody(entry.aiWatch as AiWatchAgentView) }),
  };
}

export function threadBody(view: ThreadView): Record<string, unknown> {
  return {
    id: view.id,
    agent_id: view.agentId,
    started_by: view.startedBy,
    subject: view.subjectNormalized,
    created_at: view.createdAt.toISOString(),
    last_message_at: view.lastMessageAt.toISOString(),
    messages: view.entries.map(entryBody),
    quarantined: { count: view.quarantinedCount },
  };
}
