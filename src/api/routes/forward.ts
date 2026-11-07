/**
 * `POST /v1/messages/:id/forward` — 받은 메일(`inbound_messages.id`)을 새 수신자에게 전달 (P3c, `OUTBOUND_ROUTES.forward`).
 *
 * **관문을 지난다.** 새 수신자는 이 에이전트에게 첫 연락일 수 있고, 그 판단은 Stage 7 의 것이다 — 전달이라서
 * 면제되는 것은 없다. 시도는 회신이 아니다(`isThreadReply: false`): 새 `messages` 행이 새 에이전트 스레드를 연다.
 *
 * 순서: ① `Idempotency-Key` → ② 인증 → ③ 본문 → ④ 인가(본문 `agent_id`) → ⑤ 원 메일 조회 → ⑥ 조립 → 관문.
 * ①~④ 는 `preflightWith`(다른 발송 경로와 같은 절차)다.
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * **① 격리 메일은 전달할 수 없다.** 원 메일 조회는 에이전트 컨텍스트 저장소(`inbound-read-store.ts`)로만 한다 —
 *   격리 행은 결과에 없으므로 **없는 id 와 같은 404** 다. 에이전트가 볼 수 없는 것을 에이전트가 내보낼 수 없다.
 *
 * **② `injection_risk` 가 `none` 이 아니면 전달하지 않는다(422, 관문 앞).** 보이는 메일의 위험도는 `none`·`low`
 *   둘이다(격리 문턱 `medium`). 전달은 원문을 **우리 도메인·DMARC 통과 발신자** 이름으로 새 상대에게 옮긴다 —
 *   `low` 의 지시문 조각이 "신뢰할 수 있는 atmark 에이전트가 보낸 메일" 로 세탁되어, 그 상대가 에이전트라면 그쪽
 *   컨텍스트에 그대로 들어간다(에이전트 간 injection 전파). 계획 §3.4 3조가 사람 없는 발송 문에 거는 전제
 *   (`injection_risk == none`)와 같은 선을 긋는다. 거부는 관문 앞이다 — 관문에는 본문 위험도를 볼 축이 없고,
 *   정책 모듈은 이 조각의 소유가 아니다. 에이전트가 내용을 옮겨야 하면 **자기 말로** `POST /v1/messages` 를
 *   쓴다(그 발송은 관문 전체를 지난다). 판정 없음(NULL)은 격리이므로 ①에서 이미 끝난다.
 *
 * **③ Thin slice — 첨부는 전달하지 않는다.** 본문에 "[첨부 N개 미전달]" 한 줄을 넣고 응답에 개수를 싣는다
 *   (조용히 빠뜨리면 받는 쪽은 첨부가 원래 없었다고 읽는다). 첨부 재조립은 MIME 빌더의 일이고 P3b 소유다.
 *
 * **④ 본문은 `text` 만, HTML 없음.** 전달 본문 = (선택) 에이전트 메모 + 전달 헤더 블록 + 원 메일 `text`.
 *   원 메일의 HTML 원본은 우리에게 없고(파싱 결과 문서에 없다), 변환 텍스트를 HTML 로 되돌리지 않는다.
 */

import { registrableDomainOf } from '../../domains/psl';
import { dispatch } from '../../policy/gate';
import type { DlpFamily } from '../../security/dlp/scan';
import { isSharedMailboxDomain } from '../../security/shared-mailbox';
import type { InboundReadStore } from '../../db/repositories/inbound-read-store';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import type { InboundArtifactReader } from '../../storage/inbound-artifact-store';
import { errorResponse, isJsonObject, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { codesIn } from '../exposure';
import { decodeParsedDocument, type InboundBody } from '../inbound-view';
import { parseSendBody, rejectAttachmentsOn, toApiResponse } from '../outbound-http';
import { MAX_SUBJECT_LENGTH, finalizeOutbound, gateDependenciesFor, prepareOutbound } from '../outbound-service';
import { preflightWith } from '../route-context';
import type { SendRouteDependencies } from './send';

const FORWARD_ROUTE_ID = 'forward';

export interface ForwardRouteDependencies extends SendRouteDependencies {
  /** 원 메일 조회 — **에이전트 컨텍스트 저장소**(격리 행이 결과에 없다). */
  readonly inbound: Pick<InboundReadStore, 'findVisible'>;
  readonly artifacts: InboundArtifactReader;
}

/** 전달 헤더 블록의 구분선. 받는 쪽 메일 클라이언트가 전달로 인식하는 관행적 모양(Gmail 과 같다). */
const FORWARD_SEPARATOR = '---------- Forwarded message ---------';

/**
 * 전달 본문 파서 — 발송 본문(`parseSendBody`)과 같되 **`subject`·`text` 가 선택**이다(없으면 원 메일에서 만든다).
 * `html` 은 받지 않는다(판단 ④) — 주면 400: 조용히 버리면 에이전트는 자기 HTML 이 나갔다고 믿는다.
 */
function parseForwardBody(body: unknown): ReturnType<typeof parseSendBody> {
  if (!isJsonObject(body)) return parseSendBody(body);
  const source = body;
  // 첨부는 새 메일·답장만(D8) — 전달은 원 메일의 첨부도 싣지 않는다.
  const attachmentsHere = rejectAttachmentsOn('forwarding', source);
  if (attachmentsHere !== null) return { kind: 'error', response: attachmentsHere };
  if (source['html'] !== undefined && source['html'] !== null) {
    return { kind: 'error', response: errorResponse(400, 'invalid_request', 'forward does not accept html. The original email is forwarded as text.') };
  }
  return parseSendBody({
    ...source,
    subject: typeof source['subject'] === 'string' ? source['subject'] : '',
    text: typeof source['text'] === 'string' ? source['text'] : '',
  });
}

function rejectBeforeGate(response: ApiResponse): ApiResponse {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: FORWARD_ROUTE_ID });
  log('warn', 'api.preflight_rejected', {
    route_id: FORWARD_ROUTE_ID,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
  return response;
}

function forwardedSubject(requested: string, original: string | null): string {
  const chosen = requested.trim() !== '' ? requested : `Fwd: ${original ?? ''}`.trim();
  return chosen.slice(0, MAX_SUBJECT_LENGTH);
}

function forwardedText(note: string, original: InboundBody, attachmentCount: number): string {
  const from = original.from.name === null ? original.from.address : `${original.from.name} <${original.from.address}>`;
  const lines = [
    FORWARD_SEPARATOR,
    `From: ${from}`,
    ...(original.date === null ? [] : [`Date: ${original.date}`]),
    `Subject: ${original.subject ?? ''}`,
    ...(original.to.length === 0 ? [] : [`To: ${original.to.map((a) => a.address).join(', ')}`]),
    '',
    original.text,
  ];
  if (attachmentCount > 0) lines.push('', `[Attachments not forwarded: ${String(attachmentCount)}]`);
  const block = lines.join('\n');
  return note.trim() === '' ? block : `${note}\n\n${block}`;
}

/**
 * **전달의 결정론적 DLP**(ADR-0016 리뷰 H3). 전달은 받은 메일의 **복사**다 — 에이전트가 그 메일을 읽지 않았어도(노출 0), 그 메일의 지문이
 * 없어도(이 기능 전에 받은 메일 · 30일 지난 메일 · 비교 상한 2,000통 밖) 같다. 그래서 지문 비교에 기대지 않고 정한다:
 *   - 수신자 중 **원 발신자가 아닌 주소**가 하나라도 있으면 `inbound_copy`(원 발신자에게 되돌리는 전달만 아니다).
 *   - 원문(제목 · text · html 변환 텍스트)에서 뽑은 코드 후보가 있으면 `verification_code`, URL 토큰(비밀 링크)이 있으면 `secret_link` — 수신자 등록 도메인이 **전부** 원 발신 등록 도메인이고
 *     그 도메인이 무료·공용 메일이 아닐 때만 뺀다(발신 DLP 의 출처 도메인 제외와 같은 규칙). 지문을 남기지 않는다(직접 비교).
 */
function forwardDlp(inboundMessageId: string, fromAddress: string, recipients: readonly string[], original: InboundBody): DlpFamily[] {
  const sender = fromAddress.trim().toLowerCase();
  const to = recipients.map((recipient) => recipient.trim().toLowerCase());
  const families: DlpFamily[] = [];
  if (to.some((recipient) => recipient !== sender)) families.push('inbound_copy');
  const secrets = codesIn(inboundMessageId, { subject: original.subject, text: original.text, htmlText: original.htmlText });
  if (secrets.length > 0) {
    const domainOf = (address: string): string => {
      const domain = address.slice(address.lastIndexOf('@') + 1);
      return registrableDomainOf(domain) ?? domain;
    };
    const origin = domainOf(sender);
    const sameService = !isSharedMailboxDomain(origin) && to.length > 0 && to.every((recipient) => domainOf(recipient) === origin);
    if (!sameService && secrets.some((secret) => secret.kind !== 'link')) families.push('verification_code');
    if (!sameService && secrets.some((secret) => secret.kind === 'link')) families.push('secret_link');
  }
  return families;
}

export async function handleForward(
  deps: ForwardRouteDependencies,
  request: ApiRequest,
  params: { readonly inboundMessageId: string },
): Promise<ApiResponse> {
  const pre = await preflightWith(deps, request, FORWARD_ROUTE_ID, parseForwardBody);
  if (pre.kind === 'error') return pre.response;

  if (!UUID_PATTERN.test(params.inboundMessageId)) {
    return rejectBeforeGate(errorResponse(400, 'invalid_request', 'message id must be a lowercase uuid.'));
  }

  // ① 격리·없음은 같은 404 — 에이전트 컨텍스트 저장소가 격리 행을 돌려주지 않는다.
  const source = await deps.inbound.findVisible(params.inboundMessageId);
  if (source === null) {
    return rejectBeforeGate(errorResponse(404, 'message_not_found', `No received email with message_id=${params.inboundMessageId}.`));
  }
  // 인가는 ④ 에서 본문의 agent_id 로 끝났다. 원 메일이 **그 에이전트의 것**이어야 한다 — 남의 메일을 자기
  // 이름으로 전달하는 경로를 닫는다.
  if (source.agentId !== pre.body.agentId) {
    return rejectBeforeGate(errorResponse(403, 'forbidden', 'not_own_agent'));
  }
  // ② injection 위험이 있는 원문은 전달하지 않는다.
  if (source.injectionRisk !== 'none') {
    return rejectBeforeGate(
      errorResponse(
        422,
        'forward_refused_injection_risk',
        `The original email has injection_risk=${source.injectionRisk}, so it is not forwarded to new recipients. To share its content, write your own message with POST /v1/messages.`,
      ),
    );
  }

  const original = decodeParsedDocument(await deps.artifacts.readParsed(source.parsedStorageKey));
  const subject = forwardedSubject(pre.body.subject, original.subject);
  const text = forwardedText(pre.body.text, original, source.attachments.length);
  const extraDlp = forwardDlp(source.id, source.fromAddress, pre.body.recipients, original);

  const prepared = await prepareOutbound(deps.service, {
    routeId: FORWARD_ROUTE_ID,
    agentId: pre.body.agentId,
    idempotencyKey: pre.idempotencyKey,
    fromAddress: pre.body.fromAddress,
    recipients: pre.body.recipients,
    subject,
    text,
    html: null,
    isThreadReply: false,
    traceId: pre.body.traceId,
    costCents: pre.body.costCents,
    extraDlp,
  });
  if (prepared.kind === 'settled') return toApiResponse(prepared.outcome);

  const outcome = await dispatch(gateDependenciesFor(deps.service, deps.transport), prepared.dispatchRequest);
  const response = toApiResponse(await finalizeOutbound(deps.service, prepared, outcome));
  return {
    status: response.status,
    body: {
      ...response.body,
      forwarded_from: params.inboundMessageId,
      attachments_forwarded: 0,
      attachments_omitted: source.attachments.length,
    },
  };
}
