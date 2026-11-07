/**
 * src/notify/recipient-locale.ts — 조직 알림(승인 · 도메인 · 격리 · 위험 · 가입 감지 · 자가 등록)의 **받는 사람별 메일 언어**.
 *
 * 앱 롤은 `users` · `memberships` 권한이 0 이다 — 언어는 정의자 함수 `atmark_org_mail_locales(org, emails)`(202610101000)로만 묻는다. 그 함수는
 * 그 조직의 살아 있는 멤버이거나 주 소유자인 주소의 설정만 돌려준다(다른 주소는 아무것도 — 사용자 여부를 묻는 길이 되지 않는다).
 * 고른 언어가 없는 주소는 `DEFAULT_MAIL_LOCALE`('en'). 언어는 **보내는 순간** 고른다 — outbox 행에 저장하지 않는다(모아 둔 알림을 나중에 집어도
 * 그때의 설정으로 나간다).
 */

import type { Pool } from 'pg';

import { selectRows } from '../db/repositories/rows';
import { resolveMailLocale, type MailLocale } from '../i18n/locales';

/** 주소 → 언어. 입력에 있는 주소는 모두 결과에 있다(설정이 없으면 'en'). */
export async function recipientLocales(pool: Pool, organizationId: string, emails: readonly string[]): Promise<ReadonlyMap<string, MailLocale>> {
  const rows =
    emails.length === 0
      ? []
      : await selectRows<{ email: string; mail_locale: string | null }>(pool, 'SELECT email, mail_locale FROM atmark_org_mail_locales($1, $2::text[])', [
          organizationId,
          [...emails],
        ]);
  const chosen = new Map(rows.map((row) => [row.email, row.mail_locale]));
  return new Map(emails.map((email) => [email, resolveMailLocale(chosen.get(email))]));
}

/** 언어마다 한 번만 렌더한다(받는 사람이 20명이어도 언어 수만큼). */
export function renderPerLocale<T>(render: (locale: MailLocale) => T): (locale: MailLocale) => T {
  const cache = new Map<MailLocale, T>();
  return (locale) => {
    const hit = cache.get(locale);
    if (hit !== undefined) return hit;
    const rendered = render(locale);
    cache.set(locale, rendered);
    return rendered;
  };
}
