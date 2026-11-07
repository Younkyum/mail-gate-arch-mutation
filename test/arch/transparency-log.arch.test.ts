/**
 * ★ 투명성 로그 층(ADR-0008 Phase A · US-010) — 설정이 아니라 코드·마이그레이션·형식에 대한 단언. 변이(`mutations/catalogue.ts` TL1~TL6)가 겨냥한다.
 *
 *   ① A-T1 형식: 잎 해시 = SHA-256(0x00 ‖ data) · 노드 = SHA-256(0x01 ‖ l ‖ r) — 참조 구현·RFC 6962 벡터와 같다.
 *   ② A-T2 완결성: 원천 테이블마다 outbox 트리거(`tlog_enqueue`)가 걸려 있고, append-only(`reject_row_delete`) 테이블은 전부 로그 대상이거나
 *      **이름 붙은 제외 목록**(사유 포함)에 있다 — 새 감사 테이블이 조용히 빠지지 않는다.
 *   ③ A-T3 PII 센티넬: 모든 잎 종류를 센티넬 입력(주소·제목·세션·승인자·스냅샷·오류 문장)으로 만들어 평문 부재를 본다.
 *   ④ A-T4 서명 격리: KMS `SignCommand`·`GetPublicKeyCommand` 를 import 하는 파일 = `src/tlog/checkpoint-signer.ts` 하나 · 그 파일을 import
 *      하는 곳 = 투명성 로그 조립 루트 하나 · 그 조립 루트를 import 하는 곳 = 핸들러 둘(로그 · 앵커 — M5) · 각 핸들러는 **자기 과제의
 *      조립 함수만** 가져온다(앵커 핸들러가 체크포인트 서명기를 조립하지 않는다).
 *   ⑤ 에폭: 바뀐 조직만 담은 에폭 · 되감긴 루트에는 서명하지 않는다(서명 전 계획이 거부).
 *   ⑥ 검증기 독립: `scripts/tlog-verify/**` · `scripts/log-verify.ts` · 두 번째 검증기·참조 구현은 `src/**` 를 import 하지 않는다.
 *   ⑦ 신원 잎(US-013): DB CHECK 의 잎 종류 = 코드의 `ORG_LEAF_KINDS` · outbox 원천 = `TLOG_SOURCE_TABLES` · `agents` 는 UPDATE 도(이름·상태·정지
 *      주체) · 이름·주소 센티넬은 커밋으로만(③) · 검증기 둘이 신원 잎 종류를 안다.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { IDENTITY_LEAF_KINDS, ORG_LEAF_KINDS, TLOG_SOURCE_TABLES } from '../../src/tlog/constants';
import { EpochIntegrityError, planEpoch } from '../../src/tlog/epoch';
import { buildOrgLeaf, epochTreeLeaf, globalEpochLeaf, type OrgEvent } from '../../src/tlog/leaf';
import { leafHash, nodeHash, rootOf } from '../../src/tlog/merkle';
import { refLeafHash, refNodeHash, refRoot } from '../support/tlog-reference';
import { getProject, repoPath, toRepoRelative } from './support/project';

const SIGNER = 'src/tlog/checkpoint-signer.ts';
const COMPOSITION = 'src/runtime/transparency-composition.ts';
const HANDLER = 'src/runtime/handlers/transparency-log.ts';
const ANCHOR_HANDLER = 'src/runtime/handlers/transparency-anchor.ts';

/**
 * 로그에 담지 않는 append-only 테이블과 그 사유. **여기 없는 새 append-only 테이블은 이 층을 빨갛게 만든다** — 담든가, 사유를 적어라.
 */
export const TLOG_EXCLUDED_APPEND_ONLY_TABLES: Readonly<Record<string, string>> = {
  ac0_gates: 'AC-0 운영 게이트 — 운영자의 판정 기록(조직의 발신·수신 사건이 아니다). 후속 범위.',
  billing_audit:
    '요금제 변경 원장(행위자·공급자 이벤트 id — ADR-0011). 변경 사실(요금제·한도·버전·원인)은 org_entitlements → billing.entitlement 잎이다(버전마다 감사 행 하나 — 지연 트리거).',
  ac0_gate_events: 'AC-0 운영 게이트 사건 — 위와 같다.',
  // 결제 WP-2(202609250400, ADR-0012) — 지우기 거부 표 다섯. 효과(요금제·한도·버전·원인)는 모두 org_entitlements → billing.entitlement 잎이고,
  //   공급자 좌표·고객 id 는 잎에 싣지 않는다(계획 §3-11 — 새 잎 종류·원천 없음).
  billing_events: '결제 웹훅 멱등 원장(이벤트 좌표 · 원문 해시) — 이벤트가 바꾼 요금제는 org_entitlements → billing.entitlement 잎(원인 provider_event).',
  billing_customers: '조직 ↔ 공급자 고객 결속 — 공급자 고객 id 는 잎에 싣지 않는다. 결제 효과는 billing.entitlement 잎.',
  billing_subscriptions:
    '재조회한 공급자 구독(상태 칸은 바뀐다 — 지우기만 거부) — 요금제 효과는 billing.entitlement 잎(원인 provider_event·reconcile·grace_expired).',
  billing_checkouts: 'admin 이 만든 공급자 거래(결속 근거, status 는 한 번 바뀐다) — 결제가 낳은 요금제는 billing.entitlement 잎.',
  billing_reconcile_state: 'reconcile 운영 커서 한 행(매 틱 바뀐다 — 지우기만 거부) — 조직의 사건이 아니다.',
  human_mailbox_interventions: 'AC-0 게이트의 사람 개입 기록 — 위와 같다.',
  agent_api_keys: '토큰 해시(비밀 파생값). 발급·교체 사실은 콘솔 행위(owner_actions `agent.token`) 잎으로 남는다.',
  agent_api_key_events: '토큰 한 개 폐기·이름 바꾸기·한 개 교체 감사의 부속 상세(토큰 id · 이름 전·후 · 교체의 새 토큰 id) — 행위 사실은 owner_actions `agent.token.*` 잎.',
  agent_contact_rules: '연락처 목록 — 정책 버전 스냅샷(policy.version 의 snapshot 커밋)에 그 시점 목록 전체가 들어간다.',
  approval_link_uses: '승인 링크 사용 — 승인 결과는 audit_logs 의 update 사건(decision·approved_by 커밋)으로 잎이 된다.',
  approval_notifications: '승인 알림 발송 상태 — 판정이 아니다.',
  approval_releases: '승인 릴리스 일정 — 릴리스의 판정은 audit_logs update 사건.',
  approval_request_items: '승인 요청 항목 — 각 발송 시도는 audit_logs 행(= 잎)이다.',
  approval_requests: '승인 요청 — 결과는 audit_logs update 사건.',
  outbound_recipients: '수신자 전원은 audit.evaluated 의 envelope 커밋으로 들어간다(Q5).',
  // 메일 기본기 2차 A2(202609270130) — 발신 첨부. 판정은 audit_logs 잎(Stage 6 이 총량·MIME 을 본다), 바이트·파일명은 잎에 싣지 않는다.
  outbound_attachments: '발신 첨부 업로드 메타(파일명·MIME·크기·해시) — 발송 판정은 audit_logs 잎이고 첨부는 Stage 6 의 입력일 뿐이다.',
  message_attachments: '발송 한 통의 첨부 결속(영구 키) — 위와 같다(발송 시도 = audit_logs 잎).',
  users: '콘솔 사용자(주소) — 주소는 잎에 싣지 않는다. 멤버십 사건의 대상은 owner_actions `member.*` 잎의 사용자 id.',
  memberships: '멤버십 — 생성·역할·제거 사실은 owner_actions `member.join|role|remove|leave`·`org.create` 잎(대상 = 사용자·조직 id).',
  membership_events: '멤버십 감사의 부속 상세(역할 전·후) — 행위 사실은 owner_actions `member.*` 잎.',
  org_invites: '초대 outbox — 초대·취소 사실은 owner_actions `member.invite|invite_revoke` 잎(대상 = 초대 id), 수락은 `member.join`.',
  org_api_keys: '조직 API 키(해시·권한) — 발급·폐기·교체·이름 사실은 owner_actions `org_key.*` 잎(대상 = 키 id), 키가 한 행위는 owner.action 의 api_key 커밋.',
  owner_login_links: '로그인 링크(비밀 결속) — 로그인 사실은 owner_actions `session.login` 잎.',
  owner_login_requests: '로그인 요청 원장 — 위와 같다.',
  owner_sessions: '세션(토큰 해시) — 세션 id 는 owner.action 의 session 커밋으로만.',
  passport_publish_requests: '게시 요청 outbox — 결과는 서명된 passport 버전(passport_documents → identity.passport_version 잎).',
  passports: 'passport 버전 행 — 서명된 버전마다 passport_documents 행이 생기고 그것이 identity.passport_version 잎이다(draft 는 문서·잎 없음, ADR-0002 B5).',
  scheduled_sends: '예약 — 실제 발송 시도는 audit_logs 행.',
  security_findings: '수신 스캐너 결과 — inbound.verdict(quarantine_reason)로 요약된다.',
  sender_marks: '소유자 발신자 분류(신뢰 사실) — 수신 쪽 공약(Q5 (c))이 생길 때.',
  sender_relationships: '발신자 관계(신뢰 사실) — 위와 같다.',
  signup_links: '가입 링크 — 조직이 생기기 전 사건(조직 로그가 없다).',
  signup_requests: '가입 요청 원장 — 위와 같다.',
  webhook_deliveries: '웹훅 전달 기록 — 판정이 아니다.',
  // 받기 등급(202610081000) — 신뢰 발신자 목록. 바꾼 사실은 owner_actions `watch.trusted_senders.set` 잎(대상 = 조직 id), 값(주소 · 도메인)은 잎에 싣지 않는다.
  org_trusted_senders: '감시 탭 신뢰 발신자(주소 · 도메인 — 잎에 싣지 않는다) — 목록을 바꾼 사실은 owner_actions `watch.trusted_senders.set` 잎.',
  // 셀프 가입 환영 메일(202609301510) — 시스템 메일 outbox. 가입 사실은 owner_actions `signup.verify` 잎이다.
  welcome_mails: '환영 메일 outbox(발송 상태 · 사용자 id — 주소·본문 없음) — 판정이 아니다. 가입 사실은 owner_actions `signup.verify` 잎.',
  // 대기자 명단(202609301520) — 조직이 생기기 전 사건(조직 로그가 없다). 가입 사실은 owner_actions `signup.verify` 잎.
  waitlist_mails: '대기 확인 · 초대 메일 outbox(발송 상태 · 항목 id — 주소·본문 없음) — 판정이 아니다. 조직이 생기기 전 사건.',
  waitlist_events: '대기자 명단 운영 감사(초대 · 지우기 · 가입 — 항목 id · 행위자) — 조직이 생기기 전 사건(조직 로그가 없다). 가입 사실은 owner_actions `signup.verify` 잎.',
  // 웹훅 시크릿 회전(202609301410, ADR-0013 2026-09-30 개정) — 회전 상한의 분자 · 감사 기록. 콘솔 회전은 owner_actions `agent.webhook.rotate` 잎이 남는다.
  webhook_secret_rotations: '웹훅 시크릿 회전 원장(버전만 — 시크릿 없음) — 판정이 아니다. 콘솔 회전 사실은 owner_actions `agent.webhook.rotate` 잎.',
  webhook_owner_action_details: '콘솔 웹훅 감사의 부속 상세(엔드포인트 id · URL 호스트 · 전달 id) — 행위 사실은 owner_actions `agent.webhook.*` 잎.',
  webhook_endpoint_authorizations:
    '웹훅 인증 헤더 봉인값(평문 없음 · 힌트) — 판정이 아니다. 콘솔 설정·지우기 사실은 owner_actions `agent.webhook.authorization_set|_clear` 잎(값 없이).',
  webhook_console_secret_issues: '콘솔 웹훅 시크릿 발급 원장((엔드포인트, 버전)당 한 번 — 시크릿 없음) — 판정이 아니다. 발급을 낳은 등록·회전은 owner_actions `agent.webhook.*` 잎.',
  // 호스팅 운영자 콘솔(202609290500·0510, `.omc/plans/ops-console.md`) — 운영자·세션·행위 원장. 조직 로그의 잎은 행위가 바꾼 도메인 표
  //   (organizations 의 검토 상태는 잎 원천이 아니지만 · agents · org_entitlements 가 원천이다)의 트리거가 그대로 남긴다. 투명성 잎 `ops.action` 은 후속 F-3.
  // 고객 도메인(202609291100, ADR-0014) — 알림 outbox. 알림을 낳은 사건(정지 · 제거 · 만료 예고의 원인)은 custom_domains → domain.status 잎이다.
  domain_notices: '도메인 알림 outbox(발송 상태) — 판정이 아니다. 정지·제거 사실은 custom_domains → domain.status 잎.',
  // 격리 알림(202610071000, ADR-0016 2026-10-07) — 알림 outbox. 격리 사실은 inbound_messages → inbound.verdict(quarantine_reason) 잎이다.
  quarantine_notices: '격리 알림 outbox(발송 상태 · 수) — 판정이 아니다. 격리 사실은 inbound_messages → inbound.verdict 잎.',
  quarantine_notice_items: '격리 알림 창에 묶인 메일(도메인 · 사유) — 판정이 아니다. 위와 같다.',
  drafts: '에이전트 초안(묶음 B — 받는 사람 · 제목 · 본문 키) — 판정이 아니다. 보내면 그 시도가 messages → outbound.decision 잎이 된다(초안은 내용의 출처일 뿐).',
  mail_locales: '지원하는 시스템 메일 언어의 조회 표(202610101000 — 코드 한 칸, 마이그레이션만 더한다). 조직의 발신·수신 사건이 아니다.',
  inbound_message_state: '받은 메일의 에이전트 상태(라벨 · 처음 읽은 시각, 묶음 B) — 에이전트의 정리 표시이지 판정이 아니다. 수신 판정은 inbound_messages → inbound.verdict 잎.',
  // 묶음 D(202610081101, ADR-0016 2026-10-08) — 자가 등록 감사 · 바깥 가입 감지.
  agent_enrollments: '자가 등록 감사(부른 에이전트 · 토큰 · 만든 에이전트 · 시각) — 판정이 아니다. 만든 에이전트의 정책은 policy_versions → policy.version 잎(첫 버전 · created_by agent:<id>).',
  // 정책 변경 요청(202610131201, ADR-0007 2026-10-13) — 에이전트의 부탁(변경 하나 · 이유)과 결정 칸.
  policy_change_requests:
    '에이전트의 정책 변경 요청(부탁 · 결정 상태) — 판정이 아니다. 승인은 owner_actions → owner.action 잎(agent.policy_request.approve · reject), 바뀐 정책은 policy_versions → policy.version 잎(created_by 가 요청 id 를 싣는다).',
  agent_signups: '바깥 가입 감지(서비스 도메인 · 종류 · 시각 · 수 — 정보용) — 판정이 아니다. 근거가 된 메일은 inbound_messages → inbound.verdict 잎.',
  ops_settings: '운영자 콘솔 설정 한 행(킬 스위치 · 솔트) — 조직의 사건이 아니다.',
  ops_operators: '운영자 신원(주소) — 주소는 잎에 싣지 않는다. 조직의 사건이 아니다(후속 F-3 ops.action 잎).',
  ops_operator_events: '운영자 상태 사건 원장 — 조직의 사건이 아니다.',
  ops_sessions: '운영자 세션(토큰 해시) — 조직의 사건이 아니다.',
  ops_actions: '운영자 행위 원장(티켓 · 실패) — 행위가 바꾼 에이전트·요금제는 각자 잎(identity · billing.entitlement)이다. ops.action 잎은 후속 F-3.',
  ops_action_effects: '티켓이 바꾼 도메인 행 목록(트리거가 적는다) — 행위 원장의 부속 상세. 위와 같다.',
  tlog_anchors: '투명성 로그 자신.',
  tlog_epochs: '투명성 로그 자신.',
  tlog_keys: '투명성 로그 자신.',
  tlog_leaves: '투명성 로그 자신.',
  tlog_logs: '투명성 로그 자신.',
  tlog_org_heads: '투명성 로그 자신.',
  tlog_outbox: '투명성 로그 자신.',
  tlog_salt_keys: '투명성 로그 자신.',
};

function migrationStatements(): string[] {
  const directory = repoPath('src/db/migrations');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap((name) => readFileSync(`${directory}/${name}`, 'utf8').replace(/--[^\n]*/g, '').split(';'));
}

function importersOf(module: RegExp, names?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const file of getProject().getSourceFiles()) {
    const path = toRepoRelative(file.getFilePath());
    if (!path.startsWith('src/')) continue;
    for (const declaration of file.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const resolved = declaration.getModuleSpecifierSourceFile();
      const target = resolved === undefined ? specifier : toRepoRelative(resolved.getFilePath());
      if (!module.test(target) && !module.test(specifier)) continue;
      if (names === undefined || declaration.getNamespaceImport() !== undefined || declaration.getNamedImports().some((named) => names.has(named.getName()))) {
        out.add(path);
      }
    }
  }
  return [...out].sort();
}

describe('① A-T1 — RFC 9162 해시 형식', () => {
  it('잎 해시 = SHA-256(0x00 ‖ data) · 노드 해시 = SHA-256(0x01 ‖ l ‖ r) — 참조 구현·RFC 6962 벡터와 같다', () => {
    const data = Buffer.from('atmark tlog');
    expect(leafHash(data)).toEqual(refLeafHash(data));
    expect(nodeHash(leafHash(data), leafHash(data))).toEqual(refNodeHash(refLeafHash(data), refLeafHash(data)));
    const vector = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((hex) => leafHash(Buffer.from(hex, 'hex')));
    expect(rootOf(vector).toString('hex')).toBe('5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328');
    expect(rootOf(vector)).toEqual(refRoot(vector));
  });
});

describe('② A-T2 — 수집 완결성(마이그레이션)', () => {
  const statements = migrationStatements();

  it('원천 테이블마다 AFTER INSERT outbox 트리거(tlog_enqueue)가 있다 · audit_logs · agents 는 UPDATE 도', () => {
    const enqueued = new Set<string>();
    const updated = new Set<string>();
    for (const statement of statements) {
      if (!/EXECUTE FUNCTION tlog_enqueue\(\)/.test(statement)) continue;
      // `AFTER UPDATE OF <칸> ON` 도 갱신 트리거다(tlog v4 — 별칭 폐기 `agent_addresses_tlog_enqueue_retire`).
      const match = /AFTER\s+(INSERT|UPDATE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(\w+)/.exec(statement);
      if (match === null) continue;
      if (match[1] === 'INSERT') enqueued.add(match[2] as string);
      if (match[1] === 'UPDATE') updated.add(match[2] as string);
    }
    expect([...enqueued].sort()).toEqual([...TLOG_SOURCE_TABLES].sort());
    // 변경 가능한 원천 — audit_logs · agents · org_entitlements(요금제, 202609250300 · ADR-0011) · agent_addresses(별칭 폐기, tlog v4 202609270115) ·
    // custom_domains(고객 도메인 상태, 202609291130 · ADR-0014).
    expect([...updated].sort()).toEqual(['agent_addresses', 'agents', 'audit_logs', 'custom_domains', 'org_entitlements']);
  });

  it('⑦ DB CHECK 의 잎 종류 = ORG_LEAF_KINDS · outbox 원천 = TLOG_SOURCE_TABLES (마지막 정의 기준) · 신원 잎은 제 원천에서만', () => {
    const lastList = (constraint: string): string[] => {
      const found = statements.filter((statement) => new RegExp(`ADD CONSTRAINT ${constraint} CHECK`).test(statement)).at(-1) ?? '';
      return [...found.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1] as string).sort();
    };
    expect(lastList('tlog_leaves_kind_check')).toEqual([...ORG_LEAF_KINDS].sort());
    expect(lastList('tlog_outbox_source_table_check')).toEqual([...TLOG_SOURCE_TABLES].sort());
    // 마지막 정의(tlog v4 가 폐기 잎을 더해 다시 만들었다).
    const identity = statements.filter((statement) => /ADD CONSTRAINT tlog_leaves_identity_source CHECK/.test(statement)).at(-1) ?? '';
    for (const kind of IDENTITY_LEAF_KINDS) expect(identity, kind).toContain(`'${kind}'`);
    expect(identity).toContain(`WHEN kind = 'identity.address_retired' THEN source_table = 'agent_addresses' AND event = 'update'`);
    // 두 검증기가 신원 잎 종류를 안다(1차는 원천 대조 · 블록 파일, 2차는 블록 파일).
    const verifier = readFileSync(repoPath('scripts/tlog-verify/verifier.ts'), 'utf8');
    for (const kind of IDENTITY_LEAF_KINDS) expect(verifier, kind).toContain(`'${kind}'`);
    // 요금제 잎(ADR-0011) — 1차 검증기가 원천 대조를 안다 · 잎 종류 ↔ 원천 CHECK 가 있다.
    expect(verifier).toContain(`'billing.entitlement'`);
    expect(verifier).toContain(`'org_entitlements'`);
    const billingSource = statements.find((statement) => /ADD CONSTRAINT tlog_leaves_billing_source CHECK/.test(statement)) ?? '';
    expect(billingSource).toContain(`WHEN kind = 'billing.entitlement' THEN source_table = 'org_entitlements'`);
    expect(readFileSync(repoPath('test/support/tlog-second-verifier.ts'), 'utf8')).toContain('secondVerifyIdentityBlocks');
  });

  it('⑦ L2 — 신원 잎 마이그레이션 둘은 맨 첫 문장이 SET LOCAL lock_timeout(원천 넷·tlog 표 잠금 대기 상한) · 러너는 파일 하나당 BEGIN/COMMIT(SET LOCAL 이 그 파일에만)', () => {
    for (const name of ['202609242200_tlog_identity_leaves.sql', '202609242300_tlog_identity_hardening.sql']) {
      const first = readFileSync(repoPath(`src/db/migrations/${name}`), 'utf8').replace(/--[^\n]*/g, '').split(';')[0]?.trim();
      expect(first, name).toBe("SET LOCAL lock_timeout = '5s'");
    }
    const runner = readFileSync(repoPath('src/db/migrate.ts'), 'utf8');
    expect(runner).toMatch(/for \(const migration of migrations\) \{[\s\S]*?client\.query\('BEGIN'\);[\s\S]*?client\.query\(migration\.sql\);[\s\S]*?client\.query\('COMMIT'\);/);
  });

  it('M2 — 토큰 목록 마이그레이션(202609250010: 인증 경로가 매 요청 읽는 agent_api_keys 에 트리거 DROP/CREATE · 칸 추가)도 맨 첫 문장이 SET LOCAL lock_timeout', () => {
    const name = '202609250010_agent_api_keys_label_hint.sql';
    const sql = readFileSync(repoPath(`src/db/migrations/${name}`), 'utf8').replace(/--[^\n]*/g, '');
    expect(sql.split(';')[0]?.trim(), name).toBe("SET LOCAL lock_timeout = '5s'");
    // 첫 DDL 보다 앞이다(ALTER TABLE agent_api_keys 가 ACCESS EXCLUSIVE 를 잡기 전).
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(sql.indexOf('ALTER TABLE agent_api_keys'));
  });

  it('M5(확장성 P0·P1 적대적 검토) — 뜨거운 표(owner_sessions·owner_login_links·organizations·owner_actions)를 건드리는 P0·P1 마이그레이션과 미뤄 둔 contract 도 맨 첫 문장이 SET LOCAL lock_timeout', () => {
    const files = [
      'src/db/migrations/202609250100_users_memberships.sql',
      'src/db/migrations/202609250110_session_user_binding.sql',
      'src/db/migrations/202609250120_org_invites.sql',
      'src/db/migrations/202609250150_org_api_keys.sql',
      'src/db/migrations/202609250160_owner_actions_org_key_actor.sql',
      'src/db/migrations/202609250170_owner_action_actor_emails.sql',
      'src/db/migrations/202609250180_member_lifecycle_guards.sql',
      'src/db/migrations/202609250190_session_user_binding_contract.sql',
      // L7 적대적 검토 M1 — `organizations (owner_email)` 색인(지우기 조건의 주 소유자 검사).
      'src/db/migrations/202609250220_invited_user_erasure.sql',
      // 과금 P0(ADR-0011) — organizations 를 REFERENCES · tlog 표 CHECK 교체.
      'src/db/migrations/202609250300_org_entitlements.sql',
      // 결제 WP-2(ADR-0012) — organizations·users 를 REFERENCES · org_entitlements 칸 추가.
      'src/db/migrations/202609250400_billing_provider.sql',
      // 로그인·가입 코드(2026-09-28) — owner_login_links 칸·CHECK·트리거 추가와 그 검증.
      'src/db/migrations/202609280100_login_codes.sql',
      'src/db/migrations/202609280101_login_codes_validate.sql',
      // 호스팅 운영자 콘솔(I-4) — 도메인 표 다섯(organizations 포함)에 zz_ 트리거 · ops 표가 organizations 를 읽기 GRANT(0500).
      'src/db/migrations/202609290500_ops_identity.sql',
      'src/db/migrations/202609290510_ops_actions.sql',
      // 고객 도메인(ADR-0014) — custom_domains·org_features 가 organizations 를 REFERENCES · claim 트리거와 청구 이메일 표시 칸(organizations).
      'src/db/migrations/202609291100_custom_domains.sql',
      'src/db/migrations/202609291109_billing_email_is_agent.sql',
      'src/db/migrations/202609291110_mail_identity_claims.sql',
      // 웹훅 관리(ADR-0013 2026-09-30 개정) — 콘솔 감사 상세 `webhook_owner_action_details` 가 owner_actions 를 REFERENCES.
      'src/db/migrations/202609301410_webhook_secret_rotation.sql',
      // 운영자 예약 주소(202609301500) — operator_address_grants 가 organizations 를 REFERENCES.
      'src/db/migrations/202609301500_operator_reserved_addresses.sql',
      // 환영 메일(202609301510) — welcome_mails 가 organizations 를 REFERENCES · signup_links 칸 추가.
      'src/db/migrations/202609301510_signup_lang_welcome_mails.sql',
      // 대기자 명단(202609301520) — organizations 에 색인(organizations_self_signup_created_idx).
      'src/db/migrations/202609301520_waitlist.sql',
      // 대기자 신청서 · 가입 계측(202609301530) — organizations 에 칸 넷 · CHECK · 불변 트리거와 그 검증(1531).
      'src/db/migrations/202609301530_waitlist_intake.sql',
      'src/db/migrations/202609301531_waitlist_intake_validate.sql',
      // 역할 주소 abuse@ · postmaster@(202609301540) — agent_addresses 에 CHECK NOT VALID 와 그 검증(1541).
      'src/db/migrations/202609301540_operator_reserved_abuse_postmaster.sql',
      'src/db/migrations/202609301541_operator_reserved_abuse_postmaster_validate.sql',
      // AI 의심 메일 감시(202610061100, ADR-0017 초안) — organizations 에 토글 칸 · 가드 트리거 · ai_watch_jobs 가 organizations 를 REFERENCES.
      'src/db/migrations/202610061100_ai_mail_watch.sql',
      // 격리 알림(202610071000, ADR-0016 2026-10-07) — quarantine_notices 가 organizations 를 REFERENCES · inbound_messages 에 트리거.
      'src/db/migrations/202610071000_quarantine_notices.sql',
      // 받기 등급(202610081000, ADR-0016 2026-10-08) — 감시 설정 표가 organizations 를 REFERENCES · inbound_messages 칸 · CHECK · 트리거.
      'src/db/migrations/202610081000_watch_levels.sql',
      // 묶음 D(202610081101, ADR-0016 2026-10-08) — agent_enrollments · agent_signups 가 organizations 를 REFERENCES.
      'src/db/migrations/202610081101_send_approval_enroll_signups.sql',
      // 실시간 WebSocket(202610081300, 묶음 E) — realtime_connections 가 organizations 를 REFERENCES.
      'src/db/migrations/202610081300_realtime_connections.sql',
      // 정책 변경 요청(202610131201, ADR-0007 2026-10-13) — policy_change_requests 가 organizations 를 REFERENCES.
      'src/db/migrations/202610131201_policy_change_requests.sql',
      // 운영자 · 시스템 감사 행위자(202610131610 · 1611) — owner_actions 에 칸 둘 · CHECK 둘 NOT VALID · 가드 트리거와 그 검증.
      'src/db/migrations/202610131610_owner_actions_operator_actor.sql',
      'src/db/migrations/202610131611_owner_actions_operator_actor_validate.sql',
    ];
    for (const file of files) {
      const sql = readFileSync(repoPath(file), 'utf8').replace(/--[^\n]*/g, '');
      expect(sql.split(';')[0]?.trim(), file).toBe("SET LOCAL lock_timeout = '5s'");
    }
    // 목록이 새지 않게 — 202609250100 이후 파일 중 뜨거운 표를 ALTER/잠그는 것은 전부 위 목록에 있다.
    const HOT = /\b(ALTER TABLE|CREATE (UNIQUE )?INDEX [a-z_]+ ON|CREATE TRIGGER [a-z_]+\s+(BEFORE|AFTER)[^;]* ON|REFERENCES|REVOKE [^;]* ON|DROP TRIGGER [a-z_]+ ON)\s*(owner_sessions|owner_login_links|organizations|owner_actions)\b/;
    for (const name of readdirSync(repoPath('src/db/migrations')).filter((file) => file >= '202609250100' && file.endsWith('.sql'))) {
      const sql = readFileSync(repoPath(`src/db/migrations/${name}`), 'utf8').replace(/--[^\n]*/g, '');
      if (HOT.test(sql)) expect(files, name).toContain(`src/db/migrations/${name}`);
    }
  });

  it('append-only 테이블은 전부 로그 대상이거나 이름 붙은 제외 목록(사유)에 있다', () => {
    const appendOnly = new Set<string>();
    for (const statement of statements) {
      if (!statement.includes('reject_row_delete()') || !/\bDELETE\b/.test(statement)) continue;
      const match = /\bON\s+(\w+)/.exec(statement);
      if (match !== null) appendOnly.add(match[1] as string);
    }
    const covered = new Set<string>([...TLOG_SOURCE_TABLES, ...Object.keys(TLOG_EXCLUDED_APPEND_ONLY_TABLES)]);
    expect([...appendOnly].filter((table) => !covered.has(table)).sort()).toEqual([]);
    // 제외 목록이 로그 대상과 겹치지 않고, 사유가 비어 있지 않다.
    for (const [table, reason] of Object.entries(TLOG_EXCLUDED_APPEND_ONLY_TABLES)) {
      expect((TLOG_SOURCE_TABLES as readonly string[]).includes(table)).toBe(false);
      expect(reason.length).toBeGreaterThan(5);
    }
    // 비공허성: 핵심 원천은 실제로 append-only 로 잡힌다.
    expect(appendOnly.has('audit_logs') && appendOnly.has('owner_actions') && appendOnly.has('policy_versions')).toBe(true);
  });
});

describe('③ A-T3 — 잎에 PII 평문이 없다(센티넬)', () => {
  const SENTINELS = {
    address: 'sentinel-addr-91c2@victim.example',
    subject: 'SENTINEL-SUBJECT-91c2',
    session: '9d1c2b3a-0000-4000-8000-00000000c0de',
    approver: 'sentinel-approver-91c2@owner.example',
    messageId: '<sentinel-msgid-91c2@atmark.test>',
    snapshotValue: 'sentinel-listed-91c2@partner.example',
    errorText: 'failed:550 rejected sentinel-bounce-91c2@victim.example',
    agentName: 'Sentinel Agent 91c2',
    publicKey: 'SENTINELpublicKey91c2SENTINELpublicKey91c2x',
    // 고객 도메인(ADR-0014) — 도메인 이름은 커밋으로만.
    customDomain: 'agents.sentinel-domain-91c2.example',
  };
  const AT = '2026-09-24T00:00:00.000000Z';
  const AUDIT = '11111111-2222-4333-8444-555555555555';
  const AGENT = 'a'.repeat(32);
  const src = (t: 'audit_logs' | 'owner_actions' | 'policy_versions' | 'inbound_messages', e: 'insert' | 'update' = 'insert', r = 0) => ({ t, id: AUDIT, e, r });
  const events: OrgEvent[] = [
    { kind: 'org.genesis', at: AT },
    {
      kind: 'audit.evaluated',
      src: src('audit_logs'),
      at: AT,
      auditId: AUDIT,
      agentId: AGENT,
      decision: 'denied',
      reasons: ['recipient_not_allowlisted', `rejected:${SENTINELS.address}`],
      policyVersion: 3,
      approvalId: null,
      messageId: AUDIT,
      resolutionReason: SENTINELS.errorText,
      resolvedAt: AT,
      approvedBy: SENTINELS.approver,
      recipients: [SENTINELS.address, 'other@x.example'],
      rfc822Id: SENTINELS.messageId,
    },
    { kind: 'audit.updated', src: src('audit_logs', 'update', 1), at: AT, auditId: AUDIT, decision: 'allowed', resolutionReason: SENTINELS.errorText, resolvedAt: AT, approvedBy: SENTINELS.approver },
    { kind: 'owner.action', src: src('owner_actions'), at: AT, action: 'agent.create', targetId: AGENT, sessionId: SENTINELS.session },
    {
      kind: 'policy.version',
      src: src('policy_versions'),
      at: AT,
      agentId: AGENT,
      version: 4,
      outboundMode: 'allowlist_only',
      inboundMode: 'all',
      snapshot: { lists: { outbound: { allow: [SENTINELS.snapshotValue] } }, note: SENTINELS.subject },
    },
    {
      kind: 'inbound.verdict',
      src: src('inbound_messages'),
      at: AT,
      agentId: AGENT,
      quarantined: true,
      quarantineReason: 'policy_blocked',
      policyReason: 'sender_not_allowlisted',
      fromAuthenticated: false,
      fromAddress: SENTINELS.address,
      rfc822Id: SENTINELS.messageId,
    },
    { kind: 'source.missing', src: src('owner_actions'), at: AT, reason: 'not_found' },
    // 신원 잎(US-013) — 이름·주소 센티넬은 커밋으로만. 공개키는 지문으로만.
    { kind: 'identity.agent_created', src: { t: 'agents', id: AGENT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, name: SENTINELS.agentName, status: 'provisioning', suspendedBy: null },
    {
      kind: 'identity.agent_updated',
      src: { t: 'agents', id: AGENT, e: 'update', r: 1 },
      at: AT,
      agentId: AGENT,
      name: SENTINELS.agentName,
      status: 'suspended',
      suspendedBy: 'owner',
      changed: ['name', 'status', 'suspended_by'],
    },
    { kind: 'identity.address_assigned', src: { t: 'agent_addresses', id: AUDIT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, address: SENTINELS.address, primary: true },
    { kind: 'identity.key_bound', src: { t: 'agent_keypairs', id: AGENT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, algorithm: 'ed25519', publicKey: SENTINELS.publicKey },
    { kind: 'identity.passport_version', src: { t: 'passport_documents', id: AUDIT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, version: 2, status: 'published', contentHash: 'd'.repeat(64) },
    // tlog v4 — 별칭 폐기. 주소 센티넬은 커밋으로만.
    { kind: 'identity.address_retired', src: { t: 'agent_addresses', id: AUDIT, e: 'update', r: 1 }, at: AT, agentId: AGENT, address: SENTINELS.address },
    // 요금제(ADR-0011) — 금액·고객 id 가 들어갈 칸이 없다. 모양 밖 코드(주소)는 평문이 아니라 커밋으로 간다.
    {
      kind: 'billing.entitlement',
      src: { t: 'org_entitlements', id: AUDIT, e: 'update', r: 1 },
      at: AT,
      planCode: 'pro',
      cause: SENTINELS.address,
      version: 2,
      limits: {
        max_agents: 10,
        org_daily_recipients: 1000,
        agent_per_day_max: 300,
        agent_per_minute_max: 30,
        recipients_per_message_max: 25,
        tokens_per_agent_max: 5,
        webhook_endpoints_per_agent_max: 3,
        org_api_keys_max: 2,
        inbound_storage_bytes: 10737418240,
      },
      graceUntil: null,
    },
    // tlog v4 — 11칸(늦은 두 칸 — 정수뿐).
    {
      kind: 'billing.entitlement',
      src: { t: 'org_entitlements', id: AUDIT, e: 'update', r: 2 },
      at: AT,
      planCode: 'pro',
      cause: 'backfill',
      version: 3,
      limits: {
        max_agents: 10,
        org_daily_recipients: 1000,
        agent_per_day_max: 300,
        agent_per_minute_max: 30,
        recipients_per_message_max: 25,
        tokens_per_agent_max: 5,
        webhook_endpoints_per_agent_max: 3,
        org_api_keys_max: 2,
        inbound_storage_bytes: 10737418240,
        aliases_per_agent_max: 5,
        attachment_bytes_total_max: 10485760,
      },
      graceUntil: null,
    },
    // 고객 도메인(ADR-0014 단계 3) — 도메인 이름은 커밋으로만(평문은 도메인 행 id 와 코드).
    {
      kind: 'domain.status',
      src: { t: 'custom_domains', id: AUDIT, e: 'update', r: 1 },
      at: AT,
      domainId: AUDIT,
      status: 'suspended',
      reason: 'ownership_lost',
      inbound: 'ses',
      domain: SENTINELS.customDomain,
    },
    // 대표 주소 선택(ADR-0014 개정 — DB CHECK 202610021110). 주소는 커밋으로만.
    { kind: 'identity.primary_set', src: { t: 'agent_primary_changes', id: AUDIT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, cause: 'owner', address: SENTINELS.address },
  ];

  it('모든 잎 종류 · 에폭 트리 잎 · 전역 잎에 센티넬 평문이 하나도 없다', () => {
    const texts = events.map((event, seq) => buildOrgLeaf({ log: 'c'.repeat(32), seq, saltKey: Buffer.alloc(32, 1) }, event).json);
    texts.push(epochTreeLeaf(0, 'c'.repeat(32), 7, 'f'.repeat(64)), globalEpochLeaf(0, AT, 'e'.repeat(64)));
    const joined = texts.join('\n');
    for (const [name, value] of Object.entries(SENTINELS)) expect(joined, `${name} 가 잎에 평문으로 있다`).not.toContain(value);
    // 비공허성: 커밋 칸은 실제로 채워졌다(센티넬이 "버려진" 것이 아니라 커밋된 것).
    const evaluated = JSON.parse(texts[1] as string) as { c: Record<string, string>; body: Record<string, unknown> };
    expect(Object.keys(evaluated.c).sort()).toEqual(['approved_by', 'body.reasons', 'body.resolution_reason', 'envelope', 'rfc822_id']);
    expect(evaluated.body['reasons']).toBeNull();
    const inbound = JSON.parse(texts[5] as string) as { c: Record<string, string> };
    expect(Object.keys(inbound.c).sort()).toEqual(['from', 'rfc822_id']);
    const owner = JSON.parse(texts[3] as string) as { c: Record<string, string>; body: Record<string, unknown> };
    expect(Object.keys(owner.c)).toEqual(['session']);
    // 신원 잎: 이름·주소는 커밋 · 공개키는 지문(hex64) · 모든 신원 종류가 만들어졌다.
    const identity = texts.slice(7, 13).map((text) => JSON.parse(text) as { kind: string; c: Record<string, string>; body: Record<string, unknown> });
    // 대표 주소 선택(`identity.primary_set` — ADR-0014 2026-10)은 목록 끝에 따로 있다(아래 사건) — 모든 신원 종류가 사건에 있다.
    expect(identity.map((leaf) => leaf.kind)).toEqual(IDENTITY_LEAF_KINDS.filter((kind) => kind !== 'identity.primary_set'));
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([...IDENTITY_LEAF_KINDS]));
    expect(Object.keys(identity[0]?.c ?? {})).toEqual(['name']);
    expect(identity[1]?.body).toMatchObject({ status: 'suspended', suspended_by: 'owner', changed: ['name', 'status', 'suspended_by'] });
    expect(Object.keys(identity[2]?.c ?? {})).toEqual(['address']);
    expect(identity[3]?.body['key_fp']).toMatch(/^[0-9a-f]{64}$/);
    expect(identity[4]?.body).toMatchObject({ version: 2, status: 'published', content_hash: 'd'.repeat(64) });
    expect(Object.keys(identity[5]?.c ?? {})).toEqual(['address']);
    expect(identity[5]?.body).toEqual({ agent_id: AGENT });
    const billing = JSON.parse(texts[13] as string) as { kind: string; c: Record<string, string>; body: Record<string, unknown> };
    expect(billing.kind).toBe('billing.entitlement');
    expect(billing.body).toMatchObject({ plan_code: 'pro', cause: null, version: 2, max_agents: 10, inbound_storage_bytes: 10737418240, grace_until: null });
    expect(Object.keys(billing.c)).toEqual(['body.cause']);
    const eleven = JSON.parse(texts[14] as string) as { body: Record<string, unknown>; c: Record<string, string> };
    expect(eleven.body).toMatchObject({ aliases_per_agent_max: 5, attachment_bytes_total_max: 10485760 });
    expect(Object.keys(eleven.c)).toEqual([]);
    const domain = JSON.parse(texts[15] as string) as { kind: string; c: Record<string, string>; body: Record<string, unknown> };
    expect(domain.kind).toBe('domain.status');
    expect(domain.body).toEqual({ domain_id: AUDIT, status: 'suspended', reason: 'ownership_lost', inbound: 'ses' });
    expect(Object.keys(domain.c)).toEqual(['domain']);
    const primary = JSON.parse(texts[16] as string) as { kind: string; c: Record<string, string>; body: Record<string, unknown> };
    expect(primary.kind).toBe('identity.primary_set');
    expect(primary.body).toEqual({ agent_id: AGENT, cause: 'owner' });
    expect(Object.keys(primary.c)).toEqual(['address']);
  });
});

describe('④ A-T4 — KMS 서명은 checkpoint-signer.ts 하나', () => {
  it('KMS SignCommand · GetPublicKeyCommand 를 import 하는 src 파일 = checkpoint-signer.ts + Domain Connect 서명기(다른 키 · admin λ — 투명성 로그 키는 키 정책 Deny)', () => {
    expect(importersOf(/^@aws-sdk\/client-kms$/, new Set(['SignCommand', 'GetPublicKeyCommand']))).toEqual(['src/domains/dc-kms-signer.ts', SIGNER].sort());
  });

  it('checkpoint-signer 를 import 하는 곳 = 투명성 로그 조립 루트 하나 · 그 조립 루트를 import 하는 곳 = 핸들러 둘(로그 · 앵커)', () => {
    expect(importersOf(/^src\/tlog\/checkpoint-signer\.ts$/)).toEqual([COMPOSITION]);
    expect(importersOf(/^src\/runtime\/transparency-composition\.ts$/)).toEqual([ANCHOR_HANDLER, HANDLER].sort());
  });

  it('M5 — 핸들러마다 자기 과제의 조립 함수만: 로그 = composeTransparencyLog · 앵커 = composeTransparencyAnchor', () => {
    const composers = (handler: string): string[] => {
      const file = getProject().getSourceFiles().find((source) => toRepoRelative(source.getFilePath()) === handler);
      expect(file, handler).toBeDefined();
      return (file?.getImportDeclarations() ?? [])
        .filter((declaration) => declaration.getModuleSpecifierValue() === '../transparency-composition')
        .flatMap((declaration) => declaration.getNamedImports().map((named) => named.getName()))
        .filter((name) => name.startsWith('compose'));
    };
    expect(composers(HANDLER)).toEqual(['composeTransparencyLog']);
    expect(composers(ANCHOR_HANDLER)).toEqual(['composeTransparencyAnchor']);
  });

  it('checkpoint-signer 의 export 는 서명기 생성자·클라이언트뿐 — 키 자료를 돌려주는 함수가 없다', () => {
    const file = getProject().getSourceFiles().find((source) => toRepoRelative(source.getFilePath()) === SIGNER);
    expect(file).toBeDefined();
    expect([...(file?.getExportedDeclarations().keys() ?? [])].sort()).toEqual(['TlogKmsClient', 'createKmsAnchorSigner', 'createKmsNoteSigner', 'createTlogKmsClient']);
  });
});

describe('⑤ 에폭 — 서명 전 계획이 거부한다', () => {
  const logs = ['1'.repeat(32), '2'.repeat(32)];
  const heads = logs.map((log, index) => ({ log, size: 1, root: leafHash(Buffer.from(String(index))) }));
  const first = planEpoch({ epoch: 0, closedAt: '2026-09-24T00:00:00.000000Z', logs, heads, previousHeads: [], globalLeafHashes: [], previousRoot: null, leafHashesOf: () => undefined });

  it('바뀐 조직만 담은 에폭(헤드가 로그보다 적다)은 epoch_incomplete', () => {
    expect(() =>
      planEpoch({ epoch: 0, closedAt: '2026-09-24T00:00:00.000000Z', logs, heads: heads.slice(1), previousHeads: [], globalLeafHashes: [], previousRoot: null, leafHashesOf: () => undefined }),
    ).toThrow(EpochIntegrityError);
  });

  it('되감긴(직전 체크포인트와 일관되지 않은) 역사에는 서명하지 않는다 — checkpoint_inconsistent', () => {
    const next = {
      epoch: 1,
      closedAt: '2026-09-24T01:00:00.000000Z',
      logs,
      heads: first.heads,
      previousHeads: first.heads,
      globalLeafHashes: [first.globalLeafHash],
      leafHashesOf: () => undefined,
    };
    expect(() => planEpoch({ ...next, previousRoot: Buffer.alloc(32, 0xab) })).toThrow('checkpoint_inconsistent');
    expect(planEpoch({ ...next, previousRoot: first.globalRoot }).treeSize).toBe(2);
  });
});

describe('⑥ 검증기 독립 — src/** 를 import 하지 않는다', () => {
  it('scripts/tlog-verify/** · scripts/log-verify.ts · 두 번째 검증기 · 참조 구현', () => {
    const independent = getProject()
      .getSourceFiles()
      .filter((file) => {
        const path = toRepoRelative(file.getFilePath());
        return (
          path.startsWith('scripts/tlog-verify/') ||
          path === 'scripts/log-verify.ts' ||
          path === 'test/support/tlog-second-verifier.ts' ||
          path === 'test/support/tlog-reference.ts'
        );
      });
    expect(independent.length).toBe(4);
    for (const file of independent) {
      for (const declaration of file.getImportDeclarations()) {
        const resolved = declaration.getModuleSpecifierSourceFile();
        const target = resolved === undefined ? declaration.getModuleSpecifierValue() : toRepoRelative(resolved.getFilePath());
        expect(target.startsWith('src/'), `${toRepoRelative(file.getFilePath())} → ${target}`).toBe(false);
      }
    }
  });
});
