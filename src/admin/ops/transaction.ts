/**
 * src/admin/ops/transaction.ts — 열린 트랜잭션을 `Pool` 모양으로. 관리 API 는 행위와 감사를 한 트랜잭션에 넣고
 * (`admin/context.ts` `audited`), 프로비저닝은 조직당 상한 검사와 삽입을 한 트랜잭션에 넣는다(`ops/agents.ts`).
 * 둘 다 **풀을 받는 기존 함수**(CLI 와 공유)를 고치지 않고 그 트랜잭션 안에서 부르기 위한 것이다.
 */

import type { Pool, PoolClient } from 'pg';

let savepointSequence = 0;

/** 트랜잭션 제어 문장의 분류. `null` 이면 트랜잭션 제어가 아니다(그대로 보낸다). */
type TransactionControl =
  | { readonly kind: 'begin' | 'commit' | 'rollback' }
  | { readonly kind: 'reject'; readonly reason: string };

/** 문장 머리의 주석을 걷는다(`-- …` 줄 주석 · `/* … *\/` 블록 주석). */
function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      rest = end === -1 ? '' : rest.slice(end + 1).trimStart();
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2).trimStart();
    } else {
      return rest;
    }
  }
}

/** 한 문장(`;` 없이)의 단어들 — 대문자, 공백 정규화. */
function wordsOf(statement: string): string[] {
  return stripLeadingComments(statement).toUpperCase().split(/\s+/).filter((word) => word !== '');
}

/** 첫 단어가 트랜잭션 제어(또는 그 설정)인가. */
const CONTROL_HEADS = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'PREPARE']);

function classifyStatement(words: readonly string[]): TransactionControl | null {
  const [head, ...rest] = words;
  if (head === undefined) return null;
  const tail = rest.join(' ');
  if (head === 'SET' && (rest[0] === 'TRANSACTION' || (rest[0] === 'SESSION' && rest[1] === 'CHARACTERISTICS'))) {
    return { kind: 'reject', reason: '트랜잭션 특성 변경' };
  }
  if (!CONTROL_HEADS.has(head)) return null;
  // `ROLLBACK TO [SAVEPOINT] x` 는 바깥 트랜잭션을 끝내지 않는다 — 그대로 보낸다.
  if (head === 'ROLLBACK' && (rest[0] === 'TO' || (rest[0] !== undefined && ['WORK', 'TRANSACTION'].includes(rest[0]) && rest[1] === 'TO'))) {
    return null;
  }
  // `PREPARE name AS …` 는 준비된 문장이다(트랜잭션 제어 아님). `PREPARE TRANSACTION` 만 제어다.
  if (head === 'PREPARE') return rest[0] === 'TRANSACTION' ? { kind: 'reject', reason: '2단계 커밋' } : null;
  const bare = tail === '' || tail === 'WORK' || tail === 'TRANSACTION';
  if (head === 'BEGIN') return bare ? { kind: 'begin' } : { kind: 'reject', reason: `옵션이 붙은 BEGIN(${tail})` };
  if (head === 'START') {
    return tail === 'TRANSACTION' ? { kind: 'begin' } : { kind: 'reject', reason: `옵션이 붙은 START(${tail})` };
  }
  if (head === 'COMMIT' || head === 'END') {
    return bare ? { kind: 'commit' } : { kind: 'reject', reason: `옵션이 붙은 ${head}(${tail})` };
  }
  // ROLLBACK · ABORT
  return bare ? { kind: 'rollback' } : { kind: 'reject', reason: `옵션이 붙은 ${head}(${tail})` };
}

/**
 * 쿼리 텍스트 → 트랜잭션 제어 분류. 문자열·QueryConfig(`{ text }`) 둘 다 여기로 온다.
 *
 *   - 앞뒤 공백·머리 주석·끝의 `;` 를 걷고 대소문자를 가리지 않는다(`'COMMIT;'`·`'commit'`·`'  End  '`).
 *   - `BEGIN [WORK|TRANSACTION]`·`START TRANSACTION` → begin · `COMMIT|END [WORK|TRANSACTION]` → commit ·
 *     `ROLLBACK|ABORT [WORK|TRANSACTION]` → rollback. `ROLLBACK TO …` 는 제어가 아니다(바깥을 끝내지 않는다).
 *   - 옵션이 붙은 것(격리 수준·`READ ONLY`·`AND CHAIN`·`PREPARED`)·`PREPARE TRANSACTION`·`SET TRANSACTION`·
 *     `SET SESSION CHARACTERISTICS` 는 거부한다 — 세이브포인트로 옮길 수 없고, 조용히 약해지는 대신 던진다.
 *   - **여러 문장**(`;` 로 이어진)에 트랜잭션 제어가 하나라도 있으면 거부한다(`'INSERT …; COMMIT'`). 따옴표 안의 `;` 도
 *     나누어 보므로 드물게 과하게 거부할 수 있다 — 안전 방향이다.
 */
export function classifyTransactionControl(text: string): TransactionControl | null {
  const statements = text
    .split(';')
    .map((part) => wordsOf(part))
    .filter((words) => words.length > 0);
  if (statements.length === 0) return null;
  const classified = statements.map(classifyStatement);
  if (statements.length > 1) {
    return classified.some((entry) => entry !== null)
      ? { kind: 'reject', reason: '여러 문장 안의 트랜잭션 제어' }
      : null;
  }
  return classified[0] ?? null;
}

/** `query` 의 첫 인자에서 SQL 텍스트를 꺼낸다 — 문자열이거나 `{ text }`(QueryConfig·Submittable). */
function textOf(first: unknown): string | null {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'text' in first) {
    const text = (first as { text: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * 열린 트랜잭션 하나를 `Pool` 모양으로 — 풀을 받는 연산(`src/admin/ops/**`·`createAc0Gate`·프로비저닝 저장소·
 * `recordSenderMark`)을 **감사 행과 같은 트랜잭션** 안에서 부르기 위해. CLI 는 같은 연산을 진짜 풀로 부른다(그대로).
 *
 *   - `query` 는 그 커넥션 위에서 돈다.
 *   - `connect()` 는 같은 커넥션을 준다(`release` 는 아무것도 안 한다). 그 위의 트랜잭션 제어는
 *     `SAVEPOINT`·`RELEASE`·`ROLLBACK TO` 로 바뀐다 — 안쪽 `withTransaction` 이 바깥 트랜잭션을 **커밋해 버리지 않게**.
 *     안쪽이 실패하면 예외가 바깥까지 올라와 전부 롤백된다. 판정은 `classifyTransactionControl` 하나다(문자열·
 *     QueryConfig 모두, 대소문자·공백·끝 `;` 무관 — 2차 검증 M-A: `{ text: 'COMMIT' }`·`'COMMIT;'` 가 바깥을 커밋했다).
 *   - 풀 모양의 `query`(커넥션을 빌리지 않는 쪽)에서는 트랜잭션 제어를 **전부 거부**한다 — 진짜 풀에서 그 문장은 매번 다른
 *     커넥션으로 가므로 의미가 없고, 여기서는 바깥 트랜잭션을 끝낸다.
 */
export function transactionPool(client: PoolClient): Pool {
  const run = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  const open: string[] = [];

  const poolQuery = (...args: unknown[]): Promise<unknown> => {
    const text = textOf(args[0]);
    if (text !== null && classifyTransactionControl(text) !== null) {
      return Promise.reject(new Error(`감사 트랜잭션 안에서 풀 query 로 트랜잭션 제어를 보낼 수 없다: ${text.slice(0, 60)}`));
    }
    return run(...args);
  };

  const nested = {
    query(...args: unknown[]): Promise<unknown> {
      const text = textOf(args[0]);
      const control = text === null ? null : classifyTransactionControl(text);
      if (control === null) return run(...args);
      if (control.kind === 'reject') {
        return Promise.reject(new Error(`감사 트랜잭션 안에서 보낼 수 없는 트랜잭션 제어(${control.reason}): ${String(text).slice(0, 60)}`));
      }
      if (control.kind === 'begin') {
        savepointSequence += 1;
        const name = `admin_audited_${String(savepointSequence)}`;
        open.push(name);
        return run(`SAVEPOINT ${name}`);
      }
      const name = open.pop();
      if (name === undefined) return Promise.reject(new Error(`열린 세이브포인트 없이 ${control.kind.toUpperCase()}`));
      return run(control.kind === 'commit' ? `RELEASE SAVEPOINT ${name}` : `ROLLBACK TO SAVEPOINT ${name}`);
    },
    release(): void {},
  };
  return { query: poolQuery, connect: () => Promise.resolve(nested) } as unknown as Pool;
}
