/**
 * src/admin/session.ts — 소유자 **로그인·세션·CSRF** (관리 계약). admin Lambda(DB 롤 `atmark_admin`, ADR-0006)만 이 파일을 쓴다.
 *
 * ## 로그인 요청 (`POST /api/login {email}` → 항상 202)
 *
 *   - 입력 이메일이 **살아 있는 멤버십을 가진 사용자**(`users.email`, trim + 소문자 뒤 등호)일 때만 `owner_login_links` 에 **사용자당 한 행**을
 *     적는다(조직이 여럿이어도 메일 한 통 — 링크의 조직은 `last_organization_id` 가 살아 있으면 그것, 아니면 가장 오래된 멤버십).
 *     메일은 여기서 보내지 않는다 — 전용 Lambda `atmark-login-mailer` 의 로그인 워커가 보낸다(admin 역할 SES 권한 0). 메일에는 6자리 코드만
 *     있다(2026-10-10 — 로그인 링크를 없앴다. 행 이름 `owner_login_links` 는 그대로 — 행 하나 = 로그인 시도 하나).
 *   - **열거 방지:** 일치하든 않든 응답은 같은 202 · 같은 Set-Cookie 모양이고, DB 에 보내는 문장의 수·순서도 같다
 *     (트랜잭션 · 요청자 잠금 · 입력 주소 잠금 · 요청 원장 계수 → 원장 INSERT → `INSERT … SELECT … FROM users … WHERE email = $1`
 *     한 문장). 일치 여부로 갈리는 분기가 코드에 없다.
 *   - **속도 상한(숫자는 `security/login-limits.ts` 한 곳):** ① 요청자(소스 IP 의 HMAC)당 시간당 10회 — 넘으면 429(주소와 무관하므로 열거
 *     신호가 아니다). ② (사용자, 요청자)당 시간당 코드 3통 · ③ 주소당 — 신뢰 IP(이 주소로 30일 안에 성공한 요청자)는 15분 5통 · 하루 50통,
 *     그 밖의 IP 는 신뢰 밖 코드만 세어 15분 2통 · 하루 4통(`userLinkCaps`) — 넘으면 **조용히** 적지 않는다(429 로 알리면 "그 주소는 존재한다" 가
 *     새어 나간다). 여러 IP 의 공격자가 신뢰 밖 몫을 채워도 소유자의 평소 IP 는 코드를 받는다.
 *     남는 틈: 처음 보는 기기 · IP 의 로그인은 공격자가 신뢰 밖 몫을 채운 동안(최대 하루) 미뤄질 수 있다 — 신뢰 IP 에서 로그인하거나 운영자 재설정.
 *   - **경합:** 계수와 INSERT 사이에 틈이 없다 — 트랜잭션 안에서 요청자 키와 입력 주소에 advisory 잠금을 걸고 센다
 *     (검증 L1: 같은 IP 동시 30건이 30건 다 통과했다). 잠금 순서는 언제나 요청자 → 주소(교착 없음).
 *   - **브라우저 결속:** 요청한 브라우저에 논스 쿠키(`__Host-atmark_admin_login` — HttpOnly · Secure · SameSite=Strict · Path=/)를 주고, 링크 행에는
 *     그 논스의 해시를 적는다. verify 는 같은 논스를 요구한다. 이것이 막는 것: 메일 링크만 가진 쪽(메일함을 엿본 사람, 링크를
 *     먼저 여는 메일 스캐너, 전달된 메일)은 세션을 만들 수 없다 — 로그인을 요청한 그 브라우저에서만 된다. 그리고 로그인 CSRF
 *     (남의 링크를 내 브라우저에서 태우게 하는 것)도 막는다.
 *     **이것이 막지 못하는 것:** 로그인 키를 읽을 수 있는 쪽의 탈취. 공격자는 **자기 브라우저로** 로그인을 요청해 자기 논스를
 *     받고, 링크 id·만료(앱 롤이 읽을 수 있는 outbox 컬럼)와 로그인 키로 토큰을 만들어 자기 논스로 verify 할 수 있다 —
 *     논스는 요청자와 verify 하는 쪽이 같은지만 보지, 그 쪽이 소유자인지는 보지 않는다(검증 F1 이 실증). 그래서 로그인 키는
 *     발송 역할(api Lambda 와 같은 IAM 역할)이 아니라 **로그인 메일 전용 주체**만 읽어야 한다(ADR-0006 — 로그인 메일 발송
 *     주체 분리). 그 경계가 이 파일 밖, 인프라·비밀 층에 있다.
 *
 * ## verify (`POST /api/login/verify {code}`)
 *
 *   **링크 로그인은 없다(2026-10-10 진윤겸 결정).** 옛 메일의 서명 토큰(`{token}` — `atk_login_…`)을 보내면 토큰을 보지도 않고 410
 *   `login_link_retired` 로 답한다(착지 `/login` 은 "더는 쓰지 않는 링크 — 코드로 로그인하세요" 화면). 아래가 유일한 경로다.
 *   논스 쿠키가 **아예 없는** 브라우저만 401 `login_browser_missing` 으로 따로 말한다 — 요청한 쪽이 이미 아는 사실이고, 코드·DB 를 보기 **전에**
 *   내려서 아무것도 새지 않는다. 성공하면 같은 트랜잭션에서 세션 행(토큰 **해시만**, 12시간 · 사용자 결속)과 감사 행(`session.login`)을 적는다.
 *   행이 초대 로그인이면(`invite_id`) 같은 트랜잭션에서 `accept_org_invite` → 멤버십 + 감사 `member.join`. 행의 조직에 멤버십이 없어졌으면
 *   다른 살아 있는 멤버십으로, 하나도 없으면 거부. 살아 있는 멤버십이 둘 이상이면 `next:'select-org'`.
 *
 *   **코드(`{code}` — 메일의 6자리, `security/login-code.ts`).** 행 하나 = 로그인 시도 하나 — 코드가 맞으면 그 행의 `used_at` 을 태운다
 *   (트리거가 NULL → 값 1회, 만료 뒤 불가를 한 번 더 집행). 코드에는 행 id 가 없어서 **이 브라우저의 결속**으로 후보를 찾는다: 결속이 같고 · 쓰지
 *   않았고 · 무효화되지 않았고 · 만료 전이고 · 메일이 나갔고(`sent` — 나가지 않은 행의 코드는 아무도 모른다, 대입 표면만 넓힌다) ·
 *   틀린 코드 5회 미만인 행(최신 `LOGIN_CODE_CANDIDATES` 개)을 **행 잠금**으로 잡고, 각 행의 코드를 로그인 키로 다시 계산해 상수 시간으로
 *   맞춘다. 맞으면 그 행으로 위와 같은 세션을 연다. 틀리면 잡은 후보 **전부**의 `code_failures` 를 한 문장으로 +1 하고 커밋한다 — 5 가 된
 *   행은 링크로도 코드로도 끝이다(새로 요청해야 한다). 동시 요청은 같은 행 잠금에서 줄을 서므로 5회를 넘겨 셀 수 없다.
 *   **열거 방지:** 후보가 0개여도 같은 두 문장(잠금 SELECT · 계수 UPDATE)이 같은 순서로 돌고 응답은 같은 401(`login_code_invalid`)이다
 *   — 없는 주소·안 보낸 메일·틀린 코드·만료·5회 초과를 가리지 않는다. 결속은 요청한 브라우저만 가지므로 남의 브라우저의 시도를 태울 수
 *   없다(공격자가 자기 브라우저로 남의 주소를 요청해 대 보는 것은 그 요청의 링크만 태운다 — 요청 상한 · 로그인 메일러의 사용자당 시간당
 *   10통 · API 스로틀이 그 총량을 묶는다).
 *   **잠금 DoS 수정(2026-10-10):** 예전의 계정당 하루 틀린 코드 예산(20 — 모든 IP 의 실패를 합쳐 셌다)은 공격자가 피해자를 24시간 잠그게
 *   했으므로 없앴다. 실패는 코드(5회)와 IP 에만 묶는다 — 틀린 코드 원장 `login_code_attempts`(한 행 = 틀린 코드 하나)가 IP 당 시간당 30이면
 *   그 IP 의 코드 verify 는 429(주소와 무관). 다른 IP 의 실패는 이 IP 의 로그인을 막지 못한다. 대입 총량은 코드당 5회 × 신뢰 밖 주소당 하루 4통 = 20번이 묶는다.
 *   소스 IP 가 없으면 라우트가 503 `client_ip_unavailable` 로 닫는다(재확인 I-3).
 *
 * ## 세션·CSRF
 *
 *   세션 토큰 `atk_admin_…`(256비트)은 쿠키에만 산다(HttpOnly). CSRF 토큰 = sha256(문맥 ‖ 세션 토큰) — 세션에 묶여 있고,
 *   쿠키 없이는 계산할 수 없으며, 거꾸로 세션 토큰을 복원할 수 없다. 모든 변경 요청은 `X-Atmark-CSRF` 가 이것과 같아야 한다.
 *   로그아웃은 `revoked_at` 을 적는다(한 번 적히면 덮지 않는다 — 트리거). "모든 세션 로그아웃" 은 **이 사용자의** 살아 있는
 *   세션 전부(모든 조직)에 적는다(다른 기기에 남은 세션을 끊는다 — 다른 멤버의 세션을 끊는 것은 멤버 제거다). `owner_email` 이 바뀌면
 *   DB 트리거가 그 조직의 세션을 전부 폐기한다(`202609230710_owner_pause.sql`).
 *
 * ## 세션 = 사용자 × 조직 (확장성 P0 R-1)
 *
 *   세션 행은 불변이라(`revoked_at` 밖) 조직을 바꿀 수 없다 — **조직 전환 = 새 세션 행**(`switched_from_session_id`, 만료 상속, 부모는
 *   같은 트랜잭션에서 폐기). 토큰과 CSRF 가 함께 바뀌므로 다른 탭의 옛 CSRF 로 새 조직에서 행위할 수 없다(403 로 닫힌 채 실패).
 *   역할은 세션에 캐시하지 않는다 — `resolveSession` 이 **매 요청** `memberships` 와 조인해 읽는다. 멤버십이 없어지면(제거·나가기)
 *   그 세션은 다음 요청부터 무효(401)다. 사용자 없는 옛 세션(0110 이전)도 조인에서 떨어진다(배포 때 1회 재로그인 — 창업자 결정 F-5).
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';

import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../db/client';
import { MAIL_IDENTITY_CONFLICT_SQLSTATE } from '../domains/contract';
import { isMailLocale, resolveMailLocale, SUPPORTED_MAIL_LOCALES, type MailLocale } from '../i18n/locales';
import { ProvisioningError, resolveOwnerEmail } from '../identity/provisioning';
import { activeKey, type HmacKeyring } from '../security/hmac-keyring';
import { verifyInviteToken } from '../security/invite-token';
import { matchLoginCode, normalizeLoginCode, OWNER_LOGIN_LINK_TTL_MS, SIGNUP_LINK_TTL_MS, type LoginCodeLink } from '../security/login-code';
import {
  LOGIN_CODE_FAILURE_WINDOW_MS,
  LOGIN_CODE_FAILURES_PER_CLIENT,
  LOGIN_CODE_MAX_FAILURES,
  LOGIN_LINK_USER_WINDOW_MS,
  LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR,
  LOGIN_LINKS_PER_USER_PER_DAY,
  LOGIN_LINKS_PER_USER_PER_WINDOW,
  LOGIN_REQUEST_WINDOW_MS,
  LOGIN_REQUESTS_PER_CLIENT,
  LOGIN_TRUSTED_REQUESTER_DAYS,
  LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY,
  LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW,
  SIGNUP_LINKS_PER_EMAIL_PER_DAY,
  SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR,
  SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY,
  SIGNUP_REQUESTS_PER_EMAIL_PER_DAY,
} from '../security/login-limits';
import { recordOwnerAction, type MemberRole, type OwnerSession } from './context';
import { INVISIBLE_OR_CONTROL_CHARACTERS } from './display';
import { AdminInputError, notFound, sqlStateOf, UUID_PATTERN } from './ops/errors';

const SESSION_TOKEN_PREFIX = 'atk_admin_';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_BROWSER_TTL_MS = OWNER_LOGIN_LINK_TTL_MS;

const SESSION_TOKEN_PATTERN = /^atk_admin_[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_CONTEXT = 'atmark.admin-csrf.v1';
const BROWSER_CONTEXT = 'atmark.admin-login-browser.v1';
const MAX_EMAIL_LENGTH = 254;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function newSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** 이 브라우저가 이미 가진 논스(쿠키)면 재사용 — 같은 브라우저의 링크 여럿이 모두 통하게. 모양이 아니면 새로. */
function reuseNonce(nonce: string | undefined): string {
  return nonce !== undefined && NONCE_PATTERN.test(nonce) ? nonce : randomBytes(32).toString('base64url');
}

/**
 * 요청자 키의 재료(보안 검토 2026-09-30) — IPv4 는 주소 그대로, **IPv6 는 /64 접두어**로 묶는다. 한 가입자(가정·클라우드 VM)는 보통 /64 하나를 통째로
 * 받으므로 주소마다 따로 세면 요청자 상한(시간당 5 등)을 주소 수만큼 곱해 쓸 수 있다. IPv4 에 매핑된 IPv6(`::ffff:a.b.c.d`)는 IPv4 로 본다. 주소 모양이
 * 아니면(테스트 식별자 등) 그대로 — 기존 IPv4 키는 바뀌지 않는다.
 */
export function requesterBucketOf(ip: string): string {
  const raw = ip.trim();
  const address = raw.split('%')[0] ?? raw;
  if (!isIPv6(address)) return raw;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address.replace(/^::/, '0:'));
  if (mapped?.[1] !== undefined) return mapped[1];
  let text = address.toLowerCase();
  // 끝에 박힌 IPv4(`::1.2.3.4`)는 16비트 둘로.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => String(parseInt(group, 16).toString(16))).join(':')}::/64`;
}

/**
 * 요청자 키 = HMAC(로그인 키, 'ip:' ‖ `requesterBucketOf`). 로그인·가입·초대 claim·코드 verify·대기자 명단이 같은 키 문맥이라 원장에서 함께 센다.
 */
export function requesterKeyOf(keyring: HmacKeyring, sourceIp: string): string {
  return createHmac('sha256', activeKey(keyring).key).update(`ip:${requesterBucketOf(sourceIp)}`, 'utf8').digest('hex');
}

/** 가입 원장의 주소 해시(`signup_requests.email_hash`) — 요청자 키와 같은 HMAC 키 · 원장에 주소 평문이 없다. 대기자 명단도 같은 문맥. */
export function signupEmailHashOf(keyring: HmacKeyring, email: string): string {
  return createHmac('sha256', activeKey(keyring).key).update(`signup-email:${email}`, 'utf8').digest('hex');
}

/** 논스 → 링크 행의 `browser_binding`. 논스는 256비트 난수라 해시만으로 충분하다(키 회전에 흔들리지 않게 HMAC 이 아니다). */
export function browserBindingOf(nonce: string): string {
  return sha256Hex(`${BROWSER_CONTEXT}\n${nonce}`);
}

/** 세션 토큰 → CSRF 토큰. */
export function csrfTokenOf(sessionToken: string): string {
  return createHash('sha256').update(`${CSRF_CONTEXT}\n${sessionToken}`, 'utf8').digest('base64url');
}

/** 상수 시간 비교(길이가 다르면 거짓). */
export function csrfMatches(sessionToken: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expected = Buffer.from(csrfTokenOf(sessionToken), 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isSessionTokenShape(value: string | undefined): value is string {
  return value !== undefined && SESSION_TOKEN_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 로그인 요청
// ---------------------------------------------------------------------------

interface LoginRequestInput {
  /** 요청 본문의 `email` — 무엇이든 온다(문자열이 아닐 수도). */
  readonly email: unknown;
  readonly sourceIp: string;
  /** 이 브라우저가 이미 가진 논스(쿠키). 있으면 재사용한다 — 같은 브라우저의 링크 여럿이 모두 통하게. */
  readonly browserNonce: string | undefined;
}

type LoginRequestOutcome =
  | { readonly kind: 'accepted'; readonly nonce: string }
  | { readonly kind: 'rate_limited' };

/** 이메일 정규화 — trim + 소문자. 모양이 아니면 `null`(그래도 같은 문장들을 실행한다 — 분기로 시간이 갈리지 않게). */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length >= 3 && email.length <= MAX_EMAIL_LENGTH && email.includes('@') ? email : null;
}

/**
 * 로그인 링크의 조직 — 사용자 `u` 의 살아 있는 멤버십 중 `last_organization_id` 가 있으면 그것, 아니면 가장 오래된 것 하나.
 * `CROSS JOIN LATERAL` 의 조각이라 멤버십이 없으면 행이 없다(링크 0행 — 응답은 같다). 로그인·가입 요청이 같은 조각을 쓴다.
 */
const LOGIN_ORGANIZATION_OF_USER = `SELECT m.organization_id FROM memberships m
          WHERE m.user_id = u.id AND m.removed_at IS NULL
          ORDER BY (m.organization_id = u.last_organization_id) DESC NULLS LAST, m.created_at, m.id
          LIMIT 1`;

/**
 * 주소(사용자) 단위 **발급** 상한 — 로그인 요청 · 초대 claim · 가입 화면의 로그인 갈래가 같은 조각을 쓴다(`security/login-limits.ts` ③).
 * `user` = 사용자 id 식, `client` = 요청자 키 자리표시자. 숫자는 코드 상수라 문장에 박는다. 넘으면 0행 — 응답은 같은 202(열거 신호 없음).
 *   - (사용자, 요청자) 시간당 3통 — 언제나.
 *   - 신뢰 요청자(이 주소로 지난 30일 안에 로그인에 성공한 요청자 키 — `owner_login_links_user_client_created_idx`): 그 사용자의 모든 코드로 15분 5통 · 하루 50통.
 *   - 그 밖의 요청자: **신뢰받지 않은 요청자에게 나간 코드만** 세어 15분 2통 · 하루 4통 → 신뢰 밖에서 한 주소를 겨누는 대입은 하루 4 × 5 = 20번이 끝이다.
 *     신뢰 요청자의 코드는 이 몫을 쓰지 않는다(평소 로그인이 새 기기의 몫을 깎지 않는다).
 */
function userLinkCaps(user: string, client: string): string {
  const trusted = (key: string): string => `EXISTS (SELECT 1 FROM owner_login_links t
                        WHERE t.user_id = ${user} AND t.client_key = ${key} AND t.used_at IS NOT NULL
                          AND t.created_at > now() - interval '${String(LOGIN_TRUSTED_REQUESTER_DAYS)} days')`;
  const window = `interval '${String(LOGIN_LINK_USER_WINDOW_MS / 1000)} seconds'`;
  return `(SELECT count(*) FROM owner_login_links l
                WHERE l.user_id = ${user} AND l.client_key = ${client} AND l.created_at > now() - interval '1 hour') < ${String(LOGIN_LINKS_PER_CLIENT_PER_USER_PER_HOUR)}
          AND CASE WHEN ${trusted(client)}
               THEN (SELECT count(*) FROM owner_login_links l
                      WHERE l.user_id = ${user} AND l.created_at > now() - ${window}) < ${String(LOGIN_LINKS_PER_USER_PER_WINDOW)}
                    AND (SELECT count(*) FROM owner_login_links l
                          WHERE l.user_id = ${user} AND l.created_at > now() - interval '1 day') < ${String(LOGIN_LINKS_PER_USER_PER_DAY)}
               ELSE (SELECT count(*) FROM owner_login_links l
                      WHERE l.user_id = ${user} AND l.created_at > now() - ${window} AND NOT ${trusted('l.client_key')}) < ${String(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_WINDOW)}
                    AND (SELECT count(*) FROM owner_login_links l
                          WHERE l.user_id = ${user} AND l.created_at > now() - interval '1 day' AND NOT ${trusted('l.client_key')}) < ${String(LOGIN_UNTRUSTED_LINKS_PER_USER_PER_DAY)}
               END`;
}

/** 로그인 요청 원장(`owner_login_requests`) — 요청자 잠금 아래에서 센다. 상한이면 `false`(아무것도 쓰지 않는다), 아니면 한 행 적고 `true`. 로그인·초대 claim 이 같은 원장. */
async function takeLoginRequest(client: Queryable, clientKey: string): Promise<boolean> {
  const recent = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_login_requests WHERE client_key = $1 AND requested_at > now() - make_interval(secs => $2)`,
    [clientKey, LOGIN_REQUEST_WINDOW_MS / 1000],
  );
  if ((recent.rows[0]?.n ?? 0) >= LOGIN_REQUESTS_PER_CLIENT) return false;
  await client.query('INSERT INTO owner_login_requests (client_key) VALUES ($1)', [clientKey]);
  return true;
}

export async function requestLogin(pool: Pool, keyring: HmacKeyring, input: LoginRequestInput): Promise<LoginRequestOutcome> {
  const clientKey = requesterKeyOf(keyring, input.sourceIp);
  const email = normalizeEmail(input.email);
  const nonce = reuseNonce(input.browserNonce);

  return withTransaction(pool, async (client): Promise<LoginRequestOutcome> => {
    // 요청자 → 입력 주소 순서로 잠근다. 같은 요청자의 동시 요청은 여기서 줄을 서고, 같은 주소의 동시 요청도 줄을 선다
    //   (조직 상한 계수가 경합하지 않게). 주소 잠금은 **입력값**에 건다 — 일치 여부와 무관하게 같은 문장이다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_client:' || $1::text, 0))`, [clientKey]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_email:' || coalesce($1::text, ''), 0))`, [email]);
    if (!(await takeLoginRequest(client, clientKey))) return { kind: 'rate_limited' };

    // ★ 일치·불일치가 **같은 한 문장**이다. 모양이 아닌 입력은 어떤 사용자 주소와도 같을 수 없는 값(NULL)으로 보낸다.
    //   두 링크 상한도 같은 문장의 조건이다 — 넘으면 0행, 응답은 같다. 살아 있는 멤버십이 없는 사용자(초대만 받은 주소)도 0행.
    await client.query(
      // next_attempt_at 을 ms 로 자른다 — 워커는 JS 시각(ms)으로 `next_attempt_at <= $now` 를 본다. µs 가 남으면 같은 ms 의
      //   틱이 이 행을 "아직" 으로 읽는다(다음 틱에 나가지만, 결정적이지 않은 지연은 두지 않는다).
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, client_key, expires_at, next_attempt_at)
       SELECT d.organization_id, u.id, $2, $3, date_trunc('milliseconds', now() + make_interval(secs => $4)), date_trunc('milliseconds', now())
         FROM users u
        CROSS JOIN LATERAL (${LOGIN_ORGANIZATION_OF_USER}) d
        WHERE u.email = $1
          AND ${userLinkCaps('u.id', '$3')}`,
      [email, browserBindingOf(nonce), clientKey, OWNER_LOGIN_LINK_TTL_MS / 1000],
    );
    return { kind: 'accepted', nonce };
  });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

// `OwnerSession` 은 `context.ts` 에 산다(감사 도우미가 쓴다) — 여기서 되내보낸다. 거꾸로 두면 context ↔ session 순환이다.
export type { OwnerSession } from './context';

type VerifyOutcome =
  | {
      readonly kind: 'session';
      readonly session: OwnerSession;
      readonly token: string;
      readonly csrf: string;
      /** 살아 있는 멤버십이 둘 이상이면 `select-org`(콘솔이 조직 고르기 화면으로) — 초대 수락 로그인은 언제나 `app`. */
      readonly next: 'app' | 'select-org';
    }
  /** 이 브라우저에 로그인 논스 쿠키가 없다 — 코드·DB 를 보기 전에 판단한다(행 상태는 새지 않는다). */
  | { readonly kind: 'browser_missing' }
  | { readonly kind: 'rejected' }
  /** 옛 메일의 로그인 링크 토큰이 왔다(2026-10-10 링크 로그인 삭제) — 토큰을 보지 않는다. 코드로 로그인하라고 안내한다. */
  | { readonly kind: 'link_retired' }
  /** 초대 수락이 조직 멤버 상한에 걸렸다 — 트랜잭션 전체가 되돌아가 링크·초대는 소비되지 않았다. */
  | { readonly kind: 'member_limit' }
  /** IP 당 틀린 코드 상한(`LOGIN_CODE_FAILURES_PER_CLIENT` — 시간당 30) — 주소와 무관하다. */
  | { readonly kind: 'rate_limited' };

/** DB 함수·가드가 상한·보호에 걸렸을 때 던지는 SQLSTATE — 메시지가 코드다(`member_limit` · `last_owner` · `primary_owner` · `invite_pending` …). */
const CONFLICT_SQLSTATE = 'AT409';
export const FORBIDDEN_SQLSTATE = 'AT403';

function sqlState(error: unknown): { code: string | undefined; message: string } {
  if (typeof error !== 'object' || error === null) return { code: undefined, message: '' };
  const { code, message } = error as { code?: unknown; message?: unknown };
  return { code: typeof code === 'string' ? code : undefined, message: typeof message === 'string' ? message : '' };
}

/** 에이전트 주소 ↔ 사람 이메일 claim 충돌(P0A01, ADR-0014 · 202609291110)인가. */
export function isMailIdentityConflict(error: unknown): boolean {
  return sqlStateOf(error) === MAIL_IDENTITY_CONFLICT_SQLSTATE;
}

/** DB 가 `AT409 <코드>` 로 거부했으면 그 코드(`last_owner` 등), 아니면 `null`. */
export function conflictCodeOf(error: unknown): string | null {
  const state = sqlState(error);
  return state.code === CONFLICT_SQLSTATE && /^[a-z_]{1,40}$/.test(state.message) ? state.message : null;
}

/**
 * 코드 검증의 후보 링크 상한(최신 순) — 한 브라우저 결속의 살아 있는 링크 중 **사용자(가입은 주소)마다 가장 최근 것 하나**(보안 리뷰 L-1).
 * 그래서 한 시도는 한 사용자에게 추측 1번이다(한 결속에 한 피해자의 링크를 여러 개 쌓아 한 시도로 여러 번 맞춰 보지 못한다).
 * 요청 상한이 이미 작게 묶지만 계산량의 바닥을 둔다.
 */
const LOGIN_CODE_CANDIDATES = 10;

/**
 * IP 당 틀린 코드 상한(`security/login-limits.ts` ② — 로그인·가입 합산, 원장 `login_code_attempts` 의 한 행 = 틀린 코드 하나). **주소와 무관**하다
 * (429 는 열거 신호가 아니다 · 계정 단위 예산이 없는 이유는 머리말).
 *
 * IP 키 잠금(트랜잭션 끝까지 — 같은 IP 의 verify 는 줄을 선다) → 지난 1시간 틀린 수(`login_code_attempts_client_idx`) → 상한이면 `null`(아무것도 쓰지
 * 않는다), 아니면 IP 키. IP 키는 로그인 요청 원장과 같다(HMAC(로그인 키, 'ip:' ‖ API Gateway 의 sourceIp 버킷)).
 */
async function codeFailureBudget(client: Queryable, keyring: HmacKeyring, sourceIp: string): Promise<string | null> {
  const clientKey = requesterKeyOf(keyring, sourceIp);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('login_code_client:' || $1::text, 0))`, [clientKey]);
  const recent = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM login_code_attempts WHERE client_key = $1 AND created_at > now() - make_interval(secs => $2)',
    [clientKey, LOGIN_CODE_FAILURE_WINDOW_MS / 1000],
  );
  return (recent.rows[0]?.n ?? 0) >= LOGIN_CODE_FAILURES_PER_CLIENT ? null : clientKey;
}

/** 틀린 코드 하나를 IP 원장에 적는다(위 잠금 아래 — 상한을 넘겨 쓰지 않는다). */
async function recordCodeFailure(client: Queryable, clientKey: string): Promise<void> {
  await client.query('INSERT INTO login_code_attempts (client_key) VALUES ($1)', [clientKey]);
}

export async function verifyLogin(
  pool: Pool,
  keyring: HmacKeyring,
  input: {
    /** 옛 메일 링크의 토큰 — 보지 않는다(있고 코드가 없으면 `link_retired`). */
    readonly token?: unknown;
    readonly code?: unknown;
    readonly browserNonce: string | undefined;
    /** API Gateway 의 소스 IP — 코드 경로의 요청자 상한이 쓴다. 없으면 라우트가 먼저 503 으로 닫는다(`'unknown'` 한 버킷으로 모으지 않는다). */
    readonly sourceIp: string;
    readonly now: Date;
  },
): Promise<VerifyOutcome> {
  // 링크 로그인은 없다(2026-10-10) — 토큰만 온 요청은 토큰·쿠키·DB 를 보지 않고 닫는다(아무것도 새지 않는다).
  if (input.code === undefined) return input.token === undefined ? { kind: 'rejected' } : { kind: 'link_retired' };
  if (input.browserNonce === undefined) return { kind: 'browser_missing' };
  if (!NONCE_PATTERN.test(input.browserNonce)) return { kind: 'rejected' };
  // 토큰을 함께 보내면 거부(옛 화면과 새 화면이 섞인 요청 — 어느 것도 태우지 않는다). 모양이 아니면 DB 전에 거부(시도로 세지 않는다).
  const code = input.token === undefined ? normalizeLoginCode(input.code) : null;
  if (code === null) return { kind: 'rejected' };
  return verifyLoginCode(pool, keyring, { code, binding: browserBindingOf(input.browserNonce), sourceIp: input.sourceIp, now: input.now });
}

interface UsedLoginLink {
  organization_id: string;
  user_id: string | null;
  invite_id: string | null;
}

/**
 * 이 브라우저 결속의 코드 후보 — 쓰지 않았고 · 무효화되지 않았고 · 만료 전이고 · 메일이 나갔고 · 틀린 코드 5회 미만인 링크 중 **사용자마다
 * 가장 최근 것 하나**(보안 리뷰 L-1 — 같은 사용자의 옛 메일 코드는 코드 경로로 받지 않는다)(최신 순, 행 잠금 — 부분 색인
 * `owner_login_links_code_candidates_idx`). 잠금은 바깥 문장의 `created_at DESC, id` 순서 그대로다. 살아 있는 조건은 바깥에서 한 번 더
 * 본다 — 잠금을 기다린 뒤 바뀐 행(동시에 5 가 됐거나 쓰였다)은 다시 판정돼 빠진다. 결속을 모르는 호출(`binding = null`)도 **같은 문장**을
 * 돈다(0행) — 문장 수·순서가 입력으로 갈리지 않게.
 */
async function lockLoginCodeCandidates(client: Queryable, binding: string | null): Promise<LoginCodeLink[]> {
  const rows = await client.query<{ id: string; expires_at: Date }>(
    `SELECT l.id, l.expires_at FROM owner_login_links l
      WHERE l.id IN (SELECT DISTINCT ON (c.user_id) c.id FROM owner_login_links c
                      WHERE c.browser_binding = $1 AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()
                        AND c.status = 'sent' AND c.code_failures < $2 AND c.user_id IS NOT NULL
                      ORDER BY c.user_id, c.created_at DESC, c.id)
        AND l.used_at IS NULL AND l.invalidated_at IS NULL AND l.expires_at > now() AND l.status = 'sent' AND l.code_failures < $2
      ORDER BY l.created_at DESC, l.id
      LIMIT $3
      FOR UPDATE OF l`,
    [binding, LOGIN_CODE_MAX_FAILURES, LOGIN_CODE_CANDIDATES],
  );
  return rows.rows.map((row) => ({ linkId: row.id, expiresAt: row.expires_at }));
}

/** 틀린 코드 — 잡은 후보 **전부** +1(0개여도 같은 문장). 5 가 된 행은 그 뒤로 링크로도 코드로도 쓸 수 없다. */
async function countLoginCodeFailure(client: Queryable, candidates: readonly LoginCodeLink[]): Promise<void> {
  await client.query(
    'UPDATE owner_login_links SET code_failures = code_failures + 1 WHERE id = ANY($1::uuid[]) AND code_failures < $2',
    [candidates.map((candidate) => candidate.linkId), LOGIN_CODE_MAX_FAILURES],
  );
}

/** 맞은 코드의 행을 태운다 — 단일 사용 · DB 만료(잠근 행의 만료와 같은 값) · 브라우저 결속 · 틀린 코드 5회 미만을 한 문장에서. 0행이면 `undefined`. */
async function useLoginLinkByCode(client: Queryable, link: LoginCodeLink, binding: string): Promise<UsedLoginLink | undefined> {
  const used = await client.query<UsedLoginLink>(
    `UPDATE owner_login_links SET used_at = now()
      WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND expires_at = $2 AND browser_binding = $3 AND code_failures < $4
      RETURNING organization_id, user_id, invite_id`,
    [link.linkId, link.expiresAt, binding, LOGIN_CODE_MAX_FAILURES],
  );
  return used.rows[0];
}

async function verifyLoginCode(
  pool: Pool,
  keyring: HmacKeyring,
  input: { readonly code: string; readonly binding: string; readonly sourceIp: string; readonly now: Date },
): Promise<VerifyOutcome> {
  const { code, binding, now } = input;
  try {
    return await withTransaction(pool, async (client): Promise<VerifyOutcome> => {
      const clientKey = await codeFailureBudget(client, keyring, input.sourceIp);
      if (clientKey === null) return { kind: 'rate_limited' };
      const candidates = await lockLoginCodeCandidates(client, binding);
      const matched = candidates[matchLoginCode(keyring, 'owner_login', candidates, code)];
      if (matched === undefined) {
        // 틀린 코드(후보 0개 포함) — 코드의 틀린 수와 IP 원장 한 행이 **커밋된다**(거부를 반환해도 트랜잭션은 커밋).
        await countLoginCodeFailure(client, candidates);
        await recordCodeFailure(client, clientKey);
        return { kind: 'rejected' };
      }
      return openLoginSession(client, matched.linkId, await useLoginLinkByCode(client, matched, binding), now);
    });
  } catch (error) {
    if (conflictCodeOf(error) === 'member_limit') return { kind: 'member_limit' };
    // 초대 수락의 멤버십 INSERT 가 에이전트 주소 claim 과 부딪혔다(ADR-0014 · 202609291110) — 이 주소는 사람이 될 수 없다. 이유를 가리지 않는다.
    if (isMailIdentityConflict(error)) return { kind: 'rejected' };
    throw error;
  }
}

/**
 * 태운 행 → 세션(로그인 코드 · 가입 화면의 로그인 코드 공통, 호출자의 트랜잭션 안). 초대 수락 · 조직 고르기 · 세션 행 · 감사 · `last_organization_id`.
 * 링크가 없거나(0행) 사용자 없는 옛 행이거나 살아 있는 멤버십이 없으면 거부.
 */
async function openLoginSession(client: Queryable, linkId: string, link: UsedLoginLink | undefined, now: Date): Promise<VerifyOutcome> {
  // 사용자 없는 링크 = 0110 이전의 옛 행(15분짜리) — 새 코드는 받지 않는다.
  if (link === undefined || link.user_id === null) return { kind: 'rejected' };
  const userId = link.user_id;
  const token = newSessionToken();

  let joined: { membershipId: string } | null = null;
  let invited = false;
  if (link.invite_id !== null) {
    // 초대 수락 — 대기·미만료·수신자 일치가 아니면 NULL(이 로그인은 다른 멤버십으로 이어 간다). 멤버 상한이면 AT409 → 전체 되돌림.
    const accepted = await client.query<{ membership_id: string | null; joined: boolean }>(
      'SELECT membership_id, joined FROM accept_org_invite($1::uuid, $2::uuid, $3)',
      [link.invite_id, userId, now],
    );
    const row = accepted.rows[0];
    invited = row?.membership_id !== null && row?.membership_id !== undefined;
    if (row?.membership_id != null && row.joined) joined = { membershipId: row.membership_id };
  }

  // 조직 — 링크의 조직에 살아 있는 멤버십이 있으면 그것, 아니면 last_organization_id, 아니면 가장 오래된 것.
  const chosen = await client.query<{ organization_id: string; role: MemberRole; live: number }>(
    `SELECT m.organization_id, m.role, count(*) OVER ()::int AS live
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.removed_at IS NULL
      ORDER BY (m.organization_id = $2) DESC, (m.organization_id = u.last_organization_id) DESC NULLS LAST, m.created_at, m.id
      LIMIT 1`,
    [userId, link.organization_id],
  );
  const membership = chosen.rows[0];
  if (membership === undefined) return { kind: 'rejected' };
  const organizationId = membership.organization_id;

  const session = await client.query<{ id: string }>(
    `INSERT INTO owner_sessions (organization_id, user_id, login_link_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
    [organizationId, userId, linkId, sha256Hex(token), SESSION_TTL_MS / 1000],
  );
  const id = session.rows[0]?.id;
  if (id === undefined) throw new Error('owner_sessions INSERT 가 행을 돌려주지 않았다');
  const owner: OwnerSession = { id, organizationId, userId, role: membership.role };
  await recordOwnerAction(client, owner, 'session.login', null);
  if (joined !== null && organizationId === link.organization_id) {
    await recordMembershipEvent(client, owner, 'member.join', { membershipId: joined.membershipId, userId, oldRole: null, newRole: membership.role });
  }
  await client.query('UPDATE users SET last_organization_id = $2 WHERE id = $1', [userId, organizationId]);
  return {
    kind: 'session',
    session: owner,
    token,
    csrf: csrfTokenOf(token),
    next: invited || membership.live <= 1 ? 'app' : 'select-org',
  };
}

/**
 * 멤버십 변경 감사 — `owner_actions` 한 행(대상 = 사용자 id) + 같은 id 의 `membership_events`(역할 전·후). 행위와 같은 트랜잭션에서 부른다.
 * tlog 잎에는 사용자 **id** 만 간다(주소 없음 — `owner.action` 잎의 target).
 */
export async function recordMembershipEvent(
  db: Queryable,
  session: OwnerSession,
  action: string,
  event: { readonly membershipId: string; readonly userId: string; readonly oldRole: MemberRole | null; readonly newRole: MemberRole | null },
): Promise<void> {
  const actionId = randomUUID();
  await recordOwnerAction(db, session, action, event.userId, actionId);
  await db.query(
    'INSERT INTO membership_events (owner_action_id, membership_id, user_id, old_role, new_role) VALUES ($1, $2, $3, $4, $5)',
    [actionId, event.membershipId, event.userId, event.oldRole, event.newRole],
  );
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

/**
 * 쿠키 → 살아 있는 세션. 모양이 아니거나 폐기·만료면 `null`. **멤버십 조인** — 사용자 없는 옛 세션, 제거·나간 멤버의 세션은 `null`
 * (401). 역할은 여기서 매번 읽는다(캐시 없음 — 강등이 다음 요청부터 효력).
 */
export async function resolveSession(db: Queryable, token: string | undefined): Promise<OwnerSession | null> {
  if (!isSessionTokenShape(token)) return null;
  const result = await db.query<{ id: string; organization_id: string; user_id: string; role: MemberRole }>(
    `SELECT s.id, s.organization_id, s.user_id, m.role
       FROM owner_sessions s
       JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id AND m.removed_at IS NULL
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256Hex(token)],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, organizationId: row.organization_id, userId: row.user_id, role: row.role };
}

/** 로그아웃 — 폐기 시각을 적는다(이미 폐기됐으면 덮지 않는다). */
export async function revokeSession(db: Queryable, session: OwnerSession): Promise<void> {
  await db.query('UPDATE owner_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [session.id]);
}

/**
 * 사용자 세션 잠금(트랜잭션 끝까지) — 조직 전환·새 조직(자식 세션 INSERT) · 모든 세션 로그아웃 · 멤버 제거·나가기(세션 폐기)가 **같은 키**로
 * 줄을 선다(적대적 검토 M1). 없으면: 전환이 자식을 INSERT 하고 부모를 잠근 채 커밋 전인 사이에 logout-all 의 UPDATE 가 돌면, 그 문장의
 * 스냅샷에는 자식이 없고(아직 커밋 전) 부모는 전환이 커밋한 뒤 "이미 폐기" 로 다시 평가돼 건너뛴다 — 자식이 산 채 남는다. 잠금을 먼저 잡고
 * 폐기 문장을 **그 뒤에** 돌리면 폐기 문장의 스냅샷(READ COMMITTED — 문장마다 새로)이 전환의 커밋을 본다.
 */
export async function lockUserSessions(db: Queryable, userId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_session_user:' || $1::text, 0))`, [userId]);
}

/** 사용자당 조직 전환·새 조직 상한(적대적 검토 L6) — 10분에 30회(자식 세션 행이 원장). 넘으면 429 `rate_limited`. */
export const SESSION_SWITCHES_PER_USER = 30;
const SESSION_SWITCH_WINDOW_MS = 10 * 60 * 1000;

/** 사용자 세션 잠금 **아래에서** 부른다 — 지난 창의 전환 자식 세션을 센다(`owner_sessions_user_switch_idx`). */
async function limitSessionSwitches(db: Queryable, userId: string): Promise<void> {
  const recent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM owner_sessions
      WHERE user_id = $1 AND switched_from_session_id IS NOT NULL AND created_at > now() - make_interval(secs => $2)`,
    [userId, SESSION_SWITCH_WINDOW_MS / 1000],
  );
  if ((recent.rows[0]?.n ?? 0) >= SESSION_SWITCHES_PER_USER) {
    throw new AdminInputError('조직 전환·새 조직 요청이 너무 잦다 — 잠시 뒤 다시 시도하라.', 'rate_limited', 429);
  }
}

/** 모든 세션 로그아웃 — **이 사용자의** 살아 있는 세션 전부(모든 조직, 이 세션 포함). 폐기한 수를 돌려준다. 사용자 세션 잠금 뒤에 폐기한다(M1). */
export async function revokeAllSessions(db: Queryable, userId: string): Promise<number> {
  await lockUserSessions(db, userId);
  const result = await db.query('UPDATE owner_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return result.rowCount ?? 0;
}

/** 조직의 운영자 검토 상태(`organizations.review_status`, `signup-contract.md` §0). */
type ReviewStatus = 'pending_review' | 'active' | 'rejected';

/** `GET /api/me` 의 조직. 소유자 주소는 **세션의 조직 것**만 — 입력으로 고를 수 없다. */
export async function organizationOf(
  db: Queryable,
  organizationId: string,
): Promise<{ id: string; name: string; ownerEmail: string | null; abuseFreeze: boolean; ownerPaused: boolean; reviewStatus: ReviewStatus } | null> {
  const result = await db.query<{
    id: string;
    name: string;
    owner_email: string | null;
    abuse_freeze: boolean;
    owner_paused: boolean;
    review_status: ReviewStatus;
  }>('SELECT id, name, owner_email, abuse_freeze, owner_paused, review_status::text AS review_status FROM organizations WHERE id = $1', [
    organizationId,
  ]);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        name: row.name,
        ownerEmail: row.owner_email,
        abuseFreeze: row.abuse_freeze,
        ownerPaused: row.owner_paused,
        reviewStatus: row.review_status,
      };
}

/** `GET /api/me` 의 멤버십 한 행 — 조직 스위처가 이것만으로 그린다. */
export interface MembershipView {
  readonly organizationId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly reviewStatus: ReviewStatus;
}

interface MembershipRow {
  organization_id: string;
  name: string;
  role: MemberRole;
  review_status: ReviewStatus;
}

function membershipViewOf(row: MembershipRow): MembershipView {
  return { organizationId: row.organization_id, name: row.name, role: row.role, reviewStatus: row.review_status };
}

/** 사용자의 살아 있는 멤버십 전부(가입 순). 다른 사용자의 것은 입력으로 고를 수 없다(세션의 사용자 id). */
export async function membershipsOf(db: Queryable, userId: string): Promise<MembershipView[]> {
  const result = await db.query<MembershipRow>(
    `SELECT m.organization_id, o.name, m.role, o.review_status::text AS review_status
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.removed_at IS NULL
      ORDER BY m.created_at, m.id`,
    [userId],
  );
  return result.rows.map(membershipViewOf);
}

/** 세션 사용자의 주소. */
export async function userEmailOf(db: Queryable, userId: string): Promise<string | null> {
  const result = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.email ?? null;
}

// ---------------------------------------------------------------------------
// 개인 설정 — 시스템 메일 언어(202610101000)
// ---------------------------------------------------------------------------

/**
 * `GET /api/me/preferences` 의 메일 언어 — 이 사용자가 고른 값, 아니면 기본값(`DEFAULT_MAIL_LOCALE`, 'en'). 고른 적이 있는지는 `chosen` 이 말한다
 * (가입 확정이 가입 언어로 한 번 채운다 — 그것도 고른 것으로 본다).
 */
export async function mailLocaleOf(db: Queryable, userId: string): Promise<{ readonly mailLocale: MailLocale; readonly chosen: boolean }> {
  const result = await db.query<{ mail_locale: string | null }>('SELECT mail_locale FROM users WHERE id = $1', [userId]);
  const stored = result.rows[0]?.mail_locale ?? null;
  return { mailLocale: resolveMailLocale(stored), chosen: isMailLocale(stored) };
}

/**
 * `PATCH /api/me/preferences {mailLocale}` — **본인 행만**(세션의 사용자 id) 한 칸. 값은 등록부(`SUPPORTED_MAIL_LOCALES`)에 있는 것만 — DB 도 FK 로
 * 한 번 더 본다(`users_mail_locale_fkey`). 조직과 무관한 개인 설정이라 감사 행을 남기지 않는다(화면 테마와 같다 — 권한 · 발송 범위를 바꾸지 않는다).
 */
export async function setMailLocale(db: Queryable, userId: string, raw: unknown): Promise<MailLocale> {
  if (!isMailLocale(raw)) {
    throw new AdminInputError(`mailLocale 은 ${SUPPORTED_MAIL_LOCALES.join(' · ')} 중 하나다.`, 'invalid_mail_locale');
  }
  await db.query('UPDATE users SET mail_locale = $2 WHERE id = $1', [userId, raw]);
  return raw;
}

// ---------------------------------------------------------------------------
// 초대 claim (확장성 P1 R-1 — 두 통 흐름의 1단계)
// ---------------------------------------------------------------------------
//
// `POST /api/invites/claim {token}` — 초대 메일의 토큰(서명·만료) → 대기 중인 초대면 **초대받은 사용자에게**, **이 브라우저에 결속된**
//   로그인 링크(`invite_id`)를 적는다. 로그인 요청과 같은 규율: 요청자 상한(시간당 10회, 같은 원장 — 429) · 주소 발급 상한(`userLinkCaps` —
//   넘으면 조용히 0행, 응답은 같은 202) · 같은 주소 잠금 키(`owner_login_email:`). 입력에 이메일이 없다 — 토큰만.
//   토큰을 가진 쪽(전달받은 사람·스캐너)이 claim 해도 로그인 메일은 초대받은 주소로만 가므로 그 사람의 메일함 없이는 아무것도 못 한다.
//   서명·만료·대기 상태가 아니면 401 `invite_invalid` 하나(토큰을 가진 쪽이 이미 아는 정보다).

type ClaimInviteOutcome =
  | { readonly kind: 'accepted'; readonly nonce: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'rate_limited' };

export async function claimInvite(
  pool: Pool,
  keyring: HmacKeyring,
  input: { readonly token: unknown; readonly sourceIp: string; readonly browserNonce: string | undefined; readonly now: Date },
): Promise<ClaimInviteOutcome> {
  if (typeof input.token !== 'string') return { kind: 'invalid' };
  const verified = verifyInviteToken(keyring, input.token, input.now);
  if (verified.kind !== 'valid') return { kind: 'invalid' };
  const clientKey = requesterKeyOf(keyring, input.sourceIp);
  const nonce = reuseNonce(input.browserNonce);

  return withTransaction(pool, async (client): Promise<ClaimInviteOutcome> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_client:' || $1::text, 0))`, [clientKey]);
    if (!(await takeLoginRequest(client, clientKey))) return { kind: 'rate_limited' };

    // 토큰의 만료 = 행의 만료(ms) · 대기 중(수락·취소 없음 · 미만료) · 조직 active·미동결 · 초대자가 아직 살아 있는 owner(적대적 검토 L3·M2 —
    //   DB 링크 가드 `owner_login_links_invite_guard` 와 같은 조건. 여기서 먼저 걸러 401 `invite_invalid` 하나로 답한다).
    const invite = await client.query<{ email: string }>(
      `SELECT u.email FROM org_invites i JOIN users u ON u.id = i.user_id JOIN organizations o ON o.id = i.organization_id
        WHERE i.id = $1 AND i.expires_at = $2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          AND o.review_status = 'active' AND NOT o.abuse_freeze
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = i.organization_id AND m.user_id = i.invited_by_user_id
                        AND m.removed_at IS NULL AND m.role = 'owner')`,
      [verified.claims.inviteId, verified.claims.expiresAt],
    );
    const email = invite.rows[0]?.email;
    if (email === undefined) return { kind: 'invalid' };
    // 로그인 요청과 같은 주소 잠금 — 같은 사용자의 링크 상한을 로그인·claim 이 함께 센다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_email:' || $1::text, 0))`, [email]);
    await client.query(
      `INSERT INTO owner_login_links (organization_id, user_id, invite_id, browser_binding, client_key, expires_at, next_attempt_at)
       SELECT i.organization_id, i.user_id, i.id, $2, $3, date_trunc('milliseconds', now() + make_interval(secs => $4)), date_trunc('milliseconds', now())
         FROM org_invites i
        WHERE i.id = $1
          AND ${userLinkCaps('i.user_id', '$3')}`,
      [verified.claims.inviteId, browserBindingOf(nonce), clientKey, OWNER_LOGIN_LINK_TTL_MS / 1000],
    );
    return { kind: 'accepted', nonce };
  });
}

// ---------------------------------------------------------------------------
// 조직 전환 · 새 조직 (확장성 P0 R-1)
// ---------------------------------------------------------------------------

interface SwitchedSession {
  readonly session: OwnerSession;
  readonly token: string;
  readonly csrf: string;
  /** 새 세션의 남은 수명(초) — 쿠키 Max-Age. 부모의 만료를 물려받는다. */
  readonly maxAgeSeconds: number;
  readonly organization: MembershipView;
}

/**
 * 부모 세션 → 대상 조직의 자식 세션(같은 트랜잭션): 자식 INSERT(만료 = 부모 만료, `switched_from_session_id`) → 부모 폐기 →
 * `last_organization_id`. 부모가 이미 죽었으면(경합) `null`. 같은 부모의 두 번째 자식은 UNIQUE 가 막는다(23505 → 409).
 * DB 가드(`owner_sessions_user_guard`)가 살아 있는 부모 · 같은 사용자 · 대상 조직의 살아 있는 멤버십 · 연장 없음을 한 번 더 본다.
 */
async function openChildSession(
  client: Queryable,
  parent: OwnerSession,
  organization: MembershipView,
): Promise<SwitchedSession | null> {
  // 호출자가 사용자 세션 잠금(`lockUserSessions`)을 이미 잡았다. 부모 행도 잠근다 — 다른 경로의 폐기와 자식 INSERT 가 엇갈리지 않게(M1).
  const live = await client.query(
    'SELECT 1 FROM owner_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE',
    [parent.id, parent.userId],
  );
  if (live.rowCount === 0) return null;
  const token = newSessionToken();
  const inserted = await client.query<{ id: string; remaining: number }>(
    `INSERT INTO owner_sessions (organization_id, user_id, switched_from_session_id, token_hash, expires_at)
     SELECT $1, s.user_id, s.id, $3, s.expires_at
       FROM owner_sessions s
      WHERE s.id = $2 AND s.user_id = $4 AND s.revoked_at IS NULL AND s.expires_at > now()
     RETURNING id, greatest(floor(extract(epoch FROM expires_at - now())), 0)::int AS remaining`,
    [organization.organizationId, parent.id, sha256Hex(token), parent.userId],
  );
  const child = inserted.rows[0];
  if (child === undefined) return null;
  await client.query('UPDATE owner_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [parent.id]);
  await client.query('UPDATE users SET last_organization_id = $2 WHERE id = $1', [parent.userId, organization.organizationId]);
  return {
    session: { id: child.id, organizationId: organization.organizationId, userId: parent.userId, role: organization.role },
    token,
    csrf: csrfTokenOf(token),
    maxAgeSeconds: child.remaining,
    organization,
  };
}

async function liveMembership(db: Queryable, userId: string, organizationId: string): Promise<MembershipView | null> {
  const result = await db.query<MembershipRow>(
    `SELECT m.organization_id, o.name, m.role, o.review_status::text AS review_status
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.organization_id = $2 AND m.removed_at IS NULL`,
    [userId, organizationId],
  );
  const row = result.rows[0];
  return row === undefined ? null : membershipViewOf(row);
}

export type SwitchOutcome =
  | { readonly kind: 'switched'; readonly switched: SwitchedSession }
  /** 이미 그 조직 — 아무것도 바꾸지 않는다(감사 없음). */
  | { readonly kind: 'same'; readonly organization: MembershipView }
  /** 부모 세션이 그 사이 죽었다(다른 탭의 전환·로그아웃). */
  | { readonly kind: 'session_gone' };

/**
 * `POST /api/session/org` — 멤버십이 없는 조직(다른 조직·없는 조직·모양 아님)은 모두 404 `organization_not_found`.
 * 감사 `session.switch` 는 **도착 조직**의 새 세션으로, 대상 없이(떠난 조직의 로그에 다른 조직 id 를 남기지 않는다).
 */
export async function switchOrganization(pool: Pool, session: OwnerSession, raw: unknown): Promise<SwitchOutcome> {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw notFound('조직이 없다.', 'organization_not_found');
  return withTransaction(pool, async (client): Promise<SwitchOutcome> => {
    const organization = await liveMembership(client, session.userId, raw);
    if (organization === null) throw notFound('조직이 없다.', 'organization_not_found');
    if (raw === session.organizationId) return { kind: 'same', organization };
    await lockUserSessions(client, session.userId);
    await limitSessionSwitches(client, session.userId);
    const switched = await openChildSession(client, session, organization);
    if (switched === null) return { kind: 'session_gone' };
    await recordOwnerAction(client, switched.session, 'session.switch', null);
    return { kind: 'switched', switched };
  });
}

/** `create_member_organization` 이 상한에 걸렸을 때의 SQLSTATE(메시지 `org_limit`). */
const ORG_LIMIT_SQLSTATE = 'AT429';
const INVALID_PARAMETER_SQLSTATE = '22023';

/**
 * `POST /api/organizations {name}` — 로그인한 사용자가 owner 인 새 조직(`active` Free — 202609301520)을 만들고 그 조직으로 전환한다(한 트랜잭션).
 * 이미 owner 인 active · 미동결 조직이 없으면 새 조직은 `pending_review`(202609301520 보안 검토). 감사 `org.create`(대상 = 새 조직 id)는 **새 조직**의 새 세션으로.
 * 상한(사용자 owner 5 · 하루 2 · 콘솔 새 조직 전역 하루 `member_org_daily_cap` · 거절·동결 조직의 owner) → 409 `org_limit`.
 */
export async function createMemberOrganization(pool: Pool, session: OwnerSession, raw: unknown): Promise<SwitchOutcome> {
  if (typeof raw !== 'string') throw new AdminInputError('name 은 문자열이다.', 'invalid_organization_name');
  const name = raw.trim();
  if (!isValidOrganizationName(name)) throw new AdminInputError(INVALID_ORGANIZATION_NAME_DETAIL, 'invalid_organization_name');
  try {
    return await withTransaction(pool, async (client): Promise<SwitchOutcome> => {
      // 잠금 순서: 사용자 세션 → (함수 안) 사용자 새 조직 → 전역 검토 대기 → 새 조직 멤버십. 속도 상한은 전환과 같은 원장(L6).
      await lockUserSessions(client, session.userId);
      await limitSessionSwitches(client, session.userId);
      const created = await client.query<{ id: string }>('SELECT create_member_organization($1::uuid, $2) AS id', [session.id, name]);
      const organizationId = created.rows[0]?.id;
      if (organizationId === undefined) throw new Error('create_member_organization 이 조직 id 를 돌려주지 않았다');
      const organization = await liveMembership(client, session.userId, organizationId);
      if (organization === null) throw new Error('새 조직에 owner 멤버십이 없다');
      const switched = await openChildSession(client, session, organization);
      if (switched === null) return { kind: 'session_gone' };
      await recordOwnerAction(client, switched.session, 'org.create', organizationId);
      return { kind: 'switched', switched };
    });
  } catch (error) {
    const state = sqlState(error);
    if (state.code === ORG_LIMIT_SQLSTATE && state.message === 'org_limit') {
      throw new AdminInputError('더 만들 수 없다 — 조직 수 상한(owner 5 · 하루 2 · 전역 하루)에 걸렸거나, 거절·정지된 조직의 소유자다.', 'org_limit', 409);
    }
    if (state.code === INVALID_PARAMETER_SQLSTATE || state.code === '23514') {
      throw new AdminInputError(INVALID_ORGANIZATION_NAME_DETAIL, 'invalid_organization_name');
    }
    if (state.code === '28000') return { kind: 'session_gone' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 셀프 가입 (`signup-contract.md` §0·§5)
// ---------------------------------------------------------------------------
//
// ## 가입 요청 (`POST /api/signup {email, organizationName, consent:true}` → 항상 202)
//
//   로그인 요청과 **같은 기법**이다(위 머리말). 모양 오류(이메일 모양 · 조직 이름 · 동의)만 400 — 모양은 입력한 쪽이 이미 아는
//   것이라 열거 신호가 아니다. 앱의 모양 검사는 DB CHECK 의 **상위 집합**이다(`isValidOrganizationName` — 검증 H3: 더 좁으면
//   새 주소만 CHECK 에 걸려 응답이 갈린다). 모양이 맞으면 입력 주소가 무엇이든(새 주소 · 이미 조직을 가진 소유자) **같은 문장이
//   같은 순서로** 돈다: 요청자 잠금 → 입력 주소 잠금 → 요청자 계수 → 원장 INSERT → 가입 링크 행 모양 탐침(세이브포인트 안
//   INSERT → 되돌림 — 실제 CHECK 를 두 갈래에 똑같이 대 본다, 걸리면 두 갈래 모두 같은 400 · 원장 행은 남는다) → 로그인 링크
//   `INSERT … SELECT` → 가입 링크 `INSERT … SELECT`. 둘 중 **어느 INSERT 가 행을 만드는지**는 데이터(`owner_email` 일치)가
//   정하고, 코드에는 갈림이 없다.
//     - 이미 살아 있는 멤버십을 가진 사용자 주소면 가입 메일 대신 **로그인 링크** 한 통이 적힌다(기존 `owner_login_links`
//       경로 — 로그인의 두 링크 상한도 같은 조건으로 붙는다). 중복 조직이 생기지 않는다 — 기존 사용자의 새 조직은 로그인 뒤 콘솔의
//       `새 조직 만들기`(창업자 결정 F-3, `createMemberOrganization`)로만.
//     - 아니면 — **초대 전용(202609301520)**: 그 주소의 초대가 살아 있으면(`waitlist_invite_live`) `signup_links` 에 한 행(조직은 아직 없다 —
//       verify 가 DB 함수로 만든다). 초대가 없으면 대기자 명단에 올린다(`waitlist_join` — 확인 메일은 주소당 30일 한 통, 202609301530). 세 번째 문장
//       (`SELECT waitlist_join(…) WHERE 같은 주소 상한`)도 **언제나** 돈다 — 멤버·초대·새 주소를 가르는 것은 정의 함수 안의 데이터다(열거 방지).
//   응답 쿠키도 언제나 같은 둘이다: 가입 논스 `__Host-atmark_signup`(30분)과 로그인 논스 `__Host-atmark_admin_login`(15분). 소유자
//   주소면 그 브라우저가 받은 로그인 링크를 여기서 바로 쓸 수 있어야 하고, 그 쿠키를 소유자일 때만 주면 응답이 갈린다.
//
//   **상한 셋:** ① 요청자(소스 IP 의 HMAC)당 시간당 5회 — 넘으면 429(주소와 무관, 로그인과 같다). ② 같은 주소 하루 두 층 —
//   (주소, 요청자) 3회 · 주소 10회(검증 M1: 주소 하나에 3이면 아무나 세 번으로 피해자를 하루 잠갔다). 넘으면 **조용히** 적지
//   않는다(두 INSERT 모두의 조건 · 응답은 같은 202). ③ 전역 시간당 가입 메일 상한은 메일러가 건다
//   (`SIGNUP_MAIL_GLOBAL_HOURLY_CAP`). 같은 주소 계수는 원장의 `email_hash`(요청자 키와 같은 HMAC 키) — 원장에 주소 평문이 없다.
//   요청자 → 주소 순서로 advisory 잠금을 걸고 센다(동시 30건 → 정확히 5건). 주소 잠금은 **로그인과 같은 키**
//   (`owner_login_email:`)라 로그인 요청과 가입 요청이 같은 조직의 링크 상한을 함께 셀 때도 줄을 선다.
//
// ## verify (`POST /api/signup/verify {code}`)
//
//   **가입 확인 링크는 없다(2026-10-10 — 로그인 링크와 같은 결정).** 옛 메일의 토큰(`{token}`)은 보지 않고 410 `signup_link_retired`.
//   논스 쿠키가 아예 없으면 코드·DB 를 보기 전에 `browser_missing`. 코드가 가입 행에 맞으면
//   DB 함수 `create_signup_organization(link, binding, now)` 한 번(SECURITY DEFINER — admin 롤은 organizations 에 INSERT 권한이
//   없다): 링크 잠금 · 만료 · 단일 사용 · 결속을 보고, 새 조직(살아 있는 초대가 있을 때만 · `active` Free — 202609301520)을 만들거나 그 주소가
//   이미 소유한 조직 id 를 돌려준다. NULL 이면 이유를 가리지 않고 거부(초대가 그 사이 끝났어도 같다). 그 뒤 **같은 트랜잭션**에서 세션 행(토큰 해시만 · 12시간 · `signup_link_id`)과
//   감사 행(`signup.verify`, 대상 = 조직 id)을 적는다 — 감사가 실패하면 조직도 링크 소비도 없다.
//
//   **코드(`{code}`).** 로그인 코드와 같은 규율(위 머리말 — 결속으로 후보를 행 잠금 · 상수 시간 비교 · 틀리면 후보 전부 +1 · 5회면 끝 ·
//   후보 0개여도 같은 문장). 다른 점 하나: 가입 요청은 주소가 이미 사용자면 가입 메일 대신 **로그인 메일**을 보낸다 — 가입 화면에
//   적는 코드가 어느 메일의 것인지 화면도 서버도 모른다(알면 열거다). 그래서 후보는 **두 벌**이다: 이 브라우저의 가입 결속에 묶인 가입
//   링크 + 로그인 결속에 묶인 로그인 링크(가입 응답이 두 논스를 함께 준다). 두 벌은 언제나 둘 다 잠그고(가입 → 로그인 순서), 틀리면 둘 다
//   센다. 가입 링크가 맞으면 위 가입 경로, 로그인 링크가 맞으면 로그인 경로(`openLoginSession`)로 세션을 연다.

export const SIGNUP_BROWSER_TTL_MS = SIGNUP_LINK_TTL_MS;
/** 조직 이름 길이(코드 포인트) — `signup_links.organization_name` CHECK 와 같다. */
export const SIGNUP_ORGANIZATION_NAME_MAX_LENGTH = 80;

const SIGNUP_BROWSER_CONTEXT = 'atmark.signup-browser.v1';
/** 조직 이름에 쓸 수 없는 문자 — 규칙과 근거는 `display.ts` `INVISIBLE_OR_CONTROL_CHARACTERS`(토큰 이름도 같은 집합을 쓴다). */
const ORGANIZATION_NAME_FORBIDDEN = INVISIBLE_OR_CONTROL_CHARACTERS;

/** 조직 이름 모양(앞뒤 공백을 걷어 낸 뒤): 1~80 코드 포인트 · 금지 문자 없음. 테스트가 전 코드 포인트에 대 본다. */
export function isValidOrganizationName(name: string): boolean {
  const length = [...name].length;
  return length >= 1 && length <= SIGNUP_ORGANIZATION_NAME_MAX_LENGTH && !ORGANIZATION_NAME_FORBIDDEN.test(name);
}

const INVALID_ORGANIZATION_NAME_DETAIL = `조직 이름은 1~${String(SIGNUP_ORGANIZATION_NAME_MAX_LENGTH)}자, 제어 문자·보이지 않는 문자 없이.`;
const INVALID_EMAIL_DETAIL = '이메일 주소 모양이 아니다.';

/** 가입 논스 → `signup_links.browser_binding`. 로그인 논스와 다른 문맥이다(서로의 링크에 통하지 않는다). */
function signupBindingOf(nonce: string): string {
  return sha256Hex(`${SIGNUP_BROWSER_CONTEXT}\n${nonce}`);
}

interface SignupRequestInput {
  readonly email: unknown;
  readonly organizationName: unknown;
  readonly consent: unknown;
  readonly sourceIp: string;
  /** 이 브라우저가 이미 가진 가입 논스(쿠키) — 있으면 재사용. */
  readonly signupNonce: string | undefined;
  /** 이 브라우저가 이미 가진 로그인 논스(쿠키) — 있으면 재사용(소유자 주소면 로그인 링크가 이 논스에 묶인다). */
  readonly loginNonce: string | undefined;
  /**
   * 가입 요청의 화면 언어(202609301510) — 환영 메일의 언어. 라우트가 정한다(본문 `lang` → 콘솔 언어 쿠키 → `Accept-Language`). 가입 링크 행에만
   * 적힌다(주소와 무관한 입력이라 열거와 무관하다 — 두 갈래의 문장은 같다).
   */
  readonly lang: 'ko' | 'en';
}

type SignupRequestOutcome =
  | { readonly kind: 'accepted'; readonly signupNonce: string; readonly loginNonce: string }
  | { readonly kind: 'rate_limited' };

/** 모양 검사 — 틀리면 400(`AdminInputError`). 모양은 입력한 쪽이 아는 것이라 주소의 존재와 무관하다. */
function signupShape(input: SignupRequestInput): { email: string; organizationName: string } {
  if (input.consent !== true) {
    throw new AdminInputError('이용약관과 개인정보 처리 안내에 동의해야 가입할 수 있다(consent:true).', 'consent_required');
  }
  if (typeof input.organizationName !== 'string') throw new AdminInputError('organizationName 은 문자열이다.', 'invalid_organization_name');
  const organizationName = input.organizationName.trim();
  if (!isValidOrganizationName(organizationName)) throw new AdminInputError(INVALID_ORGANIZATION_NAME_DETAIL, 'invalid_organization_name');
  if (typeof input.email !== 'string') throw new AdminInputError('email 은 문자열이다.', 'invalid_email');
  try {
    return { email: resolveOwnerEmail(input.email), organizationName };
  } catch (error) {
    if (error instanceof ProvisioningError) throw new AdminInputError(INVALID_EMAIL_DETAIL, 'invalid_email');
    throw error;
  }
}

/** 가입 링크 행 모양 탐침(`requestSignup` ★)이 DB 에서 거부됐다 — 트랜잭션 밖에서 400 으로 바꾼다(원장 행은 남긴 채). */
interface RowShapeRejection {
  readonly kind: 'row_shape';
  readonly field: 'email' | 'organization_name';
}

/** 가입 링크 행 모양 탐침이 걸린 SQLSTATE — 22xxx(데이터 예외) · 23xxx(무결성 제약 위반). */
function isRowShapeViolation(error: unknown): error is { code: string; constraint?: string } {
  const code = sqlStateOf(error);
  return code !== undefined && (code.startsWith('22') || code.startsWith('23'));
}

export async function requestSignup(pool: Pool, keyring: HmacKeyring, input: SignupRequestInput): Promise<SignupRequestOutcome> {
  const { email, organizationName } = signupShape(input);
  const clientKey = requesterKeyOf(keyring, input.sourceIp);
  const emailHash = signupEmailHashOf(keyring, email);
  const signupNonce = reuseNonce(input.signupNonce);
  const loginNonce = reuseNonce(input.loginNonce);

  const outcome = await withTransaction(pool, async (client): Promise<SignupRequestOutcome | RowShapeRejection> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup_client:' || $1::text, 0))`, [clientKey]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_email:' || $1::text, 0))`, [email]);
    const recent = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM signup_requests WHERE client_key = $1 AND created_at > now() - interval '1 hour'`,
      [clientKey],
    );
    if ((recent.rows[0]?.n ?? 0) >= SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR) return { kind: 'rate_limited' };
    await client.query('INSERT INTO signup_requests (client_key, email_hash) VALUES ($1, $2)', [clientKey, emailHash]);

    const linkValues = [email, organizationName, signupBindingOf(signupNonce), clientKey, SIGNUP_LINK_TTL_MS / 1000, input.lang === 'en' ? 'en' : 'ko'];
    // ★ 행 모양 탐침(검증 H3 의 두 번째 층) — **두 갈래 모두** 가입 링크 행 하나를 조건 없이 INSERT 해 보고 곧바로 되돌린다.
    //   아래 진짜 INSERT 는 새 주소일 때만 행을 만들므로, 그 행에만 걸리는 CHECK(조직 이름의 문자 집합 등)는 새 주소에서만
    //   평가된다 — 앱 검사가 DB 보다 좁으면 "새 주소 = 23514 → 500 · 소유자 = 0행 → 202" 로 갈린다. 탐침은 **테이블의 실제 CHECK**
    //   를 소유자 주소에도 똑같이 대 보게 해(문자 집합을 코드에 다시 적지 않는다 — 어긋날 사본이 없다), 어긋남이 생겨도 두 갈래가
    //   같은 400 이 되게 한다. 세이브포인트로 되돌리므로 탐침 행은 누구에게도 보이지 않고(메일러 포함) 원장 행은 남는다 —
    //   그래서 DB 만 거부하는 입력으로 캐는 것도 요청자 상한을 태운다. 문장·순서는 두 갈래가 같다.
    await client.query('SAVEPOINT signup_row_shape');
    try {
      await client.query(
        `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at, lang)
         VALUES ($1, $2, $3, $4, date_trunc('milliseconds', now() + make_interval(secs => $5)), date_trunc('milliseconds', now()), $6)`,
        linkValues,
      );
    } catch (error) {
      if (!isRowShapeViolation(error)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT signup_row_shape');
      return { kind: 'row_shape', field: error.constraint === 'signup_links_email_check' ? 'email' : 'organization_name' };
    }
    await client.query('ROLLBACK TO SAVEPOINT signup_row_shape');

    // ★ 두 INSERT 는 **언제나 둘 다** 돈다. 이미 소유자인 주소 → 첫 문장이 그 조직(들)의 로그인 링크를 적고 둘째는 0행.
    //   새 주소 → 첫 문장 0행, 둘째가 가입 링크 한 행. 같은 주소 하루 상한 **두 층**이 두 문장 모두의 조건이다(방금 적은 원장 행
    //   포함): (주소, 요청자) ≤ 3 · 주소 ≤ 10. 예전 상한은 주소 하나에 3이었고, 그러면 **아무나** 세 번 요청해 그 주소의 가입을
    //   하루 잠글 수 있었다(검증 M1). 이제 한 요청자는 자기 몫 3만 태운다 — 피해자의 브라우저(다른 요청자 키)는 영향이 없다.
    //   남는 틈: 서로 다른 소스 IP 4개 이상을 가진 공격자는 주소 상한 10을 채워 하루 잠글 수 있다(메일 폭탄 상한과의 교환 —
    //   로그인 M2 와 같은 모양).
    await client.query(
      `INSERT INTO owner_login_links (organization_id, user_id, browser_binding, client_key, expires_at, next_attempt_at)
       SELECT d.organization_id, u.id, $2, $3, date_trunc('milliseconds', now() + make_interval(secs => $4)), date_trunc('milliseconds', now())
         FROM users u
        CROSS JOIN LATERAL (${LOGIN_ORGANIZATION_OF_USER}) d
        WHERE u.email = $1
          AND ${userLinkCaps('u.id', '$3')}
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $5 AND r.client_key = $3 AND r.created_at > now() - interval '1 day') <= $6
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $5 AND r.created_at > now() - interval '1 day') <= $7`,
      [
        email,
        browserBindingOf(loginNonce),
        clientKey,
        OWNER_LOGIN_LINK_TTL_MS / 1000,
        emailHash,
        SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY,
        SIGNUP_REQUESTS_PER_EMAIL_PER_DAY,
      ],
    );
    await client.query(
      `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at, lang)
       SELECT $1, $2, $3, $4, date_trunc('milliseconds', now() + make_interval(secs => $5)), date_trunc('milliseconds', now()), $6
        WHERE NOT EXISTS (SELECT 1 FROM users u JOIN memberships m ON m.user_id = u.id AND m.removed_at IS NULL WHERE u.email = $1)
          AND waitlist_invite_live($1)
          AND (SELECT count(*) FROM signup_links s WHERE s.email = $1 AND s.created_at > now() - interval '1 day') < ${String(SIGNUP_LINKS_PER_EMAIL_PER_DAY)}
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $7 AND r.client_key = $4 AND r.created_at > now() - interval '1 day') <= $8
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $7 AND r.created_at > now() - interval '1 day') <= $9`,
      [...linkValues, emailHash, SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY, SIGNUP_REQUESTS_PER_EMAIL_PER_DAY],
    );
    // 초대 전용(202609301520) — 초대가 없는 새 주소는 대기자 명단으로(같은 주소 하루 상한 두 층이 조건). 멤버 · 살아 있는 초대면 정의 함수가 아무것도
    //   하지 않는다. 응답은 같은 202 — 초대받지 않은 사람에게는 가입 메일 대신 대기 확인 메일 한 통(24시간에 한 번)이 간다.
    await client.query(
      `SELECT waitlist_join($1, $2, NULL, 'signup')
        WHERE (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $3 AND r.client_key = $4 AND r.created_at > now() - interval '1 day') <= $5
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $3 AND r.created_at > now() - interval '1 day') <= $6`,
      [email, input.lang === 'en' ? 'en' : 'ko', emailHash, clientKey, SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY, SIGNUP_REQUESTS_PER_EMAIL_PER_DAY],
    );
    return { kind: 'accepted', signupNonce, loginNonce };
  });
  // 탐침이 걸린 요청: 원장 행은 커밋됐고(요청자 상한을 태운다) 링크는 어느 쪽에도 없다 — 앱 검사의 400 과 **같은 코드·같은 문구**.
  if (outcome.kind === 'row_shape') {
    throw outcome.field === 'email'
      ? new AdminInputError(INVALID_EMAIL_DETAIL, 'invalid_email')
      : new AdminInputError(INVALID_ORGANIZATION_NAME_DETAIL, 'invalid_organization_name');
  }
  return outcome;
}

type SignupVerifyOutcome =
  | {
      readonly kind: 'session';
      readonly session: OwnerSession;
      readonly token: string;
      readonly csrf: string;
      /** 가입 코드 화면에서 **로그인** 메일의 코드로 들어왔고 멤버십이 여럿이면 `select-org`. 가입은 언제나 `app`. */
      readonly next: 'app' | 'select-org';
    }
  | { readonly kind: 'browser_missing' }
  | { readonly kind: 'rejected' }
  /** 새 조직 상한(전역 검토 대기 수 · 요청자당 하루)에 걸렸다 — 링크는 소비되지 않았다(트랜잭션 전체가 되돌아갔다). */
  | { readonly kind: 'capacity' }
  /** 코드 verify 요청자 상한 — 주소와 무관하다(로그인과 같은 원장). */
  | { readonly kind: 'rate_limited' }
  /** 옛 메일의 가입 확인 링크 토큰(2026-10-10 링크 삭제) — 토큰을 보지 않는다. 가입 화면의 코드 칸을 안내한다. */
  | { readonly kind: 'link_retired' };

/**
 * `create_signup_organization` 이 새 조직 상한에 걸렸을 때 던지는 SQLSTATE(메시지 `signup_capacity`,
 * `202609240900_signup_security_hardening.sql` ④ — 검증 M2). 예외라서 링크 소비·세션·감사가 함께 되돌아간다.
 */
const SIGNUP_CAPACITY_SQLSTATE = 'AT429';

export async function verifySignup(
  pool: Pool,
  keyring: HmacKeyring,
  input: {
    /** 옛 메일 링크의 토큰 — 보지 않는다(있고 코드가 없으면 `link_retired`). */
    readonly token?: unknown;
    readonly code?: unknown;
    readonly browserNonce: string | undefined;
    /** 로그인 논스(쿠키) — 이미 사용자인 주소의 가입 요청은 로그인 메일을 보낸다(그 코드도 이 화면에서 받는다). */
    readonly loginNonce?: string | undefined;
    /** API Gateway 의 소스 IP — 코드 경로의 요청자 상한이 쓴다. 없으면 라우트가 먼저 503 으로 닫는다(`'unknown'` 한 버킷으로 모으지 않는다). */
    readonly sourceIp: string;
    readonly now: Date;
  },
): Promise<SignupVerifyOutcome> {
  if (input.code === undefined) return input.token === undefined ? { kind: 'rejected' } : { kind: 'link_retired' };
  if (input.browserNonce === undefined) return { kind: 'browser_missing' };
  if (!NONCE_PATTERN.test(input.browserNonce)) return { kind: 'rejected' };
  const binding = signupBindingOf(input.browserNonce);
  const code = input.token === undefined ? normalizeLoginCode(input.code) : null;
  if (code === null) return { kind: 'rejected' };
  const loginBinding = input.loginNonce !== undefined && NONCE_PATTERN.test(input.loginNonce) ? browserBindingOf(input.loginNonce) : null;

  try {
    return await verifySignupCode(pool, keyring, { code, binding, loginBinding, sourceIp: input.sourceIp, now: input.now });
  } catch (error) {
    // 상한은 링크가 유효하고 결속도 맞은 **뒤에만** 판정된다(함수 안 순서) — 링크를 가진 사람에게 "지금은 받을 수 없다" 를 말해도
    //   주소·링크에 대해 새는 것이 없다. 링크는 소비되지 않았으므로 상한이 풀리면 만료 전 같은 링크로 다시 된다.
    if (sqlStateOf(error) === SIGNUP_CAPACITY_SQLSTATE) return { kind: 'capacity' };
    // 가입 주소가 에이전트 주소(또는 에이전트 전용 도메인)다(ADR-0014 · 202609291110) — 조직·사용자·멤버십을 만들지 않고 거부.
    if (isMailIdentityConflict(error)) return { kind: 'rejected' };
    throw error;
  }
}

/**
 * 가입 코드 — 가입 결속의 가입 링크 + 로그인 결속의 로그인 링크를 **둘 다** 잠그고(가입 → 로그인 순서, 결속이 없어도 같은 문장) 맞춘다.
 * 틀리면 두 벌 모두 +1 하고 커밋한다. 가입 링크가 맞으면 가입 경로, 로그인 링크가 맞으면 로그인 경로.
 */
function verifySignupCode(
  pool: Pool,
  keyring: HmacKeyring,
  input: {
    readonly code: string;
    readonly binding: string;
    readonly loginBinding: string | null;
    readonly sourceIp: string;
    readonly now: Date;
  },
): Promise<SignupVerifyOutcome> {
  return withTransaction(pool, async (client): Promise<SignupVerifyOutcome> => {
    const clientKey = await codeFailureBudget(client, keyring, input.sourceIp);
    if (clientKey === null) return { kind: 'rate_limited' };
    // 가입 후보 — 로그인 후보와 같은 모양(주소마다 가장 최근의 살아 있는 링크 하나 · 보안 리뷰 L-1, 부분 색인 `signup_links_code_candidates_idx`).
    const signupRows = await client.query<{ id: string; expires_at: Date }>(
      `SELECT l.id, l.expires_at FROM signup_links l
        WHERE l.id IN (SELECT DISTINCT ON (c.email) c.id FROM signup_links c
                        WHERE c.browser_binding = $1 AND c.used_at IS NULL AND c.expires_at > now() AND c.status = 'sent' AND c.code_failures < $2
                        ORDER BY c.email, c.created_at DESC, c.id)
          AND l.used_at IS NULL AND l.expires_at > now() AND l.status = 'sent' AND l.code_failures < $2
        ORDER BY l.created_at DESC, l.id
        LIMIT $3
        FOR UPDATE OF l`,
      [input.binding, LOGIN_CODE_MAX_FAILURES, LOGIN_CODE_CANDIDATES],
    );
    const signupCandidates: LoginCodeLink[] = signupRows.rows.map((row) => ({ linkId: row.id, expiresAt: row.expires_at }));
    const loginCandidates = await lockLoginCodeCandidates(client, input.loginBinding);
    const signupMatch = signupCandidates[matchLoginCode(keyring, 'signup', signupCandidates, input.code)];
    const loginMatch = loginCandidates[matchLoginCode(keyring, 'owner_login', loginCandidates, input.code)];
    if (signupMatch !== undefined) return openSignupSession(client, signupMatch.linkId, input.binding, input.now);
    if (loginMatch !== undefined && input.loginBinding !== null) {
      const opened = await openLoginSession(client, loginMatch.linkId, await useLoginLinkByCode(client, loginMatch, input.loginBinding), input.now);
      return opened.kind === 'session' ? opened : { kind: 'rejected' };
    }
    // 틀린 코드(후보 0개 포함) — 두 벌 모두 센다(같은 두 문장). 거부를 반환해도 트랜잭션은 커밋된다.
    await client.query(
      'UPDATE signup_links SET code_failures = code_failures + 1 WHERE id = ANY($1::uuid[]) AND code_failures < $2',
      [signupCandidates.map((candidate) => candidate.linkId), LOGIN_CODE_MAX_FAILURES],
    );
    await countLoginCodeFailure(client, loginCandidates);
    await recordCodeFailure(client, clientKey);
    return { kind: 'rejected' };
  });
}

/**
 * 가입 행 → 조직(또는 그 주소의 기존 조직) + 세션(호출자의 트랜잭션 안). 사용자의 메일 언어가 아직 비어 있으면 가입 양식의 언어로 한 번 채운다
 * (202610101000 — 그 뒤로는 콘솔 설정만 바꾼다).
 */
async function openSignupSession(client: Queryable, linkId: string, binding: string, now: Date): Promise<SignupVerifyOutcome> {
  // 링크 잠금 · 만료 · 단일 사용 · 결속 · 틀린 코드 5회 미만 → 조직 생성(또는 그 주소의 기존 조직) — DB 함수 한 번. NULL 이면 이유를
  //   가리지 않는다. 새 조직 상한에 걸리면 함수가 `AT429` 를 던진다(위 `verifySignup` 이 409 로 바꾼다).
  const created = await client.query<{ organization_id: string | null }>(
    'SELECT create_signup_organization($1::uuid, $2, $3) AS organization_id',
    [linkId, binding, now],
  );
  const organizationId = created.rows[0]?.organization_id ?? null;
  if (organizationId === null) return { kind: 'rejected' };
  // 세션의 사용자 = 링크 주소의 사용자(그 조직의 owner 멤버십 — 새 조직이면 조직 INSERT 트리거가 방금 만들었다).
  const member = await client.query<{ user_id: string; role: MemberRole }>(
    `SELECT u.id AS user_id, m.role
       FROM signup_links l
       JOIN users u ON u.email = l.email
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 AND m.removed_at IS NULL
      WHERE l.id = $1`,
    [linkId, organizationId],
  );
  const membership = member.rows[0];
  if (membership === undefined) return { kind: 'rejected' };
  const token = newSessionToken();
  const session = await client.query<{ id: string }>(
    `INSERT INTO owner_sessions (organization_id, user_id, signup_link_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING id`,
    [organizationId, membership.user_id, linkId, sha256Hex(token), SESSION_TTL_MS / 1000],
  );
  const id = session.rows[0]?.id;
  if (id === undefined) throw new Error('owner_sessions INSERT 가 행을 돌려주지 않았다');
  const owner: OwnerSession = { id, organizationId, userId: membership.user_id, role: membership.role };
  await recordOwnerAction(client, owner, 'signup.verify', organizationId);
  await client.query('UPDATE users SET last_organization_id = $2 WHERE id = $1', [membership.user_id, organizationId]);
  await client.query(
    `UPDATE users SET mail_locale = (SELECT l.lang FROM signup_links l WHERE l.id = $2)
      WHERE id = $1 AND mail_locale IS NULL AND EXISTS (SELECT 1 FROM signup_links l WHERE l.id = $2 AND l.lang IS NOT NULL)`,
    [membership.user_id, linkId],
  );
  return { kind: 'session', session: owner, token, csrf: csrfTokenOf(token), next: 'app' };
}
