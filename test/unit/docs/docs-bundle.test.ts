/**
 * `docs` 번들의 import 폐포 — **문서 λ 는 `src/docs/**` · 자기 핸들러 · `src/ui/**` 의 값 파일(폰트·토큰·파비콘) · `src/billing/plans.ts`(import 없는
 * 값 파일 — `{{plan-limits}}` 가 카탈로그를 그대로 읽는다) 말고는 아무것도 싣지 않는다.** 홈(`site-bundle.test.ts`)과 같은 규율.
 * DB 클라이언트·AWS SDK·비밀·조립 루트·환경 변수 접근이 없다(역할에 권한이 0 이어도 코드 쪽에서도 닫는다). `src/site/**`·`src/mcp/**` 도 들어오지 않는다
 * (값은 옮겨 적고 `docs-sources.test.ts` 가 대조한다). `pnpm build:lambda` 와 같은 설정으로 메모리에서 만든다.
 */

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { LAMBDA_HANDLERS, lambdaBuildOptions } from '../../../scripts/build-lambda';

describe('docs 번들', () => {
  it('build:lambda 계약 목록에 있다', () => {
    expect(LAMBDA_HANDLERS).toContain('docs');
  });

  it('입력은 src/docs/** · 핸들러 · src/ui 값 파일 · src/billing/plans.ts 뿐 · DB·SDK·비밀·환경 없음', async () => {
    const result = await build({ ...lambdaBuildOptions('docs'), write: false, metafile: true, outfile: '/virtual/docs/index.js', logLevel: 'silent' });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(5);
    for (const input of inputs) {
      expect(input, input).toMatch(
        /^(src\/docs\/[a-z-]+\.ts|src\/docs\/generated\/(content\.json|shots\.ts)|src\/runtime\/handlers\/docs\.ts|src\/billing\/plans\.ts|src\/ui\/(fonts|font-faces|pretendard-data|pretendard-faces|tokens|favicon|brand|og-version)\.ts)$/,
      );
    }
    // 비공허: 콘텐츠·스크린샷·폰트 바이트·카탈로그가 실제로 폐포에 있다.
    for (const needed of ['src/docs/generated/content.json', 'src/docs/generated/shots.ts', 'src/ui/pretendard-data.ts', 'src/billing/plans.ts', 'src/docs/http.ts']) {
      expect(inputs).toContain(needed);
    }
    const text = result.outputFiles?.[0]?.text ?? '';
    expect(text).toMatch(/export\s*\{[^}]*\bhandler\b[^}]*\}/);
    expect(text).not.toMatch(/@aws-sdk|GetSecretValueCommand|SendEmailCommand|PutObjectCommand|require\(["']pg["']\)|from ["']pg["']/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/\bATMARK_(?!AGENT_TOKEN\b)[A-Z0-9_]+\b/);
  }, 60_000);
});
