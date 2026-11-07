/**
 * `hmac-keyring.ts` — 키가 없거나 약하면 **서명도 검증도 하지 않는다**(fail-closed).
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  HmacKeyUnavailableError,
  activeKey,
  parseHmacKeyring,
} from '../../../src/security/hmac-keyring';

const key = (bytes = 32) => randomBytes(bytes).toString('base64url');

describe('HMAC 키 묶음', () => {
  it('첫 항목이 active 이고 전 항목이 검증용으로 남는다', () => {
    const ring = parseHmacKeyring(`new:${key()},old:${key()}`, 'X');
    expect(ring.activeKid).toBe('new');
    expect([...ring.keys.keys()]).toEqual(['new', 'old']);
    expect(activeKey(ring).key).toHaveLength(32);
  });

  it.each([
    ['부재', undefined],
    ['빈 문자열', '   '],
    ['kid 없음', key()],
    ['kid 형식 위반(대문자)', `K1:${key()}`],
    ['kid 형식 위반(점)', `k.1:${key()}`],
    ['짧은 키(31바이트)', `k1:${key(31)}`],
    ['사람이 친 비밀', 'k1:secret'],
    ['비정규 base64url', `k1:${key()}=`],
    ['kid 중복', `k1:${key()},k1:${key()}`],
  ])('거부: %s — 기본 키로 떨어지지 않는다', (_label, raw) => {
    expect(() => parseHmacKeyring(raw, 'X')).toThrow(HmacKeyUnavailableError);
  });

  it('오류 메시지에 키 값이 실리지 않는다 (배포 로그로 간다)', () => {
    const weak = key(16);
    try {
      parseHmacKeyring(`k1:${weak}`, 'X');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(weak);
    }
  });
});
