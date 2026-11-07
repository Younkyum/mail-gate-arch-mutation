/**
 * src/watch/settings.ts — 감시 탭 **받기 설정의 계약**(ADR-0016 2026-10-08 개정 · 계획 `docs/internal/plans/watch-and-dev-surface.md` 묶음 A). 순수 · I/O 없음.
 *
 * 저장소는 마이그레이션 202610081000 의 세 표(`agent_watch_settings` · `org_watch_settings` · `org_trusted_senders`)다. 이 파일은 그 값의 모양 ·
 * 기본값 · 신뢰 발신자 일치 규칙만 갖는다 — 수신 소비자(`workers/inbound-consumer.ts`)와 콘솔 API(`admin/routes/watch.ts`)가 같은 규칙을 쓴다.
 *
 * | 설정 | 값 | 기본 | 뜻 |
 * |---|---|---|---|
 * | `riskHandling` | `deliver` · `hold` | `deliver` | 위험 등급 메일을 에이전트에게 바로 보이나(읽으면 발송은 소유자 승인 — 오염 T2) · 소유자가 풀 때까지 숨기나 |
 * | `riskNotify` | 불리언 | `true` | 위험 등급 메일이 오면 소유자에게 알림(격리 알림 기계 — 종류 `risk`). 차단 등급은 **항상** 알린다 |
 * | 신뢰 발신자 | 정확한 주소 · 정확한 도메인, 조직마다 200 | 없음 | DMARC 인증된 From 이 같으면 탐지 효과를 건너뛴다(스캐너는 돈다 · 기록은 남는다) |
 *
 * 기본값은 오늘 동작을 그대로 둔다(위험 알림만 새로 켜진다 — 진윤겸 결정). 설정은 **좁히기만** 한다(숨기기 · 알리기) — 신뢰 발신자만 예외이고,
 * 그것은 소유자가 명시적으로 고른 · DMARC 로 확인된 발신자에게만 선다(위조 From 은 일치하지 않는다).
 */

import type { RiskHandling, TrustedSenderKind } from '../db/schema';

const RISK_HANDLINGS: readonly RiskHandling[] = ['deliver', 'hold'];

/** 조직마다 살아 있는 신뢰 발신자 상한 — DB 트리거 `org_trusted_senders_limit` · 정의자 함수와 같은 값. */
export const MAX_TRUSTED_SENDERS = 200;

export interface AgentWatchSettings {
  readonly riskHandling: RiskHandling;
  readonly riskNotify: boolean;
}

/** 행이 없는 에이전트의 값 — 오늘 동작(위험은 전달) + 위험 알림 켬. */
export const DEFAULT_AGENT_WATCH_SETTINGS: AgentWatchSettings = { riskHandling: 'deliver', riskNotify: true };

export interface TrustedSender {
  readonly kind: TrustedSenderKind;
  /** 소문자. */
  readonly value: string;
}

/** 수신 소비자가 에이전트마다 읽는 것 — 에이전트 설정 + 그 조직의 살아 있는 신뢰 발신자. */
export interface InboundWatchContext {
  readonly settings: AgentWatchSettings;
  readonly trustedSenders: readonly TrustedSender[];
}

/** 도메인 모양(소문자 · IDN 은 xn--) — 가입 감지 목록 커서(`admin/ops/watch.ts`)도 쓴다. */
export const DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/**
 * 로컬파트 — RFC 5322 atext(소문자) + `.`, **`*` 빼고**(적대적 검증 U-005 · U-006 — `*@도메인` · `ce*@` 가 리터럴 주소로 저장돼 와일드카드처럼 읽혔다).
 * DB CHECK `org_trusted_senders_value_kind`(202610081004)와 같은 문자 집합.
 */
const LOCAL_SHAPE = /^[a-z0-9!#$%&'+/=?^_`{|}~.-]{1,64}$/;
/** 비교 전 From 의 모양 — 인쇄 가능한 ASCII 만(적대적 검증 U-080 · U-081: JS 소문자 접기가 켈빈 기호 U+212A 를 `k` 로 바꾼다). */
const ASCII_ADDRESS = /^[\x21-\x7e]+$/;

/**
 * 도메인 항목으로 받지 않는 공용 메일 도메인(적대적 검증 T1-S01 — `gmail.com` 을 넣으면 DMARC 통과한 gmail 계정 누구나 우회한다). 그 도메인의
 * **정확한 주소** 항목은 받는다. 완전하지 않다 — 흔한 것만(`gmx.*` 는 모든 최상위 도메인). `atmark.ai` 도 넣는다 — 이 플랫폼의 에이전트 누구나가 된다.
 */
export const TRUSTED_SENDER_FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'atmark.ai',
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'kakao.com',
  'nate.com',
  'qq.com',
  '163.com',
  'yandex.ru',
  'mail.ru',
]);

/** 도메인 항목으로 받지 않는 공용 메일 도메인인가(`gmx.<tld>` 포함). DB CHECK `org_trusted_senders_not_freemail` 과 같은 목록. */
export function isFreemailDomain(domain: string): boolean {
  return TRUSTED_SENDER_FREEMAIL_DOMAINS.has(domain) || /^gmx\.[a-z]{2,63}$/.test(domain);
}

/** ASCII · `@` 정확히 하나 · 소문자로 접은 주소의 (로컬, 도메인). 아니면 `null` — 일치 판정에 쓰지 않는다. */
function splitAsciiAddress(raw: string): { readonly address: string; readonly domain: string } | null {
  const trimmed = raw.trim();
  if (!ASCII_ADDRESS.test(trimmed)) return null;
  const at = trimmed.indexOf('@');
  if (at < 1 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return null;
  const address = trimmed.toLowerCase();
  return { address, domain: address.slice(at + 1) };
}

export function isRiskHandling(value: unknown): value is RiskHandling {
  return typeof value === 'string' && (RISK_HANDLINGS as readonly string[]).includes(value);
}

function isDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN_SHAPE.test(value);
}

/**
 * 콘솔이 넣은 한 줄 → 신뢰 발신자, 모양이 틀리면 `null`. `@` 가 있으면 주소, 없으면 도메인(정책 연락처 목록과 같은 규칙). 앞뒤 공백은 지우고 소문자로 접는다.
 * 와일드카드(`*.example.com`)는 받지 않는다 — 우회는 정확히 고른 상대에게만(하위 도메인은 따로 넣는다). DB CHECK `org_trusted_senders_value_kind` 와 같은 모양.
 */
export function parseTrustedSender(raw: string): TrustedSender | null {
  const trimmed = raw.trim();
  // 비 ASCII 는 받지 않는다(IDN 은 xn-- 로) — 접기 충돌(켈빈 기호)이 항목에도 생기지 않게.
  if (!ASCII_ADDRESS.test(trimmed)) return null;
  const value = trimmed.toLowerCase();
  if (value === '' || value.length > 320) return null;
  const at = value.lastIndexOf('@');
  if (at < 0) return isDomain(value) ? { kind: 'domain', value } : null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL_SHAPE.test(local) || local.includes('@') || !isDomain(domain)) return null;
  return { kind: 'address', value };
}

/**
 * 이 메일이 신뢰 발신자 우회를 받는가. **DMARC 인증된 From 만**(`fromAuthenticated` — DMARC pass + SES 가 본 From 도메인 = 우리가 뽑은 From 도메인,
 * `inbound/receipt.ts` `isFromAuthenticated`). 주소 항목은 From 주소와 정확히 같을 때, 도메인 항목은 From 도메인과 정확히 같을 때(하위 도메인 아님).
 *
 * 적대적 검증(2026-10-08) 반영:
 *   - `fromAddress` 는 **접기 전 원문**이다 — 인쇄 가능한 ASCII · `@` 정확히 하나가 아니면 일치하지 않는다(켈빈 기호 · 이중 `@`).
 *   - `Reply-To` 가 있고 그중 하나라도 도메인이 From 도메인과 다르면(또는 모양이 위와 같지 않으면) 일치하지 않는다 — 신뢰 발신자 계정이 탈취돼
 *     회신을 다른 곳으로 끌어가는 메일은 보통 메일처럼 검사한다.
 */
export function matchesTrustedSender(
  entries: readonly TrustedSender[],
  sender: { readonly fromAddress: string; readonly fromAuthenticated: boolean; readonly replyTo?: readonly string[] },
): boolean {
  if (!sender.fromAuthenticated || entries.length === 0) return false;
  const from = splitAsciiAddress(sender.fromAddress);
  if (from === null) return false;
  for (const reply of sender.replyTo ?? []) {
    const parsed = splitAsciiAddress(reply);
    if (parsed === null || parsed.domain !== from.domain) return false;
  }
  return entries.some((entry) => (entry.kind === 'address' ? entry.value === from.address : entry.value === from.domain));
}
