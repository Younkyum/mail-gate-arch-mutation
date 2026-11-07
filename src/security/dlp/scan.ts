/**
 * src/security/dlp/scan.ts — **발신 DLP 한 번**(ADR-0016 B). 발송 내용 → 닫힌 계열 목록. 결정론 · 선형 시간 · LLM·네트워크 없음.
 *
 * 결과는 **계열 이름뿐**이다(값·위치 없음) — 감사 행(`OutboundAttempt.dlp` · `messages.outbound_dlp`, M1)·승인 메일·로그로 가고, 거기에
 * 토큰·코드 값이 실리면 탐지가 곧 유출이 된다. 판정은 `rules/risk-hold.ts` 가 **좁히는 방향으로만** 쓴다.
 *
 * **입력 계약(ADR-0016 결정 2 — M1 배선이 지킨다):** 입력은 **서버가 조립한 최종 발송 내용**이다(전달이면 원문을 붙인 뒤). 제목 · text ·
 * html · **text/* 첨부 텍스트**를 함께 본다 — 첨부를 읽지 못했으면 `text: null` 로 넘기고, 그러면 `scan_limit` 이다. HTML 과 모든 파트는
 * 태그를 걷고 엔티티를 푼 보기(`markup.ts`)로 본다 — **두 벌**: 태그를 지운 보기(`atk_age<span></span>nt_…` 처럼 쪼갠 토큰을 잇는다)와
 * 태그를 공백으로 바꾼 보기(`<td>1</td><td>AKIA…</td>` 처럼 앞 낱말이 토큰에 붙어 경계(lookbehind)가 깨지지 않게). 비밀·코드는 두 보기의
 * 결과를 합친다(OR), 복사 지문은 공백 보기만 쓴다.
 *
 * **입력 상한 1,000,000자**(스캐너 `MAX_FIELD_CHARS` 와 같다, 파트를 이은 길이). 넘거나 후보·지문 상한에 걸리면 `scan_limit` 을 낸다 —
 * 끝까지 보지 못한 본문을 깨끗하다고 하지 않는다(fail closed, 스캐너의 `scan_limit` 계열과 같은 규율).
 *
 * **풀어 본 보기(2026-10-08 인코딩 점검):** base64 · base64url · 16진수 · 비 ASCII `%XX` 로 한 번(두 겹까지) 감싼 내용도 본다(`decode.ts` — 사람이
 * 읽는 글로 풀리는 후보만, 후보·예산 상한을 넘으면 `scan_limit`).
 *
 * **알려진 한계(ADR-0016 · `docs/security/encoding-limits.md`):** 의역·쪼개기·뒤집기·암호화·압축으로 이 검사를 피할 수 있다. 작정한 에이전트를 막는
 * 본체는 위험 적응 승인(A — 새 수신자는 사람이 본다)이고, 이 검사는 순진한 유출과 실수를 붙잡는 그물이다.
 */

import type { HmacKeyring } from '../hmac-keyring';
import { fold } from '../injection/normalize';
import { matchCodeFingerprints, type CodeFingerprint } from './codes';
import { decodedView } from './decode';
import { normalizeMarkup } from './markup';
import { detectSecretFamilies } from './secrets';
import { inboundCopyOverlap, outboundShingles, type ShingleSet } from './shingle';

/** DLP 계열 — **닫힌 열거**. 순서가 곧 표시·사유 순서다(심각한 것 먼저). */
export const DLP_FAMILIES = ['atmark_credential', 'third_party_secret', 'verification_code', 'secret_link', 'inbound_copy', 'scan_limit'] as const;
export type DlpFamily = (typeof DLP_FAMILIES)[number];

/** 입력 상한 — `injection/scanner.ts` `MAX_FIELD_CHARS` 와 같다. */
export const MAX_OUTBOUND_SCAN_CHARS = 1_000_000;

/** 발신 text/* 첨부 하나의 텍스트. `null` = 읽지 못했다(디코딩 실패·크기) → `scan_limit`. */
export interface OutboundAttachmentText {
  readonly text: string | null;
}

/** 발송 내용 — 서버가 조립한 최종본(입력 계약, 머리말). */
export interface OutboundContent {
  readonly subject: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly OutboundAttachmentText[];
}

/** 최근 받은 메일 한 통의 복사 지문(M1 — 최근 30일). */
export interface InboundCopySource {
  readonly inboundMessageId: string;
  /** 그 메일의 발신 주소(소문자, `+tag` 보존 — 허용 비교형). */
  readonly senderAddress: string;
  /** 그 메일의 권한용 스레드. 모르면 `null`. */
  readonly threadId: string | null;
  /**
   * 그 메일의 **참여자**(소문자 — 배선 계약 5 · 리뷰 L3 · 재검증 R2): 그 메일이 도착하기 **전에** 같은 스레드로 우리가 보낸 발신의 수신자 ∪ 그 전에 도착한
   * 인증된 수신 발신자 ∪ 그 메일 자체의 인증된 발신자(`db/repositories/dlp-signal-store.ts`). 수신자 전원이 여기 있으면 그 메일을 뺀다 — reply-all 에 원래
   * 참여자만 있는 인용 회신은 원 메일을 이미 받은 사람들에게 돌려주는 것이다. 받은 메일의 머리글(To/Cc)은 넣지 않고, 도착 뒤의 발신으로 참여자를 만들지
   * 못한다(참여자 세탁). 빈 목록이면 이 제외는 없다.
   */
  readonly threadParticipants: readonly string[];
  readonly shingles: ShingleSet;
  /**
   * 그 메일의 **코드·링크 토큰 지문**(재검증 N2 ①) — 회신 라우트가 대상 메일을 그 자리에서 지문화해 실을 때만 있다. 짧은 메일(재설정 링크 한 줄)은
   * 8-gram 지문이 거의 없어 복사 판정을 지난다 — 그 메일의 토큰이 발신 본문에 그대로 있으면 `inbound_copy` 다(출처 도메인 제외 없음 — 수신자 중
   * 원 발신자가 아닌 주소가 있을 때만 싣는다).
   */
  readonly secrets?: readonly CodeFingerprint[];
}

export interface DlpContext {
  readonly keyring: HmacKeyring;
  /** 수신자(허용 비교형 — 소문자, `+tag` 보존). */
  readonly recipients: readonly string[];
  /** 수신자의 **등록 도메인**(소문자). 호출자가 공개 접미사로 계산한다. */
  readonly recipientDomains: readonly string[];
  /** 최근 24시간에 에이전트가 읽은 인증 코드 지문. */
  readonly codeFingerprints: readonly CodeFingerprint[];
  /** 최근 받은 메일 복사 지문. */
  readonly inboundCopies: readonly InboundCopySource[];
}

export interface DlpScanResult {
  readonly families: DlpFamily[];
  /**
   * 키 묶음에 kid 가 없어 **비교하지 못한** 지문 수(코드 지문 + 복사 지문 묶음). 0 이 아니면 키를 지문 보존 기간(코드 24시간 · 복사 30일)보다
   * 일찍 뺐다 — M1 이 메트릭으로 드러낸다(ADR-0016 "키링 보존 ≥ 30일").
   */
  readonly droppedFingerprints: number;
}

/** 발송 내용을 본다. */
export function scanOutbound(content: OutboundContent, ctx: DlpContext): DlpScanResult {
  const found = new Set<DlpFamily>();
  const parts = [content.subject, content.text, content.html, ...content.attachments.map((a) => a.text)];
  if (content.attachments.some((a) => a.text === null)) found.add('scan_limit');
  const raw = parts.filter((p): p is string => p !== null && p.length > 0).join('\n');
  const capped = raw.length > MAX_OUTBOUND_SCAN_CHARS;
  if (capped) found.add('scan_limit');
  const bounded = capped ? raw.slice(0, MAX_OUTBOUND_SCAN_CHARS) : raw;

  // 두 보기(머리말): 태그를 지운 보기는 쪼갠 토큰을 잇고, 태그를 공백으로 바꾼 보기는 경계를 지킨다. 비밀·코드는 둘의 OR.
  const joined = fold(normalizeMarkup(bounded, ''));
  const spaced = fold(normalizeMarkup(bounded, ' '));
  if (joined.truncated || spaced.truncated) found.add('scan_limit');
  // 풀어 본 보기(`decode.ts`) — base64·base64url·16진수·비 ASCII `%XX` 로 감싼 비밀·코드·사본. 태그째 원문(속성 안의 덩어리)과 태그를 지운 원문
  // (태그로 쪼갠 덩어리) 둘 다에서 찾는다. **접기 전에** 푼다 — 접으면 소문자가 되어 base64 가 깨진다.
  const decoded = decodedView([bounded, normalizeMarkup(bounded, '')]);
  if (decoded.truncated) found.add('scan_limit');
  const decodedFolded = decoded.text === '' ? null : fold(decoded.text);
  if (decodedFolded?.truncated === true) found.add('scan_limit');
  const views = decodedFolded === null ? [joined.text, spaced.text] : [joined.text, spaced.text, decodedFolded.text];
  // 링크 토큰은 태그째 보기도 본다 — `<a href="…?t=TOKEN">` 의 토큰은 태그를 걷은 두 보기에서 사라진다(재검증 N2).
  // 맞출 지문이 없으면 `matchCodeFingerprints` 가 보기를 보기 전에 끝나므로 태그째 접기를 건너뛴다(대부분의 발송).
  // 불변식: `linkViews` 는 `matchCodeFingerprints` 만 쓴다 — 다른 곳에서 쓰려면 이 생략을 없앤다.
  const needsLinkView = ctx.codeFingerprints.length > 0 || ctx.inboundCopies.some((source) => (source.secrets ?? []).length > 0);
  const linkViews = needsLinkView ? [...views, fold(bounded).text] : views;

  for (const view of views) for (const family of detectSecretFamilies(view)) found.add(family);

  const codes = matchCodeFingerprints(ctx.keyring, views, ctx.codeFingerprints, ctx.recipientDomains, linkViews);
  if (codes.hit) found.add('verification_code');
  // 받은 메일의 비밀 링크(공유·재설정·추적 구분 없이 — 진윤겸 결정) — 사유를 코드와 나눈다.
  if (codes.linkHit) found.add('secret_link');
  if (codes.truncated) found.add('scan_limit');
  let droppedFingerprints = codes.droppedFingerprints;

  // 수신자 **전원**이 그 받은 메일의 발신자 본인이면 뺀다 — 회신 여부와 관계없이, 그 사람의 메일을 그 사람에게 돌려주는 것이다(인용 체인 회신).
  // 다른 수신자가 하나라도 있으면 뺄 수 없다 — 은행 메일에 공격자 주소로 "회신" 하며 전문을 붙이는 우회(리뷰 H2)는 수신자가 원 발신자가 아니다.
  // 스레드 참여자(reply-all 의 동료) 제외(M1 배선 계약 5): 수신자 전원이 그 메일 스레드의 **인증된** 참여자면 뺀다.
  const recipients = ctx.recipients.map((r) => r.toLowerCase());
  const returnsToSender = (source: InboundCopySource): boolean => {
    if (recipients.length === 0) return false;
    if (recipients.every((r) => r === source.senderAddress.toLowerCase())) return true;
    const participants = new Set(source.threadParticipants.map((p) => p.toLowerCase()));
    return participants.size > 0 && recipients.every((r) => participants.has(r));
  };
  const returning = ctx.inboundCopies.filter((source) => !returnsToSender(source));
  // 짧은 메일의 토큰(재검증 N2 ①) — 출처 도메인 제외 없이(수신자 도메인 목록을 비워) 맞춘다.
  for (const source of returning) {
    if ((source.secrets ?? []).length === 0 || found.has('inbound_copy')) continue;
    const secrets = matchCodeFingerprints(ctx.keyring, views, source.secrets ?? [], [], linkViews);
    if (secrets.hit || secrets.linkHit) found.add('inbound_copy');
    if (secrets.truncated) found.add('scan_limit');
  }
  const candidates = returning.filter((source) => source.shingles.fingerprints.length > 0);
  const sources = candidates.filter((source) => ctx.keyring.keys.has(source.shingles.kid));
  droppedFingerprints += candidates.length - sources.length;
  if (sources.length > 0) {
    const shingleText = decodedFolded === null ? spaced.text : `${spaced.text}\n${decodedFolded.text}`;
    const outbound = outboundShingles(ctx.keyring, shingleText, new Set(sources.map((s) => s.shingles.kid)));
    if (outbound.truncated) found.add('scan_limit');
    for (const source of sources) {
      const set = outbound.byKid.get(source.shingles.kid);
      if (set !== undefined && inboundCopyOverlap(set, source.shingles.fingerprints)) {
        found.add('inbound_copy');
        break;
      }
    }
  }

  return { families: DLP_FAMILIES.filter((family) => found.has(family)), droppedFingerprints };
}
