/**
 * `GET /v1/messages/verification-code` — 인증코드·확인 링크 조회(메일 기본기 A1 · D1 하이브리드, `.omc/plans/mail-basics.md` §4 A1).
 *
 * 쿼리 `?agent_id=&sender_domain=&include_subdomains=&since=`. 권한 `messages:read`, 대상은 `agent_id`(자기 것만).
 *
 *   - **확정 모드**(`sender_domain` 이 있다) — `from_domain` 이 그 도메인과 정확히 같은(`include_subdomains=true` 면 하위도, 단 등록 가능
 *     경계 안) **DMARC pass** 메일 가운데 **제목이 인증 메일이고**(`isVerificationSubject`) **발신 주소가 확정 모드 발신자인**
 *     (`isVerifiedModeSender`) 최근 ≤5통에서 코드·링크. 공개 접미사·그 위(`co.kr`·`github.io`·`kr`)는 400 `sender_domain_too_broad`.
 *     발신 주소 문(2회차 수정 Y1): 알림형 로컬파트(`notifications@github.com` — 제목·본문을 남이 정한다, 보안 R1)는 빼고, 발신 도메인이 공용
 *     메일 **apex**(`naver.com`·`kakao.com` …)면 공급자 시스템 발신 주소(`noreply@naver.com`)만 받는다(`attacker@naver.com` 은 조용히 빠진다 —
 *     코드 N2). 공용 도메인을 400 으로 막던 1차 규칙은 없앴다: 에이전트가 카카오·네이버 가입을 확정 모드로 끝낼 수 있게, 목록 밖 주소는
 *     400 이 아니라 **빠진 뒤 남은 것이 없으면 404** 다. `high` 코드가 서로 다르면 409 `ambiguous`(코드 값 없이 후보 id 만), 없으면 404 —
 *     도메인은 맞지만 DMARC fail 뿐이면 결과 `unauthenticated`. 기본 기간 15분. 응답에 `from_address` 를 싣는다.
 *   - **후보 모드**(`sender_domain` 이 없다) — 최근 가시 메일 가운데 코드 후보가 하나라도 있는 ≤5통의 **미검증** 후보(메일당 ≤3).
 *     **링크·URL 은 한 글자도 싣지 않는다** — 최상위 `code`·`links` 키가 없고, 값·도메인에 `http`·`://` 가 든 후보는 뺀다(AC-A1-5).
 *     DMARC fail 은 뒤로. 최상위 `verified: false` 와 이중 언어 `warning`(`UNVERIFIED_CANDIDATES_WARNING`). 기본 기간 24시간. 비ASCII
 *     `from_domain` 은 punycode(`xn--`)로 싣는다(생김새가 같은 다른 글자로 사이트를 흉내 내지 못하게 — 보안 L6).
 *     **창 밀어내기 방지**(코드 M5): SQL 이 발신 도메인마다 최근 `CANDIDATE_PER_DOMAIN` 통만 · DMARC pass 먼저 가져오고, 앱이 그 결과를
 *     **등록 가능 도메인**(`registrableDomain`)으로 다시 묶어 도메인당 `CANDIDATE_PER_DOMAIN` 통으로 줄인다(2회차 수정 Y1, 보안 N1 — 하위
 *     도메인을 돌려 쓰는 스팸). 본문을 읽기 전에 제목이 인증 메일인 것을 앞으로 올린다. 본문(S3) 읽기는 `CANDIDATE_READ_LIMIT` 통이 상한이다.
 *     후보마다 `from_address`(로컬파트 + punycode 도메인)를 싣는다 — 공용 도메인에서 온 후보가 `noreply@` 인지 사용자 주소인지 에이전트가
 *     보게. 로컬파트가 비ASCII 거나 주소에 URL 표지가 든 메일은 싣지 않는다.
 *
 * 조회 한 번의 본문 읽기·추출에는 시간 예산(`EXTRACTION_BUDGET_MS`)이 있다 — 넘으면 남은 메일은 건너뛰고 경고 로그 한 줄(보안 H1 의 방어 한 겹).
 *
 * 수신 메일은 **`visibleToAgent` 를 거친 저장소로만** 읽는다(`inbound-read-store.ts` `listVerificationSources`) — 격리·정책으로 막은 메일은
 * 두 모드 모두 후보가 아니다. 이 파일은 원시 수신 저장소를 import 하지 않고 `inbound_messages` SQL 을 품지 않는다(arch `inbound-visibility` ②).
 *
 * 조회마다 로그 `verification.lookup {agent_id, outcome, detail: 모드}` 한 줄과 메트릭 `verificationLookups`(차원 `outcome`). 코드 값·URL·
 * 도메인은 로그·메트릭에 0 이다(Contributor Insights 규칙이 `agent_id` 로 센다 — D10 은 관측만).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 조회 전용이고 관문을 import 하지 않는다. 결과는 정책·발송·승인 입력이 아니다(ADR-0005).
 */

import { domainToASCII } from 'node:url';

import type { AgentId } from '../../db/schema';
import type { VerificationSource } from '../../db/repositories/inbound-read-store';
import {
  UNVERIFIED_CANDIDATES_WARNING,
  type VerificationLookupOutcome,
  type VerificationMode,
} from '../../mail/verification';
import {
  EXTRACTOR_VERSION,
  extractCodes,
  extractLinks,
  hostInScope,
  isVerificationSubject,
  isVerifiedModeSender,
  normalizeCode,
  type CodeCandidate,
  type MailText,
  type SenderScope,
} from '../../mail/verification/extract';
import { isHostname, isPublicSuffix, registrableDomain } from '../../mail/verification/public-suffix';
import { log } from '../../observability/logger';
import { ALARM_LOG_EVENTS, countMetric, emitMetric, METRIC_NAMES } from '../../observability/metrics';
import { authenticateRequest, authorizeRequest, claimedAgentOfQuery, targetAgentOf } from '../auth';
import { recordExposure } from '../exposure';
import { errorResponse, jsonResponse, queryOf, type ApiRequest, type ApiResponse } from '../http';
import { decodeParsedDocument, type InboundReadDependencies } from '../inbound-view';

/**
 * 인증코드 조회의 의존성 — 수신 조회 라우트와 같은 칸(`visibleToAgent` 를 거치는 저장소 · 파싱 문서 읽기 · 토큰 · 시계). `elapsedClock` 은
 * 추출 시간 예산을 재는 단조 시계(밀리초)다 — 없으면 `performance.now`(테스트만 바꾼다).
 */
export type VerificationCodeRouteDependencies = InboundReadDependencies & { readonly elapsedClock?: () => number };

/** 확정 모드 기본 기간. */
const VERIFIED_DEFAULT_WINDOW_MS = 15 * 60 * 1000;
/** 후보 모드 기본 기간이자 두 모드의 최대 기간. */
const MAX_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 확정 모드가 읽는 메일 수(본문). */
const VERIFIED_MAIL_LIMIT = 5;
/** 확정 모드가 제목으로 거르기 전에 보는 행 수(메타데이터만 — 본문을 읽지 않는다). */
const VERIFIED_SCAN_LIMIT = 50;
/** 후보 모드 결과의 메일 수. */
const CANDIDATE_MAIL_LIMIT = 5;
/** 후보 모드가 SQL 에서 받는 행 수(메타데이터만). */
const CANDIDATE_SCAN_LIMIT = 100;
/** 후보 모드 SQL 이 도메인별·정렬 전에 보는 최근 행 수 — 조회 비용의 상한. */
const CANDIDATE_RECENT_LIMIT = 1_000;
/** 후보 모드 SQL 의 발신 도메인당 행 수. */
const CANDIDATE_PER_DOMAIN = 3;
/** 후보 모드가 본문(S3)을 읽는 메일 수 상한. */
const CANDIDATE_READ_LIMIT = 10;
/** 조회 한 번의 본문 읽기·추출 시간 예산 — 넘으면 남은 메일은 건너뛴다. */
const EXTRACTION_BUDGET_MS = 2_000;
/** 후보 한 통에 싣는 코드 수. */
const CODES_PER_CANDIDATE = 3;
/** 본문(S3) 동시 읽기 수. */
const READ_CONCURRENCY = 5;
/** 기간 끝 — 시계 차이로 방금 받은 메일이 "미래" 가 되지 않게 조금 연다. */
const CLOCK_SKEW_MS = 60 * 1000;

/** 후보 모드에서 한 글자라도 URL 을 싣지 않기 위한 표지(AC-A1-5). */
const URL_MARKER = /http|:\/\//iu;

function badRequest(detail: string, error = 'invalid_request'): ApiResponse {
  return errorResponse(400, error, detail);
}

function record(agentId: AgentId, mode: VerificationMode, outcome: VerificationLookupOutcome): void {
  log('info', ALARM_LOG_EVENTS.verificationLookup, { agent_id: agentId, outcome, detail: mode });
  countMetric(METRIC_NAMES.verificationLookups, { outcome });
}

interface ReadMail {
  readonly source: VerificationSource;
  readonly mail: MailText;
}

/**
 * 본문 읽기·추출의 시간 예산. 조회마다 하나. `spent()` 가 참이면 남은 메일은 읽지도 훑지도 않는다 — 건너뛴 수는 조회 끝에 경고 로그로
 * 한 번(`verification.budget_exceeded`, 값 없이 개수만).
 */
interface Budget {
  readonly spent: () => boolean;
  skipped: number;
}

function startBudget(deps: VerificationCodeRouteDependencies): Budget {
  const clock = deps.elapsedClock ?? (() => performance.now());
  const started = clock();
  return { spent: () => clock() - started > EXTRACTION_BUDGET_MS, skipped: 0 };
}

function reportBudget(agentId: AgentId, mode: VerificationMode, budget: Budget): void {
  if (budget.skipped === 0) return;
  log('warn', 'verification.budget_exceeded', {
    route_id: 'verification-code',
    agent_id: agentId,
    detail: `${mode} skipped=${String(budget.skipped)}`,
  });
}

/**
 * 원천 행 → 파싱 문서(제목·본문) → `extract`. 읽지 못한 메일은 **건너뛰고** 로그에 id·오류 종류만 남긴다 — 한 통이 깨졌다고 조회 전체가
 * 500 이 되면 에이전트는 가입을 끝내지 못한다. 순서는 원천 순서 그대로. 예산을 넘으면 남은 원천은 읽지 않고 센다.
 */
async function readAndExtract<T>(
  deps: VerificationCodeRouteDependencies,
  sources: readonly VerificationSource[],
  budget: Budget,
  extract: (item: ReadMail) => T,
): Promise<T[]> {
  const out: (T | null)[] = new Array<T | null>(sources.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const index = next;
      next += 1;
      if (budget.spent()) {
        budget.skipped += 1;
        continue;
      }
      const source = sources[index] as VerificationSource;
      let mail: MailText;
      try {
        const body = decodeParsedDocument(await deps.artifacts.readParsed(source.parsedStorageKey));
        mail = { subject: body.subject, text: body.text, htmlText: body.htmlText };
      } catch (error) {
        log('warn', 'verification.source_unreadable', {
          route_id: 'verification-code',
          message_id: source.id,
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        continue;
      }
      if (budget.spent()) {
        budget.skipped += 1;
        continue;
      }
      out[index] = extract({ source, mail });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, sources.length) }, worker));
  return out.filter((item): item is T => item !== null);
}

export async function handleGetVerificationCode(deps: VerificationCodeRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  const now = deps.now();
  const authentication = await authenticateRequest(deps.tokens, request, now);
  if (authentication.kind === 'error') return authentication.response;

  // `agent_id` 생략 = 토큰의 에이전트(`auth.claimedAgentOfQuery`). 적었으면 형식 · 인가는 오늘과 같다.
  const claimed = claimedAgentOfQuery(request);
  if (claimed.kind === 'error') return claimed.response;
  const agentId = targetAgentOf(authentication.principal, claimed.agentId);
  const forbidden = authorizeRequest(authentication.principal, 'messages:read', agentId);
  if (forbidden !== null) return forbidden;

  const senderRaw = queryOf(request, 'sender_domain');
  const includeRaw = queryOf(request, 'include_subdomains');
  const sinceRaw = queryOf(request, 'since');

  let sender: { readonly domain: string; readonly includeSubdomains: boolean } | null = null;
  if (senderRaw !== null) {
    const domain = senderRaw.trim().toLowerCase().replace(/\.$/u, '');
    // 한 라벨(`kr`)은 호스트 이름 모양이 아니지만 "너무 넓다" 가 맞는 답이다 — 접미사 판정을 먼저 한다.
    const labelsOnly = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,126}$/u.test(domain);
    if (labelsOnly && isPublicSuffix(domain)) {
      return badRequest(
        `sender_domain=${domain} is a public suffix (anyone can register domains under it). Pass the site's own domain, such as github.com.`,
        'sender_domain_too_broad',
      );
    }
    if (!isHostname(domain)) return badRequest('sender_domain must be a host name, such as github.com.');
    // 공용 메일 도메인(`naver.com`)도 받는다 — 그 apex 에서 온 메일은 공급자 시스템 발신 주소만 본다(`isVerifiedModeSender`, 코드 N2).
    if (includeRaw !== null && includeRaw !== 'true' && includeRaw !== 'false') return badRequest('include_subdomains must be true or false.');
    sender = { domain, includeSubdomains: includeRaw === 'true' };
  } else if (includeRaw !== null) {
    return badRequest('include_subdomains can only be used with sender_domain.');
  }
  const mode: VerificationMode = sender === null ? 'unverified_candidates' : 'verified';

  let since = new Date(now.getTime() - (sender === null ? MAX_LOOKUP_WINDOW_MS : VERIFIED_DEFAULT_WINDOW_MS));
  if (sinceRaw !== null) {
    const parsed = new Date(sinceRaw);
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(sinceRaw) || Number.isNaN(parsed.getTime())) return badRequest('since must be an ISO 8601 time.');
    if (parsed.getTime() > now.getTime()) return badRequest('since is in the future.');
    if (now.getTime() - parsed.getTime() > MAX_LOOKUP_WINDOW_MS) return badRequest('since must be within the last 24 hours.');
    since = parsed;
  }
  const until = new Date(now.getTime() + CLOCK_SKEW_MS);

  return sender === null
    ? candidates(deps, agentId, since, until)
    : verified(deps, agentId, { since, until, sender, mode });
}

// ---------------------------------------------------------------------------
// 확정 모드
// ---------------------------------------------------------------------------

async function verified(
  deps: VerificationCodeRouteDependencies,
  agentId: AgentId,
  query: { readonly since: Date; readonly until: Date; readonly sender: { readonly domain: string; readonly includeSubdomains: boolean }; readonly mode: VerificationMode },
): Promise<ApiResponse> {
  const window = { since: query.since, until: query.until, sender: query.sender };
  const scope: SenderScope = { senderDomain: query.sender.domain, includeSubdomains: query.sender.includeSubdomains };
  // SQL 은 접미사 일치까지 — 등록 가능 경계(`hostInScope`)는 여기서. 본문을 읽기 전에 제목으로 거른다(보안 M2 · 코드 M5).
  const authenticated = (await deps.inbound.listVerificationSources(agentId, { ...window, authenticated: true, limit: VERIFIED_SCAN_LIMIT }))
    .filter((source) => hostInScope(source.fromDomain, scope));
  if (authenticated.length === 0) {
    const unauthenticated = (await deps.inbound.listVerificationSources(agentId, { ...window, authenticated: false, limit: VERIFIED_SCAN_LIMIT }))
      .filter((source) => hostInScope(source.fromDomain, scope));
    if (unauthenticated.length > 0) {
      record(agentId, query.mode, 'unauthenticated');
      return errorResponse(
        404,
        'no_verification_found',
        `Mail from ${query.sender.domain} arrived but failed sender authentication (DMARC), so its code is not returned as verified.`,
      );
    }
    record(agentId, query.mode, 'not_found');
    return errorResponse(404, 'no_verification_found', `No verification email from ${query.sender.domain} in this time range.`);
  }
  const subjectOk = authenticated.filter((source) => isVerificationSubject(source.subject));
  if (subjectOk.length === 0) {
    record(agentId, query.mode, 'not_found');
    return errorResponse(
      404,
      'no_verification_found',
      `Mail from ${query.sender.domain} arrived, but its subject does not look like a verification email, so codes in its body are not returned.`,
    );
  }
  // 발신 주소 문 — 알림형 로컬파트(보안 R1)와 공용 apex 의 사용자 주소(코드 N2)는 조용히 뺀다. 400 이 아니라 남은 것이 없으면 404.
  const sources = subjectOk.filter((source) => isVerifiedModeSender(source.fromAddress)).slice(0, VERIFIED_MAIL_LIMIT);
  if (sources.length === 0) {
    record(agentId, query.mode, 'not_found');
    return errorResponse(
      404,
      'no_verification_found',
      `A verification email from ${query.sender.domain} came from a notification address or a personal address on a shared mail domain, ` +
        "not from the site's own sender, so its code is not returned as verified.",
    );
  }

  const budget = startBudget(deps);
  const extracted = await readAndExtract(deps, sources, budget, (item) => ({
    ...item,
    high: extractCodes(item.mail).filter((code) => code.confidence === 'high'),
    links: extractLinks(item.mail, scope),
  }));
  reportBudget(agentId, query.mode, budget);
  const dropped = extracted.reduce((sum, item) => sum + item.links.droppedHostMismatch, 0);
  if (dropped > 0) emitMetric(METRIC_NAMES.verificationLinksDroppedHostMismatch, dropped, 'Count');

  const distinct = new Set(extracted.flatMap((item) => item.high.map((code) => normalizeCode(code.value))));
  if (distinct.size > 1) {
    record(agentId, query.mode, 'ambiguous');
    return jsonResponse(409, {
      error: 'ambiguous',
      detail: 'Several emails contain different verification codes. Narrow since, or read the newest email with read_email.',
      candidate_message_ids: extracted.filter((item) => item.high.length > 0).map((item) => item.source.id),
    });
  }

  // 코드가 하나로 모이면 그 코드가 든 가장 최근 메일, 코드가 없으면 인증 링크가 있는 가장 최근 메일.
  const chosen = distinct.size === 1 ? extracted.find((item) => item.high.length > 0) : extracted.find((item) => item.links.links.length > 0);
  if (chosen === undefined) {
    record(agentId, query.mode, 'not_found');
    return errorResponse(404, 'no_verification_found', `No verification code or confirmation link was found in recent mail from ${query.sender.domain}.`);
  }
  // ADR-0016 A·B — 코드를 돌려주기 **전에** 노출과 코드 지문을 기록한다(실패 503). 지문은 발신 DLP `verification_code` 만 쓴다(좁히기만, ADR-0013 개정).
  const code = chosen.high[0]?.value ?? null;
  const refused = await recordExposure(
    deps.exposures,
    agentId,
    'verification_code',
    [{ inboundMessageId: chosen.source.id, part: 'verification_code', field: 'verification_code', content: null }],
    code === null ? [] : [{ inboundMessageId: chosen.source.id, code }],
  );
  if (refused !== null) return refused;
  record(agentId, query.mode, 'found');
  return jsonResponse(200, {
    mode: 'verified',
    verified: true,
    inbound_message_id: chosen.source.id,
    received_at: chosen.source.receivedAt.toISOString(),
    from_address: chosen.source.fromAddress,
    from_domain: chosen.source.fromDomain,
    code,
    links: chosen.links.links.map((link) => ({ url: link.url, kind: link.kind })),
    extractor_version: EXTRACTOR_VERSION,
  });
}

// ---------------------------------------------------------------------------
// 후보 모드
// ---------------------------------------------------------------------------

/** 후보 모드의 `from_domain` 표기 — 비ASCII 는 punycode(`xn--`). 변환이 안 되는 값은 싣지 않는다(`null`). */
function asciiDomain(domain: string): string | null {
  let ascii = true;
  for (let index = 0; index < domain.length; index += 1) if (domain.charCodeAt(index) > 0x7f) ascii = false;
  if (ascii) return domain;
  const converted = domainToASCII(domain);
  return converted === '' ? null : converted;
}

/**
 * SQL 은 `from_domain` 마다 `CANDIDATE_PER_DOMAIN` 통으로 자른다 — 하위 도메인을 돌려 쓰면(`a1.spam.example`·`a2.spam.example` …) 그 상한을
 * 피한다. 그래서 **등록 가능 도메인**으로 다시 묶어 도메인당 같은 수로 줄인다(보안 N1). 순서(DMARC pass 먼저 · 최근 것부터)는 그대로다.
 * 등록 가능 도메인이 없는 값(접미사 자체)은 그 값으로 묶는다.
 */
function limitPerRegistrableDomain(sources: readonly VerificationSource[]): VerificationSource[] {
  const counts = new Map<string, number>();
  return sources.filter((source) => {
    const key = registrableDomain(source.fromDomain) ?? source.fromDomain;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= CANDIDATE_PER_DOMAIN;
  });
}

/** 후보 모드의 `from_address` — 로컬파트는 ASCII 만(비ASCII 면 `null`), 도메인은 `asciiDomain`. */
function asciiAddress(fromAddress: string, fromDomain: string): string | null {
  const local = fromAddress.slice(0, fromAddress.lastIndexOf('@'));
  if (local.length === 0 || !/^[\x21-\x7e]+$/u.test(local)) return null;
  return `${local}@${fromDomain}`;
}

/** 본문을 읽을 순서 — DMARC pass 먼저, 그 안에서 제목이 인증 메일인 것 먼저, 그 안에서 원천 순서(최근 것부터). */
function readOrder(sources: readonly VerificationSource[]): VerificationSource[] {
  const rank = (source: VerificationSource): number => (source.fromAuthenticated ? 0 : 2) + (isVerificationSubject(source.subject) ? 0 : 1);
  return sources
    .map((source, index) => ({ source, index, rank: rank(source) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.source);
}

async function candidates(deps: VerificationCodeRouteDependencies, agentId: AgentId, since: Date, until: Date): Promise<ApiResponse> {
  const mode: VerificationMode = 'unverified_candidates';
  const sources = await deps.inbound.listVerificationSources(agentId, {
    since,
    until,
    sender: null,
    authenticated: null,
    limit: CANDIDATE_SCAN_LIMIT,
    recentLimit: CANDIDATE_RECENT_LIMIT,
    perDomainLimit: CANDIDATE_PER_DOMAIN,
    authenticatedFirst: true,
  });
  const order = readOrder(limitPerRegistrableDomain(sources)).slice(0, CANDIDATE_READ_LIMIT);
  const budget = startBudget(deps);
  const picked: {
    readonly source: VerificationSource;
    readonly fromAddress: string;
    readonly fromDomain: string;
    readonly codes: readonly CodeCandidate[];
  }[] = [];
  // 본문은 `READ_CONCURRENCY` 통씩 읽고, 후보가 다 차면 멈춘다(S3 읽기 수를 줄인다).
  for (let offset = 0; offset < order.length && picked.length < CANDIDATE_MAIL_LIMIT; offset += READ_CONCURRENCY) {
    const batch = await readAndExtract(deps, order.slice(offset, offset + READ_CONCURRENCY), budget, (item) => ({
      source: item.source,
      codes: extractCodes(item.mail)
        .filter((code) => !URL_MARKER.test(code.value))
        .slice(0, CODES_PER_CANDIDATE),
    }));
    for (const item of batch) {
      if (picked.length >= CANDIDATE_MAIL_LIMIT) break;
      const fromDomain = asciiDomain(item.source.fromDomain);
      // 도메인·주소에 URL 표지가 있으면 그 메일은 싣지 않는다 — 응답 전체에 `http`·`://` 0(AC-A1-5).
      if (fromDomain === null || URL_MARKER.test(fromDomain)) continue;
      const fromAddress = asciiAddress(item.source.fromAddress, fromDomain);
      if (fromAddress === null || URL_MARKER.test(fromAddress)) continue;
      if (item.codes.length > 0) picked.push({ source: item.source, fromAddress, fromDomain, codes: item.codes });
    }
    if (budget.spent()) break;
  }
  reportBudget(agentId, mode, budget);
  if (picked.length === 0) {
    record(agentId, mode, 'not_found');
    return errorResponse(404, 'no_verification_found', 'No email in this time range contains a verification code.');
  }
  // DMARC pass 먼저, 각 무리 안에서는 최근 것부터.
  const ordered = [...picked].sort(
    (a, b) =>
      Number(b.source.fromAuthenticated) - Number(a.source.fromAuthenticated) ||
      b.source.receivedAt.getTime() - a.source.receivedAt.getTime() ||
      (a.source.id < b.source.id ? 1 : a.source.id > b.source.id ? -1 : 0),
  );
  // ADR-0016 A·B — 후보를 돌려주기 **전에** 노출과 후보 코드의 지문을 기록한다(실패 503).
  const refused = await recordExposure(
    deps.exposures,
    agentId,
    'verification_code',
    ordered.map((item) => ({ inboundMessageId: item.source.id, part: 'verification_code' as const, field: 'verification_code' as const, content: null })),
    ordered.flatMap((item) => item.codes.map((candidate) => ({ inboundMessageId: item.source.id, code: candidate.value }))),
  );
  if (refused !== null) return refused;
  record(agentId, mode, 'candidates');
  return jsonResponse(200, {
    mode,
    verified: false,
    warning: UNVERIFIED_CANDIDATES_WARNING,
    unverified_candidates: ordered.map((item) => ({
      inbound_message_id: item.source.id,
      received_at: item.source.receivedAt.toISOString(),
      from_address: item.fromAddress,
      from_domain: item.fromDomain,
      dmarc: item.source.fromAuthenticated ? 'pass' : 'fail',
      unverified_code_candidates: item.codes.map((code) => ({ value: code.value, confidence: code.confidence })),
    })),
    extractor_version: EXTRACTOR_VERSION,
  });
}
