/**
 * src/runtime/login-mailer-composition.ts — **로그인 메일 Lambda(`atmark-login-mailer`)의 조립 루트** (ADR-0006).
 *
 * 소유자 로그인 링크 메일은 로그인 키로 토큰을 만든다 — 그 키와 링크 id·만료를 함께 쥔 주체는 스스로 로그인을 요청해(자기
 * 브라우저 논스) 소유자 세션을 만들 수 있다. 그래서 그 둘을 쥐는 런타임 주체를 **이 Lambda 하나**로 줄였다:
 *
 *   - 역할 `atmark-runtime-login-mailer` — SES 는 `ses:FromAddress = login@atmark.ai` 하나로만, 비밀은 로그인 키와 자기 DB
 *     비밀 둘뿐(`infra/cdk/stacks/compute-stack.ts`). HTTP 입구가 없다(스케줄러만 부른다) — 외부 입력이 닿는 면이 0 이다.
 *   - DB 롤 `atmark_login_mailer` — `owner_login_links` 의 발송 컬럼 + `organizations(id, owner_email)` 뿐(202609230720).
 *   - api·워커의 조립 루트(`composition.ts`)를 import 하지 않는다 — 그 파일은 에이전트 전송단·S3·관문을 품는다. 이 번들에는
 *     알림 전송단 하나만 들어간다(`test/arch/admin-separation.arch.test.ts` ⑤). 공통 부품(운영 가드·비밀·TLS 풀)은
 *     `admin-composition.ts` 처럼 `config.ts`·`secrets.ts`·`db/client.ts` 의 같은 함수를 부른다(규칙은 하나다).
 *
 * 이 파일은 SES 클라이언트를 **만들기만** 한다 — 발송은 알림 모듈(`notify/owner-login-notifier.ts`)의 알림면이 한다.
 *
 * **가입 확인 메일도 여기서 보낸다**(셀프 가입, `.omc/handoffs/signup-contract.md` §4) — 같은 역할·같은 DB 롤·같은 키링(다른
 * 서명 문맥)·같은 발신 주소(`login@atmark.ai`). 발송 주체를 늘리지 않는다. 알림 모듈은 따로다(`notify/signup-notifier.ts`) —
 * 수신자가 나오는 곳(`owner_email` 대 `signup_links.email`)이 다르면 모듈도 달라야 각 표면의 동결이 서로를 넓히지 않는다.
 *
 * **셀프 가입 환영 메일도 여기서 보낸다**(202609301510) — 같은 주체 · 같은 DB 롤. 발신 주소만 `onve@atmark.ai`(표시 이름 "Onve (Atmark)") ·
 * 키링 없음 · 기능 플래그 `ATMARK_WELCOME_MAIL_ENABLED`(기본 끔)가 켜졌을 때만 조립한다. 알림 모듈은 따로다(`notify/welcome-notifier.ts`).
 *
 * **대기 확인 · 초대 메일도 여기서 보낸다**(202609301520) — 같은 주체 · 같은 DB 롤 · 환영 메일과 같은 발신 `onve@atmark.ai` · 키링 없음 · 플래그 없음
 * (`notify/waitlist-notifier.ts`).
 *
 * **조직 초대 메일도 여기서 보낸다**(확장성 P1, 202609250120) — 같은 주체 · 같은 키링(서명 문맥 `atmark-invite-v1`) · 같은 발신 주소.
 * 알림 모듈은 따로다(`notify/invite-notifier.ts`). 로그인 메일의 수신자는 이제 `users.email`(링크 → 사용자)이다.
 *
 * **호스팅 운영자 콘솔 코드 메일도 여기서 보낸다**(`.omc/plans/ops-console.md` §3.4 · M1) — 같은 주체 · 같은 발신 주소. 키링은 **따로**
 * (`atmark/ops-login-keys`, 이 λ 만 — ops λ 에는 없다)이고 **처음 필요할 때** 읽는다(`loadOpsNotifier`). 비밀 ARN 이 없거나 · 읽기 실패 ·
 * 자리표시 · 형식 오류면 운영 워커만 건너뛴다(메트릭) — 이 조립은 그 비밀 때문에 실패하지 않는다(소유자 로그인·가입·초대 메일은 그대로다).
 */

import type { Pool } from 'pg';

import { createPool } from '../db/client';
import { createSesClient, SES_CONFIGURATION_SET, SES_REGION, type SesSendClient } from '../mail/transport/ses-transport';
import { createInviteNotifier } from '../notify/invite-notifier';
import { createOpsCodeNotifier, type OpsCodeNotifier } from '../notify/ops-code-notifier';
import { createOwnerLoginNotifier } from '../notify/owner-login-notifier';
import { createSignupNotifier, SIGNUP_MAIL_GLOBAL_HOURLY_CAP } from '../notify/signup-notifier';
import { createWaitlistNotifier, WAITLIST_CONFIRMATION_HOURLY_CAP, WAITLIST_MAIL_HOURLY_CAP } from '../notify/waitlist-notifier';
import { createWelcomeNotifier, WELCOME_MAIL_HOURLY_CAP } from '../notify/welcome-notifier';
import { log } from '../observability/logger';
import type { OpsMailerSkipReason } from '../ops/metrics';
import { parseHmacKeyring } from '../security/hmac-keyring';
import type { InviteMailerWorkerDependencies } from '../workers/invite-mailer';
import type { OpsCodeMailerWorkerDependencies } from '../workers/ops-code-mailer';
import type { OwnerLoginNotifierWorkerDependencies } from '../workers/owner-login-notifier';
import type { SignupMailerWorkerDependencies } from '../workers/signup-mailer';
import type { WaitlistMailerWorkerDependencies } from '../workers/waitlist-mailer';
import type { WelcomeMailerWorkerDependencies } from '../workers/welcome-mailer';
import {
  databaseUrlOf,
  isPlaceholderSecret,
  parseDatabaseSecret,
  readFeatureFlag,
  requireEnv,
  requireEnvMatching,
  requireProductionRuntime,
  requireRdsCaBundle,
  RUNTIME_ENV,
  RuntimeConfigError,
} from './config';
import { createSecretReader, type SecretReader } from './secrets';

/**
 * 실행 환경당 풀 크기 — **1**. 워커는 한 번에 한 링크씩 순차로 처리한다(집기 트랜잭션이 끝난 뒤 `sent` 를 적는다 — 동시에
 * 두 커넥션을 쥐지 않는다). 연결 예산: `RESERVED_CONCURRENCY['login-mailer']`(1) × 이 값(`test/unit/infra/compute-stack.test.ts`).
 */
export const LOGIN_MAILER_POOL_MAX = 1;

export interface LoginMailerPlatform {
  readonly env: NodeJS.ProcessEnv;
  /** 테스트만 채운다(가짜 SDK, AWS 호출 0). */
  readonly clients?: {
    readonly secrets?: SecretReader;
    readonly ses?: SesSendClient;
  };
}

/**
 * 이 Lambda 가 비우는 outbox 넷 — 운영 콘솔 코드 · 로그인 링크 · 가입 링크 · 조직 초대. 풀·SES 클라이언트·시계는 같은 것이다. 키링은 소유자 셋이
 * 하나(`atmark/owner-login-keys`), 운영 코드가 따로(`atmark/ops-login-keys` — 늦게 읽는다).
 */
export interface LoginMailerDependencies {
  readonly ops: OpsCodeMailerWorkerDependencies;
  readonly login: OwnerLoginNotifierWorkerDependencies;
  readonly signup: SignupMailerWorkerDependencies;
  readonly invite: InviteMailerWorkerDependencies;
  /** 환영 메일(202609301510) — 기능 플래그 `ATMARK_WELCOME_MAIL_ENABLED` 가 꺼져 있으면 `null`(그 단계를 돌지 않는다). 운영 조립은 늘 채운다. */
  readonly welcome?: WelcomeMailerWorkerDependencies | null;
  /** 대기 확인 · 초대 메일(202609301520) — 운영 조립은 늘 채운다(플래그 없음). 비우면(테스트) 그 단계를 돌지 않는다. */
  readonly waitlist?: WaitlistMailerWorkerDependencies | null;
}

export interface ComposedLoginMailer {
  readonly deps: LoginMailerDependencies;
  readonly pool: Pool;
}

/**
 * 운영 코드 키링 → 알림기. **성공만 캐시한다**(실패는 다음 틱이 다시 읽는다 — 사람이 비밀을 넣으면 재배포 없이 풀린다). 던지지 않는다 —
 * 건너뛸 이유를 돌려준다. 비밀 값·ARN 은 로그에 싣지 않는다.
 */
export function createOpsNotifierLoader(
  env: NodeJS.ProcessEnv,
  secrets: SecretReader,
  build: (keyring: ReturnType<typeof parseHmacKeyring>) => OpsCodeNotifier,
): () => Promise<OpsCodeNotifier | OpsMailerSkipReason> {
  let cached: OpsCodeNotifier | null = null;
  return async () => {
    if (cached !== null) return cached;
    const arn = env[RUNTIME_ENV.opsLoginKeysSecretArn]?.trim() ?? '';
    if (arn === '') return 'config';
    let raw: string;
    try {
      raw = await secrets.readSecretString(arn);
    } catch {
      return 'config';
    }
    if (isPlaceholderSecret(raw)) return 'placeholder';
    let keyring: ReturnType<typeof parseHmacKeyring>;
    try {
      keyring = parseHmacKeyring(raw, RUNTIME_ENV.opsLoginKeysSecretArn);
    } catch {
      return 'key_invalid';
    }
    cached = build(keyring);
    return cached;
  };
}

export async function composeLoginMailer(platform: LoginMailerPlatform): Promise<ComposedLoginMailer> {
  const env = platform.env;
  requireProductionRuntime(env);
  const region = requireEnv(env, RUNTIME_ENV.region);
  // 알림 전송단은 Configuration Set 을 **상수로** 쓴다 — 배포가 같은 이름을 가리키는지만 본다(`composition.ts` 와 같은 대조).
  requireEnvMatching(env, RUNTIME_ENV.sesConfigurationSet, SES_CONFIGURATION_SET);
  const secrets = platform.clients?.secrets ?? createSecretReader(region);
  requireRdsCaBundle(env);

  const loginRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.ownerLoginKeysSecretArn));
  if (isPlaceholderSecret(loginRaw)) {
    throw new RuntimeConfigError(`${RUNTIME_ENV.ownerLoginKeysSecretArn} 가 아직 채워지지 않았다(placeholder). 배포 런북대로 키링을 넣어라.`);
  }
  const keyring = parseHmacKeyring(loginRaw, RUNTIME_ENV.ownerLoginKeysSecretArn);

  // ★ 로그인 메일 롤. 앱 롤·소유자 롤·admin 롤 비밀은 읽지도 요구하지도 않는다.
  const dbRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbLoginMailerSecretArn));
  const credentials = parseDatabaseSecret(dbRaw, RUNTIME_ENV.dbLoginMailerSecretArn);
  const pool = createPool(databaseUrlOf(credentials), {
    max: LOGIN_MAILER_POOL_MAX,
    ssl: { rejectUnauthorized: true },
    keepAlive: true,
  });
  pool.on('error', (error: Error) => {
    log('warn', 'runtime.pool_idle_error', { route_id: 'login_mailer', error_kind: error.name });
  });

  const now = (): Date => new Date();
  const client = platform.clients?.ses ?? createSesClient(SES_REGION);
  return {
    deps: {
      // 운영 콘솔 코드(격리 — 키링은 늦게, 실패는 건너뛰기).
      ops: { db: pool, loadNotifier: createOpsNotifierLoader(env, secrets, (opsKeyring) => createOpsCodeNotifier({ pool, client, keyring: opsKeyring, now })), now },
      login: { db: pool, notifier: createOwnerLoginNotifier({ pool, client, keyring, now }), now },
      signup: { db: pool, notifier: createSignupNotifier({ pool, client, keyring, now, capPerHour: SIGNUP_MAIL_GLOBAL_HOURLY_CAP }), now },
      // 초대 메일(202609250120) — 가입 메일과 같은 전역 창·같은 상한 상수.
      invite: { db: pool, notifier: createInviteNotifier({ pool, client, keyring, now, capPerHour: SIGNUP_MAIL_GLOBAL_HOURLY_CAP }), now },
      // 환영 메일(202609301510) — 발신 onve@atmark.ai(IAM 은 이 λ 역할에 그 주소를 더한다) · 자기 전역 창 · 기본 끔.
      welcome: readFeatureFlag(env, RUNTIME_ENV.welcomeMailEnabled)
        ? { db: pool, notifier: createWelcomeNotifier({ pool, client, now, capPerHour: WELCOME_MAIL_HOURLY_CAP }), now }
        : null,
      // 대기 확인 · 초대 메일(202609301520) — 환영 메일과 같은 발신 onve@atmark.ai · 자기 전역 창 · 플래그 없음.
      waitlist: { db: pool, notifier: createWaitlistNotifier({
          pool,
          client,
          now,
          capPerHour: WAITLIST_MAIL_HOURLY_CAP,
          confirmationCapPerHour: WAITLIST_CONFIRMATION_HOURLY_CAP,
        }), now },
    },
    pool,
  };
}
