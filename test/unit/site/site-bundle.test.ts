/**
 * `site` 번들의 import 폐포 — **홈 Lambda 는 `src/site/**` · 자기 핸들러 파일 · `src/billing/constants.ts` · `src/billing/plans.ts`(둘 다 import
 * 없는 값 파일) 말고는 아무것도 싣지 않는다.**
 *
 * `src/ui/fonts.ts`·`src/ui/pretendard-data.ts`·`src/ui/tokens.ts`(두 표면 공통 비색상 토큰) 도 허용한다(자체 호스팅 폰트 — 생성된 값 파일과 그 조회. 콘솔과 같은 바이트를 쓰려고 `src/ui` 에 둔다).
 *
 * `src/billing/plans.ts` 를 허용한 이유(2026-09-26, 가격 페이지 `/pricing`): 가격 페이지의 한도 표는 정책 관문이 실제로 거는 **카탈로그
 * (`PLAN_CATALOG`·`ENTITLEMENT_CEILINGS`)를 렌더할 때 그대로 읽어야** 숫자가 어긋나지 않는다 — 옮겨 적으면 카탈로그를 고칠 때 공개 페이지가
 * 조용히 틀린다. 그 파일은 import 가 하나도 없는 순수 값·함수 파일이라(머리말 "import 가 없다" — 순환 금지로 강제) 번들에 DB·SDK·비밀·환경을
 * 끌어오지 않는다. 그 파일이 무엇이든 import 하기 시작하면 아래 정규식이 새 입력을 거부해 빨개진다 — 허용은 이 파일 하나뿐이다.
 *
 * 역할에 권한이 0 이어도(IAM 테스트), 번들에 조립 루트·DB 클라이언트·AWS SDK 가 들어오면 "권한만 없으면 된다" 가 유일한
 * 방어선이 된다. 코드 쪽에서도 닫는다: 번들 입력 파일 목록이 위 셋뿐이고, 결과에 `pg`·`@aws-sdk`·비밀 명령이 없다.
 * `src/runtime/config.ts` 도 들어오지 않는다 — 그 파일은 `passport/custody` 를 끌고 온다(WP-2 결제 페이지 설정은 핸들러의 작은 파서가 읽는다).
 * **환경 변수는 결제 페이지 세 키(`SITE_PAY_ENV`)만** — `process.env` 는 통째로 그 파서에 넘기는 한 곳뿐이고, 번들의 `ATMARK_*` 이름은 그 셋뿐이다.
 * `pnpm build:lambda` 와 같은 설정(`lambdaBuildOptions`)으로 메모리에서 만든다.
 */

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { LAMBDA_HANDLERS, lambdaBuildOptions } from '../../../scripts/build-lambda';
import { SITE_PAY_ENV } from '../../../src/runtime/handlers/site';

describe('site 번들', () => {
  it('build:lambda 계약 목록에 있다', () => {
    expect(LAMBDA_HANDLERS).toContain('site');
  });

  it('입력은 src/site/** · 핸들러 · src/billing/constants.ts · src/billing/plans.ts 뿐 · DB·SDK·비밀·로컬 구현·config.ts 없음', async () => {
    const result = await build({
      ...lambdaBuildOptions('site'),
      write: false,
      metafile: true,
      outfile: '/virtual/site/index.js',
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(3);
    for (const input of inputs) {
      expect(input, input).toMatch(/^(src\/site\/[a-z-]+\.ts|src\/runtime\/handlers\/site\.ts|src\/billing\/(constants|plans)\.ts|src\/ui\/(fonts|font-faces|pretendard-data|pretendard-faces|tokens|favicon|brand)\.ts)$/);
    }
    // 비공허: 결제 페이지 모듈이 실제로 폐포에 있다(Host 분기).
    expect(inputs).toContain('src/site/pay.ts');
    // 비공허: 가격 페이지와 카탈로그가 폐포에 있다(한도 표가 카탈로그를 읽는다).
    expect(inputs).toContain('src/site/pricing.ts');
    expect(inputs).toContain('src/billing/plans.ts');
    // 비공허: 자체 호스팅 폰트(값 파일 둘 — `src/ui/fonts.ts` 는 `pretendard-data.ts` 하나만 import 한다)가 폐포에 있다.
    expect(inputs).toContain('src/ui/pretendard-data.ts');
    const text = result.outputFiles?.[0]?.text ?? '';
    expect(text).toMatch(/export\s*\{[^}]*\bhandler\b[^}]*\}/);
    expect(text).not.toMatch(/@aws-sdk|GetSecretValueCommand|SendEmailCommand|PutObjectCommand|require\(["']pg["']\)|from ["']pg["']/);
    // 환경: `process.env` 는 결제 설정 파서에 통째로 넘기는 한 곳뿐 — 속성 접근(`process.env.X`·`process.env[...]`)이 없다.
    const uses = [...text.matchAll(/process\.env(.)/g)].map((m) => m[1]);
    expect(uses).toEqual([')']);
    // 번들에 적힌 환경 변수 이름은 결제 페이지 세 키뿐이다.
    const names = new Set([...text.matchAll(/\bATMARK_[A-Z0-9_]+\b/g)].map((m) => m[0]));
    expect([...names].sort()).toEqual(Object.values(SITE_PAY_ENV).sort());
  }, 30_000);
});
