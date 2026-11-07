/**
 * src/tlog/commit.ts — **필드별 솔트 커밋** (ADR-0008 §2.2).
 *
 *   salt_f = HMAC-SHA256(org_salt_key, leaf_id ‖ 0x00 ‖ f)                 — 32바이트, 잎·필드마다 다르다
 *   c_f    = SHA-256("atmark-tlog-commit-v1" ‖ 0x00 ‖ salt_f ‖ JCS(value))
 *
 * 왜 솔트인가: 주소·Message-ID·세션 id 처럼 **추측할 수 있는 값**은 솔트 없는 해시로 두면 사전 공격으로 되돌아간다(P3). 솔트 키는
 * 조직마다 하나이고, 키를 폐기하면(크립토 슈레딩, Q9) 잎·해시는 남아 무결성은 유지되고 커밋은 다시는 열 수 없다.
 * 소유자는 증명 번들에서 자기 조직의 솔트 키를 받아 커밋을 **열어** 본다(원천 행과 대조). 제3자에게는 `saltFor` 로 만든
 * 필드 솔트 하나만 건넨다(선택 공개).
 */

import { createHmac } from 'node:crypto';

import { canonicalize } from '../passport/jcs';
import { COMMIT_DOMAIN, SALT_KEY_BYTES } from './constants';
import { sha256 } from './merkle';

/** 잎 id — 솔트 유도의 입력. `<org_log_id hex>:<seq>`. */
export function leafIdOf(logIdHex: string, seq: number): string {
  return `${logIdHex}:${String(seq)}`;
}

export function saltFor(saltKey: Uint8Array, leafId: string, field: string): Buffer {
  if (saltKey.length !== SALT_KEY_BYTES) throw new RangeError('솔트 키는 32바이트다');
  return createHmac('sha256', saltKey)
    .update(Buffer.from(leafId, 'utf8'))
    .update(Uint8Array.of(0))
    .update(Buffer.from(field, 'utf8'))
    .digest();
}

/** 커밋 값(hex 64). `value` 는 JSON 값이어야 한다(JCS 가 거부하면 던진다). */
export function commitmentOf(salt: Uint8Array, value: unknown): string {
  return sha256(Buffer.from(COMMIT_DOMAIN, 'utf8'), Uint8Array.of(0), salt, Buffer.from(canonicalize(value), 'utf8')).toString('hex');
}
