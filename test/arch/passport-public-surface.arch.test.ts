/**
 * 공개 신원 표면의 형태 — **응답 본문은 필드 allowlist 직렬화기 하나만 만든다** (계획 §4B.3 "엔드포인트 하드닝" · §5.0b Layer P3).
 *
 * `GET /v1/identity/{address}` 는 무인증·CORS *·공개 캐시다. 한 번 나간 필드는 회수할 수 없으므로, 필드를 **고르는** 코드가 둘이 되면
 * 안 된다. 이 파일이 단언하는 것:
 *   ① 라우트 파일(`src/api/routes/identity.ts`)의 응답 `body` 는 `toPublicIdentityView(...)` 호출 또는 고정 404 상수뿐이다.
 *   ② 라우트 파일은 DB 행 타입(`src/db/schema.ts`)도 DB 클라이언트도 import 하지 않는다 — 도메인 객체를 직접 직렬화할 재료가 없다.
 *   ③ 직렬화기(`toPublicIdentityView`)는 객체 전개(`...x`)를 쓰지 않는다 — 입력을 펼치면 입력 타입이 넓어지는 날 그 필드가 새어 나간다.
 *   ④ 공개 읽기(`public-directory.ts`)의 SQL 에 비공개 칸 이름(`key_ref`·`owner_email`·`organization_id`·`config_json`·`limits`)이 없다
 *      (조직은 조인 술어 `ON o.id = a.organization_id` 한 번으로만 — 조직 층 발송 차단을 불리언으로 판정하려고). 주소는 **대표 주소만**
 *      찾는다(`WHERE addr.address = $1 … AND addr.address = atmark_agent_primary_address(addr.agent_id)` — 메일 기본기 D5, 별칭 비공개 · AC-P-1 ·
 *      ADR-0014 2026-10 개정 유효 대표).
 *   ⑤ 외부 라이브러리 검증 테스트(`test/integration/passport/external-verification.test.ts`)는 `src/**` 를 import 하지 않는다
 *      (§5.0b Layer P1 — "이 한 줄이 AC-11 을 증거로 만드는 전부다").
 *   ⑥~⑧ 2026-09-24 검증 반영 — 비정규 주소 404 · 폐기 did.json 검증 수단 없음 · 위반 정의(변이 카탈로그 `PP1`~`PP3`).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

import { toAgentId } from '../../src/db/schema';
import { POLICY_VIOLATION_REASONS } from '../../src/passport/attestations';
import { buildRevokedDidDocument } from '../../src/passport/document';
import { normalizePublicAddress } from '../../src/passport/public-directory';
import { getProject, repoPath, toRepoRelative } from './support/project';

const ROUTE = 'src/api/routes/identity.ts';
const VIEW = 'src/passport/public-view.ts';
const DIRECTORY = 'src/passport/public-directory.ts';
const EXTERNAL_VERIFICATION = 'test/integration/passport/external-verification.test.ts';

function sourceFile(path: string): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === path);
  if (found === undefined) throw new Error(`${path} 를 ts-morph 가 읽지 못했다 — 이 층이 공허해진다.`);
  return found;
}

describe('Layer P3 — 공개 신원 응답은 직렬화기 하나만 만든다', () => {
  it('① 라우트의 응답 body = toPublicIdentityView(...) 또는 PUBLIC_IDENTITY_NOT_FOUND 뿐 (비공허성: 둘 다 실제로 있다)', () => {
    const bodies = sourceFile(ROUTE)
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .filter((assignment) => assignment.getName() === 'body')
      .map((assignment) => assignment.getInitializerOrThrow().getText());
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect(body).toMatch(/^(toPublicIdentityView\([A-Za-z]+\)|PUBLIC_IDENTITY_NOT_FOUND)$/);
    expect(bodies).toContain('PUBLIC_IDENTITY_NOT_FOUND');
    expect(bodies.some((body) => body.startsWith('toPublicIdentityView('))).toBe(true);
  });

  it('② 라우트는 DB 행 타입·DB 클라이언트·pg 를 import 하지 않는다', () => {
    const specifiers = sourceFile(ROUTE)
      .getImportDeclarations()
      .map((declaration) => declaration.getModuleSpecifierValue());
    expect(specifiers.filter((specifier) => /db\/(schema|client)|^pg$/.test(specifier))).toEqual([]);
  });

  it('③ toPublicIdentityView 는 객체 전개(...)를 쓰지 않는다 — 필드를 하나씩 새로 만든다', () => {
    const view = sourceFile(VIEW).getFunctionOrThrow('toPublicIdentityView');
    expect(view.getDescendantsOfKind(SyntaxKind.SpreadAssignment)).toEqual([]);
    expect(view.getDescendantsOfKind(SyntaxKind.SpreadElement)).toEqual([]);
    // 비공허성: 같은 스캐너가 전개를 실제로 찾는다(같은 파일 안의 다른 코드가 아니라 합성 노드로 확인).
    const probe = getProject().createSourceFile('__probe_spread.ts', 'const a = { x: 1 }; const b = { ...a };', { overwrite: true });
    expect(probe.getDescendantsOfKind(SyntaxKind.SpreadAssignment).length).toBe(1);
    getProject().removeSourceFile(probe);
  });

  it('④ 공개 읽기의 SQL 에 비공개 칸 이름이 없다', () => {
    const literals = sourceFile(DIRECTORY)
      .getDescendants()
      .filter((node) => Node.isNoSubstitutionTemplateLiteral(node) || Node.isStringLiteral(node) || Node.isTemplateHead(node))
      .map((node) => node.getText())
      .join('\n');
    expect(literals).toMatch(/FROM agent_addresses/); // 비공허성 — SQL 을 실제로 읽고 있다.
    // 조직은 **조인 키로만** 쓴다(공개 can_send 가 조직 층 차단을 반영 — 2026-09-24 검증). 그 조인 술어 하나를 걷어 낸 나머지에
    // `organization_id` 가 있으면 조직 식별자를 읽는 것이다. 조직 이름(`o.name`)·소유자 메일도 없어야 한다.
    const joins = literals.match(/ON o\.id = a\.organization_id/g) ?? [];
    expect(joins).toHaveLength(1);
    const scrubbed = literals.replace(/ON o\.id = a\.organization_id/g, '');
    for (const forbidden of ['key_ref', 'owner_email', 'organization_id', 'config_json', 'limits', 'monthly_budget', 'subject', 'snippet', 'o.name', 'o.id AS']) {
      expect(scrubbed, forbidden).not.toContain(forbidden);
    }
    // 대표 주소만(D5) — 주소 술어는 정확히 하나이고 그 주소가 **유효 대표**(ADR-0014 2026-10 개정 — `atmark_agent_primary_address`)여야 한다. 조건을
    // 빼거나 `OR` 로 느슨하게 하면 별칭 · 잠든 앵커(`ax--`)가 공개 조회에 드러난다(AC-P-1 · M3b 통합 테스트가 행동으로도 본다).
    const addressPredicates = literals.match(/addr\.address = \$1[^`'"]*/g) ?? [];
    // 메일 기본기 2차 A6 — 폐기한 주소도 빠진다(AC-A6-3).
    expect(addressPredicates).toEqual(['addr.address = $1 AND addr.retired_at IS NULL AND addr.address = atmark_agent_primary_address(addr.agent_id)']);
  });
});

describe('Layer P3 — 2026-09-24 검증 반영(변이 PP1~PP3 가 겨냥한다)', () => {
  it('⑥ 공개 조회는 비정규 주소를 고쳐 받지 않는다 — 대문자·공백·개행 변형은 없는 주소와 같다(캐시 키가 갈라지지 않게)', () => {
    expect(normalizePublicAddress('agent@atmark.ai')).toBe('agent@atmark.ai'); // 비공허
    for (const variant of ['Agent@atmark.ai', 'agent@ATMARK.ai', ' agent@atmark.ai', 'agent@atmark.ai\n', 'agent@atmark.ai\t']) {
      expect(normalizePublicAddress(variant), JSON.stringify(variant)).toBeNull();
    }
  });

  it('⑦ 폐기된 DID 의 did.json 에는 검증 수단이 없고, 서명 워커는 폐기 버전이면 그 문서를 올린다', () => {
    const revoked: Record<string, unknown> = { ...buildRevokedDidDocument({ did: 'did:web:id.atmark.ai:agents:x', agentId: toAgentId('0'.repeat(32)) }) };
    for (const key of ['verificationMethod', 'authentication', 'assertionMethod']) expect(revoked, key).not.toHaveProperty(key);
    const publisher = readFileSync(repoPath('src/passport/publisher.ts'), 'utf8');
    expect(publisher).toContain("row.status === 'revoked' ? buildRevokedDidDocument(");
  });

  it('⑧ no_policy_violations 는 소유자 정책이 막은 거부를 세지 않는다(화이트리스트 밖 · 블랙리스트 · 전부 X · 옛 이름)', () => {
    expect(POLICY_VIOLATION_REASONS).toContain('from_forgery'); // 비공허
    for (const reason of ['recipient_not_allowlisted', 'recipient_blocklisted', 'outbound_disabled', 'recipient_not_in_allowlist', 'blocklist']) {
      expect(POLICY_VIOLATION_REASONS, reason).not.toContain(reason);
    }
  });
});

describe('Layer P1 — 외부 검증 테스트는 우리 코드에 의존하지 않는다', () => {
  it('⑤ external-verification.test.ts 의 import 는 외부 라이브러리·node 내장·vitest 뿐이다 (src/** 0)', () => {
    const text = readFileSync(repoPath(EXTERNAL_VERIFICATION), 'utf8');
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(3); // 비공허성
    expect(specifiers.filter((specifier) => specifier.startsWith('.') || specifier.includes('src/'))).toEqual([]);
  });
});
