/**
 * `src/security/**` 경계 — P4 (계획 §6 P4, PRD 제약).
 *
 *   1. **LLM SDK 금지.** injection 판정은 결정론적 룰이어야 한다(PRD). LLM 으로 injection 을 판정하면 판정기
 *      자체가 injection 대상이 된다 — 공격 메일이 판정 프롬프트를 탈취한다. 그리고 같은 입력에 같은 판정이
 *      나오지 않으면 `scanner_version` 으로 과거 판정을 재현할 수 없다.
 *   2. **외부 HTTP 0건.** 계획: "미래의 순진한 동기 DID fetch(SSRF)를 지금 봉쇄한다". `network-egress` 층이
 *      `src/**` 전체를 허용 파일 셋으로 묶어 이미 덮는다 — 여기서는 그 허용 셋이 언젠가 넓어져도
 *      `src/security/**` 만은 0 이라는 것을 **따로** 단언한다(허용 목록 한 줄 추가로 풀리지 않게).
 *   3. **스캐너는 순수하다.** `src/security/injection/**` 는 자기 디렉터리와 `node:crypto`(버전 해시)만
 *      import 한다. 파일·DB·네트워크·로거가 없으니 "스캐너가 무엇을 보는가" 가 인자로 끝나고,
 *      finding 이 로그로 새는 경로도 스캐너 안에는 없다.
 *   4. **발신 DLP·오염 분류도 순수하다**(ADR-0016). `src/security/dlp/**`·`src/security/taint.ts` 는 `src/security` 안의 순수 모듈
 *      (`dlp/**` · `injection/**` · `hmac-keyring` · `shared-mailbox`)과 `node:crypto` 만 import 한다 — DB·로거·인증 코드 추출기(ADR-0013 경계)가 없다.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { srcSourceFiles, toRepoRelative } from './support/project';

/** LLM·생성형 모델 SDK. 이름으로 적는다 — 새 SDK 가 나오면 여기에 더한다. */
const LLM_SDK =
  /^(@anthropic-ai\/.+|anthropic|openai|@openai\/.+|@google\/generative-ai|@google\/genai|@google-cloud\/vertexai|@mistralai\/.+|mistralai|cohere-ai|ollama|groq-sdk|replicate|together-ai|@huggingface\/inference|langchain|@langchain\/.+|llamaindex|ai|@ai-sdk\/.+|@aws-sdk\/client-bedrock[a-z-]*)(\/.*)?$/;

const EGRESS_MODULES = /^((node:)?(http|https|http2|tls|net|dgram|dns|dns\/promises|undici|child_process|worker_threads)|@aws-sdk\/client-[a-z0-9-]+(\/.*)?)$/;
const GLOBAL_EGRESS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);

const INJECTION_DIR = 'src/security/injection/';
const INJECTION_ALLOWED_EXTERNAL = new Set(['node:crypto']);

/** ADR-0016 순수 모듈과 그 모듈이 기댈 수 있는 `src/security` 안의 대상. */
const DLP_FILES = (path: string): boolean => path.startsWith('src/security/dlp/') || path === 'src/security/taint.ts';
const DLP_ALLOWED_TARGET = (path: string): boolean =>
  path.startsWith('src/security/dlp/') ||
  path.startsWith(INJECTION_DIR) ||
  path === 'src/security/hmac-keyring.ts' ||
  // 무료·공용 메일 도메인 목록(`isSharedMailboxDomain`) — 코드 지문의 출처 도메인 제외에서 뺀다. 플랫폼 도메인 상수만 import 하는 잎 모듈이다(정책 로더와의 순환을 끊었다).
  path === 'src/security/shared-mailbox.ts';

function securityFiles(): SourceFile[] {
  return srcSourceFiles().filter((f) => toRepoRelative(f.getFilePath()).startsWith('src/security/'));
}

/** 정적 import·`export … from`·동적 `import()`·`require()` 의 모듈 문자열 전부. */
function specifiersOf(source: SourceFile): string[] {
  const out = [
    ...source.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
    ...source.getExportDeclarations().map((d) => d.getModuleSpecifierValue() ?? ''),
  ];
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    const literal = call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    if ((callee === 'import' || callee === 'require') && literal !== undefined) out.push(literal);
  }
  return out.filter((s) => s.length > 0);
}

describe('src/security 경계', () => {
  it('검사 대상이 비어 있지 않다 — 스캐너 세 파일이 보인다(모자라면 이 층이 잠든 것이다)', () => {
    const files = securityFiles().map((f) => toRepoRelative(f.getFilePath()));
    expect(files).toEqual(
      expect.arrayContaining([`${INJECTION_DIR}scanner.ts`, `${INJECTION_DIR}rules.ts`, `${INJECTION_DIR}normalize.ts`]),
    );
  });

  it('src/security 의 어떤 파일도 LLM SDK 를 import 하지 않는다', () => {
    const offenders = securityFiles().flatMap((f) =>
      specifiersOf(f)
        .filter((s) => LLM_SDK.test(s))
        .map((s) => `${toRepoRelative(f.getFilePath())} → ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('src/security 의 어떤 파일도 네트워크 원시 모듈·전역 송출 API 를 쓰지 않는다', () => {
    const offenders: string[] = [];
    for (const f of securityFiles()) {
      const file = toRepoRelative(f.getFilePath());
      for (const s of specifiersOf(f)) if (EGRESS_MODULES.test(s)) offenders.push(`${file} → ${s}`);
      for (const id of f.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (!GLOBAL_EGRESS.has(id.getText())) continue;
        const parent = id.getParent();
        if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getChildAtIndex(0) !== id) continue;
        if (parent?.getKind() === SyntaxKind.PropertyAssignment || parent?.getKind() === SyntaxKind.PropertySignature) continue;
        offenders.push(`${file} → ${id.getText()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('injection 스캐너는 자기 디렉터리와 node:crypto 만 import 한다(순수 함수 묶음)', () => {
    const offenders: string[] = [];
    for (const f of securityFiles().filter((s) => toRepoRelative(s.getFilePath()).startsWith(INJECTION_DIR))) {
      const file = toRepoRelative(f.getFilePath());
      for (const declaration of f.getImportDeclarations()) {
        const spec = declaration.getModuleSpecifierValue();
        if (INJECTION_ALLOWED_EXTERNAL.has(spec)) continue;
        const resolved = declaration.getModuleSpecifierSourceFile();
        const target = resolved ? toRepoRelative(resolved.getFilePath()) : spec;
        if (!spec.startsWith('.') || !target.startsWith(INJECTION_DIR)) offenders.push(`${file} → ${spec}`);
      }
      for (const s of specifiersOf(f)) {
        if (!s.startsWith('.') && !INJECTION_ALLOWED_EXTERNAL.has(s)) offenders.push(`${file} → ${s}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('발신 DLP·오염 분류는 src/security 안의 순수 모듈과 node:crypto 만 import 한다(ADR-0016)', () => {
    const files = securityFiles().filter((f) => DLP_FILES(toRepoRelative(f.getFilePath())));
    expect(files.map((f) => toRepoRelative(f.getFilePath()))).toEqual(
      expect.arrayContaining(['src/security/dlp/scan.ts', 'src/security/dlp/secrets.ts', 'src/security/dlp/codes.ts', 'src/security/dlp/shingle.ts', 'src/security/taint.ts']),
    );
    const offenders: string[] = [];
    for (const f of files) {
      const file = toRepoRelative(f.getFilePath());
      for (const declaration of [...f.getImportDeclarations(), ...f.getExportDeclarations()]) {
        const spec = declaration.getModuleSpecifierValue() ?? '';
        if (spec === '' || INJECTION_ALLOWED_EXTERNAL.has(spec)) continue;
        const resolved = declaration.getModuleSpecifierSourceFile();
        const target = resolved ? toRepoRelative(resolved.getFilePath()) : spec;
        if (!spec.startsWith('.') || !DLP_ALLOWED_TARGET(target)) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
