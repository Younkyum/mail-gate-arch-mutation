/**
 * ★ 키 자료 격리 — **개인키를 복호할 수 있는 파일은 `src/passport/signer.ts` 하나다** (계획 §3.5 AC-e2 · §5.0b Layer P4, 계약 §3).
 *
 * `.dependency-cruiser.cjs`(`passport-signer-only-from-signer-composition` · `no-kms-sdk-outside-runtime-kms`)와 **같은 주장을 다른 도구로**
 * 한 번 더 증명한다 — 설정 파일 하나가 잠들면 증명이 사라지는 사고를 이 리포는 이미 겪었다(그 파일 머리말).
 *
 * 주장:
 *   ① KMS `DecryptCommand` · AES-GCM 복호(`createDecipheriv`) · 개인키 파싱(`createPrivateKey`) · 서명(`node:crypto` 의 `sign`)을
 *      쓰는 `src` 파일 = `signer.ts` **정확히 하나**(비공허성: 그 하나가 실제로 잡힌다).
 *   ② 개발 키 파일(`.pkcs8`)을 **읽는** 파일은 `signer.ts` 하나 · 쓰는 파일은 `custody-local.ts` 하나.
 *   ③ `signer.ts` 를 import 하는 파일 = 서명 Lambda 조립 루트 하나. 그 조립 루트를 import 하는 파일 = 서명 핸들러 하나.
 *   ④ `signer.ts` 의 export 는 골든 목록과 같다 — 키 자료를 돌려주는 함수(`exportPrivateKey`·`loadKey` …)가 생기면 빨갛다.
 *   ⑤ 서명기 포트(`signing.ts` `PassportSigner`)의 메서드는 `signCompact` 하나 — 밖으로 나가는 것은 서명뿐이다.
 */

import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

import { getProject, importsModule, srcSourceFiles, toRepoRelative } from './support/project';

const SIGNER = 'src/passport/signer.ts';
const SIGNER_COMPOSITION = 'src/runtime/passport-signer-composition.ts';
const SIGNER_HANDLER = 'src/runtime/handlers/passport-signer.ts';
const LOCAL_CUSTODY = 'src/passport/custody-local.ts';
/** 웹훅 인증 헤더 봉인·열기(202610141400) — createDecipheriv 의 유일한 다른 사용처. */
const WEBHOOK_AUTHORIZATION = 'src/webhooks/authorization.ts';

function sourceFile(path: string): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === path);
  if (found === undefined) throw new Error(`${path} 를 ts-morph 가 읽지 못했다 — 이 층이 공허해진다.`);
  return found;
}

/** `module` 에서 `names` 중 하나라도 **이름으로** import 하는 src 파일. */
function importersOfNamed(module: RegExp, names: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const file of srcSourceFiles()) {
    for (const declaration of file.getImportDeclarations()) {
      if (!module.test(declaration.getModuleSpecifierValue())) continue;
      if (declaration.getNamespaceImport() !== undefined || declaration.getDefaultImport() !== undefined) out.add(toRepoRelative(file.getFilePath()));
      if (declaration.getNamedImports().some((named) => names.has(named.getName()))) out.add(toRepoRelative(file.getFilePath()));
    }
  }
  return [...out].sort();
}

function literalsOf(file: SourceFile): string[] {
  return file
    .getDescendants()
    .filter((node) => Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateHead(node) || Node.isTemplateMiddle(node) || Node.isTemplateTail(node))
    .map((node) => (node as unknown as { getLiteralText(): string }).getLiteralText());
}

describe('Layer P4 — 복호·서명 원시 연산은 signer.ts 하나에만', () => {
  it('① KMS DecryptCommand 를 import 하는 파일 = signer.ts 하나', () => {
    expect(importersOfNamed(/^@aws-sdk\/client-kms$/, new Set(['DecryptCommand']))).toEqual([SIGNER]);
  });

  it('① createPrivateKey · sign · privateDecrypt(node:crypto) 를 import 하는 파일 = signer.ts 하나', () => {
    // node:crypto 의 네임스페이스·기본 import 는 무엇이든 부를 수 있다 — 같은 위반으로 센다.
    expect(importersOfNamed(/^(node:)?crypto$/, new Set(['createPrivateKey', 'sign', 'privateDecrypt']))).toEqual([SIGNER]);
  });

  it('① createDecipheriv 는 signer.ts 와 웹훅 인증 헤더(authorization.ts — 웹훅 키 묶음 파생 키, passport 키와 무관) 둘뿐 · 후자는 passport·KMS 를 모른다', () => {
    // 웹훅 인증 헤더(202610141400)는 소유자가 준 값을 웹훅 시크릿 키 묶음에서 파생한 키로 봉인·연다 — 에이전트 개인키 envelope 과 키도 경로도 다르다.
    //   그 파일이 passport · KMS · 키 보관 모듈을 import 하면 이 예외가 개인키 복호의 뒷문이 된다 — 그래서 import 를 함께 묶는다.
    expect(importersOfNamed(/^(node:)?crypto$/, new Set(['createDecipheriv']))).toEqual([SIGNER, WEBHOOK_AUTHORIZATION].sort());
    const imports = sourceFile(WEBHOOK_AUTHORIZATION)
      .getImportDeclarations()
      .map((declaration) => declaration.getModuleSpecifierValue())
      .sort();
    expect(imports).toEqual(['../security/hmac-keyring', 'node:crypto']);
  });

  it('① 봉인을 여는 함수(openWebhookAuthorization)를 import 하는 src 파일 = 디스패처 하나(보안 리뷰 Info — 평문이 나오는 길은 전달 헤더 하나다)', () => {
    expect(importersOfNamed(/(^|\/)webhooks\/authorization$|^\.\/authorization$/, new Set(['openWebhookAuthorization']))).toEqual(['src/webhooks/dispatcher.ts']);
  });

  it('② 개발 키 파일(.pkcs8)을 다루는 파일 = 쓰는 custody-local.ts · 읽는 signer.ts 둘뿐 · 읽기(readFileSync)는 signer.ts 하나', () => {
    const touching = srcSourceFiles()
      .filter((file) => literalsOf(file).some((literal) => literal.includes('.pkcs8')))
      .map((file) => toRepoRelative(file.getFilePath()))
      .sort();
    expect(touching).toEqual([LOCAL_CUSTODY, SIGNER].sort());
    const readers = touching.filter((path) =>
      sourceFile(path)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .some((call) => /^(readFileSync|readFile)$/.test(call.getExpression().getText())),
    );
    expect(readers).toEqual([SIGNER]);
  });
});

describe('Layer P4 — signer.ts 의 import 그래프는 서명 Lambda 하나로 닫힌다', () => {
  it('③ signer.ts 를 import 하는 파일 = 서명 조립 루트 하나 · 그 조립 루트를 import 하는 파일 = 서명 핸들러 하나', () => {
    const signerImporters = srcSourceFiles()
      .filter((file) => importsModule(file, SIGNER))
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(signerImporters).toEqual([SIGNER_COMPOSITION]);
    const compositionImporters = srcSourceFiles()
      .filter((file) => importsModule(file, SIGNER_COMPOSITION))
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(compositionImporters).toEqual([SIGNER_HANDLER]);
  });

  it('④ signer.ts 의 export 는 골든 목록과 같다 — 키 자료를 돌려주는 export 가 없다', () => {
    const exported = [...sourceFile(SIGNER).getExportedDeclarations().keys()].sort();
    expect(exported).toEqual(['EnvelopeSecretReader', 'KmsDecryptClient', 'PassportSignerOptions', 'createPassportSigner', 'createSignerKmsClient'].sort());
  });

  it('⑤ 서명기 포트의 메서드는 signCompact 하나다 — 밖으로 나가는 것은 서명(JWS)뿐', () => {
    const port = sourceFile('src/passport/signing.ts').getInterfaceOrThrow('PassportSigner');
    expect(port.getMethods().map((method) => method.getName())).toEqual(['signCompact']);
  });
});
