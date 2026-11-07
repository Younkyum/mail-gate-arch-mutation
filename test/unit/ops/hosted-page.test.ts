/**
 * 호스팅 페이지(`HOSTED_PAGE_CONFIG`) — 쿠키 + CSRF 세션 · 이메일 코드 로그인 · step-up 대화상자(대상 참조) · 운영자 탭 · 대기 배지.
 * P1 화면에 요금제 · 동결 · 정지 쓰기가 없다. 로컬 페이지(`LOCAL_PAGE_CONFIG`)는 그대로다.
 */

import { describe, expect, it } from 'vitest';

import { buildOpsPage, HOSTED_PAGE_CONFIG, LOCAL_PAGE_CONFIG, OPS_JS } from '../../../src/ops/console/page';

const hosted = buildOpsPage(HOSTED_PAGE_CONFIG);
const local = buildOpsPage(LOCAL_PAGE_CONFIG);
const script = (html: string): string => html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const markup = (html: string): string => html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const nav = (html: string): string[] => [...html.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1] as string);

describe('호스팅 페이지', () => {
  it('설정 — cookie-csrf 가 해시 안에 박힌다 · 스크립트 ASCII · 외부 URL 0', () => {
    expect(script(hosted.html).startsWith('var CFG={"apiBase":"/api","auth":"cookie-csrf",')).toBe(true);
    expect(script(hosted.html)).toMatch(/^[\x00-\x7f]*$/);
    expect(hosted.html).not.toMatch(/https?:\/\//);
    expect(hosted.csp).not.toBe(local.csp);
    expect(hosted.csp).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    expect(hosted.csp).toContain("connect-src 'self'");
  });

  it('화면 — 대시보드 · 주간 운영판 · 가입 검토 · 대기자 명단 · 조직 · 운영자 · 감사(요금제 · 긴급 정지 없음) · 로컬은 운영자 대신 요금제 · 긴급 정지', () => {
    expect(nav(hosted.html)).toEqual(['home', 'board', 'review', 'waitlist', 'orgs', 'ops', 'audit']);
    expect(nav(local.html)).toEqual(['home', 'board', 'review', 'waitlist', 'orgs', 'plans', 'kill', 'audit']);
    expect(hosted.html).toContain('id="nav-ops-pending"');
    expect(hosted.html).toContain('id="nav-pending"');
    expect(local.html).not.toContain('id="login"');
    expect(local.html).not.toContain('id="stepup"');
  });

  it('로그인 · step-up 대화상자(대상 참조 자리) · 로그아웃이 있다', () => {
    const m = markup(hosted.html);
    expect(m).toContain('<section id="login" class="login" hidden></section>');
    expect(m).toContain('<dialog id="stepup"');
    expect(m).toContain('<span class="ref" id="s-ref"></span>');
    expect(m).toContain('autocomplete="one-time-code"');
    expect(m).toContain('id="logout"');
    expect(m).not.toMatch(/\sstyle=|\son[a-z]+=/i);
  });

  it('스크립트 — CSRF 헤더 · 쿠키는 스크립트가 읽지 않는다 · 로그인 · step-up · 운영자 경로', () => {
    expect(OPS_JS).toContain("if(HOSTED&&CSRF)x['x-atmark-ops-csrf']=CSRF;");
    expect(OPS_JS).not.toMatch(/document\.cookie|localStorage/);
    for (const route of ["'/auth/request'", "'/auth/verify'", "'/auth/step-up'", "'/auth/step-up/verify'", "'/auth/logout'", "'/operators'"]) expect(OPS_JS).toContain(route);
    expect(OPS_JS).toContain("document.getElementById('s-ref').textContent=r.targetRef");
  });

  it('P1 — 호스팅에서 요금제 · 동결 · 정지 쓰기로 가는 버튼이 막혀 있다', () => {
    expect(OPS_JS).toContain('if(HOSTED)return c;');
    expect(OPS_JS).toContain("if(!HOSTED){var ka=h('div','actions')");
    expect(OPS_JS).toContain('if(HOSTED)act=null;');
    expect(OPS_JS).toContain("if(HOSTED&&(name==='plans'||name==='kill'))name='home';");
  });

  it('새 문구 — 줄표(—) 없음 · 주황 없음', () => {
    expect(markup(hosted.html)).not.toContain('—');
    const hostedOnly = OPS_JS.slice(OPS_JS.indexOf('/* ---------- operators (hosted)'), OPS_JS.indexOf('/* ---------- audit'));
    expect(hostedOnly.length).toBeGreaterThan(1000);
    expect(hostedOnly).not.toContain('—');
    const stepUp = OPS_JS.slice(OPS_JS.indexOf('/* ---------- step-up'), OPS_JS.indexOf('function reviewDialog'));
    expect(stepUp).not.toContain('—');
    expect(OPS_JS).not.toMatch(/#F97316/i);
  });
});
