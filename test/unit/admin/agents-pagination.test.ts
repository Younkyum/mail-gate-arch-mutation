/**
 * 에이전트 목록 쪽 나누기(확장성 P1 R-9) · 채널 이름(R-5) · 조직 키 권한 해석(R-6) — DB 없는 규칙.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 쿼리가 없으면 `null`(콘솔 옛 배열 모양) · 하나라도 있으면 쪽 요청 · 조직 키 표면은 늘 쪽 요청.
 *   - `limit` 1–100 정수만(0·101·소수·음수·문자 → `invalid_limit`).
 *   - 커서는 앞 응답의 모양만(위조 JSON·키 추가·시각/ID 모양 아님·base64url 아님 → `invalid_cursor`) · 왕복하면 같은 값.
 *   - `q` 1–64자(앞뒤 공백 제거 뒤) · 제어 문자 거부 → `invalid_query`.
 *   - 채널은 `email` 하나.
 *   - 조직 키 권한: 필수 · 비지 않음 · 알려진 이름만 · 중복 합침 · 정규 순서.
 */

import { describe, expect, it } from 'vitest';

import { CHANNELS, isChannel } from '../../../src/admin/channels';
import { decodeAgentCursor, encodeAgentCursor, resolveAgentPageQuery } from '../../../src/admin/ops/agents';
import { AdminInputError } from '../../../src/admin/ops/errors';
import { resolveOrgKeyCapabilities } from '../../../src/admin/ops/org-keys';
import { capabilitiesFromBody } from '../../../src/admin/ops/agents';

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof AdminInputError) return error.code;
    throw error;
  }
}

const AT = '2026-09-25T01:02:03.456789Z';
const ID = 'a'.repeat(32);

describe('에이전트 목록 쪽 요청 해석', () => {
  it('쿼리가 없으면 null(옛 배열 모양) · 모르는 키만 있어도 null', () => {
    expect(resolveAgentPageQuery({})).toBeNull();
    expect(resolveAgentPageQuery({ _: '123' })).toBeNull();
  });

  it('always 면 쿼리 없이도 기본 쪽(50)', () => {
    expect(resolveAgentPageQuery({}, true)).toEqual({ limit: 50, cursor: null, q: null });
  });

  it('limit 경계', () => {
    expect(resolveAgentPageQuery({ limit: '1' })?.limit).toBe(1);
    expect(resolveAgentPageQuery({ limit: '100' })?.limit).toBe(100);
    for (const bad of ['0', '101', '-1', '1.5', 'abc', '', '0100', '1e2']) {
      expect(codeOf(() => resolveAgentPageQuery({ limit: bad })), bad).toBe('invalid_limit');
    }
  });

  it('커서 왕복 · 빈 커서는 첫 쪽', () => {
    const cursor = encodeAgentCursor(AT, ID);
    expect(decodeAgentCursor(cursor)).toEqual({ createdAt: AT, id: ID });
    expect(resolveAgentPageQuery({ cursor })?.cursor).toEqual({ createdAt: AT, id: ID });
    expect(resolveAgentPageQuery({ cursor: '' })?.cursor).toBeNull();
  });

  it('위조·모양 아닌 커서는 invalid_cursor', () => {
    const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const bad = [
      'not base64!',
      b64('x'),
      b64([AT, ID]),
      b64({ c: AT }),
      b64({ c: AT, i: ID, o: 'other-org' }),
      b64({ c: '2026-09-25T01:02:03Z', i: ID }),
      b64({ c: AT, i: 'A'.repeat(32) }),
      b64({ c: AT, i: `${ID}' OR 1=1` }),
      b64({ c: '2026-13-45T99:99:99.000000Z', i: ID }),
      b64({ c: '2026-02-30T00:00:00.000000Z', i: ID }),
      Buffer.from('{not json', 'utf8').toString('base64url'),
      'a'.repeat(201),
    ];
    for (const cursor of bad) expect(codeOf(() => resolveAgentPageQuery({ cursor })), cursor).toBe('invalid_cursor');
  });

  it('q — 공백 제거 · 64자 · 제어 문자', () => {
    expect(resolveAgentPageQuery({ q: '  sales  ' })?.q).toBe('sales');
    expect(resolveAgentPageQuery({ q: 'ㄱ'.repeat(64) })?.q).toBe('ㄱ'.repeat(64));
    expect(resolveAgentPageQuery({ q: '100%_\\' })?.q).toBe('100%_\\');
    for (const bad of ['', '   ', 'x'.repeat(65), 'a\u0000b', 'a​b']) {
      expect(codeOf(() => resolveAgentPageQuery({ q: bad })), JSON.stringify(bad)).toBe('invalid_query');
    }
  });
});

describe('채널 이름', () => {
  it('email 하나', () => {
    expect(CHANNELS).toEqual(['email']);
    expect(isChannel('email')).toBe(true);
    for (const other of ['sms', 'EMAIL', '', 'email ', undefined, null, 1]) expect(isChannel(other)).toBe(false);
  });
});

describe('토큰 권한 선택(R-7)', () => {
  it('부분집합은 그대로 · 생략은 전부 · 빈 배열·모르는 이름은 invalid_capability', () => {
    expect(capabilitiesFromBody(['messages:read'])).toEqual(['messages:read']);
    expect(capabilitiesFromBody(['audit:read', 'audit:read'])).toEqual(['audit:read']);
    expect(capabilitiesFromBody(undefined)).toHaveLength(5);
    expect(capabilitiesFromBody(null)).toHaveLength(5);
    for (const bad of [[], ['agents:create'], 'messages:send', [1], {}]) {
      expect(codeOf(() => capabilitiesFromBody(bad)), JSON.stringify(bad)).toBe('invalid_capability');
    }
  });
});

describe('조직 키 권한 해석', () => {
  it('필수 · 비지 않음 · 알려진 이름만 · 정규 순서', () => {
    expect(resolveOrgKeyCapabilities(['agents:create', 'agents:read'])).toEqual(['agents:read', 'agents:create']);
    expect(resolveOrgKeyCapabilities(['agents:read', 'agents:read'])).toEqual(['agents:read']);
    for (const bad of [undefined, null, [], ['messages:send'], ['agents:read', 'policy:write'], 'agents:read', [1]]) {
      expect(codeOf(() => resolveOrgKeyCapabilities(bad)), JSON.stringify(bad)).toBe('invalid_capability');
    }
  });
});
