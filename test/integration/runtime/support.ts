/**
 * test/integration/runtime/support.ts — runtime 통합 테스트의 공용 도우미(migrate 핸들러 호출).
 */

import type { PoolClient } from 'pg';

import { createMigrateHandler, type MigrationStatus } from '../../../src/runtime/handlers/migrate';
import type { LambdaContext } from '../../../src/runtime/lambda';

export function context(): LambdaContext {
  return { awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:migrate', callbackWaitsForEmptyEventLoop: true };
}

/** migrate `status` 를 **이 클라이언트(열린 트랜잭션)** 위에서 돌린다. */
export async function statusOn(client: PoolClient): Promise<MigrationStatus> {
  const borrowed = { query: client.query.bind(client), release: () => undefined };
  const pool = { connect: () => Promise.resolve(borrowed), end: () => Promise.resolve() };
  const handler = createMigrateHandler({
    owner: () => Promise.resolve({ deps: null, pool: pool as never }),
    bootstrap: () => Promise.reject(new Error('bootstrap 조립이 불리면 안 된다')),
  });
  return (await handler({ action: 'status' }, context())) as MigrationStatus;
}
