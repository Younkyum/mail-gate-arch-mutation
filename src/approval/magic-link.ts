/**
 * src/approval/magic-link.ts — 서명된 승인 링크 (계획 §3.4 5조 "알림 경로").
 *
 * *"승인 요청 발생 시 소유자 이메일로 서명된 매직링크 1통. 링크는 승인/거절 버튼
 * 2개만 있는 정적 페이지. 토큰은 HMAC 서명 + 단일 사용 + `approval_ttl` 과 동일 만료."*
 *
 * 이 링크는 **소유자 메일함에 떨어지는 문자열 하나로 발송을 풀어 주는 권한**이다.
 * 제품의 주력 정책(approval)이 이 한 장에 걸려 있으므로 설계를 위협 모델에서 시작한다.
 *
 * ===========================================================================
 * ## 위협 모델
 * ===========================================================================
 *
 * | # | 위협 | 대응 | 고정하는 테스트 |
 * |---|---|---|---|
 * | T1 | **위조** — 공격자가 approval id 를 알거나 추측해 토큰을 만든다 | HMAC-SHA256(서버 키). 서명 비교는 `timingSafeEqual` | `magic-link.test.ts` 위조·변조 |
 * | T2 | **재사용** — 같은 링크로 두 번(승인 후 다시, 또는 승인과 거절 둘 다) | `approval_link_uses` 에 **approval 당 1행** 유니크 인덱스. 서명만으로는 막을 수 없다 | 단위(가짜 tx) + 통합(실제 PG 동시 2회) |
 * | T3 | **메일 스캐너의 선제 GET** (Safe Links·Proofpoint 가 링크를 먼저 연다) | **GET 은 상태를 바꾸지 않는다.** 토큰은 URL **fragment**(`#`)에 실려 서버로 가지도 않는다. 상태 변경은 **POST 뿐** | GET 이 포트에 **0회 접근**(Proxy 로 단언) + GET 뒤에도 POST 가 성공(링크가 태워지지 않음) |
 * | T4 | **만료 우회** — 토큰 만료만 믿거나 DB 만료만 믿는다 | 토큰에 `expires_at` 을 싣고(ms), DB 의 `approval_requests.expires_at` 과 **둘 다** 확인 + **두 값이 같아야** 통과 | 만료 3종(토큰·DB·불일치) |
 * | T5 | **키 유출/회전** | `kid` 를 토큰에 싣고 서명 범위에 포함. 키 묶음(`hmac-keyring.ts`)이 여럿을 검증 | 구 키 검증·미지 kid 거부·kid 바꿔치기 거부 |
 * | T6 | **로그 유출** — 토큰이 URL 에 있으므로 URL 을 찍으면 샌다 | ① fragment 라 서버 접근 로그·Referer 에 안 실림 ② `logger.redact` 가 `atk_*_` 토큰 형태를 값에서 지운다 ③ 이 모듈은 로그를 쓰지 않는다 | `logger.test.ts` 토큰 치환 |
 * | T7 | **인코딩 가변성** — base64 끝 비트를 바꾼 다른 문자열이 같은 바이트로 풀려 "다른 토큰" 행세 | 비정규 base64url 거부 + 단일 사용 키는 문자열이 아니라 **서명된 `jti`** 의 해시 | 끝 문자 변조 거부 |
 * | T8 | **DB 유출** | 평문 토큰을 저장하지 않는다. `jti` 의 sha256 만 저장 — 서명 키 없이는 토큰을 복원할 수 없다 | 스키마(평문 컬럼 부재) |
 *
 * **남는 위험(알고 받는다):** JS 를 실행하고 **폼 버튼까지 누르는** 샌드박스형 스캐너.
 * 실측 사례가 드물고, 누르더라도 `decision` 을 스스로 골라야 한다(기본값이 없다 — 누락은
 * 400). P5 의 로그인된 대시보드가 이 경로를 대체한다.
 *
 * ===========================================================================
 * ## 판단: 토큰 하나 + POST 본문의 `decision` (행동별 토큰 2개가 아니다)
 * ===========================================================================
 *
 * 행동별 토큰은 권한을 **나누지 못한다** — 두 링크가 같은 메일에 같은 사람에게 간다.
 * 그런데 단일 사용은 **approval 단위**여야 한다(승인 토큰을 쓴 뒤 거절 토큰이 통하면
 * 안 된다). 그러면 두 토큰이 결국 "approval 당 1회" 라는 같은 제약을 공유해야 하고,
 * 그것은 토큰 하나 + approval 유니크와 같은 물건이다. 링크 표면만 두 배가 된다.
 * 그래서 토큰은 **"이 approval 을 결정할 권한"** 이고, 무엇으로 결정하는지는 사람이
 * 누른 버튼(POST 의 `decision`)이 정한다.
 *
 * ===========================================================================
 * ## 판단: 미리보기(POST, 읽기 전용) → 결정(POST, 단일 사용) 2단계
 * ===========================================================================
 *
 * 사람이 **무엇을 승인하는지** 모르면 승인 버튼은 서명 도장일 뿐이다. 그런데 GET 페이지는
 * 정적이고(T3) 토큰은 fragment 에 있어 서버가 GET 에서 approval 을 **알 수 없다.** 그래서
 * 페이지의 스크립트가 fragment 의 토큰으로 `intent=preview` 를 POST 해 요청의 내용(발신 에이전트·
 * 발신 주소·수신자·건수·만료)을 받아 그린다. 결정은 그 다음, 사람이 버튼을 눌러야 일어난다.
 *
 * **미리보기는 단일 사용을 소비하지 않는다** — 트랜잭션도 행 잠금도 `recordUse` 도 없는 읽기다
 * (`ApprovalLinkPorts.findApprovalSummary`). 소비하면 사람이 결정 버튼을 누를 때 "이미 사용됨" 이
 * 나오고, JS 를 실행하는 스캐너가 페이지를 열기만 해도 링크가 탄다(T3 의 사고를 미리보기가 재현한다).
 * 대신 미리보기도 **서명·만료·일치를 결정과 똑같이** 확인한다 — 유효한 토큰의 소지자만 내용을 본다.
 * 수신자 주소가 응답에 실리는 이유: 그 주소가 곧 승인하면 열리는 관계이고, 소유자는 그것을 보고
 * 결정해야 한다. 응답은 `no-store` 이고 이 모듈은 로그를 쓰지 않는다(T6).
 *
 * 버튼은 미리보기가 성공하기 전까지 `disabled` 다 — 내용을 못 본 채로 누를 수 없게. 서버는 결정 POST 에
 * 미리보기를 **요구하지 않는다**(요구할 수단이 없다 — 상태가 없는 페이지다). 막는 것은 UI 이고, 결정의
 * 안전은 여전히 서명·단일 사용·만료가 진다.
 *
 * **스코프 (AC-d5).** 승인 폼은 `scope`(기본 `recipient`)와 `confirm_scope` 를 싣는다. `domain` 은
 * 체크박스로 **따로** 확인해야 하고, 확인 없이 오면 400 이다 — ① 이 파일이 트랜잭션을 열기 전에
 * ② 서비스(`DomainScopeConfirmationRequiredError`)가 전이 안에서 ③ DB CHECK 가 관계 INSERT 에서.
 * ②에서 막히면 트랜잭션이 롤백되므로 **링크는 소진되지 않는다** — 소유자는 좁은 스코프로 다시 누를 수 있다.
 *
 * ===========================================================================
 * ## 배선 — 이 파일은 라우트도 트랜잭션도 만들지 않는다
 * ===========================================================================
 *
 * - `handleApprovalLinkRequest` 를 라우트에 붙인다(GET/HEAD/POST 한 경로) — `src/api/routes/approval-link.ts`.
 * - 포트의 Postgres 구현은 `src/db/repositories/approval-link-use-store.ts` 의 `createPostgresApprovalLinkPorts`.
 * - `ApprovalLinkPorts.runInTransaction` 은 **하나의 DB 트랜잭션**이어야 한다 —
 *   `recordUse` 와 approval 상태 전이(`resolveApproval`)가 함께 커밋되거나 함께 롤백돼야
 *   "링크는 썼는데 승인은 안 된" 상태(=링크 소진, 결정 없음)가 생기지 않는다.
 * - 링크 발급은 `buildApprovalLinkUrl(pageUrl, mintApprovalLinkToken(...))`.
 *   `expiresAt` 은 **`approval_requests.expires_at` 에서 읽은 값 그대로**여야 한다.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { RelationshipScope } from '../db/schema';
import {
  AGENT_NAME_MAX_CHARS,
  ATTACHMENT_NAME_MAX_CHARS,
  MAX_ATTACHMENT_NAMES_SHOWN,
  RECIPIENT_MAX_CHARS,
  sanitizeDisplayText,
} from '../notify/approval-notification-template';
import { activeKey, decodeCanonicalBase64Url, type HmacKeyring } from '../security/hmac-keyring';
import { orderedRiskReasons, RISK_COPY, RISK_REASON_COPY, RISK_REASON_ORDER } from './risk-copy';

// ---------------------------------------------------------------------------
// 형식
// ---------------------------------------------------------------------------

/**
 * 토큰 접두사. **분류자이지 비밀이 아니다** — `atk_agent_` 와 같은 이유로 둔다.
 * `logger.redact` 가 `atk_<종류>_` 형태를 값에서 지우므로, 접두사를 바꾸면 그 치환도
 * 함께 확인하라.
 */
export const APPROVAL_LINK_TOKEN_PREFIX = 'atk_link_';

/**
 * 서명 문맥(domain separation). 같은 키가 다른 용도로 쓰였을 때 한쪽 서명이 다른 쪽에서
 * 통하지 않게 한다. 버전이 바뀌면 문자열을 바꾼다.
 */
const SIGNING_CONTEXT = 'atmark.approval-link.v1';

/** `jti` 바이트 수. 128비트 — 추측이 아니라 **충돌**을 막는 눈금이다(유니크 인덱스의 키). */
const TOKEN_ID_BYTES = 16;

/** HMAC-SHA256 출력 길이. */
const SIGNATURE_BYTES = 32;

/** 입력 상한. 파싱 전에 자른다 — 임의 길이 문자열로 HMAC·JSON 파서를 때리지 않는다. */
const MAX_TOKEN_LENGTH = 512;

/** `approval_requests.id` 는 uuid 다(`audit_logs.approval_id uuid` 와 같은 축). 정규형 소문자만. */
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TOKEN_PATTERN = /^atk_link_([a-z0-9]{1,16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export type ApprovalLinkDecision = 'approve' | 'reject';

/** 서명이 확인된 뒤에만 존재하는 값. */
export interface ApprovalLinkClaims {
  readonly approvalId: string;
  /** `approval_requests.expires_at` 과 **같아야** 한다(ms 정밀도). */
  readonly expiresAt: Date;
  /** 단일 사용의 키. DB 에는 이것의 sha256 만 들어간다. */
  readonly tokenIdHash: string;
  /** 서명한 키. 회전 사고 조사용으로 사용 기록에 남긴다. */
  readonly keyId: string;
}

export class ApprovalLinkMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalLinkMintError';
  }
}

function sign(key: Buffer, kid: string, payload: string): Buffer {
  // `kid` 가 서명 범위 **안**에 있어야 한다. 밖에 있으면 공격자가 kid 만 바꿔 다른 키로
  // 검증되게 만들 수 있다(그 키로 서명이 맞을 리는 없지만, 검증 경로가 입력에 의해 고정되는
  // 것 자체를 허용하지 않는다).
  return createHmac('sha256', key).update(`${SIGNING_CONTEXT}\n${kid}\n${payload}`, 'utf8').digest();
}

/**
 * 토큰 발급. **평문은 반환값에만 존재한다** — 메일 본문으로 가고, 저장·로깅하지 않는다.
 *
 * `random` 은 테스트 이음매다(결정적 jti). 프로덕션 호출자는 넘기지 않는다.
 */
export function mintApprovalLinkToken(
  keyring: HmacKeyring,
  approval: { readonly approvalId: string; readonly expiresAt: Date },
  random: (size: number) => Buffer = randomBytes,
): string {
  if (!APPROVAL_ID_PATTERN.test(approval.approvalId)) {
    throw new ApprovalLinkMintError('approvalId 는 정규형 uuid 여야 한다');
  }
  const expiresAtMs = approval.expiresAt.getTime();
  if (!Number.isSafeInteger(expiresAtMs)) throw new ApprovalLinkMintError('expiresAt 이 유효한 시각이 아니다');

  const { kid, key } = activeKey(keyring);
  const payload = Buffer.from(
    JSON.stringify({ a: approval.approvalId, e: expiresAtMs, j: random(TOKEN_ID_BYTES).toString('base64url') }),
    'utf8',
  ).toString('base64url');
  const signature = sign(key, kid, payload).toString('base64url');
  return `${APPROVAL_LINK_TOKEN_PREFIX}${kid}.${payload}.${signature}`;
}

/**
 * 링크 URL. 토큰은 **fragment** 에 싣는다 (위협 T3·T6).
 *
 * fragment 는 브라우저가 서버로 보내지 않는다. 그래서 ① 메일 스캐너가 GET 을 해도
 * 서버는 토큰을 **보지도 못하고** ② 접근 로그·CDN 로그·`Referer` 에 토큰이 남지 않는다.
 * 정적 페이지의 스크립트가 fragment 를 읽어 폼에 넣고, 사람이 버튼을 눌러야 POST 된다.
 */
export function buildApprovalLinkUrl(pageUrl: string, token: string): string {
  const url = new URL(pageUrl);
  if (url.protocol !== 'https:') throw new ApprovalLinkMintError('승인 페이지는 https 여야 한다');
  if (url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new ApprovalLinkMintError('승인 페이지 URL 에 fragment·자격증명이 있으면 안 된다');
  }
  if (!TOKEN_PATTERN.test(token)) throw new ApprovalLinkMintError('토큰 형식이 아니다');
  return `${url.href}#${token}`;
}

// ---------------------------------------------------------------------------
// 검증 (DB 없이)
// ---------------------------------------------------------------------------

export type ApprovalLinkTokenRejection = 'malformed' | 'unknown_key' | 'bad_signature' | 'expired';

export type ApprovalLinkVerification =
  | { readonly kind: 'valid'; readonly claims: ApprovalLinkClaims }
  | { readonly kind: 'rejected'; readonly reason: ApprovalLinkTokenRejection };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 토큰 → 클레임. **서명을 먼저 확인하고 그 다음에야 페이로드를 JSON 으로 푼다** —
 * 서명되지 않은 공격자 입력을 파서에 먹이지 않는다.
 */
export function verifyApprovalLinkToken(
  keyring: HmacKeyring,
  token: string,
  now: Date,
): ApprovalLinkVerification {
  if (token.length > MAX_TOKEN_LENGTH) return { kind: 'rejected', reason: 'malformed' };
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) return { kind: 'rejected', reason: 'malformed' };
  const [, kid = '', payload = '', encodedSignature = ''] = match;

  const key = keyring.keys.get(kid);
  if (key === undefined) return { kind: 'rejected', reason: 'unknown_key' };

  // 비정규 base64url(끝 비트 변조)은 같은 바이트로 풀리는 **다른 문자열**이다 — 위협 T7.
  const provided = decodeCanonicalBase64Url(encodedSignature);
  if (provided === null || provided.length !== SIGNATURE_BYTES) return { kind: 'rejected', reason: 'malformed' };
  if (decodeCanonicalBase64Url(payload) === null) return { kind: 'rejected', reason: 'malformed' };

  const expected = sign(key, kid, payload);
  // 길이는 위에서 이미 32로 맞췄다 — `timingSafeEqual` 은 길이가 다르면 던진다.
  if (!timingSafeEqual(expected, provided)) return { kind: 'rejected', reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { kind: 'rejected', reason: 'malformed' };
  }
  // 서명이 맞았는데 형식이 틀리면 **우리가 만든 것이 아니거나 버전이 다르다.** 관대하게 읽지 않는다.
  if (!isPlainRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'a,e,j') {
    return { kind: 'rejected', reason: 'malformed' };
  }
  const { a, e, j } = parsed;
  if (typeof a !== 'string' || !APPROVAL_ID_PATTERN.test(a)) return { kind: 'rejected', reason: 'malformed' };
  if (typeof e !== 'number' || !Number.isSafeInteger(e)) return { kind: 'rejected', reason: 'malformed' };
  if (typeof j !== 'string') return { kind: 'rejected', reason: 'malformed' };
  const tokenId = decodeCanonicalBase64Url(j);
  if (tokenId === null || tokenId.length !== TOKEN_ID_BYTES) return { kind: 'rejected', reason: 'malformed' };

  // 경계는 `<=` — 만료 시각 정각은 이미 만료다(`agent-token.ts` 와 같은 규약).
  if (e <= now.getTime()) return { kind: 'rejected', reason: 'expired' };

  return {
    kind: 'valid',
    claims: {
      approvalId: a,
      expiresAt: new Date(e),
      tokenIdHash: createHash('sha256').update(tokenId).digest('hex'),
      keyId: kid,
    },
  };
}

// ---------------------------------------------------------------------------
// 사용 (DB — 포트 뒤)
// ---------------------------------------------------------------------------

/** 링크가 가리키는 approval 에 대해 이 모듈이 알아야 하는 전부. */
export interface ApprovalLinkTarget {
  /** 아직 결정되지 않았는가. 만료·승인·거절은 전부 `resolved` 다. */
  readonly state: 'pending' | 'resolved';
  /** `approval_requests.expires_at`. */
  readonly expiresAt: Date;
}

/** `approval_link_uses` 한 행. **평문 토큰이 없다.** */
export interface ApprovalLinkUse {
  readonly approvalId: string;
  readonly tokenIdHash: string;
  readonly keyId: string;
  readonly decision: ApprovalLinkDecision;
  readonly usedAt: Date;
}

/** 결정에 딸린 것 — 승인 스코프(AC-d5)와, 결정자 표기에 쓰는 서명 키. */
export interface ApprovalLinkResolution {
  /** 승인일 때만 뜻이 있다. 기본 `recipient`(§3.4 2조). */
  readonly scope: RelationshipScope;
  /** `domain` 스코프의 소유자 확인. 폼의 체크박스가 **따로** 싣는다. */
  readonly confirmScope: RelationshipScope | null;
  /** 이 링크를 서명한 키. 결정자는 "이 키로 서명된 소유자 링크의 소지자" 다. */
  readonly keyId: string;
}

/** 한 트랜잭션 안에서 보이는 것. 구현은 전부 **같은 커넥션**이어야 한다. */
export interface ApprovalLinkTransaction {
  /** 행 잠금(`FOR UPDATE`)으로 읽는다 — 동시 POST 가 같은 상태를 보고 둘 다 진행하지 않게. */
  findApprovalForUpdate(approvalId: string): Promise<ApprovalLinkTarget | null>;
  /** 단일 사용의 집행. 유니크 인덱스가 판정한다 — 선조회가 아니다. */
  recordUse(use: ApprovalLinkUse): Promise<'recorded' | 'already_used'>;
  /**
   * approval 상태 전이 + 웹훅 enqueue. `src/approval/service.ts` 의 몫.
   *
   * 전이에 지면 `ApprovalLinkTransitionLostError` 를, 스코프가 거부되면 `ApprovalLinkScopeError` 를
   * **던진다** — 반환하면 커밋되고, 그러면 "링크는 썼는데 결정은 없다" 가 된다.
   */
  resolveApproval(
    approvalId: string,
    decision: ApprovalLinkDecision,
    now: Date,
    resolution: ApprovalLinkResolution,
  ): Promise<void>;
}

/** 미리보기가 보여 줄 것 — 사람이 "무엇을 승인하는가" 를 아는 데 필요한 최소. 본문은 없다. */
export interface ApprovalLinkSummary extends ApprovalLinkTarget {
  readonly subject: 'message' | 'batch';
  readonly agentName: string;
  /** 항목들의 발신 주소(중복 제거, 원문). */
  readonly fromAddresses: readonly string[];
  /** 항목들의 수신자(중복 제거, 원문). 승인하면 이 상대들과의 관계가 열린다. */
  readonly recipients: readonly string[];
  /** 이 요청이 덮는 발송 시도 수(배치면 여럿). */
  readonly attemptCount: number;
  /**
   * 항목들의 첨부 요약(메일 기본기 2차 · 보안 리뷰 L5) — 개수 · 총 바이트 · 파일명(원문, 자리 순). 소유자가 무엇이 붙었는지 보고 결정한다.
   * 없으면 첨부 없음으로 본다.
   */
  readonly attachments?: { readonly count: number; readonly bytes: number; readonly names: readonly string[] };
  /**
   * 위험 보류 사유(ADR-0016 — `tainted_context`·`dlp_*` 닫힌 코드). 비어 있지 않으면 페이지가 고정 경고를 보이고 범위 선택을 숨긴다 — 승인은 `once`
   * 다(서비스가 강제한다). 없으면 위험 보류가 아니다.
   */
  readonly riskReasons?: readonly string[];
}

export interface ApprovalLinkPorts {
  readonly keyring: HmacKeyring;
  /** `work` 가 던지면 롤백한다. 반환하면 커밋한다. */
  runInTransaction<T>(work: (tx: ApprovalLinkTransaction) => Promise<T>): Promise<T>;
  /**
   * 미리보기용 읽기. **트랜잭션·잠금·사용 기록이 없다** — 이 함수가 무엇을 하든 링크는 소진되지 않는다.
   */
  findApprovalSummary(approvalId: string): Promise<ApprovalLinkSummary | null>;
}

/** 전이에 졌다(그 사이 만료·다른 결정이 이겼다). 트랜잭션을 롤백시켜 사용 기록도 되돌린다. */
export class ApprovalLinkTransitionLostError extends Error {
  constructor(readonly approvalId: string) {
    super(`승인 요청 전이에 졌다 (approvalId=${approvalId})`);
    this.name = 'ApprovalLinkTransitionLostError';
  }
}

/**
 * 승인 스코프 거부(AC-d5 · thread 부재) 또는 조직 정지·동결 중 승인(L-A). 트랜잭션을 롤백시켜 링크를 소진하지 않는다 —
 * 정지를 푼 뒤 같은 링크로 다시 승인할 수 있다.
 */
export class ApprovalLinkScopeError extends Error {
  constructor(
    readonly reason: 'scope_confirmation_required' | 'scope_unavailable' | 'organization_paused' | 'organization_not_active' | 'agent_deleted',
  ) {
    super(`승인 스코프 거부: ${reason}`);
    this.name = 'ApprovalLinkScopeError';
  }
}

export type ApprovalLinkRejection =
  | ApprovalLinkTokenRejection
  | 'unknown_approval'
  | 'expiry_mismatch'
  | 'already_resolved'
  | 'already_used'
  | 'scope_confirmation_required'
  | 'scope_unavailable'
  | 'organization_paused'
  /** 운영자 검토 전·거절 조직(셀프 가입). 정지와 같은 처리 — 409, 링크 미소진, 활성화 뒤 같은 링크로 승인. */
  | 'organization_not_active'
  /** 삭제한 에이전트(202610131000) — 409. 승인은 성립하지 않는다(되돌릴 수 없으니 다시 시도할 것도 없다). 거절은 된다. */
  | 'agent_deleted';

/** 결정 요청. `scope`·`confirmScope` 를 생략하면 `recipient`·확인 없음이다. */
export interface ApprovalLinkRedeemRequest {
  readonly token: string;
  readonly decision: ApprovalLinkDecision;
  readonly scope?: RelationshipScope;
  readonly confirmScope?: RelationshipScope | null;
}

/** 대상 판정 — 미리보기와 결정이 **같은 규칙**을 쓴다(미리보기가 느슨하면 만료된 요청의 내용이 샌다). */
function judgeTarget(
  target: ApprovalLinkTarget | null,
  claims: ApprovalLinkClaims,
  now: Date,
): ApprovalLinkRejection | null {
  if (target === null) return 'unknown_approval';
  if (target.state !== 'pending') return 'already_resolved';
  if (target.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (target.expiresAt.getTime() !== claims.expiresAt.getTime()) return 'expiry_mismatch';
  return null;
}

export type ApprovalLinkRedemption =
  | { readonly kind: 'redeemed'; readonly approvalId: string; readonly decision: ApprovalLinkDecision }
  | { readonly kind: 'rejected'; readonly reason: ApprovalLinkRejection };

/**
 * 토큰을 쓴다. **상태를 바꾸는 유일한 함수이며, POST 에서만 불린다.**
 *
 * 판정 순서의 이유:
 *   1. 서명·형식·토큰 만료 — **DB 에 닿기 전에.** 위조 토큰으로 DB 를 두드리지 못하게.
 *   2. DB 의 approval — 존재·상태·만료. 토큰 만료만 믿지 않는다(위협 T4).
 *   3. 두 만료의 **일치** — 토큰은 "이 approval 의 이 만료" 에 대해 발급됐다. 다르면 다른
 *      시점의 발급물이거나 TTL 이 바뀐 것이고, 어느 쪽이든 관대하게 읽지 않는다.
 *   4. `recordUse` — 단일 사용. 동시 두 요청 중 하나만 `recorded` 다.
 *   5. `resolveApproval` — 같은 트랜잭션. 던지면 4도 롤백된다.
 */
export async function redeemApprovalLink(
  ports: ApprovalLinkPorts,
  request: ApprovalLinkRedeemRequest,
  now: Date,
): Promise<ApprovalLinkRedemption> {
  const verification = verifyApprovalLinkToken(ports.keyring, request.token, now);
  if (verification.kind === 'rejected') return verification;
  const { claims } = verification;

  const scope = request.scope ?? 'recipient';
  const confirmScope = request.confirmScope ?? null;
  // AC-d5 1차 — 트랜잭션을 열기 전에. 서비스(2차)·DB CHECK(3차)가 뒤에 있지만, 확인 없는 도메인 승인이
  // 행 잠금을 잡을 이유는 없다. 거절에는 스코프가 없다(관계를 만들지 않는다).
  if (request.decision === 'approve' && scope === 'domain' && confirmScope !== 'domain') {
    return { kind: 'rejected', reason: 'scope_confirmation_required' };
  }

  try {
    return await ports.runInTransaction(async (tx): Promise<ApprovalLinkRedemption> => {
      const rejection = judgeTarget(await tx.findApprovalForUpdate(claims.approvalId), claims, now);
      if (rejection !== null) return { kind: 'rejected', reason: rejection };

      const recorded = await tx.recordUse({
        approvalId: claims.approvalId,
        tokenIdHash: claims.tokenIdHash,
        keyId: claims.keyId,
        decision: request.decision,
        usedAt: now,
      });
      if (recorded === 'already_used') return { kind: 'rejected', reason: 'already_used' };

      await tx.resolveApproval(claims.approvalId, request.decision, now, { scope, confirmScope, keyId: claims.keyId });
      return { kind: 'redeemed', approvalId: claims.approvalId, decision: request.decision };
    });
  } catch (error) {
    // 여기 왔으면 **이미 롤백됐다**(포트 규약) — 사용 기록도 없다. 알려진 둘만 사유로 바꾸고 나머지는 던진다.
    if (error instanceof ApprovalLinkTransitionLostError) return { kind: 'rejected', reason: 'already_resolved' };
    if (error instanceof ApprovalLinkScopeError) return { kind: 'rejected', reason: error.reason };
    throw error;
  }
}

export type ApprovalLinkPreview =
  | { readonly kind: 'preview'; readonly summary: ApprovalLinkSummary }
  | { readonly kind: 'rejected'; readonly reason: ApprovalLinkRejection };

/**
 * 미리보기 — **상태를 바꾸지 않는다.** 서명·만료·일치는 결정과 같은 규칙으로 본다(`judgeTarget`).
 * `runInTransaction` 을 부르지 않는 것이 이 함수의 전부다(머리말 "미리보기 → 결정").
 */
export async function previewApprovalLink(
  ports: ApprovalLinkPorts,
  token: string,
  now: Date,
): Promise<ApprovalLinkPreview> {
  const verification = verifyApprovalLinkToken(ports.keyring, token, now);
  if (verification.kind === 'rejected') return verification;
  const summary = await ports.findApprovalSummary(verification.claims.approvalId);
  const rejection = judgeTarget(summary, verification.claims, now);
  if (rejection !== null || summary === null) return { kind: 'rejected', reason: rejection ?? 'unknown_approval' };
  return { kind: 'preview', summary };
}

// ---------------------------------------------------------------------------
// HTTP — GET 은 보여주기만, POST 만 바꾼다
// ---------------------------------------------------------------------------

export interface ApprovalLinkHttpRequest {
  readonly method: string;
  readonly contentType: string | null;
  readonly body: string;
  /**
   * 페이지 언어(계약 §8 — 두 언어). 라우트가 `approvalPageLanguage(?lang, Accept-Language)` 로 정해 넘긴다. 없으면 `ko`.
   * 언어는 **문구만** 바꾼다 — 판정·상태 코드·헤더(CSP 해시 포함)는 같다.
   */
  readonly language?: ApprovalPageLanguage;
}

/** 승인 페이지 언어. api 호스트에는 쿠키를 두지 않는다 — 쿼리와 `Accept-Language` 로만 고른다. */
export type ApprovalPageLanguage = 'ko' | 'en';

/**
 * 언어 선택: ① 쿼리 `?lang=ko|en`(페이지의 언어 전환 링크가 싣는다) ② `Accept-Language` 의 첫 언어가 `en` 으로 시작하면 `en`
 * ③ 그 밖은 `ko`. 모르는 쿼리 값은 무시한다(②로 내려간다).
 */
export function approvalPageLanguage(query: string | undefined, acceptLanguage: string | undefined): ApprovalPageLanguage {
  if (query === 'ko' || query === 'en') return query;
  const first = (acceptLanguage ?? '').split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'ko';
}

export interface ApprovalLinkHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** POST 본문 상한. 토큰 하나 + 결정·스코프 몇 개면 수백 바이트다. */
const MAX_FORM_BYTES = 2048;

/**
 * 정적 페이지의 유일한 스크립트:
 *   ① fragment 의 토큰을 숨은 필드로 옮기고 주소창에서 지운다.
 *   ② 그 토큰으로 **미리보기**(`intent=preview`)를 POST 해 요청 내용을 `textContent` 로만 그린다
 *      (`innerHTML` 이 없다 — 수신자 주소는 에이전트가 적은 문자열이다).
 *   ③ 미리보기가 성공해야 두 버튼의 `disabled` 를 푼다.
 * **결정은 제출하지 않는다** — 버튼을 누르는 것은 사람이다. 문구는 HTML 쪽에 두고 스크립트는 ASCII 만
 * 쓴다(해시가 인코딩에 흔들리지 않게 — **두 언어 페이지가 같은 스크립트·같은 해시**다). 한 줄이어야 한다 — 테스트가
 * `<script>(.*)</script>` 로 해시를 잰다. 언어 전환 링크(`#l`)에는 토큰을 fragment 로 이어 붙인다 — 전환해도 링크가 이어진다
 * (fragment 는 서버로 가지 않는다 · 숨은 필드와 같은 DOM 안의 값이다).
 */
const PAGE_SCRIPT =
  "(function(){var d=document,g=function(i){return d.getElementById(i);},h=location.hash.slice(1);" +
  "function fail(k){g('f').hidden=true;g('d').hidden=true;g(k).hidden=false;}" +
  "if(!h){fail('m0');return;}" +
  "g('t').value=h;var l=g('l');l.href=l.getAttribute('href')+'#'+h;history.replaceState(null,'',location.pathname+location.search);" +
  "fetch(location.pathname,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'}," +
  "body:'intent=preview&token='+encodeURIComponent(h),credentials:'omit',cache:'no-store'})" +
  ".then(function(r){return r.json().then(function(j){return {s:r.status,a:j&&j.approval};});})" +
  ".then(function(x){var a=x.a;" +
  "if(x.s!==200||!a){fail(x.s===409?'m1':x.s===410?'m2':'m4');return;}" +
  "g('ag').textContent=a.agent_name;g('fr').textContent=a.from.join(', ');" +
  "g('to').textContent=a.recipients.join(', ');g('n').textContent=String(a.message_count);" +
  "g('at').textContent=a.attachment_count>0?String(a.attachment_count)+' / '+(Math.ceil(a.attachment_bytes/104857.6)/10).toFixed(1)+' MB / '+a.attachment_names.join(', '):'0';" +
  "g('ex').textContent=new Date(a.expires_at).toLocaleString();" +
  "g('dm').textContent=a.recipients.map(function(e){return e.slice(e.lastIndexOf('@')+1);})" +
  ".filter(function(v,i,l){return l.indexOf(v)===i;}).join(', ');" +
  "var k=a.risk_reasons||[];if(k.length>0){g('rk').hidden=false;g('sc').hidden=true;g('sn').hidden=true;" +
  "k.forEach(function(x){var e=g('r-'+x);if(e)e.hidden=false;});}" +
  "g('d').hidden=false;g('a').disabled=false;g('r').disabled=false;})" +
  ".catch(function(){fail('m3');});})();";

const PAGE_SCRIPT_HASH = createHash('sha256').update(PAGE_SCRIPT, 'utf8').digest('base64');

/** 모든 응답의 공통 헤더. 토큰이 든 페이지·미리보기가 캐시·Referer 로 새지 않게. */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * 페이지 응답 헤더.
 *   - `no-store` — 토큰이 든 폼 페이지가 공유 캐시에 남지 않게.
 *   - `no-referrer` — 결과 페이지에서 다른 곳으로 나갈 때 URL 이 새지 않게(fragment 는
 *     원래 Referer 에 안 실리지만, 페이지 URL 자체도 내보낼 이유가 없다).
 *   - CSP — `default-src 'none'` 에서 필요한 것만 연다:
 *       · `script-src` 는 위 한 줄의 **해시**만(nonce 가 아니다 — 페이지가 정적이라 요청마다 달라질 값이
 *         없고, 해시는 스크립트가 한 글자라도 바뀌면 실행되지 않는다).
 *       · `connect-src 'self'` — 미리보기 `fetch` 가 같은 경로로만 간다. 토큰을 다른 오리진으로 보낼 수 없다.
 *       · `form-action 'self'` — 결정 폼도 같은 오리진으로만.
 *       · `frame-ancestors 'none'` — 다른 사이트가 이 페이지를 액자에 넣고 클릭을 훔치는 것(clickjacking).
 *       · `base-uri 'none'` — `<base>` 주입으로 폼·fetch 의 상대 경로를 돌리지 못하게.
 */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  ...COMMON_HEADERS,
  // 페이지 문구가 `Accept-Language` 로 갈린다(계약 §8). `no-store` 라 공유 캐시에 남지 않지만, 캐시가 끼는 날에도 언어가
  //   섞이지 않게 선언한다.
  vary: 'Accept-Language',
  'content-security-policy':
    `default-src 'none'; script-src 'sha256-${PAGE_SCRIPT_HASH}'; connect-src 'self'; form-action 'self'; ` +
    "frame-ancestors 'none'; base-uri 'none'",
};

/** 미리보기(JSON) 응답 헤더. 문서로 렌더될 일이 없으므로 CSP 는 전부 닫는다. */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  ...COMMON_HEADERS,
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

function page(language: ApprovalPageLanguage, title: string, content: string): string {
  return (
    `<!doctype html><html lang="${language}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${title}</title></head>` +
    `<body><main>${content}</main></body></html>`
  );
}

/** 결과 안내 한 쌍(제목·본문). */
type Notice = readonly [title: string, message: string];

/**
 * **두 언어 문구 사전**(계약 §8). 키 집합이 같다는 것은 타입(`ApprovalPageCopy`)이 강제하고 `magic-link.test.ts` 가 런타임에도
 * 본다. 문구에 동적 값이 없다 — 에이전트 값은 미리보기 스크립트가 `textContent` 로만 채운다.
 */
interface ApprovalPageCopy {
  readonly documentTitle: string;
  readonly heading: string;
  readonly agent: string;
  readonly from: string;
  readonly recipients: string;
  readonly messageCount: string;
  readonly attachments: string;
  readonly deadline: string;
  readonly standingNotice: string;
  readonly scopeLegend: string;
  readonly scopeRecipient: string;
  readonly scopeDomain: string;
  readonly confirmDomain: string;
  readonly approve: string;
  readonly reject: string;
  readonly brokenLink: string;
  readonly alreadyDecided: string;
  readonly expiredNotice: string;
  readonly loadFailed: string;
  readonly invalidLink: string;
  readonly noscript: string;
  /** 반대 언어로 가는 링크의 글자와 대상. */
  readonly switchLabel: string;
  readonly switchTo: ApprovalPageLanguage;
  readonly scopeConfirmationRequired: Notice;
  readonly scopeUnavailable: Notice;
  readonly organizationPaused: Notice;
  readonly organizationNotActive: Notice;
  readonly agentDeleted: Notice;
  readonly expired: Notice;
  readonly alreadyResolved: Notice;
  readonly invalid: Notice;
  readonly methodNotAllowed: Notice;
  readonly badRequest: Notice;
  readonly approved: Notice;
  readonly rejected: Notice;
}

export const APPROVAL_PAGE_COPY: Readonly<Record<ApprovalPageLanguage, ApprovalPageCopy>> = {
  ko: {
    documentTitle: 'Atmark 발송 승인',
    heading: '발송 승인 요청',
    agent: '에이전트',
    from: '보내는 주소',
    recipients: '받는 사람',
    messageCount: '메일 수',
    attachments: '첨부',
    deadline: '승인 기한',
    standingNotice: '승인하면 이 상대에게 앞으로 승인 없이 보낼 수 있게 됩니다.',
    scopeLegend: '승인 범위',
    scopeRecipient: '이 받는 사람만',
    scopeDomain: '받는 사람의 도메인 전체:',
    confirmDomain: '도메인 전체를 여는 것을 확인합니다',
    approve: '승인',
    reject: '거절',
    brokenLink: '링크가 온전하지 않습니다. 메일의 링크를 다시 열어 주세요.',
    alreadyDecided: '이 요청은 이미 결정되었습니다.',
    expiredNotice: '승인 기한이 지나 발송되지 않았습니다.',
    loadFailed: '요청 내용을 불러오지 못했습니다. 잠시 뒤 링크를 다시 열어 주세요.',
    invalidLink: '유효하지 않은 링크입니다. 메일의 링크를 다시 확인해 주세요.',
    noscript: '이 페이지는 자바스크립트가 필요합니다.',
    switchLabel: 'English',
    switchTo: 'en',
    scopeConfirmationRequired: ['확인이 필요합니다', '도메인 전체 승인은 확인란을 체크해야 합니다. 링크는 아직 유효합니다.'],
    scopeUnavailable: ['고를 수 없는 범위', '이 요청에는 스레드가 없습니다. 다른 범위로 다시 승인해 주세요.'],
    organizationPaused: [
      '조직이 정지 중입니다',
      '정지·동결 중에는 승인할 수 없습니다. 정지를 푼 뒤 같은 링크로 다시 승인해 주세요 — 링크는 아직 유효합니다.',
    ],
    organizationNotActive: ['운영자 검토 중인 조직입니다', '검토가 끝난 뒤 같은 링크로 다시 승인해 주세요. 링크는 아직 유효합니다.'],
    agentDeleted: ['삭제한 에이전트입니다', '이 에이전트는 삭제되어 메일을 보낼 수 없습니다. 승인하지 않았고, 메일은 나가지 않습니다.'],
    expired: ['만료된 링크', '승인 기한이 지나 발송되지 않았습니다.'],
    alreadyResolved: ['이미 처리됨', '이 요청은 이미 결정되었습니다.'],
    invalid: ['유효하지 않은 링크', '메일의 링크를 다시 확인해 주세요.'],
    methodNotAllowed: ['허용되지 않는 요청', '이 주소는 확인 페이지만 제공합니다.'],
    badRequest: ['잘못된 요청', '승인 또는 거절 버튼으로 제출해 주세요.'],
    approved: ['승인됨', '발송을 승인했습니다. 이 창을 닫아도 됩니다.'],
    rejected: ['거절됨', '발송을 거절했습니다. 메일은 나가지 않습니다.'],
  },
  en: {
    documentTitle: 'Atmark send approval',
    heading: 'Send approval request',
    agent: 'Agent',
    from: 'From',
    recipients: 'To',
    messageCount: 'Messages',
    attachments: 'Attachments',
    deadline: 'Decide by',
    standingNotice: 'If you approve, the agent can send to these recipients without approval from now on.',
    scopeLegend: 'Approval scope',
    scopeRecipient: 'These recipients only',
    scopeDomain: 'Every address at the recipient domain:',
    confirmDomain: 'I confirm opening the whole domain',
    approve: 'Approve',
    reject: 'Reject',
    brokenLink: 'This link is incomplete. Open the link in the email again.',
    alreadyDecided: 'This request has already been decided.',
    expiredNotice: 'The approval deadline passed, so nothing was sent.',
    loadFailed: 'Could not load the request. Open the link again in a moment.',
    invalidLink: 'This link is not valid. Check the link in the email.',
    noscript: 'This page needs JavaScript.',
    switchLabel: '한국어',
    switchTo: 'ko',
    scopeConfirmationRequired: ['Confirmation needed', 'To approve a whole domain, tick the confirmation box. The link is still valid.'],
    scopeUnavailable: ['Scope not available', 'This request has no thread. Approve again with a different scope.'],
    organizationPaused: [
      'The organization is paused',
      'Approvals are not possible while the organization is paused or frozen. Approve again with the same link after it is resumed — the link is still valid.',
    ],
    organizationNotActive: [
      'The organization is under operator review',
      'Approve again with the same link after the review is complete. The link is still valid.',
    ],
    agentDeleted: ['This agent was deleted', "This agent was deleted and can't send mail. Nothing was approved, and the email will not go out."],
    expired: ['Link expired', 'The approval deadline passed, so nothing was sent.'],
    alreadyResolved: ['Already handled', 'This request has already been decided.'],
    invalid: ['Invalid link', 'Check the link in the email.'],
    methodNotAllowed: ['Request not allowed', 'This address only serves the confirmation page.'],
    badRequest: ['Bad request', 'Submit with the Approve or Reject button.'],
    approved: ['Approved', 'You approved the send. You can close this window.'],
    rejected: ['Rejected', 'You rejected the send. The email will not go out.'],
  },
};

/**
 * 확인 페이지. **동적 값이 하나도 없다** — 서버는 이 요청에서 토큰을 보지 못한다. 요청 내용은 스크립트가
 * 미리보기로 받아 빈 칸(`#ag`·`#fr`·`#to`·`#n`·`#at`·`#ex`·`#dm`)에 채운다. 버튼은 그 전까지 `disabled` 다.
 * 언어별로 모듈 로드 때 한 벌씩 만든다 — 두 벌은 문구만 다르고 스크립트(= CSP 해시)는 같다.
 */
function confirmationPage(language: ApprovalPageLanguage): string {
  const c = APPROVAL_PAGE_COPY[language];
  return page(
    language,
    c.documentTitle,
    `<p><a id="l" href="?lang=${c.switchTo}" hreflang="${c.switchTo}" lang="${c.switchTo}">${c.switchLabel}</a></p>` +
      `<h1>${c.heading}</h1>` +
      '<section id="d" hidden><dl>' +
      `<dt>${c.agent}</dt><dd id="ag"></dd>` +
      `<dt>${c.from}</dt><dd id="fr"></dd>` +
      `<dt>${c.recipients}</dt><dd id="to"></dd>` +
      `<dt>${c.messageCount}</dt><dd id="n"></dd>` +
      `<dt>${c.attachments}</dt><dd id="at"></dd>` +
      `<dt>${c.deadline}</dt><dd id="ex"></dd>` +
      `</dl><p id="sn">${c.standingNotice}</p>` +
      // ADR-0016 — 위험 보류: 고정 문구만(에이전트 값 없음). 스크립트가 걸린 사유의 줄만 연다(`r-<사유>`).
      `<div id="rk" hidden><p><strong>${RISK_COPY[language].heading}</strong></p><ul>` +
      RISK_REASON_ORDER.map((reason) => `<li id="r-${reason}" hidden>${RISK_REASON_COPY[reason][language]}</li>`).join('') +
      `</ul><p>${RISK_COPY[language].onceNotice}</p></div></section>` +
      '<form id="f" method="post"><input type="hidden" id="t" name="token" value="">' +
      `<fieldset id="sc"><legend>${c.scopeLegend}</legend>` +
      `<label><input type="radio" name="scope" value="recipient" checked> ${c.scopeRecipient}</label><br>` +
      `<label><input type="radio" name="scope" value="domain"> ${c.scopeDomain} <span id="dm"></span></label><br>` +
      `<label><input type="checkbox" name="confirm_scope" value="domain"> ${c.confirmDomain}</label>` +
      '</fieldset>' +
      `<button type="submit" id="a" name="decision" value="approve" disabled>${c.approve}</button> ` +
      `<button type="submit" id="r" name="decision" value="reject" disabled>${c.reject}</button></form>` +
      `<p id="m0" hidden>${c.brokenLink}</p>` +
      `<p id="m1" hidden>${c.alreadyDecided}</p>` +
      `<p id="m2" hidden>${c.expiredNotice}</p>` +
      `<p id="m3" hidden>${c.loadFailed}</p>` +
      `<p id="m4" hidden>${c.invalidLink}</p>` +
      `<noscript><p>${c.noscript}</p></noscript>` +
      `<script>${PAGE_SCRIPT}</script>`,
  );
}

/** 언어별 확인 페이지(모듈 로드 때 두 벌). */
export const APPROVAL_CONFIRMATION_PAGES: Readonly<Record<ApprovalPageLanguage, string>> = {
  ko: confirmationPage('ko'),
  en: confirmationPage('en'),
};

function respond(
  status: number,
  language: ApprovalPageLanguage,
  notice: (copy: ApprovalPageCopy) => Notice,
  extra: Record<string, string> = {},
): ApprovalLinkHttpResponse {
  const [title, message] = notice(APPROVAL_PAGE_COPY[language]);
  return { status, headers: { ...PAGE_HEADERS, ...extra }, body: page(language, title, `<h1>${title}</h1><p>${message}</p>`) };
}

/** 거절 사유 → 상태 코드. 결정 응답과 미리보기 응답이 같은 표를 쓴다. */
function statusFor(reason: ApprovalLinkRejection): 400 | 409 | 410 {
  switch (reason) {
    case 'malformed':
    case 'unknown_key':
    case 'bad_signature':
    case 'unknown_approval':
    case 'scope_confirmation_required':
    case 'scope_unavailable':
      return 400;
    case 'expired':
    case 'expiry_mismatch':
      return 410;
    case 'already_resolved':
    case 'already_used':
    case 'organization_paused':
    case 'organization_not_active':
    case 'agent_deleted':
      return 409;
  }
}

/** 거절 사유 → 사람에게 보일 응답. 공격자가 사유 구분으로 얻는 것은 없다(서명 없이는 전부 400). */
function rejectionResponse(reason: ApprovalLinkRejection, language: ApprovalPageLanguage): ApprovalLinkHttpResponse {
  const status = statusFor(reason);
  if (reason === 'scope_confirmation_required') return respond(status, language, (c) => c.scopeConfirmationRequired);
  if (reason === 'scope_unavailable') return respond(status, language, (c) => c.scopeUnavailable);
  if (reason === 'organization_paused') return respond(status, language, (c) => c.organizationPaused);
  if (reason === 'organization_not_active') return respond(status, language, (c) => c.organizationNotActive);
  if (reason === 'agent_deleted') return respond(status, language, (c) => c.agentDeleted);
  if (status === 410) return respond(status, language, (c) => c.expired);
  if (status === 409) return respond(status, language, (c) => c.alreadyResolved);
  return respond(status, language, (c) => c.invalid);
}

function previewResponse(preview: ApprovalLinkPreview): ApprovalLinkHttpResponse {
  if (preview.kind === 'rejected') {
    return { status: statusFor(preview.reason), headers: JSON_HEADERS, body: JSON.stringify({ error: preview.reason }) };
  }
  const { summary } = preview;
  // **에이전트가 정한 문자열은 알림 메일과 같은 함수로 정화한다**(I1·I4·I6 — `sanitizeDisplayText`). `textContent` 는
  // HTML 을 막지만 U+202E 같은 양방향 제어는 막지 못한다 — 소유자가 결정하는 화면에서 주소가 뒤집혀 보인다.
  const address = (value: string): string => sanitizeDisplayText(value, RECIPIENT_MAX_CHARS);
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      approval: {
        kind: summary.subject,
        agent_name: sanitizeDisplayText(summary.agentName, AGENT_NAME_MAX_CHARS),
        from: summary.fromAddresses.map(address),
        recipients: summary.recipients.map(address),
        message_count: summary.attemptCount,
        // 첨부 요약(L5) — 파일명은 에이전트가 정한 값이라 주소와 같은 정화를 거친다.
        attachment_count: summary.attachments?.count ?? 0,
        attachment_bytes: summary.attachments?.bytes ?? 0,
        attachment_names: (summary.attachments?.names ?? []).slice(0, MAX_ATTACHMENT_NAMES_SHOWN).map((name) => sanitizeDisplayText(name, ATTACHMENT_NAME_MAX_CHARS)),
        expires_at: summary.expiresAt.toISOString(),
        // 위험 보류 사유(ADR-0016) — 닫힌 코드만(모르는 값은 버린다). 문장은 페이지에 고정돼 있다.
        risk_reasons: orderedRiskReasons(summary.riskReasons ?? []),
      },
    }),
  };
}

type ParsedForm =
  | { readonly kind: 'preview'; readonly token: string }
  | { readonly kind: 'decide'; readonly request: Required<ApprovalLinkRedeemRequest> };

const FORM_FIELDS: ReadonlySet<string> = new Set(['token', 'decision', 'intent', 'scope', 'confirm_scope']);
const SCOPES: ReadonlySet<string> = new Set<RelationshipScope>(['recipient', 'thread', 'domain']);

/** 같은 필드가 둘이면 어느 쪽을 읽을지가 구현에 달린다 — 받지 않는다. 없으면 `undefined`. */
function single(form: URLSearchParams, name: string): string | undefined | null {
  const values = form.getAll(name);
  if (values.length > 1) return null;
  return values[0];
}

function scopeField(form: URLSearchParams, name: string): RelationshipScope | undefined | null {
  const value = single(form, name);
  if (value === undefined || value === null) return value;
  return SCOPES.has(value) ? (value as RelationshipScope) : null;
}

function parseForm(request: ApprovalLinkHttpRequest): ParsedForm | null {
  const type = (request.contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  if (Buffer.byteLength(request.body, 'utf8') > MAX_FORM_BYTES) return null;

  const form = new URLSearchParams(request.body);
  // 모르는 필드는 받지 않는다 — 폼이 무엇을 싣는지는 이 파일이 정한다.
  for (const key of form.keys()) if (!FORM_FIELDS.has(key)) return null;

  const token = single(form, 'token');
  const decision = single(form, 'decision');
  const intent = single(form, 'intent');
  const scope = scopeField(form, 'scope');
  const confirmScope = scopeField(form, 'confirm_scope');
  if (token === undefined || token === null || token === '') return null;
  if (decision === null || intent === null || scope === null || confirmScope === null) return null;

  if (intent !== undefined) {
    // 미리보기와 결정은 **한 요청에 섞이지 않는다** — `intent=preview&decision=approve` 가 어느 쪽인지를
    // 해석으로 정하지 않는다.
    if (intent !== 'preview' || decision !== undefined) return null;
    return { kind: 'preview', token };
  }
  if (decision !== 'approve' && decision !== 'reject') return null;
  return {
    kind: 'decide',
    request: { token, decision, scope: scope ?? 'recipient', confirmScope: confirmScope ?? null },
  };
}

/**
 * 승인 링크 경로의 요청 처리 전부.
 *
 * **GET·HEAD 는 `ports` 에 손대지 않는다** — 키도, 트랜잭션도, 조회도. 쿼리스트링에
 * 토큰과 `decision=approve` 가 실려 와도 읽지 않는다. 메일 스캐너가 링크를 몇 번 열든
 * approval 은 그대로이고 **링크도 태워지지 않는다**(태워지면 사람이 눌렀을 때 "이미
 * 사용됨" 이 나온다 — 그것도 스캐너가 만든 사고다).
 *
 * **POST `intent=preview` 는 읽기만 한다** — `runInTransaction` 을 부르지 않는다(머리말 2단계 판단).
 */
export async function handleApprovalLinkRequest(
  request: ApprovalLinkHttpRequest,
  ports: ApprovalLinkPorts,
  now: Date,
): Promise<ApprovalLinkHttpResponse> {
  const method = request.method.toUpperCase();
  const language = request.language ?? 'ko';

  if (method === 'GET' || method === 'HEAD') {
    return {
      status: 200,
      headers: PAGE_HEADERS,
      body: method === 'HEAD' ? '' : APPROVAL_CONFIRMATION_PAGES[language],
    };
  }

  if (method !== 'POST') {
    return respond(405, language, (c) => c.methodNotAllowed, { allow: 'GET, HEAD, POST' });
  }

  const form = parseForm(request);
  if (form === null) return respond(400, language, (c) => c.badRequest);
  if (form.kind === 'preview') return previewResponse(await previewApprovalLink(ports, form.token, now));

  const result = await redeemApprovalLink(ports, form.request, now);
  if (result.kind === 'rejected') return rejectionResponse(result.reason, language);
  return respond(200, language, (c) => (result.decision === 'approve' ? c.approved : c.rejected));
}
