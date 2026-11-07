/**
 * ★ 결제 경계 층(WP-2, Paddle — `.omc/plans/wp2-paddle-adapter.md` 원칙 1·3 · §3-2 · §10-3). 변이 `BL-1`~`BL-4`(`mutations/catalogue.ts`)가 겨냥한다.
 *
 *   ① **서명 비교는 상수 시간뿐** — `src/billing/paddle/signature.ts` 의 `verifyPaddleSignature` 는 다이제스트를 `timingSafeEqual` 로만 비교한다.
 *      그 함수 안의 동등 비교(`===`·`!==`·`==`·`!=`)는 길이(`.length`)·`null`·숫자 리터럴과의 비교뿐이고 `.equals(` 호출이 없다(BL-4).
 *   ② **Paddle 로 나가는 문은 하나** — `src/billing/**` 에서 `fetch` 를 쓰는 파일은 `src/billing/paddle/http.ts` 하나다(`network-egress` 가 `src/**` 전체를 본다).
 *   ③ **인터넷에 열린 웹훅 λ 는 DB 를 모른다** — `billing-webhook` 번들(`pnpm build:lambda` 와 같은 설정)의 입력에 `node_modules/pg`·`src/db/`·
 *      조립 루트(`composition.ts`·`admin-composition.ts`)가 0 이다(BL-1). 타입 전용 import 는 esbuild 가 지우므로 세지 않는다.
 *   ④ **웹훅 역할에 VPC·관리형 정책이 없다** — 합성된 AtmarkCompute 의 `atmark-runtime-billing-webhook` 역할은 AWS 관리형 정책 0 · 함수 VPC 없음(BL-3).
 *   ⑤ **SQS SDK 는 `src/runtime/sqs.ts` 하나** — `src/**` 에서 `@aws-sdk/client-sqs` 를 import 하는 파일(BL-2 는 network-egress 가 먼저 잡는다 — 여기는 SQS 한정 확인).
 *   ⑥ 공유 계약 파일의 import 경계 — `src/billing/constants.ts` 는 import 0 · `src/billing/queue-message.ts` 는 `./constants` 하나(웹훅 번들이 이 둘을 싣는다).
 */

import { build } from 'esbuild';
import { SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { lambdaBuildOptions } from '../../scripts/build-lambda';
import { runtimeTemplates } from '../unit/infra/runtime-app';
import { getProject, srcSourceFiles, toRepoRelative } from './support/project';

const SIGNATURE_FILE = 'src/billing/paddle/signature.ts';
const EQUALITY = new Set([SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken]);

function sourceOf(relative: string) {
  const file = getProject()
    .getSourceFiles()
    .find((source) => toRepoRelative(source.getFilePath()) === relative);
  if (file === undefined) throw new Error(`${relative} 이 프로젝트에 없다`);
  return file;
}

describe('① 웹훅 서명 비교는 상수 시간(timingSafeEqual)뿐이다', () => {
  it('verifyPaddleSignature 는 timingSafeEqual 을 부르고, 그 안의 동등 비교는 길이·null·숫자와의 비교뿐이며 .equals( 가 없다', () => {
    const file = sourceOf(SIGNATURE_FILE);
    const importsTimingSafe = file
      .getImportDeclarations()
      .some((d) => d.getModuleSpecifierValue() === 'node:crypto' && d.getNamedImports().some((n) => n.getName() === 'timingSafeEqual'));
    expect(importsTimingSafe).toBe(true);
    const fn = file.getFunction('verifyPaddleSignature');
    expect(fn, 'verifyPaddleSignature 가 없다').toBeDefined();
    if (fn === undefined) return;
    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression).map((call) => call.getExpression().getText());
    expect(calls).toContain('timingSafeEqual');
    expect(calls.filter((callee) => /\.equals$|\.compare$/.test(callee))).toEqual([]);
    const harmless = (text: string): boolean => text === 'null' || text === 'undefined' || /^\d+$/.test(text) || /\.length$/.test(text);
    const offenders = fn
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .filter((binary) => EQUALITY.has(binary.getOperatorToken().getKind()))
      .filter((binary) => !harmless(binary.getLeft().getText()) && !harmless(binary.getRight().getText()))
      .map((binary) => binary.getText());
    expect(offenders).toEqual([]);
    // 비공허: 이 함수에 동등 비교가 실제로 있다(길이·null) — 검사가 아무것도 안 보는 상태가 아니다.
    expect(fn.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((b) => EQUALITY.has(b.getOperatorToken().getKind()))).toBe(true);
  });
});

describe('② Paddle 로 나가는 문은 하나', () => {
  it('src/billing/** 에서 fetch 를 쓰는 파일 = src/billing/paddle/http.ts', () => {
    const users = srcSourceFiles()
      .filter((source) => toRepoRelative(source.getFilePath()).startsWith('src/billing/'))
      .filter((source) =>
        source.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
          if (id.getText() !== 'fetch') return false;
          const parent = id.getParent();
          if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getChildAtIndex(0) !== id) return false;
          return parent?.getKind() !== SyntaxKind.PropertyAssignment && parent?.getKind() !== SyntaxKind.PropertySignature;
        }),
      )
      .map((source) => toRepoRelative(source.getFilePath()))
      .sort();
    expect(users).toEqual(['src/billing/paddle/http.ts']);
  });
});

describe('③ 웹훅 λ 번들은 DB 를 모른다', () => {
  it('billing-webhook 번들 입력에 pg·src/db·조립 루트가 0 이다', async () => {
    const result = await build({
      ...lambdaBuildOptions('billing-webhook'),
      write: false,
      metafile: true,
      outfile: '/virtual/billing-webhook/index.js',
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs).toContain('src/runtime/handlers/billing-webhook.ts');
    const forbidden = inputs.filter(
      (input) =>
        /node_modules\/(\.pnpm\/)?pg[@/-]/.test(input) ||
        input.startsWith('src/db/') ||
        /^src\/runtime\/(composition|admin-composition|billing-composition)\.ts$/.test(input),
    );
    expect(forbidden).toEqual([]);
  }, 30_000);
});

describe('④ 웹훅 역할 — VPC·관리형 정책 0', () => {
  it('atmark-runtime-billing-webhook 역할에 관리형 정책이 없고 atmark-billing-webhook 함수에 VpcConfig 가 없다', () => {
    const compute = runtimeTemplates().compute;
    const roles = compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string; ManagedPolicyArns?: unknown[] } }>;
    const role = Object.values(roles).find((r) => r.Properties.RoleName === 'atmark-runtime-billing-webhook');
    expect(role, '웹훅 역할이 없다').toBeDefined();
    expect(role?.Properties.ManagedPolicyArns ?? []).toEqual([]);
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string; VpcConfig?: unknown } }>;
    const fn = Object.values(functions).find((f) => f.Properties.FunctionName === 'atmark-billing-webhook');
    expect(fn, '웹훅 함수가 없다').toBeDefined();
    expect(fn?.Properties.VpcConfig).toBeUndefined();
  });
});

describe('⑤ SQS SDK 는 한 파일', () => {
  it('@aws-sdk/client-sqs 를 import 하는 src 파일 = src/runtime/sqs.ts', () => {
    const importers = srcSourceFiles()
      .filter((source) => source.getImportDeclarations().some((d) => /^@aws-sdk\/client-sqs(\/|$)/.test(d.getModuleSpecifierValue())))
      .map((source) => toRepoRelative(source.getFilePath()));
    expect(importers).toEqual(['src/runtime/sqs.ts']);
  });
});

describe('⑥ 공유 계약 파일의 import 경계', () => {
  it('src/billing/constants.ts 는 import 가 없다 · queue-message.ts 는 ./constants 하나', () => {
    expect(sourceOf('src/billing/constants.ts').getImportDeclarations().map((d) => d.getModuleSpecifierValue())).toEqual([]);
    expect(sourceOf('src/billing/queue-message.ts').getImportDeclarations().map((d) => d.getModuleSpecifierValue())).toEqual(['./constants']);
  });
});
