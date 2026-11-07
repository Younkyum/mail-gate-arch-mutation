/**
 * **모든 받은 메일은 인젝션 필터를 지난다**(진윤겸 결정 2026-10-08 — ADR-0016 개정 "받기 등급"). 코드 모양으로 못 박는다. 런타임 층은
 * `test/integration/inbound/watch-levels.test.ts` ①(메일마다 스캐너 한 번 · 에이전트 둘 · 우회 · 정책 차단이어도 모든 행에 판정)과 DB 트리거
 * `inbound_messages_require_scan`(스캔 없는 INSERT 불가 — `inbound-scan.test.ts`).
 *
 *   ① 수신 소비자의 에이전트 몫(`consumeAgentRecipients`)에서 `scanInbound(...)` 는 **정확히 한 번**, 함수 본문의 **최상위 문장**이다(if · 반복 · try
 *      안이 아니다 — 어떤 가지도 그것을 건너뛸 수 없다). 그리고 에이전트별 반복(`for … of pending`)보다 **앞**이다.
 *   ② 메일 행을 쓰는 호출(`recordMessage(`)은 이 파일에 하나뿐이고 그 스캔 **뒤**, 같은 함수 안이다. 기록되는 레코드는 `scan: scan.record` 를 싣는다.
 *   ③ `scanInbound` 는 주입된 스캐너(또는 기본 `scanForInjection`)를 부른다 — 던지거나 모양이 틀리면 판정 없음(격리)으로 끝난다(값으로, 건너뛰지 않는다).
 *   ④ 신뢰 발신자 우회(`watchRecordOf`)는 스캔 **결과**를 입력으로 받는다 — 스캔을 대신하지 않는다.
 */

import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type FunctionDeclaration, type SourceFile } from 'ts-morph';

import { getProject, toRepoRelative } from './support/project';

const CONSUMER = 'src/workers/inbound-consumer.ts';

function consumer(): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((f) => toRepoRelative(f.getFilePath()) === CONSUMER);
  if (found === undefined) throw new Error(`파일이 없다: ${CONSUMER}`);
  return found;
}

function fn(name: string): FunctionDeclaration {
  return consumer().getFunctionOrThrow(name);
}

describe('모든 받은 메일은 인젝션 필터를 지난다 (정적)', () => {
  it('① 에이전트 몫의 스캔은 정확히 한 번 · 함수 최상위 문장 · 에이전트 반복 앞', () => {
    const body = fn('consumeAgentRecipients').getBodyOrThrow();
    const calls = body.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => call.getExpression().getText() === 'scanInbound');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('scanInbound 호출이 없다');
    // 호출을 품은 문장이 함수 본문 블록의 직계 자식이다(조건 · 반복 · try 가지 안이 아니다).
    // 가장 가까운 문장(변수 선언문)의 부모가 본문 블록 자체여야 한다 — if · 반복 · try 블록 안이면 부모가 그 블록이다.
    const statement = call.getFirstAncestor((node) => Node.isStatement(node));
    expect(statement?.getParent() === body, 'scanInbound 는 함수 본문의 최상위 문장이어야 한다').toBe(true);
    const loop = body
      .getDescendantsOfKind(SyntaxKind.ForOfStatement)
      .find((statementNode) => statementNode.getExpression().getText() === 'pending');
    expect(loop, '에이전트 반복(for … of pending)').toBeDefined();
    expect(call.getStart()).toBeLessThan(loop?.getStart() ?? -1);
  });

  it('② 메일 행 기록은 하나뿐이고 스캔 뒤 · 레코드는 스캔 결과를 싣는다', () => {
    const file = consumer();
    const records = file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => /\.recordMessage$/.test(call.getExpression().getText()));
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error('recordMessage 호출이 없다');
    expect(record.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName()).toBe('consumeAgentRecipients');
    const scan = fn('consumeAgentRecipients')
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((call) => call.getExpression().getText() === 'scanInbound');
    expect((scan?.getStart() ?? Infinity) < record.getStart()).toBe(true);
    const literal = fn('consumeAgentRecipients')
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((declaration) => declaration.getName() === 'record' && declaration.getTypeNode()?.getText() === 'InboundMessageRecord');
    const property = literal?.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression)?.getProperty('scan');
    expect(property?.getText()).toBe('scan: scan.record');
  });

  it('③ scanInbound 는 스캐너를 부르고, 실패는 값(판정 없음)으로 끝난다', () => {
    const scanInbound = fn('scanInbound');
    expect(scanInbound.getBodyOrThrow().getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => call.getExpression().getText() === 'scanner')).toBe(true);
    expect(scanInbound.getText()).toContain("failed('scanner_threw'");
    expect(fn('consumeAgentRecipients').getText()).toContain('deps.scanner ?? scanForInjection');
  });

  it('④ 우회 판정은 스캔 결과를 입력으로 받는다(스캔을 대신하지 않는다)', () => {
    const watch = fn('watchRecordOf');
    expect(watch.getParameters()[0]?.getTypeNode()?.getText()).toBe('InboundScanRecord');
    const callSite = fn('consumeAgentRecipients')
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((call) => call.getExpression().getText() === 'watchRecordOf');
    expect(callSite?.getArguments()[0]?.getText()).toBe('scan.record');
  });
});
