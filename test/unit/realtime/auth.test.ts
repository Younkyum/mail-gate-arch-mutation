/**
 * 실시간 `$connect` 자격 증명 읽기(`src/realtime/auth.ts`) — 헤더 · 하위 프로토콜만 · **쿼리 토큰은 거부** · `atmark.v1` 만 되돌린다 · 조직 키 거부.
 */

import { describe, expect, it } from 'vitest';

import { offeredSubprotocols, queryCarriesToken, readRealtimeCredential } from '../../../src/realtime/auth';

const TOKEN = `atk_agent_${'A'.repeat(43)}`;
const OTHER = `atk_agent_${'B'.repeat(43)}`;

describe('readRealtimeCredential', () => {
  it('Authorization: Bearer — 대소문자 무관 머리 이름 · 응답 프로토콜 없음(제안이 없으면)', () => {
    expect(readRealtimeCredential({ headers: { Authorization: `Bearer ${TOKEN}` } })).toEqual({
      kind: 'presented',
      token: TOKEN,
      via: 'authorization',
      echoProtocol: null,
    });
    expect(readRealtimeCredential({ headers: { authorization: `bearer ${TOKEN}` } })).toMatchObject({ kind: 'presented', token: TOKEN });
  });

  it('하위 프로토콜 `atmark.v1, bearer.<토큰>` — 돌려주는 값은 atmark.v1 하나(토큰을 되돌려 보내지 않는다)', () => {
    const credential = readRealtimeCredential({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}` } });
    expect(credential).toEqual({ kind: 'presented', token: TOKEN, via: 'subprotocol', echoProtocol: 'atmark.v1' });
    // 순서 · 공백 무관.
    expect(readRealtimeCredential({ headers: { 'sec-websocket-protocol': ` bearer.${TOKEN} ,atmark.v1 ` } })).toMatchObject({
      kind: 'presented',
      echoProtocol: 'atmark.v1',
    });
  });

  it('헤더 토큰 + atmark.v1 제안 → 헤더 토큰, atmark.v1 을 돌려준다(브라우저 아닌 클라이언트가 프로토콜만 제안)', () => {
    expect(readRealtimeCredential({ headers: { Authorization: `Bearer ${TOKEN}`, 'Sec-WebSocket-Protocol': 'atmark.v1' } })).toEqual({
      kind: 'presented',
      token: TOKEN,
      via: 'authorization',
      echoProtocol: 'atmark.v1',
    });
  });

  it('★ 쿼리 문자열의 토큰은 거부 — 키 이름(token · access_token · authorization …)이든 값의 atk_ 접두사든, 헤더에 토큰이 있어도', () => {
    for (const query of [
      { token: TOKEN },
      { access_token: 'x' },
      { Authorization: 'Bearer x' },
      { api_key: 'x' },
      { x: TOKEN },
      { [TOKEN]: '' },
      { foo: 'ATK_AGENT_lower' },
    ]) {
      expect(readRealtimeCredential({ headers: { Authorization: `Bearer ${TOKEN}` }, queryStringParameters: query }), JSON.stringify(query)).toEqual({
        kind: 'rejected',
        reason: 'token_in_query',
      });
    }
    // 토큰과 무관한 쿼리는 괜찮다.
    expect(queryCarriesToken({ lang: 'ko', v: '1' })).toBe(false);
    expect(queryCarriesToken(null)).toBe(false);
  });

  it('토큰 없음 · 빈 Bearer · 다른 스킴 → missing_token', () => {
    expect(readRealtimeCredential({})).toEqual({ kind: 'rejected', reason: 'missing_token' });
    expect(readRealtimeCredential({ headers: { Authorization: 'Bearer ' } })).toEqual({ kind: 'rejected', reason: 'missing_token' });
    expect(readRealtimeCredential({ headers: { Authorization: `Basic ${TOKEN}` } })).toEqual({ kind: 'rejected', reason: 'missing_token' });
    expect(readRealtimeCredential({ headers: { 'Sec-WebSocket-Protocol': 'atmark.v1' } })).toEqual({ kind: 'rejected', reason: 'missing_token' });
  });

  it('하위 프로토콜 토큰에 atmark.v1 이 없으면 거부 · 토큰이 둘이거나 헤더와 다르면 거부(고르지 않는다)', () => {
    expect(readRealtimeCredential({ headers: { 'Sec-WebSocket-Protocol': `bearer.${TOKEN}` } })).toEqual({ kind: 'rejected', reason: 'subprotocol_required' });
    expect(readRealtimeCredential({ headers: { 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${TOKEN}, bearer.${OTHER}` } })).toEqual({
      kind: 'rejected',
      reason: 'conflicting_tokens',
    });
    expect(
      readRealtimeCredential({ headers: { Authorization: `Bearer ${TOKEN}`, 'Sec-WebSocket-Protocol': `atmark.v1, bearer.${OTHER}` } }),
    ).toEqual({ kind: 'rejected', reason: 'conflicting_tokens' });
  });

  it('조직 키(atk_org_)는 이 표면의 토큰이 아니다', () => {
    expect(readRealtimeCredential({ headers: { Authorization: 'Bearer atk_org_abc' } })).toEqual({ kind: 'rejected', reason: 'org_key' });
  });

  it('offeredSubprotocols — 빈 칸 없이 자른다', () => {
    expect(offeredSubprotocols(null)).toEqual([]);
    expect(offeredSubprotocols(' a , ,b,')).toEqual(['a', 'b']);
  });
});
