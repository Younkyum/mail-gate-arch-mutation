/**
 * 콘솔(admin λ) 번들에 폰트 데이터가 없다(리뷰 M4). 콘솔 폰트는 사이트 출처(`https://atmark.ai/_fonts/…`)가 내고, 콘솔 CSS 는 메타만 담은
 * `src/ui/font-faces.ts` 로 `@font-face` 를 만든다. 핸들러 진입점에서 값 import(`import type` 제외)를 따라가 닿는 파일에
 * `pretendard-data.ts`(청크 base64, 약 4MB)와 그것을 싣는 `src/ui/fonts.ts` 가 없음을 단언한다 — esbuild 번들의 입력이 이 폐포다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { inlined } from './console-harness';

const REPO = join(__dirname, '../../..');
const ENTRY = join(REPO, 'src/runtime/handlers/admin.ts');

/** 파일 하나의 값 import 경로들(상대 경로만 — 패키지는 번들 밖이거나 폰트와 무관). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"](\.[^'"]+)['"]/gm)) {
    if (m[2] !== undefined) continue;
    out.push(m[4] ?? '');
  }
  for (const m of text.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) out.push(m[1] ?? '');
  return out;
}

function resolveTs(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  return null;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      const next = resolveTs(file, spec);
      if (next !== null) todo.push(next);
    }
  }
  return seen;
}

describe('콘솔 번들 — 폰트 데이터 없음(리뷰 M4)', () => {
  it('admin 핸들러의 값 import 폐포에 pretendard-data.ts · ui/fonts.ts 가 없고, font-faces.ts(메타)는 있다', () => {
    const files = [...closure(ENTRY)].map((f) => relative(REPO, f));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => /pretendard-data|src\/ui\/fonts\.ts$/.test(f))).toEqual([]);
    expect(files).toContain('src/ui/font-faces.ts');
  });

  it('콘솔 페이지의 @font-face url 은 사이트 출처의 절대 URL 이다(같은 출처 /_fonts 없음)', () => {
    const html = inlined(renderAppPage('ko'));
    const urls = [...html.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(10);
    expect(urls.every((u) => u.startsWith('https://atmark.ai/_fonts/'))).toBe(true);
  });
});
