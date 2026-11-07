/**
 * §6 P1c Acceptance — **프로비저닝이 Agent·Keypair 를 같은 트랜잭션에서 만들거나 둘 다 안 만든다.**
 *
 * `test/unit/identity/provisioning.test.ts` 는 더블 위에서 **순서**를 단언한다. 이 파일은
 * 그 더블이 흉내 내는 계약 — *"콜백이 던지면 전부 롤백된다"* — 이 **실제 Postgres 에서
 * 성립하는가**를 단언한다. 그 계약이 거짓이면 `provisioning.ts` 의 모든 주장이 거짓이 되고,
 * §4B.1 이 없애려는 소급 발급 경로가 **부분 성공한 에이전트의 형태로** 다시 생긴다
 * (키 없는 에이전트가 남으면, 그 에이전트에 키를 붙이는 코드가 결국 필요해진다).
 */

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createPostgresProvisioningStore } from '../../../src/api/provisioning-store';
import {
  provisionAgent,
  type ProvisioningStore,
  type ProvisioningTransaction,
} from '../../../src/identity/provisioning';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, testPool } from '../db/support/harness';

function devCustody(): { custody: ReturnType<typeof createLocalDevKeyCustody>; directory: string } {
  // OS 임시 디렉터리. 기본값(`.atmark-dev-keys/`)으로 두면 테스트가 리포에 키 파일을 남긴다.
  const directory = mkdtempSync(join(tmpdir(), 'atmark-keys-'));
  return { custody: createLocalDevKeyCustody({ directory, env: {} }), directory };
}

function request(suffix: string) {
  return {
    // **조직도 이 트랜잭션에서 태어난다.** 롤백 판정을 조직 이름으로 할 수 있는 이유다 —
    // 롤백되면 조직 행도 없다.
    organization: { kind: 'create' as const, name: `pp-a-${suffix}`, ownerEmail: 'owner@example.com' },
    agentName: `pp-a-agent-${suffix}`,
    addressLocalPart: `pp-a-${suffix}`,
    seedContacts: ['jinyounkyum@gmail.com'],
    monthlyBudgetCents: 1000,
    createdBy: 'test:pp-a',
    tokenCapabilities: null,
    // 기본값(`approval_required`) — 원자성 테스트가 seed 관계 INSERT 까지 같은 트랜잭션으로 덮는다.
    outboundMode: null,
  };
}

describe.skipIf(!DATABASE_AVAILABLE)('PP-A 원자성 (§4B.1)', () => {
  afterAll(closeTestPool);

  it('에이전트·keypair·draft passport 가 한 트랜잭션에서 함께 커밋된다', async () => {
    const { custody, directory } = devCustody();
    const suffix = randomBytes(4).toString('hex');

    const provisioned = await provisionAgent(
      createPostgresProvisioningStore(provisioningPool()),
      request(suffix),
      custody,
    );
    const agentId = provisioned.agent.id;

    const keypair = await testPool().query<{
      public_key: string;
      algorithm: string;
      key_ref: string;
    }>('SELECT public_key, algorithm, key_ref FROM agent_keypairs WHERE agent_id = $1', [agentId]);

    expect(keypair.rows).toHaveLength(1);
    expect(keypair.rows[0]?.algorithm).toBe('ed25519');
    // 원시 32바이트의 base64url = JWK 의 x. DB CHECK 가 같은 형식을 요구한다.
    expect(keypair.rows[0]?.public_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // **DB 에 들어간 것은 참조뿐이다** (§3.5 AC-e1).
    expect(keypair.rows[0]?.key_ref).toBe(`devfile://${agentId}`);

    const passport = await testPool().query<{
      did: string;
      status: string;
      controller: string;
      version: number;
      metadata_uri: string | null;
      content_hash: string | null;
      superseded_at: Date | null;
    }>(
      `SELECT did, status, controller, version, metadata_uri, content_hash, superseded_at
         FROM passports WHERE agent_id = $1`,
      [agentId],
    );

    expect(passport.rows).toHaveLength(1);
    expect(passport.rows[0]?.did).toBe(`did:web:id.atmark.ai:agents:${agentId}`);
    // **PP-A 가 만드는 것은 draft 뿐이다** — 서빙·서명은 P6 (§4B.2).
    expect(passport.rows[0]?.status).toBe('draft');
    expect(passport.rows[0]?.controller).toBe('did:web:id.atmark.ai');
    expect(passport.rows[0]?.version).toBe(1);
    // 문서가 없으므로 해시도 URI 도 없다. 컬럼만 **지금** 존재한다(§4B.1 r3).
    expect(passport.rows[0]?.metadata_uri).toBeNull();
    expect(passport.rows[0]?.content_hash).toBeNull();
    expect(passport.rows[0]?.superseded_at).toBeNull();

    // 에이전트는 active 인데 passport 는 draft — 축이 다르다(§4B.3 r4).
    expect(provisioned.agent.status).toBe('active');

    // 개인키는 custody 안에만 있다. 파일 하나이고 이름은 agentId 다.
    expect(readdirSync(directory)).toEqual([`${agentId}.pkcs8`]);
  });

  it('프로비저닝마다 새 keypair 다 — 두 에이전트가 같은 공개키를 갖지 않는다', async () => {
    const store = createPostgresProvisioningStore(provisioningPool());
    const first = await provisionAgent(store, request(randomBytes(4).toString('hex')), devCustody().custody);
    const second = await provisionAgent(store, request(randomBytes(4).toString('hex')), devCustody().custody);

    const keys = await testPool().query<{ agent_id: string; public_key: string }>(
      'SELECT agent_id, public_key FROM agent_keypairs WHERE agent_id = ANY($1::char(32)[])',
      [[first.agent.id, second.agent.id]],
    );
    expect(keys.rows).toHaveLength(2);
    expect(new Set(keys.rows.map((row) => row.public_key)).size).toBe(2);
  });

  it('키 삽입 뒤에 실패하면 **에이전트도 조직도 남지 않는다** (둘 다 생성되지 않는다)', async () => {
    const base = createPostgresProvisioningStore(provisioningPool());
    const suffix = randomBytes(4).toString('hex');

    // keypair·passport 가 이미 삽입된 **뒤**의 지점에서 던진다. 여기서 롤백이 새면
    // "키는 붙었는데 주소·정책이 없는 에이전트" 가 남고, 그것이 조용히 망가진 에이전트다.
    const failing: ProvisioningStore = {
      withTransaction(run) {
        return base.withTransaction((tx: ProvisioningTransaction) =>
          run({
            ...tx,
            insertAgentToken: () => Promise.reject(new Error('injected failure after PP-A')),
          }),
        );
      },
    };

    await expect(provisionAgent(failing, request(suffix), devCustody().custody)).rejects.toThrow(
      'injected failure after PP-A',
    );

    const org = await testPool().query('SELECT id FROM organizations WHERE name = $1', [
      `pp-a-${suffix}`,
    ]);
    expect(org.rows).toHaveLength(0);

    // 주소 유니크 인덱스가 전역이므로, 롤백이 샜다면 같은 주소로 다시 프로비저닝할 수 없다.
    // 즉 아래가 성공한다는 것 자체가 앞의 시도가 흔적을 남기지 않았다는 증거다.
    const retried = await provisionAgent(base, request(suffix), devCustody().custody);
    expect(retried.address.address).toBe(`pp-a-${suffix}@atmark.ai`);
  });

  it('custody 가 실패하면 keypair 행도 에이전트도 만들어지지 않는다', async () => {
    const suffix = randomBytes(4).toString('hex');
    const brokenCustody = {
      kind: 'local-dev' as const,
      store: () => Promise.reject(new Error('custody unavailable')),
    };

    await expect(
      provisionAgent(createPostgresProvisioningStore(provisioningPool()), request(suffix), brokenCustody),
    ).rejects.toThrow('custody unavailable');

    const org = await testPool().query('SELECT id FROM organizations WHERE name = $1', [
      `pp-a-${suffix}`,
    ]);
    expect(org.rows).toHaveLength(0);
  });

  it('보관이 DB INSERT 보다 먼저다 — 롤백은 **고아 비밀**을 남기고 그 반대는 없다', async () => {
    // 이 비대칭이 의도다(`keypair.ts` 머리말). 반대 순서의 실패 모드는 "참조는 커밋됐는데
    // 그 자리에 아무것도 없는 행" 이고, 그 행은 불변 트리거 때문에 고칠 수도 없다.
    // 여기서 남는 것은 **아무도 참조하지 않는 키 파일 하나**다.
    const { custody, directory } = devCustody();
    const suffix = randomBytes(4).toString('hex');
    const base = createPostgresProvisioningStore(provisioningPool());

    const failing: ProvisioningStore = {
      withTransaction(run) {
        return base.withTransaction((tx: ProvisioningTransaction) =>
          run({
            ...tx,
            insertAgentKeypair: () => Promise.reject(new Error('injected failure at insertAgentKeypair')),
          }),
        );
      },
    };

    await expect(provisionAgent(failing, request(suffix), custody)).rejects.toThrow(
      'injected failure at insertAgentKeypair',
    );

    // DB 에는 아무것도 없다.
    const org = await testPool().query('SELECT id FROM organizations WHERE name = $1', [
      `pp-a-${suffix}`,
    ]);
    expect(org.rows).toHaveLength(0);
    // 그런데 보관소에는 파일이 하나 있다 — 그 사실을 숨기지 않고 단언한다.
    expect(readdirSync(directory)).toHaveLength(1);
  });
});
