/**
 * src/api/exposure.ts — 읽기 라우트의 **노출 기록 한 줄**(ADR-0016 A). 본문을 돌려주기 **전에** 부르고, 실패하면 503 이다 — 기록 없이 본문을 주지
 * 않는다(fail closed). 기록이 없으면 발송 판정은 "이 에이전트가 방금 위험한 메일을 읽었다" 를 모르고, 그 모름은 열리는 쪽이다.
 *
 * 등급은 저장소가 DB 의 신뢰 사실로 매긴다(`db/repositories/exposure-store.ts`) — 라우트는 무엇을 보여 줬는지만 말한다. MCP 도구는 같은 라우트
 * 함수를 부르므로(`mcp/tools.ts`) 여기를 지난다.
 *
 * 코드 지문(배선 계약 3): 상세·스레드 노출 때도 본문에서 뽑은 코드 후보의 지문을 남긴다 — 인증 코드 조회 라우트를 거치지 않고 본문으로 코드를
 * 읽은 에이전트도 같다. 추출기(`src/mail/verification/**`)는 이 파일(읽기 쪽)만 import 한다 — 발송·정책·워커의 import 폐포에는 없다
 * (arch `verification-boundary`).
 */

import type { ExposedCode, ExposureItem, ExposureRecorder } from '../db/repositories/exposure-store';
import type { AgentId } from '../db/schema';
import { extractCodes, type MailText } from '../mail/verification/extract';
import { log } from '../observability/logger';
import { secretLinkTokens } from '../security/dlp/codes';
import { countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import type { ExposureSurface, TaintLevel } from '../security/taint';
import { errorResponse, type ApiResponse } from './http';

/** 읽기 면 → 관측의 `route_id`(닫힌 다섯 값). */
const SURFACE_ROUTE: Readonly<Record<ExposureSurface, string>> = {
  message_detail: 'exposure_message_detail',
  message_list: 'exposure_message_list',
  thread: 'exposure_thread',
  attachment_content: 'exposure_attachment_content',
  attachment_url: 'exposure_attachment_url',
  verification_code: 'exposure_verification_code',
};

/** 메일 한 통에서 뽑아 지문을 남길 코드 후보 상한 — 본문 응답이 코드를 판정하지 않으므로 넓게(지문은 좁히는 쪽으로만 쓴다). */
const CODES_PER_MAIL = 20;

/**
 * 메일 본문(제목 포함)의 코드 후보와 **URL 안 토큰**(재설정·로그인 링크 — 재검증 N2, 기준은 `security/dlp/codes.ts` `isSecretToken`) — 지문용.
 * 전달 라우트도 이것으로 "원문에 코드·비밀 링크가 있는가" 를 본다.
 */
export function codesIn(inboundMessageId: string, mail: MailText): ExposedCode[] {
  const codes = extractCodes(mail)
    .slice(0, CODES_PER_MAIL)
    .map((candidate): ExposedCode => ({ inboundMessageId, code: candidate.value }));
  const text = [mail.subject ?? '', mail.text, mail.htmlText ?? ''].join('\n');
  const links = secretLinkTokens(text).map((token): ExposedCode => ({ inboundMessageId, code: token, kind: 'link' }));
  return [...codes, ...links];
}

/**
 * 노출을 기록한다. 성공이면 `null`, 실패면 **503 응답**(호출자가 그대로 돌려준다). 기록 실패는 메트릭(`exposure.write_failed` — 알람)과 error 로그로
 * 남긴다(오류 문장은 로그에만).
 */
export async function recordExposure(
  recorder: ExposureRecorder,
  agentId: AgentId,
  surface: ExposureSurface,
  items: readonly ExposureItem[],
  codes: readonly ExposedCode[] = [],
): Promise<ApiResponse | null> {
  const recorded = await recordExposureLevels(recorder, agentId, surface, items, codes);
  return recorded.kind === 'refused' ? recorded.response : null;
}

/**
 * `recordExposure` 와 같다 — 성공이면 **항목 순서의 등급**도 돌려준다(묶음 B — 응답 `risk.taint`). 실패는 같은 503(fail closed).
 */
export async function recordExposureLevels(
  recorder: ExposureRecorder,
  agentId: AgentId,
  surface: ExposureSurface,
  items: readonly ExposureItem[],
  codes: readonly ExposedCode[] = [],
): Promise<{ readonly kind: 'ok'; readonly levels: readonly TaintLevel[] } | { readonly kind: 'refused'; readonly response: ApiResponse }> {
  const routeId = SURFACE_ROUTE[surface];
  let levels: readonly TaintLevel[];
  try {
    ({ levels } = await recorder.record({ agentId, surface, items, codes }));
  } catch (error) {
    countMetric(METRIC_NAMES.exposureWriteFailed, { route_id: routeId });
    log('error', 'exposure.write_failed', {
      route_id: routeId,
      agent_id: agentId,
      error_kind: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      kind: 'refused',
      response: errorResponse(
        503,
        'exposure_unavailable',
        'This email could not be opened right now because Atmark could not record that it was read. Try again shortly.',
      ),
    };
  }
  for (const level of ['T0', 'T1', 'T2'] as const) {
    const count = levels.filter((candidate) => candidate === level).length;
    if (count > 0) emitMetric(METRIC_NAMES.exposureRecorded, count, 'Count', { route_id: routeId, outcome: level });
  }
  return { kind: 'ok', levels };
}
