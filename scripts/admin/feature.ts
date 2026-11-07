#!/usr/bin/env tsx
/**
 * scripts/admin/feature.ts — **운영자 기능 허용 목록**(`org_features`, ADR-0014 결정 11 · M13). 표는 기본 비어 있고 **쓰기는 소유자 롤뿐**이다(admin·틱은
 * 읽기만). 고객 도메인(`custom_domains`)은 이 목록에 없는 조직이면 DB 가 행 만들기를 거부한다(P0A07).
 *
 *   pnpm admin:feature --org <조직 id> --enable custom_domains [--by <운영자>] [--yes]
 *   pnpm admin:feature --org <조직 id> --disable custom_domains [--yes]
 *   pnpm admin:feature --list [--org <조직 id>]
 *
 *   - `--enable` — 멱등(이미 있으면 `exists`). `enabled_by` = `admin:feature:<운영자>`(코드 모양 — 자유 문장·이메일 없음).
 *   - `--disable` — 행을 지운다(소유자 롤 DELETE). **이미 만든 도메인 행은 그대로**다 — 끄기는 새 도메인 만들기만 막는다(틱 · 관문은 행 상태를 본다).
 *     조직의 도메인을 멈추려면 `pnpm admin:domain --suspend` 를 쓴다.
 *   - `--list` — 허용된 조직(또는 한 조직)의 기능 · 시각 · 행위자.
 * 소유자 롤(`DATABASE_MIGRATION_URL`)로만 붙고, 운영 DB 면 변경 전 확인(`--yes`).
 */

import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { ORGANIZATION_ID_PATTERN } from '../../src/admin/ops/agents';
import { CUSTOM_DOMAINS_FEATURE } from '../../src/domains/contract';
import { AI_WATCH_FEATURE } from '../../src/inbound/ai-watch/contract';
import { actorOf, AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps, type TargetInfo } from './common';

const USAGE = [
  'pnpm admin:feature --org <조직 id> --enable custom_domains|ai_mail_watch [--by <운영자>] [--yes]',
  'pnpm admin:feature --org <조직 id> --disable custom_domains|ai_mail_watch [--yes]',
  'pnpm admin:feature --list [--org <조직 id>]',
].join('\n');

/** `org_features.feature` CHECK 와 같다. */
export const FEATURES = [CUSTOM_DOMAINS_FEATURE, AI_WATCH_FEATURE] as const;
export type Feature = (typeof FEATURES)[number];

export type FeatureCommand =
  | { readonly kind: 'enable'; readonly org: string; readonly feature: Feature; readonly by: string | undefined; readonly yes: boolean }
  | { readonly kind: 'disable'; readonly org: string; readonly feature: Feature; readonly yes: boolean }
  | { readonly kind: 'list'; readonly org: string | null };

function featureOf(raw: string): Feature {
  const value = raw.trim().toLowerCase();
  if (!(FEATURES as readonly string[]).includes(value)) throw new AdminInputError(`알 수 없는 기능: ${raw} (${FEATURES.join(' · ')})\n${USAGE}`);
  return value as Feature;
}

function organizationId(raw: string | undefined): string {
  const org = raw?.trim().toLowerCase() ?? '';
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid)다.\n${USAGE}`);
  return org;
}

/** `enabled_by` 칸 모양(`^[a-z0-9][a-z0-9_.:-]{0,63}$`)으로. */
export function enabledByOf(actor: string): string {
  const cleaned = actor.toLowerCase().replace(/[^a-z0-9_.:-]/g, '-').slice(0, 64);
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `x${cleaned}`.slice(0, 64);
}

/** argv → 명령. 형식 오류는 접속 전에 던진다(exit 2). `null` 이면 도움말. */
export function parseFeatureArgs(argv: readonly string[]): FeatureCommand | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      org: { type: 'string' },
      enable: { type: 'string' },
      disable: { type: 'string' },
      list: { type: 'boolean', default: false },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return null;
  const modes = [values.enable !== undefined, values.disable !== undefined, values.list].filter(Boolean).length;
  if (modes !== 1) throw new AdminInputError(`--enable · --disable · --list 중 하나만.\n${USAGE}`);
  if (values.list) return { kind: 'list', org: values.org === undefined ? null : organizationId(values.org) };
  if (values.enable !== undefined) return { kind: 'enable', org: organizationId(values.org), feature: featureOf(values.enable), by: values.by, yes: values.yes };
  return { kind: 'disable', org: organizationId(values.org), feature: featureOf(values.disable ?? ''), yes: values.yes };
}

export async function feature(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const command = parseFeatureArgs(argv);
  if (command === null) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  return withAdminConnection(deps, ({ pool, target }) => runFeature(pool, target, command, deps));
}

/** 명령 하나를 이 풀(소유자 롤)에서. 테스트는 롤백할 트랜잭션의 풀을 준다. */
export async function runFeature(pool: Pool, target: TargetInfo, command: FeatureCommand, deps: AdminDeps): Promise<number> {
  if (command.kind === 'list') {
    const rows = await pool.query<{ organization_id: string; feature: string; enabled_at: Date; enabled_by: string }>(
      `SELECT organization_id::text AS organization_id, feature, enabled_at, enabled_by FROM org_features
        WHERE $1::uuid IS NULL OR organization_id = $1::uuid ORDER BY enabled_at, organization_id`,
      [command.org],
    );
    for (const row of rows.rows) deps.io.out(`${row.organization_id} ${row.feature} ${row.enabled_at.toISOString()} ${row.enabled_by}`);
    if (rows.rows.length === 0) deps.io.err('허용된 조직이 없다.');
    return EXIT_OK;
  }
  const exists = await pool.query('SELECT 1 FROM organizations WHERE id = $1', [command.org]);
  if ((exists.rowCount ?? 0) === 0) throw new AdminInputError(`조직이 없다: ${command.org}`, 'organization_not_found');
  if (command.kind === 'enable') {
    const enabledBy = enabledByOf(actorOf('admin:feature', command.by, deps.env));
    await confirmProduction(target, `기능 허용 ${command.feature} → 조직 ${command.org}`, command.yes, deps.io);
    const inserted = await pool.query(
      `INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, $2, $3) ON CONFLICT (organization_id, feature) DO NOTHING`,
      [command.org, command.feature, enabledBy],
    );
    deps.io.out(`feature ${command.org} ${command.feature} ${(inserted.rowCount ?? 0) > 0 ? 'enabled' : 'exists'}`);
    return EXIT_OK;
  }
  await confirmProduction(target, `기능 끄기 ${command.feature} → 조직 ${command.org}(이미 만든 도메인 행은 그대로)`, command.yes, deps.io);
  const deleted = await pool.query('DELETE FROM org_features WHERE organization_id = $1 AND feature = $2', [command.org, command.feature]);
  deps.io.out(`feature ${command.org} ${command.feature} ${(deleted.rowCount ?? 0) > 0 ? 'disabled' : 'absent'}`);
  const live = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM custom_domains WHERE organization_id = $1 AND status <> 'removed'`, [command.org]);
  if ((live.rows[0]?.n ?? 0) > 0) {
    deps.io.err(`⚠ 이 조직의 살아 있는 도메인 ${String(live.rows[0]?.n)}개는 그대로다 — 멈추려면 \`pnpm admin:domain --suspend --domain <id>\`.`);
  }
  return EXIT_OK;
}

if (isMain(import.meta.url)) await runAdminMain((argv, deps) => feature(argv, deps));
