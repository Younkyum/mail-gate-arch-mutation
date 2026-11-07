/**
 * EventBridge Scheduler(1분) → `workers/owner-login-notifier` + `workers/signup-mailer`. 소유자 **로그인 링크** 메일과 **가입 확인**
 * 메일 outbox 배출(시스템 메일 범주).
 *
 * **전용 Lambda · 전용 IAM 역할(atmark-runtime-login-mailer) · 전용 DB 롤(atmark_login_mailer)** — ADR-0006. 로그인 키를 쥐는
 * 런타임 주체는 이것과 admin(검증) 둘뿐이고, 둘 다 에이전트 토큰이 닿지 않는다. SES 발송은 `login@atmark.ai` 한 주소로만
 * 허용된다(Layer E: 발송 주체 둘 — 발송 역할 `*@atmark.ai`, 이 역할 `login@atmark.ai`). 가입 메일도 같은 주체다(계약 §0 —
 * 발송 주체를 늘리지 않는다).
 *
 * 조직 초대 메일(`workers/invite-mailer`, 확장성 P1)도 같은 틱에 돈다. 셀프 가입 환영 메일(`workers/welcome-mailer`, 202609301510 — 발신
 * `onve@atmark.ai`)은 기능 플래그 `ATMARK_WELCOME_MAIL_ENABLED` 가 켜졌을 때만 돈다. 대기 확인 · 초대 메일(`workers/waitlist-mailer`, 202609301520 —
 * 같은 발신 주소)은 플래그 없이 마지막에 돈다.
 *
 * **호스팅 운영자 콘솔 코드 메일(`workers/ops-code-mailer`)이 가장 먼저 돈다**(`.omc/plans/ops-console.md` §3.4 · M1) — 자기 예산(5초 · 10행)
 * 안에서, 어떤 이유로도 던지지 않는다(건너뛰면 메트릭). 그래서 소유자 로그인·가입·초대 메일은 운영 쪽 결과와 무관하게 돈다.
 *
 * 세 outbox 는 서로를 굶기지 않는다 — 한쪽이 던져도 다른 쪽은 돈다(던진 오류는 둘 다 돈 뒤에 다시 던진다 — 스케줄러가 실패로 본다).
 *
 * **입력은 둘이다**(`LOGIN_MAILER_EVENT_SOURCE` — 모르는 모양은 던진다):
 *   - `{"source":"atmark.schedule"}` — Scheduler 1분 틱(폴백). 빈 객체 `{}` 도 받는다(입력 없는 호출 — 운영자 수동 `aws lambda invoke`).
 *   - `{"source":"atmark.kick"}` — admin λ 가 outbox 행을 적은 요청의 커밋 뒤 비동기로 깨운다(`runtime/lambda-invoke.ts`). 메일이 틱을 기다리지 않는다.
 * 둘 다 **같은 일**을 한다 — 입력에 데이터가 없고, 무엇을 보낼지는 DB 의 기한·클레임이 정한다(겹쳐 돌아도 중복 발송이 없다).
 * 예약 동시성이 1 이라 틱이 도는 동안 온 깨우기는 스로틀되고, Lambda 비동기 큐가 다시 부른다(최대 이벤트 나이 1분 — compute-stack).
 */

import { OWNER_LOGIN_NOTIFY_ROUTE_ID } from '../../notify/owner-login-notifier';
import { LOGIN_MAILER_EVENT_SOURCE } from '../config';
import { runInviteMailer } from '../../workers/invite-mailer';
import { runOpsCodeMailer } from '../../workers/ops-code-mailer';
import { runOwnerLoginNotifier } from '../../workers/owner-login-notifier';
import { runSignupMailer } from '../../workers/signup-mailer';
import { runWaitlistMailer } from '../../workers/waitlist-mailer';
import { runWelcomeMailer } from '../../workers/welcome-mailer';
import { memoize, scheduledHandler, type Compose, type LambdaContext, type ScheduledRunReport } from '../lambda';
import { composeLoginMailer, type LoginMailerDependencies } from '../login-mailer-composition';

/**
 * 한 틱: 운영 코드(격리) → 로그인 → 가입 → 초대 → 환영(기능 플래그가 켜졌을 때만 — 꺼지면 `welcome` 이 `null`). 결말 개수만(`login.sent` ·
 * `signup.undeliverable` · `welcome.deferred` …) — 식별자·주소 없음. 환영 메일은 코드·링크가 없는 편지라 가장 뒤다(급한 메일을 먼저).
 */
export async function runLoginMailer(deps: LoginMailerDependencies): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  const failures: unknown[] = [];
  const run = async (prefix: string, work: () => Promise<Readonly<Record<string, number>>>): Promise<void> => {
    try {
      for (const [outcome, count] of Object.entries(await work())) counts[`${prefix}.${outcome}`] = count;
    } catch (error) {
      failures.push(error);
    }
  };
  await run('ops', () => runOpsCodeMailer(deps.ops));
  await run('login', () => runOwnerLoginNotifier(deps.login));
  await run('signup', () => runSignupMailer(deps.signup));
  await run('invite', () => runInviteMailer(deps.invite));
  const welcome = deps.welcome ?? null;
  if (welcome !== null) await run('welcome', () => runWelcomeMailer(welcome));
  // 대기 확인 · 초대 메일(202609301520) — 발신 onve@atmark.ai. 플래그 없이 늘 돈다(초대 전용 가입의 입구다).
  const waitlist = deps.waitlist ?? null;
  if (waitlist !== null) await run('waitlist', () => runWaitlistMailer(waitlist));
  if (failures.length > 0) throw failures[0];
  return counts;
}

/** 입력 판별 — 틱·깨우기·빈 객체만. 그 밖은 던진다(조용히 무시하면 잘못 걸린 호출이 "성공" 으로 남는다). */
export function classifyLoginMailerInput(event: unknown): 'tick' | 'kick' {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new TypeError('login-mailer: 모르는 입력(객체가 아니다)');
  const record = event as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return 'tick';
  if (keys.length === 1 && record['source'] === LOGIN_MAILER_EVENT_SOURCE.tick) return 'tick';
  if (keys.length === 1 && record['source'] === LOGIN_MAILER_EVENT_SOURCE.kick) return 'kick';
  throw new TypeError('login-mailer: 모르는 입력');
}

export function createLoginMailerHandler(compose: Compose<LoginMailerDependencies>) {
  const run = scheduledHandler(OWNER_LOGIN_NOTIFY_ROUTE_ID, compose, runLoginMailer);
  return async (event: unknown, context: LambdaContext): Promise<ScheduledRunReport> => {
    classifyLoginMailerInput(event);
    return run(event, context);
  };
}

export const handler = createLoginMailerHandler(memoize(() => composeLoginMailer({ env: process.env })));
