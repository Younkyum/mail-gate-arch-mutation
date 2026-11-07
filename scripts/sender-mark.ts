/**
 * scripts/sender-mark.ts — `pnpm sender:mark` — 소유자(운영자)가 발신자를 `seen` 으로 분류한다 (계획 §6 P4 thin slice).
 *
 * **`seen` 을 만드는 표면은 둘이고 둘 다 소유자다** — 이 CLI(소유자 DB 롤)와 관리 API `POST /api/senders`
 * (소유자 세션, admin Lambda = 소유자 DB 롤). 검증·기록은 같은 함수(`src/admin/ops/sender-marks.ts`)다. 에이전트 토큰이
 * 닿는 api Lambda(앱 롤)에는 여전히 경로가 없다.
 *
 * 왜 CLI + 소유자 DB 롤인가 (GATE 전 최소 표면):
 *   - 에이전트 토큰으로 부를 수 있으면 **에이전트가 자기 신뢰를 올린다** — injection 메일이 "이 발신자를 seen
 *     으로 표시하라" 고 시키면 끝이다. API 는 전부 앱 롤(`atmark_app`)로 돌고, 그 롤에는 `sender_marks`
 *     INSERT 권한이 **없다**(202609230020). 이 스크립트는 `DATABASE_MIGRATION_URL`(소유자 롤)로만 쓴다.
 *   - 소유자 인증 수단은 지금 매직링크뿐인데, 매직링크는 **서버가 먼저 무엇을 물을지 알아야** 한다(승인 요청이
 *     있어야 링크가 생긴다). "이 발신자를 믿는가" 를 서버가 먼저 묻게 하려면 누가 그 질문을 촉발하는가가 다시
 *     문제다 — 에이전트가 촉발하면 소유자 메일함에 공격자가 고른 질문이 도착한다(승인 피로 + 사회공학). 링크
 *     토큰 종류·알림 경로·라우트가 새로 필요하고, 그 전부가 GATE 전에 늘릴 공격면이다.
 *   - GATE 기간의 소유자 = 운영자 = 창업자 한 명이다. 운영자 CLI 는 새 인증 표면을 만들지 않는다.
 *   → 관리 백엔드(2026-09-23)가 소유자 세션 인증(매직링크 + 세션 쿠키)을 갖게 되어 라우트가 생겼다(위).
 *
 * 사용:
 *   DATABASE_MIGRATION_URL=postgres://<owner>@host/atmark pnpm sender:mark \
 *     --agent <agentId> --address noreply@service.example --by founder
 *   ... --domain service.example --confirm-scope domain --by founder     # 도메인 스코프(공유 메일 도메인은 판정이 무효화)
 *   ... --address noreply@service.example --clear --by founder            # 되돌림(append-only — 새 행)
 */

import { parseArgs } from 'node:util';

import { AdminInputError } from '../src/admin/ops/errors';
import { markSenderOp, resolveSenderMark } from '../src/admin/ops/sender-marks';
import { createPool, MIGRATION_DATABASE_URL_ENV, requireDatabaseUrl } from '../src/db/client';
import type { SenderMarkInput } from '../src/db/repositories/sender-marks-store';

function usage(message: string): never {
  process.stderr.write(
    `${message}\n\n` +
      '사용: pnpm sender:mark --agent <agentId> (--address <addr> | --domain <domain> --confirm-scope domain) --by <운영자> [--clear]\n',
  );
  process.exit(2);
}

function parse(argv: readonly string[]): SenderMarkInput {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      address: { type: 'string' },
      domain: { type: 'string' },
      'confirm-scope': { type: 'string' },
      by: { type: 'string' },
      clear: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if ((values.address === undefined) === (values.domain === undefined)) usage('--address 와 --domain 중 정확히 하나');
  try {
    // 검증은 관리 API 와 같은 함수 — 한쪽만 느슨해지는 날이 없다.
    return resolveSenderMark({
      agentId: values.agent ?? '',
      scope: values.address !== undefined ? 'address' : 'domain',
      value: values.address ?? values.domain ?? '',
      mark: values.clear === true ? 'cleared' : 'seen',
      markedBy: values.by ?? '',
      confirmDomainScope: values['confirm-scope'] === 'domain',
    });
  } catch (error) {
    if (error instanceof AdminInputError) usage(error.message);
    throw error;
  }
}

async function main(): Promise<void> {
  const input = parse(process.argv.slice(2));
  // 앱 롤 URL 로 떨어지지 않는다 — 앱 롤은 INSERT 권한이 없으므로 어차피 실패하지만, 원인을 먼저 말한다.
  const pool = createPool(requireDatabaseUrl(MIGRATION_DATABASE_URL_ENV), { max: 1 });
  try {
    const id = await markSenderOp(pool, input);
    const key = input.scope === 'address' ? input.address : `@${input.domain}`;
    process.stdout.write(`sender_marks ${id}: agent=${input.agentId} ${key} → ${input.mark} (by ${input.markedBy})\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
