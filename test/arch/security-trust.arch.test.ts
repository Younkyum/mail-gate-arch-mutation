/**
 * Sender Trust 의 선언 전용 신호 — **`src/**` 어디에도 `passport_verified` 신호를 값으로 만드는 코드가 없다**
 * (계획 §4B.4, AC-f1).
 *
 * 왜 arch 층인가: 단위 테스트는 **지금 있는** 수집기(`collectTrustSignals`)가 그 신호를 만들지 않음을
 * 본다. 그러나 §4B.4 가 경계하는 것은 **나중에 다른 파일에 생기는** 순진한 수집기 — inbound 경로에서
 * 원격 DID 문서를 동기 fetch 해 신뢰를 올리는 코드다. 그 파일은 단위 테스트가 모른다. 이 층은
 * 파일을 가리지 않고 `'passport_verified'` 문자열이 **값 위치**에 나타나는 것을 막는다.
 *
 * 허용되는 위치는 둘뿐이다: 타입 위치(유니온 선언)와 `case` 레이블(`computeTrust` 의 거부 분기).
 * 수집기를 정식으로 붙이는 날(P6)은 이 파일을 고치는 날이다 — 그 변경이 조용히 일어나지 않게 하는
 * 것이 이 층의 목적이다.
 *
 * 한계: 템플릿 리터럴·문자열 연결로 이름을 조립하면 못 본다. 그런 코드를 쓰지 마라.
 */

import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind } from 'ts-morph';

import { srcSourceFiles, toRepoRelative } from './support/project';

const DECLARED_ONLY = 'passport_verified';

interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly position: 'type' | 'case' | 'value';
}

function occurrences(): Occurrence[] {
  const out: Occurrence[] = [];
  for (const source of srcSourceFiles()) {
    const file = toRepoRelative(source.getFilePath());
    const literals = [
      ...source.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];
    for (const literal of literals) {
      if (literal.getLiteralValue() !== DECLARED_ONLY) continue;
      const parent = literal.getParent();
      let position: Occurrence['position'] = 'value';
      if (parent !== undefined && Node.isLiteralTypeNode(parent)) position = 'type';
      else if (parent !== undefined && Node.isCaseClause(parent) && parent.getExpression() === literal) position = 'case';
      out.push({ file, line: literal.getStartLineNumber(), position });
    }
  }
  return out;
}

describe('선언 전용 신뢰 신호 (§4B.4)', () => {
  it('src/** 어디에도 passport_verified 신호를 값으로 만드는 코드가 없다', () => {
    const found = occurrences();
    // 비공허성: 검사가 선언 자체를 보고 있어야 한다. 선언을 못 찾으면 이 검사는 아무것도 안 보는 중이다.
    expect(found).toContainEqual(expect.objectContaining({ file: 'src/security/trust-signals.ts', position: 'type' }));
    expect(found.filter((o) => o.position === 'value')).toEqual([]);
  });
});
