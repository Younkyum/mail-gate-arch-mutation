/**
 * Lambda 코드 출처 — Compute · Transparency · Site · Docs 스택이 함께 쓴다.
 * - `assets`: `dist/lambda/<name>/` — 운영. 경로가 없으면 synth 가 **실패한다**.
 * - `stub`: 인라인 스텁 — 테스트·D1 빌드 전 synth 용. 템플릿에 **배포를 거부하는 CloudFormation Rule** 이 붙는다.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export type LambdaCodeSource = { readonly kind: 'assets'; readonly root: string } | { readonly kind: 'stub' };

const STUB_SOURCE = "exports.handler = async () => { throw new Error('atmark stub: not a deployable build (pnpm build:lambda)'); };";

export function lambdaCodeOf(source: LambdaCodeSource, handler: string): lambda.Code {
  if (source.kind === 'stub') return lambda.Code.fromInline(STUB_SOURCE);
  const dir = join(source.root, handler);
  if (!existsSync(join(dir, 'index.js'))) {
    throw new Error(
      `${join(dir, 'index.js')} 가 없다 — 'pnpm build:lambda' 를 먼저 돌려라. ` +
        '운영 synth 는 빌드 산출물 없이 진행하지 않는다(테스트용 스텁은 -c atmark:lambdaStub=true).',
    );
  }
  return lambda.Code.fromAsset(dir);
}

/** 스텁 코드로 합성한 템플릿은 배포할 수 없다 — 항상 거짓인 CfnRule. `warn` 이면 synth 경고도 남긴다. */
export function refuseStubDeployment(stack: cdk.Stack, source: LambdaCodeSource, options: { readonly warn: boolean }): void {
  if (source.kind !== 'stub') return;
  new cdk.CfnRule(stack, 'StubLambdaCodeIsNotDeployable', {
    assertions: [
      {
        assert: cdk.Fn.conditionEquals('lambda-code', 'stub-refused'),
        assertDescription: 'This template was synthesized with stub Lambda code (-c atmark:lambdaStub=true). Run pnpm build:lambda and synth again.',
      },
    ],
  });
  if (options.warn) {
    cdk.Annotations.of(stack).addWarningV2(
      'atmark:lambda-stub',
      'Lambda 코드가 인라인 스텁이다 — 이 템플릿은 배포가 거부된다(CfnRule). pnpm build:lambda 후 다시 synth 하라.',
    );
  }
}
