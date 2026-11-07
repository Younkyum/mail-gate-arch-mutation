/**
 * test/support/tlog-synthetic.ts — **DB 없이** 만든 투명성 로그 역사와 그 번들(`atmark-tlog-bundle/v2`). 생산자 부품(`src/tlog` 의 잎·에폭 계획·
 * 머클·signed note)으로 역사를 쌓고, 번들 모양은 `src/tlog/proofs.ts` `buildVerificationBundle` 과 같은 규칙(닫힌 범위 · 시작 가장자리 ·
 * `since` 연결)으로 싣는다. 검증기 공격 재현(적대적 검증 attack.mts A~E)·Go 교차 검증의 입력이다.
 *
 * 조직 셋: 대상 조직 A(에폭마다 `owner.action` 잎), B(짝수 에폭에만 잎 — 쉬는 에폭이 있다), C(첫 에폭 뒤로 쉰다) — 에폭 트리에 형제가 있다.
 * `startEpoch` 를 주면 A 의 로그가 그 에폭에 처음 생긴다(앞 에폭의 에폭 트리에 A 가 없다 — 서버처럼 시작 크기 0 번들이 나온다, L1).
 * 체크포인트 키는 고정 시드 Ed25519 중 **vkey 의 키 자료에 `+` 가 들어간 것**을 고른다(H1 회귀가 모든 합성 테스트에 걸린다).
 * `identitySince` 를 주면(US-013 신원 잎 — 적대적 검증 M2·M3) A 에 에이전트 하나(`identityAgent`)의 생성 잎(에폭 2 첫 잎)·상태 갱신 잎(에폭 3 첫 잎,
 * active → suspended/owner)을 넣고, 서버처럼 번들마다 **조직의 에이전트 행 전부**와 `identity_since` 를 싣는다. 도입 전(로그 시작 뒤 · 도입 전)에
 * 만든 에이전트 행 하나와 그 주소 행 하나도 싣는다(잎 없음 — 검증기가 도입 시각으로 가려야 한다).
 * `v5Events` 를 주면(`identitySince` 필요 — ADR-0014 단계 3 · 개정) A 에 고객 도메인 행 하나의 `domain.status` 잎 둘(에폭 4 첫 잎 = 생성 pending ·
 * 에폭 5 첫 잎 = verified)과 대표 주소 선택 잎 `identity.primary_set` 하나(에폭 4 둘째 잎)를 넣고, 서버처럼 도메인 행은 늘(removed 가 아니므로), 대표 주소 행은
 * 범위에 그 잎이 있을 때 싣고 `min_verifier_version: 5` 를 요구한다.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

import { keyIdOf, signedNote, vkeyOf } from '../../src/tlog/checkpoint';
import { TLOG_ORIGIN } from '../../src/tlog/constants';
import { planEpoch, type OrgHead } from '../../src/tlog/epoch';
import { buildOrgLeaf, epochTreeLeaf } from '../../src/tlog/leaf';
import { consistencyProof, frontierOf, inclusionProof, leafHash, rootOf } from '../../src/tlog/merkle';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const hex = (bytes: Buffer): string => bytes.toString('hex');

/** 결정적 16바이트 · 32바이트 · uuid — 같은 태그면 같은 역사. */
function derive(tag: string, label: string, bytes: number): Buffer {
  return createHash('sha256').update(`${tag}:${label}`).digest().subarray(0, bytes);
}
function uuidOf(tag: string, label: string): string {
  const h = derive(tag, label, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface SyntheticSigner {
  readonly vkey: string;
  readonly raw: Buffer;
  sign(text: string): string;
}

/** 고정 시드 Ed25519 — `wantPlus` 면 vkey 키 자료에 `+` 가 있는 첫 시드. */
export function syntheticSigner(origin = TLOG_ORIGIN, wantPlus = true, from = 1): SyntheticSigner {
  for (let seed = from; seed < 255; seed += 1) {
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
    const raw = Buffer.from((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
    const vkey = vkeyOf(origin, raw);
    const material = vkey.slice(vkey.indexOf('+', vkey.indexOf('+') + 1) + 1);
    if (wantPlus && !material.includes('+')) continue;
    return {
      vkey,
      raw,
      sign: (text: string): string => signedNote(text, origin, keyIdOf(origin, raw), sign(null, Buffer.from(text, 'utf8'), privateKey)),
    };
  }
  throw new Error('시드를 찾지 못했다');
}

interface OrgState {
  readonly log: string;
  readonly salt: Buffer;
  readonly leaves: { json: string; hash: Buffer; row: Record<string, unknown> | null }[];
}

export interface SyntheticHistory {
  readonly signer: SyntheticSigner;
  /** 대상 조직 A 의 로그 id. */
  readonly log: string;
  readonly epochs: number;
  /** `identitySince` 를 줬을 때의 에이전트 id(hex32) — 아니면 null. */
  readonly identityAgent: string | null;
  /** 서버와 같은 규칙의 번들. `since` 를 주면 범위 밖일 때 `link` 를 싣는다. */
  bundle(from: number, to: number, options?: { readonly since?: number }): Record<string, unknown>;
}

export interface SyntheticOptions {
  readonly tag?: string;
  readonly epochs?: number;
  /** A 의 에폭당 잎 수. */
  readonly perEpoch?: number;
  readonly signer?: SyntheticSigner;
  /** A 의 로그가 처음 생기는 에폭(기본 0). */
  readonly startEpoch?: number;
  /** 신원 잎 도입 시각(µs 문자열) — 주면 신원 잎·행과 번들 `identity_since` 를 싣는다. */
  readonly identitySince?: string;
  /** 판 5 잎(`domain.status` · `identity.primary_set`)과 원천 행을 넣는다(`identitySince` 필요). */
  readonly v5Events?: boolean;
  /** 판 6 — A 의 에폭 1 첫 `owner.action` 잎을 운영자 · 시스템 행위자(`c.operator`)로, 원천 행에 `actor: 'operator'`(202610131610). */
  readonly operatorActions?: boolean;
}

/** `operatorActions` 의 고정 값. */
export const SYNTHETIC_OPERATOR_ACTOR = 'system:platform_reputation';

/** `v5Events` 의 고정 값 — 테스트가 행을 비틀 때 쓴다. */
export const SYNTHETIC_CUSTOM_DOMAIN = 'agents.synthetic-customer.com';
export const SYNTHETIC_PRIMARY_ADDRESS = `agent@${SYNTHETIC_CUSTOM_DOMAIN}`;

export function syntheticHistory(options: SyntheticOptions = {}): SyntheticHistory {
  const tag = options.tag ?? 'synthetic';
  const epochs = options.epochs ?? 6;
  const perEpoch = options.perEpoch ?? 3;
  const startEpoch = options.startEpoch ?? 0;
  const signer = options.signer ?? syntheticSigner();
  const at0 = Date.parse('2026-09-24T00:00:00Z');
  const instant = (ms: number): string => new Date(ms).toISOString().replace('Z', '000Z');
  const orgs: OrgState[] = ['a', 'b', 'c'].map((name) => ({ log: hex(derive(tag, `log-${name}`, 16)), salt: derive(tag, `salt-${name}`, 32), leaves: [] }));
  const [orgA] = orgs as [OrgState];
  const identity = options.identitySince;
  const agent = identity === undefined ? null : hex(derive(tag, 'agent', 16));
  const agentRows: Record<string, unknown>[] = [];
  const v5 = options.v5Events === true && agent !== null;
  const domainId = uuidOf(tag, 'custom-domain');
  const primaryChangeId = uuidOf(tag, 'primary-change');
  const atOf = (epoch: number, index: number): string => instant(at0 + epoch * 3_600_000 + index * 1000 + 1);
  /** 범위에 잎이 있을 때만 싣는 판 5 원천 행(서버 `domainRows` · `primaryChangeRows` 와 같은 규칙). */
  const v5Rows: Record<string, Record<string, unknown>> = v5
    ? {
        [`custom_domains:${domainId}`]: {
          t: 'custom_domains',
          id: domainId,
          domain: SYNTHETIC_CUSTOM_DOMAIN,
          status: 'verified',
          suspended_reason: null,
          inbound_mx_status: 'ses',
          created_at: atOf(4, 0),
          updated_at: atOf(5, 0),
          removed_at: null,
        },
        [`agent_primary_changes:${primaryChangeId}`]: {
          t: 'agent_primary_changes',
          id: primaryChangeId,
          agent_id: agent,
          address: SYNTHETIC_PRIMARY_ADDRESS,
          cause: 'owner',
          created_at: atOf(4, 1),
        },
      }
    : {};
  if (agent !== null) {
    const created = instant(at0 + 2 * 3_600_000 + 1);
    agentRows.push({ t: 'agents', id: agent, name: 'synthetic-agent', status: 'suspended', suspended_by: 'owner', created_at: created, updated_at: instant(at0 + 3 * 3_600_000 + 1) });
    // 도입 전 — 로그는 시작했지만 신원 잎은 아직 없었다(잎 없음).
    const old = hex(derive(tag, 'agent-old', 16));
    const before = instant(at0 + 3_600_000);
    agentRows.push({ t: 'agents', id: old, name: 'old-agent', status: 'active', suspended_by: null, created_at: before, updated_at: before });
    agentRows.push({ t: 'agent_addresses', id: uuidOf(tag, 'address-old'), agent_id: old, address: 'old@atmark.test', is_primary: true, created_at: before });
  }
  const append = (org: OrgState, epoch: number, index: number): void => {
    const at = instant(at0 + epoch * 3_600_000 + index * 1000 + 1);
    if (org.leaves.length === 0) {
      const genesis = buildOrgLeaf({ log: org.log, seq: 0, saltKey: org.salt }, { kind: 'org.genesis', at });
      org.leaves.push({ json: genesis.json, hash: genesis.hash, row: null });
      return;
    }
    if (org === orgA && agent !== null && index === 0 && (epoch === 2 || epoch === 3)) {
      const context = { log: org.log, seq: org.leaves.length, saltKey: org.salt };
      const built =
        epoch === 2
          ? buildOrgLeaf(context, { kind: 'identity.agent_created', src: { t: 'agents', id: agent, e: 'insert', r: 0 }, at, agentId: agent, name: 'synthetic-agent', status: 'active', suspendedBy: null })
          : buildOrgLeaf(context, {
              kind: 'identity.agent_updated',
              src: { t: 'agents', id: agent, e: 'update', r: 1 },
              at,
              agentId: agent,
              name: 'synthetic-agent',
              status: 'suspended',
              suspendedBy: 'owner',
              changed: ['status', 'suspended_by'],
            });
      org.leaves.push({ json: built.json, hash: built.hash, row: null });
      return;
    }
    if (org === orgA && v5 && agent !== null && ((epoch === 4 && (index === 0 || index === 1)) || (epoch === 5 && index === 0))) {
      const context = { log: org.log, seq: org.leaves.length, saltKey: org.salt };
      const built =
        epoch === 4 && index === 1
          ? buildOrgLeaf(context, {
              kind: 'identity.primary_set',
              src: { t: 'agent_primary_changes', id: primaryChangeId, e: 'insert', r: 0 },
              at,
              agentId: agent,
              cause: 'owner',
              address: SYNTHETIC_PRIMARY_ADDRESS,
            })
          : buildOrgLeaf(context, {
              kind: 'domain.status',
              src: { t: 'custom_domains', id: domainId, e: epoch === 4 ? 'insert' : 'update', r: epoch === 4 ? 0 : 1 },
              at,
              domainId,
              status: epoch === 4 ? 'pending' : 'verified',
              reason: null,
              inbound: epoch === 4 ? 'unknown' : 'ses',
              domain: SYNTHETIC_CUSTOM_DOMAIN,
            });
      org.leaves.push({ json: built.json, hash: built.hash, row: null });
      return;
    }
    const id = uuidOf(tag, `${org.log}:${String(org.leaves.length)}`);
    const action = `probe.e${String(epoch)}`;
    if (org === orgA && options.operatorActions === true && epoch === 1 && index === 0) {
      const built = buildOrgLeaf(
        { log: org.log, seq: org.leaves.length, saltKey: org.salt },
        {
          kind: 'owner.action',
          src: { t: 'owner_actions', id, e: 'insert', r: 0 },
          at,
          action: 'org.abuse_freeze',
          targetId: null,
          sessionId: null,
          operatorActor: SYNTHETIC_OPERATOR_ACTOR,
          operatorReason: '7d:complaint_rate',
        },
      );
      org.leaves.push({ json: built.json, hash: built.hash, row: { t: 'owner_actions', id, action: 'org.abuse_freeze', target_id: null, created_at: at, actor: 'operator' } });
      return;
    }
    const built = buildOrgLeaf(
      { log: org.log, seq: org.leaves.length, saltKey: org.salt },
      { kind: 'owner.action', src: { t: 'owner_actions', id, e: 'insert', r: 0 }, at, action, targetId: null, sessionId: uuidOf(tag, `session:${id}`) },
    );
    org.leaves.push({ json: built.json, hash: built.hash, row: { t: 'owner_actions', id, action, target_id: null, created_at: at } });
  };

  const globals: Buffer[] = [];
  const epochRows: { note: string; globalLeaf: string; closedAt: string; heads: OrgHead[] }[] = [];
  let previousHeads: OrgHead[] = [];
  let previousRoot: Buffer | null = null;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    if (epoch >= startEpoch) for (let i = 0; i < (epoch === startEpoch ? perEpoch + 1 : perEpoch); i += 1) append(orgA, epoch, i);
    if (epoch === 0 || epoch % 2 === 0) append(orgs[1] as OrgState, epoch, 0);
    if (epoch === 0) append(orgs[2] as OrgState, epoch, 0);
    const live = orgs.filter((org) => org.leaves.length > 0);
    const heads = live.map((org) => ({ log: org.log, size: org.leaves.length, root: rootOf(org.leaves.map((leaf) => leaf.hash)) }));
    const closedAt = instant(at0 + epoch * 3_600_000 + 3_599_000);
    const plan = planEpoch({
      epoch,
      closedAt,
      logs: live.map((org) => org.log),
      heads,
      previousHeads,
      globalLeafHashes: globals,
      previousRoot,
      leafHashesOf: (log) => orgs.find((org) => org.log === log)?.leaves.map((leaf) => leaf.hash),
    });
    globals.push(plan.globalLeafHash);
    previousHeads = [...plan.heads];
    previousRoot = plan.globalRoot;
    epochRows.push({ note: signer.sign(plan.checkpointText), globalLeaf: plan.globalLeaf, closedAt, heads: [...plan.heads] });
  }

  const hashesA = orgA.leaves.map((leaf) => leaf.hash);
  const headA = (epoch: number): OrgHead | undefined => (epochRows[epoch] as { heads: OrgHead[] }).heads.find((head) => head.log === orgA.log);

  function bundle(from: number, to: number, bundleOptions: { readonly since?: number } = {}): Record<string, unknown> {
    const startSize = headA(from)?.size ?? 0;
    const endSize = headA(to)?.size ?? startSize;
    const heads = [];
    for (let epoch = from; epoch <= to; epoch += 1) {
      const epochHeads = (epochRows[epoch] as { heads: OrgHead[] }).heads;
      const hashes = epochHeads.map((head) => leafHash(Buffer.from(epochTreeLeaf(epoch, head.log, head.size, hex(head.root)), 'utf8')));
      const position = epochHeads.findIndex((head) => head.log === orgA.log);
      if (position < 0) continue;
      const head = epochHeads[position] as OrgHead;
      heads.push({ epoch, size: head.size, root: hex(head.root), position, epoch_size: hashes.length, epoch_proof: inclusionProof(hashes, position).map(hex) });
    }
    const since = bundleOptions.since;
    const globalsUpTo = globals.slice(0, Math.max(to, since ?? to) + 1);
    let link: Record<string, unknown> | null = null;
    if (since !== undefined && (since < from || since > to)) {
      const forward = since < from;
      const [gFrom, gTo] = forward ? [since + 1, from + 1] : [to + 1, since + 1];
      const sinceHead = headA(since);
      const [oFrom, oTo] = forward ? [sinceHead?.size ?? 0, startSize] : [endSize, sinceHead?.size ?? 0];
      link = {
        epoch: since,
        direction: forward ? 'forward' : 'backward',
        global: { from_size: gFrom, to_size: gTo, proof: consistencyProof(globalsUpTo, gFrom, gTo).map(hex) },
        org: sinceHead === undefined ? null : { from_size: oFrom, to_size: oTo, proof: consistencyProof(hashesA, oFrom, oTo).map(hex) },
      };
    }
    const bundleLeaves = orgA.leaves.slice(startSize, endSize);
    // 판 5 원천 행 — 범위의 잎이 가리키는 행만(서버와 같다). 그런 잎·행이 있으면 판 5 를 요구한다.
    const referencedV5 = new Set(
      bundleLeaves.flatMap((leaf) => {
        const src = (JSON.parse(leaf.json) as { src?: { t?: unknown; id?: unknown } | null }).src;
        return src === null || src === undefined ? [] : [`${String(src.t)}:${String(src.id)}`];
      }),
    );
    // 서버와 같다: removed 가 아닌 도메인 행은 늘 싣고(보안 리뷰 M3), 대표 주소 행은 범위 잎이 가리킬 때만.
    const v5SourceRows = Object.entries(v5Rows).flatMap(([key, row]) => (row['t'] === 'custom_domains' || referencedV5.has(key) ? [{ ...row }] : []));
    // 판 6 — 범위에 운영자 행위자 행이 있으면(서버 `hasOperatorActions` 와 같다).
    const hasOperator = bundleLeaves.some((leaf) => leaf.row?.['actor'] === 'operator');
    const minVersion = hasOperator ? 6 : v5SourceRows.length > 0 ? 5 : 4;
    return {
      format: 'atmark-tlog-bundle/v2',
      ...(identity === undefined ? (hasOperator ? { min_verifier_version: 6 } : {}) : { min_verifier_version: minVersion, identity_since: identity }),
      origin: TLOG_ORIGIN,
      vkey: signer.vkey,
      exported_at: '2026-09-24T12:00:00.000Z',
      org: { log: orgA.log, salt_key: hex(orgA.salt), shredded: false },
      range: { from_epoch: from, to_epoch: to },
      continuation: null,
      start: { size: startSize, frontier: frontierOf(hashesA, startSize).map((node) => ({ height: node.height, hash: hex(node.hash) })) },
      leaves: bundleLeaves.map((leaf, index) => ({ id: String(startSize + index + 1), seq: startSize + index, leaf: leaf.json })),
      heads,
      checkpoints: epochRows.slice(from, to + 1).map((row, index) => ({
        epoch: from + index,
        note: row.note,
        global_leaf: row.globalLeaf,
        inclusion: inclusionProof(globalsUpTo, from + index, from + index + 1).map(hex),
      })),
      global_consistency: Array.from({ length: to - from }, (_, index) => ({
        from: from + index + 1,
        to: from + index + 2,
        proof: consistencyProof(globalsUpTo, from + index + 1, from + index + 2).map(hex),
      })),
      // 서버와 같다: from 헤드가 없으면(로그가 범위 안에서 시작) 조직 일관성 증명을 싣지 않는다 — 잎에서 헤드를 다시 계산한다.
      org_consistency:
        headA(from) === undefined ? null : { from_size: startSize, to_size: endSize, proof: consistencyProof(hashesA, startSize, endSize).map(hex) },
      link,
      sources: {
        window_start: (epochRows[from] as { closedAt: string }).closedAt,
        window_end: (epochRows[to] as { closedAt: string }).closedAt,
        rows: [...bundleLeaves.flatMap((leaf) => (leaf.row === null ? [] : [leaf.row])), ...agentRows.map((row) => ({ ...row })), ...v5SourceRows],
      },
      anchors: [],
      anchor_keys: [],
    };
  }

  return { signer, log: orgA.log, epochs, identityAgent: agent, bundle };
}
