/**
 * 콘솔 HTTP API 와 US-003(홈 → 콘솔 교차 출처 로그인·가입) — 합성 템플릿 단언. **배포하지 않는다.**
 *
 *   - 프리플라이트는 admin Lambda 가 답한다: 콘솔 API 에 `CorsConfiguration` 이 **없고**(있으면 API Gateway 가 모든 경로의 OPTIONS 에
 *     스스로 답하고 헤더를 덮는다), 명시 라우트는 POST 뿐이라 `OPTIONS /api/login`·`/api/signup` 은 `$default` → admin 으로 간다.
 *   - 운영 스위치 `ATMARK_AUTH_ON_SITE` 는 기본 `'false'` — 컨텍스트 `atmarkAuthOnSite=true` 로만 켜진다.
 *   - 운영 스위치 `ATMARK_SITE_CORS`(검증 F2) 도 기본 `'false'` — 컨텍스트 `atmarkSiteCors=true` 로만 켜지고, 리다이렉트 스위치와 독립이다.
 */

import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_ON_SITE_CONTEXT_KEY,
  CONSOLE_AUTH_ON_SITE_DEFAULT,
  CONSOLE_SITE_CORS_DEFAULT,
  SITE_CORS_CONTEXT_KEY,
} from '../../../infra/cdk/stacks/compute-stack';
import { AUTH_ON_SITE_ENV, SITE_CORS_ENV } from '../../../src/admin/http';
import { buildRuntimeApp, runtimeTemplates } from './runtime-app';

type Resources = Record<string, { Properties: Record<string, unknown> }>;

function adminEnv(template: Template): Record<string, unknown> {
  const functions = template.findResources('AWS::Lambda::Function') as Resources;
  const admin = Object.values(functions).find((fn) => fn.Properties['FunctionName'] === 'atmark-admin');
  return ((admin?.Properties['Environment'] as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {});
}

describe('콘솔 HTTP API — 프리플라이트는 admin Lambda 로', () => {
  it('콘솔 API 에 CorsConfiguration 이 없다 · 명시 라우트는 POST 뿐 · OPTIONS 라우트 없음 · $default 가 있다', () => {
    const compute = runtimeTemplates().compute;
    const apis = compute.findResources('AWS::ApiGatewayV2::Api') as Resources;
    const consoleApi = Object.entries(apis).find(([, api]) => api.Properties['Name'] === 'atmark-console');
    expect(consoleApi).toBeDefined();
    expect(consoleApi?.[1].Properties['CorsConfiguration']).toBeUndefined();
    const routes = Object.values(compute.findResources('AWS::ApiGatewayV2::Route') as Resources)
      .filter((route) => JSON.stringify(route.Properties['ApiId']).includes(`"${consoleApi?.[0] ?? '?'}"`))
      .map((route) => String(route.Properties['RouteKey']));
    expect(routes).toContain('$default');
    // 예외 하나: 조직 API 키 표면(`ANY /org-api/{proxy+}`, 확장성 P1 R-6) — 브라우저를 받지 않는 기계 전용 경로라 그 OPTIONS 가 admin 으로
    //   가도 CORS 헤더 없이 거부된다(`admin/org-api/router.ts`). 로그인·가입 두 경로와 겹치지 않는다.
    const machineOnly = (key: string): boolean => key === 'ANY /org-api/{proxy+}';
    // 폰트 라우트는 없다(배포 전 리뷰 M4 — 콘솔 폰트는 사이트 출처 `https://atmark.ai/_fonts/…` 가 낸다).
    expect(routes.some((key) => key.includes('_fonts'))).toBe(false);
    for (const key of routes.filter((k) => k !== '$default' && !machineOnly(k))) expect(key, key).toMatch(/^POST \//);
    expect(routes.filter((key) => /^(OPTIONS|ANY) /.test(key) && !machineOnly(key))).toEqual([]);
    // 교차 출처 두 경로는 명시 POST 라우트(낮은 스로틀 버킷)가 있고, 같은 경로의 OPTIONS 는 그 라우트에 걸리지 않는다.
    expect(routes).toEqual(expect.arrayContaining(['POST /api/login', 'POST /api/signup']));
  });
});

describe(`운영 스위치 ${AUTH_ON_SITE_ENV}`, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("기본은 'false'(홈 DNS 전환 전에 콘솔을 배포해도 콘솔 자기 로그인 화면이 그대로다)", () => {
    expect(CONSOLE_AUTH_ON_SITE_DEFAULT).toBe(false);
    expect(adminEnv(runtimeTemplates().compute)[AUTH_ON_SITE_ENV]).toBe('false');
  });

  it(`컨텍스트 ${AUTH_ON_SITE_CONTEXT_KEY}=true 면 'true' · 다른 값이면 'false'`, () => {
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [AUTH_ON_SITE_CONTEXT_KEY]: 'true' }));
    expect(adminEnv(Template.fromStack(buildRuntimeApp().compute))[AUTH_ON_SITE_ENV]).toBe('true');
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [AUTH_ON_SITE_CONTEXT_KEY]: 'yes' }));
    expect(adminEnv(Template.fromStack(buildRuntimeApp().compute))[AUTH_ON_SITE_ENV]).toBe('false');
  }, 120_000);
});

describe(`운영 스위치 ${SITE_CORS_ENV} (검증 F2)`, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("기본은 'false'(atmark.ai 가 아직 Vercel 인 동안 콘솔을 배포해도 홈 출처 CORS 가 닫혀 있다)", () => {
    expect(SITE_CORS_ENV).toBe('ATMARK_SITE_CORS');
    expect(CONSOLE_SITE_CORS_DEFAULT).toBe(false);
    expect(adminEnv(runtimeTemplates().compute)[SITE_CORS_ENV]).toBe('false');
  });

  it(`컨텍스트 ${SITE_CORS_CONTEXT_KEY}=true 면 'true' · 다른 값이면 'false' · 리다이렉트 스위치와 독립`, () => {
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [SITE_CORS_CONTEXT_KEY]: 'true' }));
    const on = adminEnv(Template.fromStack(buildRuntimeApp().compute));
    expect([on[SITE_CORS_ENV], on[AUTH_ON_SITE_ENV]]).toEqual(['true', 'false']);
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ [AUTH_ON_SITE_CONTEXT_KEY]: 'true' }));
    const redirectOnly = adminEnv(Template.fromStack(buildRuntimeApp().compute));
    expect([redirectOnly[SITE_CORS_ENV], redirectOnly[AUTH_ON_SITE_ENV]]).toEqual(['false', 'true']);
  }, 120_000);
});
