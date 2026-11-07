/**
 * **동결 픽스처 생성기 — 한 번 돌리고 결과를 리포에 고정한다** (계획 §5.0b Layer P2 · AC-13).
 *   `pnpm exec tsx test/fixtures/passport/generate-v1-pre-anchor.ts`
 *
 * 만드는 것(`test/fixtures/passport/v1-pre-anchor/`): "이미 세상에 나가 있는 passport" 역할의 did.json · passport.json · passport.jws, 그리고
 * **버전 2 로 재서명된** passport(`v2/` — 단언 (h): 승격이 재서명과 직교함). 서명 키는 아래 고정 시드에서 나오는 **TEST 키**다 —
 * `TEST-KEYPAIR-NOT-PRODUCTION.json` 에 개인키 시드까지 그대로 적는다. **운영 키가 아니다. 이 키로 서명된 문서를 믿지 마라.**
 *
 * 문서 조립은 운영 코드(`src/passport/document.ts` · `jcs.ts` · `attestations.ts`)를 쓴다 — 픽스처가 운영 포맷과 같은 모양이어야 승격 단언이
 * 운영 문서에 대한 명제가 된다. **서명만** 여기서 node:crypto 로 한다(운영 서명기 `signer.ts` 는 key_ref 로만 키를 받는다).
 * 다시 돌려도 같은 바이트가 나온다(Ed25519 는 결정적 서명 · 시각 고정). 그래도 **다시 돌리지 않는 것이 규칙이다** — 동결 픽스처는 "과거에
 * 발급된 문서" 이고, 포맷이 바뀐 뒤에 다시 만들면 그 명제가 사라진다.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toAgentId } from '../../../src/db/schema';
import { computeAttestations } from '../../../src/passport/attestations';
import { didForAgent } from '../../../src/passport/did';
import { buildDidDocument, buildPassportDocument, jwsHeaderFor, type SignedPassportStatus } from '../../../src/passport/document';
import { canonicalize, contentHashOf } from '../../../src/passport/jcs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'v1-pre-anchor');

/** TEST 에이전트 — 운영에 없는 id. */
const AGENT_ID = toAgentId('feedfacefeedfacefeedfacefeedface');
const SEED_LABEL = 'ATMARK TEST KEYPAIR v1-pre-anchor — NOT FOR PRODUCTION';
const SEED = createHash('sha256').update(SEED_LABEL, 'utf8').digest();
/** PKCS#8 DER 머리(Ed25519, RFC 8410) + 32바이트 시드. */
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_X = (createPublicKey(PRIVATE_KEY).export({ format: 'jwk' }) as { x: string }).x;

const DID = didForAgent(AGENT_ID);
const AGENT_CREATED_AT = new Date('2026-09-01T09:00:00.000Z');

function signCompact(payload: string): string {
  const input = `${Buffer.from(JSON.stringify(jwsHeaderFor(DID)), 'utf8').toString('base64url')}.${Buffer.from(payload, 'utf8').toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), PRIVATE_KEY).toString('base64url')}`;
}

function passport(version: number, passportId: string, issuedAt: Date, conversations: number, status: SignedPassportStatus) {
  const document = buildPassportDocument({
    agentId: AGENT_ID,
    did: DID,
    passportId,
    version,
    status,
    issuedAt,
    name: 'Fixture Agent (TEST)',
    address: 'fixture-agent@atmark.ai',
    agentCreatedAt: AGENT_CREATED_AT,
    attestations: computeAttestations({
      addressDomain: 'atmark.ai',
      agentCreatedAt: AGENT_CREATED_AT,
      policyViolationCount: 0,
      conversationCount: conversations,
      now: issuedAt,
    }),
  });
  const canonical = canonicalize(document);
  return { canonical, jws: signCompact(canonical), contentHash: contentHashOf(canonical) };
}

mkdirSync(join(OUT, 'v2'), { recursive: true });
writeFileSync(join(OUT, 'did.json'), `${JSON.stringify(buildDidDocument({ did: DID, agentId: AGENT_ID, publicKey: PUBLIC_X }), null, 2)}\n`);

const v1 = passport(1, '00000000-0000-4000-8000-000000000001', new Date('2026-09-24T00:00:00.000Z'), 0, 'published');
writeFileSync(join(OUT, 'passport.json'), v1.canonical);
writeFileSync(join(OUT, 'passport.jws'), v1.jws);

// v2 — 대화 수 버킷이 0 → 1_9 로 넘어가 재서명된 버전(§4B.1b 재서명 트리거).
const v2 = passport(2, '00000000-0000-4000-8000-000000000002', new Date('2026-10-05T00:00:00.000Z'), 3, 'published');
writeFileSync(join(OUT, 'v2', 'passport.json'), v2.canonical);
writeFileSync(join(OUT, 'v2', 'passport.jws'), v2.jws);

writeFileSync(
  join(OUT, 'TEST-KEYPAIR-NOT-PRODUCTION.json'),
  `${JSON.stringify(
    {
      _warning: 'TEST KEYPAIR — NOT PRODUCTION. Generated from a public seed label; anyone can re-derive it. Never trust documents signed with it.',
      seedLabel: SEED_LABEL,
      agentId: AGENT_ID,
      did: DID,
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: PUBLIC_X },
      privateKeySeedBase64url: SEED.toString('base64url'),
      contentHash: { v1: v1.contentHash, v2: v2.contentHash },
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${OUT} (v1 ${v1.contentHash}, v2 ${v2.contentHash})`);
