/**
 * 셀프 가입(A1 — DB·메일러·CLI) 통합 테스트의 공용 지반. 실제 Postgres 롤 넷:
 *   - 소유자 롤(`TEST_MIGRATION_DATABASE_URL`) — 지반(행 심기·검사)·운영자 CLI.
 *   - 앱 롤(`TEST_DATABASE_URL`) — 가입 표면 권한 0 을 확인한다.
 *   - `atmark_admin` · `atmark_login_mailer` — 앱 URL 의 사용자만 바꾼다(로컬 trust 인증, `test/integration/admin/support.ts` 와 같은 규칙).
 * **실메일은 나가지 않는다** — SES 호출면은 기록만 하는 가짜다.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import pg, { type Pool } from 'pg';

import { createPool } from '../../../src/db/client';
import type { SignupNotifierDependencies } from '../../../src/notify/signup-notifier';
import type { HmacKeyring } from '../../../src/security/hmac-keyring';
import { mintLoginCode } from '../../../src/security/login-code';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const APP_URL = process.env['TEST_DATABASE_URL'] ?? '';
export const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

export const ownerPool = (): Pool => createPool(OWNER_URL, { max: 4 });
export const appPool = (): Pool => createPool(APP_URL, { max: 2 });
export const adminPool = (): Pool => createPool(roleUrl(process.env['TEST_ADMIN_DATABASE_URL'], 'atmark_admin'), { max: 4 });
export const mailerPool = (): Pool => createPool(roleUrl(process.env['TEST_LOGIN_MAILER_DATABASE_URL'], 'atmark_login_mailer'), { max: 2 });

export const hex64 = (): string => randomBytes(32).toString('hex');
export const suffix = (): string => randomBytes(4).toString('hex');
export const uniqueEmail = (): string => `signup-${suffix()}@example.com`;
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** ms 로 자른 시각(`signup_links.expires_at` CHECK). */
export function msTrunc(at: Date): Date {
  return new Date(Math.floor(at.getTime()));
}

export interface SeededLink {
  readonly id: string;
  readonly email: string;
  readonly binding: string;
  readonly expiresAt: Date;
}

/**
 * 초대 전용 가입(202609301520) — 주소에 살아 있는 초대(대기자 명단 `invited` · 14일)를 소유자 롤로 심는다(초대 코어의 하루 상한·감사·메일 행을
 * 태우지 않는다). 이미 행이 있으면 초대 상태로 되돌린다. `create_signup_organization` 의 새 조직 갈래는 이것이 있어야 조직을 만든다.
 */
export async function seedLiveInvite(email: string): Promise<void> {
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    await client.query(
      // 등록 시각은 이틀 전 — 심은 항목이 새 대기 항목 하루 상한(`waitlist_daily_cap`)을 채우지 않게.
      `INSERT INTO waitlist_entries (email, lang, source, status, invited_at, invite_expires_at, invited_by, created_at)
       VALUES ($1, 'ko', 'site', 'invited', now(), now() + interval '14 days', 'test:seed', now() - interval '2 days')
       ON CONFLICT (email) DO UPDATE SET status = 'invited', invited_at = EXCLUDED.invited_at, invite_expires_at = EXCLUDED.invite_expires_at,
                                         invited_by = EXCLUDED.invited_by`,
      [email],
    );
  } finally {
    await client.end();
  }
}

/**
 * 살아 있는 초대가 있는 새 주소 `n` 개를 한 문장으로 심어 돌려준다(초대 전용 가입, 202609301520). 주소를 동기로 만드는 테스트(`newEmail()`)가
 * `beforeAll` 에서 한 번 받아 두고 하나씩 꺼내 쓴다.
 */
export async function seedInvitedEmails(n: number, prefix: string): Promise<string[]> {
  const emails = Array.from({ length: n }, () => `${prefix}-${randomBytes(6).toString('hex')}@example.com`);
  const client = new pg.Client({ connectionString: OWNER_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO waitlist_entries (email, lang, source, status, invited_at, invite_expires_at, invited_by, created_at)
       SELECT e, 'ko', 'site', 'invited', now(), now() + interval '14 days', 'test:seed', now() - interval '2 days' FROM unnest($1::text[]) AS e`,
      [emails],
    );
  } finally {
    await client.end();
  }
  return emails;
}

/**
 * **admin 롤로** 가입 링크 한 행 — 운영 admin 이 쓰는 여섯 칸 INSERT 그대로(`RETURNING id` — 결속은 읽지 못한다). 기본으로 그 주소의 살아 있는
 * 초대를 먼저 심는다(초대 전용 가입, 202609301520) — `invite: false` 면 심지 않는다(초대 없는 확정 = NULL 을 보는 테스트).
 */
export async function insertLinkAsAdmin(
  admin: Pool,
  options: {
    readonly email?: string;
    readonly organizationName?: string;
    readonly ttlMs?: number;
    readonly nextAttemptAt?: Date;
    readonly invite?: boolean;
  } = {},
): Promise<SeededLink> {
  const email = options.email ?? uniqueEmail();
  if (options.invite !== false) await seedLiveInvite(email);
  const binding = hex64();
  const expiresAt = msTrunc(new Date(Date.now() + (options.ttlMs ?? 25 * 60 * 1000)));
  const row = await admin.query<{ id: string }>(
    `INSERT INTO signup_links (email, organization_name, browser_binding, client_key, expires_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email, options.organizationName ?? `가입 조직 ${suffix()}`, binding, hex64(), expiresAt, options.nextAttemptAt ?? new Date()],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('signup_links INSERT 실패');
  return { id, email, binding, expiresAt };
}

export interface SentMail {
  readonly from: string | undefined;
  readonly to: readonly string[];
  readonly raw: string;
}

/** SES 호출면 가짜 — **기록만 한다.** */
export function fakeSes(): { readonly client: SignupNotifierDependencies['client']; readonly sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    client: {
      send(command) {
        const input = command.input;
        sent.push({
          from: input.FromEmailAddress,
          to: input.Destination?.ToAddresses ?? [],
          raw: Buffer.from(input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8'),
        });
        return Promise.resolve({ MessageId: `ses-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

/**
 * 메일 본문의 text/plain 파트(base64)를 푼다. 로그인·가입·초대·운영 코드 메일은 2026-09-28 부터 `multipart/alternative`(text/plain → text/html)
 * 이므로 첫 빈 줄 뒤가 곧 본문이 아니다 — text/plain 파트 머리를 찾아 그 파트의 몸만 푼다(단일 파트 메일에도 그대로 맞는다).
 */
export function mailText(mail: SentMail): string {
  const at = mail.raw.indexOf('Content-Type: text/plain; charset=UTF-8');
  if (at < 0) throw new Error('메일에 text/plain 파트가 없다');
  const body = (mail.raw.slice(at).split('\r\n\r\n')[1] ?? '').split('\r\n--')[0] ?? '';
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

/** SQLSTATE 만 꺼낸다(성공이면 'ok'). */
export async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? 'unknown');
  }
}

/**
 * 가입 확인 코드(2026-10-10 — 가입 확인 링크 삭제, 코드만). 메일러를 돌리지 않는 테스트용 — 가입 행을 소유자 롤로 **보낸(sent)** 상태로 표시하고
 * (코드 후보는 메일이 나간 행뿐이다 — `verifySignupCode`) 메일러와 같은 키 · 같은 문맥으로 코드를 파생한다. 이미 보낸 행은 그대로 둔다.
 */
export async function signupCodeOf(owner: Pool, keyring: HmacKeyring, link: { readonly id: string; readonly expires_at: Date }): Promise<string> {
  await owner.query(
    `UPDATE signup_links SET status = 'sent', sent_at = now(), ses_message_id = 'ses-test-' || id::text WHERE id = $1 AND status = 'pending'`,
    [link.id],
  );
  return mintLoginCode(keyring, 'signup', { linkId: link.id, expiresAt: link.expires_at });
}

/** 메일 본문(text/plain)의 6자리 코드 — 한 통에 한 번(링크 · 서명 토큰이 없다). */
export function codeOfMail(mail: SentMail): string {
  const text = mailText(mail);
  const codes = text.split('\n').filter((line) => /^[0-9]{6}$/.test(line));
  if (codes.length !== 1 || codes[0] === undefined) throw new Error(`메일에 코드가 한 번 있어야 한다:\n${text}`);
  if (/https?:\/\/|atk_(login|signup)_/.test(text)) throw new Error(`코드 메일에 링크 · 토큰이 있다:\n${text}`);
  return codes[0];
}
