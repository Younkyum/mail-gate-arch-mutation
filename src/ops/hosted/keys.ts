/**
 * src/ops/hosted/keys.ts — ops λ 가 요청에서 만드는 **파생값**(`atmark/ops-keys` 의 활성 키, 문맥 분리 — `OPS_CONTEXTS`).
 *
 *   binding    = HMAC(browser ‖ 논스 쿠키)   — 코드를 요청한 브라우저에 도전을 묶는다.
 *   clientKey  = HMAC(client ‖ 접속 IP)     — 요청자별 상한 · 실패 기록. IP 평문은 DB·로그로 가지 않는다.
 *   uaHash     = HMAC(ua ‖ User-Agent)      — 세션의 UA 가 바뀌면 DB 가 세션을 폐기한다.
 *   csrf       = HMAC(csrf ‖ 세션 토큰)      — 페이지가 헤더로 싣는다(쿠키는 HttpOnly 라 스크립트가 못 읽는다).
 *   sessionHash = sha256(세션 토큰)          — DB 에는 토큰 해시만(키 없음 — 토큰이 32바이트 난수다).
 * DB 계약은 전부 소문자 hex 64자다(W-DB CHECK `^[0-9a-f]{64}$`). **코드는 여기서 파생하지 않는다** — 코드 키는 login-mailer 만 가진다(결정 C2).
 * 키를 회전하면(활성 키 교체) 모든 세션이 UA 불일치로 끝나고 열린 도전은 쓸 수 없게 된다 — 런북 ops-console 의 회전 절.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { HmacKeyring } from '../../security/hmac-keyring';
import { OPS_CONTEXTS } from '../contract';

export interface OpsKeys {
  binding(nonce: string): string;
  clientKey(sourceIp: string): string;
  uaHash(userAgent: string): string;
  csrf(sessionToken: string): string;
  csrfMatches(sessionToken: string, presented: string | undefined): boolean;
}

/** 32바이트 base64url(43자) — 세션 토큰 · 논스. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 토큰 모양(쿠키에서 읽은 값). 모양이 아니면 DB 에 가지 않는다. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sessionHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function createOpsKeys(keyring: HmacKeyring): OpsKeys {
  const key = keyring.keys.get(keyring.activeKid);
  if (key === undefined) throw new Error('ops-keys 활성 키가 없다.');
  const mac = (context: string, value: string): string => createHmac('sha256', key).update(`${context}\u0000${value}`, 'utf8').digest('hex');
  const csrf = (token: string): string => Buffer.from(mac(OPS_CONTEXTS.csrf, token), 'hex').toString('base64url');
  return {
    binding: (nonce) => mac(OPS_CONTEXTS.browser, nonce),
    clientKey: (ip) => mac(OPS_CONTEXTS.client, ip),
    uaHash: (ua) => mac(OPS_CONTEXTS.ua, ua),
    csrf,
    csrfMatches: (token, presented) => presented !== undefined && equal(csrf(token), presented),
  };
}
