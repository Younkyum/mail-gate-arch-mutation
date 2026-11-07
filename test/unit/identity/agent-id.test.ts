/** `agentId` 규격(계획 §4B.1) — DID 문자열·DB CHECK·온체인 `bytes32` 에 동시에 박히는 값이다. */

import { describe, expect, it } from 'vitest';
import { AGENT_ID_PATTERN, isAgentId } from '../../../src/db/schema';
import { AGENT_ID_BYTES, generateAgentId } from '../../../src/identity/agent-id';

describe('generateAgentId', () => {
  it('소문자 hex 32자(대시 없음)이고 바이트 수와 hex 길이가 어긋나지 않는다', () => {
    const id = generateAgentId();
    expect(id).toMatch(AGENT_ID_PATTERN);
    expect(id).toHaveLength(32);
    expect(isAgentId(id)).toBe(true);
    expect(id).not.toContain('-');
    expect(AGENT_ID_BYTES * 2).toBe(32);
  });

  it('호출마다 다른 값이다', () => {
    const ids = new Set(Array.from({ length: 256 }, () => generateAgentId() as string));
    expect(ids.size).toBe(256);
  });
});
