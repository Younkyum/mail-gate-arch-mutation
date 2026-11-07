/**
 * Layer A — Import boundary (계획 §5.0 "Layer A").
 *
 * **주장:** `@aws-sdk/client-ses*` 를 import 하는 파일은
 * `src/mail/transport/ses-transport.ts`(발송) · `src/mail/transport/ses-identity.ts`(제어면 — ADR-0014 단계 2) 둘뿐이다. 그리고
 * ① 제어면 파일은 **발송 명령을 import 하지 않는다**(`Send*` 이름 0) ② 제어면 파일의 export 를 쓰는 곳은 `src/runtime/handlers/domain-control.ts`
 * (VPC 밖 · DB 없는 λ — IAM 에 atmark.ai identity·발송 Deny)와 `src/runtime/handlers/domain-policy-audit.ts`(읽기 전용 역할) 둘이다.
 *
 * **이 층이 잡는 것**
 * - 관문 밖 아무 파일에서나 SES 클라이언트를 직접 만들어 쓰는 코드(정적 import).
 * - `import()` / `require()` 로 우회하려는 **문자열 리터럴** 형태의 동적 로드.
 *
 * **이 층이 못 잡는 것**
 * - 런타임에 조립된 모듈 스펙(`import('@aws-sdk/' + name)`) — AST 로는 보이지 않는다.
 * - SES HTTPS API 를 `fetch` 로 직접 때리는 코드 — SDK 를 아예 쓰지 않으므로 여기 안 걸린다.
 * - 다른 컴퓨트 유닛(Lambda, CLI 스크립트)이 IAM 권한으로 SES 를 부르는 경로.
 *   → 이 두 구멍은 **Layer E(IAM 단일 주체)** 가 닫는다. TS 분석의 원리적 한계이지
 *      이 층의 버그가 아니다.
 *
 * **왜 dependency-cruiser 와 중복인가:** `.dependency-cruiser.cjs` 의
 * `no-ses-sdk-outside-transport` 가 같은 명제를 이미 단언한다. 한 도구의 설정이 잘못되어
 * **룰이 아무 파일도 검사하지 않게 되는** 사고가 흔하고, 증명이 단일 설정에 의존하면
 * 증명이 아니다(§5.0 Layer A). 그래서 도구·구현이 다른 두 벌을 둔다.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind } from 'ts-morph';
import { getProject, importsModule, moduleSpecifiersOf, srcSourceFiles, toRepoRelative } from './support/project';

/** SES SDK 를 만질 수 있는 파일 — 발송(P1b)과 제어면(ADR-0014 단계 2). */
const SES_SDK_ALLOWED_FILES: readonly string[] = ['src/mail/transport/ses-identity.ts', 'src/mail/transport/ses-transport.ts'];

/** 제어면 파일 — 발송 명령 import 0 · export 의 소비자는 domain-control 핸들러 하나. */
const SES_CONTROL_PLANE_FILE = 'src/mail/transport/ses-identity.ts';
const SES_CONTROL_PLANE_CONSUMERS: readonly string[] = ['src/runtime/handlers/domain-control.ts', 'src/runtime/handlers/domain-policy-audit.ts'];
/**
 * `src` 밖에서 제어면 파일을 부르는 곳(#13 보안 리뷰 L6) — 운영자 CLI `pnpm admin:domain --revoke-all-policies` 하나(운영자 AWS 자격 · 관리 표시가 있는
 * identity 의 `atmark-sender-*` 정책 지우기만, Lambda 번들 밖). 늘어나면 여기서 빨개진다.
 */
const SES_CONTROL_PLANE_SCRIPT_CONSUMERS: readonly string[] = ['scripts/admin/domain.ts'];

/** `@aws-sdk/client-ses`, `@aws-sdk/client-sesv2`, 하위 경로 import 까지 포함한다. */
const SES_SDK_SPECIFIER = /^@aws-sdk\/client-ses/;

describe('Layer A — SES SDK import boundary', () => {
  const files = srcSourceFiles();

  it('스캐너가 실제로 src 파일을 읽고 있다 (공허한 통과 방지)', () => {
    // 대상 0건으로 통과하는 층은 아무것도 증명하지 않는다. tsconfig·glob 이 깨져
    // 프로젝트가 비면 아래 단언들은 전부 자동 통과하므로, 그 상태를 여기서 먼저 막는다.
    expect(files.length).toBeGreaterThan(0);
    // 운영자 콘솔(ADR-0015) — `src/ops/**`(호스팅 포함)도 스캔 대상이다. 운영 λ 의 SES 는 0 이고(IAM · 인프라 층), 운영자 코드 메일은
    //   login-mailer 가 기존 전송단으로 보낸다 — 허용 목록은 그대로 하나다.
    expect(files.some((file) => toRepoRelative(file.getFilePath()) === 'src/ops/contract.ts')).toBe(true);
    expect(SES_SDK_ALLOWED_FILES).toEqual(['src/mail/transport/ses-identity.ts', 'src/mail/transport/ses-transport.ts']);
  });

  it('SES SDK 를 정적 import 하는 파일은 허용 목록뿐이다', () => {
    const offenders = files
      .filter((file) => moduleSpecifiersOf(file).some((spec) => SES_SDK_SPECIFIER.test(spec)))
      .map((file) => toRepoRelative(file.getFilePath()))
      .filter((relative) => !SES_SDK_ALLOWED_FILES.includes(relative));

    expect(offenders).toEqual([]);
  });

  it('SES SDK 를 동적 import / require 하는 파일도 허용 목록뿐이다', () => {
    // 정적 import 만 보면 `await import('@aws-sdk/client-sesv2')` 한 줄로 이 층이 뚫린다.
    // 문자열 리터럴 인자까지는 AST 로 보이므로 여기서 덮는다.
    const offenders: string[] = [];

    for (const file of files) {
      const relative = toRepoRelative(file.getFilePath());
      if (SES_SDK_ALLOWED_FILES.includes(relative)) continue;

      const calls = file.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const callee = call.getExpression().getText();
        const isModuleLoad = callee === 'require' || call.getExpression().getKind() === SyntaxKind.ImportKeyword;
        if (!isModuleLoad) continue;

        const [firstArgument] = call.getArguments();
        const literal = firstArgument?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
        if (literal !== undefined && SES_SDK_SPECIFIER.test(literal)) offenders.push(relative);
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it('★ 제어면 파일(ses-identity.ts)은 SES SDK 에서 발송 명령을 import 하지 않는다 — 제어면 명령만(비공허: 실제로 명령을 import 한다)', () => {
    const file = files.find((candidate) => toRepoRelative(candidate.getFilePath()) === SES_CONTROL_PLANE_FILE);
    expect(file, `${SES_CONTROL_PLANE_FILE} 가 스캔 대상에 없다`).toBeDefined();
    const names = (file?.getImportDeclarations() ?? [])
      .filter((declaration) => SES_SDK_SPECIFIER.test(declaration.getModuleSpecifierValue()))
      .flatMap((declaration) => [
        ...declaration.getNamedImports().map((named) => named.getName()),
        ...(declaration.getNamespaceImport() === undefined ? [] : ['*']),
        ...(declaration.getDefaultImport() === undefined ? [] : ['default']),
      ]);
    expect(names).toContain('CreateEmailIdentityCommand');
    expect(names).toContain('CreateEmailIdentityPolicyCommand');
    // 네임스페이스·기본 import 는 무엇이든 부를 수 있다 — 이름으로만.
    expect(names.filter((name) => name === '*' || name === 'default')).toEqual([]);
    expect(names.filter((name) => /^Send/.test(name) || /Send.*Command$/.test(name))).toEqual([]);
  });

  it('★ 제어면 파일의 export 를 import 하는 src 파일은 domain-control 핸들러와 읽기 전용 감사 핸들러 둘이다', () => {
    const consumers = files
      .filter((file) =>
        file.getImportDeclarations().some((declaration) => {
          const target = declaration.getModuleSpecifierSourceFile();
          return target !== undefined && toRepoRelative(target.getFilePath()) === SES_CONTROL_PLANE_FILE;
        }),
      )
      .map((file) => toRepoRelative(file.getFilePath()))
      .sort();
    expect(consumers).toEqual([...SES_CONTROL_PLANE_CONSUMERS]);
  });

  it('★ src 밖의 제어면 소비자는 운영자 CLI(scripts/admin/domain.ts) 하나다(#13 L6)', () => {
    const consumers = getProject()
      .getSourceFiles()
      .filter((file) => !toRepoRelative(file.getFilePath()).startsWith('src/') && importsModule(file, SES_CONTROL_PLANE_FILE))
      .map((file) => toRepoRelative(file.getFilePath()))
      .filter((path) => !path.startsWith('test/'))
      .sort();
    expect(consumers).toEqual([...SES_CONTROL_PLANE_SCRIPT_CONSUMERS]);
  });
});
