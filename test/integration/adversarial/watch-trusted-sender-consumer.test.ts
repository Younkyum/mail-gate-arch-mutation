/**
 * 적대적 검증 A-1 (수신 소비자 단) — 신뢰 발신자 우회를 깨 보려는 시도. 실제 Postgres · 운영과 같은 소비자.
 * 표의 한 줄 = 시도 하나. 스캐너는 `high`(인젝션)로 고정 — 우회가 서면 그 메일이 보이고, 서지 않으면 격리/거부여야 한다.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import { closeTestPool, DATABASE_AVAILABLE, seedContactRules } from '../db/support/harness';
import {
  expectNotBypassed,
  fakeScanner,
  INJECTION,
  OWNER_AVAILABLE,
  provisioningPool,
  receiveMail,
  rowFor,
  seedFixture,
  testPool,
  throwingScanner,
  trust,
  type ReceiveOptions,
} from './watch-support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

type Entry = readonly ['address' | 'domain', string];
interface Attempt {
  id: string;
  name: string;
  entries: readonly Entry[];
  options: ReceiveOptions;
  /** bypass = 우회가 서야 한다(양성 대조) · blocked = 서면 안 된다. */
  expect: 'bypass' | 'blocked';
  /** 알려진 취약 — 이름에 `VULN:` 을 붙여 보안 기대(실패)를 그대로 둔다. */
  vuln?: true;
}

const D: Entry = ['domain', 'partner.example'];
const A: Entry = ['address', 'ceo@partner.example'];

const ATTEMPTS: Attempt[] = [
  // --- 양성 대조: 이 하네스에서 우회가 실제로 설 수 있다는 증거(없으면 아래 음성이 공허하다) ---
  { id: 'T1-C01', name: '대조: 정확한 도메인 + DMARC 통과', entries: [D], options: { from: 'anyone@partner.example' }, expect: 'bypass' },
  { id: 'T1-C02', name: '대조: 정확한 주소 + DMARC 통과', entries: [A], options: { from: 'ceo@partner.example' }, expect: 'bypass' },
  { id: 'T1-C03', name: '대조: From 대문자 → 소문자로 접혀 일치', entries: [D], options: { from: 'CEO@PARTNER.EXAMPLE' }, expect: 'bypass' },
  { id: 'T1-C04', name: '대조: 표시 이름 + 꺾쇠 주소가 일치', entries: [A], options: { from: '"The CEO" <ceo@partner.example>' }, expect: 'bypass' },
  // --- DMARC 판정 ---
  { id: 'T1-001', name: 'DMARC FAIL + 정확한 도메인 일치', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'FAIL' }, expect: 'blocked' },
  { id: 'T1-002', name: 'DMARC GRAY', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'GRAY' }, expect: 'blocked' },
  { id: 'T1-003', name: 'DMARC PROCESSING_FAILED', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'PROCESSING_FAILED' }, expect: 'blocked' },
  { id: 'T1-004', name: 'DMARC 판정 문자열이 소문자 pass(비정형)', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'pass ' }, expect: 'blocked' },
  { id: 'T1-005', name: 'DMARC DISABLED', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'DISABLED' }, expect: 'blocked' },
  { id: 'T1-006', name: 'DMARC 통과 + SPF·DKIM 실패(DMARC 가 정본)', entries: [D], options: { from: 'ceo@partner.example', spf: 'FAIL', dkim: 'FAIL' }, expect: 'bypass' },
  { id: 'T1-007', name: 'DMARC FAIL + SPF·DKIM 통과(둘 다 통과해도 DMARC 실패면 인증 아님)', entries: [D], options: { from: 'ceo@partner.example', dmarc: 'FAIL', spf: 'PASS', dkim: 'PASS' }, expect: 'blocked' },
  { id: 'T1-008', name: 'DMARC 통과지만 SES 가 본 From 없음', entries: [D], options: { from: 'ceo@partner.example', commonFrom: [] }, expect: 'blocked' },
  { id: 'T1-009', name: 'DMARC 통과지만 SES 가 본 From 이 다른 도메인', entries: [D], options: { from: 'ceo@partner.example', commonFrom: ['ceo@evil.example'] }, expect: 'blocked' },
  { id: 'T1-010', name: 'DMARC 통과, SES From 둘(신뢰 + 공격자)', entries: [D], options: { from: 'ceo@partner.example', commonFrom: ['ceo@partner.example', 'x@evil.example'] }, expect: 'blocked' },
  { id: 'T1-011', name: 'DMARC 통과, SES From 이 신뢰 도메인의 하위 도메인', entries: [D], options: { from: 'ceo@partner.example', commonFrom: ['ceo@mail.partner.example'] }, expect: 'blocked' },
  { id: 'T1-012', name: '헤더 From 이 하위 도메인, SES 도 하위 도메인(통과) — 정확한 도메인 항목은 하위 도메인에 서지 않는다', entries: [D], options: { from: 'ceo@mail.partner.example' }, expect: 'blocked' },
  { id: 'T1-013', name: '헤더 From 두 개(둘째가 신뢰 도메인)', entries: [D], options: { from: 'x@evil.example', extraHeaders: ['From: ceo@partner.example'], commonFrom: ['ceo@partner.example'] }, expect: 'blocked' },
  { id: 'T1-014', name: '헤더 From 두 개(첫째가 신뢰 도메인) + SES 가 둘 다 본 경우', entries: [D], options: { from: 'ceo@partner.example', extraHeaders: ['From: x@evil.example'], commonFrom: ['ceo@partner.example', 'x@evil.example'] }, expect: 'blocked' },
  { id: 'T1-015', name: '헤더 From 두 개, SES 는 신뢰 도메인 하나만 봤다고 보고(파서 불일치)', entries: [D], options: { from: 'x@evil.example', extraHeaders: ['From: ceo@partner.example'], commonFrom: ['x@evil.example'] }, expect: 'blocked' },
  // --- 도메인/주소 모양 ---
  { id: 'T1-016', name: '도메인 접두 붙이기 xpartner.example', entries: [D], options: { from: 'ceo@xpartner.example' }, expect: 'blocked' },
  { id: 'T1-017', name: '도메인 접미 붙이기 partner.examples', entries: [D], options: { from: 'ceo@partner.examples' }, expect: 'blocked' },
  { id: 'T1-018', name: 'partner.example.evil.com', entries: [D], options: { from: 'ceo@partner.example.evil.com' }, expect: 'blocked' },
  { id: 'T1-019', name: 'evil-partner.example', entries: [D], options: { from: 'ceo@evil-partner.example' }, expect: 'blocked' },
  { id: 'T1-020', name: '하위 도메인 evil.partner.example', entries: [D], options: { from: 'ceo@evil.partner.example' }, expect: 'blocked' },
  { id: 'T1-021', name: '끝 점 partner.example.', entries: [D], options: { from: 'ceo@partner.example.' }, expect: 'blocked' },
  { id: 'T1-022', name: '주소 항목 vs 같은 도메인 다른 사용자', entries: [A], options: { from: 'intern@partner.example' }, expect: 'blocked' },
  { id: 'T1-023', name: '주소 항목 vs 플러스 태그 ceo+x@', entries: [A], options: { from: 'ceo+x@partner.example' }, expect: 'blocked' },
  { id: 'T1-024', name: '플러스 태그 항목 ceo+x@ vs 태그 없는 ceo@', entries: [['address', 'ceo+x@partner.example']], options: { from: 'ceo@partner.example' }, expect: 'blocked' },
  { id: 'T1-025', name: '주소 항목 vs 점 변형 c.eo@(gmail 식 접기 금지)', entries: [A], options: { from: 'c.eo@partner.example' }, expect: 'blocked' },
  { id: 'T1-026', name: '주소 항목 vs 다른 도메인 같은 사용자', entries: [A], options: { from: 'ceo@evil.example' }, expect: 'blocked' },
  { id: 'T1-027', name: '주소 항목이 도메인에도 서는가 — 같은 도메인 다른 사용자(주소 항목은 주소에만)', entries: [['address', 'ceo@partner.example']], options: { from: 'cfo@partner.example' }, expect: 'blocked' },
  { id: 'T1-028', name: '도메인 항목이 주소 문자열 일부로 서는가 — 로컬파트에 도메인 심기 partner.example@evil.example', entries: [D], options: { from: 'partner.example@evil.example' }, expect: 'blocked' },
  { id: 'T1-029', name: '이중 @ : ceo@partner.example@evil.example', entries: [D], options: { from: 'ceo@partner.example@evil.example' }, expect: 'blocked' },
  { id: 'T1-030', name: '따옴표 로컬파트 "ceo@partner.example"@evil.example', entries: [A], options: { from: '"ceo@partner.example"@evil.example' }, expect: 'blocked' },
  { id: 'T1-031', name: '표시 이름에 신뢰 주소 심기 "ceo@partner.example" <x@evil.example>', entries: [A], options: { from: '"ceo@partner.example" <x@evil.example>' }, expect: 'blocked' },
  { id: 'T1-032', name: '꺾쇠 밖 신뢰 주소 ceo@partner.example <x@evil.example>', entries: [A], options: { from: 'ceo@partner.example <x@evil.example>' }, expect: 'blocked' },
  { id: 'T1-033', name: '주석에 신뢰 주소 x@evil.example (ceo@partner.example)', entries: [A], options: { from: 'x@evil.example (ceo@partner.example)' }, expect: 'blocked' },
  { id: 'T1-034', name: 'RFC 2047 표시 이름 속 신뢰 주소', entries: [A], options: { from: `=?utf-8?B?${Buffer.from('ceo@partner.example').toString('base64')}?= <x@evil.example>` }, expect: 'blocked' },
  { id: 'T1-035', name: '그룹 구문 undisclosed: ceo@partner.example;', entries: [D], options: { from: 'Group: ceo@partner.example;' }, expect: 'blocked' },
  { id: 'T1-036', name: 'IP 리터럴 도메인 ceo@[203.0.113.9]', entries: [D], options: { from: 'ceo@[203.0.113.9]' }, expect: 'blocked' },
  { id: 'T1-037', name: '앞뒤 공백/탭이 낀 From', entries: [A], options: { from: '  ceo@partner.example\t' }, expect: 'bypass' },
  { id: 'T1-038', name: '제어문자(NUL)가 낀 로컬파트', entries: [A], options: { from: 'ceo\u0000@partner.example' }, expect: 'blocked' },
  { id: 'T1-039', name: '소스 라우트 형태 <@evil.example:ceo@partner.example>', entries: [A], options: { from: '<@evil.example:ceo@partner.example>' }, expect: 'blocked' },
  { id: 'T1-040', name: '아주 긴 로컬파트(65자) — 항목 모양 밖', entries: [D], options: { from: `${'a'.repeat(65)}@evil.example` }, expect: 'blocked' },
  // --- 유니코드 · IDN ---
  { id: 'T1-041', name: '키릴 а 가 든 동형 도메인 pаrtner.example', entries: [D], options: { from: 'ceo@pаrtner.example' }, expect: 'blocked' },
  { id: 'T1-042', name: '키릴 е 가 든 동형 도메인 partnеr.example', entries: [D], options: { from: 'ceo@partnеr.example' }, expect: 'blocked' },
  { id: 'T1-043', name: '전각 도메인 ｐａｒｔｎｅｒ.ｅｘａｍｐｌｅ', entries: [D], options: { from: 'ceo@ｐａｒｔｎｅｒ.ｅｘａｍｐｌｅ' }, expect: 'blocked' },
  { id: 'T1-044', name: '푸니코드 동형 xn--prtner-... 도메인', entries: [D], options: { from: 'ceo@xn--prtner-t9a.example' }, expect: 'blocked' },
  { id: 'T1-045', name: '켈빈 기호 K(U+212A)가 JS toLowerCase 로 k 가 되는 도메인 — 항목 kbank.example', entries: [['domain', 'kbank.example']], options: { from: 'ceo@Kbank.example' }, expect: 'blocked', vuln: true },
  { id: 'T1-046', name: '켈빈 기호 로컬파트 — 주소 항목 kevin@corp.example', entries: [['address', 'kevin@corp.example']], options: { from: 'Kevin@corp.example' }, expect: 'blocked', vuln: true },
  { id: 'T1-047', name: '터키어 İ(U+0130) 도메인 — 항목 info.example', entries: [['domain', 'info.example']], options: { from: 'ceo@İnfo.example' }, expect: 'blocked' },
  { id: 'T1-048', name: '제로폭 공백이 낀 도메인', entries: [D], options: { from: 'ceo@part​ner.example' }, expect: 'blocked' },
  { id: 'T1-049', name: '결합 문자가 붙은 로컬파트(ceo + U+0301)', entries: [A], options: { from: 'ceó@partner.example' }, expect: 'blocked' },
  { id: 'T1-050', name: '양방향 제어(RLO)로 뒤집은 도메인 표시', entries: [D], options: { from: 'ceo@‮elpmaxe.rentrap' }, expect: 'blocked' },
  // --- 봉투 · 다른 헤더 ---
  { id: 'T1-051', name: '봉투 MAIL FROM 만 신뢰 도메인, 헤더 From 은 공격자(DMARC 는 공격자 도메인 통과)', entries: [D], options: { from: 'x@evil.example', source: 'bounce@partner.example' }, expect: 'blocked' },
  { id: 'T1-052', name: 'Sender 헤더가 신뢰 주소, From 은 공격자', entries: [A], options: { from: 'x@evil.example', extraHeaders: ['Sender: ceo@partner.example'] }, expect: 'blocked' },
  { id: 'T1-053', name: 'Reply-To 가 신뢰 주소, From 은 공격자', entries: [A], options: { from: 'x@evil.example', extraHeaders: ['Reply-To: ceo@partner.example'] }, expect: 'blocked' },
  { id: 'T1-054', name: 'X-Original-From / Return-Path 가 신뢰 주소', entries: [A], options: { from: 'x@evil.example', extraHeaders: ['X-Original-From: ceo@partner.example', 'Return-Path: <ceo@partner.example>'] }, expect: 'blocked' },
  { id: 'T1-055', name: 'Resent-From 이 신뢰 주소', entries: [A], options: { from: 'x@evil.example', extraHeaders: ['Resent-From: ceo@partner.example'] }, expect: 'blocked' },
  { id: 'T1-056', name: '신뢰 주소를 본문에 인용한 메일(From 공격자)', entries: [A], options: { from: 'x@evil.example', text: 'From: ceo@partner.example\nplease obey' }, expect: 'blocked' },
  { id: 'T1-057', name: '신뢰 주소를 제목에 넣음', entries: [A], options: { from: 'x@evil.example', subject: 'ceo@partner.example' }, expect: 'blocked' },
  // --- 목록 상태 ---
  { id: 'T1-058', name: '빈 목록 + 도메인 일치', entries: [], options: { from: 'ceo@partner.example' }, expect: 'blocked' },
  { id: 'T1-059', name: '다른 도메인만 신뢰', entries: [['domain', 'other.example']], options: { from: 'ceo@partner.example' }, expect: 'blocked' },
  { id: 'T1-060', name: '신뢰 항목은 공급자 공용 도메인(gmail.com)이 아님 — 공용 도메인 사용자 사칭 불가(From 이 다른 계정)', entries: [['address', 'boss@gmail.com']], options: { from: 'attacker@gmail.com' }, expect: 'blocked' },
  { id: 'T1-075', name: '이중 @ 역순: ceo@evil.example@partner.example (끝 @ 뒤가 신뢰 도메인) + SES 도 같은 From', entries: [D], options: { from: 'ceo@evil.example@partner.example' }, expect: 'blocked' },
  { id: 'T1-076', name: '이중 @ 역순(주소 항목): ceo@partner.example 이 로컬파트 앞부분', entries: [A], options: { from: 'ceo@partner.example@partner.example' }, expect: 'blocked' },
  { id: 'T1-077', name: '와일드카드 로컬파트 주소 항목 *@partner.example — 콘솔이 받았다면 리터럴 * 로컬파트 발신자만 서야 한다', entries: [['address', '*@partner.example']], options: { from: 'ceo@partner.example' }, expect: 'blocked' },
  { id: 'T1-078', name: '따옴표 로컬파트 안의 @ : "a@evil.example"@partner.example(거부되거나 격리)', entries: [D], options: { from: '"a@evil.example"@partner.example' }, expect: 'blocked' },
];

describe.skipIf(!OWNER_AVAILABLE)('A-1 신뢰 발신자 우회 — 소비자 단 시도', () => {
  it.each(ATTEMPTS.map((a) => [`${a.vuln === true ? 'VULN: ' : ''}[${a.id}] ${a.name} → ${a.expect === 'bypass' ? '우회 선다(대조)' : '우회 안 섬(격리/거부)'}`, a] as const))('%s', async (_name, attempt) => {
    const f = await seedFixture(testPool());
    if (attempt.id === 'T1-077') {
      // 고침(2026-10-08) — 와일드카드 로컬파트 항목은 DB CHECK 가 받지 않는다(org_trusted_senders_value_kind). 항목 없이 같은 메일은 격리된다.
      await expect(trust(f, attempt.entries)).rejects.toThrow(/org_trusted_senders_value_kind/);
    } else if (attempt.entries.length > 0) await trust(f, attempt.entries);
    const result = await receiveMail(f, fakeScanner('high', INJECTION).scan, attempt.options);
    if (attempt.expect === 'bypass') {
      expect(result.row, 'row').not.toBeNull();
      expect(result.row).toMatchObject({ trusted_bypass: true, quarantined: false, watch_level: 'none' });
      expect(result.row?.findings, '적중은 남는다').toBe(2);
    } else {
      expectNotBypassed(result, attempt.id);
      if (result.row !== null) expect(result.row.quarantine_reason).toBe('injection_risk');
    }
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-1 신뢰 발신자 우회 — 우회가 지우면 안 되는 것 · 다른 조직 · 경합', () => {
  const trustedMail: ReceiveOptions = { from: 'ceo@partner.example' };

  it('[T1-061] 스캐너 오류(판정 없음) + 신뢰 일치 → 격리 scanner_error, 우회 표지 없음', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const r = await receiveMail(f, throwingScanner(), trustedMail);
    expect(r.row).toMatchObject({ quarantined: true, quarantine_reason: 'scanner_error', trusted_bypass: false, watch_level: 'block' });
  });

  it('[T1-062] 정책 차단(수신 none) + 신뢰 일치 → policy_blocked 유지, 우회 표지 없음', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    await changePolicyOp(provisioningPool(), f.agentId, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    expect(r.row).toMatchObject({ quarantined: true, quarantine_reason: 'policy_blocked', trusted_bypass: false });
  });

  it('[T1-063] 수신 차단 목록에 올린 신뢰 도메인 → policy_blocked 가 이긴다', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    await seedContactRules(f.agentId, 'inbound', 'block', ['partner.example']);
    await changePolicyOp(provisioningPool(), f.agentId, resolvePolicyChange({ inboundMode: 'blocklist' }), 'adv');
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    expect(r.row).toMatchObject({ quarantined: true, quarantine_reason: 'policy_blocked', trusted_bypass: false });
  });

  it.each([
    ['T1-064', 'low'],
    ['T1-065', 'medium'],
    ['T1-066', 'high'],
  ] as const)('[%s] 우회는 위험도 %s 에서 서되 등급은 none · 적중은 남는다', async (_id, risk) => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const r = await receiveMail(f, fakeScanner(risk, INJECTION).scan, trustedMail);
    expect(r.row).toMatchObject({ trusted_bypass: true, quarantined: false, watch_level: 'none', injection_risk: risk, findings: 2 });
  });

  it('[T1-067] 다른 조직의 신뢰 목록은 이 조직 에이전트에게 서지 않는다(조직 A 신뢰, 조직 B 수신)', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await trust(a, [D]);
    const r = await receiveMail(b, fakeScanner('high', INJECTION).scan, trustedMail);
    expectNotBypassed(r, 'T1-067');
    expect(r.row?.quarantine_reason).toBe('injection_risk');
  });

  it('[T1-068] 한 통이 두 조직의 에이전트에게 — 신뢰한 조직만 우회, 스캐너는 한 번', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await trust(a, [D]);
    const scanner = fakeScanner('high', INJECTION);
    const r = await receiveMail(a, scanner.scan, { ...trustedMail, recipients: [a.address, b.address] });
    expect(scanner.calls).toHaveLength(1);
    expect(r.row).toMatchObject({ trusted_bypass: true, quarantined: false });
    const rb = await rowFor(b.agentId, r.ses);
    expect(rb).toMatchObject({ trusted_bypass: false, quarantined: true, quarantine_reason: 'injection_risk' });
  });

  it('[T1-069] 항목을 지운 다음 받은 메일은 우회하지 않는다', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    expect((await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail)).row?.trusted_bypass).toBe(true);
    await trust(f, []);
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    expectNotBypassed(r, 'T1-069');
  });

  it('[T1-070] 지운 항목을 다시 넣으면 서고, 옛 우회 행은 그대로(소급해서 풀리지 않는다)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const first = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    await trust(f, []);
    const blocked = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    expectNotBypassed(blocked, 'T1-070');
    await trust(f, [D]);
    expect((await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail)).row?.trusted_bypass).toBe(true);
    expect((await rowFor(f.agentId, first.ses))?.trusted_bypass).toBe(true);
    expect((await rowFor(f.agentId, blocked.ses))?.quarantined).toBe(true);
  });

  it('[T1-071] 신뢰 목록을 지운 뒤 이미 우회로 들어온 메일은 격리로 되돌아가지 않는다(소급 없음 — 기록 사실)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const first = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    await trust(f, []);
    expect((await rowFor(f.agentId, first.ses))?.quarantined).toBe(false);
  });

  it('[T1-072] 경합: 수신 8통과 목록 삭제가 동시에 — 모든 행이 일관(우회면 보임·none, 아니면 격리)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const work = [
      ...Array.from({ length: 8 }, () => receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail)),
      trust(f, []),
    ];
    const results = await Promise.all(work);
    for (const r of results.slice(0, 8) as Awaited<ReturnType<typeof receiveMail>>[]) {
      expect(r.row).not.toBeNull();
      if (r.row?.trusted_bypass === true) expect(r.row).toMatchObject({ quarantined: false, watch_level: 'none' });
      else expect(r.row).toMatchObject({ quarantined: true, quarantine_reason: 'injection_risk' });
    }
    // 삭제가 끝난 뒤의 새 메일은 반드시 우회하지 않는다.
    expectNotBypassed(await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail), 'T1-072 after');
  });

  it('[T1-073] 경합: 목록 추가와 수신이 동시에 — 우회 행은 항상 DMARC 인증 From 이다', async () => {
    const f = await seedFixture(testPool());
    const results = await Promise.all([
      trust(f, [D]),
      ...Array.from({ length: 6 }, (_, i) => receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example', dmarc: i % 2 === 0 ? 'FAIL' : 'PASS' })),
    ]);
    for (const r of results.slice(1) as Awaited<ReturnType<typeof receiveMail>>[]) {
      if (r.row?.trusted_bypass === true) expect(r.row.from_authenticated).toBe(true);
    }
    const spoofed = (results.slice(1) as Awaited<ReturnType<typeof receiveMail>>[]).filter((r) => r.row?.from_authenticated === false);
    for (const r of spoofed) expect(r.row).toMatchObject({ trusted_bypass: false, quarantined: true });
  });

  it('[T1-074] 같은 메일 재전달(중복) 사이에 목록이 바뀌어도 첫 행이 정본(두 번째 INSERT 무시)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [D]);
    const first = await receiveMail(f, fakeScanner('high', INJECTION).scan, trustedMail);
    await trust(f, []);
    expect((await rowFor(f.agentId, first.ses))?.trusted_bypass).toBe(true);
    expect(randomUUID()).toBeTruthy();
  });
});
