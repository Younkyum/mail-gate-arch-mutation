/**
 * **호스팅 운영자 콘솔(`ops.atmark.ai`, ADR-0015) — 코드 층 격리.** 인프라 층(`test/unit/infra/compute-stack.test.ts` "운영자 콘솔":
 * 전용 λ·역할·HTTP API · SES·S3·KMS 0 · 비밀 둘)과 짝을 이룬다. 계획 `.omc/plans/ops-console.md` §3.9 "arch 테스트(I-9)".
 *
 *   ① **호스팅 폐포**(`handlers/ops.ts` + `src/ops/hosted/**` 의 런타임 import 폐포)에 다음이 없다:
 *      - 요금제 쓰기(`src/db/repositories/entitlements-write.ts` — `writeEntitlementVersion`) · `src/ops/core/plan*`(P3 — CLI 에만)
 *      - 운영 조립 루트(`composition.ts`) · 소유자 콘솔 조립(`admin-composition.ts`) · 소유자 세션(`src/admin/session.ts`)
 *      - 메일 전송단(`src/mail/transport/**`) · SES·S3·KMS SDK · 소유자 로그인 토큰(`owner-login-token`)
 *      - 소유자·결제 운영자 비밀의 이름·변수(`atmark/db/owner` · `atmark/db/billing-operator` · `DATABASE_MIGRATION_URL` ·
 *        `DATABASE_BILLING_OPERATOR_URL`) · **운영자 코드 키**(`ATMARK_OPS_LOGIN_KEYS_SECRET_ARN` — login-mailer 만, 결정 C2)
 *   ② 다른 모든 핸들러의 폐포에 `src/ops/hosted/**` 가 없다 — 콘솔(admin)·홈(site)·문서(docs)·api 번들에 운영자 세션 코드가 실리지 않는다.
 *   ③ `src/ops/**` 는 `scripts/**` 를 import 하지 않는다(로컬 셸 `scripts/ops-web` 은 소유자 풀을 쥔다).
 *
 * **비공허:** 폐포에 계약(`src/ops/contract.ts`)·조립(`src/runtime/ops-composition.ts`)·호스팅 파일이 실제로 있어야 한다 — 입구가 사라지면
 * 금지 목록은 빈 집합과 비교하며 영원히 초록이 된다. 그래서 `handlers/ops.ts` 가 없으면 **실패한다**(건너뛰지 않는다).
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { getProject, listTsFilesUnder, toRepoRelative } from './support/project';

const HANDLERS = 'src/runtime/handlers';
const OPS_HANDLER = `${HANDLERS}/ops.ts`;
const HOSTED_DIR = 'src/ops/hosted';

function sourceMap(): Map<string, SourceFile> {
  return new Map(getProject().getSourceFiles().map((file) => [toRepoRelative(file.getFilePath()), file]));
}

/** 런타임 import 폐포(타입 전용 import 제외 — 번들에 들어가지 않는다). 패키지 스펙은 `npm` 에 모은다. */
function runtimeClosure(entries: readonly string[]): { files: Set<string>; npm: Set<string> } {
  const byPath = sourceMap();
  const files = new Set<string>();
  const npm = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (files.has(path)) continue;
    const file = byPath.get(path);
    if (file === undefined) throw new Error(`${path} 를 ts-morph 가 읽지 못했다 — 이 층이 공허해진다.`);
    files.add(path);
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      if (declaration.isTypeOnly()) continue;
      if (declaration.getKind() === SyntaxKind.ImportDeclaration) {
        const imp = declaration.asKindOrThrow(SyntaxKind.ImportDeclaration);
        const named = imp.getNamedImports();
        if (named.length > 0 && named.every((n) => n.isTypeOnly()) && !imp.getDefaultImport() && !imp.getNamespaceImport()) continue;
      }
      const target = declaration.getModuleSpecifierSourceFile();
      const relative = target === undefined ? undefined : toRepoRelative(target.getFilePath());
      if (relative !== undefined && relative.startsWith('src/')) queue.push(relative);
      else {
        const specifier = declaration.getModuleSpecifierValue();
        if (specifier !== undefined && !specifier.startsWith('.')) npm.add(specifier);
      }
    }
    // 동적 import('…') 의 문자열 리터럴도 본다.
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const literal = call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
      if (literal !== undefined && !literal.startsWith('.')) npm.add(literal);
    }
  }
  return { files, npm };
}

function hostedEntries(): string[] {
  return [OPS_HANDLER, ...listTsFilesUnder(HOSTED_DIR)];
}

/** 폐포 안 파일에서 모인 문자열 리터럴·템플릿 조각·속성 접근 이름. */
function literalsAndNames(paths: Iterable<string>): { strings: string[]; names: string[]; identifiers: string[] } {
  const byPath = sourceMap();
  const strings: string[] = [];
  const names: string[] = [];
  const identifiers: string[] = [];
  for (const path of paths) {
    const file = byPath.get(path);
    if (file === undefined) continue;
    for (const node of file.getDescendantsOfKind(SyntaxKind.StringLiteral)) strings.push(`${path}: ${node.getLiteralValue()}`);
    for (const node of file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) strings.push(`${path}: ${node.getLiteralValue()}`);
    for (const node of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) names.push(`${path}: ${node.getName()}`);
    for (const node of file.getDescendantsOfKind(SyntaxKind.Identifier)) identifiers.push(`${path}: ${node.getText()}`);
  }
  return { strings, names, identifiers };
}

describe('호스팅 운영자 콘솔 — 코드 층 격리 (ADR-0015)', () => {
  it('① 호스팅 폐포 비공허: handlers/ops.ts · src/ops/hosted/** · 계약 · ops 조립이 있다', () => {
    const { files } = runtimeClosure(hostedEntries());
    expect(files.has(OPS_HANDLER), `${OPS_HANDLER} 가 없다 — 호스팅 입구가 없으면 이 층은 공허하다`).toBe(true);
    expect(listTsFilesUnder(HOSTED_DIR).length, `${HOSTED_DIR}/** 가 비었다`).toBeGreaterThan(0);
    expect(files.has('src/ops/contract.ts')).toBe(true);
    expect(files.has('src/runtime/ops-composition.ts')).toBe(true);
  });

  it('① 호스팅 폐포에 요금제 쓰기·plan 코어·운영/소유자 조립·소유자 세션·전송단·소유자 로그인 토큰이 없다', () => {
    const { files } = runtimeClosure(hostedEntries());
    const forbidden = [...files].filter(
      (path) =>
        path === 'src/db/repositories/entitlements-write.ts' ||
        /^src\/ops\/core\/plan[^/]*\.ts$/.test(path) ||
        path === 'src/runtime/composition.ts' ||
        path === 'src/runtime/admin-composition.ts' ||
        path === 'src/admin/session.ts' ||
        path.startsWith('src/mail/transport/') ||
        path.includes('owner-login-token'),
    );
    expect(forbidden).toEqual([]);
    // 이름으로도 — 다른 모듈이 다시 내보내도(`export { writeEntitlementVersion } from …`) 여기서 걸린다.
    const { identifiers } = literalsAndNames(files);
    expect(identifiers.filter((entry) => /: writeEntitlementVersion$/.test(entry))).toEqual([]);
  });

  it('① 호스팅 폐포의 패키지: SES·S3·KMS SDK 없음(Lambda·Secrets Manager 클라이언트는 허용 — 깨우기·자기 비밀)', () => {
    const { npm } = runtimeClosure(hostedEntries());
    expect([...npm].filter((spec) => /^@aws-sdk\/(client-ses|client-sesv2|client-s3|s3-request-presigner|client-kms)(\/|$)/.test(spec))).toEqual([]);
  });

  it('① 호스팅 폐포에 소유자·결제 운영자 비밀과 운영자 코드 키(login-mailer 전용)의 이름·변수가 없다', () => {
    const { files } = runtimeClosure(hostedEntries());
    const { strings, names } = literalsAndNames(files);
    const forbiddenStrings = [
      'atmark/db/owner',
      'atmark/db/billing-operator',
      'atmark/db/master',
      'DATABASE_MIGRATION_URL',
      'DATABASE_BILLING_OPERATOR_URL',
      'ATMARK_DB_MIGRATION_SECRET_ARN',
      'ATMARK_DB_MASTER_SECRET_ARN',
      'ATMARK_OWNER_LOGIN_KEYS_SECRET_ARN',
      'ATMARK_OPS_LOGIN_KEYS_SECRET_ARN',
      'atmark/owner-login-keys',
      'atmark/ops-login-keys',
    ];
    // 이름 **선언** 모듈은 뺀다 — 계약(`OPS_SECRET_NAMES`·`OPS_ENV`), 런타임 변수 표(`RUNTIME_ENV` · 운영에 있으면 안 되는 변수 목록
    //   `FORBIDDEN_PRODUCTION_ENV`), DB 클라이언트의 변수 이름 상수. 모든 핸들러가 공유하는 선언이라 폐포에 들어온다 — 대신 아래에서
    //   그 선언을 **읽는** 자리(속성 접근 · 상수 식별자)를 폐포 전체에서 금지한다.
    //   SSM 으로 옮긴 비밀 이름 목록(`ssm-secret-names.ts`, 2026-10-12)도 같은 종류의 선언이다 — 읽는 쪽 금지는 아래 속성 접근 단언이 진다.
    const DECLARATIONS = ['src/ops/contract.ts', 'src/runtime/config.ts', 'src/db/client.ts', 'src/runtime/ssm-secret-names.ts'];
    for (const declaration of DECLARATIONS.slice(1)) expect(files.has(declaration), `${declaration} 가 폐포에 없다 — 이 예외가 필요 없다`).toBe(true);
    expect(
      strings.filter((entry) => !DECLARATIONS.some((path) => entry.startsWith(`${path}:`)) && forbiddenStrings.some((s) => entry.endsWith(`: ${s}`))),
    ).toEqual([]);
    const forbiddenAccess = ['dbMigrationSecretArn', 'dbMasterSecretArn', 'ownerLoginKeysSecretArn', 'opsLoginKeysSecretArn', 'loginKeys'];
    expect(
      names.filter((entry) => !DECLARATIONS.some((path) => entry.startsWith(`${path}:`)) && forbiddenAccess.some((name) => entry.endsWith(`: ${name}`))),
    ).toEqual([]);
    // DB 클라이언트의 소유자 URL 상수를 폐포의 다른 파일이 쓰지 않는다(선언 파일 자신은 로컬 개발 경로에서 쓴다).
    const { identifiers } = literalsAndNames(files);
    expect(
      identifiers.filter((entry) => !entry.startsWith('src/db/client.ts:') && /: MIGRATION_DATABASE_URL_ENV$/.test(entry)),
    ).toEqual([]);
  });

  it('② 다른 모든 핸들러의 폐포에 src/ops/hosted/** 가 없다 — 콘솔(admin)·site·docs·api 포함(비공허: 핸들러 19개 이상)', () => {
    const others = listTsFilesUnder(HANDLERS).filter((path) => path !== OPS_HANDLER);
    expect(others.length).toBeGreaterThanOrEqual(19);
    for (const required of ['admin', 'site', 'docs', 'api', 'login-mailer', 'migrate']) expect(others).toContain(`${HANDLERS}/${required}.ts`);
    for (const handler of others) {
      const { files } = runtimeClosure([handler]);
      expect([...files].filter((path) => path.startsWith(`${HOSTED_DIR}/`) || path === OPS_HANDLER || path === 'src/runtime/ops-composition.ts'), handler).toEqual([]);
    }
  });

  it('③ src/ops/** 는 scripts/** 를 import 하지 않는다', () => {
    const byPath = sourceMap();
    const opsFiles = [...byPath.keys()].filter((path) => path.startsWith('src/ops/'));
    expect(opsFiles).toContain('src/ops/contract.ts');
    const offenders: string[] = [];
    for (const path of opsFiles) {
      const file = byPath.get(path) as SourceFile;
      for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const target = declaration.getModuleSpecifierSourceFile();
        const relative = target === undefined ? declaration.getModuleSpecifierValue() ?? '' : toRepoRelative(target.getFilePath());
        if (relative.startsWith('scripts/') || /(^|\/)scripts\//.test(relative)) offenders.push(`${path} → ${relative}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
