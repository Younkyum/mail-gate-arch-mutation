/**
 * src/identity/primary.ts — **대표 주소 포인터 모델**(ADR-0014).
 *
 * `agent_addresses.is_primary` 는 @atmark.ai **앵커**다(불변). "대표 주소" 는 `agent_primary_changes` 의 마지막 선택이고, 판정은 SQL
 * `atmark_agent_primary_address(agent)` 와 그 TS 거울 `effectivePrimaryOf`(통합 테스트가 같은 표를 본다)다.
 *
 * 앵커 이름은 `ax--` + 암호학적 난수 20자(base32) — 에이전트 id 에서 파생하지 않는다.
 */

import { randomBytes } from 'node:crypto';

import {
  ANCHOR_LOCAL_PART_PATTERN,
  ANCHOR_LOCAL_PART_PREFIX,
  ANCHOR_PROVISION_MAX_ATTEMPTS,
  ANCHOR_RANDOM_LENGTH,
  anchorDormantOf,
  DOMAIN_SQLSTATES,
  effectivePrimaryOf,
  type CustomDomainStatus,
  type PrimaryFacts,
} from '../domains/contract';

import { AGENT_ADDRESS_DOMAIN } from './address';

export { anchorDormantOf, effectivePrimaryOf, type PrimaryFacts };

/** `pg` 의 `query` 하나만 쓴다(풀 · 클라이언트 모두). */
export interface PrimaryDb {
  query<R extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: R[] }>;
}

/** RFC 4648 base32 알파벳(소문자) — DB 모양 `[a-z2-7]` 와 같다. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 바이트 → base32 소문자(패딩 없음). 비트를 앞에서부터 5개씩 — 앞 20자는 앞 100비트다. */
function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** 난수 원천 — 테스트가 충돌을 일부러 만들 때만 바꾼다. 기본은 `crypto.randomBytes`(CSPRNG). */
export type RandomSource = (size: number) => Uint8Array;

/** 앵커 로컬파트 하나 — `ax--` + base32 20자(13바이트 중 앞 100비트). */
export function generateAnchorLocalPart(random: RandomSource = randomBytes): string {
  const bytes = random(Math.ceil((ANCHOR_RANDOM_LENGTH * 5) / 8));
  const local = `${ANCHOR_LOCAL_PART_PREFIX}${base32(bytes).slice(0, ANCHOR_RANDOM_LENGTH)}`;
  if (!ANCHOR_LOCAL_PART_PATTERN.test(local)) throw new Error('앵커 로컬파트 모양이 아니다(난수 원천 결함)');
  return local;
}

export function isAnchorLocalPart(localPart: string): boolean {
  return ANCHOR_LOCAL_PART_PATTERN.test(localPart);
}

/** 앵커 이름 재시도가 상한을 넘었다 — 난수 원천 결함이거나 이름 공간이 오염됐다(운영자 확인). */
export class AnchorNameExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`앵커 이름이 ${String(attempts)}번 연속 겹쳤다 — 난수 원천 또는 이름 공간을 확인하라`);
    this.name = 'AnchorNameExhaustedError';
  }
}

function sqlStateOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

export interface ProvisionedCustomPrimary {
  readonly anchorId: string;
  readonly anchorAddress: string;
  readonly customId: string;
  readonly changeId: string;
  /** 몇 번째 난수에서 됐는가(1 = 첫 시도). */
  readonly attempts: number;
}

/**
 * 고객 도메인 주소를 대표로 하는 새 에이전트의 주소들(앵커 · 고객 별칭 · 선택)을 **호출자의 트랜잭션 안에서** 정의자 함수
 * `atmark_provision_custom_primary` 로 만든다. 앵커 이름 충돌(P0A10)만 SAVEPOINT 로 되돌리고 새 난수로 다시 한다(상한 있음). 그 밖의 오류
 * (고객 주소 쪽 — 사용자가 고른 주소의 문제)는 그대로 던지고 호출자가 번역한다.
 */
export async function provisionCustomPrimary(
  client: PrimaryDb,
  input: { readonly agentId: string; readonly customAddress: string },
  options: { readonly random?: RandomSource; readonly maxAttempts?: number } = {},
): Promise<ProvisionedCustomPrimary> {
  const maxAttempts = options.maxAttempts ?? ANCHOR_PROVISION_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const anchorLocal = generateAnchorLocalPart(options.random);
    await client.query('SAVEPOINT anchor_provision');
    try {
      const result = await client.query<{ anchor_id: string; custom_id: string; change_id: string }>(
        'SELECT anchor_id::text, custom_id::text, change_id::text FROM atmark_provision_custom_primary($1, $2, $3)',
        [input.agentId, anchorLocal, input.customAddress],
      );
      await client.query('RELEASE SAVEPOINT anchor_provision');
      const row = result.rows[0];
      if (row === undefined) throw new Error('atmark_provision_custom_primary 가 행을 돌려주지 않았다');
      return { anchorId: row.anchor_id, anchorAddress: `${anchorLocal}@${AGENT_ADDRESS_DOMAIN}`, customId: row.custom_id, changeId: row.change_id, attempts: attempt };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT anchor_provision');
      if (sqlStateOf(error) !== DOMAIN_SQLSTATES.anchorNameConflict) throw error;
    }
  }
  throw new AnchorNameExhaustedError(maxAttempts);
}

/** 유효 대표 주소(SQL 판정). 무효한 고객 선택이면 `null`(에이전트는 "주소 없음"). */
export async function loadEffectivePrimary(db: PrimaryDb, agentId: string): Promise<string | null> {
  const result = await db.query<{ address: string | null }>('SELECT atmark_agent_primary_address($1) AS address', [agentId]);
  return result.rows[0]?.address ?? null;
}

/** TS 판정(`effectivePrimaryOf`)의 재료를 DB 에서 — SQL 판정과 같은 행을 본다(통합 테스트의 TS = SQL 대조). */
export async function loadPrimaryFacts(db: PrimaryDb, agentId: string): Promise<PrimaryFacts> {
  const anchor = await db.query<{ id: string; address: string }>(
    'SELECT id::text AS id, address FROM agent_addresses WHERE agent_id = $1 AND is_primary AND retired_at IS NULL',
    [agentId],
  );
  const last = await db.query<{ address_id: string }>(
    'SELECT address_id::text AS address_id FROM agent_primary_changes WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [agentId],
  );
  const lastChoice = last.rows[0] === undefined ? null : { addressId: last.rows[0].address_id };
  let target: PrimaryFacts['target'] = null;
  if (lastChoice !== null) {
    const row = await db.query<{ address: string; domain: string; retired: boolean; statuses: CustomDomainStatus[] }>(
      `SELECT x.address, x.domain, x.retired_at IS NOT NULL AS retired,
              coalesce((SELECT array_agg(d.status ORDER BY d.status) FROM custom_domains d
                         WHERE d.organization_id = a.organization_id AND d.domain = x.domain), ARRAY[]::text[]) AS statuses
         FROM agent_addresses x JOIN agents a ON a.id = x.agent_id
        WHERE x.id = $1 AND x.agent_id = $2`,
      [lastChoice.addressId, agentId],
    );
    const found = row.rows[0];
    if (found !== undefined) target = { address: found.address, domain: found.domain, retired: found.retired, domainStatuses: found.statuses };
  }
  return { anchor: anchor.rows[0] ?? null, lastChoice, target };
}
