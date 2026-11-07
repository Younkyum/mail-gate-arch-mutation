/**
 * 인증코드 추출 경계 — **받은 메일에서 뽑은 값은 자동 행동의 입구가 되지 않는다** (메일 기본기 A1 · AC-A1-7, 2026-09-26).
 *
 * **주장:** 관문·정책(`src/policy/**`)·발송 서비스(`src/api/outbound-service.ts`)·승인(`src/approval/**`)·워커(`src/workers/**`)의
 * **전이적 런타임 import 폐포**에 인증코드 추출 모듈(`src/mail/verification/**`)이 없다.
 *
 * **왜 이 층이 필요한가.** 추출 결과(코드·확인 링크)는 조회 라우트가 에이전트에게 돌려주는 **데이터**다(원칙 2 — 받은 내용으로 자동
 * 행동하지 않는다). ADR-0005 의 `auto_approve_verification_senders` 는 OFF 이고, 이 층은 그 문을 코드 쪽에서 닫는다: 정책이 "인증 메일이면
 * 허용", 승인이 "코드가 있으면 자동 승인", 워커가 "확인 링크를 연다" 같은 편의는 이 모듈을 import 해야 하고, 그러면 여기서 빨갛다.
 *
 * **못 잡는 것:** 동적 import·문자열 경로, 그리고 추출 규칙을 **복사해** 옮긴 코드(import 가 없다). 후자는 리뷰의 몫이다.
 *
 * type-only import 는 따라가지 않는다(`approval-boundary` 와 같은 폐포 계산 — 런타임에 아무것도 부르지 않는다).
 */

import { describe, expect, it } from 'vitest';
import type { SourceFile } from 'ts-morph';

import { getProject, listTsFilesUnder, toRepoRelative } from './support/project';

const VERIFICATION_DIR = 'src/mail/verification/';

/** 추출 결과가 닿으면 안 되는 쪽 — 결정(정책·관문)·발송·승인·백그라운드 행동. */
const FORBIDDEN_ENTRIES = [
  ...listTsFilesUnder('src/policy'),
  'src/api/outbound-service.ts',
  ...listTsFilesUnder('src/approval'),
  ...listTsFilesUnder('src/workers'),
];

function sourceFileOf(relativePath: string): SourceFile {
  const file = getProject()
    .getSourceFiles()
    .find((candidate) => toRepoRelative(candidate.getFilePath()) === relativePath);
  if (!file) throw new Error(`${relativePath} 를 ts-morph 프로젝트가 로드하지 못했다 — 이 층이 공허해진다.`);
  return file;
}

/** 런타임 import·re-export 를 따라 닿는 `src/**` 파일 전부(시작점 포함). */
function runtimeClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: SourceFile[] = entries.map(sourceFileOf);
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (seen.has(path) || !path.startsWith('src/')) continue;
    seen.add(path);
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      if (declaration.isTypeOnly()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }
  }
  return seen;
}

describe('인증코드 추출 경계 — 관문·정책·발송·승인·워커의 폐포에 src/mail/verification 이 없다 (AC-A1-7)', () => {
  it('비공허성: 추출 모듈 디렉터리와 금지 시작점이 실제로 있고, 폐포가 관문·저장소까지 뻗는다', () => {
    expect(listTsFilesUnder(VERIFICATION_DIR).length).toBeGreaterThan(0);
    expect(FORBIDDEN_ENTRIES.length).toBeGreaterThan(20);
    const closure = runtimeClosure(FORBIDDEN_ENTRIES);
    // 폐포가 시작점 밖으로 실제로 뻗는다 — 워커가 관문을, 정책 로더가 저장소를 부른다.
    expect(closure.has('src/policy/gate.ts')).toBe(true);
    expect([...closure].some((path) => path.startsWith('src/db/repositories/'))).toBe(true);
    // 그리고 `src/mail/` 안으로도 들어간다 — 추출 모듈의 이웃(MIME·스레드)에 닿는 폐포가 추출 모듈만 비켜 간다는 것이 주장이다.
    expect([...closure].some((path) => path.startsWith('src/mail/') && !path.startsWith(VERIFICATION_DIR))).toBe(true);
  });

  it('금지 시작점들의 런타임 import 폐포에 인증코드 추출 모듈(src/mail/verification/**)이 0개다', () => {
    const reached = [...runtimeClosure(FORBIDDEN_ENTRIES)].filter((path) => path.startsWith(VERIFICATION_DIR)).sort();
    expect(reached).toEqual([]);
  });
});
