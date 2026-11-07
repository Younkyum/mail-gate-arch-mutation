/**
 * src/tlog/constants.ts — 투명성 로그의 **형식 상수**(ADR-0008 §2). 여기 값은 발급된 체크포인트·잎과 함께 동결된다 —
 * 바꾸면 이미 게시된 역사가 검증되지 않는다. 바꿔야 하면 새 origin(`…/v2`)으로 새 로그를 시작한다(ADR-0008 §2.4 "키 교체" 와 다르다).
 */

/** C2SP tlog-checkpoint origin — 스키마 없는 URL, 공백·`+` 없음(c2sp.org/tlog-checkpoint). 서명 키 이름도 이 값이다. */
export const TLOG_ORIGIN = 'id.atmark.ai/log/v1';

/** 조직 잎 봉투 버전(`v`). */
export const LEAF_VERSION = 1;

/**
 * 전역 공개 로그의 에폭 잎 버전(`v`) — **2**(2026-09-24, 배포 전 변경): 에폭 트리의 잎이 `{epoch, log, size, root}` 다(ADR-0008 §2.1 · §9.2 ⑩).
 * v1 은 `{log, size, root}` 였다 — 활동 없는 조직의 잎이 에폭마다 같아서, 이웃 조직이 받은 포함 증명의 형제 해시가 에폭 사이에 바뀌었는지로
 * 그 조직의 활동 여부가 드러났다. 에폭을 잎에 넣으면 모든 잎이 에폭마다 달라진다. 검증기는 v2 만 받는다.
 */
export const GLOBAL_LEAF_VERSION = 2;

/** 커밋 영역 분리 문자열(ADR-0008 §2.2 `c_f`). */
export const COMMIT_DOMAIN = 'atmark-tlog-commit-v1';

/** 조직 로그 id 바이트 수 — 무작위(조직 uuid 와 연결되지 않는다, §2.1). */
export const ORG_LOG_ID_BYTES = 16;

/** 조직 솔트 키 바이트 수. */
export const SALT_KEY_BYTES = 32;

/** 잎 종류 — 조직 로그. `source.missing` 은 outbox 가 가리키는 원천 행이 서열 시점에 **없었다**는 사실 자체를 커밋한다(변조 흔적). */
export const ORG_LEAF_KINDS = [
  'org.genesis',
  'audit.evaluated',
  'audit.updated',
  'owner.action',
  'policy.version',
  'inbound.verdict',
  'source.missing',
  'identity.agent_created',
  'identity.agent_updated',
  'identity.address_assigned',
  'identity.key_bound',
  'identity.passport_version',
  // 과금 P0(202609250300, ADR-0011) — 조직 엔타이틀먼트 한 버전(요금제 코드 · 한도 수치 · 유예 끝 · 버전 · 원인). 금액·고객 id 없음.
  'billing.entitlement',
  // tlog v4(202609270115, ADR-0013 A6) — 별칭 폐기(`agent_addresses.retired_at` NULL → 값). 주소는 커밋으로만.
  'identity.address_retired',
  // 고객 도메인(202609291130, ADR-0014) — `custom_domains` 상태 한 버전(outbox 스냅샷): 도메인 id · 상태 · 정지 사유 · 수신 MX 판정. 도메인 이름은 커밋으로만.
  'domain.status',
  // 대표 주소 선택(202610021110, ADR-0014 2026-10 개정 — 포인터 모델) — `agent_primary_changes` INSERT(append-only, `at` = `created_at`). 평문
  // `agent_id` · `cause`(provision·owner·operator), 주소는 커밋 `c.address` 로만(평문 `@` 0).
  'identity.primary_set',
] as const;
export type OrgLeafKind = (typeof ORG_LEAF_KINDS)[number];

/**
 * 신원 잎 종류(US-013, `202609242200_tlog_identity_leaves`) — 에이전트 생성 · 이름/상태/정지 주체 변경 · 주소 연결 · 키 연결 · 서명된
 * passport 버전 · (tlog v4) 별칭 폐기. 콘솔 "변경 이력 블록"(`src/tlog/identity-blocks.ts`)이 이 잎들을 에이전트마다 해시로 잇는다.
 */
export const IDENTITY_LEAF_KINDS = [
  'identity.agent_created',
  'identity.agent_updated',
  'identity.address_assigned',
  'identity.key_bound',
  'identity.passport_version',
  'identity.address_retired',
  // 대표 주소 선택(202610021110) — 체인은 `kind LIKE 'identity.%'` 라 그대로 든다.
  'identity.primary_set',
] as const satisfies readonly OrgLeafKind[];
export type IdentityLeafKind = (typeof IDENTITY_LEAF_KINDS)[number];

/** 로그에 담는 원천 테이블(= outbox 트리거가 걸린 테이블). 이름 붙은 제외 목록은 `test/arch/transparency-log.arch.test.ts`. */
export const TLOG_SOURCE_TABLES = [
  'audit_logs',
  'owner_actions',
  'policy_versions',
  'inbound_messages',
  'agents',
  'agent_addresses',
  'agent_keypairs',
  'passport_documents',
  'org_entitlements',
  // 고객 도메인(202609291130, ADR-0014) — INSERT · UPDATE OF status, suspended_reason, inbound_mx_status.
  'custom_domains',
  // 대표 주소 선택(202610021110, ADR-0014 2026-10 개정) — INSERT 만(append-only).
  'agent_primary_changes',
] as const;
export type TlogSourceTable = (typeof TLOG_SOURCE_TABLES)[number];

/** 외부 앵커 주기(Q4 — 하루 1회). */
export const ANCHOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
