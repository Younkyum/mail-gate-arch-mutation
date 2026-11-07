/**
 * src/db/repositories/rows.ts — pg 결과를 `src/db/schema.ts` 의 행 타입으로 좁히는 **한 지점**.
 *
 * `QueryResultRow` 는 `{ [column: string]: any }` 라 어떤 인터페이스와도 구조적으로
 * 맞물리지 않는다. 캐스팅이 필요한데, 그 캐스팅이 리포지토리마다 흩어지면 각자
 * 조금씩 다른 가정을 하게 된다(어떤 파일은 `?? null`, 어떤 파일은 `?? undefined`).
 * **규약은 하나다: NULL 가능 컬럼은 `T | null`** (`schema.ts` 머리말). 캐스팅 지점을
 * 여기 하나로 묶어 그 규약이 지켜지는 곳을 한 파일로 만든다.
 */

import type { Queryable } from '../client';

/**
 * 조회 결과를 `T[]` 로 읽는다.
 *
 * **런타임 검증을 하지 않는 것이 의도다.** 컬럼의 형태는 마이그레이션의 CHECK 제약과
 * NOT NULL 이 이미 집행하고 있고, 여기서 한 번 더 검사하면 "어느 쪽이 진짜 규칙인가"가
 * 둘로 갈라진다. 형태가 규약과 다를 수 있는 유일한 값(`agents.id` 의 브랜드)만
 * 호출자가 `toAgentId` 로 승격한다.
 */
export async function selectRows<T>(db: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await db.query(text, values);
  return result.rows as T[];
}

/** 0행이면 `null`. "없음"의 의미는 호출자가 정한다 — 여기서 던지면 의미가 하나로 고정된다. */
export async function selectRow<T>(db: Queryable, text: string, values: unknown[] = []): Promise<T | null> {
  const [row] = await selectRows<T>(db, text, values);
  return row ?? null;
}
