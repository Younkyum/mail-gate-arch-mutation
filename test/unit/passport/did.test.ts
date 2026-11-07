/**
 * DID 문자열 — ADR-0002 경로 스킴의 **동결 회귀 테스트**.
 *
 * 이 파일의 단언 대부분은 리터럴 비교다. 그게 요점이다: **동결된 값에 대한 테스트는
 * 값을 다시 적는 것 말고 할 일이 없다.** 누군가 `did.ts` 를 "정리" 하면 여기가 빨간불이
 * 되고, 그때 ADR-0002 Consequences("리팩터 금지 구역")를 읽게 된다.
 */

import { describe, expect, it } from 'vitest';

import { toAgentId } from '../../../src/db/schema';
import {
  ATMARK_CONTROLLER_DID,
  DID_WEB_PREFIX,
  DidMismatchError,
  agentIdFromDid,
  didDocumentUrl,
  didForAgent,
  externalDidOf,
} from '../../../src/passport/did';

const AGENT_ID = toAgentId('0123456789abcdef0123456789abcdef');

describe('did:web 경로 스킴 (ADR-0002 — 영구 동결)', () => {
  it('접두사가 동결된 값 그대로다', () => {
    expect(DID_WEB_PREFIX).toBe('did:web:id.atmark.ai:agents:');
    expect(ATMARK_CONTROLLER_DID).toBe('did:web:id.atmark.ai');
  });

  it('DID 는 `did:web:id.atmark.ai:agents:{agentId}` 다', () => {
    expect(didForAgent(AGENT_ID)).toBe('did:web:id.atmark.ai:agents:0123456789abcdef0123456789abcdef');
  });

  it('해석 URL 은 `https://id.atmark.ai/agents/{agentId}/did.json` 이다', () => {
    // 이 URL 을 나중에 바꾸면 **발급된 모든 DID 가 깨진다.**
    expect(didDocumentUrl(AGENT_ID)).toBe(
      'https://id.atmark.ai/agents/0123456789abcdef0123456789abcdef/did.json',
    );
  });

  it('DID 와 URL 이 같은 값에서 파생된다 — 둘이 갈라질 수 없다', () => {
    const did = didForAgent(AGENT_ID);
    expect(didDocumentUrl(agentIdFromDid(did))).toContain(AGENT_ID);
  });
});

describe('agentIdFromDid — 관대하게 파싱하지 않는다', () => {
  it('왕복한다', () => {
    expect(agentIdFromDid(didForAgent(AGENT_ID))).toBe(AGENT_ID);
  });

  it.each([
    ['다른 호스트', 'did:web:evil.example:agents:0123456789abcdef0123456789abcdef'],
    ['다른 경로 세그먼트', 'did:web:id.atmark.ai:agent:0123456789abcdef0123456789abcdef'],
    ['다른 method', 'did:key:z6Mk0123456789abcdef0123456789abcdef'],
    ['접두사 없음', '0123456789abcdef0123456789abcdef'],
  ])('%s 은 거부한다 — 느슨하면 남의 DID 가 우리 에이전트로 해석된다', (_label, did) => {
    expect(() => agentIdFromDid(did)).toThrow(DidMismatchError);
  });

  it('말단이 agentId 형식이 아니면 거부한다', () => {
    expect(() => agentIdFromDid('did:web:id.atmark.ai:agents:NOT-HEX')).toThrow(/invalid agentId/);
  });
});

describe('B5 — 게시되지 않은 DID 는 외부로 나가지 않는다', () => {
  const did = didForAgent(AGENT_ID);

  it('status=draft 이면 null 이다 — 해석되지 않는 DID 는 DID 가 없는 것보다 나쁘다', () => {
    expect(externalDidOf({ did, status: 'draft' })).toBeNull();
  });

  // 정지·폐기는 문서를 내리지 않고 재서명해 서빙한다(§4B.1b). 그 DID 는 **해석된다** — B5 의 해악이 없다.
  it.each(['published', 'suspended', 'revoked'] as const)('status=%s 이면 값이 나온다 — 한 번 게시된 DID 는 계속 해석된다', (status) => {
    expect(externalDidOf({ did, status })).toBe(did);
  });
});
