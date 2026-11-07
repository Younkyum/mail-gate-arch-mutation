/**
 * 요청자 키의 재료(`requesterBucketOf`, 보안 검토 2026-09-30) — IPv6 는 /64 로 묶는다. 한 /64 안의 주소를 바꿔 가며 요청자 상한(가입·대기 등록 시간당 5 ·
 * 로그인 15분 10)을 곱해 쓰지 못하게. IPv4 · 모양이 아닌 값은 그대로(기존 키가 바뀌지 않는다).
 */

import { describe, expect, it } from 'vitest';

import { requesterBucketOf } from '../../../src/admin/session';

describe('requesterBucketOf — IPv6 /64 · IPv4 그대로', () => {
  it('같은 /64 의 주소는 모두 한 버킷(표기 차이 · 0 채움 · 대소문자 · zone 무관)', () => {
    const bucket = requesterBucketOf('2001:db8:abcd:12::1');
    expect(bucket).toBe('2001:db8:abcd:12::/64');
    for (const ip of ['2001:db8:abcd:12:ffff:ffff:ffff:ffff', '2001:0DB8:ABCD:0012:0:0:0:2', ' 2001:db8:abcd:12::dead:beef ', '2001:db8:abcd:12::1%eth0', '2001:db8:abcd:12:1:2:1.2.3.4']) {
      expect(requesterBucketOf(ip), ip).toBe(bucket);
    }
  });

  it('다른 /64 는 다른 버킷', () => {
    expect(requesterBucketOf('2001:db8:abcd:13::1')).not.toBe(requesterBucketOf('2001:db8:abcd:12::1'));
    expect(requesterBucketOf('::1')).toBe('0:0:0:0::/64');
  });

  it('IPv4 · IPv4 에 매핑된 IPv6 · 주소가 아닌 값은 주소 그대로(옛 키와 같다)', () => {
    expect(requesterBucketOf('203.0.113.7')).toBe('203.0.113.7');
    expect(requesterBucketOf('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(requesterBucketOf('198.51.100.9-test')).toBe('198.51.100.9-test');
  });
});
