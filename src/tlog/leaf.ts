/**
 * src/tlog/leaf.ts — **조직 로그의 잎 봉투**(ADR-0008 §2.2). 잎 = 감사 **사건** 하나의 JCS 문자열:
 *
 *   { "v": 1, "kind": <종류>, "log": <org_log_id hex32>, "seq": <조직 안 0부터 연속>,
 *     "src": { "t": <원천 테이블>, "id": <원천 행 id>, "e": "insert"|"update", "r": <갱신 순번> } | null,
 *     "at": <RFC 3339 UTC 마이크로초>, "body": { …평문 칸… }, "c": { <칸>: <커밋 hex64>, … } }
 *   leaf_hash = SHA-256(0x00 ‖ JCS(leaf))
 *
 * ★ **평문(`body`)에 들어갈 수 있는 값은 모양이 정해져 있다** — uuid · 에이전트 id(hex32) · 코드 문자열(`^[a-z][a-z0-9_.:-]*$`) ·
 * 정수 · 불리언 · 시각. 주소·제목·본문·세션 id·승인자·연락처 목록은 **모양상** 들어갈 수 없고 `c`(솔트 커밋)로만 간다.
 * 코드 칸에 모양 밖 값(예: 전송 오류 문장 `failed:<SES 메시지>` — 주소가 섞일 수 있다)이 오면 평문은 `null` 이 되고 원래 값은
 * `c["body.<칸>"]` 커밋으로 옮겨진다 — **조용히 싣지도, 조용히 버리지도 않는다.** 이 규칙은 검증기(`scripts/tlog-verify`)가
 * 원천 행에서 잎을 다시 만들 때 **똑같이** 적용한다.
 *
 * 변경 가능한 행(`audit_logs` 의 4칸)은 행 스냅샷이 아니라 **사건의 열**로 담는다 — 행의 현재 상태 = 그 행 사건들의 접기(fold).
 *
 * PII 센티넬 스캔(A-T3, `test/arch/transparency-log.arch.test.ts`)이 이 파일의 모든 종류를 센티넬 입력으로 만들어 평문 부재를 본다.
 */

import { createHash } from 'node:crypto';

import { canonicalize } from '../passport/jcs';
import { commitmentOf, leafIdOf, saltFor } from './commit';
import { GLOBAL_LEAF_VERSION, LEAF_VERSION, type OrgLeafKind, type TlogSourceTable } from './constants';
import { leafHash } from './merkle';

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AGENT_ID_SHAPE = /^[0-9a-f]{32}$/;
/** 코드 문자열 — 소문자로 시작, `@`·공백·대문자 없음(주소·문장이 모양상 통과하지 못한다). */
export const CODE_SHAPE = /^[a-z][a-z0-9_.:-]{0,119}$/;
/** SHA-256 hex(소문자 64) — 공개키 지문 · passport `content_hash`. */
export const HEX64_SHAPE = /^[0-9a-f]{64}$/;
/** 에이전트 공개키 — Ed25519 원시 32바이트의 base64url(패딩 없음, `agent_keypairs.public_key` CHECK 와 같다). */
export const PUBLIC_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** 원천 시각 — Postgres `to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 모양. */
export const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface LeafSource {
  readonly t: TlogSourceTable;
  readonly id: string;
  readonly e: 'insert' | 'update';
  /** 갱신 순번 — insert 는 0, 같은 행의 n 번째 갱신은 n. */
  readonly r: number;
}

/** 서열기가 원천 행(과 outbox 스냅샷)에서 모은 사건 하나. **평문·커밋 구분 전의 원자료**다 — 이 모양은 DB 밖으로 나가지 않는다. */
export type OrgEvent =
  | { readonly kind: 'org.genesis'; readonly at: string }
  | {
      readonly kind: 'audit.evaluated';
      readonly src: LeafSource;
      readonly at: string;
      readonly auditId: string;
      readonly agentId: string;
      readonly decision: string;
      readonly reasons: readonly string[];
      readonly policyVersion: number | null;
      readonly approvalId: string | null;
      readonly messageId: string | null;
      readonly resolutionReason: string | null;
      readonly resolvedAt: string | null;
      readonly approvedBy: string | null;
      /** 발송 시도의 수신자 전원(`outbound_recipients`) — 메시지 행이 있을 때. 커밋으로만. */
      readonly recipients: readonly string[] | null;
      /** 보낸 메일의 Message-ID 헤더 — 커밋으로만(누락 탐지 T6). */
      readonly rfc822Id: string | null;
    }
  | {
      readonly kind: 'audit.updated';
      readonly src: LeafSource;
      readonly at: string;
      readonly auditId: string;
      readonly decision: string;
      readonly resolutionReason: string | null;
      readonly resolvedAt: string | null;
      readonly approvedBy: string | null;
    }
  | {
      readonly kind: 'owner.action';
      readonly src: LeafSource;
      readonly at: string;
      readonly action: string;
      readonly targetId: string | null;
      /**
       * 행위자 — 소유자 세션 **또는** 조직 API 키(202609250160 `owner_actions_one_actor`, ADR-0008 추가 절). 정확히 하나가 값이다.
       * 세션은 `c.session`, 키는 `c.api_key` 커밋 — 칸 이름이 달라 두 변형이 잎에서 구별된다(값은 커밋으로만).
       */
      readonly sessionId: string | null;
      readonly orgApiKeyId?: string | null;
      /**
       * 셋째 행위자 — 운영자 CLI · 플랫폼 시스템(202610131610 `operator_actor` · `operator_reason`). `c.operator` 커밋 하나(행위자 문자열 · 사유 —
       * 평문 없음). 둘 다 있거나 둘 다 없다. 세션 · 키 행위 잎의 바이트는 바뀌지 않는다.
       */
      readonly operatorActor?: string | null;
      readonly operatorReason?: string | null;
    }
  | {
      readonly kind: 'policy.version';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly version: number;
      readonly outboundMode: string;
      readonly inboundMode: string | null;
      /** 스냅샷 전문(연락처 목록 값 포함) — 커밋으로만. */
      readonly snapshot: unknown;
    }
  | {
      readonly kind: 'inbound.verdict';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly quarantined: boolean;
      readonly quarantineReason: string | null;
      readonly policyReason: string | null;
      readonly fromAuthenticated: boolean;
      readonly fromAddress: string;
      readonly rfc822Id: string | null;
    }
  | {
      /** `agents` INSERT — 이름은 커밋으로만. 상태·정지 주체는 그때 값(outbox 스냅샷). */
      readonly kind: 'identity.agent_created';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly name: string;
      readonly status: string;
      readonly suspendedBy: string | null;
    }
  | {
      /** `agents` 의 이름·상태·정지 주체 변경(rev 1,2,…) — 그때 값 + 바뀐 칸 목록(스냅샷). */
      readonly kind: 'identity.agent_updated';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly name: string;
      readonly status: string;
      readonly suspendedBy: string | null;
      readonly changed: readonly string[];
    }
  | {
      /** `agent_addresses` INSERT — 주소는 커밋으로만. */
      readonly kind: 'identity.address_assigned';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly address: string;
      readonly primary: boolean;
    }
  | {
      /**
       * `agent_addresses` UPDATE — 별칭 폐기(tlog v4, 202609270115 · ADR-0013 A6). `at` = 행의 `retired_at`(쓰기 1회 — 서열 시점의 행이 그때
       * 값이다). 주소는 커밋으로만(`identity.address_assigned` 와 같은 규율 — 평문 `@` 0).
       */
      readonly kind: 'identity.address_retired';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly address: string;
    }
  | {
      /**
       * `agent_primary_changes` INSERT — **대표 주소 선택**(ADR-0014 개정 · 포인터 모델). append-only 라 insert 잎만 있다(rev 0, `at` = 행의
       * `created_at`). 평문은 에이전트 id 와 원인 코드(`provision` · `owner` · `operator`)뿐이고 주소는 커밋 `c.address` 로만(평문 `@` 0).
       * DB CHECK · 트리거는 202610021110.
       */
      readonly kind: 'identity.primary_set';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly cause: string;
      readonly address: string;
    }
  | {
      /** `agent_keypairs` INSERT — 공개키(base64url)는 잎에 싣지 않고 지문 `key_fp = hex(SHA-256(원시 공개키))` 만. */
      readonly kind: 'identity.key_bound';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly algorithm: string;
      readonly publicKey: string;
    }
  | {
      /** `passport_documents` INSERT — 서명된(= draft 가 아닌) passport 버전. 값은 이미 공개된 것(ADR-0008 §2.2 `passport.version`). */
      readonly kind: 'identity.passport_version';
      readonly src: LeafSource;
      readonly at: string;
      readonly agentId: string;
      readonly version: number;
      readonly status: string;
      readonly contentHash: string;
    }
  | {
      /**
       * `org_entitlements` INSERT·UPDATE(202609250300, ADR-0011) — 그때 값(outbox 스냅샷). 요금제 코드 · 원인 · 버전 · 한도 수치 · 유예 끝만.
       * **금액·고객 id·이메일은 원천 표에 칸이 없다** — 이 잎에 들어갈 길이 없다. 커밋 칸 없음(전부 모양이 정해진 평문).
       */
      readonly kind: 'billing.entitlement';
      readonly src: LeafSource;
      readonly at: string;
      readonly planCode: string;
      readonly cause: string;
      readonly version: number;
      /** `ENTITLEMENT_LIMIT_FIELDS`(필수 아홉) + `ENTITLEMENT_LATE_LIMIT_FIELDS`(둘 다 있거나 둘 다 없음)의 칸 → 정수. */
      readonly limits: Readonly<Record<string, number>>;
      readonly graceUntil: string | null;
    }
  | {
      /**
       * `custom_domains` INSERT·UPDATE(202609291130, ADR-0014 · 계획 §3.10) — 그때 값(outbox 스냅샷): 상태 · 정지 사유 · 수신 MX 판정. 평문은
       * 도메인 행 id(uuid)와 코드뿐이고 **도메인 이름은 커밋으로만**(`identity.address_assigned` 와 같은 규율 — 잎은 append-only 라 지울 수 없다).
       */
      readonly kind: 'domain.status';
      readonly src: LeafSource;
      readonly at: string;
      readonly domainId: string;
      readonly status: string;
      readonly reason: string | null;
      readonly inbound: string;
      readonly domain: string;
    }
  | {
      readonly kind: 'source.missing';
      readonly src: LeafSource;
      readonly at: string;
      /** `not_found` — 서열 시점에 원천 행이 없었다. `unrepresentable` — 행은 있지만 잎 모양으로 옮길 수 없었다(무한대 시각·유한하지 않은 수 등). */
      readonly reason: 'not_found' | 'unrepresentable';
    };

/**
 * `billing.entitlement` 잎의 한도 칸 — `org_entitlements` 칸 이름 그대로, 이 순서로 싣는다(JCS 가 키를 다시 정렬하지만 빠진 칸이 없는지는 이
 * 목록이 본다). 검증기(`scripts/tlog-verify`)가 같은 목록을 따로 적는다(`src/**` 를 import 하지 않는다).
 */
export const ENTITLEMENT_LIMIT_FIELDS = [
  'max_agents',
  'org_daily_recipients',
  'agent_per_day_max',
  'agent_per_minute_max',
  'recipients_per_message_max',
  'tokens_per_agent_max',
  'webhook_endpoints_per_agent_max',
  'org_api_keys_max',
  'inbound_storage_bytes',
] as const;

/**
 * tlog v4(202609270115, ADR-0013 D6) — `billing.entitlement` 잎의 **늦게 더한 두 칸**. 필수 아홉 칸 뒤에 **둘 다 있거나 둘 다 없어야** 한다
 * (하나만 있으면 잎 모양이 아니다 → `source.missing(unrepresentable)`).
 *
 * 왜 필수로 두지 않는가(계획 F18): 서열기는 outbox 스냅샷에 있는 키만 옮긴다. v4 전(202609270115 전)에 적재된 9칸 스냅샷이 outbox 에 남은 채
 * 이 코드가 배포되면, 필수 11칸 빌더는 그 사건을 되돌릴 수 없는 `source.missing` 으로 커밋한다. "둘 다 없음" 이면 옛 9칸 잎을 그대로 만들고,
 * 과거 9칸 잎의 해시도 그대로다(JCS 는 있는 키만 정렬한다). 모든 조직의 11칸 잎은 백필 UPDATE(202609270120)가 만든다.
 */
export const ENTITLEMENT_LATE_LIMIT_FIELDS = ['aliases_per_agent_max', 'attachment_bytes_total_max'] as const;

export interface LeafContext {
  /** org_log_id 소문자 hex 32. */
  readonly log: string;
  readonly seq: number;
  /** 조직 솔트 키(32바이트). 폐기된 조직(크립토 슈레딩)은 새 잎을 만들 수 없다 — 서열기가 멈추고 알린다. */
  readonly saltKey: Uint8Array;
}

export interface BuiltLeaf {
  readonly kind: OrgLeafKind;
  /** JCS 문자열 — 저장·해시·게시되는 바이트 그 자체. */
  readonly json: string;
  readonly hash: Buffer;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

class LeafBuilder {
  readonly body: Record<string, Json> = {};
  readonly commitments: Record<string, string> = {};
  private readonly leafId: string;

  constructor(
    private readonly context: LeafContext,
  ) {
    this.leafId = leafIdOf(context.log, context.seq);
  }

  commit(field: string, value: unknown): void {
    this.commitments[field] = commitmentOf(saltFor(this.context.saltKey, this.leafId, field), value);
  }

  /** 모양이 맞으면 평문, 아니면 `null` + `c["body.<칸>"]`. */
  shaped(field: string, value: string | null, shape: RegExp): void {
    if (value === null || shape.test(value)) {
      this.body[field] = value;
      return;
    }
    this.body[field] = null;
    this.commit(`body.${field}`, value);
  }

  integer(field: string, value: number | null): void {
    if (value !== null && !Number.isSafeInteger(value)) throw new TypeError(`${field} 는 정수여야 한다`);
    this.body[field] = value;
  }

  flag(field: string, value: boolean): void {
    this.body[field] = value;
  }

  codes(field: string, values: readonly string[]): void {
    if (values.every((value) => CODE_SHAPE.test(value))) {
      this.body[field] = [...values];
      return;
    }
    this.body[field] = null;
    this.commit(`body.${field}`, [...values]);
  }
}

function requireShape(label: string, value: string, shape: RegExp): string {
  if (!shape.test(value)) throw new TypeError(`${label} 모양이 아니다`);
  return value;
}

/** 공개키 지문 — `hex(SHA-256(base64url 을 푼 원시 32바이트))`. 검증기(`scripts/tlog-verify`)가 원천 행의 공개키에서 똑같이 다시 만든다. */
export function publicKeyFingerprint(publicKey: string): string {
  requireShape('public_key', publicKey, PUBLIC_KEY_SHAPE);
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32) throw new TypeError('public_key 는 32바이트다');
  return createHash('sha256').update(raw).digest('hex');
}

function sourceOf(src: LeafSource): Json {
  if (!Number.isSafeInteger(src.r) || src.r < 0) throw new TypeError('src.r 는 0 이상 정수다');
  return { t: src.t, id: src.id, e: src.e, r: src.r };
}

/** 사건 하나 → 잎(JCS · 해시). 순수 함수 — 같은 입력이면 같은 바이트. */
export function buildOrgLeaf(context: LeafContext, event: OrgEvent): BuiltLeaf {
  if (!/^[0-9a-f]{32}$/.test(context.log)) throw new TypeError('log 는 hex32 다');
  if (!Number.isSafeInteger(context.seq) || context.seq < 0) throw new TypeError('seq 는 0 이상 정수다');
  requireShape('at', event.at, INSTANT_SHAPE);
  const builder = new LeafBuilder(context);
  const src: Json = event.kind === 'org.genesis' ? null : sourceOf(event.src);

  switch (event.kind) {
    case 'org.genesis':
      break;
    case 'audit.evaluated': {
      builder.shaped('audit_id', event.auditId, UUID_SHAPE);
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.shaped('decision', event.decision, CODE_SHAPE);
      builder.codes('reasons', event.reasons);
      builder.integer('policy_version', event.policyVersion);
      builder.shaped('approval_id', event.approvalId, UUID_SHAPE);
      builder.shaped('message_id', event.messageId, UUID_SHAPE);
      builder.shaped('resolution_reason', event.resolutionReason, CODE_SHAPE);
      builder.shaped('resolved_at', event.resolvedAt, INSTANT_SHAPE);
      if (event.approvedBy !== null) builder.commit('approved_by', event.approvedBy);
      if (event.recipients !== null) builder.commit('envelope', { to: [...new Set(event.recipients)].sort() });
      if (event.rfc822Id !== null) builder.commit('rfc822_id', event.rfc822Id);
      break;
    }
    case 'audit.updated': {
      builder.shaped('audit_id', event.auditId, UUID_SHAPE);
      builder.shaped('decision', event.decision, CODE_SHAPE);
      builder.shaped('resolution_reason', event.resolutionReason, CODE_SHAPE);
      builder.shaped('resolved_at', event.resolvedAt, INSTANT_SHAPE);
      if (event.approvedBy !== null) builder.commit('approved_by', event.approvedBy);
      break;
    }
    case 'owner.action': {
      builder.shaped('action', event.action, CODE_SHAPE);
      builder.shaped('target_id', event.targetId, /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
      const keyId = event.orgApiKeyId ?? null;
      const operatorActor = event.operatorActor ?? null;
      const operatorReason = event.operatorReason ?? null;
      if ((operatorActor === null) !== (operatorReason === null)) throw new TypeError('owner.action 운영자 행위자와 사유는 함께만 있다');
      if ([event.sessionId, keyId, operatorActor].filter((value) => value !== null).length !== 1) {
        throw new TypeError('owner.action 행위자는 세션 · 조직 키 · 운영자 중 정확히 하나다');
      }
      if (event.sessionId !== null) builder.commit('session', event.sessionId);
      else if (keyId !== null) builder.commit('api_key', keyId);
      else builder.commit('operator', { actor: operatorActor, reason: operatorReason });
      break;
    }
    case 'policy.version': {
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.integer('version', event.version);
      builder.shaped('outbound_mode', event.outboundMode, CODE_SHAPE);
      builder.shaped('inbound_mode', event.inboundMode, CODE_SHAPE);
      builder.commit('snapshot', event.snapshot);
      break;
    }
    case 'inbound.verdict': {
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.shaped('verdict', event.quarantined ? 'quarantined' : 'delivered', CODE_SHAPE);
      builder.shaped('quarantine_reason', event.quarantineReason, CODE_SHAPE);
      builder.shaped('policy_reason', event.policyReason, CODE_SHAPE);
      builder.flag('from_authenticated', event.fromAuthenticated);
      builder.commit('from', event.fromAddress);
      if (event.rfc822Id !== null) builder.commit('rfc822_id', event.rfc822Id);
      break;
    }
    case 'identity.agent_created':
    case 'identity.agent_updated': {
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.shaped('status', event.status, CODE_SHAPE);
      builder.shaped('suspended_by', event.suspendedBy, CODE_SHAPE);
      if (event.kind === 'identity.agent_updated') builder.codes('changed', event.changed);
      builder.commit('name', event.name);
      break;
    }
    case 'identity.address_assigned':
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.flag('primary', event.primary);
      builder.commit('address', event.address);
      break;
    case 'identity.address_retired':
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.commit('address', event.address);
      break;
    case 'identity.primary_set':
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.shaped('cause', event.cause, CODE_SHAPE);
      builder.commit('address', event.address);
      break;
    case 'identity.key_bound':
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.shaped('algorithm', event.algorithm, CODE_SHAPE);
      builder.shaped('key_fp', publicKeyFingerprint(event.publicKey), HEX64_SHAPE);
      break;
    case 'identity.passport_version':
      builder.shaped('agent_id', event.agentId, AGENT_ID_SHAPE);
      builder.integer('version', event.version);
      builder.shaped('status', event.status, CODE_SHAPE);
      builder.shaped('content_hash', event.contentHash, HEX64_SHAPE);
      break;
    case 'billing.entitlement': {
      builder.shaped('plan_code', event.planCode, CODE_SHAPE);
      builder.shaped('cause', event.cause, CODE_SHAPE);
      if (!Number.isSafeInteger(event.version) || event.version < 1) throw new TypeError('billing.entitlement version 은 1 이상 정수다');
      builder.integer('version', event.version);
      const limit = (field: string): void => {
        const value = event.limits[field];
        // 빠진 칸·음수·정수 아님은 잎 모양이 아니다 → 서열기가 source.missing(unrepresentable)로 커밋한다(조용히 0 으로 채우지 않는다).
        if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`billing.entitlement ${field} 는 0 이상 정수다`);
        builder.integer(field, value);
      };
      ENTITLEMENT_LIMIT_FIELDS.forEach(limit);
      // 늦게 더한 두 칸 — 둘 다 있거나 둘 다 없음(9칸 레거시 · 11칸). 하나만 있으면 모양이 아니다(unrepresentable).
      const present = ENTITLEMENT_LATE_LIMIT_FIELDS.filter((field) => event.limits[field] !== undefined);
      if (present.length !== 0 && present.length !== ENTITLEMENT_LATE_LIMIT_FIELDS.length) {
        throw new TypeError('billing.entitlement 의 늦게 더한 두 칸은 둘 다 있거나 둘 다 없다');
      }
      present.forEach(limit);
      builder.shaped('grace_until', event.graceUntil, INSTANT_SHAPE);
      break;
    }
    case 'domain.status':
      builder.shaped('domain_id', event.domainId, UUID_SHAPE);
      builder.shaped('status', event.status, CODE_SHAPE);
      builder.shaped('reason', event.reason, CODE_SHAPE);
      builder.shaped('inbound', event.inbound, CODE_SHAPE);
      builder.commit('domain', event.domain);
      break;
    case 'source.missing':
      builder.shaped('reason', event.reason, CODE_SHAPE);
      break;
  }

  const leaf = {
    v: LEAF_VERSION,
    kind: event.kind,
    log: context.log,
    seq: context.seq,
    src,
    at: event.at,
    body: builder.body,
    c: builder.commitments,
  };
  const json = canonicalize(leaf);
  return { kind: event.kind, json, hash: leafHash(Buffer.from(json, 'utf8')) };
}

/**
 * 에폭 트리의 잎 — 에폭 하나의 조직 헤드 하나(`{epoch, log, size, root}`). org_log_id 순서로 담긴다. **에폭 번호가 잎에 있다**(형식 v2 —
 * `GLOBAL_LEAF_VERSION`): 활동 없는 조직의 잎도 에폭마다 달라져, 포함 증명의 형제 해시로 이웃 조직의 활동 여부를 읽을 수 없다.
 */
export function epochTreeLeaf(epoch: number, log: string, size: number, rootHex: string): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError('epoch 는 0 이상 정수다');
  return canonicalize({ epoch, log, size, root: rootHex });
}

/** 전역 공개 로그의 잎 — 에폭 하나. 공개 표면이라 **불투명 해시와 시각뿐**이다(P1). `v` = 에폭 트리 잎 형식의 버전. */
export function globalEpochLeaf(epoch: number, closedAt: string, epochRootHex: string): string {
  return canonicalize({ v: GLOBAL_LEAF_VERSION, kind: 'epoch', epoch, closed_at: closedAt, epoch_root: epochRootHex });
}
