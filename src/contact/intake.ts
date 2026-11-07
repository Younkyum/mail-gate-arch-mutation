/**
 * src/contact/intake.ts — **`support@atmark.ai` 문의의 입구** (US-009, ADR-0009). 수신 소비자(`workers/inbound-consumer.ts`)가
 * 에이전트 조회 **앞에서** 부른다.
 *
 * 이 파일은 **보내지 않는다.** 받아들일지 정하고, 받아들이면 ① 전달할 내용 문서를 S3 `contact/forward/{sesMessageId}.json` 에
 * 쓰고 ② outbox 행(`contact_forwards`) 하나를 적을 뿐이다. 보내는 것은 발송 역할 Lambda 의 시스템 메일 모듈
 * (`src/notify/contact-forwarder.ts`)이고, 수신자(운영자 주소)는 그 모듈만 읽는 비밀에 있다 — 이 파일도, 수신 Lambda 도 모른다.
 * 그래서 수신 Lambda(외부인의 MIME 을 파싱하는 곳)가 탈취돼도 SES 로 보낼 권한도, 전달 주소도 없다(Layer E·IAM).
 *
 * 받아들이는 조건(하나라도 어긋나면 `inbound_rejections(reason='contact_not_forwarded', detail=<코드>)`):
 *   - SES 스팸·바이러스 판정이 **정확히 PASS**(gray·processing_failed 도 아니다 — 운영자 메일함으로 옮기는 것이므로 좁게).
 *   - DMARC 가 fail 이 아니다(없음·gray 는 통과 — 개인 도메인은 DMARC 가 없는 경우가 흔하다).
 *   - 루프 방지: 봉투 발신자·헤더 From·SES 가 본 From 도메인 어느 것도 우리 도메인(`atmark.ai`·하위)이 아니다 · 자동 응답
 *     헤더(`Auto-Submitted`·`X-Autoreply`·`Precedence: bulk` 등)가 없다. 전달 주소 자신에서 온 메일은 전달 모듈이 거른다
 *     (주소를 아는 쪽이 그쪽뿐이다).
 *   - 원문 크기 ≤ `CONTACT_MAX_RAW_BYTES` · MIME 이 파싱된다 · From 이 헤더에 안전한 주소 하나다.
 *   - 시간당 상한: 차선별 `CONTACT_FORWARD_LANE_HOURLY_CAP`(support 30 · role 10 — `laneOf`) · 같은 발신자 `CONTACT_FORWARD_SENDER_HOURLY_CAP`
 *     (차선과 무관). 창은 SES 수신 시각.
 *
 * 멱등: SES 메시지 하나당 행 하나(`contact_forwards.ses_message_id` 유니크). 문서는 write-once(재전달은 같은 키를 다시 쓰고
 * `created: false`). 문서를 **먼저** 쓰고 행을 나중에 적는다 — 행이 있는데 문서가 없는 상태가 생기지 않는다.
 */

import { createHash } from 'node:crypto';

import type { InboundRejectionReason } from '../db/schema';
import { isReceiveOnlyAddress, RECEIVE_ONLY_ADDRESSES } from '../identity/address';
import { SES_MESSAGE_ID_PATTERN, type InboundReceipt } from '../inbound/receipt';
import { parseInboundMime, type ParsedInboundMessage } from '../mail/mime/parse';
import { log } from '../observability/logger';
import { countMetric, METRIC_NAMES } from '../observability/metrics';
import { ObjectTooLargeError } from '../storage/object-store';
import type { RawMailStore } from '../storage/raw-mail-store';

/** 문의 주소. 로컬파트 `support` 는 에이전트에게 발급할 수 없다(`src/identity/address.ts` 예약). 홈 `CONTACT_EMAIL` 과 같다. */
export const CONTACT_ADDRESS = 'support@atmark.ai';

/** 우리 도메인 — 이 도메인(과 하위)에서 온 메일은 전달하지 않는다(루프). */
const CONTACT_OWN_DOMAIN = 'atmark.ai';

/** 관측 축의 `route_id` — `SYSTEM_MAIL_ENTRYPOINTS` 의 `contact_forward` 와 같다. */
export const CONTACT_FORWARD_ROUTE_ID = 'contact_forward';

/**
 * 전달 상한의 **차선**(`contact_forwards.lane`, 202610021000). `support` = support@ 로만 온 문의 · `role` = 봉투 수신자 중 하나라도 수신 전용 역할
 * 주소(abuse@·postmaster@). 차선마다 상한을 따로 센다 — support@ 폭탄이 abuse@ 신고를 막지 못하고, 그 반대도 같다(2026-10-02, 안 A).
 */
export type ContactLane = 'support' | 'role';

/**
 * **차선별 시간당 상한 — support 30통 · role 10통.** 문의 창구 하나에 사람이 보내는 양으로는 넉넉하고, 폭탄(같은 주소 반복·주소 돌려 막기)이
 * 운영자 메일함과 `atmark.ai` 발신 평판(에이전트 전원의 도달률)을 잠식하는 양으로는 작다. 역할 주소는 신고·바운스 문의라 양이 적다(10).
 * 넘친 문의는 버리지 않는다 — 원문은 S3 에 있고 거부 행이 남는다(`rate_global` — 코드 이름은 알람 8·기존 거부 행과 맞추려고 그대로 둔다).
 * 전달 쪽(`src/notify/contact-forwarder.ts`)도 같은 값을 차선마다 센다.
 */
export const CONTACT_FORWARD_LANE_HOURLY_CAP: Readonly<Record<ContactLane, number>> = { support: 30, role: 10 };

/** **같은 발신자(헤더 From) 시간당 5통** — 차선과 무관하게 센다. 한 사람이 차선 상한을 혼자 다 쓰지 못하게. */
export const CONTACT_FORWARD_SENDER_HOURLY_CAP = 5;

/** 문의 원문 상한 10 MiB — 에이전트 수신(40 MiB)보다 좁다. 전달은 본문 텍스트만 싣고 첨부는 싣지 않는다. */
const CONTACT_MAX_RAW_BYTES = 10 * 1024 * 1024;

/** 전달 본문(텍스트)의 코드포인트 상한. 넘으면 자르고 표시한다. */
export const CONTACT_TEXT_MAX_CHARS = 50_000;

/** 전달 문서 접두사 — 이 접두사는 수신 역할 PutObject · 전달 Lambda GetObject 둘뿐이다(`compute-stack.ts`). */
export const CONTACT_DOCUMENT_PREFIX = 'contact/forward/';

/** 전달 문서의 모양 버전. */
export const CONTACT_DOCUMENT_VERSION = 1;

/** 거부 사유 코드(`inbound_rejections.detail`). 메일 내용 없음 — 코드뿐. */
export const CONTACT_REJECTION_CODES = [
  'virus_verdict',
  'spam_verdict',
  'dmarc_fail',
  'auto_submitted',
  'loop_own_domain',
  'invalid_from',
  'too_large',
  'mime_rejected',
  'rate_global',
  'rate_sender',
] as const;
export type ContactRejectionCode = (typeof CONTACT_REJECTION_CODES)[number];

/**
 * 전달 문서 — 전달 모듈이 읽는 **유일한 내용**. 원문 MIME 이 아니다: 전달 Lambda 는 외부인의 MIME 을 파싱하지 않고, 이 JSON 을
 * 모양 검사한 뒤 텍스트로만 조립한다(HTML·첨부 없음).
 */
export interface ContactForwardDocument {
  readonly version: typeof CONTACT_DOCUMENT_VERSION;
  readonly sesMessageId: string;
  /** SES 가 받은 시각(ISO). */
  readonly receivedAt: string;
  /** 헤더 From(원문 그대로 — 대소문자·+태그 보존). 전달 메일의 Reply-To 가 된다. */
  readonly fromAddress: string;
  readonly fromName: string | null;
  /** 헤더 To 주소들(최대 10). 표시용. */
  readonly to: readonly string[];
  /** 헤더 Date(ISO) — 없거나 깨졌으면 `null`. */
  readonly date: string | null;
  readonly subject: string | null;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly textSource: ParsedInboundMessage['textSource'];
  readonly attachmentCount: number;
  readonly dmarc: string;
}

/** 원문 저장소·outbox 의 포트. 운영 구현은 `contact-store.ts`. */
export interface ContactIntakePort {
  /** 이미 받아들인 SES 메시지인가(재전달 — S3 를 건드리지 않는다). */
  isAdmitted(sesMessageId: string): Promise<boolean>;
  /** 전달 문서를 write-once 로 쓴다. 이미 있으면 성공(`created: false`). */
  putDocument(sesMessageId: string, json: string): Promise<{ readonly key: string; readonly created: boolean }>;
  /** 상한을 세고 행을 적는다(한 트랜잭션·직렬화). */
  admit(input: ContactAdmission): Promise<ContactAdmitOutcome>;
}

export interface ContactAdmission {
  readonly sesMessageId: string;
  readonly senderHash: string;
  readonly receivedAt: Date;
  /** 이 문의의 차선 — 행에 적히고(불변), 차선 상한은 같은 차선 행만 센다. */
  readonly lane: ContactLane;
  readonly laneCap: number;
  readonly senderCap: number;
}

export type ContactAdmitOutcome = 'admitted' | 'duplicate' | 'rate_global' | 'rate_sender';

/** 수신 소비자가 넘기는 것. `reject` 는 소비자의 거부 기록(`inbound_rejections`)이다. */
export interface ContactIntakeContext {
  readonly contact: ContactIntakePort;
  readonly rawMail: RawMailStore;
  readonly reject: (reason: InboundRejectionReason, recipients: readonly string[], detail: string | null) => Promise<void>;
  readonly traceId: string | null;
}

export type ContactIntakeOutcome = 'stored' | 'duplicate' | 'rejected';

/**
 * 문의 경로를 타는 봉투 주소 — `support@` 와 **RFC 2142 역할 주소 `abuse@`·`postmaster@`**(202609301540, 수신 전용 — `RECEIVE_ONLY_ADDRESSES`).
 * 스팸 신고·차단 해제 협의·바운스 문의는 급하다 — support@ 와 **같은 라우팅**(`ATMARK_CONTACT_ROUTING`)을 따라 운영자 메일함 전달(intake)과 지원 에이전트
 * 수신함(운영자가 붙인 별칭 — deploy §33)으로 간다. 전달 문서·outbox 는 SES 메시지 하나당 하나다(여러 주소로 온 같은 메일도 한 통).
 */
export const CONTACT_RECIPIENT_ADDRESSES: readonly string[] = [CONTACT_ADDRESS, ...RECEIVE_ONLY_ADDRESSES];

/** 봉투 수신자 중 문의 주소인가(소문자 비교 — 봉투 주소는 `receipt.ts` 가 이미 소문자로 접었다). */
export function isContactRecipient(address: string): boolean {
  return CONTACT_RECIPIENT_ADDRESSES.includes(address.trim().toLowerCase());
}

/**
 * 차선 — 봉투 수신자(문의 주소로 걸러 소문자로 접은 것) 중 **하나라도** 수신 전용 역할 주소면 `role`, 아니면 `support`.
 * support@ 와 abuse@ 로 함께 온 메일도 `role` 이다(신고가 support@ 폭탄에 묻히지 않게 — 역할 차선 상한 10 이 그 대가를 막는다).
 */
export function laneOf(matched: readonly string[]): ContactLane {
  return matched.some(isReceiveOnlyAddress) ? 'role' : 'support';
}

/** 우리 도메인(또는 하위)의 주소·도메인인가. */
export function isOwnDomain(addressOrDomain: string): boolean {
  const lowered = addressOrDomain.trim().toLowerCase().replace(/\.$/, '');
  const domain = lowered.includes('@') ? lowered.slice(lowered.lastIndexOf('@') + 1) : lowered;
  return domain === CONTACT_OWN_DOMAIN || domain.endsWith(`.${CONTACT_OWN_DOMAIN}`);
}

/** 발신자별 상한의 축 — 소문자 주소의 sha256. 평문을 DB 에 두지 않는다. */
export function contactSenderHash(fromAddress: string): string {
  return createHash('sha256').update(fromAddress.trim().toLowerCase(), 'utf8').digest('hex');
}

/** RFC 5322 `atext`(ASCII) — 로컬파트 dot-atom 의 글자. 인용 문자열(`"…"`)·주석·공백은 없다. */
const DOT_ATOM_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** 도메인 — LDH 라벨 둘 이상(점 하나 이상), 라벨 63자 이하, 하이픈으로 시작·끝나지 않는다. 주소 리터럴(`[…]`)은 받지 않는다. */
const DOT_ATOM_DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Reply-To 로 그대로 내보낼 수 있는 주소인가 — **ASCII dot-atom 주소 하나**(`local@domain`): 로컬파트 64자 이하 · 전체 254자 이하 ·
 * 인용·주석·공백·꺾쇠·쉼표·제어문자 없음. 전달 모듈이 같은 검사를 한 번 더 한다(문서는 S3 를 거쳐 왔다).
 *
 * **`=?` 가 들어간 주소는 거부한다**(2026-09-24 검증 F4). `=`·`?` 는 atext 라 `=?utf-8?q?victim=40bank.example?=@attacker.example` 도
 * 문법상 dot-atom 이지만, 메일 클라이언트 다수가 헤더의 RFC 2047 encoded-word 를 주소 안에서도 풀어 `victim@bank.example` 처럼 보인다
 * — 회신이 공격자 도메인으로 가면서 화면은 다른 주소를 보인다. 정상 주소에 `=?`·`?=` 가 나올 일은 사실상 없다.
 */
export function isForwardableAddress(value: string): boolean {
  if (value.length < 3 || value.length > 254) return false;
  if (value.includes('=?') || value.includes('?=')) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && DOT_ATOM_LOCAL.test(local) && DOT_ATOM_DOMAIN.test(domain);
}

/** 받아들이기 전의 판정 — 원문을 읽지 않고 SES 알림만으로. 통과면 `null`. */
export function precheckContactReceipt(receipt: InboundReceipt): ContactRejectionCode | null {
  if (receipt.verdicts.virus !== 'pass') return 'virus_verdict';
  if (receipt.verdicts.spam !== 'pass') return 'spam_verdict';
  if (receipt.verdicts.dmarc === 'fail') return 'dmarc_fail';
  if (receipt.headers.autoSubmitted) return 'auto_submitted';
  if (receipt.envelopeSender !== null && isOwnDomain(receipt.envelopeSender)) return 'loop_own_domain';
  if (receipt.dmarcFromDomains.some(isOwnDomain)) return 'loop_own_domain';
  return null;
}

/** 파싱된 메일 → 전달 문서. 모든 칸에 상한. */
export function buildContactDocument(
  sesMessageId: string,
  receivedAt: Date,
  mail: ParsedInboundMessage,
  dmarc: string,
): ContactForwardDocument {
  // UTF-16 길이 ≥ 코드포인트 수 — 짧은 본문(대부분)은 코드포인트 배열을 만들지 않는다.
  const codepoints = mail.text.length > CONTACT_TEXT_MAX_CHARS ? [...mail.text] : [];
  const truncated = codepoints.length > CONTACT_TEXT_MAX_CHARS;
  const date = mail.date !== null && Number.isFinite(mail.date.getTime()) ? mail.date.toISOString() : null;
  return {
    version: CONTACT_DOCUMENT_VERSION,
    sesMessageId,
    receivedAt: receivedAt.toISOString(),
    fromAddress: mail.from.address,
    fromName: mail.from.name === null ? null : mail.from.name.slice(0, 200),
    to: mail.to.slice(0, 10).map((address) => address.address.slice(0, 254)),
    date,
    subject: mail.subject === null ? null : mail.subject.slice(0, 998),
    text: truncated ? codepoints.slice(0, CONTACT_TEXT_MAX_CHARS).join('') : mail.text,
    textTruncated: truncated,
    textSource: mail.textSource,
    attachmentCount: mail.attachments.length,
    dmarc,
  };
}

/**
 * 문의 한 통. **던지는 것은 S3·DB 일시 장애뿐이다**(소비자가 `failed` 로 재전달한다) — 입력 때문에는 값으로 끝난다.
 */
export async function intakeContactMail(
  context: ContactIntakeContext,
  receipt: InboundReceipt,
  rawKey: string,
): Promise<ContactIntakeOutcome> {
  const { sesMessageId } = receipt;
  if (!SES_MESSAGE_ID_PATTERN.test(sesMessageId)) throw new Error('SES 메시지 ID 모양이 아니다');
  // 거부 행의 수신자 — 이 메일이 실제로 온 문의 주소들. 소비자가 `isContactRecipient` 로 불렀으니 비지 않지만, 비면 support@.
  const matched = [
    ...new Set(receipt.envelopeRecipients.map((address) => address.trim().toLowerCase()).filter((address) => CONTACT_RECIPIENT_ADDRESSES.includes(address))),
  ];
  const recipients = matched.length === 0 ? [CONTACT_ADDRESS] : matched;
  const refuse = async (code: ContactRejectionCode): Promise<ContactIntakeOutcome> => {
    await context.reject('contact_not_forwarded', recipients, code);
    return 'rejected';
  };

  const early = precheckContactReceipt(receipt);
  if (early !== null) return refuse(early);

  if (await context.contact.isAdmitted(sesMessageId)) {
    log('debug', 'contact.intake', { route_id: CONTACT_FORWARD_ROUTE_ID, trace_id: context.traceId, ses_message_id: sesMessageId, outcome: 'duplicate' });
    return 'duplicate';
  }

  let raw: Uint8Array;
  try {
    raw = await context.rawMail.get(rawKey);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return refuse('too_large');
    throw error;
  }
  if (raw.byteLength > CONTACT_MAX_RAW_BYTES) return refuse('too_large');

  // 첨부 바이트는 어디에도 쓰지 않는다 — 전달은 텍스트뿐이고 원문은 SES 가 쓴 `inbound/raw/` 에 남는다.
  const parsed = await parseInboundMime(raw);
  if (parsed.kind === 'rejected') return refuse('mime_rejected');
  const mail = parsed.message;

  if (!isForwardableAddress(mail.from.address)) return refuse('invalid_from');
  if (isOwnDomain(mail.from.address)) return refuse('loop_own_domain');

  const document = buildContactDocument(sesMessageId, receipt.receivedAt, mail, receipt.verdicts.dmarc);
  await context.contact.putDocument(sesMessageId, JSON.stringify(document));

  const lane = laneOf(matched);
  const outcome = await context.contact.admit({
    sesMessageId,
    senderHash: contactSenderHash(mail.from.address),
    receivedAt: receipt.receivedAt,
    lane,
    laneCap: CONTACT_FORWARD_LANE_HOURLY_CAP[lane],
    senderCap: CONTACT_FORWARD_SENDER_HOURLY_CAP,
  });
  // 차선 상한은 알람 8 의 축이다(검증 F6) — 알람은 차원 없는 롤업(두 차선의 합)을 보고, `lane` 차원은 어느 차선이 찼는지 가른다.
  // 발신자 상한(`rate_sender`)은 한 사람의 반복이라 알람이 아니다(거부 행으로 남는다).
  if (outcome === 'rate_global') countMetric(METRIC_NAMES.contactRateGlobal, { route_id: CONTACT_FORWARD_ROUTE_ID, lane });
  if (outcome === 'rate_global' || outcome === 'rate_sender') return refuse(outcome);
  log(outcome === 'admitted' ? 'info' : 'debug', 'contact.intake', {
    route_id: CONTACT_FORWARD_ROUTE_ID,
    trace_id: context.traceId,
    ses_message_id: sesMessageId,
    lane,
    outcome,
  });
  return outcome === 'admitted' ? 'stored' : 'duplicate';
}
