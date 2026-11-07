/**
 * P3c — **격리 메일은 에이전트 컨텍스트에 없다**(계획 §6 P4 "quarantine → 에이전트 컨텍스트 API 에서 제외")를
 * 코드 모양으로 단언한다. 런타임 층은 `test/integration/inbound/inbound-read-api.test.ts`·`forward.test.ts`.
 *
 *   ① 에이전트 컨텍스트 저장소(`inbound-read-store.ts`)의 SQL 중 `inbound_messages` 를 읽는 것은 **전부**
 *      `visibleToAgent(...)` 술어를 품는다. 새 조회 함수가 술어를 빠뜨리면 여기서 빨갛다(런타임 테스트가 그
 *      함수를 아직 모를 때도).
 *   ② 에이전트 표면(조회 라우트 셋 + `forward`)은 수신 메일을 **그 저장소로만** 읽는다 — 원시 저장소
 *      (`inbound-store.ts`: 소비자의 쓰기 포트·P3b 판정 조회)를 import 하지 않고, `inbound_messages` SQL 을
 *      직접 품지 않는다.
 *   ③ 술어 자체가 두 겹이다(`NOT quarantined` 그리고 `injection_risk IS NOT NULL` — 판정 없음도 격리).
 *   ⑤ **`policy_blocked` 는 어떤 에이전트 표면에도 없다**(메일 기본기 1차 AC-A4-3 — 2026-09-26). 에이전트 표면·웹훅(`src/webhooks/**`)·
 *      MCP(`src/mcp/**`)·인증코드 추출(`src/mail/verification/**`)의 소스에 리터럴 `policy_blocked` 가 0건이다. 소유자가 수신 정책으로
 *      막은 메일은 존재도 에이전트에게 보이지 않는다(④) — 그 값을 이름으로 부르는 코드가 에이전트 쪽에 생기면 그것이 새는 입구다.
 *      저장소의 술어(`countedAsQuarantine`)는 이 목록 밖이다(그 자리가 "빼는" 곳이다).
 *
 * 한계: 정적 층이다 — SQL 을 문자열 연결로 쪼개 조립하면 ① 은 못 본다(`sender-marks-surface` 와 같은 한계).
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { countedAsQuarantine, visibleToAgent } from '../../src/db/repositories/inbound-read-store';
import { getProject, listTsFilesUnder, toRepoRelative } from './support/project';

const READ_STORE = 'src/db/repositories/inbound-read-store.ts';
const RAW_STORE = 'src/db/repositories/inbound-store.ts';
const AGENT_SURFACES = [
  'src/api/routes/inbound-messages.ts',
  'src/api/routes/threads.ts',
  'src/api/routes/attachments.ts',
  'src/api/routes/forward.ts',
  'src/api/inbound-view.ts',
  // 메일 기본기 1차(A1) — 인증코드 조회도 수신 메일을 읽는 에이전트 표면이다(두 모드 모두 격리·policy_blocked 는 후보가 아니다).
  'src/api/routes/verification-code.ts',
  // 묶음 B — 라벨(받은 메일에 붙인다 · 목록에 센다) · 초안(답장 대상을 확인한다). 둘 다 저장소로만 읽는다.
  'src/api/routes/labels.ts',
  'src/api/routes/drafts.ts',
] as const;

/** 묶음 B — 받은 메일 상태 · 응답 `risk` 재료의 저장소. 이 파일의 `inbound_messages` 조회도 전부 `visibleToAgent` 를 건다(①-b). */
const STATE_STORE = 'src/db/repositories/message-state-store.ts';

/** ⑤ 의 범위 — 에이전트 표면 밖이지만 에이전트에게 닿는 디렉터리(웹훅 페이로드 · MCP · 인증코드 추출). */
const AGENT_FACING_DIRS = ['src/webhooks', 'src/mcp', 'src/mail/verification'] as const;

function file(path: string): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((f) => toRepoRelative(f.getFilePath()) === path);
  if (found === undefined) throw new Error(`파일이 없다: ${path}`);
  return found;
}

/** 템플릿·문자열 리터럴의 **원문**(치환식 포함). */
function sqlLiterals(source: SourceFile): string[] {
  return [
    ...source.getDescendantsOfKind(SyntaxKind.StringLiteral).map((l) => l.getLiteralValue()),
    ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral).map((l) => l.getLiteralValue()),
    ...source.getDescendantsOfKind(SyntaxKind.TemplateExpression).map((t) => t.getText()),
  ];
}

describe('P3c — 에이전트 컨텍스트에서 격리 메일 제외 (정적)', () => {
  it('① inbound-read-store 의 inbound_messages 조회는 전부 visibleToAgent 술어(또는 그 위의 countedAsQuarantine)를 품는다', () => {
    const queries = sqlLiterals(file(READ_STORE)).filter((sql) => /\b(FROM|JOIN)\s+inbound_messages\b/.test(sql));
    // 비공허성: 목록·개수·상세·첨부(상세)·스레드·스레드 개수·첨부 — 조회가 실제로 여럿 있다.
    expect(queries.length).toBeGreaterThanOrEqual(6);
    const missing = queries.filter((sql) => !sql.includes('visibleToAgent(') && !sql.includes('countedAsQuarantine('));
    expect(missing).toEqual([]);
  });

  it('①-b 받은 메일 상태 저장소(라벨 · 읽음 · risk 재료)의 inbound_messages 조회도 전부 visibleToAgent 술어를 품는다 — 격리 메일은 라벨 · 목록 · 위험 재료에 없다', () => {
    const queries = sqlLiterals(file(STATE_STORE)).filter((sql) => /\b(FROM|JOIN)\s+inbound_messages\b/.test(sql));
    // 비공허성: 위험 재료 · 라벨 바꾸기의 확인 · 라벨 목록 · 읽음 — 넷.
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.filter((sql) => !sql.includes('visibleToAgent('))).toEqual([]);
    expect(sqlLiterals(file(STATE_STORE)).some((literal) => literal.includes('policy_blocked'))).toBe(false);
  });

  it('② 에이전트 표면은 원시 수신 저장소를 import 하지 않고 inbound_messages SQL 을 직접 품지 않는다', () => {
    const offenders: string[] = [];
    for (const path of AGENT_SURFACES) {
      const source = file(path);
      for (const declaration of source.getImportDeclarations()) {
        const target = declaration.getModuleSpecifierSourceFile();
        if (target !== undefined && toRepoRelative(target.getFilePath()) === RAW_STORE) offenders.push(`${path} → ${RAW_STORE}`);
      }
      if (sqlLiterals(source).some((sql) => /\binbound_messages\b/.test(sql))) offenders.push(`${path}: inbound_messages SQL`);
    }
    expect(offenders).toEqual([]);
  });

  it('③ visibleToAgent 는 두 겹이다 — 격리 아님 **그리고** 판정 있음(판정 없음도 격리)', () => {
    const predicate = visibleToAgent('m');
    expect(predicate).toContain('NOT m.quarantined');
    expect(predicate).toContain('m.injection_risk IS NOT NULL');
    expect(() => visibleToAgent('m; DROP TABLE x')).toThrow();
  });

  it('④ 격리 개수는 visibleToAgent 의 여집합에서 **정책 격리를 뺀다** — 소유자가 막은 메일은 존재도 에이전트에게 안 보인다(정책 v2)', () => {
    const predicate = countedAsQuarantine('m');
    expect(predicate).toContain(`NOT ${visibleToAgent('m')}`);
    expect(predicate).toContain("m.quarantine_reason IS DISTINCT FROM 'policy_blocked'");
    expect(() => countedAsQuarantine('m; DROP TABLE x')).toThrow();
  });

  it('⑤ policy_blocked 리터럴은 에이전트 표면·웹훅·MCP·인증코드 추출 소스에 0건이다 — 소유자가 막은 메일은 이름으로도 에이전트 쪽에 없다', () => {
    const files = [...AGENT_SURFACES, ...AGENT_FACING_DIRS.flatMap((dir) => listTsFilesUnder(dir))];
    // 비공허성: 표면 여덟 + 세 디렉터리의 파일들을 실제로 읽는다(디렉터리가 비면 이 단언은 아무것도 보지 않는다).
    for (const dir of AGENT_FACING_DIRS) expect(listTsFilesUnder(dir).length, dir).toBeGreaterThan(0);
    // 양성 대조군: 같은 스캔이 저장소의 격리 개수 술어에서는 그 리터럴을 찾는다 — 스캔이 살아 있다.
    expect(sqlLiterals(file(READ_STORE)).some((literal) => literal.includes('policy_blocked'))).toBe(true);
    const offenders = files.filter((path) => sqlLiterals(file(path)).some((literal) => literal.includes('policy_blocked')));
    expect(offenders).toEqual([]);
  });
});
