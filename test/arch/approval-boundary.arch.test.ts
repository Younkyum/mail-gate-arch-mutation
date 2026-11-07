/**
 * 승인 경계 — **만료·거절은 구조적으로 발송할 수 없다** (계획 §3.4 4조, P2).
 *
 * **주장:** 승인 상태 전이 모듈(`src/approval/service.ts`)·TTL 스위퍼(`src/workers/approval-expiry.ts`)·
 * 그 저장소(`src/db/repositories/approval-store.ts`)의 **전이적 런타임 import 폐포**에 관문
 * (`src/policy/gate.ts`)과 전송단(`src/mail/transport/**`)이 없다.
 *
 * **왜 이 층이 필요한가.** §3.4 4조는 *"타임아웃 기본동작 = 만료. 절대 auto-send 아님 — 설정으로도
 * 열지 않는다"* 이다. 그 명제를 코드 리뷰나 주석이 아니라 **그래프의 성질**로 세운다: 발송은 관문을
 * 통해서만 일어나고(AC-8, Layer B), 만료 경로는 관문에 닿지 않는다. 그러면 만료가 발송을 일으키는
 * 설정·분기·"편의 기능" 은 **이 테스트를 깨지 않고는** 들어올 수 없다.
 *
 * **Layer C 와 무엇이 다른가.** Layer C 는 `approval-expiry.ts` 를 `NON_SENDING_ENTRYPOINTS` 로 보고
 * "관문을 **직접** import 하지 않는다" 를 단언한다. 그런데 스위퍼가 부르는 `approval/service.ts` 가
 * 관문을 import 하면 Layer C 는 초록이다 — 직접 import 가 아니기 때문이다. 이 층이 그 한 단계를 닫는다.
 *
 * **이 층이 못 잡는 것:** 동적 import(`await import(...)`)·문자열 경로, 그리고 **다른 프로세스를
 * 깨우는** 방식(예: 스위퍼가 릴리스 잡을 큐에 넣는 코드). 후자는 import 그래프 밖이다 — 그런 코드가
 * 생기면 그 큐의 소비자가 릴리스 워커이고, 릴리스는 grant(요청이 `approved`)가 없으면 아무것도
 * 쓰지 않는다(`gate.reserveRelease`). 즉 마지막 방어선은 관문 쪽 grant 판정이다.
 *
 * **type-only import 는 따라가지 않는다** — 런타임에 아무것도 부르지 않기 때문이다. 대신 선언
 * 전체가 `import type` 인 것만 건너뛴다(개별 `type` 수식어가 섞인 선언은 런타임 import 로 본다 —
 * 보수적인 쪽이다).
 */

import { describe, expect, it } from 'vitest';
import type { SourceFile } from 'ts-morph';

import { getProject, toRepoRelative } from './support/project';

const GATE_FILE = 'src/policy/gate.ts';
const TRANSPORT_DIR = 'src/mail/transport/';

/** 만료·거절만 하는 모듈들 — 이 폐포에 관문이 있으면 안 된다. */
const NON_SENDING_APPROVAL_MODULES = [
  'src/approval/service.ts',
  'src/workers/approval-expiry.ts',
  'src/db/repositories/approval-store.ts',
  // P2 T1 — 매직링크 결정 경로. **승인은 발송이 아니다**: 라우트는 요청을 approved 로 바꾸고 커밋 뒤
  // 릴리스 잡을 넣을 뿐이고, 보내는 것은 릴리스 워커가 관문을 다시 지나며 한다. 라우트 파일은 Layer C 가
  // 직접 import 를 보지만, 트랜잭션 조립(`approval-link-use-store.ts`)은 `src/db/` 라 Layer C 밖이다 —
  // 그 한 단계 간접을 여기서 닫는다.
  'src/api/routes/approval-link.ts',
  'src/db/repositories/approval-link-use-store.ts',
] as const;

/** 양성 대조군 — 발송하는 워커. 이 폐포에는 관문이 **있어야** 한다(폐포 계산이 살아 있다는 증거). */
const SENDING_CONTROL = 'src/workers/approval-release.ts';

function sourceFileOf(relativePath: string): SourceFile {
  const file = getProject()
    .getSourceFiles()
    .find((candidate) => toRepoRelative(candidate.getFilePath()) === relativePath);
  if (!file) throw new Error(`${relativePath} 를 ts-morph 프로젝트가 로드하지 못했다 — 이 층이 공허해진다.`);
  return file;
}

/** 런타임 import·re-export 를 따라 닿는 `src/**` 파일 전부(자기 자신 포함). */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue: SourceFile[] = [sourceFileOf(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (seen.has(path) || !path.startsWith('src/')) continue;
    seen.add(path);

    for (const declaration of file.getImportDeclarations()) {
      if (declaration.isTypeOnly()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }
    for (const declaration of file.getExportDeclarations()) {
      if (declaration.isTypeOnly()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }
  }
  return seen;
}

function sendingModulesIn(closure: Set<string>): string[] {
  return [...closure].filter((path) => path === GATE_FILE || path.startsWith(TRANSPORT_DIR)).sort();
}

describe('승인 경계 — 만료·거절 경로의 전이적 import 폐포에 관문이 없다 (§3.4 4조)', () => {
  it('양성 대조군: 릴리스 워커의 폐포에는 관문이 있다 — 폐포 계산이 살아 있다', () => {
    // 이 단언이 없으면 아래 단언은 "폐포가 비어서" 초록일 수 있다.
    expect(runtimeClosure(SENDING_CONTROL).has(GATE_FILE)).toBe(true);
  });

  it('폐포가 실제로 여러 파일을 따라간다 — 자기 자신만 담은 폐포는 아무것도 증명하지 않는다', () => {
    const closure = runtimeClosure('src/workers/approval-expiry.ts');
    expect(closure.has('src/approval/service.ts')).toBe(true);
    expect(closure.has('src/policy/policy-loader.ts')).toBe(true);
    // 매직링크 결정의 트랜잭션 조립은 서비스·승인 저장소·웹훅 outbox 까지 닿아야 한다 — 닿지 않으면 위 목록의
    // 그 항목은 파일 하나만 본 것이다. (라우트 자체는 포트를 **주입받으므로** 폐포가 `magic-link.ts` 까지다.)
    const assembly = runtimeClosure('src/db/repositories/approval-link-use-store.ts');
    expect(assembly.has('src/approval/service.ts')).toBe(true);
    expect(assembly.has('src/db/repositories/approval-store.ts')).toBe(true);
    expect(assembly.has('src/db/repositories/webhook-store.ts')).toBe(true);
    expect(runtimeClosure('src/api/routes/approval-link.ts').has('src/approval/magic-link.ts')).toBe(true);
  });

  for (const entry of NON_SENDING_APPROVAL_MODULES) {
    it(`${entry} 의 런타임 import 폐포에 관문·전송단이 없다`, () => {
      expect(sendingModulesIn(runtimeClosure(entry))).toEqual([]);
    });
  }
});
