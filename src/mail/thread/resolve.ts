/**
 * src/mail/thread/resolve.ts — 수신 메일을 스레드에 잇는다 (계획 §6 P3, AC-4).
 *
 * **이 파일은 I/O 를 하지 않는다.** 헤더 몇 개와 조회 포트를 받아 판정 하나를 돌려준다.
 * 저장소 구현(`threads` 테이블)은 이 포트의 구현자가 만든다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 판정이 두 개인가 — 권한용과 표시용
 * ---------------------------------------------------------------------------
 *
 * 스레드 소속은 **권한 판단의 입력**이다. reply_only(§3.1)는 "기존 스레드 내 회신" 만
 * 허용하고, `auto_approve_reply_within_thread`(§3.4 3조)는 스레드 회신의 승인을 면제한다.
 * 그러므로 남의 메일을 어떤 스레드에 잘못 이어 붙이는 것은 표시 오류가 아니라
 * **승인 우회**다 — 제3자가 우리 스레드에 들어오면, 에이전트가 그에게 보내는 회신이
 * "스레드 내 회신" 으로 승인 없이 나간다.
 *
 * 그래서:
 *   - `authority` — **강한 증거만으로** 기존 스레드에 잇는다. 저장 `thread_id` 도 이것이다.
 *     증거가 모자라면 `new` 다. 새 스레드는 그 발신자 혼자의 스레드이므로 누구의 권한도
 *     빌려 오지 않는다.
 *   - `display` — UI·에이전트 컨텍스트에서 "이 메일은 아마 저 대화의 일부" 라고 묶어
 *     보여 줄 뿐이다. 약한 증거(검증 안 된 헤더 매칭, 제목)도 여기서는 쓴다.
 *     **이 값으로 권한을 판단하지 마라.** 타입이 그것을 막는다 — `authority.matchedBy` 에는
 *     `'subject'` 가 들어갈 자리가 없다.
 *
 * 저장 `thread_id` 가 권한용이라는 것이 요점이다. 약한 연결을 같은 `thread_id` 에
 * "unverified 플래그" 로 넣으면, 그 스레드의 참여자·턴 수를 세는 모든 쿼리가 그 플래그를
 * 기억해야 한다 — 하나라도 잊으면 우회다. 약한 연결을 **다른 스레드**에 두면 잊을 것이 없다.
 *
 * ---------------------------------------------------------------------------
 * ## 강한 증거의 정의
 * ---------------------------------------------------------------------------
 *
 * `In-Reply-To`/`References` 의 어떤 id 가 **이 에이전트의** 메시지와 일치하고, 그리고:
 *
 *   1. 그 메시지가 **우리가 실제로 내보낸** outbound 이면 — 발신자가 그 메시지의
 *      **수신자 집합**에 있어야 한다. id 는 비밀이 아니다(수신자에게 보이고, 전달되면
 *      제3자에게도 보인다). id 만 맞으면 들여보내는 순간 "id 를 아는 사람 = 참여자" 가 된다.
 *   2. 그 메시지가 이 스레드에 이미 들어온 inbound 이면 — 발신자가 **그 메시지의 발신자와
 *      같아야** 한다(같은 사람이 이어 쓰는 경우). 그 inbound 의 다른 수신자(Cc)는 소유자가
 *      승인한 적 없는 사람이므로 참여자로 치지 않는다. 그리고 **그 inbound 도 인증돼 있어야** 한다 —
 *      사칭 메일이 연 스레드에 진짜 발신자의 회신이 권한으로 들어가지 않게(`senderAuthenticated`).
 *
 * 그리고 어느 쪽이든 **`From` 이 인증돼 있어야** 한다(`fromAuthenticated` — DMARC 정렬
 * 통과). `From` 헤더는 누구나 쓸 수 있다. 인증 없는 발신자 검증은 검증이 아니다.
 * 한계: DMARC 는 **도메인**만 인증한다. 같은 도메인의 다른 사용자가 로컬파트를 사칭하는
 * 것은 그 도메인 메일서버의 정책에 달렸다 — 우리가 닫을 수 있는 구멍이 아니다.
 *
 * ---------------------------------------------------------------------------
 * ## SES 가 우리 `Message-ID` 를 덮는다 (ADR-0004, B9)
 * ---------------------------------------------------------------------------
 *
 * 우리가 실은 `<mucer1q5.…@atmark.ai>` 는 수신 시점에 `<{SES MessageId}@ap-northeast-2.amazonses.com>`
 * 으로 바뀌어 있다. 상대의 회신 `In-Reply-To` 에는 **이 값**이 들어온다.
 *
 * 실발송(2026-09-22 `demo:p1b`)에서 도착 원문 `Message-ID` 의 **로컬파트 == `messages.ses_message_id`** 였다.
 * 표본이 1건이므로, `*.amazonses.com` id 는 로컬파트를 `ses_message_id` 로 조회하고
 * **동시에** 모든 id 를 원형 그대로 `message_id_header` 로도 조회한다 — SES 가 덮지 않는
 * 경로(다른 전송단, 정책 변경)가 생겨도 매칭이 끊기지 않는다.
 */

import { MESSAGE_ID_HEADER_PATTERN } from '../message-id';

// ---------------------------------------------------------------------------
// 입력 — 파서 출력과 독립된 최소 필드 (어댑터로 잇는다)
// ---------------------------------------------------------------------------

/**
 * 수신 메일에서 스레드 해석에 쓰는 것 전부. optional 은 쓰지 않는다 — 없는 값은 `null`·빈 배열.
 *
 * **헤더 `To` 는 받지 않는다.** 어느 에이전트가 받았는지는 봉투 수신자(SES receipt 의
 * `recipients`)가 정하고, 그것이 `agentId` 다. 헤더 `To` 는 발신자가 마음대로 쓰고
 * Bcc 수신이면 에이전트 주소가 아예 없다 — 조회 범위를 거기에 걸면 범위가 공격자 입력이 된다.
 */
export interface InboundThreadHeaders {
  /** 봉투 기준으로 이 메일을 받은 에이전트. 모든 조회가 이 범위 안에서만 일어난다. */
  readonly agentId: string;
  /** 이 메일 자신의 `Message-ID`. 자기 참조를 후보에서 빼는 데만 쓴다. */
  readonly messageId: string | null;
  /** `In-Reply-To` 헤더 원문 또는 id 하나. 여러 개가 들어 있어도 전부 뽑는다. */
  readonly inReplyTo: string | null;
  /** `References` — 이미 쪼갠 배열이든 원문 한 줄이든 각 원소에서 `<…>` 를 전부 뽑는다. */
  readonly references: readonly string[];
  /** `From` 의 **주소만** (표시명 없이). 모양이 아니면 권한 판정은 성립하지 않는다. */
  readonly from: string;
  /**
   * `From` 도메인이 인증됐는가 — SES receipt 의 `dmarcVerdict.status === 'PASS'` 수준.
   * `false` 면 어떤 헤더가 맞아도 권한용 연결은 없다.
   */
  readonly fromAuthenticated: boolean;
  readonly subject: string | null;
}

// ---------------------------------------------------------------------------
// 저장소 포트 — 구현은 다음 워커 (`threads` + `messages`)
// ---------------------------------------------------------------------------

/** 조회 키의 종류. `messages` 의 어느 컬럼에 거는지와 1:1 이다. */
export type HeaderKeyKind = 'message_id_header' | 'ses_message_id';

export interface HeaderLookupKey {
  readonly kind: HeaderKeyKind;
  /** `message_id_header` 면 `<local@domain>`(도메인 소문자), `ses_message_id` 면 SES id 원형. */
  readonly value: string;
}

export type MessageDirection = 'inbound' | 'outbound';

/** 포트가 돌려주는 기존 메시지 한 건. */
export interface KnownMessage {
  /** `messages.id` */
  readonly messageId: string;
  /** 포트 구현이 범위를 빠뜨려도 여기서 한 번 더 거른다. */
  readonly agentId: string;
  /** 이 메시지가 저장된 **권한용** `thread_id`. */
  readonly threadId: string;
  readonly direction: MessageDirection;
  /**
   * outbound: 실제로 SES 에 넘긴 수신자 전원(To·Cc·Bcc). inbound: 빈 배열(쓰지 않는다).
   */
  readonly recipients: readonly string[];
  /** inbound: 그 메일의 `From` 주소. outbound: 에이전트 주소(쓰지 않는다). */
  readonly sender: string;
  /**
   * outbound 가 실제로 나갔는가(`status='sent'`). 나간 적 없는 메시지의 id 를 외부인이
   * 정당하게 알 방법은 없다 — 그 id 가 회신에 등장하면 권한 근거가 될 수 없다.
   * inbound 는 항상 `true`.
   */
  readonly sent: boolean;
  /**
   * inbound: 그 메일의 `From` 이 인증됐는가(DMARC pass — `inbound_messages.from_authenticated`). **인증 안 된 수신은
   * 권한 연결의 근거가 될 수 없다** — bob 을 사칭한 메일(DMARC fail)이 `M_x` 로 스레드를 열고, 진짜 bob 의
   * 인증 메일이 `In-Reply-To: M_x` 로 오면, 발신자 대조("같은 사람이 이어 쓴다")가 사칭자가 쓴 `From` 과 맞아
   * 사칭자가 연 스레드에 권한으로 들어간다(검증 V2). outbound 는 `true`(우리가 보낸 것 — 쓰지 않는다).
   */
  readonly senderAuthenticated: boolean;
  /** 어느 키로 찾았는가. 요청하지 않은 키의 결과는 버린다. */
  readonly matchedKey: HeaderLookupKey;
}

export interface ThreadLookupPort {
  /**
   * `agentId` 의 메시지 중 `keys` 의 어느 하나와 일치하는 것 전부.
   * 한 키에 여러 행이 올 수 있다 — inbound 의 `Message-ID` 는 외부가 정하므로 유니크가 아니다.
   *
   * `counterpart` = 이 메일의 발신자(비교용 주소, 모양이 아니면 `null`). 발신자가 **Atmark 주소**면 구현은 그 주소의 지금 활성 행이 생기기
   * **전**의 메시지를 돌려주지 않는다(별칭 재발급 보안 리뷰 M3 — 재발급된 주소의 새 주인이 예전 주인의 스레드 권한을 물려받지 않게). 해석기는
   * 이 시각을 모르므로 이 거르기는 구현의 몫이다(Postgres 구현 `thread-store.ts` · 통합 테스트).
   */
  findByHeaderKeys(agentId: string, keys: readonly HeaderLookupKey[], counterpart: string | null): Promise<readonly KnownMessage[]>;
  /**
   * **표시용 전용.** 정규화된 제목이 같고 `counterpart` 가 참여한 이 에이전트의 스레드 id 들. 같은 이유로 Atmark 주소 상대의 참여는 그 주소의
   * 지금 활성 행이 생긴 뒤의 것만 센다.
   */
  findThreadIdsBySubject(
    agentId: string,
    normalizedSubject: string,
    counterpart: string,
  ): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// 출력
// ---------------------------------------------------------------------------

/** 어느 헤더에서 찾았는가. */
export type HeaderSource = 'in_reply_to' | 'references';

/** 권한용 연결이 없는 이유 — audit·디버깅용. */
export type NewThreadReason =
  | 'no_header_ids'
  | 'no_known_message'
  | 'sender_unauthenticated'
  | 'sender_unparseable'
  | 'sender_not_participant';

/**
 * 권한용 판정. `matchedBy` 에 `'subject'` 가 **들어갈 수 없다** — 제목 폴백이 여기로 새는
 * 것을 타입이 막는다.
 */
export type AuthorityThread =
  | {
      readonly kind: 'existing';
      readonly threadId: string;
      readonly matchedBy: HeaderKeyKind;
      readonly via: HeaderSource;
      /** 근거가 된 우리 쪽 `messages.id`. audit 에 남긴다. */
      readonly matchedMessageId: string;
      readonly confidence: 'verified';
    }
  | { readonly kind: 'new'; readonly reason: NewThreadReason };

/** 표시용 판정. **권한 판단에 쓰지 마라.** */
export interface DisplayThread {
  readonly threadId: string;
  readonly matchedBy: HeaderKeyKind | 'subject';
  readonly confidence: 'verified' | 'header_unverified' | 'subject_heuristic';
}

export interface ThreadResolution {
  /** 저장 `thread_id`·reply_only·`auto_approve_reply_within_thread` 가 읽는 값. */
  readonly authority: AuthorityThread;
  /** UI 묶음용. `null` 이면 어디에도 묶지 않는다. */
  readonly display: DisplayThread | null;
}

// ---------------------------------------------------------------------------
// 헤더 id 추출·정규화
// ---------------------------------------------------------------------------

/**
 * 한 메일에서 조회할 id 상한. `References` 는 발신자가 원하는 만큼 늘릴 수 있다 —
 * 상한이 없으면 메일 한 통이 조회 수천 건이 된다. 최근 쪽(끝)을 남긴다(RFC 5322 3.6.4:
 * 부모가 마지막).
 */
export const MAX_CANDIDATE_IDS = 50;

const BRACKETED_ID = /<([^<>\s]+@[^<>\s]+)>/g;
const BARE_ID = /^[^<>\s]+@[^<>\s]+$/;

/**
 * SES 가 붙이는 `Message-ID` 도메인. 실측은 `ap-northeast-2.amazonses.com` 1건이고,
 * us-east-1 은 `email.amazonses.com` 을 쓴다고 알려져 있다 — 둘 다 이 패턴에 든다.
 * 도메인을 넓게 받아도 위험이 늘지 않는다: 로컬파트가 **우리가 저장한 SES id 와 정확히
 * 일치**해야 하고, 권한은 그 뒤의 발신자 검증이 정한다.
 */
const SES_MESSAGE_ID_DOMAIN = /^(?:[a-z0-9-]+\.)*amazonses\.com$/;

/**
 * `<local@Domain>` → `<local@domain>`. 로컬파트는 대소문자를 보존한다(RFC 5322 에서
 * 구분되고, SES id 는 원형 비교다). 모양이 아니면 `null`.
 */
export function normalizeMessageId(raw: string): string | null {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  if (!BARE_ID.test(inner)) return null;
  const at = inner.lastIndexOf('@');
  const normalized = `<${inner.slice(0, at)}@${inner.slice(at + 1).toLowerCase()}>`;
  return MESSAGE_ID_HEADER_PATTERN.test(normalized) ? normalized : null;
}

/** 헤더 값 하나에서 id 를 순서대로 전부 뽑는다. 꺾쇠가 없으면 값 전체를 id 하나로 본다. */
export function extractMessageIds(raw: string): string[] {
  const bracketed = [...raw.matchAll(BRACKETED_ID)].map((match) => match[1] ?? '');
  const sources = bracketed.length > 0 ? bracketed : [raw];
  return sources.map(normalizeMessageId).filter((id): id is string => id !== null);
}

/** `<X@ap-northeast-2.amazonses.com>` → `X`. SES 가 붙인 id 가 아니면 `null`. */
export function sesMessageIdOf(normalizedId: string): string | null {
  const inner = normalizedId.slice(1, -1);
  const at = inner.lastIndexOf('@');
  return SES_MESSAGE_ID_DOMAIN.test(inner.slice(at + 1)) ? inner.slice(0, at) : null;
}

interface Candidate {
  readonly id: string;
  readonly source: HeaderSource;
  /** 작을수록 우선. `In-Reply-To` 가 먼저, 그다음 `References` 의 끝(최근)부터. */
  readonly rank: number;
}

/** 우선순위 순으로 정렬된, 중복·자기참조 없는 후보. */
export function candidateIds(headers: InboundThreadHeaders): Candidate[] {
  const own = headers.messageId === null ? null : normalizeMessageId(headers.messageId);
  const inReplyTo = headers.inReplyTo === null ? [] : extractMessageIds(headers.inReplyTo);
  const references = headers.references.flatMap(extractMessageIds).reverse();

  const seen = new Set<string>(own === null ? [] : [own]);
  const out: Candidate[] = [];
  const push = (id: string, source: HeaderSource): void => {
    if (seen.has(id) || out.length >= MAX_CANDIDATE_IDS) return;
    seen.add(id);
    out.push({ id, source, rank: out.length });
  };
  for (const id of inReplyTo) push(id, 'in_reply_to');
  for (const id of references) push(id, 'references');
  return out;
}

/** 후보 하나 → 조회 키들. 모든 id 는 헤더 원형으로, SES 도메인이면 SES id 로도 찾는다. */
function lookupKeysOf(candidate: Candidate): HeaderLookupKey[] {
  const keys: HeaderLookupKey[] = [{ kind: 'message_id_header', value: candidate.id }];
  const ses = sesMessageIdOf(candidate.id);
  if (ses !== null) keys.push({ kind: 'ses_message_id', value: ses });
  return keys;
}

// ---------------------------------------------------------------------------
// 주소·제목 정규화
// ---------------------------------------------------------------------------

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+$/;

/**
 * 비교용 주소. 소문자화만 한다 — `+tag` 를 지우지 **않는다.** 정책 쪽 `normalizeAddress` 는
 * 차단 판정이라 넓게 묶는 것이 안전 방향이지만, 여기는 **허용** 판정이라 좁은 것이 안전
 * 방향이다(`bob+x@` 로 보냈는데 `bob@` 이 회신하면 승인 한 번을 더 탈 뿐이다).
 */
function comparableAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  return ADDRESS.test(trimmed) ? trimmed : null;
}

const REPLY_PREFIX = /^\s*(?:re|fwd?|aw|sv|회신|답장|전달)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

/**
 * `Re: Fwd: 회신: 견적` → `견적`. 공백 정리·NFKC·소문자. 접두사가 하나라도 있었는지도 알려 준다.
 */
export function normalizeSubject(subject: string): { readonly normalized: string; readonly hadReplyPrefix: boolean } {
  let rest = subject.normalize('NFKC');
  let hadReplyPrefix = false;
  for (;;) {
    const next = rest.replace(REPLY_PREFIX, '');
    if (next === rest) break;
    hadReplyPrefix = true;
    rest = next;
  }
  return { normalized: rest.replace(/\s+/g, ' ').trim().toLowerCase(), hadReplyPrefix };
}

// ---------------------------------------------------------------------------
// 해석
// ---------------------------------------------------------------------------

interface Hit {
  readonly message: KnownMessage;
  readonly candidate: Candidate;
}

/** 이 발신자가 이 기존 메시지를 근거로 그 스레드에 들어올 자격이 있는가. */
function senderQualifies(hit: KnownMessage, sender: string): boolean {
  if (hit.direction === 'outbound') {
    if (!hit.sent) return false;
    return hit.recipients.some((recipient) => comparableAddress(recipient) === sender);
  }
  // 근거 행 자체가 인증돼 있어야 한다 — 인증 안 된 행의 `From` 은 누구든 쓸 수 있는 값이다.
  return hit.senderAuthenticated && comparableAddress(hit.sender) === sender;
}

export async function resolveThread(
  headers: InboundThreadHeaders,
  port: ThreadLookupPort,
): Promise<ThreadResolution> {
  const candidates = candidateIds(headers);
  const sender = comparableAddress(headers.from);

  const hits = candidates.length === 0 ? [] : await findHits(headers.agentId, candidates, sender, port);

  // 우선순위: 후보 순위 → 같은 후보면 outbound 먼저(우리가 id 를 정한 쪽이 더 단단하다).
  hits.sort(
    (a, b) =>
      a.candidate.rank - b.candidate.rank ||
      directionRank(a.message.direction) - directionRank(b.message.direction),
  );

  const verified =
    headers.fromAuthenticated && sender !== null
      ? hits.find((hit) => senderQualifies(hit.message, sender))
      : undefined;

  if (verified !== undefined) {
    return {
      authority: {
        kind: 'existing',
        threadId: verified.message.threadId,
        matchedBy: verified.message.matchedKey.kind,
        via: verified.candidate.source,
        matchedMessageId: verified.message.messageId,
        confidence: 'verified',
      },
      display: {
        threadId: verified.message.threadId,
        matchedBy: verified.message.matchedKey.kind,
        confidence: 'verified',
      },
    };
  }

  const reason = newThreadReason(candidates.length, hits.length, headers.fromAuthenticated, sender);
  const firstHit = hits[0];
  if (firstHit !== undefined) {
    // 헤더는 맞았지만 발신자를 검증하지 못했다. 보여 주되 권한은 주지 않는다.
    return {
      authority: { kind: 'new', reason },
      display: {
        threadId: firstHit.message.threadId,
        matchedBy: firstHit.message.matchedKey.kind,
        confidence: 'header_unverified',
      },
    };
  }

  return {
    authority: { kind: 'new', reason },
    display: await subjectFallback(headers, sender, port),
  };
}

async function findHits(
  agentId: string,
  candidates: readonly Candidate[],
  sender: string | null,
  port: ThreadLookupPort,
): Promise<Hit[]> {
  const candidateByKey = new Map<string, Candidate>();
  const keys: HeaderLookupKey[] = [];
  for (const candidate of candidates) {
    for (const key of lookupKeysOf(candidate)) {
      candidateByKey.set(keyString(key), candidate);
      keys.push(key);
    }
  }
  const found = await port.findByHeaderKeys(agentId, keys, sender);

  const hits: Hit[] = [];
  for (const message of found) {
    // 포트를 믿지 않는다 — 범위 밖 에이전트의 행, 요청하지 않은 키의 행은 버린다.
    // 느슨한 구현(전 행 반환, agent 필터 누락)이 곧 스레드 탈취 경로가 되기 때문이다.
    if (message.agentId !== agentId) continue;
    const candidate = candidateByKey.get(keyString(message.matchedKey));
    if (candidate === undefined) continue;
    hits.push({ message, candidate });
  }
  return hits;
}

function keyString(key: HeaderLookupKey): string {
  return `${key.kind}\u0000${key.value}`;
}

function directionRank(direction: MessageDirection): number {
  return direction === 'outbound' ? 0 : 1;
}

function newThreadReason(
  candidateCount: number,
  hitCount: number,
  fromAuthenticated: boolean,
  sender: string | null,
): NewThreadReason {
  if (candidateCount === 0) return 'no_header_ids';
  if (hitCount === 0) return 'no_known_message';
  if (sender === null) return 'sender_unparseable';
  if (!fromAuthenticated) return 'sender_unauthenticated';
  return 'sender_not_participant';
}

/**
 * **표시용 전용** 제목 폴백. 헤더로 아무것도 못 찾았을 때만, 회신 접두사가 있고, 이 발신자가
 * 참여한 스레드 중 **정확히 하나**가 같은 제목일 때만 묶는다.
 *
 * 권한에 쓰지 않는 이유: 제목은 누구나 똑같이 쓸 수 있다. "Re: 견적" 을 보내는 것만으로
 * 남의 스레드에 들어가면 그 스레드의 승인 면제를 빌려 쓴다.
 */
async function subjectFallback(
  headers: InboundThreadHeaders,
  sender: string | null,
  port: ThreadLookupPort,
): Promise<DisplayThread | null> {
  if (headers.subject === null || sender === null) return null;
  const { normalized, hadReplyPrefix } = normalizeSubject(headers.subject);
  if (!hadReplyPrefix || normalized === '') return null;

  const threadIds = await port.findThreadIdsBySubject(headers.agentId, normalized, sender);
  const only = threadIds.length === 1 ? threadIds[0] : undefined;
  if (only === undefined) return null;
  return { threadId: only, matchedBy: 'subject', confidence: 'subject_heuristic' };
}
