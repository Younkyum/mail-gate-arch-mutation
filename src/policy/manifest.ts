/**
 * 발송 위상(topology) 선언 — AC-8 의 단일 진실 원천. Layer C(진입점 전수 분할)가 `ARCH_PARTITIONED_DIRS` 의 모든 파일을
 * 아래 네 범주와 대조하므로, 등록되지 않은 진입점은 존재하는 즉시 CI 가 막는다(계획 §5.0 Layer C/D, §4.5).
 */

import type { HumanApprovalReason } from './types';

/** 진입점의 구동 방식. `http`는 API 라우트, `worker`는 큐/스케줄 소비자. */
export type OutboundRouteKind = 'http' | 'worker';

/** 발송 경로 공통 필드. */
interface OutboundRouteBase {
  /** 유일 식별자 — audit·metrics 의 `route_id`. */
  readonly id: string;
  /** 리포 루트 기준 상대 경로(Layer C 가 매칭한다). */
  readonly file: string;
  /** 사람이 읽는 참조(예: `POST /v1/messages`, `workers/scheduled-sender`). */
  readonly ref: string;
  /** 걷어낼 날짜(ISO) — 그 뒤 CI 가 경고한다(한시적 경로용). */
  readonly deprecateAfter?: string;
}

/**
 * HTTP 경로. **`requiresIdempotencyKey` 는 리터럴 `true`** — 모든 http 경로가 `Idempotency-Key` 를 요구한다(§4.5).
 * 키 없는 http 경로는 컴파일되지 않고, Layer D 가 같은 명제를 한 번 더 단언한다.
 */
export interface OutboundHttpRoute extends OutboundRouteBase {
  readonly kind: 'http';
  readonly requiresIdempotencyKey: true;
  /**
   * 이 경로의 시도는 사람 승인 없이 나갈 수 없다(§3.2 2단계, AC-b1) — 값은 승인 대기 사유. 요청 본문이 아니라 매니페스트에
   * 있어 에이전트가 끌 수 없고, Stage 7 은 좁히는 방향으로만 읽는다. 부재 = 평소의 Stage 7.
   */
  readonly requiresHumanApproval?: HumanApprovalReason;
}

/** 워커 경로. 헤더가 없어 키 대신 §4.5-3 의 조건부 UPDATE lease 가 멱등성을 진다. */
export interface OutboundWorkerRoute extends OutboundRouteBase {
  readonly kind: 'worker';
  readonly requiresIdempotencyKey?: false;
}

/** 발송 경로 매니페스트의 항목. */
export type OutboundRoute = OutboundHttpRoute | OutboundWorkerRoute;

/**
 * 발송을 일으키는(관문을 import 하는) 모든 진입점. 등록하지 않으면 Layer C 가 미분류로 막고, 등록만 하고 관문을 건너뛰면
 * 역방향 단언이 잡는다 — 등록이 알리바이가 되지 않는다. `as const` 를 쓰지 않는다(arch 테스트가 유니온 판별 필드를 읽는다).
 */
export const OUTBOUND_ROUTES: readonly OutboundRoute[] = [
  {
    id: 'send',
    kind: 'http',
    file: 'src/api/routes/send.ts',
    ref: 'POST /v1/messages',
    requiresIdempotencyKey: true,
  },
  {
    id: 'reply',
    kind: 'http',
    file: 'src/api/routes/reply.ts',
    ref: 'POST /v1/threads/:id/reply',
    requiresIdempotencyKey: true,
  },
  {
    id: 'forward',
    kind: 'http',
    file: 'src/api/routes/forward.ts',
    ref: 'POST /v1/messages/:id/forward',
    requiresIdempotencyKey: true,
  },
  {
    // 멱등성은 lease 와 잡이 들고 오는 안정적인 `idempotency_key` 가 진다.
    id: 'scheduled_send',
    kind: 'worker',
    file: 'src/workers/scheduled-sender.ts',
    ref: 'workers/scheduled-sender',
  },
  {
    // 승인된 요청의 발송(§4.3) — 관문을 재통과하고 대기 audit 행을 갱신한다. 관문 호출을 워커 진입점에 두어야 Layer C 분할 안에 선다.
    // 멱등성은 기존 messages 행의 lease 가 진다.
    id: 'approval_release',
    kind: 'worker',
    file: 'src/workers/approval-release.ts',
    ref: 'workers/approval-release',
  },
  {
    // §3.2 2단계(AC-b1·b2) — seed 전원에게 1통씩, 승인 대기 시도들이 배치 요청 1개를 공유한다.
    // `requiresHumanApproval` 이 필요한 이유: 수신자가 seed 라 표지가 없으면 승인 없이 통과한다. 실제 발송은 `approval_release`.
    id: 'transition_announcement',
    kind: 'http',
    file: 'src/api/routes/transition-announcement.ts',
    ref: 'POST /v1/agents/:id/transition-announcement',
    requiresIdempotencyKey: true,
    requiresHumanApproval: 'transition_announcement',
  },
  {
    // 초안 보내기 — 내용의 출처(초안 행)만 다르고 앞·관문·뒤는 `send`·`reply` 와 같다. 보낸 초안은 굳는다(DB 트리거).
    id: 'draft_send',
    kind: 'http',
    file: 'src/api/routes/draft-send.ts',
    ref: 'POST /v1/drafts/:id/send',
    requiresIdempotencyKey: true,
  },
];

/** 발송하지 않는 진입점. `reason` 필수 — 사람이 관리하는 예외 통로라 이유 없는 한 줄이 우회 경로가 된다. */
export interface NonSendingEntrypoint {
  /** 리포 루트 기준 상대 경로. */
  readonly file: string;
  /** 왜 이 진입점이 발송하지 않는가 — 리뷰 대상 문장. */
  readonly reason: string;
}

/** 발송하지 않는 진입점 허용 목록. 여기 적고 관문을 import 하면 Layer C 가 잡는다(분류는 양방향). */
export const NON_SENDING_ENTRYPOINTS: readonly NonSendingEntrypoint[] = [
  {
    file: 'src/api/routes/audit.ts',
    reason:
      'GET /v1/audit — 조회 전용(AC-9 "왜 이 메일이 나갔는가"). 읽기만 하며 관문을 import 하지 ' +
      '않는다. 이 파일에서 발송이 필요해지는 날은 이 줄을 지우고 OUTBOUND_ROUTES 로 옮기는 날이다.',
  },
  {
    file: 'src/workers/approval-expiry.ts',
    reason:
      'TTL 스위퍼(§3.4 4조). **만료의 뜻이 "보내지 않는다" 이다** — 요청·audit 행·messages 를 denied 로 ' +
      '닫을 뿐 발송을 일으키지 않는다. auto-send 는 설정으로도 불허이므로 이 파일이 관문을 import 하는 ' +
      '날은 설계가 뒤집힌 날이다. 전이적 폐포는 test/arch/approval-boundary.arch.test.ts 가 따로 본다.',
  },
  {
    file: 'src/workers/ses-event-consumer.ts',
    reason:
      'SES 이벤트 소비자(ADR-0004). **방향이 반대인 워커다** — 발송의 결과를 받아 적을 뿐 ' +
      '발송을 일으키지 않는다. 관문을 import 하지 않으며, 이 워커가 쓰는 ses_events 를 읽는 것은 ' +
      '관문 쪽(SendEvidenceLookup)이다. 그 의존이 역방향으로 뒤집혀 이 파일이 관문을 부르게 되는 ' +
      '날은 "이벤트가 발송을 촉발한다" 는 뜻이고, 그때는 OUTBOUND_ROUTES 로 옮겨야 한다.',
  },
  // ---- P2 T1: 승인 표면 + 웹훅 배선 ----
  {
    file: 'src/api/routes/approval-link.ts',
    reason:
      'GET|HEAD|POST /approve — 소유자 매직링크(§3.4 5조). **승인은 발송이 아니다**: 요청을 approved 로 ' +
      '바꾸고 standing approval 을 만들 뿐이며, 보내는 것은 approval_release 워커가 관문을 다시 지나며 한다. ' +
      '전이적 폐포에도 관문이 없다(test/arch/approval-boundary.arch.test.ts). 이 파일이 관문을 부르는 날은 ' +
      '"승인 = 즉시 발송" 으로 재평가(kill-switch·억제·캡)를 건너뛰는 날이다.',
  },
  {
    file: 'src/api/routes/approvals.ts',
    reason: 'GET /v1/approvals/{id} — 조회 전용(§3.4 1조, 웹훅 유실 대비). 읽기만 하며 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/agent-policy.ts',
    reason:
      'GET /v1/agents/{id}/policy — 조회 전용(AC-a1). 관문과 같은 PolicySource·resolvePolicy 로 읽지만 ' +
      '평가·발송은 하지 않는다. 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/policy-requests.ts',
    reason:
      'POST /v1/agents/{id}/policy/requests · GET …/{requestId} — 에이전트의 정책 변경 **요청**(ADR-0007 2026-10-13). 정의자 하나로 요청 한 행을 남길 뿐 ' +
      '정책을 바꾸지 않고(바꾸는 것은 콘솔의 소유자 승인) 메일을 보내지 않는다 — 소유자 알림은 DB 가 감시 알림 창에 세고 시스템 메일 워커가 보낸다. ' +
      '관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/webhook-endpoints.ts',
    reason:
      'POST|GET /v1/agents/{id}/webhook-endpoints · DELETE …/{endpointId}(소프트 삭제, 메일 기본기 A4) — 웹훅 URL 등록·조회·삭제. ' +
      '행 하나를 쓸 뿐 메일도 HTTP 도 보내지 않는다(전달은 webhook-dispatcher 워커). 관문을 import 하지 않는다.',
  },
  {
    file: 'src/workers/webhook-dispatcher.ts',
    reason:
      '웹훅 outbox 디스패처. 내보내는 것은 소유자가 등록한 URL 로 가는 식별자·시각 HTTP 이지 **메일이 아니다** — ' +
      '관문·SES 전송단에 닿지 않고, 네트워크 I/O 는 주입받은 webhooks/https-transport 하나다. 웹훅 수신이 ' +
      '발송을 촉발하게 되는 날은 이 줄을 지우고 OUTBOUND_ROUTES 로 옮기는 날이다.',
  },
  // ---- P3a: 수신 파이프라인 ----
  {
    file: 'src/workers/inbound-consumer.ts',
    reason:
      'SES 수신 소비자(P3a). **받기만 한다** — SES receipt 알림을 읽어 S3 원문을 파싱하고 메타를 Postgres 에, ' +
      '본문·첨부를 S3 에 쓸 뿐 메일을 내보내지 않는다. 관문·SES 전송단을 import 하지 않는다. 수신이 자동 회신을 ' +
      '촉발하게 되는 날(예: 확인 코드 자동 응답)은 그 회신이 관문을 지나는 **별도 진입점**이어야 하고, 이 줄은 그대로다. ' +
      'US-009: support@atmark.ai 문의는 판정 뒤 outbox(contact_forwards)·문서(S3 contact/forward/)를 적을 뿐이다 — 보내는 것은 ' +
      'contact_forward 시스템 메일 워커다(수신 역할은 SES 0, 전달 주소를 모른다). `ATMARK_CONTACT_ROUTING` ≠ forward 면 support@ 도 ' +
      '지원 에이전트 수신자로 저장한다 — 여전히 SES 0, 보내지 않는다(ADR-0006 2026-09-30 개정 · deploy.md §29).',
  },
  {
    file: 'src/workers/ai-watch-result.ts',
    reason:
      'AI 의심 메일 감시 결과 소비자(ADR-0017 초안 · 경고 전용). 결과 큐(SQS)의 판정·하트비트를 DB 정의 함수 둘(전용 롤 — 표 ' +
      '권한 0)로 적을 뿐이다 — 메일을 내보내지 않고 관문·SES 전송단·S3 를 import 하지 않는다. 판정은 경고 표시(provenance · MCP 문구 · ' +
      '콘솔 배지)에만 쓰이고 발송 판정의 입력이 아니다(arch ai-watch-boundary).',
  },
  // ---- P3c: 수신 조회 표면 · 예약 생성 ----
  {
    file: 'src/api/routes/inbound-messages.ts',
    reason:
      'GET /v1/messages/inbound[/{id}] — 조회 전용(AC-3·AC-4). 격리 메일은 저장소가 행째 거른다(inbound-read-store). ' +
      '읽기만 하며 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/threads.ts',
    reason:
      'GET /v1/threads/{id} — 조회 전용(AC-4). 권한용 스레드의 발신·수신 시간순. 회신(POST …/reply)은 reply.ts 이고 ' +
      'OUTBOUND_ROUTES 에 있다. 이 파일은 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/attachments.ts',
    reason:
      'GET /v1/messages/inbound/{id}/attachments/{index} — 단기 서명 다운로드 URL 을 줄 뿐 메일을 보내지 않는다. ' +
      'GET …/attachments/{index}/content — 첨부 바이트를 읽어 텍스트·PDF 텍스트·이미지로 돌려줄 뿐이다(읽기). ' +
      '관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/scheduled-messages.ts',
    reason:
      'POST /v1/messages/scheduled — 예약 **생성**. 행 하나와 본문 객체 하나를 쓸 뿐 보내지 않는다. 보내는 것은 ' +
      'scheduled_send 워커이고 **발송 시점에** 관문을 지난다(평가 지점은 하나). 이 라우트가 관문을 부르는 날은 ' +
      '"예약 시점에 이미 평가했다" 가 생기는 날이고, 그 판정을 믿고 워커에서 평가를 빼는 사고(계획 프리모템)의 입구다.',
  },
  // ---- 메일 기본기 1차 (2026-09-26, .omc/plans/mail-basics.md §4 경로표) ----
  // ---- 메일 기본기 2차 A2 (2026-09-27, ADR-0013 2차 · 스위치 ATMARK_OUTBOUND_ATTACHMENTS_ENABLED) ----
  {
    file: 'src/api/routes/outbound-attachments.ts',
    reason:
      'POST /v1/attachments — 발신 첨부 업로드 생성. outbound_attachments 한 행을 적고 스테이징 키의 서명된 PUT URL 을 돌려줄 뿐이다 — ' +
      '메일을 보내지 않는다(첨부를 싣는 발송은 send·reply 가 관문을 지난다). 관문·전송단 import 없음.',
  },
  // ---- 개발자 표면 (2026-10-08, 묶음 B — docs/internal/plans/watch-and-dev-surface.md) ----
  {
    file: 'src/api/routes/drafts.ts',
    reason:
      'POST|GET /v1/drafts · GET|PATCH /v1/drafts/{id} · POST …/{id}/discard — 초안 만들기 · 고치기 · 버리기(소프트). drafts 한 행과 본문 객체 하나를 ' +
      '쓸 뿐 보내지 않는다 — 보내기는 draft-send.ts(OUTBOUND_ROUTES draft_send)가 관문을 지난다(평가 지점은 하나). 관문 import 없음.',
  },
  {
    file: 'src/api/routes/labels.ts',
    reason:
      'PUT /v1/messages/inbound/{id}/labels · GET /v1/labels — 받은 메일의 라벨(inbound_message_state 한 행). 보이는 메일만 · 판정의 입력이 아니다. ' +
      '보내지 않고 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/discovery.ts',
    reason:
      'GET /.well-known/atmark.json · /v1/openapi.json(무인증 상수 문서) · /v1/agents/{id}/capabilities(정책 읽기 — agent-policy.ts 와 같은 소스). ' +
      '보내지 않고 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/agents-enroll.ts',
    reason:
      'POST /v1/agents — 자가 등록(ADR-0016 2026-10-08). 토큰 · 권한(agents:enroll) · 입력을 보고 admin λ 자가 등록 이벤트 하나를 부른다(새 에이전트 · 토큰은 ' +
      'admin λ 가 DB 에서 다시 판정한 뒤 만든다). 메일을 보내지 않고 관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/verification-code.ts',
    reason:
      'GET /v1/messages/verification-code — 인증코드·확인 링크 조회(A1). 이미 받은 메일(visibleToAgent)을 읽어 순수 함수로 값을 ' +
      '뽑을 뿐 메일을 보내지 않고 링크를 따라가지 않는다. 결과는 정책·발송·승인 입력이 아니다(ADR-0005, arch verification-boundary). ' +
      '관문을 import 하지 않는다.',
  },
  {
    file: 'src/api/routes/scheduled-queries.ts',
    reason:
      'GET /v1/messages/scheduled[/{id}] · POST …/{id}/cancel — 예약 조회·취소(A3). 취소는 행을 종단(cancelled)으로 닫을 뿐 ' +
      '**보내지 않는다** — 보내는 것은 scheduled_send 워커이고 그 워커는 scheduled 행만 집는다. 관문을 import 하지 않는다. ' +
      '이 파일이 관문을 부르는 날은 "취소 대신 즉시 발송" 같은 편의가 생기는 날이고, 그때는 OUTBOUND_ROUTES 로 옮긴다.',
  },
  {
    file: 'src/api/routes/webhook-deliveries.ts',
    reason:
      'GET /v1/agents/{id}/webhook-deliveries · POST …/{deliveryId}/redeliver — 웹훅 전달 목록·재전송(A4). 재전송은 outbox 행 ' +
      '하나를 더할 뿐이고 HTTP 는 webhook-dispatcher 워커가 보낸다. 메일을 보내지 않고 관문을 import 하지 않는다.',
  },
  // ---- 관리 백엔드: 소유자 세션 표면 (2026-09-23) — console.atmark.ai · admin Lambda(DB 롤 atmark_admin, SES 권한 0 — ADR-0006) ----
  {
    file: 'src/admin/routes/session.ts',
    reason:
      'POST /api/login · login/verify · logout · GET me — 소유자 로그인. 로그인 요청은 owner_login_links 에 **행을 적을 뿐** ' +
      '메일을 보내지 않는다(보내는 것은 owner_login_notify 시스템 메일 워커). 이 파일이 알림기·관문을 import 하는 날은 admin ' +
      'Lambda(콘솔 입구)가 발송 주체가 된 날이다(Layer C 마지막 단언이 알림기 import 를 막는다).',
  },
  {
    file: 'src/admin/routes/agents.ts',
    reason:
      '/api/agents[/{id}/token|seeds|policy] — 프로비저닝·토큰·seed·정책. CLI(scripts/admin/**)와 같은 src/admin/ops 함수를 ' +
      '부른다. 행을 쓸 뿐 메일을 보내지 않는다.',
  },
  {
    file: 'src/admin/routes/policy-requests.ts',
    reason:
      'GET /api/agents/{id}/change-requests · POST …/{requestId}/approve|reject — 에이전트의 정책 변경 요청을 소유자가 ' +
      '보고 결정한다(ADR-0007 2026-10-13). 승인은 /policy · /rules 와 같은 관리 연산으로 새 정책 버전을 쓰고 감사 1행을 남길 뿐이다. 발송 없음.',
  },
  {
    file: 'src/admin/routes/kill-switch.ts',
    reason:
      'POST /api/kill-switch — Stage 0 이 읽는 소유자 상태(owner_paused·agents.status/suspended_by=owner)만 바꾼다. ' +
      '플랫폼 동결(abuse_freeze)은 건드리지 않는다. 발송 없음.',
  },
  // ---- AI 의심 메일 감시 설정 (2026-10-06, ADR-0017) ----
  {
    file: 'src/admin/routes/ai-watch.ts',
    reason:
      'GET|PATCH /api/settings/ai-watch — 조직의 AI 의심 메일 감시 토글(조직 행의 켜짐 칸 하나)을 읽고 바꾸고 감사 1행을 남길 뿐이다. ' +
      '경고 표시만 켜는 값이라 발송 판정의 입력이 아니다(arch ai-watch-boundary) — 관문 · 전송단 import 없음. 발송 없음.',
  },
  // ---- 감시 탭 받기 등급 (2026-10-08, ADR-0016 개정) ----
  {
    file: 'src/admin/routes/watch.ts',
    reason:
      'GET|PATCH /api/watch/settings · /api/agents/{id}/watch · GET /api/watch/held · POST /api/watch/held/{id}/release — 받기 설정(위험 처리 · 알림 · ' +
      '신뢰 발신자)과 보류 메일 풀기를 정의자 함수로 바꾸고 감사 1행을 남길 뿐이다. 풀기가 적는 것은 에이전트의 message.received 웹훅(outbox 행)이지 메일이 아니다 — ' +
      '관문 · 전송단 import 없음. 발송 없음.',
  },
  {
    file: 'src/admin/routes/approvals.ts',
    reason:
      'GET /api/approvals — 조회 전용. **결정(승인·거절) 엔드포인트가 없다** — 승인은 서명 링크(/approve) 한 경로뿐이다 ' +
      '(계약). 발송 없음.',
  },
  {
    file: 'src/admin/routes/senders.ts',
    reason: 'GET|POST /api/senders — 소유자 수동 발신자 분류 조회·기록(수신 신뢰, 발신 허가 아님). 발송 없음.',
  },
  {
    file: 'src/admin/routes/gate.ts',
    reason: '/api/gate[/start|forwarding|intervention] — AC-0 판정 조회·기록(pnpm check:ac0·ac0:* 와 같은 함수). 발송 없음.',
  },
  // ---- 셀프 가입 (2026-09-24, .omc/handoffs/signup-contract.md §5) ----
  {
    file: 'src/admin/routes/signup.ts',
    reason:
      'POST /api/signup · /api/signup/verify — 셀프 가입. 가입 요청은 signup_links 에 **행을 적을 뿐** 메일을 보내지 않는다 ' +
      '(보내는 것은 signup_notify 시스템 메일 워커 — login-mailer Lambda). 초대 전용(202609301520): 초대가 없는 새 주소는 waitlist_join ' +
      '(SECURITY DEFINER)으로 대기자 명단에 올린다. verify 는 create_signup_organization(SECURITY DEFINER)으로 — 살아 있는 초대가 있을 때만 — ' +
      'active(Free) 조직을 만들고 세션을 연다. 발송 없음.',
  },
  // ---- 대기자 명단 (2026-09-30, 202609301520) ----
  {
    file: 'src/admin/routes/waitlist.ts',
    reason:
      'POST /api/waitlist — 대기자 명단 등록(홈 폼, 교차 출처). waitlist_join(SECURITY DEFINER)이 항목 한 행과 확인 메일 outbox 한 행을 적을 뿐 ' +
      '메일을 보내지 않는다(보내는 것은 waitlist_notify 시스템 메일 워커 — login-mailer Lambda). 가입 요청과 같은 원장·상한 · 늘 202. 발송 없음.',
  },
  {
    file: 'src/admin/routes/pages.ts',
    reason: 'GET / · /login · /app (console.atmark.ai) — 정적 HTML(관리 UI) 서빙. 읽기만 한다.',
  },
  // ---- 로그 (2026-09-24, .omc/handoffs/v2-contract.md §2 — T3) ----
  {
    file: 'src/admin/routes/logs.ts',
    reason:
      'GET /api/logs · /api/logs/{type}/{id} — 발신 판정·수신·콘솔 기록 조회(조직 범위, 본문 없음, 컬럼 단위 SELECT 만). 발송 없음.',
  },
  // ---- 신원 PP-B/PP-C (2026-09-24, .omc/handoffs/v2-contract.md §3 — T4) ----
  {
    file: 'src/api/routes/identity.ts',
    reason:
      'GET /v1/identity/{address} — 무인증 공개 신원 조회(계획 §4B.3). 서명된 passport 문서와 공개키를 읽어 필드 allowlist ' +
      '직렬화기(src/passport/public-view.ts)로만 응답한다. 관문·토큰 저장소를 import 하지 않는다. 발송 없음.',
  },
  {
    file: 'src/admin/routes/identity.ts',
    reason:
      'GET /api/agents/{id}/identity · POST …/identity/publish|suspend — 신원 상태 조회와 게시·정지 요청(outbox ' +
      'passport_publish_requests 에 행을 적을 뿐, 서명·게시는 서명 Lambda). 발송 없음.',
  },
  // ---- 콘솔 v4 (2026-09-25, .omc/handoffs/console-v4-api.md) ----
  {
    file: 'src/admin/routes/tokens.ts',
    reason:
      'GET/POST /api/agents/{id}/tokens · POST …/{tokenId}/revoke · PATCH …/{tokenId} — 에이전트 API 토큰 목록·발급·폐기·이름(조직 범위, ' +
      '에이전트당 활성 5 — 코드 잠금 + DB 트리거, 평문은 발급 응답 1회). 관문·전송단을 import 하지 않는다. 발송 없음.',
  },
  {
    file: 'src/admin/routes/stats.ts',
    reason: 'GET /api/stats — 조직(선택: 에이전트) 1·7·30일 발신 판정·수신 집계(조직 범위, SELECT 만). 발송 없음.',
  },
  // ---- 확장성 P0·P1 (2026-09-25, .omc/handoffs/p0p1-api.md) ----
  {
    file: 'src/admin/routes/members.ts',
    reason:
      'GET /api/members · POST /api/members/invites[/{id}/revoke] · PATCH|DELETE /api/members/{userId} · POST /api/members/leave · ' +
      'POST /api/invites/claim — 멤버·초대 관리와 초대 수락 1단계. 초대는 org_invites(outbox)에, claim 은 owner_login_links 에 **행을 ' +
      '적을 뿐** 메일을 보내지 않는다(보내는 것은 atmark-login-mailer 의 시스템 메일 워커 — ADR-0006). 관문·전송단·알림기 import 없음.',
  },
  {
    file: 'src/admin/routes/org-keys.ts',
    reason:
      'GET|POST /api/org-keys · POST …/{keyId}/revoke|rotate · PATCH …/{keyId} — 조직 API 키 관리(owner, 해시만 저장 · 평문 발급 ' +
      '응답 1회 · 조직당 활성 5). 행을 쓸 뿐 발송 없음(관문·전송단 import 없음).',
  },
  {
    file: 'src/admin/routes/plan.ts',
    reason:
      'GET /api/plan — 요금제·사용량 보기(과금 P0, ADR-0011). 읽기만(org_entitlements SELECT · 사용량 집계) — 쓰기도 발송도 없다(관문·전송단 import 없음).',
  },
  {
    file: 'src/admin/routes/billing.ts',
    reason:
      'GET /api/billing · POST /api/billing/checkout · POST /api/billing/portal — 콘솔 결제(WP-2). 체크아웃은 Paddle 거래 하나와 billing_checkouts ' +
      '한 행·감사 1행을 적고 결제 페이지 URL 을 돌려줄 뿐이고, 포털은 Paddle 세션 URL 을 돌려줄 뿐이다. 요금제 쓰기도 메일도 없다(관문·전송단 import 없음).',
  },
  {
    file: 'src/admin/routes/org-api.ts',
    reason:
      'GET|POST /org-api/v1/agents · GET /org-api/v1/agents/{id} — 조직 API 키(CI) 표면의 에이전트 목록·조회·프로비저닝. 콘솔 ' +
      'POST /api/agents 와 같은 src/admin/ops 함수(provisionAgentOp)를 부른다 — 에이전트·토큰 행을 만들 뿐 메일을 보내지 않는다.',
  },
  // ---- 메일 기본기 1차 2회차 Y2 (2026-09-26, .omc/handoffs/mail-basics-fix2.md) ----
  {
    file: 'src/admin/routes/scheduled.ts',
    reason:
      'POST /api/scheduled/{id}/cancel — 콘솔 예약 취소(owner·admin, 조직 범위). 정의자 함수 console_cancel_scheduled_send 로 예약 행을 ' +
      'cancelled 로 표시하고 감사 1행을 적을 뿐이다 — 발송을 **막는** 쪽이고 관문·전송단·워커를 import 하지 않는다. 발송 없음.',
  },
  // ---- 메일 기본기 2차 A6 (2026-09-27, ADR-0013 2차 · 스위치 ATMARK_ADDRESS_ALIASES_ENABLED) ----
  {
    file: 'src/admin/routes/aliases.ts',
    reason:
      'GET|POST /api/agents/{id}/aliases · POST …/aliases/{addressId}/retire — 별칭 주소 목록·추가·폐기(owner·admin, 조직 범위, 요금제 한도 · ' +
      'DB 천장 트리거). agent_addresses 행을 적거나 retired_at 을 한 번 적고 감사 1행을 남길 뿐이다 — 관문·전송단 import 없음. 발송 없음.',
  },
  // ---- 고객 도메인 (2026-10, ADR-0014 단계 4 M3b) ----
  {
    file: 'src/admin/routes/domains.ts',
    reason:
      '콘솔 GET|POST /api/domains · GET|DELETE /api/domains/{id} · POST …/{id}/check 와 조직 API /org-api/v1/domains*(domains:manage) — 고객 ' +
      '도메인 목록 · 추가(pending 행) · 레코드 보기 · 지금 확인 요청(행의 수동 확인 칸) · 제거 요청(트리거가 removed). custom_domains 행과 감사 1행을 ' +
      '적을 뿐이다(상태 · 확인 · SES 는 틱과 domain-control) — 관문 · 전송단 import 없음. 발송 없음.',
  },
  // ---- 콘솔 웹훅 관리 (2026-09-30, ADR-0013 개정) ----
  {
    file: 'src/admin/routes/webhooks.ts',
    reason:
      'GET|POST /api/agents/{id}/webhooks · DELETE …/{webhookId} · POST …/{webhookId}/rotate · GET …/webhooks/deliveries · POST …/deliveries/{id}/redeliver — ' +
      '웹훅 엔드포인트·전달 관리(owner·admin 쓰기, 조직 범위, 에이전트 API 와 같은 연산). 엔드포인트·outbox 행을 적고 감사 1행을 남길 뿐이다 — ' +
      '웹훅 HTTP 는 디스패처 워커가 보낸다. 관문·전송단 import 없음. 발송 없음.',
  },
  // ---- 투명성 로그 (2026-09-24, US-010 · ADR-0008) ----
  {
    file: 'src/admin/routes/integrity.ts',
    reason:
      'GET /api/logs/integrity · inclusion-proof · consistency-proof · bundle — 투명성 로그 무결성 패널·증명·검증 번들(조직 범위, ' +
      'admin 롤 SELECT 만 + 번들 내려받기 감사 1행). 관문·전송단을 import 하지 않는다. 발송 없음.',
  },
  {
    file: 'src/workers/transparency-logger.ts',
    reason:
      'outbox → 잎 서열 · 매시 에폭 마감(KMS Ed25519 체크포인트 서명) · 공개 로그 게시(S3 Object Lock 버킷) — Lambda ' +
      'atmark-transparency-log(SES 권한 0). 메일을 보내지 않는다(관문·알림 모듈 import 없음).',
  },
  {
    file: 'src/workers/transparency-anchor.ts',
    reason:
      '체크포인트 외부 앵커(OpenTimestamps 캘린더 · Sigstore Rekor v2) — Lambda atmark-transparency-anchor(SES 권한 0). ' +
      '밖으로 나가는 것은 체크포인트 다이제스트와 앵커 서명뿐이다. 메일을 보내지 않는다.',
  },
  {
    file: 'src/workers/passport-signer.ts',
    reason:
      'passport 게시 outbox 소비 + 재서명(계획 §4B.1b) — 서명 Lambda(atmark-passport-signer, SES 권한 0). 문서를 서명해 ' +
      'identity 버킷에 쓰고 CloudFront 를 무효화한다. 메일을 보내지 않는다(관문·알림 모듈 import 없음).',
  },
];

/**
 * **세 번째 범주 — 메일을 보내지만 에이전트 메일이 아닌 진입점**(시스템 메일). 관문을 지나지 않으므로 `OUTBOUND_ROUTES` 가
 * 아니고, 실제로 SES 로 나가므로 `NON_SENDING_ENTRYPOINTS` 도 아니다. 계약은 더 좁다: 관문을 import 하지 않고 `sender` 로 지정된
 * 시스템 메일 모듈만 import 하며, 그 모듈을 import 하는 진입점은 이 범주뿐이다(Layer B·C). 줄을 더하는 것은 관문 밖 발송 경로가
 * 늘었다는 뜻이다 — 리드의 판단이다.
 */
export interface SystemMailEntrypoint {
  /** 관측 축의 `route_id` — `OUTBOUND_ROUTES[].id` 와 겹치지 않는다. */
  readonly id: string;
  /** 리포 루트 기준 상대 경로. */
  readonly file: string;
  /** 보낼 때 거치는 유일한 모듈 — 공개 API 에 수신자·본문 인자가 없다(Layer B). */
  readonly sender: string;
  /** 왜 이 진입점이 에이전트 메일이 아닌가 — 리뷰 대상 문장. */
  readonly reason: string;
}

export const SYSTEM_MAIL_ENTRYPOINTS: readonly SystemMailEntrypoint[] = [
  {
    id: 'approval_notify',
    file: 'src/workers/approval-notifier.ts',
    sender: 'src/notify/approval-notifier.ts',
    reason:
      '소유자 승인 알림 outbox 배출(§3.4 5조). 수신자는 organizations.owner_email 하나뿐이고 알림기의 공개 ' +
      'API 는 approvalId 만 받는다 — 에이전트가 수신자·본문을 고를 자리가 없다. 관문을 지나지 않으므로 ' +
      '워밍업 캡을 먹지 않고, 대신 조직당 속도 상한(시간당 10통)이 스팸 벡터를 닫는다. 이 워커가 관문을 ' +
      'import 하는 날은 알림이 에이전트 메일이 된 날이고, 그때는 결정 (b) 를 다시 연다.',
  },
  // ---- 관리 백엔드: 소유자 로그인 링크 (2026-09-23) ----
  {
    id: 'owner_login_notify',
    file: 'src/workers/owner-login-notifier.ts',
    sender: 'src/notify/owner-login-notifier.ts',
    reason:
      '소유자 로그인 링크 outbox 배출(관리 계약). 수신자는 링크의 사용자(users.email) 하나뿐이고 알림기의 공개 API 는 ' +
      'loginLinkId 만 받는다 — 로그인을 요청한 사람이 입력한 주소는 이 경로에 닿지 않는다(admin 은 정확히 일치할 때만 ' +
      '링크 행을 만든다). 전용 Lambda atmark-login-mailer(역할 atmark-runtime-login-mailer — SES 는 login@atmark.ai 하나, ADR-0006)에서만 돈다 — admin Lambda 역할은 ' +
      'SES 권한이 0 이다(Layer E). 본문에 요청자가 정한 문자열이 한 글자도 없다(owner-login-template.ts).',
  },
  // ---- 셀프 가입: 가입 확인 링크 (2026-09-24, .omc/handoffs/signup-contract.md §4) ----
  {
    id: 'signup_notify',
    file: 'src/workers/signup-mailer.ts',
    sender: 'src/notify/signup-notifier.ts',
    reason:
      '가입 확인 링크 outbox 배출. **수신자가 요청자가 입력한 주소다**(signup_links.email — 아직 조직이 없다) — 그래서 이 경로는 ' +
      '임의 주소로 가는 메일이고, 폭탄을 셋이 막는다: admin 의 요청자·같은 주소 상한(signup_requests) · 알림기의 전역 시간당 ' +
      '상한(SIGNUP_MAIL_GLOBAL_HOURLY_CAP) · 억제 목록(signup_email_suppressed). 알림기의 공개 API 는 signupLinkId 만 받고, ' +
      '본문에 요청자가 정한 문자열(조직 이름 포함)이 한 글자도 없다(signup-template.ts). 로그인 메일과 같은 전용 Lambda ' +
      'atmark-login-mailer(SES 는 login@atmark.ai 하나) — 발송 주체를 늘리지 않는다. 에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 조직 초대 (2026-09-25, 확장성 P1 R-1 · 창업자 결정 F-2) ----
  {
    id: 'invite_notify',
    file: 'src/workers/invite-mailer.ts',
    sender: 'src/notify/invite-notifier.ts',
    reason:
      '조직 초대 outbox 배출. 수신자는 owner 가 입력한 주소(users.email ← org_invites.user_id)라 임의 주소로 가는 메일이고, 폭탄을 여럿이 ' +
      '막는다: 검토 끝난(active)·동결되지 않은 조직만(DB, 발송 순간 다시) · 대기 10(DB) · admin 의 조직 하루 20 · 한 조직이 같은 주소에 하루 3 · ' +
      '알림기의 주소당 하루 3(조직 무관, 보낸 메일만) · 알림기의 전역 시간당 상한(가입 메일과 같은 창) · ' +
      '억제 목록(signup_email_suppressed). 알림기의 공개 API 는 inviteId 만 받고, 본문에 조직 이름이 없다(invite-template.ts — 초대자의 ' +
      '증명된 주소만). 토큰은 세션을 만들지 않는다(claim → 초대받은 주소로 로그인 링크). 로그인 메일과 같은 전용 Lambda atmark-login-mailer ' +
      '(SES 는 login@atmark.ai 하나) — 발송 주체를 늘리지 않는다. 에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 셀프 가입 환영 메일 (2026-09-30, 202609301510) ----
  {
    id: 'welcome_notify',
    file: 'src/workers/welcome-mailer.ts',
    sender: 'src/notify/welcome-notifier.ts',
    reason:
      '셀프 가입 환영 메일 outbox 배출. 행은 create_signup_organization(SECURITY DEFINER)이 **새 가입**(링크·코드로 주소를 증명한 뒤 새 조직을 ' +
      '만드는 갈래)에서만, 사용자당 한 번(user_id UNIQUE) 만든다 — 초대받은 멤버·돌아온 소유자·콘솔 새 조직·운영자 CLI 는 만들지 않는다. 수신자는 ' +
      '보내는 순간의 users.email 하나뿐이고 알림기의 공개 API 는 welcomeId 만 받는다. 본문은 상수 문구(welcome-template.ts — 보간 값 0, 가입 언어 ' +
      '하나로). 지운 사용자·시스템 메일 억제 주소는 undeliverable, 48시간 지난 행은 obsolete, 전역 시간당 30(넘으면 미룬다). 발신은 상수 ' +
      'onve@atmark.ai(헤더 "Onve (Atmark)" <onve@atmark.ai>). 로그인 메일과 같은 전용 Lambda atmark-login-mailer 에서 기능 플래그 ' +
      'ATMARK_WELCOME_MAIL_ENABLED 가 켜졌을 때만 돈다 — 발송 주체를 늘리지 않는다(그 역할의 ses:FromAddress 에 onve@ 하나를 더할 뿐). ' +
      '에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음) — onve 로컬파트는 예약이라 일반 에이전트가 가질 수 없다(운영자가 지원 에이전트의 ' +
      '별칭으로만 붙인다 — 답장이 그리로 간다, 202609301500).',
  },
  // ---- 대기자 명단: 대기 확인 · 초대 메일 (2026-09-30, 202609301520) ----
  {
    id: 'waitlist_notify',
    file: 'src/workers/waitlist-mailer.ts',
    sender: 'src/notify/waitlist-notifier.ts',
    reason:
      '대기 확인 · 초대 메일 outbox 배출. 행은 소유자 함수만 만든다 — 확인 메일은 waitlist_join(admin 의 요청자·같은 주소 상한 뒤 · 주소당 30일 한 통), ' +
      '초대 메일은 운영자 초대(waitlist_invite_core — 전역 하루 5). 수신자는 보내는 순간의 waitlist_entries.email 하나뿐이고 알림기의 공개 API 는 ' +
      'mailId 만 받는다. 항목이 지워졌거나(지우기 · 가입 · 보존) 상태가 바뀌었으면 obsolete, 시스템 메일 억제 주소는 undeliverable, 전역 시간당 초대 60 · ' +
      '확인 20(따로 센다 — 넘으면 미룬다) · 새 대기 항목 하루 500(넘으면 저장만, 확인 메일 없음) · 요청자 키는 IPv6 /64 로 묶는다. 본문은 상수 문구(waitlist-template.ts) — 보간 값은 초대 링크의 fragment(받는 사람 자신의 주소) 하나. 발신은 환영 메일과 같은 상수 ' +
      'onve@atmark.ai(헤더 "Onve (Atmark)" <onve@atmark.ai>). 로그인 메일과 같은 전용 Lambda atmark-login-mailer — 발송 주체를 늘리지 않는다. ' +
      '에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 호스팅 운영자 콘솔 코드 메일 (2026-09-28, .omc/plans/ops-console.md §3.4 · ADR-0015 초안) ----
  {
    id: 'ops_code_notify',
    file: 'src/workers/ops-code-mailer.ts',
    sender: 'src/notify/ops-code-notifier.ts',
    reason:
      'ops.atmark.ai 운영자 코드(로그인 · 접근 요청 확인 · step-up) outbox 배출. 알림기의 공개 API 는 challengeId 만 받는다. 수신자는 DB 에서만 — ' +
      '로그인·step-up 은 보내는 순간의 ops_operators(active 가 아니면 obsolete), 접근 요청은 요청자가 입력한 주소라 DB 가 먼저 막는다(요청자 15분 10 · ' +
      '(주소, 요청자) 시간 3 · 주소 하루 30 · 접근 요청 전역 시간당 5 · 대기 5 · 주소 실패 잠금 · 억제 목록). 코드는 저장하지 않는다 — 운영 코드 키' +
      '(atmark/ops-login-keys, 이 λ 만)로 파생하고 다이제스트를 정의 함수로 먼저 적은 뒤에만 보낸다(키 회전이면 dead, 0통). 본문에 요청자 문자열·링크가 ' +
      '없다(ops-code-template.ts). 로그인 메일과 같은 전용 Lambda atmark-login-mailer(SES 는 login@atmark.ai 하나) — 발송 주체를 늘리지 않는다. ' +
      '에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 고객 도메인 알림 (2026-10, ADR-0014 단계 4 M3b · 계획 §3.11 M14) ----
  {
    id: 'domain_notice',
    file: 'src/workers/domain-notifier.ts',
    sender: 'src/notify/domain-notifier.ts',
    reason:
      '고객 도메인 알림 outbox(domain_notices) 배출 — 확인 완료(첫 확인 · 자동 복귀) · 정지(사유별) · 제거 3일 전 · 제거됨 · 등록 만료 예고. 행은 확인 틱(atmark_domain_tick)만 ' +
      '적는다(조직 하루 10 · 같은 사건 1번 — UNIQUE). 수신자는 정의자 함수 atmark_claim_domain_notice 가 집기와 같은 문장에서 돌려주는 그 조직의 ' +
      '살아 있는 owner · admin 주소뿐이다(최대 20 — 앱 롤은 users · memberships 권한 0). 알림기의 공개 API 는 noticeId 만 받고, 본문은 상수 ' +
      '문구 + 그 조직의 도메인 이름(DB CHECK 모양) · 그 도메인 주소를 대표로 쓰는 그 조직 에이전트 이름(정화 · 길이 상한)이다. 보내기 전에 사건이 ' +
      '아직 사실인지 본다(풀렸으면 obsolete). 발신은 상수 notify@atmark.ai(승인 알림과 같은 예약 주소). 승인 알림과 같은 Lambda · 같은 발송 역할 ' +
      '(atmark-runtime-sender) — 발송 주체를 늘리지 않는다. 에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 격리 알림 (2026-10-07, ADR-0016 개정 · 202610071000) ----
  {
    id: 'quarantine_notice',
    file: 'src/workers/quarantine-notifier.ts',
    sender: 'src/notify/quarantine-notifier.ts',
    reason:
      '격리 알림 outbox(quarantine_notices) 배출 — 인젝션 방어가 에이전트의 받은 메일을 격리했을 때(스캐너 격리 · 판정 없음, 정책 차단은 아니다). 행은 ' +
      'inbound_messages AFTER INSERT 트리거의 정의자 함수만 적는다(앱 롤 INSERT 0 — 에이전트당 열린 창 하나 · 첫 격리 2분 뒤 · 직전 알림 15분 뒤). ' +
      '수신자는 정의자 함수 atmark_claim_quarantine_notice 가 집기와 같은 문장에서 돌려주는 그 조직의 organizations.owner_email 하나뿐이다(승인 알림과 같은 ' +
      '수신자 — 모듈의 SQL 은 그 칸을 읽지 않는다). 알림기의 공개 API 는 noticeId 만 받고, 본문은 상수 문구 + 에이전트 이름(정화 · 길이 상한) · 유효 대표 주소 · 수 · ' +
      '시각 · 검사한 보낸 사람 도메인(DB CHECK 와 같은 모양 · 최대 5 · 자동 링크를 끊어 싣는다)이다 — 격리된 메일의 제목 · 본문 · 주소는 싣지 않는다. ' +
      '조직 하루 20통(넘으면 suppressed — 다음 알림이 수를 말한다) · 24시간 넘은 창은 obsolete. 발신은 상수 notify@atmark.ai. 승인 알림과 같은 ' +
      'Lambda · 같은 발송 역할(atmark-runtime-sender) — 발송 주체를 늘리지 않는다. 운영자 킬 스위치 ATMARK_QUARANTINE_NOTICE=off 면 싣지 않는다. ' +
      '에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음).',
  },
  // ---- 문의 전달 (2026-09-24, US-009 · ADR-0009) ----
  {
    id: 'contact_forward',
    file: 'src/workers/contact-forwarder.ts',
    sender: 'src/notify/contact-forwarder.ts',
    reason:
      'support@atmark.ai 문의 전달 outbox 배출. **수신자는 운영자 한 곳**이고 전달 모듈만 읽는 비밀(atmark/contact-forward-to)에서만 ' +
      '나온다 — 모듈의 공개 API 는 forwardId 만 받고, 메일 내용·헤더·DB 행 어디에서도 수신자를 읽지 않는다(원 발신자는 Reply-To 로만). ' +
      '발신은 상수 support@atmark.ai. 수신 쪽(발신자별 5·전역 30/시간)과 전달 쪽(전역 30/시간) 두 겹 상한, 루프 방지(우리 도메인·전달 ' +
      '주소 자신·자동 응답). 전용 Lambda atmark-contact-forwarder 가 발송 역할(atmark-runtime-sender)을 공유한다 — 발송 주체를 늘리지 ' +
      '않는다(Layer E 2). 대신 비밀·문서 읽기는 lambda:SourceFunctionArn 으로 이 함수에만, support@ 발신은 ATMARK_CONTACT_ROUTING=forward ' +
      '일 때 이 함수 밖에서 명시 Deny(그 밖의 모드에서 support@ 는 운영자가 발급한 지원 에이전트의 대표 주소 — 관문을 지나 회신한다). ' +
      'agent_and_notify 면 알림만(제목 + 보낸 사람 도메인, 본문·Reply-To 없음). 이 경로는 에이전트 메일이 아니다(관문 없음, 워밍업 캡 없음) — ' +
      'support 로컬파트는 예약이고 운영자 허가 행이 있는 조직만 가진다(202609301500).',
  },
];

/**
 * **네 번째 범주 — 전송 어댑터**(MCP): 발송을 일으키지만 관문을 import 하지 않고 등록된 라우트 함수(`handleSend` 등)를 부른다.
 * 계약: 라우트 파일에서 멈춘 import 폐포에 관문·전송단·SES SDK·시스템 메일 모듈이 없고, import 할 수 있는 라우트는 이름으로
 * 못 박힌 에이전트 도구뿐이다(`test/arch/mcp-adapter.arch.test.ts`).
 */
export interface TransportAdapterEntrypoint {
  /** 리포 루트 기준 상대 경로. */
  readonly file: string;
  /** 왜 이 파일이 관문을 직접 부르지 않고도 발송 경로에 서 있는가 — 리뷰 대상 문장. */
  readonly reason: string;
}

export const TRANSPORT_ADAPTER_ENTRYPOINTS: readonly TransportAdapterEntrypoint[] = [
  {
    file: 'src/mcp/server.ts',
    reason:
      'POST /mcp — MCP Streamable HTTP(무상태 JSON) 의 JSON-RPC 번역과 인증. 도구 실행은 tools.ts 에 넘긴다. ' +
      '관문·전송단을 import 하지 않는다.',
  },
  {
    file: 'src/mcp/tools.ts',
    reason:
      'MCP 도구 표 — 도구 하나 = 기존 라우트 함수 하나. 발송 도구는 handleSend·handleReply·handleForward 를 그대로 ' +
      '부르고(멱등 키·인증·인가·관문은 라우트 안), 이 파일은 관문을 import 하지 않는다. 소유자 권한 라우트는 import 하지 않는다.',
  },
  {
    file: 'src/mcp/render.ts',
    reason: 'MCP 도구 결과의 외부 데이터 경계 표시·크기 상한. 순수 문자열 처리 — 라우트도 관문도 import 하지 않는다.',
  },
];

/**
 * Layer C 가 전수 분할하는 디렉터리. **Layer C 의 알려진 사각지대** — 새 진입점 디렉터리는 자동으로 덮이지 않으므로
 * 이 선언 자체가 리뷰 체크리스트 항목이다(§5.0).
 */
export const ARCH_PARTITIONED_DIRS: readonly string[] = ['src/api/routes', 'src/workers', 'src/mcp', 'src/admin/routes'];
