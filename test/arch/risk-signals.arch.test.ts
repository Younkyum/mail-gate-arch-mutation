/**
 * 위험 신호 경계(ADR-0016 M1) — **위험 신호는 로더를 통해서만 판정에 들어온다**(매니페스트 표지 `humanApprovalRequired` 와 같은 규율).
 *
 *   1. `ApprovalContext.riskHold` 를 채우는 프로덕션 코드는 `src/policy/policy-loader.ts` 하나다 — 별도 포트(`RiskSignalSource`)의 결과를 로더가
 *      해석한다. 라우트·서비스·워커가 이 칸을 만들면 "위험 신호 없음" 을 주장하는 경로가 생긴다.
 *   2. 시도의 DLP 계열(`OutboundAttempt.dlp`)을 적는 프로덕션 코드는 발송 서비스(`src/api/outbound-service.ts` — 서버가 조립한 최종 내용으로 계산)와
 *      승인 릴리스(`src/workers/approval-release.ts` — 빈 목록, grant 가 위험 판정을 건너뛴다) 둘이다. 요청 본문 파서는 그런 키를 읽지 않는다.
 *   3. 판정 쪽(`rules/risk-hold.ts` · `rules/outbound-mode.ts` · `risk-signals.ts`)의 런타임 import 폐포에 DB 저장소가 없다 — 판정은 순수하고, 읽기는
 *      포트 구현(`db/repositories/risk-signal-store.ts`) 하나가 한다. 그 구현을 만드는 프로덕션 파일은 조립 루트(`runtime/composition.ts`)뿐이다.
 *   4. 운영자 킬 스위치는 env 하나다 — `RISK_HOLD_ENFORCE_ENV` 를 읽는 프로덕션 코드는 조립 루트(`RUNTIME_ENV.riskHoldEnforce`)뿐이고, 소유자·에이전트
 *      쪽 표면(콘솔 · 정책 jsonb · 요청 본문)에 그 이름이 없다.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { getProject, srcSourceFiles, toRepoRelative } from './support/project';

function relative(file: SourceFile): string {
  return toRepoRelative(file.getFilePath());
}

/** 객체 리터럴의 속성 대입 `name: …`(단축형 `name` 포함)이 있는 프로덕션 파일. */
function filesAssigning(name: string, filter: (literalText: string) => boolean = () => true): string[] {
  const out = new Set<string>();
  for (const file of srcSourceFiles()) {
    for (const literal of file.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const hit = literal.getProperties().some((property) => {
        if (property.isKind(SyntaxKind.PropertyAssignment) || property.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
          return property.getName() === name;
        }
        return false;
      });
      if (hit && filter(literal.getText())) out.add(relative(file));
    }
  }
  return [...out].sort();
}

function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const start = getProject()
    .getSourceFiles()
    .find((file) => relative(file) === entry);
  if (start === undefined) throw new Error(`${entry} 를 찾지 못했다 — 이 층이 공허해진다.`);
  const queue: SourceFile[] = [start];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = relative(file);
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

describe('위험 신호 경계 — 로더를 통해서만(ADR-0016)', () => {
  it('ApprovalContext.riskHold 를 채우는 프로덕션 파일은 정책 로더 하나다', () => {
    // `riskHold:` 와 `humanApprovalRequired:` 가 함께 있는 리터럴 = ApprovalContext. 다른 `riskHold` 이름(알림 보기 등)은 대상이 아니다.
    expect(filesAssigning('riskHold', (text) => text.includes('humanApprovalRequired'))).toEqual(['src/policy/policy-loader.ts']);
  });

  it('시도의 dlp 계열을 적는 프로덕션 파일은 발송 서비스와 승인 릴리스 둘이다 · 요청 파서는 그런 키를 읽지 않는다', () => {
    // `dlp:` 와 `contentShape:` 가 함께 있는 리터럴 = OutboundAttempt.
    // 로더는 옮기기만 한다(닫힌 집합으로 정규화 — 모르는 값은 scan_limit).
    expect(filesAssigning('dlp', (text) => text.includes('contentShape'))).toEqual([
      'src/api/outbound-service.ts',
      'src/policy/policy-loader.ts',
      'src/workers/approval-release.ts',
    ]);
    for (const parser of ['src/api/outbound-http.ts', 'src/mcp/tools.ts']) {
      const file = srcSourceFiles().find((candidate) => relative(candidate) === parser);
      expect(file, parser).toBeDefined();
      const literals = (file?.getDescendantsOfKind(SyntaxKind.StringLiteral) ?? []).map((node) => node.getLiteralValue());
      for (const forbidden of ['dlp', 'risk_hold', 'riskHold', 'tainted', 'risk_signals']) expect(literals, `${parser} · ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('예약 고정 위험(pinnedRisk)은 예약 발송 워커만 · 결정론적 DLP(extraDlp)는 전달 라우트만 싣는다(리뷰 H1·H3)', () => {
    expect(filesAssigning('pinnedRisk')).toEqual(['src/workers/scheduled-sender.ts']);
    expect(filesAssigning('extraDlp')).toEqual(['src/api/routes/forward.ts']);
    expect(filesAssigning('pinnedTaint', (text) => text.includes('contentShape'))).toEqual([
      'src/api/outbound-service.ts',
      'src/policy/policy-loader.ts',
      'src/workers/approval-release.ts',
    ]);
  });

  it('판정 쪽 런타임 폐포에 DB 저장소가 없다 · 위험 신호 포트 구현을 만드는 프로덕션 파일은 조립 루트뿐이다', () => {
    for (const entry of ['src/policy/rules/risk-hold.ts', 'src/policy/rules/outbound-mode.ts', 'src/policy/risk-signals.ts']) {
      const reached = [...runtimeClosure(entry)].filter((path) => path.startsWith('src/db/'));
      // `db/schema.ts` 는 열거형·상수만(타입의 근원) — 저장소(`db/repositories/**`)·클라이언트가 없어야 한다.
      expect(reached.filter((path) => path !== 'src/db/schema.ts'), entry).toEqual([]);
    }
    const constructors = srcSourceFiles()
      .filter((file) => relative(file) !== 'src/db/repositories/risk-signal-store.ts')
      .filter((file) =>
        file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => call.getExpression().getText() === 'createPostgresRiskSignalSource'),
      )
      .map(relative);
    expect(constructors).toEqual(['src/runtime/composition.ts']);
  });

  it('킬 스위치 env 는 조립 루트만 읽는다 — 콘솔·정책·요청 표면에 그 이름이 없다', () => {
    // 이름을 **코드로** 적는 곳(주석은 대상이 아니다): 문자열 리터럴 `ATMARK_RISK_HOLD_ENFORCE` · `RUNTIME_ENV.riskHoldEnforce` 접근.
    const named = srcSourceFiles()
      .filter(
        (file) =>
          file.getDescendantsOfKind(SyntaxKind.StringLiteral).some((node) => node.getLiteralValue() === 'ATMARK_RISK_HOLD_ENFORCE') ||
          file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((node) => node.getText() === 'RUNTIME_ENV.riskHoldEnforce'),
      )
      .map(relative)
      .sort();
    expect(named).toEqual(['src/policy/risk-signals.ts', 'src/runtime/composition.ts', 'src/runtime/config.ts']);
  });
});
