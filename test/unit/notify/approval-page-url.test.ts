/**
 * **알림 메일의 승인 링크 == 컴퓨트 스택이 서빙하는 승인 페이지** — 둘이 갈라지면 소유자 링크가 404 다.
 *
 * 결함(2026-09-23): 알림 상수가 `https://atmark.ai/approve` 였고 스택은 API 커스텀 도메인
 * `https://api.atmark.ai/approve` 에 페이지를 붙였다. 테스트가 둘을 맞붙이지 않아 초록이었다.
 *
 * 그리고 **상수는 주입 불가다**(T2 — 링크 호스트는 운영 설정으로 바꿀 수 없다). 검증자 V1 의 N11:
 * "상수를 환경 변수로 주입 가능하게" 변이가 arch 포함 초록이었다 — 아래 두 겹이 그것을 고정한다:
 *   ① 원문: `APPROVAL_PAGE_URL` 의 초기화식이 **문자열 리터럴**이고, 모듈에 `process.env` 가 없다.
 *   ② 실행: 환경 변수에 다른 호스트를 넣고 모듈을 새로 읽어도 값이 같다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Node, Project } from 'ts-morph';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APPROVAL_PAGE_URL } from '../../../src/notify/approval-notifier';
import { runtimeTemplates } from '../infra/runtime-app';

const NOTIFIER_FILE = resolve(__dirname, '../../../src/notify/approval-notifier.ts');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('승인 링크 URL — 스택과 한 값', () => {
  it('합성한 컴퓨트 스택의 출력 ApprovalPageUrl 이 알림 상수와 같다', () => {
    const outputs = runtimeTemplates().compute.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs['ApprovalPageUrl']?.Value).toBe(APPROVAL_PAGE_URL);
  });

  it('상수는 https 의 /approve 경로다', () => {
    const url = new URL(APPROVAL_PAGE_URL);
    expect([url.protocol, url.pathname, url.search, url.hash]).toEqual(['https:', '/approve', '', '']);
  });
});

describe('승인 링크 URL — 주입할 수 없다', () => {
  it('초기화식이 문자열 리터럴이고, 알림 모듈은 process.env 를 읽지 않는다', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = project.createSourceFile('approval-notifier.ts', readFileSync(NOTIFIER_FILE, 'utf8'));
    const declaration = source.getVariableDeclarationOrThrow('APPROVAL_PAGE_URL');
    const initializer = declaration.getInitializerOrThrow();
    expect(Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer), initializer.getText()).toBe(true);
    expect(declaration.getVariableStatementOrThrow().getDeclarationKind()).toBe('const');

    const envReads = source
      .getDescendants()
      .filter((node) => Node.isPropertyAccessExpression(node) && node.getText().startsWith('process.env'));
    expect(envReads.map((node) => node.getText())).toEqual([]);
  });

  it('환경 변수에 다른 호스트를 넣고 모듈을 새로 읽어도 값이 바뀌지 않는다', async () => {
    vi.stubEnv('ATMARK_APPROVAL_PAGE_URL', 'https://evil.example/approve');
    vi.stubEnv('APPROVAL_PAGE_URL', 'https://evil.example/approve');
    vi.resetModules();
    const fresh = await import('../../../src/notify/approval-notifier');
    expect(fresh.APPROVAL_PAGE_URL).toBe('https://api.atmark.ai/approve');
  });
});
