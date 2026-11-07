/**
 * 공개 응답의 **필드 이름·판정 코드**에 공급자와 내부 휴리스틱이 새지 않는다 (가림 정책 — `src/api/public-codes.ts`).
 *
 * `public-detail-veil.test.ts` 는 사람용 문장(`detail`·안내)을 본다. 여기는 기계가 읽는 쪽이다:
 *   ① 판정 사유 표가 사유 유니온 전부를 덮고, 공개 이름에 금지 토큰이 없다.
 *   ② `resolution_reason` 은 알려진 공개 값만 나가고 전송단 오류 원문은 `send_failed` 로 접힌다.
 *   ③ `POST /v1/messages`(발송·재호출·거부) 응답 본문의 키와 코드에 금지 토큰이 없다.
 *   ④ 공개 모듈(`src/api/**`·`src/mcp/**`)의 응답 객체 리터럴에 금지 토큰이 들어간 snake_case 키가 없다.
 *
 * audit 행·투명성 로그·로그는 내부 이름 그대로다 — 이 검사는 경계만 본다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { toApiResponse } from '../../../src/api/outbound-http';
import type { OutboundMessageSnapshot } from '../../../src/api/outbound-store';
import {
  PUBLIC_REASON_CODES,
  PUBLIC_RESOLUTION_OTHER,
  PUBLIC_RESOLUTION_SEND_FAILED,
  publicReasonCode,
  publicReasons,
  publicResolutionReason,
} from '../../../src/api/public-codes';
import { toAgentId } from '../../../src/db/schema';
import { deny, toDeniedDecision, type DecisionReason } from '../../../src/policy/types';

const ROOT = join(__dirname, '..', '..', '..');

/** snake_case 코드·키를 토큰으로 쪼갰을 때 하나라도 나오면 안 되는 말. */
const FORBIDDEN_TOKENS = new Set(['ses', 'sqs', 'sns', 'aws', 's3', 'kms', 'lambda', 'warmup', 'route', 'manifest', 'lease', 'postgres']);

function forbiddenTokens(code: string): string[] {
  return code
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => FORBIDDEN_TOKENS.has(token));
}

/** `types.ts` 원문에서 유니온의 문자열 리터럴을 모은다(참조한 유니온까지). 표가 컴파일 타입과 따로 한 번 더 대조된다. */
function unionLiterals(source: string, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const match = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  if (match === null) return [];
  const body = (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const literals = [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] ?? '');
  const refs = [...body.matchAll(/\|?\s*\b([A-Z][A-Za-z]+Reason)\b/g)].map((m) => m[1] ?? '');
  return [...literals, ...refs.flatMap((ref) => unionLiterals(source, ref, seen))];
}

describe('판정 사유 → 공개 코드', () => {
  const types = readFileSync(join(ROOT, 'src/policy/types.ts'), 'utf8');
  const all = [...new Set(unionLiterals(types, 'DecisionReason'))];

  it('표가 사유 유니온 전부를 덮는다(원문 대조)', () => {
    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((code) => !Object.hasOwn(PUBLIC_REASON_CODES, code))).toEqual([]);
    expect(Object.keys(PUBLIC_REASON_CODES).sort()).toEqual([...all].sort());
  });

  it('공개 이름에 공급자·내부 휴리스틱 토큰이 없다', () => {
    const leaks = Object.entries(PUBLIC_REASON_CODES).filter(([, value]) => forbiddenTokens(value).length > 0);
    expect(leaks).toEqual([]);
  });

  it('내부 이름을 드러내는 사유만 바꾼다 — 나머지는 그대로다', () => {
    const renamed = Object.entries(PUBLIC_REASON_CODES).filter(([internal, value]) => internal !== value);
    expect(Object.fromEntries(renamed)).toEqual({
      ses_account_level_suppression: 'suppression_list',
      warmup_daily_cap: 'daily_send_limit',
      // 고객 도메인 워밍업(ADR-0014) — 같은 내부 휴리스틱이라 같은 중립 이름.
      domain_warmup_daily_cap: 'daily_send_limit',
      unregistered_route: 'evaluation_error',
      // 위험 보류(ADR-0016) — 탐지 계열은 내부 휴리스틱이다. 에이전트에게는 중립 이름 하나.
      tainted_context: 'risk_review',
      dlp_atmark_credential: 'risk_review',
      dlp_third_party_secret: 'risk_review',
      dlp_verification_code: 'risk_review',
      dlp_secret_link: 'risk_review',
      dlp_inbound_copy: 'risk_review',
      dlp_scan_limit: 'risk_review',
    });
    // 바꾼 이름은 기존 공개 코드와 겹치거나(재사용) 새 중립 이름이다 — 업그레이드 안내가 붙는 `plan_daily_cap` 과 섞지 않는다.
    expect(publicReasonCode('warmup_daily_cap')).not.toBe(publicReasonCode('plan_daily_cap'));
    expect(publicReasonCode('warmup_daily_cap')).not.toBe(publicReasonCode('rate_limit_per_day'));
  });

  it('배열은 순서를 지키고 겹침을 하나로 접는다 · 옛 이름은 그대로 둔다', () => {
    expect(publicReasons(['suppression_list', 'ses_account_level_suppression', 'rate_limit_per_minute'])).toEqual([
      'suppression_list',
      'rate_limit_per_minute',
    ]);
    expect(publicReasons(['ses_account_level_suppression', 'suppression_list'])).toEqual(['suppression_list']);
    expect(publicReasons(['recipient_not_in_allowlist'])).toEqual(['recipient_not_in_allowlist']);
    expect(publicReasonCode('toString')).toBe('toString');
  });
});

describe('resolution_reason → 공개 값', () => {
  it.each([
    [null, null],
    ['sent', 'sent'],
    ['approval_rejected', 'approval_rejected'],
    ['approval_expired', 'approval_expired'],
    ['failed:SES throttled', PUBLIC_RESOLUTION_SEND_FAILED],
    ['failed:AccessDenied: User arn:aws:sts::123456789012:assumed-role/x is not authorized', PUBLIC_RESOLUTION_SEND_FAILED],
    ['failed:missing_message_row', PUBLIC_RESOLUTION_SEND_FAILED],
    ['failed:unknown', PUBLIC_RESOLUTION_SEND_FAILED],
    ['release_denied:rate_limit_per_minute', 'release_denied:rate_limit_per_minute'],
    ['release_denied:ses_account_level_suppression', 'release_denied:suppression_list'],
    ['release_denied:warmup_daily_cap', 'release_denied:daily_send_limit'],
    ['release_denied:unregistered_route', 'release_denied:evaluation_error'],
    ['release_denied:release_window_expired', 'release_denied:release_window_expired'],
    ['release_denied:Some raw text', PUBLIC_RESOLUTION_OTHER],
    ['something_new', PUBLIC_RESOLUTION_OTHER],
  ] as const)('%s → %s', (stored, expected) => {
    expect(publicResolutionReason(stored)).toBe(expected);
  });

  it('공개 값 어디에도 금지 토큰이 없다', () => {
    const outputs = Object.keys(PUBLIC_REASON_CODES).map((code) => publicResolutionReason(`release_denied:${code}`) ?? '');
    expect(outputs.filter((value) => forbiddenTokens(value).length > 0)).toEqual([]);
  });
});

describe('POST /v1/messages 응답 본문', () => {
  const NOW = new Date('2026-09-28T00:00:00.000Z');
  const stamp = { policyVersion: 1, policyVersionId: '22222222-2222-4222-8222-222222222222', evaluatedAt: NOW };
  const MESSAGE_ID = '274eb50e-fe72-48ff-bdf5-a7c01c123cc9';

  function keysAndCodes(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((item) => keysAndCodes(item, out));
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        out.push(key);
        keysAndCodes(inner, out);
      }
    } else if (typeof value === 'string' && /^[a-z][a-z0-9_:]*$/.test(value)) out.push(value);
    return out;
  }

  const denied = toDeniedDecision(deny(['ses_account_level_suppression', 'warmup_daily_cap', 'unregistered_route']), stamp);

  it('발송 성공은 공급자 중립 이름 `provider_message_id` 로 전송단 id 를 싣는다', () => {
    const response = toApiResponse({
      kind: 'sent',
      messageId: MESSAGE_ID,
      messageIdHeader: '<x@atmark.ai>',
      sesMessageId: 'provider-id-1',
      decision: denied,
      settled: true,
    });
    expect(response.body['provider_message_id']).toBe('provider-id-1');
    expect(response.body).not.toHaveProperty('ses_message_id');
    expect(keysAndCodes(response.body).filter((code) => forbiddenTokens(code).length > 0)).toEqual([]);
  });

  it('403 policy_denied 의 decision.reasons 는 공개 이름이다(MCP 도 이 본문을 옮긴다)', () => {
    const response = toApiResponse({ kind: 'denied', messageId: MESSAGE_ID, decision: denied });
    expect(response.status).toBe(403);
    expect((response.body['decision'] as { reasons: unknown }).reasons).toEqual(['suppression_list', 'daily_send_limit', 'evaluation_error']);
    expect(keysAndCodes(response.body).filter((code) => forbiddenTokens(code).length > 0)).toEqual([]);
  });

  it.each(['sent', 'failed', 'denied', 'pending'] as const)('재호출(%s)도 같은 이름이다', (status) => {
    const message: OutboundMessageSnapshot = {
      id: MESSAGE_ID,
      agentId: toAgentId('0123456789abcdef0123456789abcdef'),
      status,
      messageIdHeader: '<x@atmark.ai>',
      idempotencyKey: 'k',
      requestHash: 'h',
      recipientCount: 1,
      sesMessageId: status === 'sent' ? 'provider-id-1' : null,
      failureReason: status === 'failed' ? 'SES throttled' : null,
      gated: true,
    };
    const response = toApiResponse({ kind: 'replayed', message });
    expect(response.body).toHaveProperty('provider_message_id');
    expect(response.body).not.toHaveProperty('ses_message_id');
    expect(JSON.stringify(response.body)).not.toMatch(/\bSES\b|throttl/i);
    expect(keysAndCodes(response.body).filter((code) => forbiddenTokens(code).length > 0)).toEqual([]);
  });
});

describe('공개 모듈의 응답 키', () => {
  function walk(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  }
  /** 운영자용 호출(로그·메트릭) 안의 키는 밖으로 나가지 않는다. */
  const SKIP_CALLS = new Set(['log', 'countMetric', 'emitMetric', 'record', 'reportBudget']);

  function snakeKeys(file: string): { readonly file: string; readonly line: number; readonly key: string }[] {
    const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const out: { file: string; line: number; key: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        if (name !== null && SKIP_CALLS.has(name)) return;
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        const key = node.name.text;
        if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(key)) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, key });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  it('src/api·src/mcp 의 snake_case 객체 키에 공급자 토큰이 없다', () => {
    // 번역 표 자체(`public-codes.ts`)는 내부 이름을 **키로** 가져야 한다 — 값은 위에서 따로 검사했다.
    const files = [...walk('src/api'), ...walk('src/mcp')].filter((file) => file !== join('src', 'api', 'public-codes.ts'));
    const keys = files.flatMap(snakeKeys);
    expect(keys.length).toBeGreaterThan(100);
    const leaks = keys.filter(({ key }) => forbiddenTokens(key).length > 0).map(({ file, line, key }) => `${file}:${String(line)} ${key}`);
    expect(leaks).toEqual([]);
  });
});
