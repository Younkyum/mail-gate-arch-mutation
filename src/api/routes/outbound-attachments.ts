/**
 * `POST /v1/attachments` — **발신 첨부 업로드 생성**(메일 기본기 2차 A2, 스위치 `ATMARK_OUTBOUND_ATTACHMENTS_ENABLED` — 꺼지면 404 ·
 * `orgs:<uuid>,…` 이면 토큰의 에이전트 조직이 목록에 있을 때만 — 목록 밖·인증 실패는 404).
 *
 * 본문 `{agent_id, filename, mime_type, bytes, sha256}` → 201
 * `{attachment_id, expires_at, upload: {method: 'PUT', url, headers, expires_at}}`. 에이전트는 `upload.url` 에 `upload.headers` 그대로 바이트를
 * PUT 한다 — 헤더 넷(타입 · 길이 · SHA-256 · `if-none-match: *`)이 서명에 들어 있어 크기·내용이 다르거나 두 번째 PUT 이면 S3 가 거부한다.
 * 올린 뒤 GuardDuty 가 검사한다(보통 수 초~수십 초). 발송은 `send`·`reply` 의 `attachments: [attachment_id]`(검사 중이면 409).
 *
 * **발송이 아니다**(매니페스트 NON_SENDING) — 행 하나를 적고 서명된 URL 을 돌려줄 뿐 관문·전송단을 import 하지 않는다. 권한은 발송과 같은
 * `messages:send`(업로드는 보낼 메일의 일부다). **`Idempotency-Key` 는 선택이다**(묶음 B, 2026-10-08) — 주면 같은 키 + 같은 요청은 같은 첨부 id 와 새로
 * 서명한 업로드 URL(200 · `replayed: true` — 새 행 · 하루 상한 소모 없음), 다른 요청은 409 `idempotency_key_reused`, 만료된 첨부의 키는 409
 * `attachment_expired`. 주지 않으면 예전처럼 부를 때마다 새 첨부 id(하루 상한 100개가 남용을 묶는다).
 *
 * 빠른 거부: 발송이 막힌 에이전트·조직 403(보안 리뷰 L3) · 서명표 밖 MIME 400 · 파일명 모양·확장자 ↔ MIME·encoded-word 400(M1) · 한 파일이 요금제 메일당 첨부 한도를 넘으면 400 `attachment_too_large` · `text/plain` 1 MB ·
 * 하루 100개·200 MB 429 `attachment_daily_limit`. 최종 총량 판정은 Stage 6 이다.
 * 로그에 파일명·URL 을 싣지 않는다.
 */

import { isAgentId, toAgentId } from '../../db/schema';
import type { AgentTokenStore } from '../../identity/agent-token';
import { log } from '../../observability/logger';
import { countMetric, METRIC_NAMES } from '../../observability/metrics';
import { authenticateRequest, authorizeRequest, targetAgentOf } from '../auth';
import { errorResponse, headerOf, IDEMPOTENCY_KEY_HEADER, isJsonObject, jsonResponse, type ApiRequest, type ApiResponse } from '../http';
import {
  ATTACHMENT_BYTES_CEILING,
  ATTACHMENT_MIME_TYPES,
  isAttachmentMimeType,
  type OutboundAttachmentService,
} from '../outbound-attachments';

const ATTACHMENT_UPLOAD_ROUTE_ID = 'attachment_upload';

export interface AttachmentUploadRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly attachments: OutboundAttachmentService;
  readonly now: () => Date;
}

const KEYS: ReadonlySet<string> = new Set(['agent_id', 'filename', 'mime_type', 'bytes', 'sha256']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function rejected(response: ApiResponse): ApiResponse {
  const code = response.body['error'];
  countMetric(METRIC_NAMES.preflightRejected, { route_id: ATTACHMENT_UPLOAD_ROUTE_ID });
  log('warn', 'api.preflight_rejected', {
    route_id: ATTACHMENT_UPLOAD_ROUTE_ID,
    http_status: response.status,
    error_code: typeof code === 'string' ? code : null,
  });
  return response;
}

function notFound(): ApiResponse {
  return errorResponse(404, 'route_not_found', 'Route not found.');
}

/**
 * 단계 공개(허용목록) 모드에서 숨긴 404 — 응답은 `notFound()` 와 같지만 운영 쪽에는 거부로 센다(보안 리뷰 L-3 — 목록 밖 조직의 호출·토큰
 * 대입이 지표에 보이게). 사유만 싣는다(id 없음).
 */
function hiddenNotFound(reason: 'auth_failed_hidden' | 'rollout_closed'): ApiResponse {
  countMetric(METRIC_NAMES.preflightRejected, { route_id: ATTACHMENT_UPLOAD_ROUTE_ID });
  log('warn', 'api.preflight_rejected', { route_id: ATTACHMENT_UPLOAD_ROUTE_ID, http_status: 404, error_code: reason });
  return notFound();
}

export async function handleCreateAttachmentUpload(deps: AttachmentUploadRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  // 스위치가 꺼져 있으면 경로가 없는 것과 같다(라우터의 404 와 같은 모양).
  const rollout = deps.attachments.rollout;
  if (rollout === false) return notFound();
  // 선택 `Idempotency-Key` — 있으면 모양만 먼저 본다(보내기 경로와 같은 상한).
  const idempotencyKey = headerOf(request, IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey !== null && idempotencyKey.length > 255) {
    return rejected(errorResponse(400, 'invalid_request', `${IDEMPOTENCY_KEY_HEADER} must be 1 to 255 characters.`));
  }

  const now = deps.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  // 단계 공개(`orgs:<uuid>,…`) — 토큰의 에이전트가 속한 조직이 목록 밖이면 꺼짐과 같은 404. 인증 실패도 404 다(허용목록 모드에서는 누가
  // 부르든 열린 조직의 토큰이 아니면 경로가 없는 것과 같다 — 열려 있는지 드러내지 않는다).
  if (authentication.kind === 'error') return rollout === true ? rejected(authentication.response) : hiddenNotFound('auth_failed_hidden');
  if (rollout !== true && !(await deps.attachments.enabledFor(authentication.principal.agentId))) return hiddenNotFound('rollout_closed');

  const body = request.body;
  if (!isJsonObject(body)) return rejected(errorResponse(400, 'invalid_request', 'The request body must be a JSON object.'));
  const source = body;
  const unknown = Object.keys(source).find((key) => !KEYS.has(key));
  if (unknown !== undefined) return rejected(errorResponse(400, 'invalid_request', `Unknown field: ${unknown.slice(0, 40)}`));

  // `agent_id` 생략 = 토큰의 에이전트. 적었으면 형식 · 인가는 오늘과 같다.
  const agentIdRaw = source['agent_id'];
  if (agentIdRaw !== undefined && (typeof agentIdRaw !== 'string' || !isAgentId(agentIdRaw))) return rejected(errorResponse(400, 'invalid_request', 'agent_id must be 32 lowercase hex characters.'));
  const agentId = targetAgentOf(authentication.principal, agentIdRaw === undefined ? null : toAgentId(agentIdRaw));
  const forbidden = authorizeRequest(authentication.principal, 'messages:send', agentId);
  if (forbidden !== null) return rejected(forbidden);

  // 모양 · encoded-word · 확장자 ↔ MIME 은 서비스가 본다(`normalizeAttachmentFilename` — 확장자가 없으면 붙인다, 보안 리뷰 M1).
  const filename = source['filename'];
  if (typeof filename !== 'string') return rejected(errorResponse(400, 'invalid_request', 'filename is required.'));
  const mimeType = source['mime_type'];
  if (!isAttachmentMimeType(mimeType)) {
    return rejected(errorResponse(400, 'attachment_type_not_allowed', `mime_type must be one of: ${ATTACHMENT_MIME_TYPES.join(', ')}.`));
  }
  const bytes = source['bytes'];
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > ATTACHMENT_BYTES_CEILING) {
    return rejected(errorResponse(400, 'invalid_request', `bytes must be an integer from 1 to ${String(ATTACHMENT_BYTES_CEILING)}.`));
  }
  const sha256 = source['sha256'];
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return rejected(errorResponse(400, 'invalid_request', 'sha256 must be 64 lowercase hex characters.'));

  const outcome = await deps.attachments.createUpload(
    { agentId, filename, mimeType, bytes, sha256, ...(idempotencyKey === null ? {} : { idempotencyKey }) },
    now,
  );
  if (!('kind' in outcome)) return rejected(errorResponse(outcome.status, outcome.code, outcome.detail));
  log('info', 'api.attachment_upload_created', { route_id: ATTACHMENT_UPLOAD_ROUTE_ID, agent_id: agentId, outcome: outcome.kind });
  return jsonResponse(outcome.kind === 'replayed' ? 200 : 201, {
    replayed: outcome.kind === 'replayed',
    attachment_id: outcome.row.id,
    // 저장된 파일명(확장자를 붙였으면 붙인 이름) — 받는 쪽에 보이는 이름이다.
    filename: outcome.row.filename,
    expires_at: outcome.row.expiresAt.toISOString(),
    upload: {
      method: outcome.upload.method,
      url: outcome.upload.url,
      headers: outcome.upload.headers,
      expires_at: outcome.upload.expiresAt.toISOString(),
    },
  });
}
