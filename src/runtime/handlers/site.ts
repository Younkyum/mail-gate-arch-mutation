/**
 * API Gateway HTTP API `atmark-site`(payload v2, `atmark.ai` · `www.atmark.ai` · `pay.atmark.ai`) → `src/site/http.ts`.
 *
 * **별도 Lambda · 별도 IAM 역할(로그만) · VPC 밖 · DB 없음 · 비밀 없음.** 이 번들의 import 폐포는 `src/site/**` 와 `src/billing/constants.ts`
 * (import 없는 값 파일)뿐이다 — 조립 루트·비밀·SES·S3·DB 클라이언트·`src/runtime/config.ts` 가 들어오지 않는다(`test/unit/site/site-bundle.test.ts`).
 *
 * **결제 페이지 설정(WP-2 · `pay.atmark.ai`)만 환경에서 읽는다** — 세 키(`SITE_PAY_ENV`, 이름은 `RUNTIME_ENV` 와 같다). `config.ts` 의
 * `readPaddleEnvironment`·`readBillingEnabled` 와 **같은 의미**의 작은 파서를 여기 둔다(`config.ts` 는 `passport/custody` 를 끌고 와 홈 번들의
 * 격리를 약하게 한다 — 두 파서가 같은 표에 같은 답을 내는지 `test/unit/site/pay.test.ts` 가 고정한다). 다른 점은 하나: 틀린 값에서 **던지지
 * 않고** 체크아웃(`pay.atmark.ai/?_ptxn=…`)만 404 로 둔다 — 홈(`atmark.ai`)과 pay 의 쿼리 없는 안내 페이지는 결제 설정 오류와 무관하게
 * 살아 있어야 한다. 그때 로그 한 줄(이유 코드만, 값 없음).
 * 스위치가 꺼진 것은 오류가 아니다(로그 없음).
 */

import { PADDLE_ENVIRONMENTS, type PaddleEnvironment } from '../../billing/constants';
import { handleSiteRequest, type SiteHttpEvent, type SiteHttpResult, type SiteRequestOptions } from '../../site/http';
import { payConfigUsable } from '../../site/pay';

/** 홈 λ 가 읽는 환경 변수 — 이것뿐이다. 이름은 `src/runtime/config.ts` `RUNTIME_ENV` 의 같은 키와 같다(테스트). */
export const SITE_PAY_ENV = {
  paddleEnvironment: 'ATMARK_PADDLE_ENV',
  billingEnabled: 'ATMARK_BILLING_ENABLED',
  paddleClientToken: 'ATMARK_PADDLE_CLIENT_TOKEN',
} as const;

/** `readPaddleEnvironment` 과 같은 의미: 앞뒤 공백을 걷고 `sandbox`|`production` 정확히. 아니면 `null`. */
export function parseSitePaddleEnvironment(value: string | undefined): PaddleEnvironment | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return null;
  return PADDLE_ENVIRONMENTS.find((candidate) => candidate === trimmed) ?? null;
}

/** `readBillingEnabled` 와 같은 의미: 앞뒤 공백을 걷고 `true`|`false` 정확히. 아니면 `null`. */
export function parseSiteBillingEnabled(value: string | undefined): boolean | null {
  const trimmed = value?.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

export type SitePayOptionsResult =
  | { readonly options: SiteRequestOptions; readonly problem: null }
  | { readonly options: SiteRequestOptions; readonly problem: 'billing_enabled_invalid' | 'paddle_env_invalid' | 'client_token_unusable' };

/** 환경 → 결제 페이지 설정. 스위치 꺼짐은 문제가 아니다. */
export function readSitePayOptions(env: Readonly<Record<string, string | undefined>>): SitePayOptionsResult {
  const off: SiteRequestOptions = { pay: null };
  const enabled = parseSiteBillingEnabled(env[SITE_PAY_ENV.billingEnabled]);
  if (enabled === null) return { options: off, problem: 'billing_enabled_invalid' };
  if (!enabled) return { options: off, problem: null };
  const environment = parseSitePaddleEnvironment(env[SITE_PAY_ENV.paddleEnvironment]);
  if (environment === null) return { options: off, problem: 'paddle_env_invalid' };
  const config = { environment, clientToken: env[SITE_PAY_ENV.paddleClientToken]?.trim() ?? '' };
  if (!payConfigUsable(config)) return { options: off, problem: 'client_token_unusable' };
  return { options: { pay: config }, problem: null };
}

let resolved: SiteRequestOptions | undefined;

function options(): SiteRequestOptions {
  if (resolved === undefined) {
    const result = readSitePayOptions(process.env);
    if (result.problem !== null) {
      // 값은 싣지 않는다 — 이유 코드만. 홈과 pay 안내 페이지는 계속 200 이고 체크아웃(?_ptxn=…)만 404 다.
      console.error(JSON.stringify({ level: 'error', event: 'site.pay_config_invalid', reason: result.problem }));
    }
    resolved = result.options;
  }
  return resolved;
}

export const handler = async (event: SiteHttpEvent): Promise<SiteHttpResult> => handleSiteRequest(event, options());
