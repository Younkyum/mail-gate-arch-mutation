/**
 * src/webhooks/authorization.ts — 웹훅 **인증 헤더**(선택, 진윤겸 2026-10-14: "웹훅 등록할 때, optional로 Authorization token을 넣을 수 있도록").
 *
 * 수신측이 API 게이트웨이 · n8n · Zapier · Cloud Run 같은 인증 뒤에 있으면 서명(`webhook-signature`)만으로는 요청이 문 앞에서 막힌다. 등록할 때
 * `authorization` 을 주면 Atmark 가 **모든 전달**(재시도 · 재전송 포함)에 `Authorization: <값>` 을 그대로 싣는다.
 *
 * **서명을 대신하지 않는다.** 이 헤더는 게이트웨이 통과용이다 — 진위(Atmark 가 보냈는가) · 무결성 · 재생 방지는 여전히 서명이 맡는다(`signing.ts`).
 * 수신측은 둘 다 확인한다.
 *
 * ---------------------------------------------------------------------------
 * ## 입력 — 헤더 값 전체 하나
 * ---------------------------------------------------------------------------
 *
 * `authorization` = 헤더 값 전체(`Bearer xyz` · `Basic …` · 그냥 키). 방식을 나눠 받지 않는다 — 수신측이 요구하는 문자열을 그대로 붙여 넣는 것이
 * 가장 덜 틀린다. 헤더 이름은 `Authorization` 하나로 고정이다(임의 이름은 받지 않는다 — Host · Content-Length · 서명 헤더를 덮어쓰는 길이 된다).
 * 규칙(`parseWebhookAuthorization`): 문자열 · 앞뒤 공백을 자른 뒤 1–2048자 · **인쇄 가능한 ASCII(0x20–0x7E)만**(CR · LF · NUL · 탭 · 제어 문자 ·
 * 비 ASCII 거부 — 헤더 주입) · `Authorization:` 으로 시작하면 거부(헤더 줄째 붙여 넣은 실수). 생략 · `null` 은 "없음".
 *
 * ---------------------------------------------------------------------------
 * ## 저장 — 시크릿과 **같은 키 묶음**으로 봉인한다
 * ---------------------------------------------------------------------------
 *
 * 서명 시크릿은 파생하므로 저장하지 않지만, 이 값은 소유자가 준 것이라 파생할 수 없다 — 다시 써야 하므로 해시도 안 된다. 그래서 **웹훅 시크릿 마스터 키
 * 묶음**(`ATMARK_WEBHOOK_SECRET_KEYS` — api λ 와 디스패처만 가진다, 콘솔 λ 는 없다)에서 용도별 키를 파생해 AES-256-GCM 으로 봉인한다:
 *
 *     key    = HMAC-SHA256(master[kid], "atmark.webhook-authorization-key.v1")
 *     aad    = "atmark.webhook-authorization.v1\n<kid>\n<agent id>\n<endpoint id>\n<generation>\n<url>"
 *     sealed = "v1." + b64url(iv 12B) + "." + b64url(ciphertext ‖ tag 16B)
 *
 * DB 에는 `(kid, sealed, hint)` 만 있다(`webhook_endpoint_authorizations`, 202610141400) — DB 가 통째로 새도 평문은 없다(서명 시크릿과 같은 위협 모형:
 * 마스터 키가 새면 함께 샌다). **AAD 가 (에이전트, 엔드포인트 id, URL) 에 묶는다** — DB 쓰기 권한을 가진 공격자가 봉인값을 다른 엔드포인트(같은
 * URL 로 새로 등록하거나 지우고 다시 만든 것 포함)로 옮기거나 행의 URL 을 바꿔도 열리지 않는다(열리지 않으면 디스패처는 **보내지 않는다** —
 * `authorization_unavailable`). 그래서 값은 봉인한 그 엔드포인트 · 그 URL 로만 간다. 엔드포인트 id 는 **앱이 INSERT 전에 만든다**
 * (`register_webhook_endpoint` 의 id 받는 판, 202610141400) — 봉인을 등록과 같은 트랜잭션에 넣기 위해서다(보안 리뷰 L2).
 * **세대(`generation`)도 AAD 에 든다**(재검증 L2) — 엔드포인트마다 설정 · 지우기 때마다 1씩 오르고 내려가지 않는다(DB 가드). 같은 엔드포인트에 옛
 * 봉인값을 다시 넣거나 지운 값을 되살려도 세대가 달라 열리지 않는다.
 *
 * **읽기 표면에는 평문이 없다.** 목록(API · MCP · 콘솔)은 `has_authorization` 과 `hint`(방식 + 끝 4글자, 16자 이상일 때만 — 예 `Bearer …wxyz`.
 * `Basic` 은 끝 글자를 보이지 않는다 — base64 의 끝은 비밀번호 끝이다, 보안 리뷰 L1) 뿐이다.
 * 로그 · 감사 상세 · 투명성 잎에도 값은 없다(감사는 행위 이름과 엔드포인트 id · URL 호스트만).
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { activeKey, type HmacKeyring } from '../security/hmac-keyring';

/** 헤더 값 상한. 대부분의 게이트웨이 토큰(JWT 포함)은 이 안이다. */
export const MAX_WEBHOOK_AUTHORIZATION_LENGTH = 2048;

/** 끝 4글자를 보여 줄 최소 자격 길이(방식 뺀 부분). 짧은 값은 끝 4글자가 값의 큰 몫이라 보이지 않는다. */
const HINT_MIN_CREDENTIAL_LENGTH = 16;

const KEY_CONTEXT = 'atmark.webhook-authorization-key.v1';
const AAD_CONTEXT = 'atmark.webhook-authorization.v1';
const SEALED_PATTERN = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,3000})$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type WebhookAuthorizationRejection = 'not_string' | 'empty' | 'too_long' | 'invalid_characters' | 'includes_header_name';

export type WebhookAuthorizationInput =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'invalid'; readonly reason: WebhookAuthorizationRejection };

/** 입력 판정(머리말 "입력"). 거부 사유에 값을 싣지 않는다. */
export function parseWebhookAuthorization(raw: unknown): WebhookAuthorizationInput {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'not_string' };
  // 길이를 먼저 본다 — 아주 긴 입력에 정규식을 돌리지 않는다(자르기 전 상한은 넉넉히 두 배).
  if (raw.length > MAX_WEBHOOK_AUTHORIZATION_LENGTH * 2) return { kind: 'invalid', reason: 'too_long' };
  const value = raw.trim();
  if (value === '') return { kind: 'invalid', reason: 'empty' };
  if (value.length > MAX_WEBHOOK_AUTHORIZATION_LENGTH) return { kind: 'invalid', reason: 'too_long' };
  if (!/^[\x20-\x7E]+$/.test(value)) return { kind: 'invalid', reason: 'invalid_characters' };
  if (/^authorization\s*:/i.test(value)) return { kind: 'invalid', reason: 'includes_header_name' };
  return { kind: 'value', value };
}

/** 사람이 읽는 거부 사유(영어 — API `detail`). 값은 싣지 않는다. */
export function webhookAuthorizationRejectionDetail(reason: WebhookAuthorizationRejection): string {
  switch (reason) {
    case 'not_string':
      return 'authorization must be a string (the full Authorization header value, e.g. "Bearer <token>").';
    case 'empty':
      return 'authorization must not be empty. Omit it to send no Authorization header.';
    case 'too_long':
      return `authorization is at most ${String(MAX_WEBHOOK_AUTHORIZATION_LENGTH)} characters.`;
    case 'invalid_characters':
      return 'authorization may contain only printable ASCII characters (no line breaks, tabs or control characters).';
    case 'includes_header_name':
      return 'authorization is the header value only, without the "Authorization:" name.';
  }
}

/**
 * 힌트에 이름을 보여 줄 수 있는 방식(소문자 비교) — 이 목록 밖의 첫 낱말은 방식이 아니라 **자격의 일부**로 본다(재검증 L1: 모르는 첫 낱말은
 * 비밀번호일 수 있다 — 보이지 않는다).
 */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set(['bearer', 'token', 'basic', 'digest', 'apikey', 'aws4-hmac-sha256', 'hmac', 'negotiate']);

/** 끝 글자를 보이지 않는 방식 — 자격의 끝이 사람이 고른 비밀(비밀번호)의 끝이다(보안 리뷰 L1). */
const NO_TAIL_SCHEMES: ReadonlySet<string> = new Set(['basic', 'digest']);

/**
 * 목록에 보이는 힌트 — 알려진 방식(`KNOWN_SCHEMES`)이면 그 이름 + 끝 4글자. 끝 4글자는 **모두** 참일 때만 보인다: 자격이 16자 이상 ·
 * 방식이 `Basic`·`Digest` 가 아님 · 자격에 `:`(user:pass) · 공백 · `,`(여러 칸 — 서명 파라미터 등)가 없음. 모르는 첫 낱말은 보이지 않는다(값 전체를
 * 자격으로 본다). 예: `Bearer …wxyz` · `Basic …` · `…9f2c` · `…`.
 */
export function webhookAuthorizationHint(value: string): string {
  const match = /^(\S+) +(\S.*)$/.exec(value);
  const first = match?.[1];
  const scheme = first !== undefined && KNOWN_SCHEMES.has(first.toLowerCase()) ? first : undefined;
  const credential = scheme === undefined ? value : (match?.[2] ?? '');
  const showTail =
    credential.length >= HINT_MIN_CREDENTIAL_LENGTH &&
    !(scheme !== undefined && NO_TAIL_SCHEMES.has(scheme.toLowerCase())) &&
    !/[:\s,]/.test(credential);
  const tail = showTail ? credential.slice(-4) : '';
  return scheme === undefined ? `…${tail}` : `${scheme} …${tail}`;
}

export class WebhookAuthorizationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookAuthorizationUnavailableError';
  }
}

/** 봉인한 값 — DB 에 적는 넷. 평문이 없다. `generation` 은 봉인에 쓴 세대(설정 함수는 지금 세대 + 1 만 받는다). */
export interface SealedWebhookAuthorization {
  readonly kid: string;
  readonly sealed: string;
  readonly hint: string;
  readonly generation: number;
}

/** 봉인을 묶는 자리 — 에이전트 · 엔드포인트 id · **정규화된** URL(`checkWebhookUrl(...).url.href`, 저장소가 적는 값과 같은 문자열). */
export interface WebhookAuthorizationBinding {
  readonly agentId: string;
  readonly endpointId: string;
  /** 엔드포인트의 인증 헤더 세대(1 이상 정수 — 봉인은 다음 세대 · 열기는 저장된 세대). */
  readonly generation: number;
  readonly url: string;
}

function keyFor(keyring: HmacKeyring, kid: string): Buffer {
  const master = keyring.keys.get(kid);
  if (master === undefined) throw new WebhookAuthorizationUnavailableError(`kid '${kid}' 가 묶음에 없다`);
  return createHmac('sha256', master).update(KEY_CONTEXT, 'utf8').digest();
}

function aadFor(kid: string, binding: WebhookAuthorizationBinding): Buffer {
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new WebhookAuthorizationUnavailableError('세대는 1 이상 정수다');
  return Buffer.from(`${AAD_CONTEXT}\n${kid}\n${binding.agentId}\n${binding.endpointId}\n${String(binding.generation)}\n${binding.url}`, 'utf8');
}

/** 봉인 — 활성 kid 로. `value` 는 `parseWebhookAuthorization` 을 지난 값이어야 한다(여기서도 다시 본다). */
export function sealWebhookAuthorization(keyring: HmacKeyring, binding: WebhookAuthorizationBinding, value: string): SealedWebhookAuthorization {
  const parsed = parseWebhookAuthorization(value);
  if (parsed.kind !== 'value') throw new WebhookAuthorizationUnavailableError('봉인할 값이 규칙을 지나지 않았다');
  const { kid } = activeKey(keyring);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keyring, kid), iv);
  cipher.setAAD(aadFor(kid, binding));
  const body = Buffer.concat([cipher.update(parsed.value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    kid,
    sealed: `v1.${iv.toString('base64url')}.${body.toString('base64url')}`,
    hint: webhookAuthorizationHint(parsed.value),
    generation: binding.generation,
  };
}

/**
 * 열기 — 디스패처만 부른다. kid 가 묶음에 없거나 · 모양이 틀리거나 · (에이전트, URL) 이 봉인 때와 다르거나 · 값이 바뀌었으면 던진다(오류에 값 없음).
 * 연 값도 규칙을 다시 지나야 한다(헤더 주입의 마지막 바닥).
 */
export function openWebhookAuthorization(
  keyring: HmacKeyring,
  binding: WebhookAuthorizationBinding,
  stored: { readonly kid: string; readonly sealed: string },
): string {
  const match = SEALED_PATTERN.exec(stored.sealed);
  if (match === null) throw new WebhookAuthorizationUnavailableError('봉인값 모양이 틀렸다');
  const iv = Buffer.from(match[1] ?? '', 'base64url');
  const body = Buffer.from(match[2] ?? '', 'base64url');
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES) throw new WebhookAuthorizationUnavailableError('봉인값 길이가 틀렸다');
  let value: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(keyring, stored.kid), iv);
    decipher.setAAD(aadFor(stored.kid, binding));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    value = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof WebhookAuthorizationUnavailableError) throw error;
    throw new WebhookAuthorizationUnavailableError('봉인값을 열지 못했다');
  }
  const parsed = parseWebhookAuthorization(value);
  if (parsed.kind !== 'value' || parsed.value !== value) throw new WebhookAuthorizationUnavailableError('연 값이 규칙을 지나지 않았다');
  return value;
}
