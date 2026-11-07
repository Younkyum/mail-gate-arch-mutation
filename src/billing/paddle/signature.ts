/**
 * src/billing/paddle/signature.ts — **Paddle 웹훅 서명 검증**(`Paddle-Signature: ts=<unix>;h1=<hex>`, 계획 §0 P1–P4 · §3-2).
 *
 * 규칙(Paddle 문서 "Verify webhook signatures"):
 *   - 서명 대상 = `ts` + `:` + **원문 바디 바이트**. 바디를 파싱·재직렬화하면(공백·키 순서) 서명이 맞지 않는다 — 그래서 이 함수는
 *     문자열이 아니라 **바이트**(`Uint8Array`)를 받는다. HTTP API 가 `isBase64Encoded` 로 준 바디는 호출자가 풀어서 넘긴다.
 *   - HMAC-SHA256, 키 = **알림 목적지의 비밀 키**(API 키 아님). 비밀 교체 중에는 `h1` 이 여럿 온다 — 하나라도 맞으면 통과.
 *     우리 쪽 비밀도 `{"current","previous"}` 둘로 검증한다(교체 중 옛 키로 서명된 재시도를 떨어뜨리지 않게).
 *   - 비교는 **상수 시간**(`timingSafeEqual`)만. `===`·`Buffer.equals` 는 첫 다른 바이트에서 멈춰 서명을 한 바이트씩 맞혀 가는 길을 준다
 *     (`test/arch/billing-boundary.arch.test.ts` 가 이 파일이 `timingSafeEqual` 로만 비교함을 본다 — 변이 BL-4).
 *   - 타임스탬프 창 `|now − ts| ≤ 5초`(Paddle SDK 기본값, P3). 창 밖은 재전송 공격으로 보고 거부한다 — 창 안의 재전송은 FIFO 중복 제거
 *     (`event_id`)와 `billing_events` PK 가 흡수한다. Paddle 재시도가 `ts` 를 새로 서명하는지는 샌드박스 E2E 로 확정한다(계획 §0 ⑦).
 *
 * **헤더 파서는 엄격하다**: `ts` 정확히 하나(10자리 10진) · `h1` 하나 이상 넷 이하(64자 소문자 hex) · 모르는 키·빈 조각·중복 `ts` 거부 ·
 * 길이 상한. 거부 이유는 코드 셋뿐이다(값을 싣지 않는다 — 로그·메트릭이 이 코드만 본다).
 *
 * 이 파일은 `node:crypto` 말고 아무것도 import 하지 않는다 — 웹훅 λ 번들(DB 0)의 핵심이고, 순수 함수라 퍼징이 싸다.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 서명 헤더 이름(HTTP 헤더는 대소문자 무시 — 호출자가 소문자로 찾는다). */
export const PADDLE_SIGNATURE_HEADER = 'paddle-signature';

/** 타임스탬프 허용치(초) — Paddle SDK 도우미의 기본값(계획 §0 P3). 경계 포함(`≤`). */
export const PADDLE_SIGNATURE_TOLERANCE_SECONDS = 5;

/** 헤더 길이 상한 — `ts`(13) + `h1` 넷(4 × 68) + 구분자. 넘으면 파싱하지 않는다(퍼징·거대 헤더). */
export const PADDLE_SIGNATURE_HEADER_MAX_LENGTH = 512;

/** 한 헤더에 받는 `h1` 최대 개수 — 교체 중 둘이 정상이다. 넷을 넘으면 비정상으로 거부한다(HMAC 계산 증폭 방지). */
export const PADDLE_SIGNATURE_MAX_H1 = 4;

/** 웹훅 비밀 — Secrets Manager `atmark/billing/paddle/webhook-secret` 의 `{"current","previous"}`. */
export interface PaddleWebhookSecrets {
  readonly current: string;
  readonly previous: string | null;
}

export interface ParsedPaddleSignature {
  readonly timestamp: number;
  readonly h1: readonly string[];
}

/** 거부 이유 — 값 없는 코드. */
export type PaddleSignatureRejection = 'header_malformed' | 'timestamp_out_of_window' | 'signature_mismatch';

export type PaddleSignatureVerdict =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: PaddleSignatureRejection };

const TS_PATTERN = /^[0-9]{10}$/;
const H1_PATTERN = /^[0-9a-f]{64}$/;

/** 헤더를 엄격하게 읽는다. 형식이 하나라도 어긋나면 `null` — 예외를 던지지 않는다(퍼징 대상). */
export function parsePaddleSignatureHeader(header: string | undefined): ParsedPaddleSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > PADDLE_SIGNATURE_HEADER_MAX_LENGTH) return null;
  let timestamp: number | undefined;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'ts') {
      if (timestamp !== undefined || !TS_PATTERN.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'h1') {
      if (!H1_PATTERN.test(value)) return null;
      h1.push(value);
      if (h1.length > PADDLE_SIGNATURE_MAX_H1) return null;
    } else {
      return null;
    }
  }
  if (timestamp === undefined || h1.length === 0) return null;
  return { timestamp, h1 };
}

/** `ts:` + 원문 바이트의 HMAC-SHA256 (32바이트). */
function digestOf(secret: string, timestamp: number, rawBody: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${String(timestamp)}:`, 'utf8').update(rawBody).digest();
}

/**
 * 서명을 검증한다. 순서: 헤더 형식 → 타임스탬프 창 → HMAC. 모든 (비밀 × `h1`) 쌍을 끝까지 비교한다 — 어느 쌍이 맞았는지가
 * 시간으로 새지 않게(맞은 쌍에서 멈추지 않는다). 길이가 다르면 `timingSafeEqual` 이 던지므로 먼저 거른다(`h1` 은 형식상 늘 32바이트).
 */
export function verifyPaddleSignature(input: {
  readonly header: string | undefined;
  readonly rawBody: Uint8Array;
  readonly secrets: PaddleWebhookSecrets;
  readonly nowSeconds: number;
}): PaddleSignatureVerdict {
  const parsed = parsePaddleSignatureHeader(input.header);
  if (parsed === null) return { ok: false, reason: 'header_malformed' };
  if (Math.abs(input.nowSeconds - parsed.timestamp) > PADDLE_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const keys = input.secrets.previous === null ? [input.secrets.current] : [input.secrets.current, input.secrets.previous];
  const expected = keys.map((key) => digestOf(key, parsed.timestamp, input.rawBody));
  let matched = false;
  for (const candidate of parsed.h1) {
    const given = Buffer.from(candidate, 'hex');
    for (const digest of expected) {
      if (given.length !== digest.length) continue;
      if (timingSafeEqual(given, digest)) matched = true;
    }
  }
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: 'signature_mismatch' };
}

/**
 * 비밀 JSON `{"current":"…","previous":"…"|null}` 을 읽는다. 형식이 틀리면 `null`(값을 오류에 싣지 않는다 — 호출자가 "형식 오류" 만 적는다).
 * 빈 문자열·16자 미만 키는 받지 않는다(자리표시·오입력). `previous` 는 없거나 `null` 이면 교체 중이 아니다.
 */
export function parsePaddleWebhookSecrets(raw: string): PaddleWebhookSecrets | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const usable = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 16 && value === value.trim();
  const current = record['current'];
  const previous = record['previous'] ?? null;
  if (!usable(current)) return null;
  if (previous !== null && !usable(previous)) return null;
  return { current, previous };
}
