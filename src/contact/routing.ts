/**
 * src/contact/routing.ts — **`support@atmark.ai` 문의를 어디로 보내는가**(2026-09-30). 환경 변수 `ATMARK_CONTACT_ROUTING` 하나가 inbound 와
 * contact-forwarder 두 Lambda 에 같은 값으로 간다(CDK 컨텍스트 `atmark:contactRouting` ?? `CONTACT_ROUTING_DEFAULT` — `compute-stack.ts`).
 *
 * | 모드 | 에이전트 수신함(support@ 에이전트) | 운영자 메일함 전달(contact-forwarder) |
 * |---|---|---|
 * | `forward`(코드 기본) | 없음 — support@ 는 에이전트 조회에 넘기지 않는다(US-009 그대로) | 전문(본문 · Reply-To 원 발신자) |
 * | `agent_and_forward` | 있다 | 전문 — 이중 수신(전환 첫 단계) |
 * | `agent_and_notify` | 있다 | **알림만** — 제목 + 보낸 사람 도메인, 본문·Reply-To 없음, "Atmark 에서 회신" |
 * | `agent` | 있다 | 없음(intake 를 돌리지 않는다) |
 *
 * 각 경로는 자기 규칙을 지킨다: 문의 intake 는 스팸·바이러스 PASS 를 요구하고(`precheckContactReceipt`), 에이전트 경로는 저장하고 격리한다
 * (`inbound-consumer.ts`). 멱등 키는 둘 다 SES 메시지 ID 다(`contact_forwards.ses_message_id` · `inbound_messages (agent_id, ses_message_id)`).
 *
 * `abuse@`·`postmaster@atmark.ai`(202609301540 — 수신 전용)도 같은 표를 따른다(`src/contact/intake.ts` `CONTACT_RECIPIENT_ADDRESSES`).
 *
 * 이 파일은 I/O 가 없다 — CDK(합성 검증)와 런타임(읽기)이 같은 표를 쓴다.
 */

/** 환경 변수 이름 — inbound · contact-forwarder 만 받는다. */
export const CONTACT_ROUTING_ENV = 'ATMARK_CONTACT_ROUTING';

export const CONTACT_ROUTING_MODES = ['forward', 'agent_and_forward', 'agent_and_notify', 'agent'] as const;
export type ContactRouting = (typeof CONTACT_ROUTING_MODES)[number];

/** 코드 기본값 — env 가 없을 때(에이전트 수신함 없음 · 전문 전달). 운영 배포 값은 `compute-stack.ts` 의 기본값이 정한다. */
export const CONTACT_ROUTING_DEFAULT: ContactRouting = 'forward';

export function isContactRouting(value: string): value is ContactRouting {
  return (CONTACT_ROUTING_MODES as readonly string[]).includes(value);
}

/** support@ 가 에이전트 수신자로도 가는가(`forward` 밖 전부). */
export function routesContactToAgent(mode: ContactRouting): boolean {
  return mode !== 'forward';
}

/** 문의 intake(전달 outbox)를 돌리는가(`agent` 밖 전부). */
export function runsContactIntake(mode: ContactRouting): boolean {
  return mode !== 'agent';
}

/** 전달이 알림만인가(본문·Reply-To 없음). */
export function forwardsNotifyOnly(mode: ContactRouting): boolean {
  return mode === 'agent_and_notify';
}

/**
 * 환경 → 모드. 없거나 빈 값이면 기본값. **틀린 값은 던지지 않고 기본값(`forward`)** 으로 읽고 `invalid: true` 를 돌려준다 — 호출자가
 * 경고 로그 한 줄을 남긴다. 수신 Lambda 가 기동을 거부하면 모든 수신이 멈추고(재전달 → DLQ) 그것이 오타 하나의 대가가 되면 안 된다. 합성은 같은
 * 판정으로 **던진다**(`compute-stack.ts` — 오타가 배포되지 않게).
 */
export function readContactRouting(env: NodeJS.ProcessEnv): { readonly mode: ContactRouting; readonly invalid: boolean } {
  const raw = env[CONTACT_ROUTING_ENV]?.trim() ?? '';
  if (raw === '') return { mode: CONTACT_ROUTING_DEFAULT, invalid: false };
  return isContactRouting(raw) ? { mode: raw, invalid: false } : { mode: CONTACT_ROUTING_DEFAULT, invalid: true };
}
