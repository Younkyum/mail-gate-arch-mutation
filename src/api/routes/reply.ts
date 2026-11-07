/**
 * `POST /v1/threads/:id/reply` — 받은 메일에 답한다 (`OUTBOUND_ROUTES.reply`, P3b).
 *
 * **이 라우트는 스레드 권한을 주지 않는다.** 하는 일은 셋뿐이다:
 *   ① 본문의 `in_reply_to`(수신 메일 id)로 **이 에이전트의** 수신 메일을 찾는다 — 없거나 격리면 404, 그 메일의
 *      권한용 스레드가 경로의 `:id` 와 다르면 400.
 *   ② 그 메일에서 회신의 모양을 정한다: 기본 수신자(인증된 `From`), `Re:` 제목, `In-Reply-To`·`References`.
 *   ③ 그 메일의 **권한용** 스레드를 **주장으로** 관문에 싣는다.
 * 이 회신이 사람 승인 없이 나가도 되는가는 관문의 로더가 DB 에서 **다시** 읽어 정한다
 * (`policy-loader.resolveThreadReply`): 에이전트 소유 · 인증 수신 존재 · 수신자 전원이 그 스레드의 인증 발신자.
 * 그 위에서 Stage 7 이 스레드를 연 쪽(`started_by`)과 답하는 메일의 판정을 본다(`rules/outbound-mode.ts`).
 *
 * ---
 *
 * **`Reply-To` 판단 — 쓰지 않는다.** `Reply-To` 는 발신자가 마음대로 쓰는 헤더이고 DMARC 가 인증하지 않는다.
 * `From: ceo@partner.com`(인증됨) + `Reply-To: attacker@evil.example` 인 메일에 `Reply-To` 로 답하면, 스레드
 * 회신 면제가 **인증된 상대가 아니라 공격자가 고른 주소**에 적용된다. 그래서:
 *   - 기본 수신자는 **인증된 `From`** 이다. `Reply-To` 는 저장조차 하지 않는다(`inbound_messages` 에 컬럼이 없다).
 *   - 에이전트가 다른 주소(본문에서 읽은 `Reply-To` 등)로 답하려면 `to` 로 **명시**할 수 있다. 그 주소는 그 스레드의
 *     인증 발신자가 아니므로 로더가 스레드 회신으로 인정하지 않고 → `approval_required` 면 사람 승인,
 *     `reply_only` 면 grace 뒤 거부로 떨어진다. 즉 "다르면 승인 쪽" 이 라우트가 아니라 **정책**에서 성립한다.
 *   - `From` 이 인증되지 않은 메일(DMARC 불통과)에 답하는 것도 같다 — 참여자가 아니므로 승인 쪽이다.
 *
 * **`Idempotency-Key` 는 필수다**(§4.5-1, Layer D 가 자동 검사). 순서는 `preflightWith` 가 지킨다.
 */

import { isOutboundRecipientAddress } from '../../policy/contact-rules';
import { dispatch, type OutboundTransport } from '../../policy/gate';
import { replyThreading } from '../../mail/mime/build';
import { normalizeSubject } from '../../mail/thread/resolve';
import type { ReplyTarget, ReplyTargetLookup } from '../../db/repositories/reply-target-store';
import type { InboundArtifactReader } from '../../storage/inbound-artifact-store';
import { codesIn } from '../exposure';
import { decodeParsedDocument } from '../inbound-view';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import { errorResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { INVALID_RECIPIENT, invalidRecipientDetail, parseReplyBody, toApiResponse } from '../outbound-http';
import { finalizeOutbound, gateDependenciesFor, prepareReplyOutbound, type CopyTarget } from '../outbound-service';
import { preflightWith, type OutboundRouteDependencies } from '../route-context';

const REPLY_ROUTE_ID = 'reply';

export interface ReplyRouteDependencies extends OutboundRouteDependencies {
  /** 전송단. 주입받는다 — 이 파일이 `ses-transport.ts` 를 import 하면 Layer B 가 깨진다(`send.ts` 와 같다). */
  readonly transport: OutboundTransport;
  /** 답하는 수신 메일 조회. **권한을 주지 않는다** — 헤더·기본 수신자·제목만 정한다. */
  readonly replyTargets: ReplyTargetLookup;
  /** 수신자를 바꾼 회신의 원문 읽기(ADR-0016 재검증 N2 ①). */
  readonly artifacts: InboundArtifactReader;
}

/**
 * **수신자를 바꾼 회신의 복사 비교**(ADR-0016 재검증 N2 ① — 리드 결정). 수신자 중 대상 메일 발신자가 아닌 주소가 하나라도 있으면, 대상 메일을 복사
 * 비교에 **무조건** 넣는다 — 저장된 지문(`inbound_fingerprints`)이 없어도(이 기능 전 · 30일 밖 · 2,000통 밖) 이 자리에서 지문화한다. 짧은 메일(재설정
 * 링크 한 줄)은 8-gram 지문이 거의 없으므로 그 메일의 코드·URL 토큰도 싣는다 — 회신 본문에 그대로 있으면 `inbound_copy` 다(전달 H3 와 같은 취지).
 * 수신자 전원이 원 발신자면 싣지 않는다(인용 회신은 정상). 스레드 참여자 제외(배선 계약 5)는 저장된 지문과 같게 서비스가 건다.
 * 답장 초안 보내기(`draft-send.ts`)도 같은 함수를 쓴다 — 두 경로의 복사 비교가 갈라지지 않게.
 */
export async function copyTargetsOf(deps: Pick<ReplyRouteDependencies, 'artifacts'>, target: ReplyTarget, recipients: readonly string[]): Promise<CopyTarget[]> {
  const sender = target.fromAddress.trim().toLowerCase();
  if (recipients.every((recipient) => recipient.trim().toLowerCase() === sender)) return [];
  const original =
    target.parsedStorageKey === undefined ? null : decodeParsedDocument(await deps.artifacts.readParsed(target.parsedStorageKey));
  const mail = { subject: original?.subject ?? target.subject, text: original?.text ?? '', htmlText: original?.htmlText ?? null };
  return [
    {
      inboundMessageId: target.inboundMessageId,
      threadId: target.threadId,
      senderAddress: sender,
      text: [mail.subject ?? '', mail.text, mail.htmlText ?? ''].join('\n'),
      secrets: codesIn(target.inboundMessageId, mail),
    },
  ];
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]+/g;

/**
 * 받은 제목 → 회신 제목. 이미 `Re:` 로 시작하면 그대로(겹치지 않게), 아니면 `Re: ` 를 붙인다.
 * 받은 제목은 외부인이 쓴 값이다 — 제어문자는 공백으로 바꾼다(헤더 인코딩은 `build.ts` 가 다시 한다).
 * 받은 제목이 비었으면 `null` — 에이전트가 제목을 적어야 한다(제목 없는 메일은 스팸 시그널, AC-2).
 */
export function replySubject(received: string | null): string | null {
  const cleaned = (received ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (normalizeSubject(cleaned).normalized === '') return null;
  return /^re\s*:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
}

/** 관문 앞에서 끝난 요청을 방출한다 — `route-context.observeRejection` 과 같은 축(관문 지표에 안 보이는 유일한 축). */
function rejectBeforeGate(response: ApiResponse): ApiResponse {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: REPLY_ROUTE_ID });
  log('warn', 'api.preflight_rejected', {
    route_id: REPLY_ROUTE_ID,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
  return response;
}

export async function handleReply(
  deps: ReplyRouteDependencies,
  request: ApiRequest,
  params: { readonly threadId: string },
): Promise<ApiResponse> {
  const pre = await preflightWith(deps, request, REPLY_ROUTE_ID, parseReplyBody);
  if (pre.kind === 'error') return pre.response;
  const body = pre.body;

  if (!UUID_PATTERN.test(params.threadId)) {
    return rejectBeforeGate(errorResponse(400, 'invalid_request', 'thread id must be a lowercase uuid.'));
  }

  // **에이전트 범위로** 찾는다(인가는 본문 `agent_id` 로 끝났다). 남의 에이전트의 메일 id 는 없는 것과 같고,
  // 격리 메일도 같다 — 에이전트가 볼 수 없는 메일에 답할 수 없다(`forward.ts` 와 같은 선).
  const target = await deps.replyTargets.find(body.agentId, body.inReplyTo);
  if (target === null || target.quarantined) {
    return rejectBeforeGate(
      errorResponse(404, 'message_not_found', `No received email matches in_reply_to=${body.inReplyTo}.`),
    );
  }
  if (target.threadId !== params.threadId) {
    // 경로의 스레드와 답하는 메일의 **권한용** 스레드가 다르다. 어느 쪽을 믿을지 고르지 않는다.
    return rejectBeforeGate(
      errorResponse(400, 'invalid_request', 'The in_reply_to email does not belong to the thread in the path.'),
    );
  }

  // 기본 수신자(받은 `From`)도 발신 수신자 모양이어야 한다(202609241040 — 검증 M2). 받은 메일의 `From` 은 파서의 넓은 모양만
  // 지났다 — 따옴표 로컬파트·끝 점 도메인이면 차단·억제 비교를 비껴간다. 관문의 선적재도 같은 검사로 끊지만(`evaluation_error`),
  // 에이전트에게는 "왜" 를 400 으로 먼저 준다.
  if (body.recipients === null && !isOutboundRecipientAddress(target.fromAddress)) {
    return rejectBeforeGate(errorResponse(400, INVALID_RECIPIENT, invalidRecipientDetail([target.fromAddress])));
  }

  // `from` 생략 — 받은 봉투 주소가 활성이면 그것, 아니면 대표(메일 기본기 2차 · 리드 판정 2026-09-27). 판정은 여전히 Stage 1 이 한다.
  const fromAddress = body.fromAddress ?? target.defaultFromAddress ?? null;
  if (fromAddress === null) {
    return rejectBeforeGate(errorResponse(400, 'invalid_request', 'from is required because this email has no default sending address.'));
  }

  const subject = body.subject ?? replySubject(target.subject);
  if (subject === null) {
    return rejectBeforeGate(errorResponse(400, 'invalid_request', 'The received email has no subject, so subject is required.'));
  }

  const recipients = body.recipients ?? [target.fromAddress];
  const copyTargets = await copyTargetsOf(deps, target, recipients);

  const prepared = await prepareReplyOutbound(
    deps.service,
    {
      routeId: REPLY_ROUTE_ID,
      agentId: body.agentId,
      idempotencyKey: pre.idempotencyKey,
      fromAddress,
      // 기본은 받은 `From` 이다(인증 여부와 무관하게 — 인증되지 않았으면 로더가 참여자로 치지 않는다).
      // `Reply-To` 는 쓰지 않는다(머리말).
      recipients,
      subject,
      text: body.text,
      html: body.html,
      isThreadReply: false,
      traceId: body.traceId,
      costCents: body.costCents,
      ...(body.attachmentIds.length === 0 ? {} : { attachmentIds: body.attachmentIds }),
      ...(copyTargets.length === 0 ? {} : { copyTargets }),
    },
    {
      threadId: target.threadId,
      inboundMessageId: target.inboundMessageId,
      threading: replyThreading(target.messageIdHeader, target.inReplyTo === null ? [] : [target.inReplyTo]),
    },
  );
  if (prepared.kind === 'settled') return toApiResponse(prepared.outcome);

  const outcome = await dispatch(gateDependenciesFor(deps.service, deps.transport), prepared.dispatchRequest);

  return toApiResponse(await finalizeOutbound(deps.service, prepared, outcome));
}
