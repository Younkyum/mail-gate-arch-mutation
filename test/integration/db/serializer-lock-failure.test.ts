/**
 * **직렬화 실패는 audit 행을 남기고 끝나야 한다** (Principle P3 — 조용한 거부는 없다).
 *
 * `gate.dispatch` 는 `SerializationUnavailableError` **하나만** fail-closed
 * `denied` + `evaluation_error` 로 바꾸고, 나머지 예외는 의도적으로 그대로 올린다
 * (`reserve` 안의 audit INSERT 실패를 삼키면 그게 진짜 조용한 거부이기 때문이다).
 *
 * 그런데 `outbound-serializer` 의 잠금 **획득** 구간 — `pool.connect()` · `BEGIN` ·
 * `pg_advisory_xact_lock` — 은 **날것의 pg 에러**를 던지고 있었다. 즉 가장 현실적인 두
 * 실패가 그 클래스를 위해 만든 경로를 통째로 건너뛰었다:
 *
 *   - **풀 고갈** → `connectionTimeoutMillis` 로 `pool.connect()` 가 죽는다
 *   - **잠금 대기 타임아웃** → `statement_timeout` 으로 `pg_advisory_xact_lock` 이 죽는다
 *
 * 메일 기준으로는 안 나가니 fail-closed 였다. 하지만 **audit 행이 0개**였고, 그러면
 * "왜 안 나갔는가" 는 애플리케이션 로그 밖 어디에도 없다.
 *
 * 이 테스트는 두 번째 경로를 실제로 재현한다: 다른 세션이 같은 조직 잠금을 쥐고 있는
 * 동안 짧은 `statement_timeout` 을 건 풀로 발송을 시도한다. **고치기 전에는 날것의
 * pg 에러가 `handleSend` 밖으로 튀어나오고 audit 행이 0개다.**
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createInMemoryContentStore } from '../../../src/api/content-store';
import type { ApiRequest } from '../../../src/api/http';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import type { OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { handleSend } from '../../../src/api/routes/send';
import {
  ADVISORY_LOCK_NAMESPACE,
  createPostgresAgentTokenStore,
  createPostgresGateStores,
} from '../../../src/db/repositories';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { countingTransport } from '../outbound/support/fakes';
import { closeTestPool, DATABASE_AVAILABLE, newIndependentPool, provisioningPool, seedFixture, testPool } from './support/harness';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';

const RECIPIENT = 'lock-failure-probe@example.com';

/**
 * 잠금 대기가 죽는 데 걸리는 시간. 짧게 잡는 이유는 속도가 아니라 **의도의 명시**다 —
 * 기본값 10초로 두면 이 테스트는 "느린 테스트" 로 보이고, 왜 느린지는 아무 데도 안 적힌다.
 */
const LOCK_WAIT_TIMEOUT_MS = 300;

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('직렬화 실패 — 잠금을 못 잡은 시도도 행을 남긴다', () => {
  it('잠금 대기가 타임아웃되면 denied + evaluation_error 이고, audit 행이 정확히 1개다', async () => {
    const observer = testPool();
    const fixture = await seedFixture(observer, {
      allowlist: [RECIPIENT],
      sendingStartedAt: new Date(),
    });

    const token = issueAgentToken(fixture.agentId);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: token.tokenHash,
      capabilities: token.capabilities,
      expiresAt: null,
    });

    // **경쟁자.** 다른 세션이 같은 조직 잠금을 트랜잭션 동안 쥔다 — 다른 프로세스가
    // 마침 그 조직을 직렬화 중인 상태 그대로다. 네임스페이스는 구현에서 가져온다.
    const holder = await observer.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      ADVISORY_LOCK_NAMESPACE,
      fixture.organizationId,
    ]);

    // 발송 측은 **자기 풀**을 쓴다. 공유 풀에 `statement_timeout` 을 걸면 다른 테스트의
    // 쿼리까지 그 시계 아래로 들어간다.
    const pool = newIndependentPool({ max: 4, statement_timeout: LOCK_WAIT_TIMEOUT_MS });
    const transport = countingTransport();

    try {
      const gateStores = createPostgresGateStores(pool);
      const service: OutboundServiceDependencies = {
        source: gateStores.source,
        audit: gateStores.audit,
        dispatchStore: gateStores.leases,
        serializer: gateStores.serializer,
      sendEvidence: gateStores.sendEvidence,
        messages: createPostgresOutboundMessageStore(pool),
        content: createInMemoryContentStore(),
        leaseTtlSeconds: 300,
        riskSignals: inertRiskSignals(),
        dlp: inertDlp(),
        now: () => new Date(),
      };

      const request: ApiRequest = {
        headers: {
          authorization: `Bearer ${token.plaintext}`,
          'idempotency-key': `lock-failure-${fixture.agentId}`,
        },
        query: {},
        body: {
          agent_id: fixture.agentId,
          from: fixture.address,
          to: [RECIPIENT],
          subject: '잠금을 못 잡았다',
          text: '이 시도는 나가지 않는다',
          cost_cents: 0,
        },
      };

      const response = await handleSend(
        { tokens: createPostgresAgentTokenStore(pool), service, transport },
        request,
      );

      // ① 메일 기준 fail closed — 예전에도 참이었다.
      expect(transport.calls()).toBe(0);

      // ② **결말이 예외가 아니라 판정이다.** 예전에는 날것의 pg 에러가 여기까지 올라왔다.
      expect(response.status).toBe(403);
      expect(response.body['error']).toBe('policy_denied');
      const decision = response.body['decision'] as { readonly reasons: readonly string[] };
      expect(decision.reasons).toContain('evaluation_error');

      // ③ **그리고 행이 남는다** — 이것이 갭의 본체다.
      const audits = await observer.query<{ decision: string; reasons: string[] }>(
        'SELECT decision, reasons FROM audit_logs WHERE agent_id = $1',
        [fixture.agentId],
      );
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0]?.decision).toBe('denied');
      expect(audits.rows[0]?.reasons).toContain('evaluation_error');

      // ④ 정책 스탬프는 비어 있다 — 잠그지 못해 **읽은 적이 없는** 정책이기 때문이다.
      //    DB CHECK `audit_logs_policy_stamp_presence` 가 그 `null` 을 정확히 이 조합
      //    (`denied` + `evaluation_error`)으로만 허용한다.
      const stamp = await observer.query<{ policy_version: number | null; policy_version_id: string | null }>(
        'SELECT policy_version, policy_version_id FROM audit_logs WHERE agent_id = $1',
        [fixture.agentId],
      );
      expect(stamp.rows[0]?.policy_version).toBeNull();
      expect(stamp.rows[0]?.policy_version_id).toBeNull();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await pool.end();
    }
  });
});
