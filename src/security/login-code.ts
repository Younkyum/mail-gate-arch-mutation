/**
 * src/security/login-code.ts — 로그인·가입 메일의 **6자리 코드** (진윤겸 2026-09-28 승인 · 2026-10-10 "링크 로그인은 이제 삭제할거야" — 이제 코드만).
 *
 * 코드는 **요청한 브라우저에 사람이 옮겨 적는다**(논스 쿠키 결속) — 메일을 휴대폰에서 읽어도 기기를 건넌다. 예전의 서명 토큰 링크
 * (`atk_login_` · `atk_signup_`)는 2026-10-10 에 없앴다(`owner-login-token.ts` · `signup-token.ts` 삭제 — 옛 링크는 콘솔 착지가 안내 화면으로 받는다).
 *
 * **저장하지 않는다(ADR-0006).** 보낼 때 로그인 키로 **파생**한다:
 *   `코드 = HMAC-SHA256(로그인 키[kid], 문맥 ‖ kid ‖ 링크 id ‖ 만료 ms)` 의 앞 8바이트 mod 10^6(치우침 < 10^6 / 2^64).
 *   - 평문은 발급 함수의 반환값에만 있다(메일 본문으로 간다). DB 에는 코드도 코드 해시도 없다 — admin 은 검증할 때 같은 식으로
 *     다시 계산한다. 그래서 **새 저장 경로·새 발송 경로가 없다**: 코드를 만들 수 있는 쪽 = 링크 토큰을 만들 수 있는 쪽(로그인 키 +
 *     링크 id·만료 — login-mailer 와 admin)이다. 앱 롤은 링크 행을 읽지 못한다(202609230700).
 *   - 난수성: HMAC-SHA256 은 256비트 비밀 키 아래 PRF 다 — 링크 id(행마다 새 uuid)가 입력이므로 코드는 CSPRNG 출력과 구별되지 않는다.
 *   - 문맥이 로그인·가입으로 갈린다 — 같은 링크 id 가 두 표에 있을 수 없지만, 있어도 두 코드는 다르다. 토큰 서명 문맥과도 다르다.
 *   - 키 회전: 발급은 활성 키, 검증은 묶음의 모든 키로 한다(토큰과 같다). 키가 둘인 동안 틀린 코드 하나가 맞을 확률은 2배(2/10^6)다.
 *
 * 무차별 대입 상한은 이 모듈 밖이다 — 링크 행의 `code_failures`(5번 틀리면 그 코드는 죽는다, 202609280100)와 발급 상한(`login-limits.ts`)이 진다.
 * 이 모듈은 DB 도 로그도 없다. 코드를 로그에 싣지 않는다.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { OPS_CONTEXTS } from '../ops/contract';
import { activeKey, type HmacKeyring } from './hmac-keyring';

/** 코드 자릿수. */
export const LOGIN_CODE_DIGITS = 6;

/** 로그인 시도(`owner_login_links` 행 — 이름은 링크 시절 그대로) 수명. `owner_login_links_ttl` CHECK(≤ 15분)와 같은 값. */
export const OWNER_LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

/** 가입 시도(`signup_links` 행) 수명. `signup_links` 의 만료 CHECK(≤ 30분)와 같은 값. */
export const SIGNUP_LINK_TTL_MS = 30 * 60 * 1000;

/** 코드당 틀릴 수 있는 횟수 — 숫자는 상한 모듈 한 곳(`login-limits.ts`)에 있다. */
export { LOGIN_CODE_MAX_FAILURES } from './login-limits';

/**
 * 코드의 용도 — 서명 문맥을 가른다. `ops_login` 은 호스팅 운영자 콘솔(ops.atmark.ai)의 코드 메일(로그인 · 접근 요청 · step-up)이다 —
 * 키는 따로다(`atmark/ops-login-keys`, login-mailer 만). 링크 id 자리에 도전 id(`ops_login_challenges.id`)를 넣는다.
 */
export type LoginCodePurpose = 'owner_login' | 'signup' | 'ops_login';

const CONTEXTS: Readonly<Record<LoginCodePurpose, string>> = {
  owner_login: 'atmark.owner-login-code.v1',
  signup: 'atmark.signup-code.v1',
  ops_login: OPS_CONTEXTS.code,
};

const MODULUS = 10n ** BigInt(LOGIN_CODE_DIGITS);
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[0-9]{6}$/;
const MAX_RAW_LENGTH = 32;

export class LoginCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginCodeError';
  }
}

/** 코드가 묶이는 링크 — 행의 id 와 만료(ms). 토큰의 클레임과 같다. */
export interface LoginCodeLink {
  readonly linkId: string;
  readonly expiresAt: Date;
}

function derive(key: Buffer, kid: string, purpose: LoginCodePurpose, link: LoginCodeLink): string {
  const mac = createHmac('sha256', key)
    .update(`${CONTEXTS[purpose]}\n${kid}\n${link.linkId}\n${String(link.expiresAt.getTime())}`, 'utf8')
    .digest();
  return (mac.readBigUInt64BE(0) % MODULUS).toString().padStart(LOGIN_CODE_DIGITS, '0');
}

/** 발급(login-mailer). **평문은 반환값에만 있다** — 메일 본문으로 가고 저장·로깅하지 않는다. */
export function mintLoginCode(keyring: HmacKeyring, purpose: LoginCodePurpose, link: LoginCodeLink): string {
  if (!LINK_ID_PATTERN.test(link.linkId)) throw new LoginCodeError('linkId 는 정규형 uuid 여야 한다');
  if (!Number.isSafeInteger(link.expiresAt.getTime())) throw new LoginCodeError('expiresAt 이 유효한 시각이 아니다');
  const { kid, key } = activeKey(keyring);
  return derive(key, kid, purpose, link);
}

/**
 * 입력 정규화 — 붙여 넣은 `123 456`·`123-456`·전각 숫자를 받는다(NFKC 뒤 공백·하이픈 제거). 6자리 숫자가 아니면 `null`
 * (DB 를 보기 전에 거부 — 시도로 세지 않는다. 모양은 입력한 쪽이 이미 아는 것이다).
 */
export function normalizeLoginCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) return null;
  const digits = raw.normalize('NFKC').replace(/[\s-]/g, '');
  return CODE_PATTERN.test(digits) ? digits : null;
}

/**
 * 후보 링크 중 코드가 맞는 것의 위치(없으면 -1). **모든 후보 × 묶음의 모든 키를 끝까지** 상수 시간으로 비교한다 — 일치한 위치에서
 * 일찍 끝나지 않는다. `code` 는 `normalizeLoginCode` 를 지난 값이어야 한다(아니면 -1).
 */
export function matchLoginCode(
  keyring: HmacKeyring,
  purpose: LoginCodePurpose,
  candidates: readonly LoginCodeLink[],
  code: string,
): number {
  if (!CODE_PATTERN.test(code)) return -1;
  const provided = Buffer.from(code, 'utf8');
  let found = -1;
  candidates.forEach((link, index) => {
    if (!LINK_ID_PATTERN.test(link.linkId)) return;
    for (const [kid, key] of keyring.keys) {
      const expected = Buffer.from(derive(key, kid, purpose, link), 'utf8');
      const equal = timingSafeEqual(expected, provided);
      if (equal && found === -1) found = index;
    }
  });
  return found;
}

/**
 * 운영자 콘솔 코드의 **다이제스트**(결정 C2) — `sha256(문맥.digest ‖ 도전 id ‖ 코드)` 의 hex. 메일러가 코드를 파생한 뒤 이 값을
 * `ops_mailer_set_digest` 로 한 번 적고, 검증은 DB 가 같은 식(`ops_code_digest`, 202609290500)으로 한다. 코드는 6자리라 다이제스트를 가진
 * 쪽은 코드를 되찾을 수 있다 — 다이제스트는 소유자·정의 함수만 읽는다(login-mailer 는 그 칸 SELECT 0). 쓰이면 NULL 이 된다.
 */
export function opsCodeDigest(challengeId: string, code: string): string {
  if (!LINK_ID_PATTERN.test(challengeId)) throw new LoginCodeError('challengeId 는 정규형 uuid 여야 한다');
  if (!CODE_PATTERN.test(code)) throw new LoginCodeError('code 는 6자리 숫자여야 한다');
  return createHash('sha256').update(`${OPS_CONTEXTS.code}.digest\n${challengeId}\n${code}`, 'utf8').digest('hex');
}

const TARGET_REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * step-up **대상 참조**(비밀 아님) — Crockford base32 4자리 = sha256(도전 id ‖ 행위 ‖ 대상)의 앞 20비트. DB 가 만든다(`ops_target_ref`,
 * 202609290500) — 이 함수는 같은 식의 사본이다(단위·통합 테스트가 둘을 대조한다). 화면과 메일에 같은 값이 보인다.
 */
export function opsTargetRef(challengeId: string, action: string, target: string): string {
  const hash = createHash('sha256').update(`${challengeId}\n${action}\n${target}`, 'utf8').digest();
  const n = ((hash[0] ?? 0) << 12) | ((hash[1] ?? 0) << 4) | ((hash[2] ?? 0) >> 4);
  return [15, 10, 5, 0].map((shift) => TARGET_REF_ALPHABET[(n >> shift) & 31]).join('');
}
