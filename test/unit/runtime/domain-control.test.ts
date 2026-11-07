/**
 * `atmark-domain-control`(ADR-0014 결정 3·4 · 계획 §3.5 C1) — 가짜 SES 제어면 · 가짜 DNS · 가짜 RDAP 로 본다.
 *
 *   - **엄격 파싱**: 키 집합이 정확히 계약(`principal` 같은 칸이 끼면 배치 전체를 던진다) · 도메인은 고객 도메인 판정을 다시 지난다 · 배치 상한.
 *   - **Principal 은 환경변수로만**: `SENDER_ROLE_ARN` 모양·길이 밖이면 기동하지 않는다 · 정책 문서의 Principal 이 그 값이다.
 *   - **변형 전 태그 대조**: 태그가 다른 행(또는 없음)이면 SES 변형 호출 0(가짜 SES 가 센다) — 사가 `identity_owned_elsewhere`(그 태그),
 *     제거·동기화·감사 `not_owner`. `AlreadyExists` 는 태그가 이 행이거나 `supersededRowId` 일 때만 채택(태그를 이 행으로 바꾼다).
 *   - **`too_large` 면 기존 정책을 건드리지 않는다** · 주소 목록 뜻 위반은 `rejected_input`(SES 호출 0).
 *   - 결과는 요청과 같은 순서·같은 길이.
 *   - 2026-10 one-shot: `check` 는 소유 TXT 를 (domain, registrable) 두 이름으로 묻는다 · `peek_identity` 는 읽기 전용(변형 0) · 관리자 아닌 행에는
 *     토큰만(상태 unknown) · `supersededRowId` = 채택해도 되는 직전 관리자 행(채택은 identity 단계에서만, 토큰 불변).
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOM_DOMAIN_SES_STATUSES,
  customDomainAddressCeiling,
  IDENTITY_POLICY_NAME_PREFIX,
  identityPolicyDocument,
  type DomainControlRequest,
} from '../../../src/domains/contract';
import type { DnsLookup } from '../../../src/domains/dns-lookup';
import type { RdapExpiryResult } from '../../../src/domains/rdap';
import type { SesIdentityControl, SesIdentitySnapshot } from '../../../src/mail/transport/ses-identity';
import { RuntimeConfigError } from '../../../src/runtime/config';
import {
  addressesAcceptable,
  composeDomainControl,
  createDomainControlHandler,
  desiredPolicies,
  DOMAIN_CONTROL_MAX_BATCH,
  DomainControlInputError,
  parseDomainControlBatch,
  policySetDigest,
  runDomainControlBatch,
  type DomainControlDependencies,
} from '../../../src/runtime/handlers/domain-control';

const ROW = '11111111-1111-4111-8111-111111111111';
const OLD_ROW = '22222222-2222-4222-8222-222222222222';
const OTHER_ROW = '33333333-3333-4333-8333-333333333333';
const DOMAIN = 'agents.example.com';
const APEX = 'example.com';
const ACCOUNT = '123456789012';
const SENDER = `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`;
const TOKEN = 'T'.repeat(43);
const FRAME = { senderRoleArn: SENDER, accountId: ACCOUNT, domain: DOMAIN };
const ROW_TAGS = { 'atmark:row': ROW, 'atmark:managed': 'customer-domain' };

const base = { rowId: ROW, domain: DOMAIN, registrable: APEX } as const;

// ---------------------------------------------------------------------------
// 가짜 SES — 상태(identity 하나) + 호출 기록. 변형 호출 수를 센다.
// ---------------------------------------------------------------------------

interface FakeIdentity {
  tags: Record<string, string>;
  policies: Record<string, string>;
  dkimStatus?: string;
}

function fakeSes(initial: FakeIdentity | null, options: { readonly createRaces?: FakeIdentity; readonly failOn?: string } = {}) {
  let identity = initial === null ? null : { ...initial, tags: { ...initial.tags }, policies: { ...initial.policies } };
  const calls: string[] = [];
  const mutations = (): string[] => calls.filter((call) => !call.startsWith('get'));
  const fail = (op: string): void => {
    if (options.failOn === op) throw Object.assign(new Error('throttled'), { name: 'TooManyRequestsException' });
  };
  const snapshot = (): SesIdentitySnapshot | null =>
    identity === null
      ? null
      : { tags: { ...identity.tags }, policies: { ...identity.policies }, dkimTokens: ['t1', 't2', 't3'], dkimStatus: identity.dkimStatus ?? 'PENDING', mailFromStatus: 'PENDING' };
  const ses: SesIdentityControl = {
    getIdentity(domain) {
      calls.push(`get ${domain}`);
      return Promise.resolve(snapshot());
    },
    createIdentity(domain, tags) {
      calls.push(`create ${domain} ${JSON.stringify(tags)}`);
      fail('create');
      if (options.createRaces !== undefined) {
        identity = { ...options.createRaces };
        return Promise.reject(Object.assign(new Error('exists'), { name: 'AlreadyExistsException' }));
      }
      if (identity !== null) return Promise.reject(Object.assign(new Error('exists'), { name: 'AlreadyExistsException' }));
      identity = { tags: { ...tags }, policies: {} };
      return Promise.resolve();
    },
    tagIdentity(arn, tags) {
      calls.push(`tag ${arn} ${JSON.stringify(tags)}`);
      if (identity !== null) identity.tags = { ...identity.tags, ...tags };
      return Promise.resolve();
    },
    putMailFrom(domain, mailFrom) {
      calls.push(`mailfrom ${domain} ${mailFrom}`);
      return Promise.resolve();
    },
    putConfigurationSet(domain, name) {
      calls.push(`configset ${domain} ${name}`);
      return Promise.resolve();
    },
    createPolicy(domain, name, policy) {
      calls.push(`createPolicy ${name}`);
      fail('createPolicy');
      if (identity !== null) identity.policies[name] = policy;
      return Promise.resolve();
    },
    updatePolicy(domain, name, policy) {
      calls.push(`updatePolicy ${name}`);
      if (identity !== null) identity.policies[name] = policy;
      return Promise.resolve();
    },
    deletePolicy(domain, name) {
      calls.push(`deletePolicy ${name}`);
      if (identity !== null) delete identity.policies[name];
      return Promise.resolve();
    },
    deleteIdentity(domain) {
      calls.push(`deleteIdentity ${domain}`);
      identity = null;
      return Promise.resolve();
    },
    listIdentities() {
      calls.push('getList');
      return Promise.resolve(identity === null ? [] : [DOMAIN]);
    },
  };
  return { ses, calls, mutations, current: () => identity };
}

const dnsStub: DnsLookup = {
  checkChallenge: () => Promise.resolve({ verdict: 'present', errorCode: null }),
  checkMx: () => Promise.resolve({ verdict: 'missing', errorCode: null }),
};

function deps(ses: SesIdentityControl, overrides: Partial<DomainControlDependencies> = {}): DomainControlDependencies {
  return {
    ses,
    dns: dnsStub,
    rdap: () => Promise.resolve<RdapExpiryResult>({ kind: 'ok', expiresAt: new Date('2027-05-01T00:00:00Z') }),
    senderRoleArn: SENDER,
    accountId: ACCOUNT,
    region: 'ap-northeast-2',
    configurationSet: 'atmark-default',
    ...overrides,
  };
}

async function runOne(dependencies: DomainControlDependencies, request: DomainControlRequest) {
  const [result] = await runDomainControlBatch(dependencies, [request]);
  return result;
}

// ---------------------------------------------------------------------------

describe('엄격 파싱 — 배치 전체를 던진다', () => {
  const ok = { op: 'check', ...base, token: TOKEN };

  it('정확한 모양은 통과한다(op 일곱 전부)', () => {
    const batch = parseDomainControlBatch({
      batch: [
        ok,
        { op: 'saga_step', ...base, step: 'identity', supersededRowId: null },
        { op: 'saga_step', ...base, step: 'mail_from', supersededRowId: OLD_ROW },
        { op: 'remove_step', ...base, step: 'policy' },
        { op: 'sync_policy', ...base, addresses: [`a@${DOMAIN}`] },
        { op: 'audit_policy', ...base, addresses: [], expectedDigest: null },
        { op: 'check_expiry', ...base },
        { op: 'peek_identity', ...base },
      ],
    });
    expect(batch.map((request) => request.op)).toEqual(['check', 'saga_step', 'saga_step', 'remove_step', 'sync_policy', 'audit_policy', 'check_expiry', 'peek_identity']);
  });

  it.each([
    ['principal 칸이 끼었다(Principal 은 환경변수로만)', { batch: [{ ...ok, principal: 'arn:aws:iam::999999999999:root' }] }],
    ['모르는 칸', { batch: [{ ...ok, extra: 1 }] }],
    ['빠진 칸', { batch: [{ op: 'check', ...base }] }],
    ['바깥 키가 batch 하나가 아니다', { batch: [ok], principal: 'x' }],
    ['빈 배치', { batch: [] }],
    ['배치 상한 초과', { batch: Array.from({ length: DOMAIN_CONTROL_MAX_BATCH + 1 }, () => ok) }],
    ['모르는 op', { batch: [{ ...ok, op: 'send' }] }],
    ['rowId 가 uuid 가 아니다', { batch: [{ ...ok, rowId: 'x' }] }],
    ['atmark.ai(플랫폼 도메인)', { batch: [{ ...ok, domain: 'atmark.ai', registrable: 'atmark.ai' }] }],
    ['atmark.ai 의 하위', { batch: [{ ...ok, domain: 'x.atmark.ai', registrable: 'atmark.ai' }] }],
    ['apex 자체', { batch: [{ ...ok, domain: APEX, registrable: APEX }] }],
    ['registrable 이 판정과 다르다', { batch: [{ ...ok, registrable: 'other.com' }] }],
    ['대문자 도메인(정규형 아님)', { batch: [{ ...ok, domain: 'Agents.example.com' }] }],
    ['토큰 모양', { batch: [{ ...ok, token: 'short' }] }],
    ['사가 단계 none', { batch: [{ op: 'saga_step', ...base, step: 'none', supersededRowId: null }] }],
    ['supersededRowId 가 자기 자신', { batch: [{ op: 'saga_step', ...base, step: 'identity', supersededRowId: ROW }] }],
    ['제거 단계 done', { batch: [{ op: 'remove_step', ...base, step: 'done' }] }],
    ['주소가 배열이 아니다', { batch: [{ op: 'sync_policy', ...base, addresses: 'a@x' }] }],
    ['다이제스트 모양', { batch: [{ op: 'audit_policy', ...base, addresses: [], expectedDigest: 'abc' }] }],
    ['peek_identity 에 토큰 칸', { batch: [{ op: 'peek_identity', ...base, token: TOKEN }] }],
    ['peek_identity 에 supersededRowId 칸', { batch: [{ op: 'peek_identity', ...base, supersededRowId: null }] }],
    ['peek_identity 의 registrable 이 판정과 다르다', { batch: [{ op: 'peek_identity', ...base, registrable: 'other.com' }] }],
  ])('%s', (_label, event) => {
    expect(() => parseDomainControlBatch(event)).toThrow(DomainControlInputError);
  });
});

describe('주소 목록의 뜻(rejected_input) — SES 호출 0', () => {
  it('다른 도메인 · 대문자 · 로컬파트 문법 · 전역 예약 · 하위 주소 · 천장 초과는 받지 않는다', async () => {
    expect(addressesAcceptable(DOMAIN, [`bot@${DOMAIN}`, `a.b-c@${DOMAIN}`])).toBe(true);
    // 고객 도메인은 atmark.ai 전용 예약(support@ 등)을 쓸 수 있다 — 전역 예약(postmaster@ · admin@)만 막는다.
    expect(addressesAcceptable(DOMAIN, [`support@${DOMAIN}`])).toBe(true);
    for (const bad of [`bot@other.${APEX}`, `Bot@${DOMAIN}`, `a..b@${DOMAIN}`, `postmaster@${DOMAIN}`, `admin@${DOMAIN}`, `a+b@${DOMAIN}`, `@${DOMAIN}`, `bot@${DOMAIN}.`]) {
      expect(addressesAcceptable(DOMAIN, [bad]), bad).toBe(false);
    }
    const ceiling = customDomainAddressCeiling(DOMAIN);
    expect(addressesAcceptable(DOMAIN, Array.from({ length: ceiling + 1 }, (_, i) => `a${String(i)}@${DOMAIN}`))).toBe(false);
    const fake = fakeSes({ tags: ROW_TAGS, policies: {} });
    await expect(runOne(deps(fake.ses), { op: 'sync_policy', ...base, addresses: [`postmaster@${DOMAIN}`] })).resolves.toEqual({
      op: 'sync_policy',
      rowId: ROW,
      outcome: 'rejected_input',
      policyDigest: null,
      errorCode: 'rejected_input',
    });
    await expect(runOne(deps(fake.ses), { op: 'audit_policy', ...base, addresses: [`x@other.com`], expectedDigest: null })).resolves.toMatchObject({
      outcome: 'error',
      errorCode: 'rejected_input',
    });
    expect(fake.calls).toEqual([]);
  });
});

describe('생성 사가 — 태그 대조 · 채택', () => {
  it('identity 없음 → 만들기(태그 둘) → advanced · DKIM 토큰·상태', async () => {
    const fake = fakeSes(null);
    const result = await runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: null });
    expect(result).toEqual({
      op: 'saga_step',
      rowId: ROW,
      outcome: 'advanced',
      ownerRowTag: null,
      dkimTokens: ['t1', 't2', 't3'],
      dkimStatus: 'pending',
      mailFromStatus: 'pending',
      policyDigest: null,
      errorCode: null,
    });
    expect(fake.calls).toContain(`create ${DOMAIN} ${JSON.stringify(ROW_TAGS)}`);
  });

  it('이미 이 행의 것 → 멱등 advanced(변형 호출 0)', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: {} });
    await expect(runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: null })).resolves.toMatchObject({ outcome: 'advanced' });
    expect(fake.mutations()).toEqual([]);
  });

  it('★ 다른 행의 태그 · 태그 없음(스파이크·수동) → identity_owned_elsewhere(그 태그) · 변형 호출 0 — 단계마다', async () => {
    for (const tags of [{ 'atmark:row': OTHER_ROW }, {}]) {
      for (const step of ['identity', 'mail_from', 'config_set', 'policy'] as const) {
        const fake = fakeSes({ tags, policies: {} });
        const result = await runOne(deps(fake.ses), { op: 'saga_step', ...base, step, supersededRowId: OLD_ROW });
        expect(result, `${step} ${JSON.stringify(tags)}`).toMatchObject({ outcome: 'identity_owned_elsewhere', ownerRowTag: tags['atmark:row' as keyof typeof tags] ?? null, dkimTokens: [] });
        expect(fake.mutations(), step).toEqual([]);
      }
    }
  });

  it('★ 양도 채택 — 태그가 supersededRowId(대체된 옛 행)면 atmark:row 하나만 이 행으로 바꾸고 · 옛 행의 정책을 곧바로 지우고 advanced(보안 리뷰 M3)', async () => {
    const oldPolicy = `${IDENTITY_POLICY_NAME_PREFIX}${OLD_ROW}-0`;
    const fake = fakeSes({ tags: { 'atmark:row': OLD_ROW, 'atmark:managed': 'customer-domain' }, policies: { [oldPolicy]: '{"old":true}', manual: '{}' } });
    await expect(runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: OLD_ROW })).resolves.toMatchObject({ outcome: 'advanced' });
    expect(fake.mutations()).toEqual([
      `tag arn:aws:ses:ap-northeast-2:${ACCOUNT}:identity/${DOMAIN} ${JSON.stringify({ 'atmark:row': ROW })}`,
      'deletePolicy atmark-sender-22222222-2222-4222-8222-222222222222-0',
      'deletePolicy manual',
    ]);
    expect(fake.current()?.tags).toEqual(ROW_TAGS);
    expect(fake.current()?.policies).toEqual({});
  });

  it('정책 단계 — 이 행 접두사가 아닌 정책을 지우고 남은(이 행) 정책 집합의 다이제스트를 돌려준다', async () => {
    const own = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const ownDoc = identityPolicyDocument(FRAME, [`a@${DOMAIN}`]);
    const fake = fakeSes({ tags: ROW_TAGS, policies: { [own]: ownDoc, [`${IDENTITY_POLICY_NAME_PREFIX}${OLD_ROW}-0`]: '{}' } });
    await expect(runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'policy', supersededRowId: null })).resolves.toMatchObject({
      outcome: 'advanced',
      policyDigest: policySetDigest({ [own]: ownDoc }),
    });
    expect(fake.mutations()).toEqual([`deletePolicy ${IDENTITY_POLICY_NAME_PREFIX}${OLD_ROW}-0`]);
  });

  it('만들기 경합(AlreadyExists) — 태그 규칙 그대로: 남의 것이면 owned_elsewhere, 옛 행이면 채택', async () => {
    const raced = fakeSes(null, { createRaces: { tags: { 'atmark:row': OTHER_ROW }, policies: {} } });
    await expect(runOne(deps(raced.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: null })).resolves.toMatchObject({
      outcome: 'identity_owned_elsewhere',
      ownerRowTag: OTHER_ROW,
    });
    const adopted = fakeSes(null, { createRaces: { tags: { 'atmark:row': OLD_ROW }, policies: {} } });
    await expect(runOne(deps(adopted.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: OLD_ROW })).resolves.toMatchObject({ outcome: 'advanced' });
    expect(adopted.current()?.tags['atmark:row']).toBe(ROW);
  });

  it('★ 넘겨주기·선점 인수 채택(supersededRowId = 직전 관리자) — identity 를 만들지도 지우지도 않는다(토큰 불변) · 채택은 identity 단계에서만', async () => {
    const fake = fakeSes({ tags: { 'atmark:row': OLD_ROW, 'atmark:managed': 'customer-domain' }, policies: {} });
    const result = await runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: OLD_ROW });
    expect(result).toMatchObject({ outcome: 'advanced', dkimTokens: ['t1', 't2', 't3'] });
    expect(fake.mutations().filter((call) => call.startsWith('create') || call.startsWith('deleteIdentity'))).toEqual([]);
    expect(fake.current()?.tags).toEqual(ROW_TAGS);
    // 태그가 아직 직전 관리자인데 다음 단계가 오면(채택 전) — 변형 0 · owned_elsewhere.
    for (const step of ['mail_from', 'config_set', 'policy'] as const) {
      const before = fakeSes({ tags: { 'atmark:row': OLD_ROW, 'atmark:managed': 'customer-domain' }, policies: {} });
      await expect(runOne(deps(before.ses), { op: 'saga_step', ...base, step, supersededRowId: OLD_ROW })).resolves.toMatchObject({
        outcome: 'identity_owned_elsewhere',
        ownerRowTag: OLD_ROW,
      });
      expect(before.mutations(), step).toEqual([]);
    }
  });

  it('mail_from · config_set — 이 행의 identity 에만 · bounce.<domain> · 구성 세트 이름은 배포 값', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: {} });
    await runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'mail_from', supersededRowId: null });
    await runOne(deps(fake.ses), { op: 'saga_step', ...base, step: 'config_set', supersededRowId: null });
    expect(fake.mutations()).toEqual([`mailfrom ${DOMAIN} bounce.${DOMAIN}`, `configset ${DOMAIN} atmark-default`]);
  });

  it('identity 가 없는데 다음 단계 → error(identity_not_found) · SES 예외 → error(예외 이름만)', async () => {
    await expect(runOne(deps(fakeSes(null).ses), { op: 'saga_step', ...base, step: 'mail_from', supersededRowId: null })).resolves.toMatchObject({
      outcome: 'error',
      errorCode: 'identity_not_found',
    });
    await expect(runOne(deps(fakeSes(null, { failOn: 'create' }).ses), { op: 'saga_step', ...base, step: 'identity', supersededRowId: null })).resolves.toMatchObject({
      outcome: 'error',
      errorCode: 'TooManyRequestsException',
    });
  });
});

describe('정책 동기화 · 감사 — Principal 은 환경변수 · too_large 는 기존 정책 유지', () => {
  const addresses = [`b@${DOMAIN}`, `a@${DOMAIN}`];

  it('동기화: 정책 이름 atmark-sender-<row>-<n> · 문서 Principal = SENDER_ROLE_ARN · 남의 정책은 지운다 · 다이제스트를 돌려준다', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: { 'console-test': '{"Statement":[]}' } });
    const result = await runOne(deps(fake.ses), { op: 'sync_policy', ...base, addresses });
    const name = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const expected = identityPolicyDocument(FRAME, [`a@${DOMAIN}`, `b@${DOMAIN}`]);
    expect(fake.current()?.policies).toEqual({ [name]: expected });
    expect(JSON.parse(expected).Statement[0].Principal).toEqual({ AWS: SENDER });
    expect(result).toEqual({ op: 'sync_policy', rowId: ROW, outcome: 'synced', policyDigest: policySetDigest({ [name]: expected }), errorCode: null });
    // 남는 이름을 **먼저** 지운다(닫힌 쪽) — 그다음 만든다.
    expect(fake.mutations()).toEqual(['deletePolicy console-test', `createPolicy ${name}`]);
    // 두 번째 동기화는 같으면 아무것도 바꾸지 않는다.
    const again = fakeSes({ tags: ROW_TAGS, policies: { [name]: expected } });
    await runOne(deps(again.ses), { op: 'sync_policy', ...base, addresses });
    expect(again.mutations()).toEqual([]);
  });

  it('빈 주소 목록 = 정책 전부 삭제(발신 불가 상태) · 같은 정책이 키 순서만 달라도 고치지 않는다(정규화)', async () => {
    const name = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const fake = fakeSes({ tags: ROW_TAGS, policies: { [name]: identityPolicyDocument(FRAME, [`a@${DOMAIN}`]) } });
    await expect(runOne(deps(fake.ses), { op: 'sync_policy', ...base, addresses: [] })).resolves.toMatchObject({ outcome: 'synced' });
    expect(fake.current()?.policies).toEqual({});
    const parsed = JSON.parse(identityPolicyDocument(FRAME, [`a@${DOMAIN}`])) as { Version: string; Statement: unknown };
    // SES 가 돌려주는 원문은 키 순서·공백이 다를 수 있다 — 정규화 다이제스트는 같다.
    const reordered = JSON.stringify({ Statement: parsed.Statement, Version: parsed.Version }, null, 2);
    const same = fakeSes({ tags: ROW_TAGS, policies: { [name]: reordered } });
    await runOne(deps(same.ses), { op: 'sync_policy', ...base, addresses: [`a@${DOMAIN}`] });
    expect(same.mutations()).toEqual([]);
  });

  it('★ too_large — 기존 정책을 건드리지 않는다(지우지도 줄이지도 않는다)', async () => {
    // 천장(`customDomainAddressCeiling` — ARN 128자·로컬파트 64자 최악)이 먼저 막으므로 정상 입력으로는 닿지 않는다(계약). 천장 안의 최악 목록은
    //   들어가고, 천장을 넘는 목록은 20개를 넘는다 — 그리고 핸들러 경로의 방어(기존 정책 유지)는 정책 하나에도 안 들어가는 프레임으로 본다.
    const worstArn = `arn:aws:iam::${ACCOUNT}:role/${'r'.repeat(64)}`;
    const worst = (n: number): string[] => Array.from({ length: n }, (_, i) => `${'x'.repeat(60)}${String(i).padStart(4, '0')}@${DOMAIN}`);
    const ceiling = customDomainAddressCeiling(DOMAIN);
    expect(desiredPolicies({ ...FRAME, senderRoleArn: worstArn }, ROW, worst(ceiling))).not.toBeNull();
    expect(desiredPolicies({ ...FRAME, senderRoleArn: worstArn }, ROW, worst(ceiling * 2))).toBeNull();
    const hugeArn = `arn:aws:iam::${ACCOUNT}:role/${'r'.repeat(3_900)}`;
    const many = [`a@${DOMAIN}`];
    const fake = fakeSes({ tags: ROW_TAGS, policies: { keep: 'x' } });
    await expect(runOne(deps(fake.ses, { senderRoleArn: hugeArn }), { op: 'sync_policy', ...base, addresses: many })).resolves.toEqual({
      op: 'sync_policy',
      rowId: ROW,
      outcome: 'too_large',
      policyDigest: null,
      errorCode: null,
    });
    expect(fake.mutations()).toEqual([]);
    expect(fake.current()?.policies).toEqual({ keep: 'x' });
  });

  it('★ 남의 identity — not_owner · 변형 0 (동기화·감사·제거)', async () => {
    for (const request of [
      { op: 'sync_policy', ...base, addresses },
      { op: 'audit_policy', ...base, addresses, expectedDigest: null },
      { op: 'remove_step', ...base, step: 'policy' },
      { op: 'remove_step', ...base, step: 'identity' },
    ] as DomainControlRequest[]) {
      const fake = fakeSes({ tags: { 'atmark:row': OTHER_ROW }, policies: { p: 'x' } });
      await expect(runOne(deps(fake.ses), request), request.op).resolves.toMatchObject({ outcome: 'not_owner' });
      expect(fake.mutations(), request.op).toEqual([]);
    }
  });

  it('감사: 기대(다이제스트)와 같으면 clean · 다르면 기대 정책으로 덮어쓰고 drift · DKIM 상태를 싣는다', async () => {
    const name = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const good = { [name]: identityPolicyDocument(FRAME, [`a@${DOMAIN}`, `b@${DOMAIN}`]) };
    const clean = fakeSes({ tags: ROW_TAGS, policies: good, dkimStatus: 'SUCCESS' });
    await expect(runOne(deps(clean.ses), { op: 'audit_policy', ...base, addresses, expectedDigest: policySetDigest(good) })).resolves.toEqual({
      op: 'audit_policy',
      rowId: ROW,
      outcome: 'clean',
      dkimStatus: 'success',
      errorCode: null,
    });
    expect(clean.mutations()).toEqual([]);
    // 누가 Principal 을 넓혔다.
    const widened = { [name]: good[name]?.replace(SENDER, '*') ?? '' };
    const drift = fakeSes({ tags: ROW_TAGS, policies: { ...widened, extra: '{"Statement":[]}' } });
    await expect(runOne(deps(drift.ses), { op: 'audit_policy', ...base, addresses, expectedDigest: policySetDigest(good) })).resolves.toMatchObject({ outcome: 'drift' });
    expect(drift.current()?.policies).toEqual(good);
  });

  it('★ 감사: SES 가 원소 하나 배열을 값 하나로 바꿔 저장해도 clean — 주소 하나인 도메인이 감사마다 drift → operator 정지되던 것(2026-10-06 운영 e2e)', async () => {
    const name = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const one = [`a@${DOMAIN}`];
    const ours = { [name]: identityPolicyDocument(FRAME, one) };
    expect(ours[name]).toContain(`"ses:FromAddress":["a@${DOMAIN}"]`);
    // SES 가 돌려주는 모양(실측): ["a@…"] → "a@…".
    const stored = { [name]: ours[name]?.replace(`"ses:FromAddress":["a@${DOMAIN}"]`, `"ses:FromAddress":"a@${DOMAIN}"`) ?? '' };
    expect(stored[name]).not.toEqual(ours[name]);
    expect(policySetDigest(stored)).toBe(policySetDigest(ours));
    const fake = fakeSes({ tags: ROW_TAGS, policies: stored, dkimStatus: 'SUCCESS' });
    await expect(runOne(deps(fake.ses), { op: 'audit_policy', ...base, addresses: one, expectedDigest: policySetDigest(ours) })).resolves.toMatchObject({ outcome: 'clean' });
    expect(fake.mutations()).toEqual([]);
    // 값 하나라도 다른 주소면 여전히 drift.
    const other = { [name]: ours[name]?.replace(`["a@${DOMAIN}"]`, `"b@${DOMAIN}"`) ?? '' };
    expect(policySetDigest(other)).not.toBe(policySetDigest(ours));
  });

  it('★ 감사 판정은 언제나 주소로 조립한 기대 정책 — 행의 다이제스트가 SES 원문(넓혀진 정책)과 같아도 drift 다(보안 리뷰 M4)', async () => {
    const name = `${IDENTITY_POLICY_NAME_PREFIX}${ROW}-0`;
    const good = { [name]: identityPolicyDocument(FRAME, [`a@${DOMAIN}`, `b@${DOMAIN}`]) };
    const widened = { [name]: good[name]?.replace(SENDER, '*') ?? '' };
    const fake = fakeSes({ tags: ROW_TAGS, policies: widened });
    await expect(runOne(deps(fake.ses), { op: 'audit_policy', ...base, addresses, expectedDigest: policySetDigest(widened) })).resolves.toMatchObject({ outcome: 'drift' });
    expect(fake.current()?.policies).toEqual(good);
    // 행의 다이제스트가 낡았어도(기대와 다름) SES 가 기대와 같으면 clean — 덮어쓰지 않는다.
    const stale = fakeSes({ tags: ROW_TAGS, policies: good });
    await expect(runOne(deps(stale.ses), { op: 'audit_policy', ...base, addresses, expectedDigest: 'f'.repeat(64) })).resolves.toMatchObject({ outcome: 'clean' });
    expect(stale.mutations()).toEqual([]);
  });

  it('제거 사가: 정책 전부 → identity · 이미 없으면 advanced(멱등)', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: { a: '1', b: '2' } });
    await expect(runOne(deps(fake.ses), { op: 'remove_step', ...base, step: 'policy' })).resolves.toEqual({ op: 'remove_step', rowId: ROW, outcome: 'advanced', errorCode: null });
    await expect(runOne(deps(fake.ses), { op: 'remove_step', ...base, step: 'identity' })).resolves.toMatchObject({ outcome: 'advanced' });
    expect(fake.mutations()).toEqual(['deletePolicy a', 'deletePolicy b', `deleteIdentity ${DOMAIN}`]);
    await expect(runOne(deps(fake.ses), { op: 'remove_step', ...base, step: 'identity' })).resolves.toMatchObject({ outcome: 'advanced' });
  });
});

describe('확인 · 만료 · 배치', () => {
  it('check — DNS 판정 둘 · 첫 오류 코드', async () => {
    const dns: DnsLookup = {
      checkChallenge: () => Promise.resolve({ verdict: 'error', errorCode: 'dns_timeout' }),
      checkMx: () => Promise.resolve({ verdict: 'ses', errorCode: null }),
    };
    await expect(runOne(deps(fakeSes(null).ses, { dns }), { op: 'check', ...base, token: TOKEN })).resolves.toEqual({
      op: 'check',
      rowId: ROW,
      txt: 'error',
      mx: 'ses',
      errorCode: 'dns_timeout',
    });
  });

  it('check — 소유 TXT 는 (domain, registrable, token) 으로 묻는다(두 이름의 OR 은 dns-lookup) · MX 는 서브도메인', async () => {
    const asked: unknown[][] = [];
    const dns: DnsLookup = {
      checkChallenge: (...args) => (asked.push(['txt', ...args]), Promise.resolve({ verdict: 'present', errorCode: null })),
      checkMx: (...args) => (asked.push(['mx', ...args]), Promise.resolve({ verdict: 'missing', errorCode: null })),
    };
    await expect(runOne(deps(fakeSes(null).ses, { dns }), { op: 'check', ...base, token: TOKEN })).resolves.toEqual({
      op: 'check',
      rowId: ROW,
      txt: 'present',
      mx: 'missing',
      errorCode: null,
    });
    expect(asked).toEqual([
      ['txt', DOMAIN, APEX, TOKEN],
      ['mx', DOMAIN, APEX],
    ]);
  });

  it('check_expiry — ok(ISO) · unsupported · error(코드)', async () => {
    const ses = fakeSes(null).ses;
    await expect(runOne(deps(ses), { op: 'check_expiry', ...base })).resolves.toEqual({ op: 'check_expiry', rowId: ROW, outcome: 'ok', expiresAt: '2027-05-01T00:00:00.000Z', errorCode: null });
    await expect(runOne(deps(ses, { rdap: () => Promise.resolve({ kind: 'unsupported' }) }), { op: 'check_expiry', ...base })).resolves.toMatchObject({ outcome: 'unsupported', expiresAt: null });
    await expect(runOne(deps(ses, { rdap: () => Promise.resolve({ kind: 'error', code: 'rdap_timeout' }) }), { op: 'check_expiry', ...base })).resolves.toMatchObject({
      outcome: 'error',
      errorCode: 'rdap_timeout',
    });
  });

  it('결과는 요청과 같은 순서·같은 길이 · 핸들러는 { results } 를 돌려준다', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: {} });
    const handler = createDomainControlHandler(() => deps(fake.ses));
    const out = await handler({ batch: [{ op: 'check_expiry', ...base }, { op: 'check', ...base, token: TOKEN }, { op: 'remove_step', ...base, step: 'policy' }] });
    expect(out.results.map((result) => result.op)).toEqual(['check_expiry', 'check', 'remove_step']);
    await expect(handler({ batch: [{ op: 'check', ...base, token: TOKEN, principal: SENDER }] })).rejects.toThrow(DomainControlInputError);
    expect(CUSTOM_DOMAIN_SES_STATUSES).toContain('pending');
  });
});

describe('peek_identity — 읽기 전용 · 관리자 아닌 행에는 토큰만', () => {
  const peek = { op: 'peek_identity', ...base } as const;

  it('이 행의 identity → found · ownerIsRow · 토큰 · DKIM·MAIL FROM 상태 · 변형 0', async () => {
    const fake = fakeSes({ tags: ROW_TAGS, policies: { x: '{}' }, dkimStatus: 'SUCCESS' });
    await expect(runOne(deps(fake.ses), peek)).resolves.toEqual({
      op: 'peek_identity',
      rowId: ROW,
      outcome: 'found',
      ownerIsRow: true,
      dkimTokens: ['t1', 't2', 't3'],
      dkimStatus: 'success',
      mailFromStatus: 'pending',
      errorCode: null,
    });
    expect(fake.mutations()).toEqual([]);
  });

  it('★ 다른 행 · 태그 없음 · 관리 표시만 있는 identity → 토큰만(상태 unknown) · 변형 0', async () => {
    for (const tags of [{ 'atmark:row': OTHER_ROW, 'atmark:managed': 'customer-domain' }, {}, { 'atmark:managed': 'customer-domain' }]) {
      const fake = fakeSes({ tags, policies: {}, dkimStatus: 'SUCCESS' });
      await expect(runOne(deps(fake.ses), peek), JSON.stringify(tags)).resolves.toEqual({
        op: 'peek_identity',
        rowId: ROW,
        outcome: 'found',
        ownerIsRow: false,
        dkimTokens: ['t1', 't2', 't3'],
        dkimStatus: 'unknown',
        mailFromStatus: 'unknown',
        errorCode: null,
      });
      expect(fake.mutations()).toEqual([]);
    }
  });

  it('identity 없음 → absent · SES 예외 → error(예외 이름만) · 둘 다 토큰 없음 · 상태 unknown', async () => {
    await expect(runOne(deps(fakeSes(null).ses), peek)).resolves.toEqual({
      op: 'peek_identity',
      rowId: ROW,
      outcome: 'absent',
      ownerIsRow: false,
      dkimTokens: [],
      dkimStatus: 'unknown',
      mailFromStatus: 'unknown',
      errorCode: null,
    });
    const throwing: SesIdentityControl = {
      ...fakeSes(null).ses,
      getIdentity: () => Promise.reject(Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' })),
    };
    await expect(runOne(deps(throwing), peek)).resolves.toEqual({
      op: 'peek_identity',
      rowId: ROW,
      outcome: 'error',
      ownerIsRow: false,
      dkimTokens: [],
      dkimStatus: 'unknown',
      mailFromStatus: 'unknown',
      errorCode: 'TooManyRequestsException',
    });
  });
});

describe('조립 — Principal 은 환경변수 하나 · 모양·길이·리전', () => {
  const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
    Object.fromEntries(
      Object.entries({ ATMARK_ENV: 'production', AWS_REGION: 'ap-northeast-2', SENDER_ROLE_ARN: SENDER, ATMARK_SES_CONFIGURATION_SET: 'atmark-default', ...overrides }).filter(
        ([, value]) => value !== undefined,
      ),
    );

  it('정상 — 계정 id 는 ARN 에서', () => {
    const composed = composeDomainControl(env());
    expect([composed.senderRoleArn, composed.accountId, composed.region, composed.configurationSet]).toEqual([SENDER, ACCOUNT, 'ap-northeast-2', 'atmark-default']);
  });

  it.each([
    ['없음', undefined],
    ['128자 초과', `arn:aws:iam::${ACCOUNT}:role/${'r'.repeat(120)}`],
    ['사용자 ARN', `arn:aws:iam::${ACCOUNT}:user/x`],
    ['와일드카드', '*'],
    ['다른 서비스 ARN', `arn:aws:sts::${ACCOUNT}:assumed-role/x/y`],
    ['경로가 있는 역할', `arn:aws:iam::${ACCOUNT}:role/path/x`],
  ])('SENDER_ROLE_ARN %s → 기동 거부', (_label, value) => {
    expect(() => composeDomainControl(env({ SENDER_ROLE_ARN: value }))).toThrow(RuntimeConfigError);
  });

  it('다른 리전 · 운영 아님 → 기동 거부', () => {
    expect(() => composeDomainControl(env({ AWS_REGION: 'us-east-1' }))).toThrow(RuntimeConfigError);
    expect(() => composeDomainControl(env({ ATMARK_ENV: 'development' }))).toThrow();
  });
});
