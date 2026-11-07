/**
 * `GET | HEAD | POST /approve` — **소유자 매직링크의 착지점** (계획 §3.4 5조).
 *
 * 규칙은 전부 `src/approval/magic-link.ts` 에 있고(위협 모델 T1–T8, 미리보기 → 결정 2단계), 트랜잭션
 * 조립은 `src/db/repositories/approval-link-use-store.ts` 의 `createPostgresApprovalLinkPorts` 에 있다.
 * 이 파일은 **둘을 잇고 결말만 관측한다.**
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 승인은 발송이 아니다 — 상태를 `approved` 로 바꾸고
 * standing approval 을 만들 뿐이며, 보내는 것은 릴리스 워커(`workers/approval-release`)가 관문을 다시
 * 지나며 한다(`approval/service.ts` 머리말 1·2). 그래서 이 파일의 전이적 import 폐포에도 관문이 없어야
 * 하고, `test/arch/approval-boundary.arch.test.ts` 가 그것을 본다.
 *
 * **토큰을 로그에 싣지 않는다**(T6). 여기서 남기는 것은 메서드와 상태 코드뿐이다 — 토큰도 approval id 도
 * 이 층에서는 보지 않는다(검증 전의 id 는 공격자 입력이다).
 */

import {
  handleApprovalLinkRequest,
  type ApprovalLinkHttpRequest,
  type ApprovalLinkHttpResponse,
  type ApprovalLinkPorts,
} from '../../approval/magic-link';
import { log } from '../../observability/logger';

const APPROVAL_LINK_ROUTE_ID = 'approval_link';

export interface ApprovalLinkRouteDependencies {
  readonly ports: ApprovalLinkPorts;
  readonly now: () => Date;
}

export async function handleApprovalLink(
  deps: ApprovalLinkRouteDependencies,
  request: ApprovalLinkHttpRequest,
): Promise<ApprovalLinkHttpResponse> {
  const response = await handleApprovalLinkRequest(request, deps.ports, deps.now());
  log(response.status >= 500 ? 'error' : 'info', 'approval.link', {
    route_id: APPROVAL_LINK_ROUTE_ID,
    http_status: response.status,
    detail: request.method.toUpperCase().slice(0, 8),
  });
  return response;
}
