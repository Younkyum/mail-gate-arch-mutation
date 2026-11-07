/**
 * 운영자 웹 화면 페이지 — CSP 와 DOM 규율(콘솔 `src/admin/ui/page.ts` 와 같은 규칙).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - HTML 에 박힌 인라인 스크립트·스타일 **각각의** sha256 이 CSP 에 있다(독립 재계산) · 인라인 블록은 정확히 하나씩.
 *   - CSP: default-src 'none' · connect-src 'self' · frame-ancestors 'none' · form-action 'none' · base-uri 'none' · trusted types · 외부 출처 0.
 *   - 스크립트는 ASCII · `innerHTML` 류 싱크·`eval`·`new Function` 이 ops-web 소스 어디에도 없다 · `style=""`·`on*=` 속성 없음 · 외부 URL 없음.
 *   - 주황 없음(`@` 도 글자색).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOpsPage, LOCAL_PAGE_CONFIG, OPS_CSS, OPS_JS } from '../../../scripts/ops-web/page';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');
const page = buildOpsPage();

describe('운영자 웹 페이지', () => {
  it('인라인 블록의 해시가 CSP 에 있다(하나씩)', () => {
    const scripts = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
    const styles = [...page.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(page.csp).toContain(`script-src 'sha256-${sha(scripts[0] as string)}';`);
    expect(page.csp).toContain(`style-src 'sha256-${sha(styles[0] as string)}';`);
    expect(page.html).not.toMatch(/<script[^>]+src=/);
    expect(page.html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it('CSP 지시어 — 외부 출처 0', () => {
    for (const directive of [
      "default-src 'none'",
      "img-src 'none'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "require-trusted-types-for 'script'",
      "trusted-types 'none'",
    ]) {
      expect(page.csp).toContain(directive);
    }
    expect(page.csp).not.toMatch(/https?:|\*|'unsafe-/);
  });

  it('스크립트는 ASCII · 속성 스타일·이벤트 속성 없음 · 외부 URL 없음', () => {
    const script = page.html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    const markup = page.html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
    expect(markup).not.toMatch(/\sstyle=/i);
    expect(markup).not.toMatch(/\son[a-z]+=/i);
    expect(page.html).not.toMatch(/https?:\/\//);
    expect(OPS_CSS).not.toMatch(/url\(|@import|@font-face/);
  });

  it('DOM 싱크 — innerHTML·outerHTML·insertAdjacentHTML·document.write·eval·new Function 이 ops-web 소스에 없다', () => {
    const dir = join(process.cwd(), 'scripts/ops-web');
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts'));
    expect(files).toContain('page.ts');
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
    expect(OPS_JS).toContain('textContent');
  });

  it('주황(#F97316)은 어디에도 없다 — `@` 도 주변 글자색', () => {
    expect(OPS_CSS).not.toMatch(/#F97316|orange/i);
    expect(OPS_JS).not.toMatch(/#F97316|orange/i);
  });

  it('세션 토큰 — fragment 에서 sessionStorage 로 옮기고 주소에서 지운다 · 쿠키·앰비언트 자격 증명을 쓰지 않는다', () => {
    expect(OPS_JS).toContain('sessionStorage.setItem');
    expect(OPS_JS).toContain('history.replaceState');
    expect(OPS_JS).toContain("x['x-ops-token']=TOKEN");
    expect(OPS_JS).toContain("credentials:TOKEN_AUTH?'omit':'same-origin'");
    expect(OPS_JS).not.toMatch(/document\.cookie|localStorage|x-ops-csrf/);
    // 로컬 페이지에 박힌 설정은 fragment-token 하나(쿠키 없는 길) — 해시가 이 설정까지 덮는다.
    const script = page.html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script.startsWith('var CFG={"apiBase":"/api","auth":"fragment-token",')).toBe(true);
    expect(LOCAL_PAGE_CONFIG).toMatchObject({ apiBase: '/api', auth: 'fragment-token' });
  });

  it('설정은 순수 함수 입력 — 같은 설정이면 같은 바이트 · apiBase 가 경로 모양이 아니면 거부 · `<` 로 스크립트를 닫을 수 없다', () => {
    expect(buildOpsPage().html).toBe(page.html);
    const other = buildOpsPage({ ...LOCAL_PAGE_CONFIG, apiBase: '/ops/api', relaunchHint: '</script><b>x' });
    expect(other.html).toContain('"apiBase":"/ops/api"');
    expect(other.html).not.toContain('</script><b>');
    expect(other.csp).not.toBe(page.csp);
    for (const bad of ['api', '/api/', 'https://evil.example/api', '/api?x', '/a"b']) {
      expect(() => buildOpsPage({ ...LOCAL_PAGE_CONFIG, apiBase: bad }), bad).toThrow();
    }
  });

  it('사이드바 — 대시보드 · 주간 운영판 · 가입 검토 · 대기자 명단 · 조직 · 요금제 · 긴급 정지 · 감사 로그(이 순서)', () => {
    const labels = [...page.html.matchAll(/data-nav="([a-z]+)">[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(labels).toEqual([
      ['home', '대시보드'],
      ['board', '주간 운영판'],
      ['review', '가입 검토'],
      ['waitlist', '대기자 명단'],
      ['orgs', '조직'],
      ['plans', '요금제'],
      ['kill', '긴급 정지'],
      ['audit', '감사 로그'],
    ]);
  });

  it('빨강 토큰은 위험 버튼·오류·운영 대상·위험 카드 규칙에만', () => {
    const rules = OPS_CSS.split('}').filter((rule) => /--red-/.test(rule) && !/^\s*:root\{|@media \(prefers-color-scheme/.test(rule.trim()));
    expect(rules.length).toBeGreaterThan(4);
    for (const rule of rules) {
      expect(rule.trim(), rule).toMatch(/^(\.btn\.danger|\.msg\.err|\.target\.prod|\.card\.danger|\.over|\.toast\.err|dialog\.danger)/);
    }
  });
});

describe('대기자 명단 화면(202609301520)', () => {
  it('메모는 본인 확인이 없는 문자열이라 머리에 그렇게 적고 · textContent 로만 그린다(cell) · 확인 입력은 대상 주소/수', () => {
    expect(OPS_JS).toContain("'메모 (본인 확인 안 됨 · unverified)'");
    // 용도 · 등급 후보(용도와 메모에서 나온다)도 본인 확인이 없다 — 머리에 같은 표지.
    expect(OPS_JS).toContain("'용도 (본인 확인 안 됨 · unverified)'");
    expect(OPS_JS).toContain("'등급 후보 (본인 확인 안 됨 · unverified)'");
    expect(OPS_JS).toContain("api('GET','/waitlist?status='");
    expect(OPS_JS).toContain("label:'대상 주소를 그대로 입력하세요',expect:e.email");
    expect(OPS_JS).toContain("expect:String(n)");
  });

  it('"가장 오래 기다린 N명" 기본값은 하루 초대 한도(5)와 같다', () => {
    expect(OPS_JS).toContain("nIn.max='50';nIn.value='5';");
  });
});
