/**
 * src/security/invite-token.ts — **조직 초대** 토큰 (확장성 P1 R-1, 계획 §3.3 · 창업자 결정 F-2).
 *
 * 규율 — HMAC-SHA256 · `kid` 서명 범위 포함 · 비정규 base64url 거부 · 서명 확인 **뒤에** 페이로드 파싱 · URL **fragment**(`#t=`)에만
 * 싣는다. **키링은 로그인 키링, 서명 문맥은 `atmark-invite-v1`** — 같은 키의 로그인 코드(`login-code.ts`)·다른 서명물과 겹치지 않는다
 * (초대 메일도 로그인 메일 Lambda 가 보낸다 — 비밀을 늘리지 않는다).
 *
 * **이 토큰은 세션을 만들지 않는다.** 토큰으로 할 수 있는 것은 claim(`POST /api/invites/claim`) 하나 — 초대받은 **주소로**, claim 한
 * **브라우저에 결속된** 로그인 링크를 적는 것뿐이다. 그래서 전달된 초대 메일이나 메일 스캐너가 토큰을 가져가도 멤버십은 생기지
 * 않는다(로그인 메일이 초대받은 사람의 메일함으로 간다). 수명 7일 — `org_invites.expires_at` 과 같다.
 *
 * 이 모듈은 DB 도 로그도 없다. 발급은 초대 알림기(`notify/invite-notifier.ts` — login-mailer Lambda), 검증은 admin(`admin/invites.ts`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { activeKey, decodeCanonicalBase64Url, type HmacKeyring } from './hmac-keyring';

/** 토큰 접두사 — `logger.redact` 가 `atk_<종류>_` 형태를 지운다. */
export const INVITE_TOKEN_PREFIX = 'atk_invite_';

/** 초대 수명. `org_invites_ttl` CHECK(≤ 7일)와 같은 값. admin 이 초대 행의 `expires_at` 을 이 값으로 정한다. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 서명 문맥 — 로그인 코드(`login-code.ts`)·승인 링크와 겹치지 않는다. */
const SIGNING_CONTEXT = 'atmark-invite-v1';
const SIGNATURE_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^atk_invite_([a-z0-9]{1,16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export class InviteTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteTokenError';
  }
}

export interface InviteClaims {
  readonly inviteId: string;
  /** `org_invites.expires_at` 과 같아야 한다(ms). */
  readonly expiresAt: Date;
}

export type InviteTokenVerification =
  | { readonly kind: 'valid'; readonly claims: InviteClaims }
  | { readonly kind: 'rejected'; readonly reason: 'malformed' | 'unknown_key' | 'bad_signature' | 'expired' };

function sign(key: Buffer, kid: string, payload: string): Buffer {
  return createHmac('sha256', key).update(`${SIGNING_CONTEXT}\n${kid}\n${payload}`, 'utf8').digest();
}

/** 발급. **평문은 반환값에만 있다** — 메일 본문으로 가고 저장·로깅하지 않는다. */
export function mintInviteToken(keyring: HmacKeyring, invite: InviteClaims): string {
  if (!LINK_ID_PATTERN.test(invite.inviteId)) throw new InviteTokenError('inviteId 는 정규형 uuid 여야 한다');
  const expiresAtMs = invite.expiresAt.getTime();
  if (!Number.isSafeInteger(expiresAtMs)) throw new InviteTokenError('expiresAt 이 유효한 시각이 아니다');
  const { kid, key } = activeKey(keyring);
  const payload = Buffer.from(JSON.stringify({ i: invite.inviteId, e: expiresAtMs }), 'utf8').toString('base64url');
  return `${INVITE_TOKEN_PREFIX}${kid}.${payload}.${sign(key, kid, payload).toString('base64url')}`;
}

/** 초대 URL — 토큰은 fragment(`#t=`)에만. 페이지는 https · fragment·쿼리·자격증명 없음. */
export function buildInviteUrl(pageUrl: string, token: string): string {
  const url = new URL(pageUrl);
  if (url.protocol !== 'https:') throw new InviteTokenError('초대 페이지는 https 여야 한다');
  if (url.hash !== '' || url.username !== '' || url.password !== '' || url.search !== '') {
    throw new InviteTokenError('초대 페이지 URL 에 fragment·쿼리·자격증명이 있으면 안 된다');
  }
  if (!TOKEN_PATTERN.test(token)) throw new InviteTokenError('토큰 형식이 아니다');
  return `${url.href}#t=${token}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 검증. 서명을 먼저 보고 그 다음에야 페이로드를 JSON 으로 푼다. 만료 경계는 `<=`(정각은 만료).
 * `valid` 는 "우리가 발급한 모양" 일 뿐이다 — 대기·만료·수신자의 최종 판정은 DB(claim 의 조건부 INSERT · `accept_org_invite`)가 한다.
 */
export function verifyInviteToken(keyring: HmacKeyring, token: string, now: Date): InviteTokenVerification {
  if (token.length > MAX_TOKEN_LENGTH) return { kind: 'rejected', reason: 'malformed' };
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) return { kind: 'rejected', reason: 'malformed' };
  const [, kid = '', payload = '', encodedSignature = ''] = match;
  const key = keyring.keys.get(kid);
  if (key === undefined) return { kind: 'rejected', reason: 'unknown_key' };
  const provided = decodeCanonicalBase64Url(encodedSignature);
  if (provided === null || provided.length !== SIGNATURE_BYTES) return { kind: 'rejected', reason: 'malformed' };
  if (decodeCanonicalBase64Url(payload) === null) return { kind: 'rejected', reason: 'malformed' };
  if (!timingSafeEqual(sign(key, kid, payload), provided)) return { kind: 'rejected', reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { kind: 'rejected', reason: 'malformed' };
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'e,i') return { kind: 'rejected', reason: 'malformed' };
  const { i, e } = parsed;
  if (typeof i !== 'string' || !LINK_ID_PATTERN.test(i)) return { kind: 'rejected', reason: 'malformed' };
  if (typeof e !== 'number' || !Number.isSafeInteger(e)) return { kind: 'rejected', reason: 'malformed' };
  if (e <= now.getTime()) return { kind: 'rejected', reason: 'expired' };
  return { kind: 'valid', claims: { inviteId: i, expiresAt: new Date(e) } };
}
