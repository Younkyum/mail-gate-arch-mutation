/**
 * 정책 v2 경계 (계약 `.omc/handoffs/v2-contract.md` §1 · ADR-0007) — Layer D 의 v2 몫.
 *
 *   ① 발신 화이트리스트는 목록 밖을 **허용하지 않는다**(승인 경로도 없다 — 진윤겸 결정 ①). 엔진을 직접 돌려 본다.
 *   ② 수신 화이트리스트는 **인증되지 않은 From** 을 목록과 맞추지 않는다(사칭으로 에이전트 컨텍스트에 들어오는 길).
 *   ③ 정책이 막은 수신은 **격리**다 — 저장소의 사유 함수가 정책 사유를 격리로 쓰고, INSERT 의 `quarantined`·웹훅 발화가 같은 값을 본다.
 *   ④ 목록의 출처는 `agent_contact_rules` 하나 — 엔진·로더·신뢰 사실이 `config_json.allowlist/blocklist` 를 읽지 않는다.
 *   ⑤ 목록 쓰기(INSERT·UPDATE)는 관리 연산·프로비저닝 저장소뿐 — 앱 롤 코드(api·워커)에 목록 쓰기 SQL 이 없다(DB 권한과 두 겹).
 *
 *   ⑥ 발신 수신자는 **ASCII dot-atom** 만 — 본문 파서(HTTP·MCP)와 관문 선적재가 같은 함수로 거른다(202609241040 — 검증 M2).
 *   ⑦ 관문의 목록은 **버전 스냅샷**(`policy_versions.snapshot.contact_rules`) — 관문·수신 소스는 살아 있는 테이블을 읽지 않는다(M3).
 *   ⑧ 자기 주소로는 **어느 모드에서도** 못 보낸다(`recipient_is_self` — L1).
 *   ⑨ 수신 차단은 헤더 From 만이 아니라 **봉투 발신자·SES 가 본 From 도메인**까지(L2).
 *
 * 변이 카탈로그(`mutations/catalogue.ts`)의 `PV-*` 가 ①②③⑥⑦⑧⑨ 를 겨냥한다.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { parseSendBody } from '../../src/api/outbound-http';
import { quarantineOf } from '../../src/db/repositories/inbound-store';
import type { PolicyVersionRow } from '../../src/db/schema';
import { evaluate } from '../../src/policy/engine';
import { resolvePolicy } from '../../src/policy/policy-loader';
import { evaluateInboundPolicy, resolveInboundPolicy } from '../../src/policy/inbound-policy';
import { AGENT_ADDRESS, AGENT_ID, contextWith, NOW, policyWith, POLICY_VERSION_ID, STRANGER_RECIPIENT } from '../unit/policy/fixtures';
import { getProject, srcSourceFiles, toRepoRelative } from './support/project';

function file(path: string): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((f) => toRepoRelative(f.getFilePath()) === path);
  if (found === undefined) throw new Error(`파일이 없다: ${path}`);
  return found;
}

function literals(source: SourceFile): string[] {
  return [
    ...source.getDescendantsOfKind(SyntaxKind.StringLiteral).map((l) => l.getLiteralValue()),
    ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral).map((l) => l.getLiteralValue()),
    ...source.getDescendantsOfKind(SyntaxKind.TemplateExpression).map((t) => t.getText()),
  ];
}

const CLEAN_SCAN = { kind: 'scanned', scannerVersion: 'v', injectionRisk: 'none', quarantined: false, findings: [] } as const;

describe('정책 v2 경계 — Layer D (v2)', () => {
  it('① 화이트리스트는 목록 밖을 허용하지 않는다 — 빈 목록 · 다른 주소 · 하위 도메인 · 태그 변형 전부 거부', () => {
    const offList: readonly (readonly [string, readonly string[]])[] = [
      [STRANGER_RECIPIENT, []],
      [STRANGER_RECIPIENT, ['friend@example.com']],
      ['a@mail.example.com', ['example.com']],
      ['friend+x@example.com', ['friend@example.com']],
    ];
    for (const [recipient, allowlist] of offList) {
      const decision = evaluate(
        contextWith({ attempt: { recipients: [recipient] } }),
        policyWith({ outboundMode: 'allowlist_only', allowlist, blocklist: [] }),
      );
      expect(decision.verdict, `${recipient} / ${allowlist.join(',')}`).toBe('denied');
      expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
    }
  });

  it('② 수신 화이트리스트는 인증되지 않은 From 을 목록과 맞추지 않는다', () => {
    const policy = resolveInboundPolicy('allowlist_only', [
      { id: 'r', direction: 'inbound', list: 'allow', kind: 'address', value: 'owner@partner.example' },
    ], 1);
    expect(evaluateInboundPolicy(policy, { address: 'owner@partner.example', authenticated: false })).toEqual({
      kind: 'quarantine',
      reason: 'sender_not_allowlisted',
    });
    expect(evaluateInboundPolicy(policy, { address: 'owner@partner.example', authenticated: true })).toEqual({ kind: 'deliver' });
  });

  it('③ 정책 격리는 격리다 — 사유 함수가 정책 사유를 격리로 쓰고, INSERT·웹훅이 그 한 값을 본다', () => {
    expect(quarantineOf({ scan: CLEAN_SCAN, policyBlocked: 'sender_blocklisted' })).toBe('policy_blocked');
    expect(quarantineOf({ scan: CLEAN_SCAN, policyBlocked: 'inbound_disabled' })).toBe('policy_blocked');
    expect(quarantineOf({ scan: { ...CLEAN_SCAN, quarantined: true, injectionRisk: 'high' }, policyBlocked: 'sender_not_allowlisted' })).toBe(
      'policy_blocked',
    );
    expect(quarantineOf({ scan: CLEAN_SCAN, policyBlocked: null })).toBeNull();
    expect(quarantineOf({ scan: { kind: 'scanner_error', scannerVersion: 'v' }, policyBlocked: null })).toBe('scanner_error');

    // INSERT 의 `quarantined` 칸과 웹훅 발화가 **같은 지역값**(`quarantine`)을 본다 — 따로 판정하면 "격리됐는데 이벤트는 나갔다".
    const store = file('src/db/repositories/inbound-store.ts').getFullText();
    expect(store).toContain('const quarantine = quarantineOf(record);');
    expect(store).toContain('quarantine !== null,');
    expect(store).toContain('if (quarantine === null) {');
  });

  it('④ 목록의 출처는 agent_contact_rules 하나 — src/policy·신뢰 사실은 config_json 의 allowlist/blocklist 를 읽지 않는다', () => {
    const offenders: string[] = [];
    for (const source of srcSourceFiles()) {
      const path = toRepoRelative(source.getFilePath());
      if (!path.startsWith('src/policy/') && path !== 'src/db/repositories/trust-facts-store.ts' && path !== 'src/db/repositories/policy-source.ts') {
        continue;
      }
      const text = source.getFullText();
      // SQL(`config_json -> 'allowlist'`)·코드(`config_json['allowlist']`·`configJson['blocklist']`) 두 모양 모두.
      for (const match of text.matchAll(/config_?json\s*(?:->>?\s*'|\[\s*')(allowlist|blocklist)'/gi)) offenders.push(`${path}: ${match[0]}`);
      for (const match of text.matchAll(/requireStringArray\([^)]*'(allowlist|blocklist)'/g)) offenders.push(`${path}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('⑤ 목록 쓰기 SQL 은 관리 연산·프로비저닝 저장소에만 있다 — api·워커(앱 롤) 코드에 없다', () => {
    const writers: string[] = [];
    for (const source of srcSourceFiles()) {
      const path = toRepoRelative(source.getFilePath());
      if (literals(source).some((text) => /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+agent_contact_rules\b/.test(text))) writers.push(path);
    }
    expect(writers.sort()).toEqual(['src/admin/ops/rules.ts', 'src/api/provisioning-store.ts']);
  });

  it('⑥ 발신 수신자는 dot-atom 만 — 따옴표 로컬파트·끝 점 도메인·역슬래시는 본문 파서가 400 invalid_recipient', () => {
    for (const bad of ['"bad"@x.com', 'bad@x.com.', 'bad\\@x.com']) {
      const parsed = parseSendBody({ agent_id: 'a'.repeat(32), from: AGENT_ADDRESS, to: [bad], subject: 's', text: 't' });
      expect(parsed.kind === 'error' ? parsed.response.body['error'] : 'accepted', bad).toBe('invalid_recipient');
    }
    const ok = parseSendBody({ agent_id: 'a'.repeat(32), from: AGENT_ADDRESS, to: ['Friend+Tag@Example.com'], subject: 's', text: 't' });
    expect(ok.kind).toBe('ok');
  });

  it('⑦ 관문의 목록은 버전 스냅샷에서 온다 — 관문·수신 소스는 agent_contact_rules 를 읽지 않는다', () => {
    const version: PolicyVersionRow = {
      id: POLICY_VERSION_ID,
      agent_id: AGENT_ID,
      version: 7,
      outbound_mode: 'allowlist_only',
      inbound_mode: 'all',
      snapshot: { contact_rules: [{ id: 'r1', direction: 'outbound', list: 'allow', kind: 'address', value: 'snap@example.com' }] },
      created_by: null,
      created_at: NOW,
    };
    const policy = resolvePolicy(
      { agent_id: AGENT_ID, outbound_mode: 'allowlist_only', inbound_mode: 'all', require_approval: false, limits: { per_minute: 1, per_hour: 1, per_day: 1, recipients_per_message: 1 }, config_json: { max_attachment_bytes_total: 1, allowed_mime_types: [] }, current_version: 7, created_at: NOW, updated_at: NOW },
      version,
      [],
    );
    expect(policy.allowlist).toEqual(['snap@example.com']);
    expect(literals(file('src/db/repositories/inbound-policy-store.ts')).filter((text) => /\bagent_contact_rules\b/.test(text))).toEqual([]);
    // 관문 소스의 예외 하나(보안 감사 H-1) — 규칙 **id 만** 읽어 요청 출처를 가린다(목록 · 값은 여전히 스냅샷 — 로더가 스냅샷의 id 와만 맞춘다).
    const gateReads = literals(file('src/db/repositories/policy-source.ts')).filter((text) => /\bagent_contact_rules\b/.test(text));
    expect(gateReads).toHaveLength(1);
    expect(gateReads[0]?.trim().startsWith('SELECT id::text AS id FROM agent_contact_rules')).toBe(true);
    expect(gateReads[0]).toContain('created_by');
  });

  it('⑧ 자기 주소로는 어느 모드에서도 못 보낸다 — "전체" 에서도 recipient_is_self', () => {
    for (const outboundMode of ['unrestricted', 'blocklist_only', 'allowlist_only'] as const) {
      const decision = evaluate(
        contextWith({ attempt: { recipients: [AGENT_ADDRESS] } }),
        policyWith({ outboundMode, allowlist: [AGENT_ADDRESS], blocklist: [] }),
      );
      expect([decision.verdict, decision.reasons], outboundMode).toEqual(['denied', ['recipient_is_self']]);
    }
  });

  it('⑨ 수신 차단은 봉투 발신자·SES 가 본 From 도메인까지 — From 이 깨끗해도 격리', () => {
    const policy = resolveInboundPolicy('blocklist_only', [{ id: 'b', direction: 'inbound', list: 'block', kind: 'domain', value: 'evil.example' }], 1);
    const blocked = { kind: 'quarantine', reason: 'sender_blocklisted' };
    expect(evaluateInboundPolicy(policy, { address: 'friend@clean.example', authenticated: true, envelopeSender: 'bounce@evil.example' })).toEqual(blocked);
    expect(evaluateInboundPolicy(policy, { address: 'friend@clean.example', authenticated: true, authenticatedDomains: ['evil.example'] })).toEqual(blocked);
    expect(evaluateInboundPolicy(policy, { address: 'friend@clean.example', authenticated: true, envelopeSender: 'bounce@clean.example' })).toEqual({ kind: 'deliver' });
  });
});
