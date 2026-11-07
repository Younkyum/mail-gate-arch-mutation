/**
 * `workers/inbound-consumer` — SES 수신 소비자 (계획 §6 P3a, AC-3·AC-4).
 *
 * **발송하지 않는다.** 관문을 import 하지 않으며 `NON_SENDING_ENTRYPOINTS` 에 등록돼 있다.
 *
 * 한 건의 흐름:
 *   SES receipt 알림(SNS→SQS) → `inbound/receipt.ts` 파싱 → **봉투 수신자로 에이전트 결정** →
 *   S3 원문(`RawMailStore`) → `parseInboundMime`(첨부 바이트는 싱크로 S3 `inbound/attachments/`) →
 *   파싱 결과 JSON 을 S3 `inbound/parsed/` → 에이전트마다 스레드 해석(`resolveThread` + `thread-store`) →
 *   메타만 Postgres(`inbound-store`).
 *
 * ---------------------------------------------------------------------------
 * ## 규율 — `ses-event-consumer.ts` 와 같은 셋
 * ---------------------------------------------------------------------------
 *
 * **① 멱등하다.** SNS/SQS 는 at-least-once 다. 같은 SES 메시지를 세 번 받아도 에이전트당 한 행이고,
 * 그 집행은 유니크 인덱스(`inbound_messages_agent_ses_message_key`)다. S3 쪽도 write-once 재시도를
 * 성공으로 본다(`storage/inbound-artifact-store.ts`).
 *
 * **② 입력 때문에는 던지지 않는다 — 결말로 기록한다.** 알림 파싱 실패는 `unparsable`, 파싱 거부·알 수
 * 없는 수신자·바이러스·과대 원문은 `inbound_rejections` 에 한 행을 남기고 `rejected`. 재전달해도 결과가
 * 같은 것을 재시도하면 poison pill 이다.
 *
 * **③ 일시 장애만 `failed` 다.** S3·DB 오류(원문 없음 포함 — SES 는 원문을 쓴 **뒤에** 알린다)만이
 * 재전달이 도움이 되는 실패다. 호출자(Lambda 배선)는 이것만 배치 실패로 돌려준다.
 *
 * **이 함수도 던지지 않는다.** 모든 경로가 값으로 끝난다.
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * - **바이러스(`virusVerdict = fail`)는 파싱하지 않는다 — 결말만 기록.** 첨부를 `inbound/attachments/` 로
 *   복사하는 순간 악성 바이트가 "에이전트가 읽을 수 있는 곳" 에 생긴다. 원문은 SES 가 이미 비공개 버킷에
 *   썼으므로 조사는 거기서 한다. `gray`·`processing_failed` 는 버리지 않는다(판정은 저장되고 P4 가 읽는다) —
 *   스캔 실패를 버림으로 읽으면 SES 쪽 장애가 곧 메일 유실이 된다.
 * - **스팸(`spamVerdict = fail`)은 저장한다.** 가입 확인 메일(AC-3)은 스팸 판정을 자주 받는다. 판정은 행에
 *   남고, 에이전트 컨텍스트에서 가릴지는 P4(quarantine)의 결정이다.
 * - **알 수 없는 수신자는 버리되 기록한다.** receipt rule 은 도메인 단위(M5 부터 recipients 없음 = verified 도메인 전부 — `atmark.ai` ·
 *   고객 도메인)라 없는 주소로도 온다. 받을 수 없는 고객 도메인 주소는 `domain_not_active`(아래 `consumeAgentRecipients`).
 *   SES 는 이미 수락했으므로 반송할 수 없다(반송은 백스캐터가 된다).
 * - **`fromAuthenticated` 는 DMARC 에서만 온다** (`receipt.ts` `isFromAuthenticated`, DB CHECK 가 한 번 더).
 *
 * ---------------------------------------------------------------------------
 * ## P4 — 저장 전에 스캔하고, 신뢰를 스탬프한다
 * ---------------------------------------------------------------------------
 *
 * - **스캔은 파싱 직후, 기록 전에 한 번**(내용은 에이전트마다 같다). `text` 와 `htmlText` 를 둘 다 넘긴다
 *   (p3-integration.md — plain 은 안내문, 코드는 HTML 에만 있는 메일). 판정·격리·스캐너 버전은 행에, 적중
 *   좌표는 `security_findings` 에(같은 트랜잭션). 매칭 원문은 어디에도 없다.
 * - ★ **스캐너가 던지면 격리 쪽으로 실패한다(fail-closed).** 스캔하지 못한 메일을 에이전트에게 보여주면
 *   "스캐너 장애 = injection 통과" 다. 그렇다고 `failed`(재전달)로 올리지도 않는다 — 같은 입력에 같은 예외면
 *   poison pill 이다. 판정 없음(`injection_risk` NULL) + 격리로 **기록하고**, `inbound.scan_failed` 를 남긴다.
 *   스캐너 결과의 모양이 DB 가 받을 수 없는 것이어도(모르는 위험도, 모양이 깨진 적중) 같은 길이다 — INSERT
 *   실패가 곧 무한 재전달이기 때문이다. DB 도 "판정 없음 ⇒ 격리" 를 CHECK 로 한 번 더 집행한다.
 * - **신뢰는 에이전트마다, 수신 시점 사실로.** `loadTrustSignals` → `computeTrust`. 포트는
 *   `trust-facts-store.ts`. 권한용 스레드만 넘긴다(표시용 아님). 정책 모양 오류(blocklist 가 배열이 아님)는
 *   `unknown` 으로 떨어뜨린다 — 에이전트 하나의 정책 오류가 그 에이전트의 수신 전체를 DLQ 로 보내지 않게.
 *   `unknown` 은 `>= seen` 을 요구하는 모든 전제에서 지는 값이다. DB 오류는 그대로 `failed`(재전달).
 *
 * ---------------------------------------------------------------------------
 * ## 정책 v2 — 수신 정책(에이전트마다, 기록 전에)
 * ---------------------------------------------------------------------------
 *
 * - 에이전트마다 현재 수신 정책(`inbound_mode` + 수신 목록)을 읽고 `evaluateInboundPolicy` 로 판정한다. 막히면 **그래도 기록한다** —
 *   격리(`quarantine_reason = 'policy_blocked'`) + 사유(`policy_reason`)로. 버리지 않는 이유: 소유자가 콘솔 로그에서 "무엇이 막혔나" 를
 *   봐야 목록을 고칠 수 있다(진윤겸 결정 ③ "격리 + 로그"). 반송하지 않는다(백스캐터).
 * - 판정 기준 주소는 `From` 이고, 허용의 근거는 **DMARC 인증된** `From` 뿐이다(`fromAuthenticated` — 스레드 해석과 같은 값).
 * - ★ 정책을 **읽을 수 없으면**(정책·버전 행 없음 — 데이터 문제) 격리로 끝낸다(`inbound_disabled`, `inbound.policy_unavailable` 로그).
 *   판정할 수 없는 메일을 에이전트에게 보이지 않는다 — 스캐너 예외와 같은 fail-closed. DB 오류는 그대로 `failed`(재전달).
 *
 * ---------------------------------------------------------------------------
 * ## 받기 등급 — 위험 · 차단(ADR-0016 2026-10-08, `security/levels.ts`)
 * ---------------------------------------------------------------------------
 *
 * - **모든 메일이 스캐너를 지난다.** 스캔은 에이전트 결정 · 정책 · 설정과 무관하게 메일마다 한 번, 기록 전에 돈다(위 P4). 신뢰 발신자 우회도 정책 차단도
 *   스캔을 건너뛰지 않는다 — 판정 · 적중은 늘 행에 남는다(arch `inbound-scan-always` · 통합 `watch-levels`).
 * - 에이전트마다 감시 설정(`watch-settings-store.ts` — 에이전트 설정 + 조직 신뢰 발신자)을 읽는다. DB 오류 · 에이전트 없음은 던진다(`failed` — 재전달):
 *   설정을 못 읽고 기본값(`deliver`)으로 넘기면 소유자가 고른 `hold` 가 깨진다.
 * - **신뢰 발신자 우회**: DMARC 인증된 From(`fromAuthenticated`)이 조직 목록의 정확한 주소 · 도메인과 같으면 스캐너 격리를 지우고 등급을 `none` 으로 둔다
 *   (`trusted_bypass = true`). 판정 없음(스캐너 오류)은 지우지 않는다(fail closed) · 정책 차단은 그대로다.
 * - **등급**은 `classifyInboundLevel` 하나로 정해 행에 남긴다(`watch_level`). 위험 등급이고 에이전트 설정이 `hold` 면 `risk_hold` 로 숨긴다(격리처럼 —
 *   웹훅 없음, 소유자가 콘솔에서 풀 때까지). 알림(차단 항상 · 위험은 설정)은 DB 트리거가 같은 트랜잭션에서 센다(`quarantine_notice_record`).
 *
 * ---------------------------------------------------------------------------
 * ## US-009 — `support@atmark.ai` 문의(에이전트 조회 **앞**)
 * ---------------------------------------------------------------------------
 *
 * - 봉투 수신자에 문의 주소가 있으면 그 몫은 `src/contact/intake.ts` 가 맡는다: 판정(스팸·바이러스 PASS · DMARC fail 아님 · 루프 ·
 *   크기 · 상한) → 전달 문서(S3 `contact/forward/`) → outbox 행(`contact_forwards`). 받아들이지 않으면 `inbound_rejections`
 *   (`contact_not_forwarded` + 사유 코드). 문의 주소는 에이전트 조회에 넘기지 않는다(`unknown_recipient` 로 두 번 적지 않는다).
 * - **이 워커는 여전히 보내지 않는다** — 전달은 발송 역할의 contact-forwarder Lambda 가 한다. 수신 역할은 SES 권한 0 이고, 전달
 *   주소(비밀)를 모른다. 이 파일은 시스템 메일 모듈·전송단을 import 하지 않는다(`test/arch/contact-forward.arch.test.ts`).
 * - 같은 메일이 에이전트 주소로도 왔으면 문의 몫을 먼저 처리하고 나머지는 평소대로 간다(결말은 둘 중 강한 쪽).
 * - **라우팅(2026-09-30, `src/contact/routing.ts`)** — `ATMARK_CONTACT_ROUTING` 이 `forward` 가 아니면 support@ 도 에이전트 수신자다(지원 에이전트 —
 *   조직 Chronostasis, 런북 deploy §29). `agent` 모드만 intake 를 건너뛴다. 기본은 `forward`(위 설명 그대로).
 * - **`abuse@`·`postmaster@atmark.ai`**(202609301540) 도 문의 주소다(`CONTACT_RECIPIENT_ADDRESSES`) — support@ 와 같은 라우팅. 에이전트 몫은 운영자가 지원
 *   에이전트에 붙인 수신 전용 별칭이 받는다(런북 deploy §33). 별칭이 없으면(§33 운영자 명령 전) 에이전트 몫만 `unknown_recipient` 다.
 *
 * ---------------------------------------------------------------------------
 * ## AI 의심 메일 감시(ADR-0017 초안 — **경고 전용 측정**, `src/inbound/ai-watch/`)
 * ---------------------------------------------------------------------------
 *
 * - 스캔·정책·신뢰가 정해진 **뒤에** 승격 규칙(`shouldEscalate`)을 본다 — 그 결과는 이 행의 격리·정책·신뢰·웹훅 발화 여부를 바꾸지 않는다. 바꾸는
 *   것은 둘뿐: 작업 행 연결 · 보이는 시각(`ai_hold_until`, 최대 30초)과 그에 맞춘 웹훅 시각. 위험 보류·오염 등급·관문으로 가는 길은 없다.
 * - 요청 큐 전송은 **커밋 뒤에**, 이 호출이 새로 만든 작업만(조직 × SES 메시지 하나). 실패하면 재시도 없이 fail-skip(`ai_watch_skip_job` —
 *   보류를 곧바로 푼다). 감시 쪽의 어떤 실패도 메일 기록을 막거나 재전달을 부르지 않는다(사실 조회 실패 = 승격 안 함).
 * - 인증 코드 메일도 같은 규칙을 탄다(감시는 한다). 기다리지 않는 것은 인증 코드 **조회 라우트**가 보류를 보지 않아서다(Q3) — 이 워커는 추출기를
 *   import 하지 않는다(`verification-boundary`).
 */

import { createHash } from 'node:crypto';

import type { InboundArtifactStore } from '../storage/inbound-artifact-store';
import { ObjectTooLargeError } from '../storage/object-store';
import type { RawMailStore } from '../storage/raw-mail-store';
import {
  quarantineOf,
  type AiWatchInboundPort,
  type InboundAiWatchPlan,
  type InboundAttachmentRecord,
  type InboundCopyFingerprints,
  type InboundMessageRecord,
  type InboundScanRecord,
  type InboundSenderTrustRecord,
  type InboundStore,
  type InboundThreadPlacement,
  type InboundWatchRecord,
} from '../db/repositories/inbound-store';
import type { InboundWatchPort } from '../db/repositories/watch-settings-store';
import type { AgentSignupPort } from '../db/repositories/agent-signup-store';
import { detectSignup } from '../mail/signup/classify';
import type { RuleFamily } from '../security/injection/rule-types';
import type { RealtimePusher } from '../realtime/push';
import { classifyInboundLevel } from '../security/levels';
import { matchesTrustedSender, type InboundWatchContext } from '../watch/settings';
import {
  isFromAuthenticated,
  parseInboundReceipt,
  type InboundReceipt,
} from '../inbound/receipt';
import type { InboundPolicyReason, InboundRejectionReason } from '../db/schema';
import { intakeContactMail, isContactRecipient, type ContactIntakePort } from '../contact/intake';
import { CONTACT_ROUTING_DEFAULT, routesContactToAgent, runsContactIntake, type ContactRouting } from '../contact/routing';
import { parseInboundMime, type ParsedInboundMessage } from '../mail/mime/parse';
import {
  normalizeMessageId,
  normalizeSubject,
  resolveThread,
  type ThreadLookupPort,
} from '../mail/thread/resolve';
import { log } from '../observability/logger';
import type { SecurityFindingRecord } from '../db/repositories/security-finding-store';
import { PolicyShapeError, PolicySourceUnavailableError } from '../policy/policy-loader';
import {
  INJECTION_SCANNER_VERSION,
  QUARANTINE_FROM,
  scanForInjection,
  type InjectionScanInput,
  type InjectionScanResult,
} from '../security/injection/scanner';
import { computeTrust } from '../security/sender-trust';
import { inboundShingles } from '../security/dlp/shingle';
import type { HmacKeyring } from '../security/hmac-keyring';
import { fold } from '../security/injection/normalize';
import { evaluateInboundPolicy, type InboundPolicyPort, type InboundSender } from '../policy/inbound-policy';
import { loadTrustSignals, type TrustFactsPort } from '../security/trust-signals';
import { AI_WATCH_INPUT_VERSION, serializeAiWatchRequest, type AiWatchMode } from '../inbound/ai-watch/contract';
import { buildAiWatchExcerpt } from '../inbound/ai-watch/excerpt';
import { shouldEscalate } from '../inbound/ai-watch/escalate';
import { countMetric, emitMetric, METRIC_NAMES } from '../observability/metrics';
import { AGENT_ADDRESS_DOMAIN } from '../identity/address';

/** 매니페스트의 `NON_SENDING_ENTRYPOINTS` 항목과 같은 값. 로그의 `route_id` 축이다. */
export const INBOUND_CONSUMER_ROUTE_ID = 'inbound_consumer';

/** 파싱 결과 JSON 의 모양 버전. 소비자(조회 API)가 모양을 바꿀 때 올린다. */
const INBOUND_PARSED_DOCUMENT_VERSION = 1;

/** DB 컬럼 상한(SMTP 한 줄) — `subject`·`content_id`. */
const MAX_HEADER_COLUMN = 998;
const MAX_FILENAME = 1000;
const MAX_CONTENT_TYPE = 255;

export interface InboundConsumerDependencies {
  readonly receipts: InboundStore;
  readonly threads: ThreadLookupPort;
  readonly rawMail: RawMailStore;
  readonly artifacts: InboundArtifactStore;
  /** P4 — Sender Trust 사실 포트(`trust-facts-store.ts`). */
  readonly trust: TrustFactsPort;
  /** 정책 v2 — 수신 정책 소스(`inbound-policy-store.ts`). **선택이 아니다** — 없으면 판정 없이 보이는 길이 생긴다. */
  readonly inboundPolicy: InboundPolicyPort;
  /**
   * 받기 등급 — 감시 탭 설정(`watch-settings-store.ts`: 에이전트의 위험 처리 · 조직 신뢰 발신자). **선택이 아니다** — 없으면 소유자가 고른 보류가
   * 조용히 꺼진다.
   */
  readonly watch: InboundWatchPort;
  /**
   * 바깥 가입 감지(ADR-0016 2026-10-08 — `mail/signup/classify.ts`). 기록된 · 보이는 메일만, 메일을 적은 **뒤**(정의자 — 도메인 · 종류뿐). 실패는 메일을 실패시키지
   * 않는다(정보용 — 경고 로그 한 줄).
   */
  readonly signups: AgentSignupPort;
  /** US-009 — 문의(`support@atmark.ai`) outbox·문서. **선택이 아니다** — 없으면 문의가 조용히 `unknown_recipient` 가 된다. */
  readonly contact: ContactIntakePort;
  /**
   * 문의 라우팅(`ATMARK_CONTACT_ROUTING` — `src/contact/routing.ts`). 생략하면 `forward`(지금 운영 — support@ 는 에이전트 조회에 넘기지 않는다).
   * 조립 루트(`composeInboundConsumer`)는 환경에서 읽어 늘 채운다.
   */
  readonly contactRouting?: ContactRouting;
  /** P4 — 스캐너. 생략하면 `scanForInjection`. 주입은 fail-closed 경로를 시험하기 위해서다. */
  readonly scanner?: (input: InjectionScanInput) => InjectionScanResult;
  /**
   * 발신 DLP 지문 키(ADR-0016 B — `atmark/dlp-keys`). 받은 메일의 복사 지문을 메일 행과 같은 트랜잭션에 적는다. **선택이 아니다** — 없으면 그 메일이
   * 발신 DLP 의 복사 판정에서 조용히 빠진다.
   */
  readonly dlpKeys: HmacKeyring;
  /**
   * AI 의심 메일 감시(ADR-0017 초안 · 경고 전용). 생략하면 꺼짐(`off`) — 조립 루트가 `ATMARK_AI_WATCH` 를 읽어 `off` 가 아닐 때만 채운다
   * (env 를 읽는 곳은 조립 루트 하나 — arch `ai-watch-boundary` ⑤).
   */
  readonly aiWatch?: InboundAiWatchDependencies;
  /**
   * 실시간 힌트(묶음 E — `realtime/push.ts`). 생략하면 밀지 않는다(실시간이 꺼진 배포 · 테스트). 커밋 뒤에만 부르고, 받을 대상(보이는 메일 · 그
   * 에이전트의 연결)은 DB 정의 함수가 정한다.
   */
  readonly realtime?: RealtimePusher;
}

export interface InboundAiWatchDependencies {
  readonly mode: Exclude<AiWatchMode, 'off'>;
  readonly store: AiWatchInboundPort;
  /** 요청 큐(`atmark-ai-watch-req`)에 본문 하나. URL 은 조립 루트가 묶었다. */
  readonly queue: { send(body: string): Promise<void> };
}

/**
 * 받은 메일 → 복사 지문(ADR-0016 B). 본문은 제목·text·html 변환 텍스트를 접은 보기 하나로 본다. 참여자 칸은 더 쓰지 않는다(리뷰 L3 — reply-all
 * 제외의 참여자는 발송 DLP 가 **우리가 그 스레드에 보낸 발신의 수신자 ∪ 인증된 수신 발신자**로 계산한다. 받은 메일의 To/Cc 는 참여자가 아니다).
 */
function copyFingerprintsOf(keyring: HmacKeyring, mail: ParsedInboundMessage): InboundCopyFingerprints | null {
  const text = [mail.subject ?? '', mail.text, mail.htmlText ?? ''].join('\n');
  const shingles = inboundShingles(keyring, fold(text).text);
  if (shingles.fingerprints.length === 0) return null;
  return { kid: shingles.kid, fingerprints: shingles.fingerprints, participants: [] };
}

/** 큐에서 꺼낸 한 건 — 본문 문자열 그대로. */
export interface InboundMailMessage {
  /** 큐가 부여한 식별자. 로그에만 쓴다(멱등성 판정은 SES 메시지 ID). */
  readonly receiptId: string | null;
  readonly body: string;
}

/** 한 건의 결말. **여섯의 운영적 의미가 전부 다르다.** */
export type InboundMailOutcome =
  /** 적어도 한 에이전트에 새로 기록했다. */
  | 'stored'
  /** 이미 전부 기록돼 있었다(재전달). 정상이다. */
  | 'duplicate'
  /** 수신 알림이 아니었다(SNS 구독 확인 등). */
  | 'ignored'
  /** 알림 자체를 파싱할 수 없었다. 재전달해도 같다 — DLQ 로 갈 건. */
  | 'unparsable'
  /** 저장하지 않기로 했고 그 결말을 `inbound_rejections` 에 남겼다. 재전달해도 같다. */
  | 'rejected'
  /** S3·DB 일시 장애. **이것만 재전달되어야 한다.** */
  | 'failed';

/** 파싱 결과 JSON(`inbound/parsed/{sesMessageId}.json`). **본문 텍스트는 Postgres 가 아니라 여기 있다.** */
interface InboundParsedDocument {
  readonly version: typeof INBOUND_PARSED_DOCUMENT_VERSION;
  readonly sesMessageId: string;
  readonly message: Omit<ParsedInboundMessage, 'date'> & { readonly date: string | null };
}

export async function consumeInboundMail(
  deps: InboundConsumerDependencies,
  message: InboundMailMessage,
): Promise<InboundMailOutcome> {
  const parsed = parseInboundReceipt(message.body);
  if (parsed.kind === 'unparsable') {
    log('error', 'inbound.unparsable', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      reason: 'unparsable',
      detail: parsed.detail,
    });
    return 'unparsable';
  }
  if (parsed.kind === 'ignored') {
    log('debug', 'inbound.ignored', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      reason: parsed.notificationType,
    });
    return 'ignored';
  }

  try {
    return await consumeReceipt(deps, parsed.receipt, message.receiptId);
  } catch (error) {
    // 여기까지 온 예외는 전부 S3·DB 다(입력 문제는 위에서 값으로 끝났다). 재전달 대상.
    log('error', 'inbound.failed', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: message.receiptId,
      ses_message_id: parsed.receipt.sesMessageId,
      reason: 'transient_failure',
      error_kind: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/** 배치 하나. 건마다 결과를 모은다(한 건의 실패가 나머지를 막지 않는다). */
export async function consumeInboundMailBatch(
  deps: InboundConsumerDependencies,
  messages: readonly InboundMailMessage[],
): Promise<readonly InboundMailOutcome[]> {
  const outcomes: InboundMailOutcome[] = [];
  for (const message of messages) outcomes.push(await consumeInboundMail(deps, message));
  return outcomes;
}

// ---------------------------------------------------------------------------
// 한 통
// ---------------------------------------------------------------------------

async function consumeReceipt(
  deps: InboundConsumerDependencies,
  receipt: InboundReceipt,
  traceId: string | null,
): Promise<InboundMailOutcome> {
  const { sesMessageId } = receipt;

  // 알림이 가리키는 객체는 SES 메시지 ID 에서 **우리가** 유도한 키여야 한다. 알림의 objectKey 를 그대로
  // 읽으면 입력의 출처가 "이 메일의 원문" 에서 "그 접두사의 아무 객체" 로 넓어진다.
  const rawKey = deps.rawMail.keyFor(sesMessageId);
  if (receipt.objectKey !== rawKey) {
    log('error', 'inbound.unparsable', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      ses_message_id: sesMessageId,
      reason: 'object_key_mismatch',
      detail: 'receipt.action.objectKey 가 inbound/raw/{mail.messageId} 가 아니다',
    });
    return 'unparsable';
  }

  const reject = async (
    reason: InboundRejectionReason,
    recipients: readonly string[],
    detail: string | null,
  ): Promise<void> => {
    const outcome = await deps.receipts.recordRejection({
      sesMessageId,
      reason,
      detail,
      envelopeRecipients: recipients,
      virusVerdict: receipt.verdicts.virus,
      spamVerdict: receipt.verdicts.spam,
      rawStorageKey: rawKey,
      receivedAt: receipt.receivedAt,
    });
    log('warn', 'inbound.rejected', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      ses_message_id: sesMessageId,
      reason,
      outcome,
      recipient_count: recipients.length,
      detail,
    });
    // 시끄러운 수신(알람 41) — 고객 도메인의 모르는 수신자 수. 플랫폼 도메인(`atmark.ai` · 하위)은 세지 않는다. 던지지 않는다(EMF 한 줄).
    if (reason === 'unknown_recipient' && outcome === 'recorded') {
      const custom = recipients.filter((address) => {
        const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
        return domain !== AGENT_ADDRESS_DOMAIN && !domain.endsWith(`.${AGENT_ADDRESS_DOMAIN}`);
      }).length;
      if (custom > 0) emitMetric(METRIC_NAMES.inboundUnknownCustomDomain, custom, 'Count');
    }
  };

  // --- 바이러스 — 파싱하지 않는다(머리말) ----------------------------------------
  if (receipt.verdicts.virus === 'fail') {
    await reject('virus', receipt.envelopeRecipients, null);
    return 'rejected';
  }

  // --- US-009 문의 — 라우팅(`ATMARK_CONTACT_ROUTING`)에 따라 intake 와 에이전트 몫을 가른다 --------------------
  //   `forward` — support@ 는 intake 만(에이전트 조회에 넘기지 않는다 — `unknown_recipient` 로 두 번 적지 않는다).
  //   `agent_and_forward`·`agent_and_notify` — intake(전달 outbox) **와** 에이전트 몫 둘 다. 전달이 전문인지 알림만인지는 전달 Lambda 가 같은 값으로 정한다.
  //   `agent` — 에이전트 몫만. 각 경로는 자기 규칙(intake 는 판정 PASS 요구 · 에이전트는 저장 후 격리)을 지키고, 멱등 키는 둘 다 SES 메시지 ID 다.
  const routing = deps.contactRouting ?? CONTACT_ROUTING_DEFAULT;
  const hasContact = receipt.envelopeRecipients.some(isContactRecipient);
  const agentRecipients = routesContactToAgent(routing)
    ? receipt.envelopeRecipients
    : receipt.envelopeRecipients.filter((address) => !isContactRecipient(address));
  if (hasContact && runsContactIntake(routing)) {
    const contactOutcome = await intakeContactMail({ contact: deps.contact, rawMail: deps.rawMail, reject, traceId }, receipt, rawKey);
    if (agentRecipients.length === 0) return contactOutcome;
    const agentOutcome = await consumeAgentRecipients(deps, receipt, traceId, rawKey, reject, agentRecipients);
    return strongerOutcome(contactOutcome, agentOutcome);
  }
  return consumeAgentRecipients(deps, receipt, traceId, rawKey, reject, agentRecipients);
}

/** 문의 몫과 에이전트 몫의 결말을 합친다 — 기록 > 재전달 > 거부. */
function strongerOutcome(a: InboundMailOutcome, b: InboundMailOutcome): InboundMailOutcome {
  const rank: Readonly<Record<InboundMailOutcome, number>> = { failed: 6, stored: 5, duplicate: 4, rejected: 3, ignored: 2, unparsable: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/** 에이전트 몫 — 봉투 수신자에서 문의 주소를 뺀 것(`envelopeRecipients`)만 본다. */
async function consumeAgentRecipients(
  deps: InboundConsumerDependencies,
  receipt: InboundReceipt,
  traceId: string | null,
  rawKey: string,
  reject: (reason: InboundRejectionReason, recipients: readonly string[], detail: string | null) => Promise<void>,
  envelopeRecipients: readonly string[],
): Promise<InboundMailOutcome> {
  const { sesMessageId } = receipt;

  // --- 에이전트 결정 — **봉투 수신자로만** -----------------------------------------
  const matches = await deps.receipts.findAgentsByAddresses(envelopeRecipients);
  const matchedAddresses = new Set(matches.map((match) => match.address));
  const unknownRecipients = envelopeRecipients.filter((address) => !matchedAddresses.has(address));
  // ★ 운영자 검토 전·거절 조직의 에이전트는 받지 않는다(보안 검증 M3). 셀프 가입 조직은 검토 전에도 에이전트를 만들 수 있다 —
  //   그 수신함이 열려 있으면 검토 없이 `atmark.ai` 주소로 가입 확인 메일·인증 코드를 받는 창구가 된다(발송은 Stage 0 이 막아도).
  //   원문을 읽기 **전에** 거른다: 파싱·첨부·본문 JSON 을 S3 에 만들지 않는다(다른 거부 결말과 같이 SES 가 쓴 원문만 남는다).
  const inactiveRecipients = [...new Set(matches.filter((match) => !match.organizationActive).map((match) => match.address))];
  // ★ 고객 도메인(ADR-0014 결정 6) — 같은 조직의 도메인이 받을 수 없는 상태(소유권 상실·DKIM 실패·제거·행 없음)면 같은 자리에서, 원문을 읽기
  //   **전에** `domain_not_active` 로 남긴다(S3 파생물 0). 조직 사유가 먼저다 — 검토 전 조직의 주소는 도메인과 무관하게 `org_not_active`.
  const domainInactiveRecipients = [
    ...new Set(matches.filter((match) => match.organizationActive && !match.domainActive).map((match) => match.address)),
  ];
  // 한 에이전트가 주소 둘로 같은 메일을 받으면 행은 하나다(유니크가 (agent_id, ses_message_id)).
  const agents = new Map<string, string>();
  const organizationOf = new Map<string, string>();
  for (const match of matches) {
    if (match.organizationActive && match.domainActive && !agents.has(match.agentId)) {
      agents.set(match.agentId, match.address);
      organizationOf.set(match.agentId, match.organizationId);
    }
  }

  if (inactiveRecipients.length > 0) await reject('org_not_active', inactiveRecipients, null);
  if (domainInactiveRecipients.length > 0) await reject('domain_not_active', domainInactiveRecipients, null);
  if (agents.size === 0) {
    if (unknownRecipients.length > 0) await reject('unknown_recipient', unknownRecipients, null);
    return 'rejected';
  }

  // --- 최적화: 전부 이미 기록됐으면 S3 를 건드리지 않는다(판정은 아래 INSERT 가 한다) ----------
  const already = await deps.receipts.existingAgentIds(sesMessageId);
  const pending = [...agents].filter(([agentId]) => !already.has(agentId));
  if (pending.length === 0) {
    log('debug', 'inbound.consumed', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      ses_message_id: sesMessageId,
      outcome: 'duplicate',
    });
    return 'duplicate';
  }

  // --- 원문 --------------------------------------------------------------------
  let raw: Uint8Array;
  try {
    raw = await deps.rawMail.get(rawKey);
  } catch (error) {
    // 상한 초과는 재시도해도 같다. 나머지(없음·네트워크)는 일시 장애로 올린다.
    if (error instanceof ObjectTooLargeError) {
      await reject('raw_too_large', envelopeRecipients, null);
      return 'rejected';
    }
    throw error;
  }

  // --- 파싱 — 첨부 바이트는 싱크로 S3 에, 체크섬은 여기 ---------------------------------
  const stored = new Map<number, { readonly key: string; readonly sha256: string }>();
  const result = await parseInboundMime(raw, {
    onAttachment: async (attachment, content) => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      const put = await deps.artifacts.putAttachment(sesMessageId, attachment.index, content);
      stored.set(attachment.index, { key: put.key, sha256 });
    },
  });
  if (result.kind === 'rejected') {
    // detail 은 싣지 않는다 — 파서의 detail 은 라이브러리 메시지를 포함할 수 있다. 사유 코드만.
    await reject('mime_rejected', envelopeRecipients, result.reason);
    return 'rejected';
  }
  const mail = result.message;

  // --- P4 스캔 — 기록 전에 한 번. 던지면 격리(fail-closed) ------------------------------
  const scan = scanInbound(deps.scanner ?? scanForInjection, mail);
  if (scan.kind === 'scanner_error') {
    log('error', 'inbound.scan_failed', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      ses_message_id: sesMessageId,
      reason: scan.reason,
      error_kind: scan.errorKind,
      outcome: 'quarantined',
      detail: scan.record.scannerVersion,
    });
  } else {
    log(scan.record.quarantined ? 'warn' : 'debug', 'inbound.scanned', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      ses_message_id: sesMessageId,
      verdict: scan.record.injectionRisk,
      outcome: scan.record.quarantined ? 'quarantined' : 'visible',
      detail: scan.record.scannerVersion,
    });
  }

  // --- 본문은 S3 JSON 으로 (PRD: Postgres 에는 키만) ------------------------------------
  const document: InboundParsedDocument = {
    version: INBOUND_PARSED_DOCUMENT_VERSION,
    sesMessageId,
    message: { ...mail, date: mail.date === null ? null : mail.date.toISOString() },
  };
  const parsedPut = await deps.artifacts.putParsed(sesMessageId, JSON.stringify(document));

  const fromAddress = mail.from.address.trim().toLowerCase();
  const fromAuthenticated = isFromAuthenticated(receipt, fromAddress);
  const attachments = attachmentRecords(mail, stored);
  const messageIdHeader = mail.messageId === null ? null : normalizeMessageId(mail.messageId);
  const inReplyTo = mail.inReplyTo === null ? null : normalizeMessageId(mail.inReplyTo);
  // `threads.subject_normalized` 도 998 상한이다(CHECK). 파서는 제목을 2000자까지 두므로 여기서 자르지 않으면
  // 누구나(인증 없이) 한 통으로 INSERT 를 죽인다 — 그리고 그 실패는 재전달해도 같다(poison pill).
  const subjectNormalized =
    mail.subject === null ? null : normalizeSubject(mail.subject).normalized.slice(0, MAX_HEADER_COLUMN) || null;
  const headerDate = storableDate(mail.date);
  // ADR-0016 B — 복사 지문은 메일마다 한 번(에이전트 수와 무관), 기록은 에이전트 행마다 같은 트랜잭션에서.
  const copyFingerprints = copyFingerprintsOf(deps.dlpKeys, mail);
  // AI 감시 — 발췌문은 메일마다 한 번(꺼져 있으면 만들지 않는다). 승격 사실은 조직마다 한 번(아래 `planAiWatch`).
  const aiWatch = deps.aiWatch === undefined ? null : aiWatchSession(deps.aiWatch, buildAiWatchExcerpt({ subject: mail.subject, text: mail.text }));
  // 바깥 가입 감지 — 메일마다 한 번(순수). 결과는 도메인 · 종류뿐이다.
  const signup = detectSignup({ fromAddress, fromAuthenticated, subject: mail.subject, text: mail.text });

  // --- 에이전트마다: 스레드 해석 → 기록 --------------------------------------------------
  let recorded = 0;
  // 실시간(묶음 E) — 새로 기록한 메일 id. 커밋 · AI 감시 flush 뒤에 한 번 민다(보이는지는 DB 가 정한다 — 격리 · 보류는 0행).
  const recordedIds: string[] = [];
  let unstorable = 0;
  // AI 감시 — 커밋된 새 작업은 **무슨 일이 있어도** 요청 큐로(보안 리뷰 L7): 뒤 에이전트의 일시 장애로 이 호출이 `failed` 가 돼도, 재전달은 이미 있는
  //   작업을 "새로 만든 것" 으로 보지 않으므로 여기서 보내지 않으면 그 작업은 영영 안 간다(30초 뒤 fail-skip). flush 는 던지지 않는다.
  try {
    for (const [agentId, envelopeRecipient] of pending) {
      const resolution = await resolveThread(
        {
          agentId,
          messageId: messageIdHeader,
          inReplyTo,
          references: mail.references,
          from: fromAddress,
          fromAuthenticated,
          subject: mail.subject,
        },
        deps.threads,
      );
      const thread: InboundThreadPlacement =
        resolution.authority.kind === 'existing'
          ? {
              kind: 'existing',
              threadId: resolution.authority.threadId,
              matchedBy: resolution.authority.matchedBy,
              matchedMessageId: resolution.authority.matchedMessageId,
            }
          : { kind: 'new', reason: resolution.authority.reason, subjectNormalized };

      const policyBlocked = await judgeInboundPolicy(
        deps.inboundPolicy,
        agentId,
        // 차단은 헤더 `From` 만이 아니라 봉투 발신자·SES 가 본 `From` 도메인까지(202609241040 — 검증 L2, `inbound-policy.ts`).
        {
          address: fromAddress,
          authenticated: fromAuthenticated,
          envelopeSender: receipt.envelopeSender,
          authenticatedDomains: receipt.dmarcFromDomains,
        },
        traceId,
        sesMessageId,
      );

      // 우회 판정은 **접기 전** From 원문과 Reply-To 로(적대적 검증 — 켈빈 기호 · 이중 @ · Reply-To 가 다른 도메인이면 우회 없음, `matchesTrustedSender`).
      const watch = watchRecordOf(scan.record, policyBlocked, await deps.watch.loadInboundWatch(agentId), {
        fromAddress: mail.from.address,
        fromAuthenticated,
        replyTo: mail.replyTo.map((reply) => reply.address),
      });
      const bypassedHigh = watch.trustedBypass && scan.record.kind === 'scanned' && scan.record.injectionRisk === 'high';
      if (bypassedHigh) countMetric(METRIC_NAMES.watchTrustedBypassHigh, { route_id: INBOUND_CONSUMER_ROUTE_ID });
      if (watch.trustedBypass || watch.riskHold) {
        log('info', 'inbound.watch', {
          route_id: INBOUND_CONSUMER_ROUTE_ID,
          trace_id: traceId,
          agent_id: agentId,
          ses_message_id: sesMessageId,
          verdict: watch.level,
          reason: bypassedHigh ? 'trusted_bypass_high' : watch.trustedBypass ? 'trusted_bypass' : 'risk_hold',
          outcome: watch.riskHold ? 'quarantined' : 'visible',
        });
      }

      const senderTrust = await stampTrust(deps.trust, {
        agentId,
        from: fromAddress,
        fromAuthenticated,
        authorityThreadId: resolution.authority.kind === 'existing' ? resolution.authority.threadId : null,
        now: receipt.receivedAt,
      }, traceId, sesMessageId);

      const record: InboundMessageRecord = {
        agentId,
        envelopeRecipient,
        sesMessageId,
        thread,
        displayThreadId: resolution.display?.threadId ?? null,
        messageIdHeader,
        inReplyTo,
        fromAddress,
        fromAuthenticated,
        subject: mail.subject === null ? null : mail.subject.slice(0, MAX_HEADER_COLUMN),
        headerDate,
        autoSubmitted: receipt.headers.autoSubmitted,
        envelopeSender: receipt.envelopeSender,
        forwardedForHeader: receipt.headers.forwardedFor,
        forwardedToHeader: receipt.headers.forwardedTo,
        verdicts: receipt.verdicts,
        headersTruncated: receipt.headers.truncated,
        rawStorageKey: rawKey,
        parsedStorageKey: parsedPut.key,
        textSource: mail.textSource,
        hasHtmlText: mail.htmlText !== null,
        attachments,
        receivedAt: receipt.receivedAt,
        scan: scan.record,
        senderTrust,
        policyBlocked,
        copyFingerprints,
        watch,
      };
      const quarantined = quarantineOf({ scan: scan.record, policyBlocked, watch }) !== null;
      const aiWatchPlan =
        aiWatch === null
          ? null
          : await aiWatch.plan(organizationOf.get(agentId) ?? null, {
              quarantined,
              injectionRisk: scan.record.kind === 'scanned' ? scan.record.injectionRisk : null,
              fromAuthenticated,
              senderTrust: senderTrust.category,
            }, traceId, sesMessageId);

      let outcome: Awaited<ReturnType<InboundStore['recordMessage']>>;
      try {
        outcome = await deps.receipts.recordMessage(aiWatchPlan === null ? record : { ...record, aiWatch: aiWatchPlan });
      } catch (error) {
        // ★ DB 가 **입력 때문에** 거부했다(CHECK·데이터 예외) — 재전달해도 같은 결과다(poison pill).
        //   소비자가 컬럼 상한을 전부 맞추지만(위 slice 들, `storableDate`), 그 맞춤이 DB 와 어긋나는 경우가 남는다:
        //   JS `toLowerCase` 와 DB `lower()` 가 로캘마다 다르게 접는 문자(V2 — U+038D, macOS), 파서가 모르는 제약.
        //   그 차이를 여기서 전부 예측하는 대신 **DB 의 판정을 입력 거부로 읽는다.** 일시 장애(연결·타임아웃·
        //   직렬화 실패·FK 경합)는 이 분류에 들지 않으므로 그대로 올라가 `failed` 가 된다.
        const rejection = inputRejectionOf(error);
        if (rejection === null) throw error;
        await reject('unstorable', [envelopeRecipient], rejection);
        unstorable += 1;
        continue;
      }
      if (outcome.kind === 'recorded') {
        recorded += 1;
        recordedIds.push(outcome.inboundMessageId);
        if (aiWatch !== null && outcome.aiWatchJob?.created === true) aiWatch.created(outcome.aiWatchJob);
        if (signup !== null && !quarantined) {
          await recordSignup(deps.signups, agentId, outcome.inboundMessageId, signup, traceId, sesMessageId);
        }
      }
      log(outcome.kind === 'recorded' ? 'info' : 'debug', 'inbound.consumed', {
        route_id: INBOUND_CONSUMER_ROUTE_ID,
        trace_id: traceId,
        agent_id: agentId,
        message_id: outcome.kind === 'recorded' ? outcome.inboundMessageId : null,
        ses_message_id: sesMessageId,
        outcome: outcome.kind,
        reason: resolution.authority.kind === 'existing' ? 'thread_existing' : `thread_new:${resolution.authority.reason}`,
        verdict: receipt.verdicts.dmarc,
      });
    }
  } finally {
    if (aiWatch !== null) await aiWatch.flush(traceId, sesMessageId);
  }
  // 실시간 힌트(묶음 E) — 행은 이미 커밋됐다(`recordMessage` 가 트랜잭션 하나). 던지지 않고 1초를 넘기지 않는다(`realtime/push.ts`).
  //   AI 감시 보류 중인 행은 여기서 0행이고 결과 λ 가 풀 때 민다 · 전송 실패로 바로 풀린 행(flush 의 skip)은 여기서 보인다.
  if (deps.realtime !== undefined && recordedIds.length > 0) await deps.realtime.messagesVisible(recordedIds);

  // 일부 수신자만 모르는 주소였다 — 받은 에이전트 몫은 기록했고, 나머지는 결말로 남긴다.
  if (unknownRecipients.length > 0) await reject('unknown_recipient', unknownRecipients, null);

  if (recorded > 0) return 'stored';
  return unstorable > 0 ? 'rejected' : 'duplicate';
}

/** 가입 감지 기록 — 실패는 삼킨다(메일은 이미 기록됐다 · 정보용). 로그에 도메인 · 제목은 없다(결과만). */
async function recordSignup(
  port: AgentSignupPort,
  agentId: string,
  inboundMessageId: string,
  signup: NonNullable<ReturnType<typeof detectSignup>>,
  traceId: string | null,
  sesMessageId: string,
): Promise<void> {
  try {
    const result = await port.recordSignup(agentId, inboundMessageId, signup);
    log('debug', 'inbound.signup', { route_id: INBOUND_CONSUMER_ROUTE_ID, trace_id: traceId, agent_id: agentId, ses_message_id: sesMessageId, outcome: result, reason: signup.kind });
  } catch (error) {
    log('warn', 'inbound.signup_failed', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      agent_id: agentId,
      ses_message_id: sesMessageId,
      error_kind: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Postgres `timestamptz` 가 받는 범위 밖의 날짜(파서는 JS `Date` 가 만드는 것은 다 준다)는 `null` 로. */
function storableDate(date: Date | null): Date | null {
  if (date === null) return null;
  const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 1 && year <= 9999 ? date : null;
}

/**
 * DB 오류가 **입력 때문**인가. SQLSTATE 로만 가린다 — 메시지 문장은 로캘·버전마다 다르다.
 *   - `22xxx` 데이터 예외(길이 초과·인코딩·날짜 범위)와 `23514` CHECK 만 입력 거부다.
 *   - `23502`(NOT NULL)은 넣지 않는다 — 소비자는 NOT NULL 컬럼을 입력과 무관하게 항상 채우므로, 그 위반은 코드·스키마
 *     불일치(버그)다. 입력 거부로 읽으면 배포 실수가 "조용한 거부" 가 되고, `failed` 로 두면 DLQ 에서 재처리할 수 있다.
 *   - `23505`(유니크)는 여기 오지 않는다(저장소가 `duplicate` 로 바꾼다). `23503`(FK)은 입력이 아니라 경합·버그다.
 * 돌려주는 값은 `inbound_rejections.detail` 에 들어간다 — **제약 이름과 코드뿐**(메일 내용 없음, 200자 CHECK).
 */
function inputRejectionOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  if (!(code.startsWith('22') || code === '23514')) return null;
  const name = typeof constraint === 'string' && /^[a-z0-9_]{1,63}$/.test(constraint) ? constraint : null;
  return name === null ? `sqlstate:${code}` : `sqlstate:${code} constraint:${name}`;
}

function attachmentRecords(
  mail: ParsedInboundMessage,
  stored: ReadonlyMap<number, { readonly key: string; readonly sha256: string }>,
): InboundAttachmentRecord[] {
  return mail.attachments.map((attachment) => {
    const put = stored.get(attachment.index);
    // 싱크가 모든 첨부에 불렸다(파서 계약). 없으면 파서 계약이 깨진 것이다 — 조용히 키 없는 행을 만들지 않는다.
    if (put === undefined) throw new Error(`첨부 ${String(attachment.index)} 의 저장 기록이 없다`);
    return {
      partIndex: attachment.index,
      filename: attachment.filename === null ? null : attachment.filename.slice(0, MAX_FILENAME),
      contentType: (attachment.contentType.trim() || 'application/octet-stream').slice(0, MAX_CONTENT_TYPE),
      disposition: attachment.disposition,
      sizeBytes: attachment.size,
      contentId: attachment.contentId === null ? null : attachment.contentId.slice(0, MAX_HEADER_COLUMN),
      storageKey: put.key,
      sha256: put.sha256,
    };
  });
}

// ---------------------------------------------------------------------------
// P4 — 스캔 · 신뢰
// ---------------------------------------------------------------------------

const RISK_RANK: Readonly<Record<string, number>> = { none: 0, low: 1, medium: 2, high: 3 };

/** DB CHECK 와 같은 모양(`security_findings`). 어긋나면 INSERT 가 죽고 그것은 무한 재전달이다. */
const RULE_ID_SHAPE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
const TOKEN_SHAPE = /^[a-z0-9_]{1,64}$/;
const VERSION_SHAPE = /^[^\s\p{Cc}]{1,200}$/u;

type ScanOutcome =
  | { readonly kind: 'scanned'; readonly record: Extract<InboundScanRecord, { kind: 'scanned' }> }
  | {
      readonly kind: 'scanner_error';
      readonly record: Extract<InboundScanRecord, { kind: 'scanner_error' }>;
      readonly reason: 'scanner_threw' | 'scanner_result_malformed';
      readonly errorKind: string | null;
    };

function scanInbound(
  scanner: (input: InjectionScanInput) => InjectionScanResult,
  mail: ParsedInboundMessage,
): ScanOutcome {
  const failed = (reason: 'scanner_threw' | 'scanner_result_malformed', errorKind: string | null): ScanOutcome => ({
    kind: 'scanner_error',
    record: { kind: 'scanner_error', scannerVersion: INJECTION_SCANNER_VERSION },
    reason,
    errorKind,
  });

  let result: InjectionScanResult;
  try {
    result = scanner({
      subject: mail.subject,
      text: mail.text,
      htmlText: mail.htmlText,
      attachmentNames: mail.attachments.map((attachment) => attachment.filename),
      // HTML 에서 숨긴 글(숨김 신호). 보이는 글이 아니라 "숨겼다" 는 사실을 스캐너에 넘긴다 — AI-watch 발췌는 보이는 `text` 만 쓴다.
      hiddenText: mail.hiddenText,
      // 파서가 **지운** C1 의 흔적(CP949 파서 차이 공격). 넘기지 않으면 운영 경로에서 C1 룰이 죽는다 —
      // 지워진 뒤의 text 에는 C1 이 없으므로 스캐너가 스스로 볼 방법이 없다.
      c1Removed: mail.c1Removed,
    });
  } catch (error) {
    return failed('scanner_threw', error instanceof Error ? error.name : typeof error);
  }

  // 결과의 **모양**을 타입이 아니라 값으로 확인한다(V3 M1). 타입은 스캐너가 약속한 것이지 돌려준 것이 아니다 —
  // `quarantine: 'false'`(문자열)는 `||` 를 문자열로 통과시켜 pg 가 false 로 쓰고, `'constructor'` 는 프로토타입
  // 키라 표 조회가 숫자 대신 함수를 준다. 틀린 모양은 **전부** "판정 없음 + 격리" 다(재전달하지 않는다 — 같은
  // 입력에 같은 결과면 poison pill). 읽는 도중 던져도(게터) 같은 길이다.
  try {
    const validated = validateScanResult(result);
    if (validated === null) return failed('scanner_result_malformed', null);
    return { kind: 'scanned', record: validated };
  } catch {
    return failed('scanner_result_malformed', null);
  }
}

function validateScanResult(result: unknown): Extract<InboundScanRecord, { kind: 'scanned' }> | null {
  if (typeof result !== 'object' || result === null) return null;
  const { injectionRisk, scannerVersion, quarantine, findings: rawFindings } = result as Record<string, unknown>;
  if (typeof injectionRisk !== 'string' || !Object.hasOwn(RISK_RANK, injectionRisk)) return null;
  const rank = RISK_RANK[injectionRisk];
  if (typeof rank !== 'number') return null;
  if (typeof scannerVersion !== 'string' || !VERSION_SHAPE.test(scannerVersion)) return null;
  if (typeof quarantine !== 'boolean') return null;
  if (!Array.isArray(rawFindings)) return null;

  const findings: SecurityFindingRecord[] = [];
  for (const raw of rawFindings as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { ruleId, family, field, view, fieldIndex, start, end, weight, damped } = raw as Record<string, unknown>;
    const ok =
      typeof ruleId === 'string' && RULE_ID_SHAPE.test(ruleId) &&
      typeof family === 'string' && TOKEN_SHAPE.test(family) &&
      typeof field === 'string' && TOKEN_SHAPE.test(field) &&
      typeof view === 'string' && TOKEN_SHAPE.test(view) &&
      typeof fieldIndex === 'number' && Number.isInteger(fieldIndex) && fieldIndex >= 0 &&
      typeof start === 'number' && Number.isInteger(start) && start >= 0 &&
      typeof end === 'number' && Number.isInteger(end) && end >= start &&
      typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 &&
      typeof damped === 'boolean';
    if (!ok) return null;
    // **이름 붙인 필드만** 옮긴다 — 스캐너 결과 타입에 무엇이 늘든 DB 로 가는 것은 이 아홉뿐이다.
    findings.push({ ruleId, family, field, fieldIndex, view, start, end, weight, damped });
  }

  return {
    kind: 'scanned',
    scannerVersion,
    injectionRisk: injectionRisk as InjectionScanResult['injectionRisk'],
    // 스캐너의 결정에 임계를 한 번 더 겹친다 — 둘 중 하나라도 격리면 격리.
    quarantined: quarantine === true || rank >= (RISK_RANK[QUARANTINE_FROM] ?? 0),
    findings,
  };
}

/**
 * 수신 정책 판정 → 막혔으면 사유, 보여도 되면 `null`. 정책을 읽을 수 없거나(행 없음) 모양이 틀리면 **격리**(`inbound_disabled`) —
 * 머리말의 fail-closed. DB 일시 장애는 그대로 던진다(`failed` → 재전달).
 */
async function judgeInboundPolicy(
  port: InboundPolicyPort,
  agentId: string,
  sender: InboundSender,
  traceId: string | null,
  sesMessageId: string,
): Promise<InboundPolicyReason | null> {
  let verdict: ReturnType<typeof evaluateInboundPolicy>;
  try {
    verdict = evaluateInboundPolicy(await port.loadInboundPolicy(agentId), sender);
  } catch (error) {
    if (!(error instanceof PolicySourceUnavailableError || error instanceof PolicyShapeError)) throw error;
    log('error', 'inbound.policy_unavailable', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      agent_id: agentId,
      ses_message_id: sesMessageId,
      reason: error.name,
      outcome: 'quarantined',
    });
    return 'inbound_disabled';
  }
  if (verdict.kind === 'deliver') return null;
  log('info', 'inbound.policy_blocked', {
    route_id: INBOUND_CONSUMER_ROUTE_ID,
    trace_id: traceId,
    agent_id: agentId,
    ses_message_id: sesMessageId,
    reason: verdict.reason,
    outcome: 'quarantined',
  });
  return verdict.reason;
}

/**
 * 받기 등급 + 감시 설정 → 이 행의 등급 · 우회 · 보류(머리말 "받기 등급"). 등급은 위험 보류를 정하기 **전**의 판정이다(보류해도 `risk`).
 * 우회는 스캔이 끝났고(판정 있음) 정책이 막지 않았을 때만 — 판정 없음 · 정책 차단은 우회가 지우지 못한다.
 */
function watchRecordOf(
  scan: InboundScanRecord,
  policyBlocked: InboundPolicyReason | null,
  context: InboundWatchContext,
  sender: { readonly fromAddress: string; readonly fromAuthenticated: boolean; readonly replyTo: readonly string[] },
): InboundWatchRecord {
  const trustedBypass = scan.kind === 'scanned' && policyBlocked === null && matchesTrustedSender(context.trustedSenders, sender);
  const hidden = quarantineOf({ scan, policyBlocked, watch: { level: 'none', trustedBypass, riskHold: false } });
  const { level } = classifyInboundLevel({
    quarantined: hidden !== null,
    quarantineReason: hidden,
    injectionRisk: scan.kind === 'scanned' ? scan.injectionRisk : null,
    findings: scan.kind === 'scanned' ? scan.findings.map((f) => ({ family: f.family as RuleFamily, damped: f.damped })) : [],
    trustedBypass,
  });
  return { level, trustedBypass, riskHold: level === 'risk' && context.settings.riskHandling === 'hold' };
}

async function stampTrust(
  port: TrustFactsPort,
  context: Parameters<typeof loadTrustSignals>[0],
  traceId: string | null,
  sesMessageId: string,
): Promise<InboundSenderTrustRecord> {
  try {
    const trust = computeTrust(await loadTrustSignals(context, port));
    return { category: trust.category, decidedBy: trust.decidedBy };
  } catch (error) {
    if (!(error instanceof PolicyShapeError)) throw error;
    log('warn', 'inbound.trust_degraded', {
      route_id: INBOUND_CONSUMER_ROUTE_ID,
      trace_id: traceId,
      agent_id: context.agentId,
      ses_message_id: sesMessageId,
      reason: 'policy_shape',
      verdict: 'unknown',
    });
    return { category: 'unknown', decidedBy: null };
  }
}

// ---------------------------------------------------------------------------
// AI 의심 메일 감시(ADR-0017 초안) — 승격 · 커밋 뒤 전송. **경고 전용 측정**: 여기서 정한 것은 작업 연결과 보이는 시각뿐이다.
// ---------------------------------------------------------------------------

type AiWatchRowFacts = Parameters<typeof shouldEscalate>[0]['row'];

interface AiWatchSession {
  plan(organizationId: string | null, row: AiWatchRowFacts, traceId: string | null, sesMessageId: string): Promise<InboundAiWatchPlan | null>;
  created(job: { readonly jobId: string; readonly enqueuedAt: Date; readonly deadline: Date }): void;
  flush(traceId: string | null, sesMessageId: string): Promise<void>;
}

/** 메일 한 통 동안의 감시 상태 — 조직 사실·워커 상태는 한 번씩만 읽고, 새 작업은 모아 두었다가 커밋 뒤에 보낸다. */
type AiWatchOrgContext = Awaited<ReturnType<AiWatchInboundPort['orgContext']>>;

function aiWatchSession(deps: InboundAiWatchDependencies, excerpt: string | null): AiWatchSession {
  const contexts = new Map<string, Promise<AiWatchOrgContext | null>>();
  let healthy: Promise<boolean> | null = null;
  const pending = new Map<string, { readonly enqueuedAt: Date; readonly deadline: Date }>();

  const contextOf = (organizationId: string): Promise<AiWatchOrgContext | null> => {
    let found = contexts.get(organizationId);
    if (found === undefined) {
      found = deps.store.orgContext(organizationId).catch(() => null);
      contexts.set(organizationId, found);
    }
    return found;
  };

  return {
    async plan(organizationId, row, traceId, sesMessageId) {
      if (organizationId === null) return null;
      const org = await contextOf(organizationId);
      if (org === null) {
        // 사실을 못 읽었다 — 승격하지 않는다(감시 실패가 메일 기록을 막지 않는다).
        log('warn', 'inbound.ai_watch_skipped', { route_id: INBOUND_CONSUMER_ROUTE_ID, trace_id: traceId, ses_message_id: sesMessageId, reason: 'context_unavailable' });
        return null;
      }
      healthy ??= deps.store.workerHealthy().catch(() => false);
      const decision = shouldEscalate({
        mode: deps.mode,
        org,
        row,
        excerpt,
        workerHealthy: await healthy,
      });
      if (!decision.escalate) {
        if (decision.reason === 'rate_capped') countMetric(METRIC_NAMES.aiWatchRateCapped);
        return null;
      }
      return { organizationId, hold: decision.hold, shadow: decision.shadow };
    },
    created(job) {
      pending.set(job.jobId, { enqueuedAt: job.enqueuedAt, deadline: job.deadline });
    },
    async flush(traceId, sesMessageId) {
      if (excerpt === null) return;
      for (const [jobId, job] of pending) {
        try {
          const body = serializeAiWatchRequest({
            v: 1,
            job_id: jobId,
            enqueued_at: job.enqueuedAt.toISOString(),
            deadline: job.deadline.toISOString(),
            input_version: AI_WATCH_INPUT_VERSION,
            text: excerpt,
          });
          await deps.queue.send(body);
          countMetric(METRIC_NAMES.aiWatchEnqueued);
        } catch (error) {
          countMetric(METRIC_NAMES.aiWatchEnqueueFailed);
          const released = await deps.store.skipJob(jobId).catch(() => null);
          log('warn', 'inbound.ai_watch_enqueue_failed', {
            route_id: INBOUND_CONSUMER_ROUTE_ID,
            trace_id: traceId,
            ses_message_id: sesMessageId,
            reason: 'enqueue_failed',
            outcome: released === null ? 'skip_failed' : 'skipped',
            error_kind: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      pending.clear();
    },
  };
}
