/**
 * src/admin/waitlist.ts — **대기자 명단 등록**(`POST /api/waitlist`, 202609301520). admin Lambda(DB 롤 `atmark_admin`)만 쓴다.
 *
 * 가입 요청(`session.ts` `requestSignup`)과 **같은 원장·같은 상한**을 쓴다(`signup_requests` — 요청자 키 · 주소 해시):
 *   ① 요청자(소스 IP 의 HMAC)당 시간당 5회(가입 요청과 합산) — 넘으면 429(주소와 무관).
 *   ② 같은 주소 하루 두 층 — (주소, 요청자) 3회 · 주소 10회. 넘으면 **조용히** 등록하지 않는다(응답은 같은 202).
 *   ③ 확인 메일은 주소당 30일에 한 통(정의 함수 `waitlist_join`, 202609301530) · 전역 시간당 상한은 메일러(`WAITLIST_CONFIRMATION_HOURLY_CAP`).
 * **열거 방지:** 모양이 맞으면 응답은 언제나 같은 202 `{ok:true}` 이고 문장도 같은 순서로 같다(요청자 잠금 → 주소 잠금 → 요청자 계수 → 원장 INSERT →
 * `SELECT waitlist_join(…) WHERE …`). 새 주소 · 이미 대기 중 · 초대받음 · 이미 가입한 사람을 가르는 것은 정의 함수 안의 데이터다.
 * **꿀단지(honeypot):** 폼의 숨은 칸(`website`)이 채워져 오면 사람이 아니다 — 원장·상한은 똑같이 태우고(같은 문장) 등록만 하지 않는다(같은 202).
 *
 * 모으는 것은 주소 · 한 줄 메모 · 신청서 답 셋(202609301530 — 용도 `use_case` 필수 · 알게 된 곳 `heard_from` 선택 · 유입 `ref`)이다(개인정보 처리
 * 안내). 메모는 1~200자 한 줄 · 제어·보이지 않는 문자 없음, 용도·알게 된 곳은 닫힌 값 — 어기면 400(입력한 쪽이 아는 모양). `ref` 는 400 이 없다:
 * 허용목록 밖(모양이 틀린 값 · 빈 값 포함)은 `none` 으로 적는다(`waitlistRefOf`). 셋 모두 응답을 바꾸지 않는다(같은 202).
 */

import type { Pool } from 'pg';

import { withTransaction } from '../db/client';
import { ProvisioningError, resolveOwnerEmail } from '../identity/provisioning';
import type { HmacKeyring } from '../security/hmac-keyring';
import {
  SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR,
  SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY,
  SIGNUP_REQUESTS_PER_EMAIL_PER_DAY,
} from '../security/login-limits';
import { INVISIBLE_OR_CONTROL_CHARACTERS } from './display';
import { AdminInputError } from './ops/errors';
import { requesterKeyOf, signupEmailHashOf } from './session';

/** 한 줄 메모 길이(코드 포인트) — `waitlist_entries.note` CHECK 와 같다. */
const WAITLIST_NOTE_MAX_LENGTH = 200;

/** 신청서의 용도(필수) — `waitlist_entries.use_case` CHECK 와 같은 값 · 화면 순서(반복 수신이 앞). */
export const WAITLIST_USE_CASES = ['alerts', 'replies', 'codes', 'outreach'] as const;
type WaitlistUseCase = (typeof WAITLIST_USE_CASES)[number];

/** "어디서 알게 되셨나요?"(선택) — `waitlist_entries.heard_from` CHECK 와 같은 값(계획서의 `source`). */
export const WAITLIST_HEARD_FROM = ['directory', 'github', 'reddit', 'x', 'search', 'friend', 'other'] as const;
type WaitlistHeardFrom = (typeof WAITLIST_HEARD_FROM)[number];

/** 유입 `ref` 허용목록 — 고정 값 넷 + `recipe-<슬러그>`. `waitlist_entries.ref` CHECK 와 같다. */
const WAITLIST_REFS = ['github', 'devto', 'referral', 'none'] as const;
const WAITLIST_RECIPE_REF = /^recipe-[a-z0-9-]{1,40}$/;

interface WaitlistRequestInput {
  readonly email: unknown;
  /** 선택 — "Atmark로 무엇을 하고 싶으세요?" 한 줄. */
  readonly note: unknown;
  /** 필수 — 용도 하나(`WAITLIST_USE_CASES`). */
  readonly useCase: unknown;
  /** 선택 — 알게 된 곳(`WAITLIST_HEARD_FROM`). 비면 NULL. */
  readonly heardFrom: unknown;
  /** `/waitlist?ref=` 값(화면 스크립트가 옮겨 싣는다). 허용목록 밖은 `none`. */
  readonly ref: unknown;
  /** 폼의 숨은 칸 값 — 비어 있어야 사람이다. */
  readonly honeypot: unknown;
  readonly sourceIp: string;
  /** 등록 화면의 언어 — 확인·초대 메일의 언어. 라우트가 정한다(본문 `lang` → 언어 쿠키 → Accept-Language). */
  readonly lang: 'ko' | 'en';
}

type WaitlistRequestOutcome = { readonly kind: 'accepted' } | { readonly kind: 'rate_limited' };

/** 메모 모양 — 비면 `null`. 앞뒤 공백을 걷어 낸 뒤 1~200자 · 제어·보이지 않는 문자 없음(DB CHECK 의 상위 집합). */
function waitlistNoteOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new AdminInputError('note 는 문자열이다.', 'invalid_note');
  const note = raw.trim();
  if (note === '') return null;
  if ([...note].length > WAITLIST_NOTE_MAX_LENGTH || INVISIBLE_OR_CONTROL_CHARACTERS.test(note)) {
    throw new AdminInputError(`메모는 한 줄, ${String(WAITLIST_NOTE_MAX_LENGTH)}자 이하로.`, 'invalid_note');
  }
  return note;
}

/** 용도 — 필수 · 닫힌 값. 없거나 목록 밖이면 400 `invalid_use_case`. */
export function waitlistUseCaseOf(raw: unknown): WaitlistUseCase {
  if (typeof raw === 'string' && (WAITLIST_USE_CASES as readonly string[]).includes(raw)) return raw as WaitlistUseCase;
  throw new AdminInputError(`use_case 는 ${WAITLIST_USE_CASES.join('|')} 중 하나다.`, 'invalid_use_case');
}

/** 알게 된 곳 — 선택. 비면(없음 · 빈 문자열) `null`, 목록 밖이면 400 `invalid_heard_from`. */
export function waitlistHeardFromOf(raw: unknown): WaitlistHeardFrom | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string' && (WAITLIST_HEARD_FROM as readonly string[]).includes(raw)) return raw as WaitlistHeardFrom;
  throw new AdminInputError(`heard_from 은 ${WAITLIST_HEARD_FROM.join('|')} 중 하나다.`, 'invalid_heard_from');
}

/** 유입 ref — 허용목록 값만 그대로(대소문자를 고치지 않는다), 그 밖은 전부 `none`. 400 이 없다(링크를 잘못 옮겨 적어도 등록은 된다). */
export function waitlistRefOf(raw: unknown): string {
  if (typeof raw !== 'string') return 'none';
  return (WAITLIST_REFS as readonly string[]).includes(raw) || WAITLIST_RECIPE_REF.test(raw) ? raw : 'none';
}

function waitlistEmailOf(raw: unknown): string {
  if (typeof raw !== 'string') throw new AdminInputError('email 은 문자열이다.', 'invalid_email');
  try {
    return resolveOwnerEmail(raw);
  } catch (error) {
    if (error instanceof ProvisioningError) throw new AdminInputError('이메일 주소 모양이 아니다.', 'invalid_email');
    throw error;
  }
}

export async function requestWaitlist(pool: Pool, keyring: HmacKeyring, input: WaitlistRequestInput): Promise<WaitlistRequestOutcome> {
  const email = waitlistEmailOf(input.email);
  const note = waitlistNoteOf(input.note);
  const useCase = waitlistUseCaseOf(input.useCase);
  const heardFrom = waitlistHeardFromOf(input.heardFrom);
  const ref = waitlistRefOf(input.ref);
  const human = input.honeypot === undefined || input.honeypot === null || input.honeypot === '';
  // 가입 요청과 **같은 키 문맥** — 두 경로가 한 원장에서 함께 센다.
  const clientKey = requesterKeyOf(keyring, input.sourceIp);
  const emailHash = signupEmailHashOf(keyring, email);

  return withTransaction(pool, async (client): Promise<WaitlistRequestOutcome> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('signup_client:' || $1::text, 0))`, [clientKey]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_login_email:' || $1::text, 0))`, [email]);
    const recent = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM signup_requests WHERE client_key = $1 AND created_at > now() - interval '1 hour'`,
      [clientKey],
    );
    if ((recent.rows[0]?.n ?? 0) >= SIGNUP_REQUESTS_PER_CLIENT_PER_HOUR) return { kind: 'rate_limited' };
    await client.query('INSERT INTO signup_requests (client_key, email_hash) VALUES ($1, $2)', [clientKey, emailHash]);
    // ★ 한 문장 — 등록 여부(새 주소 · 대기 중 · 초대 · 멤버)는 정의 함수 안에서, 같은 주소 상한 · 꿀단지는 이 문장의 조건에서 갈린다.
    await client.query(
      `SELECT waitlist_join($1, $2, $3, 'site', $9::text, $10::text, $11::text)
        WHERE $4::boolean
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $5 AND r.client_key = $6 AND r.created_at > now() - interval '1 day') <= $7
          AND (SELECT count(*) FROM signup_requests r
                WHERE r.email_hash = $5 AND r.created_at > now() - interval '1 day') <= $8`,
      [
        email,
        input.lang === 'en' ? 'en' : 'ko',
        note,
        human,
        emailHash,
        clientKey,
        SIGNUP_REQUESTS_PER_EMAIL_PER_CLIENT_PER_DAY,
        SIGNUP_REQUESTS_PER_EMAIL_PER_DAY,
        useCase,
        heardFrom,
        ref,
      ],
    );
    return { kind: 'accepted' };
  });
}
