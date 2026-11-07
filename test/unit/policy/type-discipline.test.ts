/**
 * 타입 규율 가드 — `DenyOnly`/`Decision` 분리와 `EvaluationContext` 형태. 컴파일러가 못 지키는 두 가지를 소스로 단언한다:
 *   ① 허용 생성자(`allowed`/`pendingApproval`)를 Stage 7 **밖에서** 쓰는 것 ② `EvaluationContext` 에 optional 이 생기는 것.
 *
 * 이름 정규식은 범위(`src/policy` 밖)·네임스페이스 import·별칭으로 빠져나갔고, 호출 지점 세기는 지역 바인딩
 * (`const { allowed } = PT`, `const mint = allowed`)으로 빠져나갔다. 그래서 `allowed`·`pendingApproval` 은 ts-morph 로 해석한
 * **참조 집합**으로 센다 — Stage 7 이 아닌 파일이 그 이름을 참조하는 것 자체가 실패다(표기법 독립).
 *
 * 못 잡는 것: `src/` 밖(발송 경로가 아니다 — Layer C 의 몫) · 문자열 동적 참조(리뷰가 막는다) · 허용된 파일 안의 호출 횟수.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { allowed, deny, pendingApproval, toDeniedDecision } from '../../../src/policy/types';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const POLICY_DIR = join(REPO_ROOT, 'src', 'policy');
const TYPES_FILE = 'src/policy/types.ts';

function toRepoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function policySourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(POLICY_DIR);
  return out.sort();
}

/** tsconfig 전체 — `src/**` 어디에 호출이 생겨도 보이게. */
const project = new Project({
  tsConfigFilePath: join(REPO_ROOT, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: false,
});
const typesFile = project.getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === TYPES_FILE);

type ConstructorName = 'allowed' | 'pendingApproval' | 'toDeniedDecision';

/** 참조 노드가 호출의 callee 자리에 있는가(import specifier·타입 위치·값 전달은 제외). */
function isCallee(reference: Node): boolean {
  const parent = reference.getParent();
  if (!parent) return false;
  if (Node.isCallExpression(parent)) return parent.getExpression() === reference;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference) {
    const grandParent = parent.getParent();
    return Node.isCallExpression(grandParent) && grandParent.getExpression() === parent;
  }
  return false;
}

/** 생성자 `name` 을 **참조하는** `src/**` 파일 목록(선언의 참조 그래프 — 정의부는 제외). */
function filesReferencing(name: ConstructorName): string[] {
  const declaration = typesFile?.getFunction(name);
  if (!declaration) {
    throw new Error(`${TYPES_FILE} 에 ${name} 선언이 없다 — 이 가드가 통째로 공허해진다.`);
  }

  const files = new Set<string>();
  for (const reference of declaration.getNameNodeOrThrow().findReferencesAsNodes()) {
    const relativePath = toRepoRelative(reference.getSourceFile().getFilePath());
    if (!relativePath.startsWith('src/')) continue;
    if (relativePath === TYPES_FILE) continue; // 선언부 자신
    files.add(relativePath);
  }
  return [...files].sort();
}

/**
 * 생성자 `name` 을 **호출하는** `src/**` 파일 목록 — `toDeniedDecision` 전용(거부 승격이라 이름을 아는 것은 정상).
 * `allowed`·`pendingApproval` 에는 쓰지 않는다 — 지역 바인딩으로 빠져나간다.
 */
function filesCalling(name: ConstructorName): string[] {
  const declaration = typesFile?.getFunction(name);
  if (!declaration) {
    throw new Error(`${TYPES_FILE} 에 ${name} 선언이 없다 — 이 가드가 통째로 공허해진다.`);
  }

  const files = new Set<string>();
  for (const reference of declaration.getNameNodeOrThrow().findReferencesAsNodes()) {
    if (!isCallee(reference)) continue;
    const relativePath = toRepoRelative(reference.getSourceFile().getFilePath());
    if (!relativePath.startsWith('src/')) continue;
    files.add(relativePath);
  }
  return [...files].sort();
}

describe('DenyOnly → Decision 승격 경로', () => {
  it('스캐너가 `src/policy/` 밖까지 읽고 있다 (공허한 통과 방지)', () => {
    // 아래 목록은 전부 `src/policy/` 안이라 스캔 범위가 좁아져도 통과한다 — 밖의 소스를 실제로 들고 있는지 따로 못 박는다.
    const scanned = project
      .getSourceFiles()
      .map((file) => toRepoRelative(file.getFilePath()))
      .filter((path) => path.startsWith('src/') && !path.startsWith('src/policy/'));
    expect(scanned.length).toBeGreaterThan(0);
  });

  it('허용(`allowed`)을 만드는 파일은 Stage 7 하나뿐이다', () => {
    // 늘어나는 순간 "승인 판정 경로는 하나"(§4.2 원칙 2)가 거짓이 된다.
    expect(filesReferencing('allowed')).toEqual(['src/policy/rules/outbound-mode.ts']);
  });

  it('승인 대기(`pendingApproval`)를 만드는 파일은 Stage 7 하나뿐이다 (§4.2 — "여기서만 PENDING_APPROVAL")', () => {
    // 관문·서비스가 직접 부르면 Stage 0~6 을 건너뛴 승인 대기가 생겨 억제된 수신자를 사람에게 묻게 된다(§4.2 원칙 1).
    expect(filesReferencing('pendingApproval')).toEqual(['src/policy/rules/outbound-mode.ts']);
  });

  it('`toDeniedDecision`(거부 승격)은 엔진·관문·Stage 7 만 쓴다', () => {
    // 스캐너 비공허성 — 참조 해석이 통째로 고장 나도 위 단언은 통과할 수 있어 여기서 3곳을 못 박는다.
    expect(filesCalling('toDeniedDecision')).toEqual([
      'src/policy/engine.ts',
      'src/policy/gate.ts',
      'src/policy/rules/outbound-mode.ts',
    ]);
  });

  it('Stage 0~6 규칙 모듈은 `Decision` 생성자를 전혀 부르지 않는다', () => {
    const hardStageFiles = [
      'src/policy/rules/kill-switch.ts',
      'src/policy/rules/identity.ts',
      'src/policy/rules/suppression.ts',
      'src/policy/rules/blocklist.ts',
      'src/policy/rules/limits.ts',
      'src/policy/rules/budget.ts',
      'src/policy/rules/content.ts',
    ];
    const constructors: readonly ConstructorName[] = ['allowed', 'pendingApproval', 'toDeniedDecision'];
    for (const constructor of constructors) {
      const scan = constructor === 'toDeniedDecision' ? filesCalling : filesReferencing;
      for (const file of scan(constructor)) {
        expect(hardStageFiles).not.toContain(file);
      }
    }
  });

  it('하드 Stage 7종이 전부 존재한다 — 파일이 사라지면 위 단언이 공허해진다', () => {
    const names = policySourceFiles().map(toRepoRelative).filter((f) => f.startsWith('src/policy/rules/'));
    expect(names).toEqual([
      'src/policy/rules/blocklist.ts',
      'src/policy/rules/budget.ts',
      'src/policy/rules/content.ts',
      'src/policy/rules/identity.ts',
      'src/policy/rules/kill-switch.ts',
      'src/policy/rules/limits.ts',
      'src/policy/rules/outbound-mode.ts',
      // 위험 보류·소유자 발신 승인 — Stage 7 의 좁히기 보조(`Decision` 생성자를 부르지 않는다).
      'src/policy/rules/risk-hold.ts',
      'src/policy/rules/send-approval.ts',
      'src/policy/rules/suppression.ts',
    ]);
  });
});

describe('Decision 생성자 — 세 verdict 가 전부 표현 가능하다', () => {
  const stamp = { policyVersion: 1, policyVersionId: 'v-1', evaluatedAt: new Date('2026-10-15T12:00:00Z') };

  it('allowed / pendingApproval / toDeniedDecision 이 audit 의 3값과 1:1 대응한다', () => {
    expect(allowed(['unrestricted_mode'], stamp).verdict).toBe('allowed');
    expect(toDeniedDecision(deny(['recipient_blocklisted']), stamp).verdict).toBe('denied');
    // 호출자는 Stage 7 하나다(위 참조 집합 단언).
    expect(pendingApproval(['new_recipient'], stamp).verdict).toBe('pending_approval');
  });

  it('`reasons` 와 정책 스탬프가 그대로 실린다 — 승격이 근거를 다시 쓰지 않는다', () => {
    const denied = toDeniedDecision(deny(['warmup_daily_cap'], 3600), stamp);
    expect(denied.reasons).toEqual(['warmup_daily_cap']);
    expect(denied.retryAfterSeconds).toBe(3600);
    expect(denied.policyVersionId).toBe('v-1');
  });
});

describe('EvaluationContext 형태 가드 — optional 필드 0개', () => {
  // optional 은 채우지 않는 호출자 = 관문을 얇게 지나가는 경로를 허락하고, 전수 테이블 테스트(§5.1)의 케이스 공간을 배로 만든다.
  it('types.ts 를 ts-morph 가 실제로 읽었다 (공허한 통과 방지)', () => {
    expect(typesFile).toBeDefined();
  });

  const GUARDED_INTERFACES = [
    'EvaluationContext',
    'OrganizationSnapshot',
    'AgentSnapshot',
    'OutboundAttempt',
    'AttachmentMeta',
    'SendCounters',
    'BudgetSnapshot',
    'ResolvedPolicy',
    'PolicyLimits',
    'ContentPolicy',
    'DenyOnly',
    'Decision',
    'PolicyStamp',
    'ApprovalContext',
    'RelationshipMatch',
    'ApprovalGrant',
    'BootstrapGraceInput',
    'PreApprovalRules',
    'VerifiedThreadReply',
    'RepliedInbound',
    'DomainSnapshot',
    'RiskHoldContext',
  ] as const;

  for (const name of GUARDED_INTERFACES) {
    it(`${name} 에 optional(?) 필드가 없다`, () => {
      const declaration = typesFile?.getInterface(name);
      expect(declaration, `${name} 인터페이스를 찾지 못했다`).toBeDefined();

      const optional = (declaration?.getProperties() ?? [])
        .filter((property) => property.hasQuestionToken())
        .map((property) => property.getName());

      expect(optional).toEqual([]);
    });
  }

  it('가드 대상 목록이 types.ts 의 인터페이스 전부를 덮는다 — 새 인터페이스가 규칙 밖에 생기지 않게', () => {
    const declared = (typesFile?.getInterfaces() ?? []).map((node) => node.getName()).sort();
    expect(declared).toEqual([...GUARDED_INTERFACES].sort());
  });

  it('`DenyOnly` 에는 verdict 계열 필드가 없다 — 허용을 표현할 수단이 없어야 한다', () => {
    const denyOnly = typesFile?.getInterface('DenyOnly');
    const propertyNames = (denyOnly?.getProperties() ?? []).map((property) => property.getName());

    expect(propertyNames).toEqual(['kind', 'reasons', 'retryAfterSeconds']);

    // `kind` 는 리터럴 `'deny'` 하나다. 유니온이 되면 그 순간 허용이 표현 가능해진다.
    const kind = denyOnly?.getProperty('kind');
    expect(kind?.getTypeNode()?.getText()).toBe("'deny'");
    expect(kind?.getTypeNode()?.getKind()).not.toBe(SyntaxKind.UnionType);
  });

  it('하드 Stage 시그니처의 반환 타입은 `HardStageResult` 하나다', () => {
    const alias = typesFile?.getTypeAlias('HardStageRule');
    expect(alias?.getTypeNode()?.getText()).toContain('HardStageResult');
    expect(alias?.getTypeNode()?.getText()).not.toContain('Decision');
  });
});
