/**
 * 수신 첨부 두 라우트 (P3c, AC-4):
 *   - `GET /v1/messages/inbound/{id}/attachments/{index}` — **단기 서명 다운로드 URL**.
 *   - `GET /v1/messages/inbound/{id}/attachments/{index}/content` — **읽을 수 있는 내용**(텍스트 · PDF 텍스트 · 이미지 base64).
 *     서명 URL 을 받지 못하는 MCP 클라이언트가 많다 — 서버가 바이트를 읽어 풀어 준다(`api/attachment-content.ts`).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 읽기만 하며 관문을 import 하지 않는다.
 *
 * - 다운로드 URL 라우트는 **바이트를 응답에 싣지 않는다** — URL 을 준다(presigned GET, 5분). 이유는 `createS3DownloadSigner` 머리말.
 * - 다운로드 응답은 **항상** `Content-Disposition: attachment` + `Content-Type: application/octet-stream` 이다 —
 *   서명기가 스스로 건다(발신자가 선언한 타입은 JSON 의 `declared_content_type` 로만 나간다).
 * - 내용 라우트는 종류를 **바이트로** 정한다(선언값·파일명 무시). 모든 해석에 크기·쪽·시간·메모리 상한이 있고(PDF 는 워커 스레드 ·
 *   함대 전체 2 칸 · 조직마다 1), 해석 실패·칸 없음은 200 `kind: "unsupported"` + 고정 사유 코드다(해석기 예외 문장은 응답·로그에 싣지 않는다 —
 *   로그에는 종류·사유 코드만).
 * - 내용 라우트는 **메일의 신뢰 판정**(`injection_risk`·`from_authenticated`·`sender_trust`)을 함께 싣고, 뽑은 텍스트를 수신 때와
 *   **같은 스캐너**로 다시 본다(`content_injection_risk`). 수신 스캔은 본문·제목·파일명만 봤다 — 첨부 속 글자는 이 조회에서 처음
 *   에이전트에게 간다. 판정이 `medium` 이상이면 텍스트를 **주지 않는다**(`text: null` · `withheld: "injection_risk"` — 진윤겸 결정 4, ADR-0016 C;
 *   운영자 킬 스위치 `observe` 면 주고 판정만 싣는다). 소유자는 콘솔에서 본다.
 * - **노출 기록**(ADR-0016 A): 두 라우트 모두 내용·URL 을 돌려주기 **전에** `agent_exposures` 에 적는다(실패 503). URL 은 판정 없는 노출(T2)이다.
 * - **격리 메일의 첨부는 없다** — 저장소가 격리 메일의 첨부를 결과에 넣지 않는다(404, 없는 첨부와 같다). 두 라우트 공통.
 *   바이러스 판정 메일은 애초에 첨부를 저장하지 않았다(`inbound-consumer.ts`).
 * - `index` 는 파서의 등장 순서(`part_index`)다. 파일명은 키가 아니다.
 */

import { authenticateRequest, authorizeRequest } from '../auth';
import { recordExposure } from '../exposure';
import { ATTACHMENT_CONTENT_LIMITS, UNSUPPORTED_DETAIL, readAttachmentContent, type AttachmentContent } from '../attachment-content';
import { errorResponse, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { attachmentBody, type AttachmentRouteDependencies } from '../inbound-view';
import type { VisibleAttachmentLookup } from '../../db/repositories/inbound-read-store';
import { log } from '../../observability/logger';
import { scanForInjection, type InjectionRisk } from '../../security/injection/scanner';
import type { TaintFinding } from '../../security/taint';
import { ObjectTooLargeError } from '../../storage/object-store';

const ATTACHMENT_CONTENT_ROUTE_ID = 'inbound_attachment_content';

type AttachmentParams = { readonly inboundMessageId: string; readonly index: string };

type Authorized = { readonly kind: 'refused'; readonly response: ApiResponse } | { readonly kind: 'found'; readonly found: VisibleAttachmentLookup };

/** 두 라우트 공통 — 모양 → 인증 → 보이는 첨부(격리 제외) → 인가. 실패면 응답, 성공이면 첨부. */
async function authorizedAttachment(deps: AttachmentRouteDependencies, request: ApiRequest, params: AttachmentParams): Promise<Authorized> {
  const refused = (response: ApiResponse): Authorized => ({ kind: 'refused', response });
  if (!UUID_PATTERN.test(params.inboundMessageId)) {
    return refused(errorResponse(400, 'invalid_request', 'message id must be a lowercase uuid.'));
  }
  if (!/^(0|[1-9][0-9]{0,3})$/.test(params.index)) {
    return refused(errorResponse(400, 'invalid_request', 'attachment index must be a non-negative integer.'));
  }
  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return refused(authentication.response);

  const found = await deps.inbound.findVisibleAttachment(params.inboundMessageId, Number(params.index));
  if (found === null) {
    return refused(
      errorResponse(404, 'attachment_not_found', `No attachment at index=${params.index} for message_id=${params.inboundMessageId}.`),
    );
  }
  const forbidden = authorizeRequest(authentication.principal, 'messages:read', found.agentId);
  if (forbidden !== null) return refused(forbidden);
  return { kind: 'found', found };
}

export async function handleGetInboundAttachment(
  deps: AttachmentRouteDependencies,
  request: ApiRequest,
  params: AttachmentParams,
): Promise<ApiResponse> {
  const authorized = await authorizedAttachment(deps, request, params);
  if (authorized.kind === 'refused') return authorized.response;
  const { found } = authorized;

  // ADR-0016 리뷰 M2 — 내용 판정이 medium 이상인 첨부는 URL 로도 주지 않는다(강제 모드) — 내용 라우트의 보류를 URL 로 돌아 피하지 못하게.
  //   URL 을 내기 **전에** 내용 라우트와 같은 판정을 한다(바이트를 읽어 텍스트·PDF 텍스트를 스캔). 판정할 수 없는 종류(이미지 등)는 그대로 준다.
  if (deps.riskHoldMode === 'enforce') {
    const content = await readContent(deps, found);
    // 재검증 N4 — 읽기 상한(`maxReadBytes`)을 넘어 판정하지 못한 **텍스트** 첨부도 URL 을 주지 않는다: 판정이 없으니 medium 보류를 크기로 돌아 피할 수
    // 있다. 텍스트인지는 바이트를 읽지 않았으므로 발신자 선언으로만 본다(`declaredText` — 선언을 속이면 지나간다, 남는 한계). 이미지·PDF 등은 그대로.
    if (content.kind === 'unsupported' && content.reason === 'too_large' && declaredText(found.attachment)) {
      log('info', 'api.attachment_url_withheld', { route_id: ATTACHMENT_CONTENT_ROUTE_ID, agent_id: found.agentId, message_id: params.inboundMessageId, verdict: null });
      return jsonResponse(200, {
        message_id: params.inboundMessageId,
        attachment: attachmentBody(found.attachment),
        download_url: null,
        expires_at: null,
        withheld: 'unscanned_text',
        withheld_detail:
          'This text attachment is too large for Atmark to check for instructions aimed at AI agents, so no download link is given. ' +
          'Ask your owner to review it in the Atmark console.',
      });
    }
    const scan = content.kind === 'text' || content.kind === 'pdf_text' ? scanAttachmentText(content.text) : null;
    if (scan !== null && WITHHOLD_FROM.has(scan.risk)) {
      log('info', 'api.attachment_url_withheld', { route_id: ATTACHMENT_CONTENT_ROUTE_ID, agent_id: found.agentId, message_id: params.inboundMessageId, verdict: scan.risk });
      return jsonResponse(200, {
        message_id: params.inboundMessageId,
        attachment: attachmentBody(found.attachment),
        download_url: null,
        expires_at: null,
        withheld: 'injection_risk',
        content_injection_risk: scan.risk,
        withheld_detail:
          'This attachment looks like it contains instructions aimed at AI agents (injection_risk medium or higher), so no download link is given. ' +
          'Ask your owner to review it in the Atmark console.',
      });
    }
  }

  // ADR-0016 A — 다운로드 URL 을 받은 에이전트는 우리가 스캔하지 않은 바이트를 읽을 수 있다: 판정 없는 첨부 텍스트(→ T2)로 기록한다(실패 503).
  const refused = await recordExposure(deps.exposures, found.agentId, 'attachment_url', [
    { inboundMessageId: params.inboundMessageId, part: `attachment:${found.attachment.index}`, field: 'attachment_text', content: { risk: null, findings: [] } },
  ]);
  if (refused !== null) return refused;

  const signed = await deps.signer.signDownload(found.attachment.storageKey, deps.now());
  return jsonResponse(200, {
    message_id: params.inboundMessageId,
    attachment: attachmentBody(found.attachment),
    download_url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
  });
}

/** 텍스트로 선언된 MIME — `text/*` 와 텍스트 직렬화 형식들. */
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/x-ndjson',
  'application/ld+json',
  'application/rtf',
  'message/rfc822',
]);
/** 텍스트 파일 확장자 — 선언이 `application/octet-stream` 이어도 이름이 텍스트면 텍스트로 친다. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'json', 'ndjson', 'xml', 'html', 'htm', 'xhtml', 'eml', 'log', 'yaml', 'yml',
  'ics', 'vcf', 'ini', 'cfg', 'conf', 'toml', 'rtf', 'js', 'mjs', 'ts', 'py', 'rb', 'sh', 'sql', 'svg',
]);

/**
 * 크기 초과로 읽지 못한 첨부가 **텍스트**인가(재검증 N4 의 기준) — 선언 MIME 이 `text/*` · `*+json` · `*+xml` · 위 목록이거나, 파일명 확장자가 텍스트다.
 * 이미지 · 오디오 · 비디오 · PDF · 압축 · 오피스 문서는 텍스트가 아니다(지금 동작 그대로 — URL 을 준다).
 */
function declaredText(attachment: { readonly declaredContentType: string; readonly filename: string | null }): boolean {
  const type = (attachment.declaredContentType.split(';')[0] ?? '').trim().toLowerCase();
  if (type.startsWith('text/') || type.endsWith('+json') || type.endsWith('+xml') || TEXT_APPLICATION_TYPES.has(type)) return true;
  const name = (attachment.filename ?? '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTENSIONS.has(name.slice(dot + 1));
}

/** 첨부 텍스트를 에이전트에게 주지 않는 문턱(진윤겸 결정 4) — `medium` 이상. 수신 스캔의 격리 문턱과 같다. */
const WITHHOLD_FROM: ReadonlySet<InjectionRisk> = new Set<InjectionRisk>(['medium', 'high']);

/**
 * 보류한 첨부 텍스트(ADR-0016 C · 결정 4) — 본문 모양은 그대로(`kind` 유지 · 글자 수·쪽 수) 두고 `text: null` · `withheld: "injection_risk"`. 소유자는
 * 콘솔에서 본다. 다운로드 URL 라우트는 그대로 열려 있다(그 URL 은 판정 없는 노출로 기록된다).
 */
function withheldBody(content: AttachmentContent & { readonly kind: 'text' | 'pdf_text' }): Record<string, unknown> {
  const detail =
    'This attachment text was withheld because it looks like it contains instructions aimed at AI agents (injection_risk medium or higher). ' +
    'Ask your owner to review it in the Atmark console.';
  return content.kind === 'text'
    ? { kind: 'text', text: null, chars: content.chars, truncated: content.truncated, withheld: 'injection_risk', withheld_detail: detail }
    : {
        kind: 'pdf_text',
        text: null,
        truncated: content.truncated,
        pages: content.pages,
        pages_read: content.pagesRead,
        no_text_layer: content.noTextLayer,
        withheld: 'injection_risk',
        withheld_detail: detail,
      };
}

/** 첨부 바이트 → 읽을 수 있는 내용. 저장된 크기로 먼저 거른다 — 넘는 객체는 읽지도 않는다. 저장소도 상한을 다시 건다(크기 기록과 객체가 어긋나도). */
async function readContent(deps: AttachmentRouteDependencies, found: VisibleAttachmentLookup): Promise<AttachmentContent> {
  const limits = ATTACHMENT_CONTENT_LIMITS;
  if (found.attachment.sizeBytes > limits.maxReadBytes) return { kind: 'unsupported', reason: 'too_large' };
  let bytes: Uint8Array;
  try {
    bytes = await deps.contents.readAttachment(found.attachment.storageKey, limits.maxReadBytes);
  } catch (error) {
    if (!(error instanceof ObjectTooLargeError)) throw error;
    return { kind: 'unsupported', reason: 'too_large' };
  }
  return readAttachmentContent(bytes, { slots: deps.pdfSlots, agentId: found.agentId, cacheKey: found.attachment.storageKey }, limits);
}

function contentBody(content: AttachmentContent): Record<string, unknown> {
  switch (content.kind) {
    case 'text':
      return { kind: 'text', text: content.text, chars: content.chars, truncated: content.truncated };
    case 'pdf_text':
      // 전체 글자 수는 없다 — 글자 상한에서 추출을 멈추므로 모른다(`AttachmentContent` 주석).
      return {
        kind: 'pdf_text',
        text: content.text,
        truncated: content.truncated,
        pages: content.pages,
        pages_read: content.pagesRead,
        no_text_layer: content.noTextLayer,
      };
    case 'image':
      return { kind: 'image', mime_type: content.mimeType, data_base64: content.dataBase64 };
    case 'unsupported':
      return { kind: 'unsupported', reason: content.reason, detail: UNSUPPORTED_DETAIL[content.reason] };
  }
}

export async function handleGetInboundAttachmentContent(
  deps: AttachmentRouteDependencies,
  request: ApiRequest,
  params: AttachmentParams,
): Promise<ApiResponse> {
  const authorized = await authorizedAttachment(deps, request, params);
  if (authorized.kind === 'refused') return authorized.response;
  const { found } = authorized;

  const started = Date.now();
  const content = await readContent(deps, found);
  const contentScan = content.kind === 'text' || content.kind === 'pdf_text' ? scanAttachmentText(content.text) : null;
  const contentRisk = contentScan?.risk ?? null;
  // 진윤겸 결정 4 — `medium` 이상의 첨부 텍스트는 에이전트에게 주지 않는다(강제 모드). 관찰 모드면 주고 판정만 싣는다.
  const withheld = contentRisk !== null && WITHHOLD_FROM.has(contentRisk) && deps.riskHoldMode === 'enforce';
  // ADR-0016 A — 내용을 돌려주기 **전에** 노출을 기록한다(실패 503). 보류한 텍스트와 읽지 못한 종류는 보인 것이 없다 — 기록하지 않는다.
  // 이미지는 판정이 없다(이미지 속 글자는 스캔하지 않는다) → T2.
  if (!withheld && content.kind !== 'unsupported') {
    const refused = await recordExposure(deps.exposures, found.agentId, 'attachment_content', [
      {
        inboundMessageId: params.inboundMessageId,
        part: `attachment:${found.attachment.index}`,
        field: 'attachment_text',
        content: contentScan === null ? { risk: null, findings: [] } : contentScan,
      },
    ]);
    if (refused !== null) return refused;
  }
  log('info', 'api.attachment_content', {
    route_id: ATTACHMENT_CONTENT_ROUTE_ID,
    agent_id: found.agentId,
    message_id: params.inboundMessageId,
    outcome: content.kind,
    reason: content.kind === 'unsupported' ? content.reason : null,
    // 첨부 텍스트 주입 판정(닫힌 로그 어휘라 `verdict` 칸 — 텍스트가 아닌 종류는 null).
    verdict: contentRisk,
    latency_ms: Date.now() - started,
  });
  return jsonResponse(200, {
    message_id: params.inboundMessageId,
    from_authenticated: found.message.fromAuthenticated,
    injection_risk: found.message.injectionRisk,
    sender_trust: found.message.senderTrust,
    attachment: attachmentBody(found.attachment),
    ...(withheld && (content.kind === 'text' || content.kind === 'pdf_text') ? withheldBody(content) : contentBody(content)),
    ...(contentRisk === null ? {} : { content_injection_risk: contentRisk }),
  });
}

/**
 * 뽑은 텍스트의 주입 판정 — 수신 때와 같은 스캐너(`workers/inbound-consumer.ts` 의 `scanInbound`)를 본문 자리 하나로 부른다. 스캐너는
 * 던지지 않기로 약속했지만 수신 쪽과 같은 규율로 **실패는 닫힌 쪽**이다: 던지거나 모양이 틀리면 `high`(MCP 가 경고를 붙인다).
 */
function scanAttachmentText(text: string): { readonly risk: InjectionRisk; readonly findings: readonly TaintFinding[] } {
  try {
    const result = scanForInjection({ subject: null, text, htmlText: null });
    const risk = result.injectionRisk;
    // 적중 계열은 노출 기록(`agent_exposures.families`)에만 간다 — 닫힌 어휘다.
    const findings = result.findings.map((finding) => ({ family: finding.family, damped: finding.damped }));
    return { risk: risk === 'none' || risk === 'low' || risk === 'medium' || risk === 'high' ? risk : 'high', findings };
  } catch {
    return { risk: 'high', findings: [] };
  }
}
