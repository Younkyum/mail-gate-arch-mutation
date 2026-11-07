/**
 * B0(console-v4) — `app.ts` 를 모듈(`console/router.ts` · `console/markup/*` · `console/script/*` · `console/data.ts`)로 나눈 구조의 고정점.
 *
 * 분할 자체는 **동작 변화 0** 이 계약이었다: 분할 직전 `renderAppPage('ko'|'en')` 의 HTML·CSP sha256
 * (ko `df63ed23…c672`/`f7b2c370…3ca8` · en `66d33715…07f3`/`88b38c27…65f6`)과 분할 직후 값이 같음을 이 파일의 첫 판이
 * 단언했고(2026-09-25, 11 파일 351 통과), 그 뒤 v4 화면 작업이 의도해서 바이트를 바꿨다. 지금 이 파일은 분할 구조가 무너지지 않게 본다:
 *   ① `app.ts` 는 조립만 한다(마크업·스크립트 본문이 없다).
 *   ② 스크립트 조각은 모두 **정해진 순서로 한 번씩** 페이지 스크립트에 들어간다(한 IIFE 의 공유 스코프 — 순서가 계약).
 *   ③ 조각마다 코드(문자열·주석 밖)는 ASCII 다 — 한국어는 문자열 안에만(`asciiScript` 가 `\uXXXX` 로 바꾸는 자리).
 *   ④ 원문을 읽는 테스트가 볼 수 있게, UI 원문 파일 목록이 분할 뒤 파일까지 다 담는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_PARTS } from '../../../src/admin/ui/app';
import { AGENT_JS } from '../../../src/admin/ui/console/script/agent';
import { AGENTS_JS } from '../../../src/admin/ui/console/script/agents';
import { CORE_JS } from '../../../src/admin/ui/console/script/core';
import { DOMAINS_JS } from '../../../src/admin/ui/console/script/domains';
import { AI_WATCH_JS } from '../../../src/admin/ui/console/script/ai-watch';
import { EMAIL_JS } from '../../../src/admin/ui/console/script/email';
import { GATE_JS } from '../../../src/admin/ui/console/script/gate';
import { IDENTITY_JS } from '../../../src/admin/ui/console/script/identity';
import { LOGS_JS } from '../../../src/admin/ui/console/script/logs';
import { ORG_JS } from '../../../src/admin/ui/console/script/org';
import { OVERVIEW_JS } from '../../../src/admin/ui/console/script/overview';
import { SHELL_JS } from '../../../src/admin/ui/console/script/shell';
import { TEAM_JS } from '../../../src/admin/ui/console/script/team';
import { PLAN_JS } from '../../../src/admin/ui/console/script/plan';
import { TOKENS_JS } from '../../../src/admin/ui/console/script/tokens';
import { WATCH_JS } from '../../../src/admin/ui/console/script/watch';
import { WEBHOOKS_JS } from '../../../src/admin/ui/console/script/webhooks';

import { UI_DIR as UI, uiSources } from './console-harness';

const FRAGMENTS = { CORE_JS, AGENTS_JS, OVERVIEW_JS, LOGS_JS, AGENT_JS, EMAIL_JS, WEBHOOKS_JS, IDENTITY_JS, TOKENS_JS, GATE_JS, ORG_JS, TEAM_JS, PLAN_JS, DOMAINS_JS, AI_WATCH_JS, WATCH_JS, SHELL_JS };


/** 문자열 리터럴('…' · "…")과 주석을 지운 코드(정규식 리터럴 안의 따옴표는 이 조각들에 없다 — 있으면 ③ 이 알려 준다). */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

describe('B0 분할 구조', () => {
  it('① app.ts는 조립만 — 마크업 조각·스크립트 본문(String.raw)이 없다', () => {
    const app = readFileSync(join(UI, 'app.ts'), 'utf8');
    expect(app).not.toContain('String.raw');
    expect(app).not.toMatch(/<(section|dialog|table|form|nav)\b/);
    expect(app).toContain("const APP_SCRIPT_BODY = [CORE_JS, AGENTS_JS, OVERVIEW_JS, LOGS_JS, AGENT_JS, EMAIL_JS, WEBHOOKS_JS, IDENTITY_JS, TOKENS_JS, GATE_JS, ORG_JS, TEAM_JS, PLAN_JS, DOMAINS_JS, AI_WATCH_JS, WATCH_JS, SHELL_JS].join('');");
  });

  it('② 조각은 정해진 순서로 한 번씩 페이지 스크립트에 들어간다', () => {
    const script = APP_PARTS.script;
    let at = -1;
    for (const [name, frag] of Object.entries(FRAGMENTS)) {
      expect(frag.length, name).toBeGreaterThan(200);
      expect(script.split(frag).length - 1, name).toBe(1);
      const i = script.indexOf(frag);
      expect(i, name).toBeGreaterThan(at);
      at = i;
    }
  });

  it('③ 조각마다 코드(문자열·주석 밖)는 ASCII — 한국어는 문자열 안에만', () => {
    for (const [name, frag] of Object.entries(FRAGMENTS)) expect([...codeOnly(frag).matchAll(/[^\x00-\x7f]/g)].map((m) => m[0]), name).toEqual([]);
  });

  it('④ UI 원문 목록은 분할 뒤 파일까지 — router · kit · data · markup/* · script/*', () => {
    const files = uiSources().map((p) => p.slice(UI.length + 1)).sort();
    for (const f of ['app.ts', 'invite.ts', 'console/router.ts', 'console/kit.ts', 'console/data.ts', 'console/markup/shell.ts', 'console/markup/agent-identity.ts', 'console/markup/org-team.ts', 'console/script/tokens.ts', 'console/script/org.ts', 'console/script/team.ts']) expect(files).toContain(f);
    expect(files.filter((f) => f.startsWith('console/script/'))).toHaveLength(Object.keys(FRAGMENTS).length);
  });
});
