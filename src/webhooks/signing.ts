/**
 * src/webhooks/signing.ts — 웹훅 서명. **수신자가 "Atmark 가 보낸 것" 임을 확인하는 수단.**
 *
 * ---------------------------------------------------------------------------
 * ## 형식: Standard Webhooks (https://www.standardwebhooks.com) 를 그대로 따른다
 * ---------------------------------------------------------------------------
 *
 * ```
 * webhook-id:        <이벤트 id>
 * webhook-timestamp: <unix 초>
 * webhook-signature: v1,<base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>"))>
 * ```
 *
 * 본문만 서명하는 방식(GitHub)은 타임스탬프가 없어 언제든 재생되고, Stripe 방식은 이벤트 id 가 서명 범위 밖이다.
 * Standard Webhooks 는 **id 까지 서명**해 헤더 id 를 바꿔 수신측 중복 제거를 우회하는 재생을 막고, 수신측이 기성
 * 라이브러리(`whsec_` + base64 시크릿)로 검증할 수 있다.
 *
 * **재생 방지는 두 겹이다**: ① 타임스탬프 허용 오차 5분(서명 범위 안이라 바꿀 수 없다)
 * ② 창 안의 재생은 이벤트 id 로 수신측이 멱등 처리한다(`events.ts`).
 * 재시도는 **매번 새 타임스탬프로 다시 서명**한다 — 본문과 id 는 같다.
 *
 * ---------------------------------------------------------------------------
 * ## 시크릿: DB 에 두지 않고 **파생**한다
 * ---------------------------------------------------------------------------
 *
 * 매직링크·에이전트 토큰과 달리 웹훅 시크릿은 **우리가 평문을 다시 써야 한다**(서명할 때마다).
 * 해시만 저장할 수 없다. 암호화 저장은 KMS 가 필요하고 그것은 아직 없다. 그래서
 *
 *     secret = HMAC(master[kid], "atmark.webhook-secret.v1\n<endpoint_id>\n<version>")
 *
 * 로 **파생**한다. DB 에는 `(secret_kid, secret_version)` 만 있고 비밀은 **0바이트**다.
 * DB 가 통째로 유출돼도 웹훅을 위조할 수 없다. 회전은 `version` 을 올리는 것(그때의 활성 kid 로 — 마스터 키 회전도 같은 길, `management.ts`).
 * 직전 `(kid, version)` 은 24시간 유예로 남고, 그동안 디스패처는 새·옛 시크릿 **둘 다로** 서명한다(`signWebhook` 의 여러 서명).
 * 대가: 마스터 키가 새면 전 엔드포인트가 샌다(암호화 저장의 KEK 가 새는 것과 같은 크기).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { HmacKeyring } from '../security/hmac-keyring';

/** 마스터 키 묶음 환경 변수. 매직링크 키와 **분리한다** — 한쪽 유출이 다른 쪽을 열지 않게. */
export const WEBHOOK_SECRET_KEYS_ENV = 'ATMARK_WEBHOOK_SECRET_KEYS';

/** Standard Webhooks 시크릿 접두사. 수신측 라이브러리가 이 접두사를 벗기고 base64 를 푼다. */
const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** 수신측 허용 오차의 권장값. Stripe·Standard Webhooks 기본값과 같다. */
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

const DERIVATION_CONTEXT = 'atmark.webhook-secret.v1';

export class WebhookSecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSecretUnavailableError';
  }
}

export interface WebhookSecretRef {
  readonly endpointId: string;
  readonly kid: string;
  readonly version: number;
}

/**
 * 엔드포인트 시크릿 파생. 등록 응답에서 1회 보여주고(다음 워커), 서명할 때마다 다시 만든다.
 * kid 가 묶음에 없으면 던진다 — **다른 키로 대신 서명하지 않는다**(수신측 검증이 실패할 뿐
 * 아니라, 어느 키로 서명했는지가 입력에 따라 바뀌는 경로를 만들지 않는다).
 */
export function deriveWebhookSecret(keyring: HmacKeyring, ref: WebhookSecretRef): string {
  const master = keyring.keys.get(ref.kid);
  if (master === undefined) throw new WebhookSecretUnavailableError(`kid '${ref.kid}' 가 묶음에 없다`);
  if (!Number.isSafeInteger(ref.version) || ref.version < 1) {
    throw new WebhookSecretUnavailableError('secret version 은 1 이상의 정수다');
  }
  const bytes = createHmac('sha256', master)
    .update(`${DERIVATION_CONTEXT}\n${ref.endpointId}\n${ref.version}`, 'utf8')
    .digest();
  return `${WEBHOOK_SECRET_PREFIX}${bytes.toString('base64')}`;
}

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new WebhookSecretUnavailableError('whsec_ 형식이 아니다');
  return Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
}

function mac(secret: string, eventId: string, timestamp: number, body: string): Buffer {
  return createHmac('sha256', secretBytes(secret)).update(`${eventId}.${timestamp}.${body}`, 'utf8').digest();
}

export interface WebhookSignatureHeaders {
  readonly 'webhook-id': string;
  readonly 'webhook-timestamp': string;
  readonly 'webhook-signature': string;
}

/**
 * 서명 헤더. `secrets` 가 여럿이면 서명도 여럿(공백 구분, 순서 그대로)이다 — 엔드포인트 시크릿 회전 유예 동안 새·옛 시크릿을 둘 다 싣는다
 * (Standard Webhooks 규격: `v1,<새> v1,<옛>`). 수신측은 자기 시크릿으로 맞는 것 하나만 찾으면 된다(`verifyWebhook`).
 */
export function signWebhook(
  secrets: readonly string[],
  eventId: string,
  body: string,
  now: Date,
): WebhookSignatureHeaders {
  if (secrets.length === 0) throw new WebhookSecretUnavailableError('서명할 시크릿이 없다');
  const timestamp = Math.floor(now.getTime() / 1000);
  const signatures = secrets.map((secret) => `v1,${mac(secret, eventId, timestamp, body).toString('base64')}`);
  return {
    'webhook-id': eventId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signatures.join(' '),
  };
}

export type WebhookVerification =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly reason: 'malformed' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

/**
 * 수신측 검증의 **참조 구현.** 우리 서버는 이것을 쓰지 않는다 — 문서·SDK 예시와 테스트가
 * 쓴다. 서명과 검증이 같은 파일에 있어야 한쪽만 바뀌는 일이 테스트에서 드러난다.
 */
export function verifyWebhook(
  secret: string,
  headers: { readonly id: string; readonly timestamp: string; readonly signature: string },
  body: string,
  now: Date,
  toleranceSeconds: number = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): WebhookVerification {
  if (!/^\d{1,12}$/.test(headers.timestamp)) return { kind: 'invalid', reason: 'malformed' };
  const timestamp = Number(headers.timestamp);
  // **양방향**이다. 미래 쪽을 열어 두면 공격자가 먼 미래 타임스탬프로 서명된 요청을
  // (그런 것을 얻을 수 있다면) 오래 재생할 수 있다.
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    return { kind: 'invalid', reason: 'timestamp_out_of_tolerance' };
  }

  const expected = mac(secret, headers.id, timestamp, body);
  for (const entry of headers.signature.split(' ')) {
    const [version, encoded] = entry.split(',', 2);
    if (version !== 'v1' || encoded === undefined) continue;
    const provided = Buffer.from(encoded, 'base64');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return { kind: 'valid' };
  }
  return { kind: 'invalid', reason: 'no_matching_signature' };
}
