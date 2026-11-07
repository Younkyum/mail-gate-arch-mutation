#!/usr/bin/env tsx
/**
 * scripts/update-psl.ts — 공개 접미사 목록(PSL) 스냅샷 `src/domains/psl-data.ts` 를 **원문에서 다시 만든다**(ADR-0014 결정 1 · 계획 §3.1).
 *
 * 고객 도메인의 "등록 가능 apex" 판정(`src/domains/names.ts`)은 PSL 의 ICANN 절 **과 PRIVATE 절**을 모두 본다 — `foo.github.io` 같은
 * PRIVATE 접미사 아래 이름도 apex 로 보고 거부해야 하기 때문이다. 런타임 의존성(`psl`·`tldts`)을 넣지 않고 스냅샷을 vendor 한다
 * (공급망을 늘리지 않는다 — ADR 대안란). 이 스크립트가 그 스냅샷의 **유일한 생성 경로**다. 생성 파일은 손으로 고치지 않는다.
 *
 * 쓰는 법(런북 `custom-domains.md` — 분기마다):
 *   pnpm psl:update                      # https://publicsuffix.org/list/public_suffix_list.dat 을 내려받는다
 *   pnpm psl:update -- --from <파일>      # 이미 받은 원문으로(오프라인 · 재현)
 *
 * 규칙:
 *   - 원문의 SHA-256 · 가져온 날짜 · 절별 규칙 수를 생성 파일 머리에 적는다(`PSL_SOURCE`).
 *   - **ASCII 가 아닌 규칙(IDN 원문 표기)은 싣지 않는다.** 판정 함수는 LDH ASCII 만 받고 `xn--` 라벨을 거부하므로(§3.1), 유니코드 라벨·그
 *     punycode 형은 입력의 어느 라벨과도 같을 수 없다 — 빼도 판정이 달라지지 않는다. 뺀 수는 `skippedNonAscii` 로 남긴다.
 *   - 절 표지(`===BEGIN ICANN DOMAINS===` · `===BEGIN PRIVATE DOMAINS===`)가 없거나 규칙이 비정상적으로 적으면(각 절 500 미만) 쓰지 않고 멈춘다.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PSL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'domains', 'psl-data.ts');
const MIN_RULES_PER_SECTION = 500;
const RULE_SHAPE = /^(?:\*\.|!)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

interface ParsedList {
  readonly icann: readonly string[];
  readonly privateRules: readonly string[];
  readonly skippedNonAscii: number;
}

/** PSL 원문 → 절별 규칙(원문 순서, 중복 제거). 형식이 틀리면 던진다. */
export function parsePublicSuffixList(text: string): ParsedList {
  const icann: string[] = [];
  const privateRules: string[] = [];
  let section: 'none' | 'icann' | 'private' = 'none';
  let skippedNonAscii = 0;
  let sawIcann = false;
  let sawPrivate = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('// ===BEGIN ICANN DOMAINS===')) {
      section = 'icann';
      sawIcann = true;
      continue;
    }
    if (line.startsWith('// ===BEGIN PRIVATE DOMAINS===')) {
      section = 'private';
      sawPrivate = true;
      continue;
    }
    if (line.startsWith('// ===END')) {
      section = 'none';
      continue;
    }
    if (line === '' || line.startsWith('//') || section === 'none') continue;
    // PSL 규칙은 줄의 첫 공백 앞까지다(명세).
    const rule = (line.split(/\s/)[0] ?? '').toLowerCase();
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(rule)) {
      skippedNonAscii += 1;
      continue;
    }
    if (!RULE_SHAPE.test(rule)) throw new Error(`PSL 규칙 모양이 아니다: ${JSON.stringify(rule).slice(0, 80)}`);
    (section === 'icann' ? icann : privateRules).push(rule);
  }
  if (!sawIcann || !sawPrivate) throw new Error('PSL 절 표지(ICANN · PRIVATE)가 없다 — 원문이 아니다');
  const unique = (rules: readonly string[]): string[] => [...new Set(rules)];
  const result = { icann: unique(icann), privateRules: unique(privateRules), skippedNonAscii };
  if (result.icann.length < MIN_RULES_PER_SECTION || result.privateRules.length < MIN_RULES_PER_SECTION) {
    throw new Error(`PSL 규칙 수가 비정상이다(ICANN ${String(result.icann.length)} · PRIVATE ${String(result.privateRules.length)})`);
  }
  return result;
}

export function renderPslData(parsed: ParsedList, sha256: string, fetchedAt: string, source: string): string {
  return [
    '/**',
    ' * src/domains/psl-data.ts — **생성 파일**(`scripts/update-psl.ts`). 손으로 고치지 않는다 — `pnpm psl:update` 로 다시 만든다.',
    ' *',
    ` * 원문: ${source}`,
    ` * SHA-256: ${sha256}`,
    ` * 가져온 날: ${fetchedAt}`,
    ` * 규칙: ICANN ${String(parsed.icann.length)} · PRIVATE ${String(parsed.privateRules.length)} · ASCII 아닌 규칙 ${String(parsed.skippedNonAscii)}개 제외`,
    ' *   (판정 함수는 LDH ASCII 만 받고 `xn--` 라벨을 거부하므로 제외해도 판정이 같다 — 스크립트 머리말).',
    ' *',
    ' * Public Suffix List 는 Mozilla Public License 2.0 이다(https://mozilla.org/MPL/2.0/). 규칙 값만 옮기고 주석은 옮기지 않는다.',
    ' */',
    '',
    'export const PSL_SOURCE = {',
    `  url: ${JSON.stringify(PSL_URL)},`,
    `  sha256: ${JSON.stringify(sha256)},`,
    `  fetchedAt: ${JSON.stringify(fetchedAt)},`,
    `  icannRules: ${String(parsed.icann.length)},`,
    `  privateRules: ${String(parsed.privateRules.length)},`,
    `  skippedNonAscii: ${String(parsed.skippedNonAscii)},`,
    '} as const;',
    '',
    '/** ICANN 절 규칙 — 줄마다 하나(`*.` 와일드카드 · `!` 예외 포함). */',
    `export const PSL_ICANN_RULES = \`${parsed.icann.join('\n')}\`;`,
    '',
    '/** PRIVATE 절 규칙 — 줄마다 하나. v1 판정은 이 절도 접미사로 본다(`foo.github.io` = apex). */',
    `export const PSL_PRIVATE_RULES = \`${parsed.privateRules.join('\n')}\`;`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const fromIndex = process.argv.indexOf('--from');
  let text: string;
  let source: string;
  if (fromIndex >= 0) {
    const path = process.argv[fromIndex + 1];
    if (path === undefined) throw new Error('--from 뒤에 파일 경로가 없다');
    text = readFileSync(path, 'utf8');
    source = `${PSL_URL} (로컬 사본에서 생성)`;
  } else {
    const response = await fetch(PSL_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`PSL 을 받지 못했다: HTTP ${String(response.status)}`);
    text = await response.text();
    source = PSL_URL;
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const parsed = parsePublicSuffixList(text);
  const fetchedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(OUTPUT, renderPslData(parsed, sha256, fetchedAt, source));
  console.log(
    `psl-data.ts 생성 — ICANN ${String(parsed.icann.length)} · PRIVATE ${String(parsed.privateRules.length)} · 제외 ${String(parsed.skippedNonAscii)} · sha256 ${sha256}`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
