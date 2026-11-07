/**
 * `POST /v1/messages` — **P1b 에서 실제로 보내는 유일한 경로** (`OUTBOUND_ROUTES.send`).
 *
 * 계획 §6 P1b 의 demo 가 이 파일을 지나간다:
 *   *"에이전트가 자기 @atmark.ai 로 시드 계정에 실제로 발송하고, allowlist 밖 수신자는
 *     SES 호출 0회로 막히고, 두 시도 모두 audit 에 남는 장면."*
 *
 * **`dispatch` 호출이 이 파일 안에 보이는 것이 요점이다.** 서비스 함수로 감싸면 라우트는
 * 관문을 타입으로만 알게 되고, Layer C 의 "등록된 진입점은 실제로 관문을 import 한다" 가
 * 형식적으로만 충족된다 — 매니페스트가 알리바이가 되는 상태다. 앞(`prepareOutbound`)과
 * 뒤(`finalizeOutbound`)만 공유하고, **가운데 한 줄은 각 경로가 직접 쓴다.**
 */

import { dispatch } from '../../policy/gate';
import type { ApiRequest, ApiResponse } from '../http';
import { toApiResponse } from '../outbound-http';
import { finalizeOutbound, gateDependenciesFor, prepareOutbound } from '../outbound-service';
import { preflight, type OutboundRouteDependencies } from '../route-context';
import type { OutboundTransport } from '../../policy/gate';

/** 매니페스트의 `id` 와 **같은 문자열이어야 한다** — 관문이 그 값으로 대조한다. */
const SEND_ROUTE_ID = 'send';

export interface SendRouteDependencies extends OutboundRouteDependencies {
  /**
   * 전송단. **주입받는다** — 이 파일이 `ses-transport.ts` 를 import 하면 Layer B 의
   * "전송단을 참조하는 프로덕션 파일은 관문뿐" 이 즉시 거짓이 된다. 조립은 프로세스의
   * 진입 지점(demo·워커 런타임)이 하고, 라우트는 인터페이스만 본다.
   */
  readonly transport: OutboundTransport;
}

export async function handleSend(
  deps: SendRouteDependencies,
  request: ApiRequest,
): Promise<ApiResponse> {
  const pre = await preflight(deps, request, SEND_ROUTE_ID, false);
  if (pre.kind === 'error') return pre.response;

  const prepared = await prepareOutbound(deps.service, pre.request);
  if (prepared.kind === 'settled') return toApiResponse(prepared.outcome);

  const outcome = await dispatch(
    gateDependenciesFor(deps.service, deps.transport),
    prepared.dispatchRequest,
  );

  return toApiResponse(await finalizeOutbound(deps.service, prepared, outcome));
}
