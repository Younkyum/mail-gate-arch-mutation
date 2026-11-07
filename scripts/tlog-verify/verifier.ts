/**
 * scripts/tlog-verify/verifier.ts — **Atmark 투명성 로그 오프라인 검증기**(ADR-0008 §2.6). `pnpm log:verify <bundle>` 의 본체.
 *
 * ★ **`src/**` 를 import 하지 않는다**(arch 테스트 `test/arch/transparency-log.arch.test.ts`). 우리 서버 코드로 우리를 통과시키는
 * 것은 증거가 아니다(R15) — JCS · RFC 9162 머클 · C2SP signed note · 커밋 · OTS 파서를 이 파일이 **따로** 구현한다. 두 번째 독립 구현
 * (`test/support/tlog-second-verifier.ts` — `canonicalize` 패키지 · `@noble/ed25519` · transparency-dev 식 증명 검증)과 Go
 * `golang.org/x/mod/sumdb/{tlog,note}` 교차 검증(`test/unit/tlog/go-crosscheck.test.ts`, Go 가 있을 때)이 같은 번들을 본다(A-T6).
 *
 * 하는 일 (번들 `atmark-tlog-bundle/v2`):
 *   1. 체크포인트 서명을 **고정한 vkey** 로 검사(고정하지 않으면 경고 — 번들의 vkey 를 믿는 것은 Atmark 를 믿는 것이다). origin 도 고정한다
 *      (기본 `id.atmark.ai/log/v1`). tree size 는 안전한 정수여야 한다.
 *   2. 전역: 범위의 **모든 에폭**에 체크포인트가 있다 · 에폭 잎(JCS 정규형, v2) → 체크포인트 포함 증명 · 연속 체크포인트 사이 일관성 증명.
 *   3. 조직: 시작 가장자리(frontier) → 시작 헤드 · 잎을 이어 붙여 모든 헤드 재계산 · 헤드의 에폭 트리 포함 증명(잎 = {epoch, log, size, root}) ·
 *      범위 일관성 증명. **빠짐을 통과시키지 않는다**: 시작 크기 > 0 이면 from 헤드가 그 크기로 있어야 하고, 잎이 있으면 to 헤드가 있어야 하며,
 *      첫 헤드부터 to 까지 헤드가 끊기지 않는다. 마지막 헤드 뒤의 잎은 "체크포인트 전" 으로 따로 보고하고 검증·원천 대조에 쓰지 않는다.
 *   4. 잎: JCS 정규형 · 봉투(log·seq 연속) · 커밋을 솔트 키로 **열어** 원천 행과 대조 · **원천 행 ↔ 잎 양방향**
 *      (`row_without_leaf` · `leaf_without_row` · `row_leaf_mismatch` — 트리거를 끄고 쓴 흔적을 각각 다른 오류로).
 *   5. 로컬 상태(지난번에 본 체크포인트·조직 헤드)와의 **연결** — 저장한 에폭이 범위 안이면 같은 루트, 범위 밖이면 번들의 `link`
 *      일관성 증명(전역·조직)이 있어야 한다. 이어지지 않으면 실패(`state_unlinked`)이고 상태를 갱신하지 않는다. 소유자가 곧 자기 조직의 증인이다.
 *      상태는 **origin 하나에 하나**다(CLI 가 origin 으로 파일을 고른다 — 번들이 대는 조직 로그 id 로 고르면 새 id 하나로 저장 상태를 통째로
 *      건너뛴다, 적대적 검증 M1). 조직 로그 id 는 첫 통과 때 고정(`org_log`)하고, 다른 id 의 번들은 `state_org_log_changed` 로 실패한다
 *      (`acceptNewLog` 면 경고 뒤 조직 연결만 새로 시작 — 전역 체크포인트 연결은 그대로 본다).
 *   5'. 조직 로그의 시작(L1) — 시작 크기 0(= 번들이 창세 잎부터)이면 첫 헤드 **직전 에폭**이 범위 안에 있고 그 마감 시각이 창세 잎의 `at`
 *      이전이어야 한다(그 에폭이 이 조직 헤드 없이 닫혔다는 주장이 시각과 맞는다). 앞 에폭 헤드를 빼고 "로그가 나중에 시작했다" 고 꾸미지 못한다.
 *      남는 한계: 저장 상태 없이 창세 잎 `at` 까지 새로 지은 역사, 시작 크기 > 0 인 번들(범위 앞은 보지 않는다 — 경고).
 *   4'. 신원 잎(US-013 — `identity.agent_created`·`agent_updated`·`address_assigned`·`key_bound`·`passport_version`)도 같은 원천 대조를 받는다.
 *      이름·주소는 커밋을 열어, 공개키는 지문(`hex(SHA-256(원시 공개키))`)을 다시 계산해 본다. `agents` 는 변경 가능한 행이라 마지막 사건 =
 *      지금 행. 적대적 검증 반영(2026-09-24):
 *      - M2 `identity_since`(신원 잎 도입 시각): 신원 원천의 창은 이 시각 + 여유에서 시작한다(도입 전 행은 잎이 없다). 이 값은 번들 안 모든 신원
 *        잎의 `at` 이하여야 하고(`identity_since_after_leaf`) 저장 상태에 고정된다(`state_identity_since_changed`) — 서버가 늦춰 지운 행을 숨기지 못한다.
 *      - M3 창 끝 뒤에 바뀐 `agents` 행: `updated_at` 이 번들 생성 시각 + 여유보다 뒤면 오류(`updated_at_in_future`), 아니면 이름 붙은 경고
 *        (`agent_fold_deferred`)와 함께 **저장 상태에 대기**로 남긴다 — 다음 번들이 뒤의 `identity.agent_updated` 잎을 보이거나 그 행을 마지막 잎과
 *        다시 대조해야 풀린다(없으면 `agent_update_leaf_missing`).
 *      - L6 번들의 `min_verifier_version` 이 이 검증기(`VERIFIER_VERSION`)보다 크면 `verifier_outdated` 로 멈춘다.
 *   6. 앵커: OTS 영수증이 체크포인트 다이제스트에서 시작하는지 · Bitcoin 증명 높이/머클 루트 보고(**주장** — 블록 헤더 대조는 `ots verify`) ·
 *      Rekor 응답의 체크포인트를 **고정한 샤드 키**로 열고 포함 증명 · 앵커 서명을 **고정한 앵커 키**로(번들의 키가 아니다).
 */

import { createHash, createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const BUNDLE_FORMAT = 'atmark-tlog-bundle/v2';
/** 콘솔 로그 상세 "포함 증명 내려받기"(`GET /api/logs/inclusion-proof?entry=`)의 파일 — 잎 하나 → 조직 헤드 → 에폭 루트 → 체크포인트. */
export const INCLUSION_FORMAT = 'atmark-tlog-inclusion/v1';
/** 콘솔 신원 탭 "변경 이력 블록"(`GET /api/agents/{id}/identity-blocks`, US-013)의 응답 — 잎 해시와 블록 체인을 다시 계산한다. */
export const IDENTITY_BLOCKS_FORMAT = 'atmark-identity-blocks/v1';
/** 운영 로그 origin — `--origin` 으로 바꿀 수 있다(스테이징). */
export const DEFAULT_ORIGIN = 'id.atmark.ai/log/v1';
/** 전역 에폭 잎의 `v` — 에폭 트리 잎이 `{epoch, log, size, root}` 인 형식. */
export const GLOBAL_LEAF_VERSION = 2;
/**
 * 이 검증기의 판(L6). 번들이 `min_verifier_version` 으로 요구하는 판보다 낮으면 멈춘다. 2 = 신원 원천 대조 · `identity_since` · `agents` 대기 검사.
 * 3 = 요금제 원천 `org_entitlements` · 잎 `billing.entitlement`(202609250300, ADR-0011) 대조.
 * 4 = tlog v4(202609270115, ADR-0013 2차) — `billing.entitlement` 는 9칸(레거시) 또는 11칸만(10칸 = `limit_fields`), 접기 대조는 행의 늦은 두 칸이
 *     있으면 마지막 잎도 11칸 · 별칭 폐기 잎 `identity.address_retired`(주소 행의 `retired_at` = 잎 `at`, 창 안 폐기에 잎이 없으면 `retire_leaf`).
 * 5 = 고객 도메인(202609291130, ADR-0014 단계 3) — 잎 `domain.status` ↔ 원천 `custom_domains`(도메인 id 평문 · 이름 커밋 · rev 연속 · 창 안
 *     생성·제거에 잎이 없으면 오류). 서버는 도메인을 가진 조직의 번들에 removed 가 아닌 행을 늘 싣고, 검증기는 행의 지금 상태를 범위의 마지막 잎
 *     **또는 저장 상태의 마지막 잎**(`domain_folds`)과 접어 본다 — 잎 없이 바뀐 상태는 실패다. 창 끝 뒤에 바뀐 행은 대기로 남기고 다음 번들이
 *     풀어야 한다 — 대기 시각이 창 안으로 들어왔는데 뒤의 잎이 없으면 행의 지금 시각과 무관하게 `domain_update_leaf_missing`. 기준이 저장된 도메인
 *     행이 removed 잎 없이 번들에서 빠지면 `domain_row_missing`. **한계:** 저장 상태 없이 처음 검증하는 번들에서 범위에 잎이 없는 오래된 도메인 행은 접을
 *     기준이 없어 맥락 행으로만 센다(`agents` 와 같은 한계 — 창세부터 한 번 내려받으면 닫힌다). 서버는 그 잎이나 행이 있을 때만
 *     `min_verifier_version: 5` 를 싣는다 — 도메인이 없는 조직의 번들은 판 4 로도 읽힌다. 신원 블록 파일의 `domains`(체인 밖 도메인 사건)도 이 판이 본다.
 *     같은 판에 대표 주소 선택 잎 `identity.primary_set` ↔ 원천 `agent_primary_changes`(ADR-0014 개정 — append-only: insert 잎만, 평문 `agent_id` ·
 *     `cause`, 커밋 `c.address`, `at` = `created_at`)도 넣었다(판 6 을 피한다). 그 잎이나 행이 있으면 서버가 5 를 요구한다.
 * 6 = 운영자 · 시스템 행위자(202610131610) — `owner.action` 잎의 셋째 행위자 커밋 `c.operator` ↔ 원천 행 `actor: 'operator'`(운영자 CLI 의
 *     에이전트 삭제 · 조직 동결/해제, 플랫폼의 공유 도메인 평판 자동 동결). 행위자 종류가 없는 옛 번들의 행은 `c.operator` 잎과 맞지 않는다(옛
 *     서버는 그런 행을 만들지 않았다). 서버는 그 행이 있을 때만 `min_verifier_version: 6` 을 싣는다.
 * (1 = 신원 잎 전 — 그 검증기는 이 필드를 모르고 신원 원천 행을 `row_leaf_mismatch … table` 로 거부한다 → 소유자가 검증기를 갱신한다.)
 */
export const VERIFIER_VERSION = 6;
/** 원천 창 가장자리 여유 — 생산자(`src/tlog/proofs.ts` `SOURCE_WINDOW_SKEW_MS`)와 같은 값을 문서에서 옮겼다. */
export const SOURCE_WINDOW_SKEW_MS = 60_000;
/** M3 — `agents.updated_at` 이 번들 생성 시각(`exported_at`)보다 이만큼 넘게 뒤면 미래 시각(꾸민 값)이다. */
export const UPDATED_AT_FUTURE_SKEW_MS = 60_000;
/** 신원 잎의 원천 테이블 — M2 창 자르기 대상. */
const IDENTITY_SOURCE_TABLES: ReadonlySet<string> = new Set(['agents', 'agent_addresses', 'agent_keypairs', 'passport_documents', 'agent_primary_changes']);

export interface VerifyIssue {
  readonly code: string;
  readonly detail: string;
}

/** M3 — 창 끝 뒤에 바뀌어 접기 대조를 미룬 에이전트. 다음 번들이 `after_seq` 이후의 agent_updated 잎을 보이거나 행을 `last_leaf` 와 대조해야 풀린다. */
export interface PendingAgentUpdate {
  readonly agent: string;
  /** 이 seq 부터의 잎은 그 번들에 없었다(= 그 번들의 체크포인트 끝 크기). */
  readonly after_seq: number;
  readonly updated_at: string;
  /** 그때까지의 마지막 에이전트 잎(JCS 그대로) — 다음 번들에 새 잎이 없으면 행을 이것과 대조한다. */
  readonly last_leaf: string;
}

export interface SavedState {
  readonly origin: string;
  readonly vkey: string;
  /** 첫 통과 때 고정한 조직 로그 id(hex32) — 다른 id 의 번들은 `acceptNewLog` 없이 통과하지 않는다(M1). */
  readonly org_log: string;
  readonly checkpoint: { readonly epoch: number; readonly size: number; readonly root: string };
  readonly org: { readonly log: string; readonly size: number; readonly root: string } | null;
  /** M2 — 첫 통과 때 고정한 신원 잎 도입 시각. 다른 값의 번들은 `state_identity_since_changed`. 옛 상태 파일엔 없다. */
  readonly identity_since?: string | null;
  /** M3 — 접기 대조를 미룬 에이전트들. */
  readonly pending_agent_updates?: readonly PendingAgentUpdate[];
  /** 판 5 — 고객 도메인 행마다 마지막으로 본(체크포인트에 묶인) `domain.status` 잎과 미룬 접기 대조. */
  readonly domain_folds?: readonly DomainFold[];
}

/**
 * 판 5 — 고객 도메인 하나의 접기 기준. 서버는 도메인을 가진 조직의 번들에 removed 가 아닌 `custom_domains` 행을 **늘** 싣는다 — 범위에 그 도메인의
 * 잎이 없으면 검증기는 저장 상태의 `last_leaf` 로 행을 접어 본다(잎 없이 바뀐 상태 = 트리거를 끄고 쓴 흔적). `updated_at` 이 있으면 대기다: 창 끝
 * 뒤에 바뀌어 접기가 어긋났던 행 — 다음 번들이 `after_seq` 뒤의 잎을 보이거나 행이 `last_leaf` 와 맞아야 풀리고, 아니면 `domain_update_leaf_missing`.
 */
export interface DomainFold {
  readonly domain: string;
  readonly after_seq: number;
  readonly last_leaf: string;
  readonly updated_at: string | null;
}

export interface VerifyReport {
  readonly ok: boolean;
  /**
   * 신원 블록 파일(M4)만 — `proven`: 모든 블록 잎이 고정한 vkey 로 연 체크포인트에 포함 증명으로 묶였다 · `consistency_only`: 체인·잎 해시만
   * (증명 아님, CLI 종료 3) · `truncated`: 앞 블록이 잘려 첫 블록의 이전 해시를 확인할 수 없다(CLI 종료 3).
   */
  readonly assurance?: 'proven' | 'consistency_only' | 'truncated';
  readonly errors: readonly VerifyIssue[];
  readonly warnings: readonly string[];
  readonly stats: Readonly<Record<string, number>>;
  readonly anchors: readonly string[];
  /** 통과했을 때 저장할 상태 — 저장한 것보다 앞으로만 간다(범위가 저장한 에폭보다 뒤면 그대로). 실패하면 null(갱신하지 않는다). */
  readonly state: SavedState | null;
}

export interface VerifyOptions {
  /** 고정한 체크포인트 키(vkey). 없으면 저장한 상태의 키, 그것도 없으면 번들 것을 쓰고 경고한다. */
  readonly pinnedVkey?: string;
  readonly previous?: SavedState | null;
  /** 기대하는 로그 origin — 기본 `DEFAULT_ORIGIN`. */
  readonly origin?: string;
  /** 고정한 앵커 공개키(P-256 SPKI DER base64) — ADR-0008 §9 기록·DNS TXT. 없으면 번들의 앵커 키를 쓰고 경고한다. */
  readonly anchorKeys?: readonly string[];
  /** 고정한 Rekor 샤드 체크포인트 키(C2SP vkey) — Sigstore trusted root. 없으면 Rekor 체크포인트 서명을 확인하지 못했다고 보고한다. */
  readonly rekorVkeys?: readonly string[];
  /** 저장 상태의 조직 로그 id 와 다른 번들을 받는다(조직을 정말 바꿨을 때 — CLI `--accept-new-log`). 전역 연결은 그대로 본다. */
  readonly acceptNewLog?: boolean;
  /** M3 — 번들에 `exported_at` 이 없을 때 미래 시각 판정의 기준(기본 지금). */
  readonly now?: Date;
}

/** 창세 잎 `at` 과 첫 헤드 직전 에폭 마감 사이에 허용하는 시계 차(서열기·에폭 마감은 같은 advisory lock 아래 순서가 정해진다 — 여유는 시계 차만). */
export const GENESIS_CLOCK_SKEW_MS = 5_000;

// ---------------------------------------------------------------------------
// 원시 연산(독립 구현)
// ---------------------------------------------------------------------------

const sha256 = (...parts: readonly Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const leafHash = (data: Uint8Array): Buffer => sha256(Buffer.from([0]), data);
const nodeHash = (l: Uint8Array, r: Uint8Array): Buffer => sha256(Buffer.from([1]), l, r);
const unhex = (value: unknown): Buffer => (typeof value === 'string' && /^([0-9a-f]{2})*$/.test(value) ? Buffer.from(value, 'hex') : Buffer.alloc(0));

/** RFC 8785 JCS — 이 검증기가 다루는 값(문자열·유한 수·불리언·null·배열·객체)만. */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('유한하지 않은 수');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`JSON 이 아닌 값: ${typeof value}`);
}

/** RFC 9162 §2.1.3.2. */
function verifyInclusion(index: number, size: number, leaf: Buffer, proof: readonly Buffer[], root: Buffer): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return false;
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leaf;
  for (const p of proof) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = nodeHash(p, r);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(root);
}

/** RFC 9162 §2.1.4.2. */
function verifyConsistency(first: number, second: number, firstRoot: Buffer, secondRoot: Buffer, proof: readonly Buffer[]): boolean {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first > second || first < 0) return false;
  if (first === second) return proof.length === 0 && firstRoot.equals(secondRoot);
  if (first === 0) return proof.length === 0;
  const path = (first & (first - 1)) === 0 ? [firstRoot, ...proof] : [...proof];
  if (path.length === 0) return false;
  let fn = BigInt(first - 1);
  let sn = BigInt(second - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr = path[0] as Buffer;
  let sr = path[0] as Buffer;
  for (const c of path.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return fr.equals(firstRoot) && sr.equals(secondRoot) && sn === 0n;
}

interface Checkpoint {
  readonly origin: string;
  readonly size: number;
  readonly root: Buffer;
}

interface Vkey {
  readonly name: string;
  readonly id: Buffer;
  readonly key: Buffer;
}

/**
 * C2SP vkey — Go `note.NewVerifier` 와 같은 자르기: 이름 = 첫 `+` 앞, 키 id = 첫·둘째 `+` 사이, 키 자료 = **나머지 전부**
 * (base64 키 자료에 `+` 가 들어갈 수 있다). Ed25519(0x01)만.
 */
export function parseVkey(text: string): Vkey | null {
  const trimmed = text.trim();
  const first = trimmed.indexOf('+');
  const second = first < 0 ? -1 : trimmed.indexOf('+', first + 1);
  if (first <= 0 || second < 0) return null;
  const name = trimmed.slice(0, first);
  const idHex = trimmed.slice(first + 1, second);
  const materialText = trimmed.slice(second + 1);
  if (/\s/u.test(name) || !/^[0-9a-f]{8}$/.test(idHex)) return null;
  const material = Buffer.from(materialText, 'base64');
  if (material.toString('base64') !== materialText || material.length !== 33 || material[0] !== 0x01) return null;
  const key = material.subarray(1);
  const id = sha256(Buffer.from(name, 'utf8'), Buffer.from([0x0a, 0x01]), key).subarray(0, 4);
  if (id.toString('hex') !== idHex) return null;
  return { name, id, key };
}

function ed25519Verify(key: Buffer, message: Buffer, signature: Buffer): boolean {
  if (signature.length !== 64) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]);
  return cryptoVerify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature);
}

/** signed note 를 vkey 로 연다 — 실패하면 오류 코드. tree size 는 안전한 정수만. */
function openNote(note: string, vkey: Vkey): Checkpoint | string {
  if (typeof note !== 'string') return 'checkpoint_malformed';
  const split = note.lastIndexOf('\n\n');
  if (split < 0) return 'checkpoint_malformed';
  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2).split('\n').filter((line) => line !== '');
  const valid = lines.some((line) => {
    const match = /^— (\S+) ([A-Za-z0-9+/=]+)$/u.exec(line);
    if (match === null || match[1] !== vkey.name) return false;
    const bytes = Buffer.from(match[2] as string, 'base64');
    return bytes.subarray(0, 4).equals(vkey.id) && ed25519Verify(vkey.key, Buffer.from(text, 'utf8'), bytes.subarray(4));
  });
  if (!valid) return 'checkpoint_signature_invalid';
  const body = text.split('\n');
  if (body.length < 4 || !/^(0|[1-9][0-9]{0,15})$/.test(body[1] as string) || !Number.isSafeInteger(Number(body[1]))) return 'checkpoint_malformed';
  const root = Buffer.from(body[2] as string, 'base64');
  if (root.length !== 32) return 'checkpoint_malformed';
  return { origin: body[0] as string, size: Number(body[1]), root };
}

// ---------------------------------------------------------------------------
// 잎 재구성 규칙 (src/tlog/leaf.ts 의 명세를 문서에서 다시 옮긴 것 — ADR-0008 §2.2)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT = /^[0-9a-f]{32}$/;
const CODE = /^[a-z][a-z0-9_.:-]{0,119}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TARGET = /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** `YYYY-MM-DDTHH:MM:SS.ffffffZ` → ms(µs 는 버린다 — 비교 여유가 초 단위다). */
const instantMs = (value: string): number => Date.parse(`${value.slice(0, 23)}Z`);

interface Leaf {
  readonly v: number;
  readonly kind: string;
  readonly log: string;
  readonly seq: number;
  readonly src: { readonly t: string; readonly id: string; readonly e: string; readonly r: number } | null;
  readonly at: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly c: Readonly<Record<string, string>>;
}

class Opener {
  constructor(private readonly saltKey: Buffer | null) {}

  /** 커밋을 연다. 솔트 키가 없으면(폐기) null — 대조하지 않는다. */
  commit(leaf: Leaf, field: string, value: unknown): string | null {
    if (this.saltKey === null) return null;
    const salt = createHmac('sha256', this.saltKey).update(`${leaf.log}:${String(leaf.seq)}`, 'utf8').update(Buffer.from([0])).update(field, 'utf8').digest();
    return sha256(Buffer.from('atmark-tlog-commit-v1', 'utf8'), Buffer.from([0]), salt, Buffer.from(jcs(value), 'utf8')).toString('hex');
  }
}

/** 평문 칸 기대값 — 모양이 맞으면 값, 아니면 null + `c["body.<칸>"]`. 어긋난 칸 이름 목록을 돌려준다. */
function expectShaped(leaf: Leaf, opener: Opener, field: string, value: unknown, shape: RegExp | 'integer' | 'boolean' | 'codes'): string[] {
  const actual = leaf.body[field];
  if (value === null || value === undefined) return actual === null ? [] : [field];
  if (shape === 'integer' || shape === 'boolean') return actual === value ? [] : [field];
  const conforming = shape === 'codes' ? Array.isArray(value) && value.every((item) => typeof item === 'string' && CODE.test(item)) : typeof value === 'string' && shape.test(value);
  if (conforming) return jcs(actual) === jcs(value) ? [] : [field];
  if (actual !== null) return [field];
  const expected = opener.commit(leaf, `body.${field}`, value);
  return expected === null || leaf.c[`body.${field}`] === expected ? [] : [field];
}

function expectCommit(leaf: Leaf, opener: Opener, field: string, value: unknown): string[] {
  const expected = opener.commit(leaf, field, value);
  if (expected === null) return [];
  return leaf.c[field] === expected ? [] : [`c.${field}`];
}

type Row = Readonly<Record<string, unknown>> & { readonly t: string; readonly id: string };

/**
 * `owner.action` 의 행위자 커밋(ADR-0008 추가 절, 202609250160) — 소유자 세션이면 `c.session`, 조직 API 키면 `c.api_key`. **정확히 하나**여야
 * 한다(둘 다·둘 다 없음 = `actor`). 원천 행이 행위자 종류(`actor: 'session'|'api_key'`)를 대면 그 종류와 같은 칸이어야 한다(옛 번들의 행에는
 * 종류가 없다 — 그때는 "정확히 하나" 만 본다). 값(세션 id·키 id)은 번들에 없으므로 커밋을 열지 않는다.
 */
function expectActor(leaf: Leaf, actor: unknown): string[] {
  const session = Object.hasOwn(leaf.c, 'session');
  const apiKey = Object.hasOwn(leaf.c, 'api_key');
  // 판 6 — 운영자 · 시스템 행위자(202610131610)는 `c.operator`(행위자 · 사유 커밋 — 값은 번들에 없다).
  const operator = Object.hasOwn(leaf.c, 'operator');
  if ([session, apiKey, operator].filter(Boolean).length !== 1) return ['actor'];
  if (actor === undefined || actor === null) return operator ? ['actor'] : [];
  if (actor === 'session') return session ? [] : ['actor'];
  if (actor === 'api_key') return apiKey ? [] : ['actor'];
  if (actor === 'operator') return operator ? [] : ['actor'];
  return ['actor'];
}

/** 공개키 지문 — `hex(SHA-256(base64url 을 푼 원시 공개키))`(US-013 `identity.key_bound` 의 `key_fp`). 모양이 아니면 null. */
function keyFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return sha256(Buffer.from(value, 'base64url')).toString('hex');
}

/**
 * `billing.entitlement` 잎의 한도 칸(202609250300, ADR-0011) — 생산자 `src/tlog/leaf.ts` `ENTITLEMENT_LIMIT_FIELDS` 를 **따로** 적는다
 * (`src/**` 를 import 하지 않는다 — arch ⑥).
 */
const ENTITLEMENT_LIMIT_FIELDS = [
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
 * tlog v4 — `billing.entitlement` 잎의 늦게 더한 두 칸(생산자 `ENTITLEMENT_LATE_LIMIT_FIELDS` 를 따로 적는다). 잎마다 **둘 다 있거나 둘 다 없다**.
 */
const ENTITLEMENT_LATE_LIMIT_FIELDS = ['aliases_per_agent_max', 'attachment_bytes_total_max'] as const;

/**
 * 요금제 행(`org_entitlements`, 조직당 한 행 · 변경 가능) ↔ 그 행의 `billing.entitlement` 잎들. 어긋난 칸 이름을 돌려준다.
 *   - 잎은 전부 `billing.entitlement` · rev 가 이어지고(insert = 0) · version 이 하나씩 는다(DB 트리거 `org_entitlements_version_forward_only`).
 *   - `fold` 면 마지막 잎 = 지금 행(요금제 · 원인 · 버전 · 한도 · 유예 끝 · `at` = `updated_at`). 창 끝 뒤에 바뀐 행은 접지 않고(`fold=false`)
 *     버전이 되감기지 않았는지만 본다 — 다음 번들이 그 잎을 싣는다.
 */
function compareEntitlementRow(row: Row, leaves: readonly Leaf[], opener: Opener, fold: boolean): string[] {
  const events = leaves.filter((leaf) => leaf.kind !== 'source.missing').sort((a, b) => (a.src?.r ?? 0) - (b.src?.r ?? 0));
  if (events.some((leaf) => leaf.kind !== 'billing.entitlement')) return ['kind'];
  const out: string[] = [];
  events.forEach((leaf, index) => {
    const previous = events[index - 1];
    if (leaf.src?.e === 'insert' && leaf.src.r !== 0) out.push('insert_rev');
    // 판 4 — 9칸(레거시) 또는 11칸. 10칸(늦은 두 칸 중 하나만)은 모양이 아니다.
    const late = ENTITLEMENT_LATE_LIMIT_FIELDS.filter((field) => Object.hasOwn(leaf.body, field)).length;
    if (late !== 0 && late !== ENTITLEMENT_LATE_LIMIT_FIELDS.length) out.push('limit_fields');
    if (previous !== undefined) {
      if (leaf.src?.r !== (previous.src?.r ?? 0) + 1) out.push('update_rev_gap');
      if (leaf.body['version'] !== Number(previous.body['version']) + 1) out.push('version_gap');
    }
  });
  const last = events.at(-1);
  if (last === undefined) return out;
  if (!fold) {
    if (typeof row['version'] === 'number' && typeof last.body['version'] === 'number' && row['version'] < last.body['version']) out.push('version_rollback');
    return out;
  }
  out.push(...expectShaped(last, opener, 'plan_code', row['plan_code'], CODE));
  out.push(...expectShaped(last, opener, 'cause', row['cause'], CODE));
  out.push(...expectShaped(last, opener, 'version', row['version'], 'integer'));
  for (const field of ENTITLEMENT_LIMIT_FIELDS) out.push(...expectShaped(last, opener, field, row[field], 'integer'));
  // 판 4 — 행에 늦은 두 칸이 있으면(백필 뒤) 마지막 잎도 그 값의 11칸이어야 한다. 행이 비었으면(칸 없는 옛 스키마 · 백필 못 한 행) 잎은 9칸.
  for (const field of ENTITLEMENT_LATE_LIMIT_FIELDS) {
    const value = row[field];
    if (value === null || value === undefined) {
      if (Object.hasOwn(last.body, field)) out.push(field);
    } else if (last.body[field] !== value) out.push(field);
  }
  out.push(...expectShaped(last, opener, 'grace_until', row['grace_until'], INSTANT));
  if (last.at !== row['updated_at']) out.push('at');
  return out;
}

/**
 * 주소 행(`agent_addresses`) ↔ 그 행의 잎들(판 4). 연결 잎(insert)은 행이 신원 창 안에서 만들어졌으면 있어야 하고(`createdInWindow`), 폐기 잎
 * (update, tlog v4)은 행의 `retired_at` 이 창 안이면 있어야 한다(`retireExpected`). 폐기는 쓰기 1회라 update 잎은 많아야 하나(rev 1)다.
 */
function compareAddressRow(row: Row, leaves: readonly Leaf[], opener: Opener, createdInWindow: boolean, retireExpected: boolean): string[] {
  const out: string[] = [];
  const insert = leaves.find((leaf) => leaf.src?.e === 'insert');
  const updates = leaves.filter((leaf) => leaf.src?.e === 'update');
  if (insert !== undefined) {
    if (insert.kind !== 'identity.address_assigned') return ['kind'];
    out.push(...expectShaped(insert, opener, 'agent_id', row['agent_id'], AGENT));
    out.push(...expectShaped(insert, opener, 'primary', row['is_primary'], 'boolean'));
    if (insert.at !== row['created_at']) out.push('at');
    out.push(...expectCommit(insert, opener, 'address', row['address']));
  } else if (createdInWindow) {
    out.push('insert_leaf');
  }
  if (updates.some((leaf) => leaf.kind !== 'identity.address_retired')) return [...out, 'kind'];
  if (updates.length > 1 || updates.some((leaf) => leaf.src?.r !== 1)) out.push('update_rev_gap');
  const retire = updates[0];
  if (retire !== undefined) {
    out.push(...expectShaped(retire, opener, 'agent_id', row['agent_id'], AGENT));
    if (typeof row['retired_at'] !== 'string') out.push('retired_at');
    else if (retire.at !== row['retired_at']) out.push('at');
    out.push(...expectCommit(retire, opener, 'address', row['address']));
  } else if (retireExpected) {
    out.push('retire_leaf');
  }
  return out;
}

/**
 * 고객 도메인 행(`custom_domains`, 판 5) ↔ 그 행의 `domain.status` 잎들. 어긋난 칸 이름을 돌려준다.
 *   - 잎은 전부 `domain.status` · 평문 `domain_id` = 행 id · 커밋 `c.domain` 이 행의 도메인 이름으로 열린다.
 *   - 생성 잎(insert, rev 0, `at` = `created_at`)은 행이 창 안에서 만들어졌으면 있어야 하고(`createdInWindow`), 갱신 잎은 rev 가 이어진다.
 *   - `fold` 면 마지막 잎의 상태 · 정지 사유 · 수신 MX = 지금 행(창 끝 뒤에 바뀐 행은 접지 않는다 — 다음 번들이 그 잎을 싣는다).
 *   - 창 안에서 제거됐으면(`removedInWindow`) `removed` 잎이 있어야 한다.
 */
function compareDomainRow(row: Row, leaves: readonly Leaf[], opener: Opener, fold: boolean, createdInWindow: boolean, removedInWindow: boolean): string[] {
  const events = leaves.filter((leaf) => leaf.kind !== 'source.missing').sort((a, b) => (a.src?.r ?? 0) - (b.src?.r ?? 0));
  if (events.some((leaf) => leaf.kind !== 'domain.status')) return ['kind'];
  const out: string[] = [];
  const insert = events.find((leaf) => leaf.src?.e === 'insert');
  if (insert !== undefined) {
    if (insert.src?.r !== 0) out.push('insert_rev');
    if (insert.at !== row['created_at']) out.push('at');
  } else if (createdInWindow) {
    out.push('insert_leaf');
  }
  const updates = events.filter((leaf) => leaf.src?.e === 'update');
  updates.forEach((leaf, index) => {
    const previous = index === 0 ? (insert === undefined ? undefined : 0) : updates[index - 1]?.src?.r;
    if (previous !== undefined && leaf.src?.r !== previous + 1) out.push('update_rev_gap');
  });
  for (const leaf of events) {
    out.push(...expectShaped(leaf, opener, 'domain_id', row.id, UUID));
    out.push(...expectCommit(leaf, opener, 'domain', row['domain']));
  }
  if (removedInWindow && !events.some((leaf) => leaf.body['status'] === 'removed')) out.push('remove_leaf');
  const last = events.at(-1);
  if (last !== undefined && fold) {
    out.push(...expectShaped(last, opener, 'status', row['status'], CODE));
    out.push(...expectShaped(last, opener, 'reason', row['suspended_reason'], CODE));
    out.push(...expectShaped(last, opener, 'inbound', row['inbound_mx_status'], CODE));
  }
  return [...new Set(out)];
}

/** 판 5 — 도메인 행의 지금 상태 · 정지 사유 · 수신 MX 가 기준 잎(그 도메인의 마지막 `domain.status`)과 같은가. 어긋난 칸 이름. */
function domainFoldMismatch(row: Row, basis: Leaf, opener: Opener): string[] {
  if (basis.kind !== 'domain.status' || basis.body['domain_id'] !== row.id) return ['kind'];
  return [
    ...expectShaped(basis, opener, 'status', row['status'], CODE),
    ...expectShaped(basis, opener, 'reason', row['suspended_reason'], CODE),
    ...expectShaped(basis, opener, 'inbound', row['inbound_mx_status'], CODE),
  ];
}

/**
 * 원천 행 하나 ↔ 그 행의 잎들. 어긋난 칸 이름을 돌려준다. `agents`(변경 가능한 신원 행)는 호출자가 접기(fold) 대조를 할지(`fold`) 정한다 —
 * 창 끝 뒤에 바뀐 행은 그 사건의 잎이 이 번들에 없다(M3 대기). 이 번들에 그 에이전트의 잎이 없으면 `foldFallback`(저장 상태가 넘긴 마지막 잎)과
 * 대조한다. `createdInWindow` 면 생성 잎이 이 번들에 있어야 한다.
 */
function compareRow(row: Row, leaves: readonly Leaf[], opener: Opener, fold = true, foldFallback?: Leaf, createdInWindow = false): string[] {
  const insert = leaves.find((leaf) => leaf.src?.e === 'insert');
  const out: string[] = [];
  if (row.t === 'agents') {
    // 생성 잎은 범위 앞일 수 있다(오래된 에이전트의 상태 변경만 범위 안) — 있으면 대조하고, 갱신 잎은 범위 안에서 rev 가 이어져야 한다.
    const updates = leaves.filter((leaf) => leaf.src?.e === 'update').sort((a, b) => (a.src?.r ?? 0) - (b.src?.r ?? 0));
    if (insert !== undefined) {
      if (insert.kind !== 'identity.agent_created') return ['kind'];
      out.push(...expectShaped(insert, opener, 'agent_id', row.id, AGENT));
      if (insert.at !== row['created_at']) out.push('at');
    }
    if (updates.some((leaf) => leaf.kind !== 'identity.agent_updated')) return [...out, 'kind'];
    updates.forEach((leaf, index) => {
      out.push(...expectShaped(leaf, opener, 'agent_id', row.id, AGENT));
      const previous = index === 0 ? (insert === undefined ? undefined : 0) : updates[index - 1]?.src?.r;
      if (previous !== undefined && leaf.src?.r !== previous + 1) out.push('update_rev_gap');
    });
    if (insert === undefined && createdInWindow) out.push('insert_leaf');
    const last = updates.at(-1) ?? insert ?? foldFallback;
    if (last !== undefined && fold) {
      out.push(...expectShaped(last, opener, 'status', row['status'], CODE));
      out.push(...expectShaped(last, opener, 'suspended_by', row['suspended_by'], CODE));
      out.push(...expectCommit(last, opener, 'name', row['name']));
    }
    return out;
  }
  if (insert === undefined) return ['insert_leaf'];
  const shaped = (leaf: Leaf, field: string, value: unknown, shape: Parameters<typeof expectShaped>[4]): void => {
    out.push(...expectShaped(leaf, opener, field, value, shape));
  };
  switch (row.t) {
    case 'audit_logs': {
      if (insert.kind !== 'audit.evaluated') return ['kind'];
      shaped(insert, 'audit_id', row.id, UUID);
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'reasons', row['reasons'], 'codes');
      shaped(insert, 'policy_version', row['policy_version'], 'integer');
      shaped(insert, 'approval_id', row['approval_id'], UUID);
      shaped(insert, 'message_id', row['message_id'], UUID);
      if (insert.at !== row['evaluated_at']) out.push('at');
      if (row['message_id'] !== null && Array.isArray(row['recipients'])) {
        out.push(...expectCommit(insert, opener, 'envelope', { to: [...new Set(row['recipients'] as string[])].sort() }));
      }
      if (typeof row['rfc822_id'] === 'string') out.push(...expectCommit(insert, opener, 'rfc822_id', row['rfc822_id']));
      // 접기(fold): 마지막 사건의 변경 가능 칸 = 행의 지금 값.
      const updates = leaves.filter((leaf) => leaf.src?.e === 'update').sort((a, b) => (a.src?.r ?? 0) - (b.src?.r ?? 0));
      updates.forEach((leaf, index) => {
        if (leaf.src?.r !== index + 1) out.push('update_rev_gap');
      });
      const last = updates.at(-1) ?? insert;
      shaped(last, 'decision', row['decision'], CODE);
      shaped(last, 'resolution_reason', row['resolution_reason'], CODE);
      shaped(last, 'resolved_at', row['resolved_at'], INSTANT);
      break;
    }
    case 'owner_actions':
      if (insert.kind !== 'owner.action') return ['kind'];
      shaped(insert, 'action', row['action'], CODE);
      shaped(insert, 'target_id', row['target_id'], TARGET);
      if (insert.at !== row['created_at']) out.push('at');
      out.push(...expectActor(insert, row['actor']));
      break;
    case 'policy_versions':
      if (insert.kind !== 'policy.version') return ['kind'];
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'version', row['version'], 'integer');
      shaped(insert, 'outbound_mode', row['outbound_mode'], CODE);
      shaped(insert, 'inbound_mode', row['inbound_mode'], CODE);
      if (insert.at !== row['created_at']) out.push('at');
      out.push(...expectCommit(insert, opener, 'snapshot', row['snapshot']));
      break;
    case 'inbound_messages':
      if (insert.kind !== 'inbound.verdict') return ['kind'];
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'verdict', row['quarantined'] === true ? 'quarantined' : 'delivered', CODE);
      shaped(insert, 'quarantine_reason', row['quarantine_reason'], CODE);
      shaped(insert, 'policy_reason', row['policy_reason'], CODE);
      shaped(insert, 'from_authenticated', row['from_authenticated'], 'boolean');
      if (insert.at !== row['received_at']) out.push('at');
      out.push(...expectCommit(insert, opener, 'from', row['from_address']));
      if (typeof row['message_id_header'] === 'string') out.push(...expectCommit(insert, opener, 'rfc822_id', row['message_id_header']));
      break;
    case 'agent_addresses':
      if (insert.kind !== 'identity.address_assigned') return ['kind'];
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'primary', row['is_primary'], 'boolean');
      if (insert.at !== row['created_at']) out.push('at');
      out.push(...expectCommit(insert, opener, 'address', row['address']));
      break;
    case 'agent_primary_changes':
      // 대표 주소 선택(판 5, ADR-0014 개정) — append-only. insert 잎 하나뿐이고 update 잎이 있으면 종류 불일치다.
      if (insert.kind !== 'identity.primary_set' || leaves.some((leaf) => leaf.src?.e !== 'insert' && leaf.kind !== 'source.missing')) return ['kind'];
      if (insert.src?.r !== 0) out.push('insert_rev');
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'cause', row['cause'], CODE);
      if (insert.at !== row['created_at']) out.push('at');
      out.push(...expectCommit(insert, opener, 'address', row['address']));
      break;
    case 'agent_keypairs':
      if (insert.kind !== 'identity.key_bound') return ['kind'];
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'algorithm', row['algorithm'], CODE);
      shaped(insert, 'key_fp', keyFingerprint(row['public_key']) ?? `invalid:${String(row['public_key']).slice(0, 8)}`, HEX64);
      if (insert.at !== row['created_at']) out.push('at');
      break;
    case 'passport_documents':
      if (insert.kind !== 'identity.passport_version') return ['kind'];
      shaped(insert, 'agent_id', row['agent_id'], AGENT);
      shaped(insert, 'version', row['version'], 'integer');
      shaped(insert, 'status', row['status'], CODE);
      shaped(insert, 'content_hash', row['content_hash'], HEX64);
      if (insert.at !== row['created_at']) out.push('at');
      break;
    default:
      return ['table'];
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTS (독립 파서 — 검증에 필요한 만큼)
// ---------------------------------------------------------------------------

interface OtsFinding {
  readonly pending: string[];
  readonly bitcoin: { readonly height: number; readonly merkleRoot: string }[];
}

function readOts(bytes: Buffer, digest: Buffer): OtsFinding | string {
  let offset = 0;
  const found: OtsFinding = { pending: [], bitcoin: [] };
  const byte = (): number => {
    if (offset >= bytes.length) throw new Error('ots_truncated');
    return bytes[offset++] as number;
  };
  const varuint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
      if (shift > 49) throw new Error('ots_varuint');
    }
  };
  const take = (n: number): Buffer => {
    if (n < 0 || offset + n > bytes.length) throw new Error('ots_truncated');
    const out = bytes.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  const walk = (msg: Buffer, depth: number): void => {
    if (depth > 256) throw new Error('ots_depth');
    const step = (tag: number): void => {
      if (tag === 0x00) {
        const kind = take(8).toString('hex');
        const payload = take(varuint());
        if (kind === '83dfe30d2ef90c8e') found.pending.push(payload.subarray(1).toString('utf8'));
        else if (kind === '0588960d73d71901') {
          let height = 0;
          let shift = 0;
          for (const b of payload) {
            height += (b & 0x7f) * 2 ** shift;
            shift += 7;
            if ((b & 0x80) === 0) break;
          }
          found.bitcoin.push({ height, merkleRoot: Buffer.from(msg).reverse().toString('hex') });
        }
        return;
      }
      let next: Buffer;
      if (tag === 0xf0) next = Buffer.concat([msg, take(varuint())]);
      else if (tag === 0xf1) next = Buffer.concat([take(varuint()), msg]);
      else if (tag === 0x08) next = sha256(msg);
      else if (tag === 0x02) next = createHash('sha1').update(msg).digest();
      else if (tag === 0x03) next = createHash('ripemd160').update(msg).digest();
      else if (tag === 0xf2) next = Buffer.from(msg).reverse();
      else if (tag === 0xf3) next = Buffer.from(msg.toString('hex'), 'ascii');
      else throw new Error(`ots_op_${tag.toString(16)}`);
      if (next.length > 4096) throw new Error('ots_result_too_large');
      walk(next, depth + 1);
    };
    let tag = byte();
    while (tag === 0xff) {
      step(byte());
      tag = byte();
    }
    step(tag);
  };
  try {
    walk(digest, 0);
    if (offset !== bytes.length) return 'ots_trailing_bytes';
  } catch (error) {
    return error instanceof Error ? error.message : 'ots_invalid';
  }
  return found;
}

// ---------------------------------------------------------------------------
// 번들 검증
// ---------------------------------------------------------------------------

interface Head {
  epoch: number;
  size: number;
  root: string;
  position: number;
  epoch_size: number;
  epoch_proof: string[];
}

interface ConsistencyLink {
  from_size: number;
  to_size: number;
  proof: string[];
}

interface Bundle {
  format: string;
  min_verifier_version?: unknown;
  exported_at?: unknown;
  identity_since?: unknown;
  origin: string;
  vkey: string;
  org: { log: string; salt_key: string | null; shredded: boolean };
  range: { from_epoch: number; to_epoch: number };
  start: { size: number; frontier: { height: number; hash: string }[] };
  leaves: { id: string; seq: number; leaf: string }[];
  heads: Head[];
  checkpoints: { epoch: number; note: string; global_leaf: string; inclusion: string[] }[];
  global_consistency: { from: number; to: number; proof: string[] }[];
  org_consistency: ConsistencyLink | null;
  link?: { epoch: number; direction: string; global: ConsistencyLink; org: ConsistencyLink | null } | null;
  sources: { window_start: string; window_end: string; rows: Row[] };
  anchors: { epoch: number; target: string; endpoint: string; state: string; digest: string; receipt: string | null; upgraded: string | null }[];
  anchor_keys: string[];
}

const isSafeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isHexString = (value: unknown): value is string => typeof value === 'string' && /^([0-9a-f]{2})*$/.test(value);
const isHexList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isHexString);
const isLink = (value: unknown): value is ConsistencyLink => {
  const link = value as ConsistencyLink | null;
  return typeof link === 'object' && link !== null && isSafeCount(link.from_size) && isSafeCount(link.to_size) && isHexList(link.proof);
};

/** 번들의 모양 — 어긋나면 첫 문제. 증명·서명 검사 전에 본다(모양이 틀린 입력으로 검증기가 던지지 않게). */
function shapeProblem(bundle: Bundle): string | null {
  const record = bundle as unknown as Record<string, unknown>;
  for (const key of ['leaves', 'heads', 'checkpoints', 'global_consistency', 'anchors', 'anchor_keys']) {
    if (!Array.isArray(record[key])) return `${key} 가 배열이 아니다`;
  }
  if (typeof bundle.origin !== 'string' || typeof bundle.vkey !== 'string') return 'origin·vkey 가 문자열이 아니다';
  if (typeof bundle.org !== 'object' || bundle.org === null || typeof bundle.org.log !== 'string' || !/^[0-9a-f]{32}$/.test(bundle.org.log)) return 'org.log 모양이 아니다';
  if (bundle.org.salt_key !== null && !(isHexString(bundle.org.salt_key) && bundle.org.salt_key.length === 64)) return 'org.salt_key 모양이 아니다';
  if (typeof bundle.range !== 'object' || bundle.range === null || !isSafeCount(bundle.range.from_epoch) || !isSafeCount(bundle.range.to_epoch)) return 'range 모양이 아니다';
  if (bundle.range.from_epoch > bundle.range.to_epoch) return 'range: from_epoch > to_epoch';
  if (bundle.range.to_epoch - bundle.range.from_epoch > 100_000) return 'range 가 너무 크다';
  if (typeof bundle.start !== 'object' || bundle.start === null || !isSafeCount(bundle.start.size) || !Array.isArray(bundle.start.frontier)) return 'start 모양이 아니다';
  if (!bundle.start.frontier.every((node) => typeof node === 'object' && node !== null && isSafeCount(node.height) && node.height < 64 && isHexString(node.hash) && node.hash.length === 64)) {
    return 'start.frontier 모양이 아니다';
  }
  if (!bundle.leaves.every((entry) => typeof entry === 'object' && entry !== null && typeof entry.leaf === 'string' && isSafeCount(entry.seq))) return 'leaves 모양이 아니다';
  if (
    !bundle.heads.every(
      (head) =>
        typeof head === 'object' && head !== null && isSafeCount(head.epoch) && isSafeCount(head.size) && isHexString(head.root) && head.root.length === 64 &&
        isSafeCount(head.position) && isSafeCount(head.epoch_size) && isHexList(head.epoch_proof),
    )
  ) {
    return 'heads 모양이 아니다';
  }
  if (!bundle.checkpoints.every((entry) => typeof entry === 'object' && entry !== null && isSafeCount(entry.epoch) && typeof entry.note === 'string' && typeof entry.global_leaf === 'string' && isHexList(entry.inclusion))) {
    return 'checkpoints 모양이 아니다';
  }
  if (!bundle.global_consistency.every((link) => typeof link === 'object' && link !== null && isSafeCount(link.from) && isSafeCount(link.to) && isHexList(link.proof))) {
    return 'global_consistency 모양이 아니다';
  }
  if (bundle.org_consistency !== null && bundle.org_consistency !== undefined && !isLink(bundle.org_consistency)) return 'org_consistency 모양이 아니다';
  if (bundle.link !== null && bundle.link !== undefined) {
    const link = bundle.link;
    if (typeof link !== 'object' || !isSafeCount(link.epoch) || (link.direction !== 'forward' && link.direction !== 'backward') || !isLink(link.global)) return 'link 모양이 아니다';
    if (link.org !== null && !isLink(link.org)) return 'link.org 모양이 아니다';
  }
  if (bundle.identity_since !== undefined && bundle.identity_since !== null && !(typeof bundle.identity_since === 'string' && INSTANT.test(bundle.identity_since))) {
    return 'identity_since 모양이 아니다';
  }
  if (typeof bundle.sources !== 'object' || bundle.sources === null || !Array.isArray(bundle.sources.rows)) return 'sources 모양이 아니다';
  if (typeof bundle.sources.window_start !== 'string' || typeof bundle.sources.window_end !== 'string') return 'sources 창 모양이 아니다';
  if (!bundle.sources.rows.every((row) => typeof row === 'object' && row !== null && typeof row.t === 'string' && typeof row.id === 'string')) return 'sources.rows 모양이 아니다';
  if (!bundle.anchor_keys.every((key) => typeof key === 'string')) return 'anchor_keys 모양이 아니다';
  if (!bundle.anchors.every((anchor) => typeof anchor === 'object' && anchor !== null && isSafeCount(anchor.epoch) && typeof anchor.target === 'string' && isHexString(anchor.digest))) {
    return 'anchors 모양이 아니다';
  }
  return null;
}

function savedStateProblem(state: SavedState): string | null {
  if (typeof state !== 'object' || state === null || typeof state.vkey !== 'string' || typeof state.origin !== 'string') return '상태 파일 모양이 아니다';
  if (typeof state.org_log !== 'string' || !AGENT.test(state.org_log)) return '상태 파일의 org_log 모양이 아니다';
  const checkpoint = state.checkpoint as SavedState['checkpoint'] | undefined;
  if (checkpoint === undefined || !isSafeCount(checkpoint.epoch) || !isSafeCount(checkpoint.size) || !isHexString(checkpoint.root) || checkpoint.root.length !== 64) {
    return '상태 파일의 checkpoint 모양이 아니다';
  }
  if (state.org !== null && (typeof state.org !== 'object' || !isSafeCount(state.org.size) || !isHexString(state.org.root) || state.org.root.length !== 64)) {
    return '상태 파일의 org 모양이 아니다';
  }
  if (state.identity_since !== undefined && state.identity_since !== null && !(typeof state.identity_since === 'string' && INSTANT.test(state.identity_since))) {
    return '상태 파일의 identity_since 모양이 아니다';
  }
  const pending = state.pending_agent_updates;
  if (
    pending !== undefined &&
    !(
      Array.isArray(pending) &&
      pending.every(
        (entry: PendingAgentUpdate) =>
          typeof entry === 'object' && entry !== null && typeof entry.agent === 'string' && AGENT.test(entry.agent) && isSafeCount(entry.after_seq) &&
          typeof entry.updated_at === 'string' && INSTANT.test(entry.updated_at) && typeof entry.last_leaf === 'string',
      )
    )
  ) {
    return '상태 파일의 pending_agent_updates 모양이 아니다';
  }
  const folds = state.domain_folds;
  if (
    folds !== undefined &&
    !(
      Array.isArray(folds) &&
      folds.every(
        (entry: DomainFold) =>
          typeof entry === 'object' && entry !== null && typeof entry.domain === 'string' && UUID.test(entry.domain) && isSafeCount(entry.after_seq) &&
          typeof entry.last_leaf === 'string' && (entry.updated_at === null || (typeof entry.updated_at === 'string' && INSTANT.test(entry.updated_at))),
      )
    )
  ) {
    return '상태 파일의 domain_folds 모양이 아니다';
  }
  return null;
}

/** 번들 하나를 검증한다. 모양이 틀린 번들도 던지지 않고 `bundle_malformed` 로 실패한다. */
export function verifyBundle(input: unknown, options: VerifyOptions = {}): VerifyReport {
  try {
    return verifyWellFormed(input, options);
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: 'bundle_malformed', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) }],
      warnings: [],
      stats: {},
      anchors: [],
      state: null,
    };
  }
}

function verifyWellFormed(input: unknown, options: VerifyOptions): VerifyReport {
  const errors: VerifyIssue[] = [];
  const warnings: string[] = [];
  const anchorsReport: string[] = [];
  const fail = (code: string, detail: string): void => {
    errors.push({ code, detail });
  };
  const failed = (issues: VerifyIssue[]): VerifyReport => ({ ok: false, errors: issues, warnings, stats: {}, anchors: [], state: null });
  const bundle = input as Bundle;
  if (typeof input !== 'object' || input === null || bundle.format !== BUNDLE_FORMAT) {
    return failed([{ code: 'bundle_format', detail: `format 이 ${BUNDLE_FORMAT} 가 아니다` }]);
  }
  if (typeof bundle.min_verifier_version === 'number' && bundle.min_verifier_version > VERIFIER_VERSION) {
    return failed([
      {
        code: 'verifier_outdated',
        detail: `이 번들은 검증기 v${String(bundle.min_verifier_version)} 이상이 필요하다(이 검증기는 v${String(VERIFIER_VERSION)}) — 리포를 받아 pnpm log:verify 를 갱신한 뒤 다시 돌려라(런북 transparency-log §8)`,
      },
    ]);
  }
  const malformed = shapeProblem(bundle);
  if (malformed !== null) return failed([{ code: 'bundle_malformed', detail: malformed }]);
  const previous = options.previous ?? null;
  if (previous !== null) {
    const problem = savedStateProblem(previous);
    if (problem !== null) return failed([{ code: 'state_malformed', detail: problem }]);
  }
  const from = bundle.range.from_epoch;
  const to = bundle.range.to_epoch;

  // 1. origin · 키 고정
  const origin = options.origin ?? DEFAULT_ORIGIN;
  if (bundle.origin !== origin) fail('origin_mismatch', `번들 origin ${JSON.stringify(bundle.origin).slice(0, 80)} ≠ 고정한 ${origin}`);
  const pinned = options.pinnedVkey ?? previous?.vkey;
  if (pinned === undefined) warnings.push('vkey 를 고정하지 않았다 — 번들의 키를 믿는다(= Atmark 를 믿는다). --key 로 고정하라(ADR-0008 Q10 채널).');
  if (pinned !== undefined && pinned.trim() !== bundle.vkey) fail('vkey_mismatch', '번들의 체크포인트 키가 고정한 키와 다르다');
  if (options.pinnedVkey !== undefined && previous !== null && previous.vkey !== options.pinnedVkey.trim()) {
    warnings.push('저장한 상태의 키와 --key 가 다르다 — 키 교체(공동 서명 기간)가 아니라면 멈추고 채널을 대조하라.');
  }
  const vkey = parseVkey(pinned ?? bundle.vkey);
  if (vkey === null) return failed([...errors, { code: 'vkey_invalid', detail: 'vkey 모양이 아니다' }]);
  if (vkey.name !== origin) fail('vkey_origin_mismatch', `키 이름 ${vkey.name} ≠ origin ${origin}`);

  // 2. 전역 체크포인트 — 범위의 모든 에폭
  const opened = new Map<number, Checkpoint>();
  const epochRoots = new Map<number, Buffer>();
  const closedAt = new Map<number, string>();
  const seenEpochs = new Set<number>();
  for (const entry of bundle.checkpoints) {
    if (entry.epoch < from || entry.epoch > to || seenEpochs.has(entry.epoch)) {
      fail('checkpoint_outside_range', `epoch ${String(entry.epoch)}`);
      continue;
    }
    seenEpochs.add(entry.epoch);
    const checkpoint = openNote(entry.note, vkey);
    if (typeof checkpoint === 'string') {
      fail(checkpoint, `epoch ${String(entry.epoch)}`);
      continue;
    }
    if (checkpoint.origin !== origin) fail('checkpoint_origin_mismatch', `epoch ${String(entry.epoch)}`);
    if (checkpoint.size !== entry.epoch + 1) fail('checkpoint_size_mismatch', `epoch ${String(entry.epoch)}`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(entry.global_leaf) as Record<string, unknown>;
    } catch {
      fail('global_leaf_invalid', `epoch ${String(entry.epoch)}`);
      continue;
    }
    if (
      jcs(parsed) !== entry.global_leaf ||
      parsed['kind'] !== 'epoch' ||
      parsed['epoch'] !== entry.epoch ||
      !isHexString(parsed['epoch_root']) ||
      (parsed['epoch_root'] as string).length !== 64
    ) {
      fail('global_leaf_invalid', `epoch ${String(entry.epoch)}`);
      continue;
    }
    if (parsed['v'] !== GLOBAL_LEAF_VERSION) {
      fail('global_leaf_version', `epoch ${String(entry.epoch)} — v=${JSON.stringify(parsed['v'])} (이 검증기는 v${String(GLOBAL_LEAF_VERSION)} 만 안다)`);
      continue;
    }
    if (!verifyInclusion(entry.epoch, checkpoint.size, leafHash(Buffer.from(entry.global_leaf, 'utf8')), entry.inclusion.map(unhex), checkpoint.root)) {
      fail('global_inclusion_invalid', `epoch ${String(entry.epoch)}`);
    }
    opened.set(entry.epoch, checkpoint);
    epochRoots.set(entry.epoch, unhex(parsed['epoch_root']));
    if (typeof parsed['closed_at'] === 'string' && INSTANT.test(parsed['closed_at'])) closedAt.set(entry.epoch, parsed['closed_at']);
  }
  for (let epoch = from; epoch <= to; epoch += 1) {
    if (!seenEpochs.has(epoch)) fail('checkpoint_missing', `epoch ${String(epoch)} — 범위의 모든 에폭에 체크포인트가 있어야 한다`);
  }
  for (let epoch = from; epoch < to; epoch += 1) {
    const a = opened.get(epoch);
    const b = opened.get(epoch + 1);
    const link = bundle.global_consistency.find((item) => item.from === epoch + 1 && item.to === epoch + 2);
    if (a === undefined || b === undefined || link === undefined) {
      fail('global_consistency_missing', `epoch ${String(epoch)} → ${String(epoch + 1)}`);
      continue;
    }
    if (!verifyConsistency(a.size, b.size, a.root, b.root, link.proof.map(unhex))) fail('global_consistency_invalid', `epoch ${String(epoch)} → ${String(epoch + 1)}`);
  }

  // 3·4. 조직 로그
  const leaves: Leaf[] = [];
  const leafHashes: Buffer[] = [];
  let expectedSeq = bundle.start.size;
  for (const entry of bundle.leaves) {
    let leaf: Leaf;
    try {
      leaf = JSON.parse(entry.leaf) as Leaf;
    } catch {
      fail('leaf_not_canonical', `seq ${String(entry.seq)}`);
      leaf = { v: 0, kind: '', log: '', seq: -1, src: null, at: '', body: {}, c: {} };
    }
    if (typeof leaf !== 'object' || leaf === null || typeof leaf.body !== 'object' || leaf.body === null || typeof leaf.c !== 'object' || leaf.c === null) {
      fail('leaf_not_canonical', `seq ${String(entry.seq)}`);
      leaf = { v: 0, kind: '', log: '', seq: -1, src: null, at: '', body: {}, c: {} };
    } else if (jcs(leaf) !== entry.leaf) {
      fail('leaf_not_canonical', `seq ${String(entry.seq)}`);
    }
    if (leaf.log !== bundle.org.log) fail('leaf_log_mismatch', `seq ${String(entry.seq)}`);
    if (leaf.seq !== expectedSeq || entry.seq !== expectedSeq) fail('leaf_seq_gap', `기대 ${String(expectedSeq)}, 받음 ${String(leaf.seq)}`);
    expectedSeq += 1;
    leaves.push(leaf);
    leafHashes.push(leafHash(Buffer.from(entry.leaf, 'utf8')));
  }
  // 가장자리 → 시작 헤드, 잎을 붙이며 모든 크기의 루트를 다시 계산.
  const frontier = bundle.start.frontier.map((node) => ({ height: node.height, hash: unhex(node.hash) }));
  const frontierValid =
    frontier.reduce((sum, node) => sum + 2 ** node.height, 0) === bundle.start.size &&
    frontier.every((node, index) => index === 0 || node.height < (frontier[index - 1] as { height: number }).height);
  if (!frontierValid) fail('frontier_invalid', '가장자리가 시작 크기의 완전 부분 트리 분해가 아니다');
  const fold = (stack: readonly { height: number; hash: Buffer }[]): Buffer => {
    if (stack.length === 0) return sha256();
    let accumulator = (stack.at(-1) as { hash: Buffer }).hash;
    for (let i = stack.length - 2; i >= 0; i -= 1) accumulator = nodeHash((stack[i] as { hash: Buffer }).hash, accumulator);
    return accumulator;
  };
  const rootsBySize = new Map<number, Buffer>([[bundle.start.size, fold(frontier)]]);
  const stack = [...frontier];
  leafHashes.forEach((hash, index) => {
    let node = { height: 0, hash };
    while (stack.length > 0 && (stack.at(-1) as { height: number }).height === node.height) {
      const top = stack.pop() as { height: number; hash: Buffer };
      node = { height: node.height + 1, hash: nodeHash(top.hash, node.hash) };
    }
    stack.push(node);
    rootsBySize.set(bundle.start.size + index + 1, fold(stack));
  });
  const heads = [...bundle.heads].sort((a, b) => a.epoch - b.epoch);
  const headAt = new Map<number, Head>();
  for (const head of heads) {
    if (head.epoch < from || head.epoch > to || headAt.has(head.epoch)) {
      fail('head_outside_range', `epoch ${String(head.epoch)}`);
      continue;
    }
    headAt.set(head.epoch, head);
    const root = rootsBySize.get(head.size);
    if (root === undefined) fail('head_size_outside_bundle', `epoch ${String(head.epoch)}`);
    else if (!root.equals(unhex(head.root))) fail('head_root_mismatch', `epoch ${String(head.epoch)} — 잎에서 다시 계산한 루트가 헤드와 다르다(과거 잎이 바뀌었다)`);
    const epochRoot = epochRoots.get(head.epoch);
    const headLeaf = leafHash(Buffer.from(jcs({ epoch: head.epoch, log: bundle.org.log, size: head.size, root: head.root }), 'utf8'));
    if (epochRoot === undefined || !verifyInclusion(head.position, head.epoch_size, headLeaf, head.epoch_proof.map(unhex), epochRoot)) {
      fail('head_epoch_proof_invalid', `epoch ${String(head.epoch)}`);
    }
  }
  // 빠짐 — 시작 크기의 헤드 · 첫 헤드부터 to 까지 끊김 없음 · 잎이 있으면 to 헤드.
  if (bundle.start.size > 0) {
    const startHead = headAt.get(from);
    if (startHead === undefined) fail('start_head_missing', `시작 크기 ${String(bundle.start.size)} 인데 from(${String(from)}) 헤드가 없다 — 가장자리를 무엇에도 묶을 수 없다`);
    else if (startHead.size !== bundle.start.size) fail('start_size_mismatch', `from 헤드 크기 ${String(startHead.size)} ≠ 시작 크기 ${String(bundle.start.size)}`);
  }
  const firstHead = heads.find((head) => headAt.get(head.epoch) === head);
  if (firstHead !== undefined) {
    for (let epoch = firstHead.epoch; epoch <= to; epoch += 1) {
      if (!headAt.has(epoch)) fail('epoch_head_missing', `epoch ${String(epoch)} 에 이 조직의 헤드가 없다(에폭은 모든 조직을 담아야 한다)`);
    }
    for (let i = 1; i < heads.length; i += 1) {
      if ((heads[i] as Head).size < (heads[i - 1] as Head).size) fail('head_shrunk', `epoch ${String((heads[i] as Head).epoch)}`);
    }
  }
  const toHead = headAt.get(to);
  if (leaves.length > 0 && toHead === undefined) fail('to_head_missing', `잎 ${String(leaves.length)}개가 있는데 to(${String(to)}) 헤드가 없다 — 잎을 체크포인트에 묶을 수 없다`);
  // 5'. 조직 로그의 시작(L1) — 창세 잎부터 싣는 번들은 첫 헤드 직전 에폭이 창세 전에 닫혔음을 보여야 한다.
  if (bundle.start.size === 0 && leaves.length > 0) {
    const genesis = leaves[0] as Leaf;
    if (genesis.kind !== 'org.genesis' || typeof genesis.at !== 'string' || !INSTANT.test(genesis.at)) {
      fail('org_genesis_missing', 'seq 0 잎이 org.genesis 가 아니다');
    } else if (firstHead !== undefined && firstHead.epoch > 0) {
      const before = firstHead.epoch - 1;
      const beforeClosed = closedAt.get(before);
      if (beforeClosed === undefined) {
        fail('org_start_unproven', `첫 헤드(epoch ${String(firstHead.epoch)}) 직전 에폭 ${String(before)} 이 범위 밖이다 — from ≤ ${String(before)} 로 다시 내려받아라(앞 에폭의 헤드가 빠지지 않았음을 보일 수 없다)`);
      } else if (instantMs(beforeClosed) > instantMs(genesis.at) + GENESIS_CLOCK_SKEW_MS) {
        fail('org_start_hidden', `에폭 ${String(before)} 은 창세 잎(${genesis.at}) 뒤인 ${beforeClosed} 에 닫혔는데 이 조직 헤드가 없다 — 앞 에폭의 헤드가 빠졌다`);
      }
    }
  }
  if (previous === null && bundle.start.size > 0) {
    warnings.push(`저장한 상태가 없고 번들이 조직 로그 중간(크기 ${String(bundle.start.size)})에서 시작한다 — 에폭 ${String(from)} 앞의 역사는 보지 않았다. 처음 한 번은 창세부터(조직 로그 시작 전 에폭을 from 으로) 내려받아라.`);
  }
  if (bundle.org_consistency !== null && bundle.org_consistency !== undefined) {
    const a = rootsBySize.get(bundle.org_consistency.from_size);
    const b = rootsBySize.get(bundle.org_consistency.to_size);
    if (a === undefined || b === undefined || !verifyConsistency(bundle.org_consistency.from_size, bundle.org_consistency.to_size, a, b, bundle.org_consistency.proof.map(unhex))) {
      fail('org_consistency_invalid', `${String(bundle.org_consistency.from_size)} → ${String(bundle.org_consistency.to_size)}`);
    }
  }
  // 체크포인트에 묶인 잎 = [시작 크기, to 헤드 크기). 그 뒤 잎은 검증되지 않았다 — 따로 보고하고 원천 대조에 쓰지 않는다.
  const checkpointedSize = toHead?.size ?? bundle.start.size;
  const checkpointed = leaves.filter((leaf, index) => bundle.start.size + index < checkpointedSize);
  const uncheckpointed = leaves.length - checkpointed.length;
  if (uncheckpointed > 0) warnings.push(`체크포인트 뒤의 잎 ${String(uncheckpointed)}개는 어떤 체크포인트에도 묶이지 않았다 — 검증하지 않았고 원천 대조에서 뺐다(다음 에폭 뒤 다시 내려받아라).`);
  if (heads.length === 0) warnings.push('이 범위에 조직 헤드가 없다 — 조직 로그가 이 범위 뒤에 시작됐거나, 헤드가 빠졌다(저장한 상태가 있으면 연결 검사가 잡는다).');

  // 4. 원천 행 ↔ 잎 (양방향) — 체크포인트에 묶인 잎만
  const opener = new Opener(bundle.org.salt_key === null ? null : unhex(bundle.org.salt_key));
  if (bundle.org.salt_key === null) warnings.push('솔트 키가 폐기됐다(크립토 슈레딩) — 커밋은 열지 않고 평문 칸만 대조한다.');
  const bySource = new Map<string, Leaf[]>();
  for (const leaf of checkpointed) {
    if (leaf.src === null || typeof leaf.src !== 'object') continue;
    const key = `${String(leaf.src.t)}:${String(leaf.src.id)}`;
    bySource.set(key, [...(bySource.get(key) ?? []), leaf]);
    if (leaf.kind === 'source.missing') {
      const reason = leaf.body['reason'] === 'unrepresentable' ? '원천 행을 잎 모양으로 옮길 수 없었다' : '서열 시점에 원천 행이 없었다';
      fail('leaf_source_missing', `${key} — ${reason}`);
    }
  }
  const tailSources = new Set(
    leaves.slice(checkpointed.length).flatMap((leaf) => (leaf.src !== null && typeof leaf.src === 'object' ? [`${String(leaf.src.t)}:${String(leaf.src.id)}`] : [])),
  );

  // M2 — 신원 잎 도입 시각. 번들 안 모든 신원 잎은 그 뒤다(여유 안) · 저장 상태에 고정된 값과 같다 · 신원 원천의 창은 그 뒤에서 시작한다.
  const identitySince = typeof bundle.identity_since === 'string' ? bundle.identity_since : null;
  if (identitySince === null && bundle.sources.rows.some((row) => IDENTITY_SOURCE_TABLES.has(row.t))) {
    warnings.push('번들에 identity_since(신원 잎 도입 시각)가 없다 — 도입 전 신원 행을 가리지 못한다(옛 서버). 도입 전 행이 row_without_leaf 로 보일 수 있다.');
  }
  if (identitySince !== null) {
    for (const leaf of checkpointed) {
      if (!leaf.kind.startsWith('identity.') || typeof leaf.at !== 'string' || !INSTANT.test(leaf.at)) continue;
      if (instantMs(leaf.at) + SOURCE_WINDOW_SKEW_MS < instantMs(identitySince)) {
        fail('identity_since_after_leaf', `seq ${String(leaf.seq)} ${leaf.kind} 의 at ${leaf.at} 이 identity_since ${identitySince} 앞이다 — 도입 시각을 늦춰 창 밖으로 민 흔적`);
      }
    }
  }
  const pinnedSince = previous !== null && previous.org_log === bundle.org.log ? (previous.identity_since ?? null) : null;
  if (pinnedSince !== null && identitySince !== null && pinnedSince !== identitySince) {
    fail('state_identity_since_changed', `저장한 identity_since ${pinnedSince} ≠ 번들의 ${identitySince} — 도입 시각은 바뀌지 않는다(서버가 창을 옮겨 지운 행을 숨기는 분기)`);
  }
  const windowStartMs = Date.parse(bundle.sources.window_start);
  const windowEndMs = Date.parse(bundle.sources.window_end);
  const identityStartMs = identitySince === null ? windowStartMs : Math.max(windowStartMs, instantMs(identitySince) + SOURCE_WINDOW_SKEW_MS);
  const exportedMs = typeof bundle.exported_at === 'string' ? Date.parse(bundle.exported_at) : Number.NaN;
  const futureLimitMs = (Number.isFinite(exportedMs) ? exportedMs : (options.now ?? new Date()).getTime()) + UPDATED_AT_FUTURE_SKEW_MS;
  const checkpointedEnd = bundle.start.size + checkpointed.length;
  const carried = previous !== null && previous.org_log === bundle.org.log ? (previous.pending_agent_updates ?? []) : [];
  const carriedByAgent = new Map(carried.map((entry) => [entry.agent, entry]));
  const nextPending = new Map<string, PendingAgentUpdate>();
  const carriedFolds = new Map((previous !== null && previous.org_log === bundle.org.log ? (previous.domain_folds ?? []) : []).map((entry) => [entry.domain, entry]));
  const nextFolds = new Map<string, DomainFold>(carriedFolds);
  const handledPending = new Set<string>();
  const parseLeaf = (text: string): Leaf | undefined => {
    try {
      const parsed = JSON.parse(text) as Leaf;
      return typeof parsed === 'object' && parsed !== null && typeof parsed.body === 'object' && typeof parsed.c === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const agentLeafKinds = new Set(['identity.agent_created', 'identity.agent_updated']);
  const laterUpdateLeaf = (entry: PendingAgentUpdate): boolean =>
    checkpointed.some(
      (leaf) => leaf.kind === 'identity.agent_updated' && leaf.body['agent_id'] === entry.agent && leaf.seq >= entry.after_seq && leaf.at >= entry.updated_at,
    );

  const rowKeys = new Set<string>();
  let unverifiedRows = 0;
  let contextRows = 0;
  for (const row of bundle.sources.rows) {
    const key = `${row.t}:${row.id}`;
    rowKeys.add(key);
    const matched = bySource.get(key);
    const createdMs = typeof row['created_at'] === 'string' && INSTANT.test(row['created_at']) ? instantMs(row['created_at']) : Number.NaN;
    // 신원 행이 신원 창(도입 시각 + 여유 ~ 창 끝) 밖에서 만들어졌다 — 잎이 없어도 된다(M2 도입 전 · agents 는 조직 전체를 싣는다).
    const outsideIdentityWindow = IDENTITY_SOURCE_TABLES.has(row.t) && Number.isFinite(createdMs) && (createdMs < identityStartMs || createdMs > windowEndMs);
    if (row.t === 'agents') {
      const agentLeaves = (matched ?? []).filter((leaf) => agentLeafKinds.has(leaf.kind)).sort((a, b) => a.seq - b.seq);
      const latest = agentLeaves.at(-1);
      const carriedEntry = carriedByAgent.get(row.id);
      const carriedLeaf = carriedEntry === undefined ? undefined : parseLeaf(carriedEntry.last_leaf);
      if (carriedEntry !== undefined) handledPending.add(row.id);
      if (matched === undefined && tailSources.has(key)) {
        unverifiedRows += 1;
        if (carriedEntry !== undefined) nextPending.set(row.id, carriedEntry);
        continue;
      }
      if (matched === undefined && carriedLeaf === undefined) {
        if (outsideIdentityWindow) contextRows += 1;
        else fail('row_without_leaf', `${key} — 잎 없는 원천 행(트리거를 끄고 쓴 흔적)`);
        continue;
      }
      // 접기 대조를 할 수 있는가(M3).
      const updatedAt = typeof row['updated_at'] === 'string' && INSTANT.test(row['updated_at']) ? row['updated_at'] : null;
      let fold = true;
      let fallback = latest === undefined ? carriedLeaf : undefined;
      if (carriedEntry !== undefined && latest === undefined && bundle.start.size > carriedEntry.after_seq) {
        // 저장 상태 뒤의 잎을 이 번들이 싣지 않았다(범위를 건너뛰었다) — 그 사이 잎을 모르므로 판단하지 않고 대기를 이어 간다.
        fold = false;
        fallback = undefined;
        nextPending.set(row.id, carriedEntry);
        warnings.push(`agent_fold_pending: ${key} — 지난 번들이 미룬 대조를 이 번들로 풀 수 없다(seq ${String(carriedEntry.after_seq)} 부터의 잎이 없다). 저장한 에폭부터 이어 내려받아라.`);
      }
      if (updatedAt !== null && instantMs(updatedAt) > futureLimitMs) {
        fail('updated_at_in_future', `${key} — updated_at ${updatedAt} 이 번들 생성 시각(${String(bundle.exported_at)}) 뒤다(시각을 미래로 꾸며 접기 대조를 건너뛰려는 흔적)`);
        fold = false;
      } else if (fold && updatedAt !== null && instantMs(updatedAt) > windowEndMs && (latest === undefined || latest.at < updatedAt)) {
        fold = false;
        const basis = [latest, carriedLeaf].filter((leaf): leaf is Leaf => leaf !== undefined).sort((a, b) => b.seq - a.seq)[0];
        if (basis !== undefined) {
          nextPending.set(row.id, { agent: row.id, after_seq: checkpointedEnd, updated_at: updatedAt, last_leaf: jcs(basis) });
          warnings.push(
            `agent_fold_deferred: ${key} — 창 끝(${bundle.sources.window_end}) 뒤에 바뀌었다(updated_at ${updatedAt}). 접기 대조를 미뤘다 — 다음 번들이 뒤의 agent_updated 잎을 보이거나 이 행을 다시 대조해야 한다(저장 상태에 대기로 남겼다).`,
          );
        }
      }
      const createdInWindow = Number.isFinite(createdMs) && !outsideIdentityWindow;
      const mismatches = compareRow(row, matched ?? [], opener, fold, fallback, createdInWindow);
      if (mismatches.length > 0) fail('row_leaf_mismatch', `${key} — ${mismatches.join(', ')} (잎과 다르다: 행이 사후에 바뀌었다)`);
      continue;
    }
    if (row.t === 'agent_addresses') {
      // 주소 행(판 4) — 연결 잎은 신원 창 안에서 만든 행에, 폐기 잎은 창 안에서 폐기한 행에 있어야 한다. 폐기 시각이 미래면 꾸민 값이다.
      const retiredAt = typeof row['retired_at'] === 'string' && INSTANT.test(row['retired_at']) ? row['retired_at'] : null;
      if (retiredAt !== null && instantMs(retiredAt) > futureLimitMs) {
        fail('updated_at_in_future', `${key} — retired_at ${retiredAt} 이 번들 생성 시각(${String(bundle.exported_at)}) 뒤다(시각을 미래로 꾸며 대조를 건너뛰려는 흔적)`);
        continue;
      }
      const retiredInWindow = retiredAt !== null && instantMs(retiredAt) >= identityStartMs && instantMs(retiredAt) <= windowEndMs;
      if (matched === undefined) {
        if (tailSources.has(key)) {
          unverifiedRows += 1;
          continue;
        }
        if (outsideIdentityWindow && !retiredInWindow) {
          contextRows += 1;
          continue;
        }
        fail('row_without_leaf', `${key} — 잎 없는 원천 행(트리거를 끄고 쓴 흔적)`);
        continue;
      }
      const mismatches = compareAddressRow(row, matched, opener, !outsideIdentityWindow, retiredInWindow && !tailSources.has(key));
      if (mismatches.length > 0) fail('row_leaf_mismatch', `${key} — ${mismatches.join(', ')} (잎과 다르다: 행이 사후에 바뀌었다)`);
      continue;
    }
    if (row.t === 'org_entitlements') {
      // 요금제 행(ADR-0011) — 변경 가능한 조직당 한 행. 창 안에서 바뀌었는데(updated_at) 잎이 없으면 트리거를 끄고 쓴 흔적이다.
      if (matched === undefined && tailSources.has(key)) {
        unverifiedRows += 1;
        continue;
      }
      const updatedAt = typeof row['updated_at'] === 'string' && INSTANT.test(row['updated_at']) ? row['updated_at'] : null;
      if (updatedAt !== null && instantMs(updatedAt) > futureLimitMs) {
        fail('updated_at_in_future', `${key} — updated_at ${updatedAt} 이 번들 생성 시각(${String(bundle.exported_at)}) 뒤다(시각을 미래로 꾸며 대조를 건너뛰려는 흔적)`);
        continue;
      }
      const afterWindow = updatedAt !== null && instantMs(updatedAt) > windowEndMs;
      const inWindow = updatedAt !== null && !afterWindow && instantMs(updatedAt) >= windowStartMs;
      if (matched === undefined) {
        if (inWindow) fail('row_without_leaf', `${key} — 창 안에서 바뀐 요금제 행에 잎이 없다(트리거를 끄고 쓴 흔적)`);
        else contextRows += 1;
        continue;
      }
      if (afterWindow) warnings.push(`entitlement_fold_deferred: ${key} — 창 끝(${bundle.sources.window_end}) 뒤에 바뀌었다(updated_at ${String(updatedAt)}). 다음 번들이 그 잎을 싣는다.`);
      const mismatches = compareEntitlementRow(row, matched, opener, !afterWindow);
      if (mismatches.length > 0) fail('row_leaf_mismatch', `${key} — ${mismatches.join(', ')} (잎과 다르다: 행이 사후에 바뀌었다)`);
      continue;
    }
    if (row.t === 'custom_domains') {
      // 고객 도메인 행(판 5, ADR-0014) — 변경 가능한 행. 서버는 도메인을 가진 조직의 번들에 removed 가 아닌 행을 늘 싣고(+ 범위 잎이 가리키는 행 ·
      // 창 안에서 제거된 행), 검증기는 범위의 마지막 잎 또는 저장 상태의 마지막 잎(`domain_folds`)으로 행을 접는다.
      if (matched === undefined && tailSources.has(key)) {
        unverifiedRows += 1;
        continue;
      }
      const at = (field: string): string | null => (typeof row[field] === 'string' && INSTANT.test(row[field] as string) ? (row[field] as string) : null);
      const updatedAt = at('updated_at');
      const removedAt = at('removed_at');
      const future = [updatedAt, removedAt].find((value) => value !== null && instantMs(value) > futureLimitMs);
      if (future !== undefined) {
        fail('updated_at_in_future', `${key} — ${future} 이 번들 생성 시각(${String(bundle.exported_at)}) 뒤다(시각을 미래로 꾸며 대조를 건너뛰려는 흔적)`);
        continue;
      }
      const inWindow = (value: string | null): boolean => value !== null && instantMs(value) >= windowStartMs && instantMs(value) <= windowEndMs;
      const createdInWindow = Number.isFinite(createdMs) && createdMs >= windowStartMs && createdMs <= windowEndMs;
      const removedInWindow = inWindow(removedAt);
      const domainLeaves = (matched ?? []).filter((leaf) => leaf.kind === 'domain.status').sort((a, b) => a.seq - b.seq);
      const carriedFold = carriedFolds.get(row.id);
      // 저장 상태 뒤의 잎을 이 번들이 싣지 않았다(범위를 건너뛰었다) — 판단하지 않고 기준을 이어 간다.
      if (carriedFold !== undefined && domainLeaves.length === 0 && bundle.start.size > carriedFold.after_seq) {
        warnings.push(`domain_fold_pending: ${key} — 지난 번들의 접기 기준(seq ${String(carriedFold.after_seq)} 부터)을 이 번들로 이을 수 없다. 저장한 에폭부터 이어 내려받아라.`);
        continue;
      }
      const basis = domainLeaves.at(-1) ?? (carriedFold === undefined ? undefined : parseLeaf(carriedFold.last_leaf));
      if (matched === undefined && basis === undefined) {
        if (createdInWindow || removedInWindow) fail('row_without_leaf', `${key} — 창 안에서 만들어지거나 제거된 도메인 행에 잎이 없다(트리거를 끄고 쓴 흔적)`);
        else contextRows += 1;
        continue;
      }
      const structural = matched === undefined ? [] : compareDomainRow(row, matched, opener, false, createdInWindow, removedInWindow && !tailSources.has(key));
      if (matched === undefined && removedInWindow) structural.push('remove_leaf');
      const fold = basis === undefined ? [] : domainFoldMismatch(row, basis, opener);
      const afterWindow = updatedAt !== null && instantMs(updatedAt) > windowEndMs;
      const mismatches = [...structural];
      // 재검증 R2 — 저장된 대기 시각이 이번 창 끝 안으로 들어왔는데 그 뒤의 잎이 없으면, 행의 지금 updated_at 과 무관하게 실패다(updated_at 을 창 끝
      // 바로 뒤로 옮겨 대기를 끝없이 다시 미루는 길을 닫는다).
      const pendingDue =
        carriedFold !== undefined && carriedFold.updated_at !== null && instantMs(carriedFold.updated_at) <= windowEndMs &&
        !domainLeaves.some((leaf) => leaf.seq >= carriedFold.after_seq);
      if (pendingDue) {
        fail('domain_update_leaf_missing', `${key} — 지난 번들이 미룬 접기 대조(updated_at ${String(carriedFold.updated_at)})가 이번 창 안인데 그 뒤의 잎이 없다`);
      } else if (basis !== undefined) {
        const basisLeaf = jcs(basis);
        if (fold.length === 0) {
          nextFolds.set(row.id, { domain: row.id, after_seq: checkpointedEnd, last_leaf: basisLeaf, updated_at: null });
        } else if (afterWindow) {
          // 창 끝 뒤의 상태 변화일 수 있다 — 대기로 남기고 다음 번들이 그 잎을 보이게 한다(풀리지 않으면 domain_update_leaf_missing).
          nextFolds.set(row.id, { domain: row.id, after_seq: checkpointedEnd, last_leaf: basisLeaf, updated_at: updatedAt });
          warnings.push(`domain_fold_deferred: ${key} — 창 끝(${bundle.sources.window_end}) 뒤에 바뀐 행이 마지막 잎과 다르다(updated_at ${String(updatedAt)}). 다음 번들이 그 잎을 보여야 한다(저장 상태에 대기로 남겼다).`);
        } else {
          mismatches.push(...fold);
        }
      }
      if (mismatches.length > 0) fail('row_leaf_mismatch', `${key} — ${[...new Set(mismatches)].join(', ')} (잎과 다르다: 행이 사후에 바뀌었다)`);
      continue;
    }
    if (row.t === 'agent_primary_changes' && Number.isFinite(createdMs) && createdMs > futureLimitMs) {
      // append-only 행의 생성 시각을 미래로 꾸며 신원 창 밖(= 잎 없어도 되는 행)으로 미는 길을 닫는다.
      fail('updated_at_in_future', `${key} — created_at ${String(row['created_at'])} 이 번들 생성 시각(${String(bundle.exported_at)}) 뒤다(시각을 미래로 꾸며 대조를 건너뛰려는 흔적)`);
      continue;
    }
    if (matched === undefined) {
      if (tailSources.has(key)) {
        unverifiedRows += 1;
        continue;
      }
      if (outsideIdentityWindow) {
        contextRows += 1;
        continue;
      }
      fail('row_without_leaf', `${key} — 잎 없는 원천 행(트리거를 끄고 쓴 흔적)`);
      continue;
    }
    const mismatches = compareRow(row, matched, opener);
    if (mismatches.length > 0) fail('row_leaf_mismatch', `${key} — ${mismatches.join(', ')} (잎과 다르다: 행이 사후에 바뀌었다)`);
  }
  for (const [key, matched] of bySource) {
    if (matched.some((leaf) => leaf.kind === 'source.missing')) continue;
    if (!rowKeys.has(key)) fail('leaf_without_row', `${key} — 잎은 있는데 원천 행이 없다(지워졌다)`);
  }
  // M3 — 지난 번들이 미룬 에이전트 가운데 이 번들에 행이 없는 것.
  for (const entry of carried) {
    if (handledPending.has(entry.agent)) continue;
    if (laterUpdateLeaf(entry)) continue; // 뒤의 잎이 있다 — 행이 없으면 leaf_without_row 가 따로 잡는다.
    if (identitySince === null || bundle.start.size > entry.after_seq) {
      nextPending.set(entry.agent, entry);
      warnings.push(`agent_fold_pending: agents:${entry.agent} — 지난 번들이 미룬 대조를 이 번들로 풀 수 없다(행 또는 seq ${String(entry.after_seq)} 부터의 잎이 없다).`);
      continue;
    }
    fail(
      'agent_update_leaf_missing',
      `agents:${entry.agent} — 지난 번들이 미룬 접기 대조(updated_at ${entry.updated_at})를 이을 행도, 뒤의 identity.agent_updated 잎도 이 번들에 없다(행이 숨겨졌거나 잎 없이 바뀌었다)`,
    );
  }

  // 판 5 — 지난 번들이 미룬 도메인 접기 가운데 이 번들에 행도 뒤의 잎도 없는 것(removed 가 아닌 행은 늘 실리므로 행을 숨긴 흔적).
  // 재검증 R1 — 접기 기준이 저장된 도메인의 행이 removed 잎 없이 번들에서 빠졌다(서버는 removed 가 아닌 행을 늘 싣는다 — 트리거를 끄고 removed 로
  // 바꾸고 removed_at 을 비우면 질의가 그 행을 싣지 않는다). 대기 여부와 무관하게 실패다. 예외: 이번 범위에 그 도메인의 removed 잎이 있다 ·
  // 저장된 마지막 잎이 이미 removed · 이 번들이 저장 상태 뒤의 잎을 싣지 않았다(범위를 건너뛰었다 — 판단하지 않는다).
  for (const entry of carriedFolds.values()) {
    if (rowKeys.has(`custom_domains:${entry.domain}`)) continue;
    if (bundle.start.size > entry.after_seq) continue;
    if (parseLeaf(entry.last_leaf)?.body['status'] === 'removed') continue;
    const removedHere = checkpointed.some(
      (leaf) => leaf.kind === 'domain.status' && leaf.body['domain_id'] === entry.domain && leaf.seq >= entry.after_seq && leaf.body['status'] === 'removed',
    );
    if (removedHere) continue;
    fail('domain_row_missing', `custom_domains:${entry.domain} — 접기 기준이 저장된 도메인 행이 removed 잎 없이 번들에서 빠졌다(행을 숨겼거나 잎 없이 제거했다)`);
  }

  // 5. 저장한 상태와의 연결 — 이어지지 않으면 실패하고 상태를 갱신하지 않는다.
  const lastCheckpoint = opened.get(to);
  let nextState: SavedState | null =
    lastCheckpoint === undefined
      ? null
      : {
          origin,
          vkey: pinned ?? bundle.vkey,
          org_log: bundle.org.log,
          checkpoint: { epoch: to, size: lastCheckpoint.size, root: lastCheckpoint.root.toString('hex') },
          org: toHead === undefined ? null : { log: bundle.org.log, size: toHead.size, root: toHead.root },
          identity_since: pinnedSince ?? identitySince,
          pending_agent_updates: [...nextPending.values()],
          ...(nextFolds.size === 0 ? {} : { domain_folds: [...nextFolds.values()] }),
        };
  if (previous !== null) {
    // M1 — 조직 로그 id 고정. 새 id 로 저장 상태(조직 연결)를 건너뛰지 못한다. 받아들여도 전역 체크포인트 연결은 본다.
    let linked: SavedState = previous;
    if (previous.org_log !== bundle.org.log) {
      if (options.acceptNewLog === true) {
        warnings.push(`조직 로그 id 가 바뀌었다(${previous.org_log} → ${bundle.org.log}) — --accept-new-log 로 받아들였다. 조직 연결은 여기서 새로 시작한다(전역 체크포인트 연결은 보았다).`);
        linked = { ...previous, org_log: bundle.org.log, org: null };
      } else {
        fail(
          'state_org_log_changed',
          `저장한 조직 로그 ${previous.org_log} 와 번들의 ${bundle.org.log} 가 다르다 — 새 로그 id 로 과거를 건너뛰는 분기일 수 있다. 조직을 정말 바꿨다면 --accept-new-log`,
        );
      }
    }
    nextState = linkToPrevious({ bundle, previous: linked, origin, opened, headAt, rootsBySize, fail }) ? nextState : null;
    if (previous.checkpoint.epoch > to) nextState = linked;
  }

  // 6. 앵커
  const anchorKeys: ReturnType<typeof createPublicKey>[] = [];
  const anchorKeySource = options.anchorKeys ?? bundle.anchor_keys;
  if (options.anchorKeys === undefined && bundle.anchors.some((anchor) => anchor.target === 'rekor')) {
    warnings.push('앵커 키를 고정하지 않았다(--anchor-key) — 번들이 준 앵커 키로 Rekor 항목의 서명을 본다(= Atmark 를 믿는다).');
  }
  for (const key of anchorKeySource) {
    try {
      anchorKeys.push(createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }));
    } catch {
      fail('anchor_key_invalid', '앵커 공개키가 SPKI DER 가 아니다');
    }
  }
  const rekorVkeys = (options.rekorVkeys ?? []).map((text) => parseVkey(text));
  if (rekorVkeys.some((key) => key === null)) fail('rekor_vkey_invalid', '--rekor-key 가 C2SP vkey(Ed25519) 가 아니다');
  for (const anchor of bundle.anchors) {
    const checkpointEntry = bundle.checkpoints.find((entry) => entry.epoch === anchor.epoch);
    if (checkpointEntry === undefined) continue;
    const digest = sha256(Buffer.from(checkpointEntry.note, 'utf8'));
    if (unhex(anchor.digest).compare(digest) !== 0) {
      fail('anchor_digest_mismatch', `${anchor.target} epoch ${String(anchor.epoch)}`);
      continue;
    }
    if (typeof anchor.receipt !== 'string') {
      anchorsReport.push(`${anchor.target} ${String(anchor.endpoint)} epoch ${String(anchor.epoch)}: ${String(anchor.state)}(영수증 없음)`);
      continue;
    }
    if (anchor.target === 'opentimestamps') {
      const proof = readOts(Buffer.from(typeof anchor.upgraded === 'string' ? anchor.upgraded : anchor.receipt, 'base64'), digest);
      if (typeof proof === 'string') {
        fail('ots_invalid', `${String(anchor.endpoint)} epoch ${String(anchor.epoch)} — ${proof}`);
        continue;
      }
      anchorsReport.push(
        proof.bitcoin.length > 0
          ? `OTS ${String(anchor.endpoint)} epoch ${String(anchor.epoch)}: Bitcoin 블록 ${proof.bitcoin.map((b) => `${String(b.height)}(merkle root ${b.merkleRoot})`).join(', ')} — 캘린더의 주장(bitcoin_claimed). 블록 헤더와의 대조는 'ots verify' 로`
          : `OTS ${String(anchor.endpoint)} epoch ${String(anchor.epoch)}: 대기(pending ${proof.pending.join(', ')})`,
      );
    } else if (anchor.target === 'rekor') {
      const result = checkRekor(anchor.receipt, checkpointEntry.note, digest, anchorKeys, rekorVkeys.filter((key): key is Vkey => key !== null));
      if (typeof result === 'string') fail('rekor_invalid', `epoch ${String(anchor.epoch)} — ${result}`);
      else if (result.checkpointVerified) anchorsReport.push(`Rekor ${String(anchor.endpoint)} epoch ${String(anchor.epoch)}: 고정한 샤드 키로 연 체크포인트 · 포함 증명 · 앵커 서명 통과`);
      else {
        anchorsReport.push(`Rekor ${String(anchor.endpoint)} epoch ${String(anchor.epoch)}: 포함 증명·앵커 서명 통과 — Rekor 체크포인트 서명은 확인하지 못했다(--rekor-key 없음)`);
        warnings.push('Rekor 샤드 키를 고정하지 않았다(--rekor-key) — Rekor 영수증은 응답이 스스로 내민 루트로만 확인됐다.');
      }
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      checkpoints: opened.size,
      leaves: checkpointed.length,
      uncheckpointed_leaves: uncheckpointed,
      heads: headAt.size,
      sources: bundle.sources.rows.length - unverifiedRows - contextRows,
      unverified_sources: unverifiedRows,
      context_sources: contextRows,
      pending_agent_updates: nextPending.size,
      anchors: bundle.anchors.length,
    },
    anchors: anchorsReport,
    state: ok ? nextState : null,
  };
}

/**
 * 저장한 상태(지난번 체크포인트 E · 조직 헤드)와 번들이 이어지는가. E 가 범위 안이면 같은 루트, 범위 앞이면 `link`(forward: E → from),
 * 범위 뒤면 `link`(backward: to → E). 링크가 없거나 틀리면 실패 — **범위 밖 번들로 저장한 상태를 우회하거나 덮어쓰지 못한다**.
 */
function linkToPrevious(context: {
  readonly bundle: Bundle;
  readonly previous: SavedState;
  readonly origin: string;
  readonly opened: ReadonlyMap<number, Checkpoint>;
  readonly headAt: ReadonlyMap<number, Head>;
  readonly rootsBySize: ReadonlyMap<number, Buffer>;
  readonly fail: (code: string, detail: string) => void;
}): boolean {
  const { bundle, previous, origin, opened, headAt, rootsBySize, fail } = context;
  const from = bundle.range.from_epoch;
  const to = bundle.range.to_epoch;
  const saved = previous.checkpoint;
  const savedRoot = unhex(saved.root);
  let linked = true;
  const problem = (code: string, detail: string): void => {
    linked = false;
    fail(code, detail);
  };
  if (previous.origin !== origin) problem('state_origin_mismatch', `저장한 상태의 origin ${previous.origin} ≠ ${origin}`);
  if (saved.size !== saved.epoch + 1) problem('state_malformed', '저장한 체크포인트의 크기가 에폭 + 1 이 아니다');
  const savedOrg = previous.org;
  if (savedOrg !== null && savedOrg.log !== bundle.org.log) problem('state_org_mismatch', '저장한 상태가 다른 조직 로그의 것이다');
  const hint = `저장한 에폭 ${String(saved.epoch)} — 번들을 from ≤ ${String(saved.epoch)} 로, 또는 &since=${String(saved.epoch)} 를 붙여 다시 내려받아라`;

  if (saved.epoch >= from && saved.epoch <= to) {
    const checkpoint = opened.get(saved.epoch);
    if (checkpoint === undefined) problem('state_unlinked', `${hint} (그 에폭의 체크포인트를 열지 못했다)`);
    else if (checkpoint.size !== saved.size || !checkpoint.root.equals(savedRoot)) {
      problem('state_checkpoint_inconsistent', `epoch ${String(saved.epoch)} 의 루트가 저장한 것과 다르다(분기)`);
    }
    if (savedOrg !== null) {
      const head = headAt.get(saved.epoch);
      if (head === undefined) problem('state_unlinked', `${hint} (저장한 에폭의 조직 헤드가 번들에 없다)`);
      else if (head.size !== savedOrg.size || head.root !== savedOrg.root) {
        problem(head.size < savedOrg.size ? 'state_org_ahead' : 'state_org_inconsistent', `조직 헤드(epoch ${String(saved.epoch)})가 저장한 것과 다르다(과거가 바뀌었다)`);
      }
    }
    return linked;
  }

  const link = bundle.link ?? null;
  if (link === null || link.epoch !== saved.epoch) {
    problem('state_unlinked', hint);
    return false;
  }
  const forward = saved.epoch < from;
  if (link.direction !== (forward ? 'forward' : 'backward')) {
    problem('state_unlinked', `${hint} (link 방향이 맞지 않는다)`);
    return false;
  }
  const edge = opened.get(forward ? from : to);
  if (edge === undefined) {
    problem('state_unlinked', `${hint} (범위 끝의 체크포인트를 열지 못했다)`);
    return false;
  }
  const [globalFrom, globalTo, rootFrom, rootTo] = forward ? [saved.size, edge.size, savedRoot, edge.root] : [edge.size, saved.size, edge.root, savedRoot];
  if (link.global.from_size !== globalFrom || link.global.to_size !== globalTo || !verifyConsistency(globalFrom, globalTo, rootFrom, rootTo, link.global.proof.map(unhex))) {
    problem('state_checkpoint_inconsistent', `저장한 체크포인트(epoch ${String(saved.epoch)})와 번들의 체크포인트가 한 역사로 이어지지 않는다(분기·되감김)`);
  }
  if (savedOrg !== null) {
    // forward: 저장한 헤드 → 시작 크기(from 헤드). backward: to 헤드 → 저장한 헤드.
    const edgeHead = headAt.get(forward ? from : to);
    if (forward && (edgeHead === undefined || edgeHead.size !== bundle.start.size)) {
      problem(savedOrg.size > bundle.start.size ? 'state_org_ahead' : 'state_unlinked', `${hint} (from 에 저장한 조직 헤드와 이을 헤드가 없다)`);
      return linked;
    }
    if (!forward && edgeHead === undefined) {
      problem('state_unlinked', `${hint} (to 에 조직 헤드가 없다)`);
      return linked;
    }
    const head = edgeHead as Head;
    const headRoot = rootsBySize.get(head.size) ?? unhex(head.root);
    const [orgFrom, orgTo, orgRootFrom, orgRootTo] = forward
      ? [savedOrg.size, head.size, unhex(savedOrg.root), headRoot]
      : [head.size, savedOrg.size, headRoot, unhex(savedOrg.root)];
    const orgLink = link.org;
    if (orgFrom > orgTo) problem('state_org_ahead', '저장한 조직 헤드가 번들보다 크다 — 로그가 되감겼다');
    else if (orgLink === null || orgLink.from_size !== orgFrom || orgLink.to_size !== orgTo || !verifyConsistency(orgFrom, orgTo, orgRootFrom, orgRootTo, orgLink.proof.map(unhex))) {
      problem('state_org_inconsistent', `저장한 조직 헤드(크기 ${String(savedOrg.size)})와 번들의 헤드가 한 역사로 이어지지 않는다(과거가 바뀌었다)`);
    }
  }
  return linked;
}

interface RekorOutcome {
  readonly checkpointVerified: boolean;
}

function checkRekor(
  receiptB64: string,
  note: string,
  digest: Buffer,
  keys: readonly ReturnType<typeof createPublicKey>[],
  rekorVkeys: readonly Vkey[],
): RekorOutcome | string {
  let receipt: { request?: { hashedRekordRequestV002?: { digest?: string; signature?: { content?: string } } }; response?: Record<string, unknown> };
  try {
    receipt = JSON.parse(Buffer.from(receiptB64, 'base64').toString('utf8')) as typeof receipt;
  } catch {
    return 'receipt_not_json';
  }
  const request = receipt.request?.hashedRekordRequestV002;
  if (request?.digest !== digest.toString('base64')) return 'request_digest_mismatch';
  const signature = Buffer.from(request.signature?.content ?? '', 'base64');
  if (!keys.some((key) => cryptoVerify('sha256', Buffer.from(note, 'utf8'), key, signature))) return 'anchor_signature_invalid';
  const response = receipt.response as
    | { canonicalizedBody?: string; inclusionProof?: { logIndex?: string; treeSize?: string; rootHash?: string; hashes?: string[]; checkpoint?: { envelope?: unknown } } }
    | undefined;
  const body = Buffer.from(response?.canonicalizedBody ?? '', 'base64');
  const text = body.toString('utf8');
  if (!text.includes(digest.toString('base64')) || !text.includes(request.signature?.content ?? '\u0000')) return 'entry_body_mismatch';
  const proof = response?.inclusionProof;
  if (proof === undefined) return 'inclusion_proof_missing';
  const size = Number(proof.treeSize);
  const root = Buffer.from(proof.rootHash ?? '', 'base64');
  if (!Number.isSafeInteger(size)) return 'inclusion_proof_malformed';
  let checkpointVerified = false;
  if (rekorVkeys.length > 0) {
    const envelope = proof.checkpoint?.envelope;
    if (typeof envelope !== 'string') return 'rekor_checkpoint_missing';
    const opened = rekorVkeys.map((key) => openNote(envelope, key)).find((result): result is Checkpoint => typeof result !== 'string');
    if (opened === undefined) return 'rekor_checkpoint_signature_invalid';
    if (opened.size !== size || !opened.root.equals(root)) return 'rekor_checkpoint_mismatch';
    checkpointVerified = true;
  }
  const ok = verifyInclusion(
    Number(proof.logIndex),
    size,
    leafHash(body),
    (proof.hashes ?? []).map((hash) => Buffer.from(hash, 'base64')),
    root,
  );
  return ok ? { checkpointVerified } : 'inclusion_proof_invalid';
}

// ---------------------------------------------------------------------------
// 포함 증명 한 건(`atmark-tlog-inclusion/v1`) — 제3자에게 사건 하나만 보일 때
// ---------------------------------------------------------------------------

interface InclusionProofFile {
  readonly format: string;
  readonly origin: string;
  readonly vkey: string | null;
  readonly entry: { readonly id: string; readonly seq: number; readonly leaf: string; readonly leafHash: string };
  readonly org: { readonly log: string; readonly epoch: number; readonly treeSize: number; readonly root: string; readonly proof: string[] };
  readonly epochTree: { readonly position: number; readonly size: number; readonly epochRoot: string; readonly proof: string[] };
  readonly global: { readonly index: number; readonly treeSize: number; readonly globalLeaf: string; readonly proof: string[] };
  readonly checkpoint: string;
}

function inclusionShapeProblem(file: InclusionProofFile): string | null {
  const isHash = (value: unknown): boolean => isHexString(value) && (value as string).length === 64;
  if (typeof file.origin !== 'string' || (file.vkey !== null && typeof file.vkey !== 'string') || typeof file.checkpoint !== 'string') return 'origin·vkey·checkpoint';
  const { entry, org, epochTree, global } = file;
  if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || !isSafeCount(entry.seq) || typeof entry.leaf !== 'string' || !isHash(entry.leafHash)) return 'entry';
  if (typeof org !== 'object' || org === null || !isHexString(org.log) || org.log.length !== 32 || !isSafeCount(org.epoch) || !isSafeCount(org.treeSize) || !isHash(org.root) || !isHexList(org.proof)) return 'org';
  if (typeof epochTree !== 'object' || epochTree === null || !isSafeCount(epochTree.position) || !isSafeCount(epochTree.size) || !isHash(epochTree.epochRoot) || !isHexList(epochTree.proof)) return 'epochTree';
  if (typeof global !== 'object' || global === null || !isSafeCount(global.index) || !isSafeCount(global.treeSize) || typeof global.globalLeaf !== 'string' || !isHexList(global.proof)) return 'global';
  return null;
}

/**
 * 포함 증명 한 건을 검증한다 — **체크포인트 서명(고정한 vkey)** → 전역 잎의 체크포인트 포함 → 조직 헤드의 에폭 트리 포함 → 잎의 조직 트리 포함.
 * 통과하면 "이 잎(JSON 그대로)은 서명된 체크포인트 k 에 들어 있다" 가 선다. 잎의 커밋(`c`)을 여는 솔트는 이 파일에 없다(번들의 솔트 키로
 * `HMAC-SHA256(key, "<log>:<seq>" ‖ 0x00 ‖ 필드)` — 런북 §8). 저장 상태는 읽지도 갱신하지도 않는다(`state: null`).
 */
export function verifyInclusionProof(input: unknown, options: Pick<VerifyOptions, 'pinnedVkey' | 'origin'> = {}): VerifyReport {
  const errors: VerifyIssue[] = [];
  const warnings: string[] = [];
  const report = (stats: Readonly<Record<string, number>> = {}): VerifyReport => ({ ok: errors.length === 0, errors, warnings, stats, anchors: [], state: null });
  const fail = (code: string, detail: string): void => {
    errors.push({ code, detail });
  };
  const file = input as InclusionProofFile;
  if (typeof input !== 'object' || input === null || file.format !== INCLUSION_FORMAT) {
    fail('inclusion_format', `format 이 ${INCLUSION_FORMAT} 가 아니다`);
    return report();
  }
  const malformed = inclusionShapeProblem(file);
  if (malformed !== null) {
    fail('inclusion_malformed', malformed);
    return report();
  }
  // 1. origin · 키 고정
  const origin = options.origin ?? DEFAULT_ORIGIN;
  if (file.origin !== origin) fail('origin_mismatch', `파일 origin ${JSON.stringify(file.origin).slice(0, 80)} ≠ 고정한 ${origin}`);
  const pinned = options.pinnedVkey?.trim();
  if (pinned === undefined) warnings.push('vkey 를 고정하지 않았다 — 파일의 키를 믿는다(= Atmark 를 믿는다). --key 로 고정하라(ADR-0008 Q10 채널).');
  else if (pinned !== file.vkey) fail('vkey_mismatch', '파일의 체크포인트 키가 고정한 키와 다르다');
  const vkey = parseVkey(pinned ?? file.vkey ?? '');
  if (vkey === null) {
    fail('vkey_invalid', 'vkey 모양이 아니다');
    return report();
  }
  if (vkey.name !== origin) fail('vkey_origin_mismatch', `키 이름 ${vkey.name} ≠ origin ${origin}`);
  // 2. 체크포인트 — 서명 · 크기 = 에폭 + 1
  const checkpoint = openNote(file.checkpoint, vkey);
  if (typeof checkpoint === 'string') {
    fail(checkpoint, `epoch ${String(file.org.epoch)}`);
    return report();
  }
  if (checkpoint.origin !== origin) fail('checkpoint_origin_mismatch', `epoch ${String(file.org.epoch)}`);
  if (checkpoint.size !== file.global.treeSize || file.global.index !== file.org.epoch || checkpoint.size !== file.org.epoch + 1) {
    fail('checkpoint_size_mismatch', `체크포인트 크기 ${String(checkpoint.size)} · 전역 index ${String(file.global.index)} · 에폭 ${String(file.org.epoch)}`);
  }
  // 3. 전역 잎(에폭) → 체크포인트
  let globalLeaf: Record<string, unknown> | null = null;
  try {
    globalLeaf = JSON.parse(file.global.globalLeaf) as Record<string, unknown>;
  } catch {
    globalLeaf = null;
  }
  if (
    globalLeaf === null ||
    typeof globalLeaf !== 'object' ||
    jcs(globalLeaf) !== file.global.globalLeaf ||
    globalLeaf['kind'] !== 'epoch' ||
    globalLeaf['epoch'] !== file.org.epoch ||
    globalLeaf['epoch_root'] !== file.epochTree.epochRoot
  ) {
    fail('global_leaf_invalid', `epoch ${String(file.org.epoch)}`);
  } else if (globalLeaf['v'] !== GLOBAL_LEAF_VERSION) {
    fail('global_leaf_version', `v=${JSON.stringify(globalLeaf['v'])} (이 검증기는 v${String(GLOBAL_LEAF_VERSION)} 만 안다)`);
  }
  if (!verifyInclusion(file.global.index, checkpoint.size, leafHash(Buffer.from(file.global.globalLeaf, 'utf8')), file.global.proof.map(unhex), checkpoint.root)) {
    fail('global_inclusion_invalid', `epoch ${String(file.org.epoch)}`);
  }
  // 4. 조직 헤드 → 에폭 루트
  const headLeaf = leafHash(Buffer.from(jcs({ epoch: file.org.epoch, log: file.org.log, size: file.org.treeSize, root: file.org.root }), 'utf8'));
  if (!verifyInclusion(file.epochTree.position, file.epochTree.size, headLeaf, file.epochTree.proof.map(unhex), unhex(file.epochTree.epochRoot))) {
    fail('head_epoch_proof_invalid', `epoch ${String(file.org.epoch)}`);
  }
  // 5. 잎 → 조직 헤드
  const leafBytes = Buffer.from(file.entry.leaf, 'utf8');
  if (leafHash(leafBytes).toString('hex') !== file.entry.leafHash) fail('leaf_hash_mismatch', `entry ${file.entry.id.slice(0, 20)}`);
  let leaf: { log?: unknown; seq?: unknown } | null = null;
  try {
    leaf = JSON.parse(file.entry.leaf) as { log?: unknown; seq?: unknown };
  } catch {
    leaf = null;
  }
  if (leaf === null || typeof leaf !== 'object' || jcs(leaf) !== file.entry.leaf) fail('leaf_not_canonical', `seq ${String(file.entry.seq)}`);
  else {
    if (leaf.log !== file.org.log) fail('leaf_log_mismatch', `seq ${String(file.entry.seq)}`);
    if (leaf.seq !== file.entry.seq) fail('leaf_seq_gap', `잎의 seq ${JSON.stringify(leaf.seq)} ≠ ${String(file.entry.seq)}`);
  }
  if (file.entry.seq >= file.org.treeSize || !verifyInclusion(file.entry.seq, file.org.treeSize, leafHash(leafBytes), file.org.proof.map(unhex), unhex(file.org.root))) {
    fail('org_inclusion_invalid', `seq ${String(file.entry.seq)} · 조직 트리 ${String(file.org.treeSize)}`);
  }
  return report({ epoch: file.org.epoch, seq: file.entry.seq, org_tree_size: file.org.treeSize, checkpoint_size: checkpoint.size });
}

// ---------------------------------------------------------------------------
// 신원 변경 이력 블록(US-013) — `atmark-identity-blocks/v1`
// ---------------------------------------------------------------------------

const IDENTITY_KINDS = new Set([
  'identity.agent_created',
  'identity.agent_updated',
  'identity.address_assigned',
  'identity.key_bound',
  'identity.passport_version',
  // 판 4 — tlog v4 별칭 폐기.
  'identity.address_retired',
  // 판 5 — 대표 주소 선택(ADR-0014 개정).
  'identity.primary_set',
]);
const ZERO_BLOCK = '00'.repeat(32);

interface IdentityBlocksFile {
  readonly format?: unknown;
  readonly agentId?: unknown;
  readonly truncated?: unknown;
  readonly blocks?: unknown;
  readonly missing?: unknown;
  /** 판 5 — 고객 도메인 사건(`domain.status` 잎, 체인 밖). */
  readonly domains?: unknown;
  readonly proof?: unknown;
}

/** M4 — 블록 파일의 공통 닻(서버 `checkpointAnchorFor`). 포함 증명 파일과 같은 칸 이름이다. */
interface BlocksAnchor {
  readonly origin: string;
  readonly vkey: string | null;
  readonly checkpoint: string;
  readonly org: { readonly log: string; readonly epoch: number; readonly treeSize: number; readonly root: string };
  readonly epochTree: { readonly position: number; readonly size: number; readonly epochRoot: string; readonly proof: string[] };
  readonly global: { readonly index: number; readonly treeSize: number; readonly globalLeaf: string; readonly proof: string[] };
}

/**
 * 닻을 연다 — 고정한 vkey 로 체크포인트 서명 → 크기 = 에폭 + 1 → 전역 잎(에폭) 포함 → 조직 헤드의 에폭 트리 포함. 통과하면 조직 트리(크기·루트).
 * 포함 증명 한 건(`verifyInclusionProof`)의 1~4 단계와 같은 규칙이다.
 */
function openBlocksAnchor(anchor: BlocksAnchor, vkey: Vkey, origin: string, fail: (code: string, detail: string) => void): { size: number; root: Buffer; log: string } | null {
  const isHash = (value: unknown): boolean => isHexString(value) && (value as string).length === 64;
  const { org, epochTree, global } = anchor;
  if (
    typeof anchor.checkpoint !== 'string' || typeof org !== 'object' || org === null || !isHexString(org.log) || org.log.length !== 32 ||
    !isSafeCount(org.epoch) || !isSafeCount(org.treeSize) || !isHash(org.root) || typeof epochTree !== 'object' || epochTree === null ||
    !isSafeCount(epochTree.position) || !isSafeCount(epochTree.size) || !isHash(epochTree.epochRoot) || !isHexList(epochTree.proof) ||
    typeof global !== 'object' || global === null || !isSafeCount(global.index) || typeof global.globalLeaf !== 'string' || !isHexList(global.proof)
  ) {
    fail('identity_blocks_proof_malformed', 'proof');
    return null;
  }
  if (anchor.origin !== origin) fail('origin_mismatch', `파일 origin ${JSON.stringify(anchor.origin).slice(0, 80)} ≠ 고정한 ${origin}`);
  const checkpoint = openNote(anchor.checkpoint, vkey);
  if (typeof checkpoint === 'string') {
    fail(checkpoint, `epoch ${String(org.epoch)}`);
    return null;
  }
  let ok = true;
  const problem = (code: string, detail: string): void => {
    ok = false;
    fail(code, detail);
  };
  if (checkpoint.origin !== origin) problem('checkpoint_origin_mismatch', `epoch ${String(org.epoch)}`);
  if (checkpoint.size !== org.epoch + 1 || global.index !== org.epoch) problem('checkpoint_size_mismatch', `체크포인트 크기 ${String(checkpoint.size)} · 에폭 ${String(org.epoch)}`);
  let globalLeaf: Record<string, unknown> | null = null;
  try {
    globalLeaf = JSON.parse(global.globalLeaf) as Record<string, unknown>;
  } catch {
    globalLeaf = null;
  }
  if (
    globalLeaf === null || typeof globalLeaf !== 'object' || jcs(globalLeaf) !== global.globalLeaf || globalLeaf['kind'] !== 'epoch' ||
    globalLeaf['epoch'] !== org.epoch || globalLeaf['epoch_root'] !== epochTree.epochRoot || globalLeaf['v'] !== GLOBAL_LEAF_VERSION
  ) {
    problem('global_leaf_invalid', `epoch ${String(org.epoch)}`);
  }
  if (!verifyInclusion(global.index, checkpoint.size, leafHash(Buffer.from(global.globalLeaf, 'utf8')), global.proof.map(unhex), checkpoint.root)) {
    problem('global_inclusion_invalid', `epoch ${String(org.epoch)}`);
  }
  const headLeaf = leafHash(Buffer.from(jcs({ epoch: org.epoch, log: org.log, size: org.treeSize, root: org.root }), 'utf8'));
  if (!verifyInclusion(epochTree.position, epochTree.size, headLeaf, epochTree.proof.map(unhex), unhex(epochTree.epochRoot))) {
    problem('head_epoch_proof_invalid', `epoch ${String(org.epoch)}`);
  }
  return ok ? { size: org.treeSize, root: unhex(org.root), log: org.log } : null;
}

/**
 * 신원 블록 파일을 검증한다 — 블록마다 ① 잎이 JCS 정규형이고 `identity.*` 종류이며 `body.agent_id` 가 파일의 에이전트다 ② `leafHash` =
 * SHA-256(0x00 ‖ 잎) ③ `seq` 가 늘어난다 ④ `prevBlockHash` = 앞 블록의 `blockHash`(첫 블록은 0×32) · `blockHash` = SHA-256(prevBlockHash ‖ leafHash)
 * ⑤ **모든 잎이 한 조직 로그(`log`)의 것**이다.
 *
 * **체인만으로는 로그에 있다는 증거가 아니다**(적대적 검증 M4 — 서버가 체인을 새로 지어 내면 통과한다). 그래서 결과는 셋이다(`assurance`):
 *   - `proven`: 파일의 공통 닻(`proof` — 콘솔 "내려받기" = `?proofs=1`)을 **고정한 vkey**(`pinnedVkey`)와 origin 으로 열고, 모든 블록의 잎이 그 조직
 *     트리에 포함 증명(`inclusion`)으로 묶였다. `ok` 는 이때만 참이다. `checkpointed` = 증명이 검증된 블록 수(파일의 `checkpoint` 주장은 세지 않는다).
 *   - `consistency_only`: 체인·잎 해시만 맞다(닻 없음 · 키 고정 안 함 · 증명 없는 블록) — CLI 종료 3 "일관성만, 증명 아님".
 *   - `truncated`: 앞 블록이 잘렸다(첫 블록의 이전 해시를 확인할 수 없다) — CLI 종료 3.
 * 빠진 블록(`missing` — `source.missing` 잎, L4)은 체인 밖이다: 모양 · 같은 로그 · 잎 해시 · (닻이 있으면) 포함을 보고 경고로 알린다.
 * 저장 상태는 읽지도 쓰지도 않는다.
 */
export function verifyIdentityBlocks(input: unknown, options: Pick<VerifyOptions, 'pinnedVkey' | 'origin'> = {}): VerifyReport {
  const errors: VerifyIssue[] = [];
  const warnings: string[] = [];
  const fail = (code: string, detail: string): void => {
    errors.push({ code, detail });
  };
  const file = input as IdentityBlocksFile;
  const report = (assurance: VerifyReport['assurance'], stats: Readonly<Record<string, number>> = {}): VerifyReport => ({
    ok: errors.length === 0 && assurance === 'proven',
    ...(assurance === undefined ? {} : { assurance }),
    errors,
    warnings,
    stats,
    anchors: [],
    state: null,
  });
  if (typeof input !== 'object' || input === null || file.format !== IDENTITY_BLOCKS_FORMAT) {
    fail('identity_blocks_format', `format 이 ${IDENTITY_BLOCKS_FORMAT} 가 아니다`);
    return report(undefined);
  }
  if (
    typeof file.agentId !== 'string' || !AGENT.test(file.agentId) || !Array.isArray(file.blocks) || (file.missing !== undefined && !Array.isArray(file.missing)) ||
    (file.domains !== undefined && !Array.isArray(file.domains))
  ) {
    fail('identity_blocks_malformed', 'agentId · blocks · missing · domains');
    return report(undefined);
  }
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const logs = new Set<string>();
  type BlockLeaf = { kind?: unknown; seq?: unknown; log?: unknown; body?: { agent_id?: unknown; reason?: unknown } };
  const parseCanonical = (text: string, label: string): BlockLeaf | null => {
    let leaf: BlockLeaf | null;
    try {
      leaf = JSON.parse(text) as BlockLeaf | null;
    } catch {
      leaf = null;
    }
    if (leaf === null || typeof leaf !== 'object' || jcs(leaf) !== text) {
      fail('leaf_not_canonical', label);
      return null;
    }
    logs.add(typeof leaf.log === 'string' ? leaf.log : '');
    return leaf;
  };

  // 공통 닻 — 고정한 vkey 로만 연다(파일의 vkey 를 믿는 것은 Atmark 를 믿는 것이다).
  let tree: { size: number; root: Buffer; log: string } | null = null;
  const pinned = options.pinnedVkey?.trim();
  if (file.proof !== undefined && file.proof !== null) {
    const anchor = file.proof as BlocksAnchor;
    if (pinned === undefined) {
      warnings.push('vkey 를 고정하지 않았다(--key) — 포함 증명을 보지 않았다. 고정한 키 없이는 "일관성만, 증명 아님" 이다.');
    } else {
      if (typeof anchor === 'object' && anchor !== null && anchor.vkey !== null && anchor.vkey !== undefined && anchor.vkey !== pinned) {
        fail('vkey_mismatch', '파일의 체크포인트 키가 고정한 키와 다르다');
      }
      const vkey = parseVkey(pinned);
      if (vkey === null) fail('vkey_invalid', 'vkey 모양이 아니다');
      else if (vkey.name !== origin) fail('vkey_origin_mismatch', `키 이름 ${vkey.name} ≠ origin ${origin}`);
      else if (typeof anchor !== 'object' || anchor === null) fail('identity_blocks_proof_malformed', 'proof');
      else tree = openBlocksAnchor(anchor, vkey, origin, fail);
    }
  } else {
    warnings.push('파일에 포함 증명이 없다 — 콘솔 "내려받기"(proofs=1)로 받은 파일이어야 블록을 서명된 체크포인트에 묶을 수 있다.');
  }
  const proven = (seq: unknown, leafText: string, inclusion: unknown, label: string): boolean => {
    if (tree === null || !isHexList(inclusion) || typeof seq !== 'number' || !isSafeCount(seq)) return false;
    if (seq >= tree.size || !verifyInclusion(seq, tree.size, leafHash(Buffer.from(leafText, 'utf8')), inclusion.map(unhex), tree.root)) {
      fail('identity_block_inclusion_invalid', `${label} — seq ${String(seq)} 이 조직 트리(크기 ${String(tree.size)})에 없다`);
      return false;
    }
    return true;
  };

  let prev = ZERO_BLOCK;
  let lastSeq = -1;
  let checkpointed = 0;
  let unproven = 0;
  const truncated = file.truncated === true;
  file.blocks.forEach((raw: unknown, index: number) => {
    const block = raw as Record<string, unknown>;
    const label = `block ${String(index)}`;
    if (typeof block !== 'object' || block === null || typeof block['leaf'] !== 'string' || !isHexString(block['leafHash']) || !isHexString(block['prevBlockHash']) || !isHexString(block['blockHash'])) {
      fail('identity_block_malformed', label);
      return;
    }
    const leafText = block['leaf'];
    const leaf = parseCanonical(leafText, label);
    if (leaf !== null) {
      if (typeof leaf.kind !== 'string' || !IDENTITY_KINDS.has(leaf.kind)) fail('identity_block_kind', `${label} — ${String(leaf.kind).slice(0, 40)}`);
      if (leaf.body?.agent_id !== file.agentId) fail('identity_block_agent', `${label} — 다른 에이전트의 잎`);
      if (typeof leaf.seq !== 'number' || leaf.seq <= lastSeq || block['seq'] !== leaf.seq) fail('identity_block_order', `${label} — seq`);
      if (typeof leaf.seq === 'number') lastSeq = leaf.seq;
    }
    const recomputed = leafHash(Buffer.from(leafText, 'utf8')).toString('hex');
    if (recomputed !== block['leafHash']) fail('leaf_hash_mismatch', label);
    if (index === 0 && truncated) {
      prev = block['prevBlockHash'];
      warnings.push('앞 블록이 잘렸다(truncated) — 첫 블록의 이전 해시는 확인할 수 없다(파일의 값을 받아들였다). 잘린 파일은 통과가 아니다.');
    }
    if (block['prevBlockHash'] !== prev) fail('identity_block_unlinked', `${label} — 이전 블록 해시가 앞 블록과 다르다`);
    const expected = sha256(Buffer.from(prev, 'hex'), Buffer.from(recomputed, 'hex')).toString('hex');
    if (block['blockHash'] !== expected) fail('identity_block_hash_mismatch', label);
    prev = expected;
    if (proven(leaf?.seq, leafText, block['inclusion'], label)) checkpointed += 1;
    else unproven += 1;
  });
  const missingEntries = (file.missing ?? []) as unknown[];
  let missingProven = 0;
  missingEntries.forEach((raw: unknown, index: number) => {
    const entry = raw as Record<string, unknown>;
    const label = `missing ${String(index)}`;
    if (typeof entry !== 'object' || entry === null || typeof entry['leaf'] !== 'string' || !isHexString(entry['leafHash'])) {
      fail('identity_missing_malformed', label);
      return;
    }
    const leaf = parseCanonical(entry['leaf'], label);
    if (leaf !== null && leaf.kind !== 'source.missing') fail('identity_missing_kind', `${label} — ${String(leaf.kind).slice(0, 40)}`);
    if (leafHash(Buffer.from(entry['leaf'], 'utf8')).toString('hex') !== entry['leafHash']) fail('leaf_hash_mismatch', label);
    if (proven(leaf?.seq, entry['leaf'], entry['inclusion'], label)) missingProven += 1;
  });
  // 판 5 — 고객 도메인 사건(체인 밖): 모양 · `domain.status` 종류 · 잎 해시 · 같은 로그 · (닻이 있으면) 포함. 체인·assurance 에는 넣지 않는다.
  const domainEntries = (file.domains ?? []) as unknown[];
  let domainsProven = 0;
  domainEntries.forEach((raw: unknown, index: number) => {
    const entry = raw as Record<string, unknown>;
    const label = `domain ${String(index)}`;
    if (typeof entry !== 'object' || entry === null || typeof entry['leaf'] !== 'string' || !isHexString(entry['leafHash'])) {
      fail('identity_domain_malformed', label);
      return;
    }
    const leaf = parseCanonical(entry['leaf'], label);
    if (leaf !== null && leaf.kind !== 'domain.status') fail('identity_domain_kind', `${label} — ${String(leaf.kind).slice(0, 40)}`);
    if (leafHash(Buffer.from(entry['leaf'], 'utf8')).toString('hex') !== entry['leafHash']) fail('leaf_hash_mismatch', label);
    if (proven(leaf?.seq, entry['leaf'], entry['inclusion'], label)) domainsProven += 1;
  });
  if (domainEntries.length > domainsProven && tree !== null) {
    warnings.push(`도메인 사건 ${String(domainEntries.length - domainsProven)}건은 서명된 체크포인트에 묶이지 않았다(체크포인트 전) — 다음 정시 뒤 다시 내려받아라.`);
  }
  // ⑤ 한 조직 로그 — 다른 로그의 잎을 섞어 체인을 지어 내지 못한다. 닻이 있으면 그 로그여야 한다.
  if (logs.size > 1) fail('identity_blocks_log_mixed', `잎이 조직 로그 ${String(logs.size)}개에 걸쳐 있다 — 한 에이전트의 블록은 한 로그의 잎이다`);
  const onlyLog = [...logs][0];
  if (tree !== null && onlyLog !== undefined && logs.size === 1 && onlyLog !== tree.log) fail('identity_blocks_log_mismatch', '잎의 로그가 증명의 조직 로그와 다르다');
  if (missingEntries.length > 0) {
    warnings.push(`빠진 블록 ${String(missingEntries.length)}건 — 원천 행이 서열 시점에 없었던(또는 옮길 수 없었던) 신원 사건이다(source.missing). 운영자에게 알려라.`);
  }
  const assurance: VerifyReport['assurance'] = truncated ? 'truncated' : tree !== null && file.blocks.length > 0 && unproven === 0 ? 'proven' : 'consistency_only';
  if (assurance === 'consistency_only' && file.blocks.length > 0) {
    warnings.push(`블록 ${String(unproven)}개는 서명된 체크포인트에 묶이지 않았다 — 일관성만, 증명 아님(체크포인트 전 블록은 다음 정시 뒤 다시 내려받아라).`);
  }
  return report(assurance, {
    blocks: file.blocks.length,
    checkpointed,
    missing: missingEntries.length,
    missing_proven: missingProven,
    domains: domainEntries.length,
    domains_proven: domainsProven,
  });
}
