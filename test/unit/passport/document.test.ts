/**
 * passport 문서 조립(PP-B) — did.json · passport.json · attestation 버킷 · 공개 뷰 allowlist. **DB·키 없음.** (JCS 는 `jcs.test.ts`.)
 *
 * 외부 구현과의 일치를 본다: multibase 는 `@scure/base`, JWS 는 `jose`. 자기 구현을
 * 자기 구현으로 확인하지 않는다(§5.0b Layer P1 의 정신).
 */

import { generateKeyPairSync, sign } from 'node:crypto';

import { base58 } from '@scure/base';
import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { OUTBOUND_MODES, toAgentId } from '../../../src/db/schema';
import { consoleOutboundModeOf } from '../../../src/policy/mode-names';
import {
  accountAgeBucket,
  computeAttestations,
  conversationsBucket,
  POLICY_VIOLATION_REASONS,
  POLICY_VIOLATION_WINDOW_DAYS,
} from '../../../src/passport/attestations';
import { didForAgent } from '../../../src/passport/did';
import {
  buildDidDocument,
  buildPassportDocument,
  buildRevokedDidDocument,
  identityObjectKey,
  jwsHeaderFor,
  PASSPORT_VALIDITY_DAYS,
  publicKeyMultibaseOf,
  substanceOf,
} from '../../../src/passport/document';
import { canonicalize } from '../../../src/passport/jcs';
import {
  PUBLIC_IDENTITY_FIELDS,
  PUBLIC_IDENTITY_NOT_FOUND,
  publicOutboundMode,
  toPublicIdentityView,
  type PublicIdentitySource,
} from '../../../src/passport/public-view';

const AGENT = toAgentId('0123456789abcdef0123456789abcdef');
const DID = didForAgent(AGENT);
const NOW = new Date('2026-09-24T12:34:56.789Z');

function keypair(): { x: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { x: (publicKey.export({ format: 'jwk' }) as { x: string }).x, privateKey };
}

describe('did.json — DID Core 1.0', () => {
  it('필수 모양 · JWK(#key-1) · multibase(#key-2) 가 같은 키 · 결정적', () => {
    const { x } = keypair();
    const document = buildDidDocument({ did: DID, agentId: AGENT, publicKey: x });
    expect(document['@context'][0]).toBe('https://www.w3.org/ns/did/v1');
    expect(document.id).toBe(DID);
    expect(document.controller).toBe('did:web:id.atmark.ai');
    expect(document.verificationMethod.map((method) => method.id)).toEqual([`${DID}#key-1`, `${DID}#key-2`]);
    expect(document.verificationMethod[0]?.publicKeyJwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x });
    // 검증 수단 하나에 재료 하나(DID Core §5.2.1).
    for (const method of document.verificationMethod) {
      expect([method.publicKeyJwk, method.publicKeyMultibase].filter((value) => value !== undefined)).toHaveLength(1);
      expect(method.controller).toBe(DID);
    }
    const multibase = document.verificationMethod[1]?.publicKeyMultibase ?? '';
    expect(multibase.startsWith('z6Mk')).toBe(true);
    const decoded = base58.decode(multibase.slice(1));
    expect([...decoded.slice(0, 2)]).toEqual([0xed, 0x01]);
    expect(Buffer.from(decoded.slice(2)).toString('base64url')).toBe(x);
    expect(document.authentication).toEqual(document.assertionMethod);
    expect(buildDidDocument({ did: DID, agentId: AGENT, publicKey: x })).toEqual(document);
    expect(publicKeyMultibaseOf(x)).toBe(multibase);
  });

  it('★ 폐기 — 검증 수단·검증 관계를 **내린다**(이전 JWS·침해된 키의 새 JWS 가 did.json 으로 검증되지 않게) · id·controller·service 는 남긴다', () => {
    const { x } = keypair();
    const live = buildDidDocument({ did: DID, agentId: AGENT, publicKey: x });
    const revoked: Record<string, unknown> = { ...buildRevokedDidDocument({ did: DID, agentId: AGENT }) };
    for (const key of ['verificationMethod', 'authentication', 'assertionMethod']) expect(revoked, key).not.toHaveProperty(key);
    expect(JSON.stringify(revoked)).not.toContain(x);
    expect(revoked).toEqual({ '@context': live['@context'], id: live.id, controller: live.controller, service: live.service });
  });

  it('버킷 키는 ADR-0002 동결 경로 그대로', () => {
    expect(identityObjectKey(AGENT, 'did.json')).toBe(`agents/${AGENT}/did.json`);
  });
});

describe('passport.json — JWT 등록 클레임 + VC 2.0 정렬 필드 (ADR-0003 B1)', () => {
  const attestations = computeAttestations({ addressDomain: 'atmark.ai', agentCreatedAt: new Date('2026-09-01T00:00:00Z'), policyViolationCount: 0, conversationCount: 0, now: NOW });

  it('iat=nbf=발급 초 · exp=+90일 · ISO 두 표기가 같은 초 · jti=버전 행', () => {
    const document = buildPassportDocument({ agentId: AGENT, did: DID, passportId: 'a0000000-0000-4000-8000-000000000001', version: 3, status: 'published', issuedAt: NOW, name: 'n', address: 'a@atmark.ai', agentCreatedAt: new Date('2026-09-01T00:00:00Z'), attestations });
    const seconds = Math.floor(NOW.getTime() / 1000);
    expect(document).toMatchObject({ iss: 'did:web:id.atmark.ai', sub: DID, iat: seconds, nbf: seconds, exp: seconds + PASSPORT_VALIDITY_DAYS * 86400, version: 3, jti: 'urn:uuid:a0000000-0000-4000-8000-000000000001' });
    expect(Date.parse(document.validFrom) / 1000).toBe(document.nbf);
    expect(Date.parse(document.validUntil) / 1000).toBe(document.exp);
    expect(document.credentialSubject.createdMonth).toBe('2026-09');
    expect(document.credentialStatus.statusListUrl).toBe(`https://id.atmark.ai/agents/${AGENT}/passport.json`);
  });

  it('revoked 는 지금 만료된다 — exp = nbf', () => {
    const document = buildPassportDocument({ agentId: AGENT, did: DID, passportId: 'x', version: 2, status: 'revoked', issuedAt: NOW, name: 'n', address: 'a@atmark.ai', agentCreatedAt: NOW, attestations });
    expect(document.exp).toBe(document.nbf);
  });

  it('서명한 JCS 바이트를 jose(JWT)가 그대로 검증한다 · 만료 뒤에는 표준 동작으로 거부한다', async () => {
    const { x, privateKey } = keypair();
    const document = buildPassportDocument({ agentId: AGENT, did: DID, passportId: 'x', version: 1, status: 'published', issuedAt: NOW, name: 'n', address: 'a@atmark.ai', agentCreatedAt: NOW, attestations });
    const payload = canonicalize(document);
    const input = `${Buffer.from(JSON.stringify(jwsHeaderFor(DID))).toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
    const jws = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA');
    const verified = await jwtVerify(jws, key, { issuer: 'did:web:id.atmark.ai', subject: DID, currentDate: new Date(NOW.getTime() + 1000) });
    expect(verified.protectedHeader).toEqual({ alg: 'EdDSA', kid: `${DID}#key-1`, typ: 'JWT' });
    await expect(jwtVerify(jws, key, { currentDate: new Date(NOW.getTime() + 91 * 86400_000) })).rejects.toThrow(/exp/);
  });

  it('substanceOf 는 시각·버전을 뺀 내용 — 같은 사실이면 같다', () => {
    const base = { agentId: AGENT, did: DID, name: 'n', address: 'a@atmark.ai', agentCreatedAt: NOW, attestations, status: 'published' as const };
    const a = buildPassportDocument({ ...base, passportId: 'a', version: 1, issuedAt: NOW });
    const b = buildPassportDocument({ ...base, passportId: 'b', version: 2, issuedAt: new Date(NOW.getTime() + 86400_000) });
    expect(canonicalize(substanceOf(a))).toBe(canonicalize(substanceOf(b)));
  });
});

describe('attestation — 버킷만, 수치 없음 (§4B.3)', () => {
  it('나이 버킷 경계 30·180일', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const at = (days: number): Date => new Date(created.getTime() + days * 86400_000);
    expect([29.9, 30, 179.9, 180].map((days) => accountAgeBucket(created, at(days)))).toEqual(['lt_30d', '30_180d', '30_180d', 'gt_180d']);
  });

  it('대화 버킷 경계 0·1·10·100', () => {
    expect([0, 1, 9, 10, 99, 100, 5000].map(conversationsBucket)).toEqual(['0', '1_9', '1_9', '10_99', '10_99', '100_plus', '100_plus']);
    expect(() => conversationsBucket(-1)).toThrow();
  });

  it('4종 고정 순서 · issuer 병기 · 값은 불리언/버킷 문자열뿐(수치 없음)', () => {
    const list = computeAttestations({ addressDomain: 'ATMARK.AI', agentCreatedAt: NOW, policyViolationCount: 7, conversationCount: 42, now: NOW });
    expect(list.map((entry) => entry.type)).toEqual(['domain_verified', 'no_policy_violations', 'account_age_bucket', 'successful_conversations_bucket']);
    expect(list.every((entry) => entry.issuer === 'did:web:id.atmark.ai')).toBe(true);
    expect(list.map((entry) => entry.value)).toEqual([true, false, 'lt_30d', '10_99']);
    expect(JSON.stringify(list)).not.toMatch(/\b(7|42)\b/);
    expect(computeAttestations({ addressDomain: 'evil.example', agentCreatedAt: NOW, policyViolationCount: 0, conversationCount: 0, now: NOW })[0]).toMatchObject({ value: false });
  });

  it('위반 사유 목록 고정 — 진짜 위반(위조·플랫폼 내용 가드)만 · 소유자 정책이 막은 것·운영 제동은 위반이 아니다 · 창 90일', () => {
    expect([...POLICY_VIOLATION_REASONS].sort()).toEqual(
      ['attachment_bytes_exceeded', 'from_forgery', 'mime_type_not_allowed', 'recipient_ceiling_exceeded'].sort(),
    );
    const ownerPolicyWorking = [
      'recipient_not_allowlisted', 'recipient_blocklisted', 'outbound_disabled', // 정책 v2
      'recipient_not_in_allowlist', 'blocklist', 'outbound_mode_disabled', // 옛 이름
      'reply_only_no_inbound_thread', 'reply_only_inbound_quarantined', 'new_recipient', 'recipients_per_message', // 레거시·소유자 한도
    ];
    const operational = ['org_abuse_freeze', 'org_pending_review', 'rate_limit_per_minute', 'budget_exhausted', 'warmup_daily_cap', 'evaluation_error', 'suppression_list', 'ses_account_level_suppression'];
    for (const reason of [...ownerPolicyWorking, ...operational]) expect(POLICY_VIOLATION_REASONS, reason).not.toContain(reason);
    expect(POLICY_VIOLATION_WINDOW_DAYS).toBe(90);
  });
});

describe('공개 뷰 — 필드 allowlist (§4B.3 · Layer P3)', () => {
  function deepKeys(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => deepKeys(item, `${prefix}[]`));
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      return [path, ...deepKeys(child, path)];
    });
  }

  const source = (overrides: Partial<PublicIdentitySource> = {}): PublicIdentitySource => ({
    address: 'a@atmark.ai',
    did: DID,
    name: 'n',
    agentStatus: 'active',
    passportStatus: 'published',
    version: 2,
    issuedAt: NOW,
    validUntil: NOW,
    contentHash: 'f'.repeat(64),
    publicKey: keypair().x,
    createdMonth: '2026-09',
    attestations: computeAttestations({ addressDomain: 'atmark.ai', agentCreatedAt: NOW, policyViolationCount: 0, conversationCount: 0, now: NOW }),
    outboundMode: 'allowlist_only',
    inboundMode: 'all',
    organizationSendingBlocked: false,
    organizationReceivingBlocked: false,
    didDocumentUrl: 'https://id.atmark.ai/agents/x/did.json',
    passportUrl: 'https://id.atmark.ai/agents/x/passport.json',
    passportJwsUrl: 'https://id.atmark.ai/agents/x/passport.jws',
    ...overrides,
  });

  it('응답의 키 경로 ⊆ PUBLIC_IDENTITY_FIELDS (중첩·배열 포함) — 비공허: 대부분을 실제로 채운다', () => {
    const keys = deepKeys(toPublicIdentityView(source()).valueOf());
    const allowed = new Set<string>(PUBLIC_IDENTITY_FIELDS);
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
    expect(new Set(keys).size).toBeGreaterThanOrEqual(PUBLIC_IDENTITY_FIELDS.length - 1);
  });

  it('입력의 알 수 없는 attestation·추가 필드는 버린다(저장된 JSON 을 그대로 내보내지 않는다)', () => {
    const view = toPublicIdentityView(
      source({
        attestations: [
          { type: 'domain_verified', value: true, domain: 'atmark.ai', issuer: 'did:web:id.atmark.ai', secret: '__LEAK__' },
          { type: 'reputation_score', value: 97, issuer: 'x' },
          { type: 'account_age_bucket', value: '12 days', issuer: 'x' },
        ],
      }),
    );
    expect(JSON.stringify(view)).not.toContain('__LEAK__');
    expect(view.attestations).toEqual([{ type: 'domain_verified', value: true, domain: 'atmark.ai', issuer: 'did:web:id.atmark.ai' }]);
  });

  it('모드 이름은 콘솔 이름 · 레거시는 legacy · 모르는 값·정책 없음은 none(가장 좁게)', () => {
    expect(['unrestricted', 'allowlist_only', 'blocklist_only', 'disabled', 'approval_required', 'reply_only', null, 'weird'].map(publicOutboundMode)).toEqual([
      'all', 'allowlist', 'blocklist', 'none', 'legacy', 'legacy', 'none', 'none',
    ]);
  });

  it('모드 이름은 정책 v2 의 콘솔 표(src/policy/mode-names.ts)와 같다 — 공개 표면과 콘솔이 다른 이름을 말하지 않는다', () => {
    for (const mode of OUTBOUND_MODES) expect(publicOutboundMode(mode), mode).toBe(consoleOutboundModeOf(mode));
  });

  it('capabilities — 정지된 에이전트·폐기된 passport 는 주고받지 못한다고 말한다 · 수신 disabled', () => {
    expect(toPublicIdentityView(source()).capabilities).toEqual({ can_receive: true, can_send: true, requires_approval_for_first_contact: false });
    expect(toPublicIdentityView(source({ agentStatus: 'suspended' })).capabilities).toMatchObject({ can_receive: false, can_send: false });
    expect(toPublicIdentityView(source({ passportStatus: 'revoked' })).capabilities).toMatchObject({ can_send: false });
    expect(toPublicIdentityView(source({ inboundMode: 'disabled' })).capabilities.can_receive).toBe(false);
    expect(toPublicIdentityView(source({ agentStatus: 'suspended' })).agent.status).toBe('suspended');
  });

  it('capabilities — 조직 층 차단(검토 전·동결·소유자 정지·결제)을 반영한다 · 어떤 차단인지는 말하지 않는다', () => {
    const blocked = toPublicIdentityView(source({ organizationSendingBlocked: true }));
    expect(blocked.capabilities).toEqual({ can_receive: true, can_send: false, requires_approval_for_first_contact: false });
    expect(toPublicIdentityView(source({ organizationSendingBlocked: true, organizationReceivingBlocked: true, outboundMode: 'unrestricted' })).capabilities).toMatchObject({
      can_receive: false,
      can_send: false,
    });
    expect(JSON.stringify(blocked)).not.toMatch(/organization|review|billing|freeze|paused/);
  });

  it('폐기 — public_key 는 null(폐기된 키는 검증 수단이 아니다) · 정지는 키를 그대로 보인다', () => {
    expect(toPublicIdentityView(source({ passportStatus: 'revoked' })).public_key).toBeNull();
    const suspended = source({ passportStatus: 'suspended' });
    expect(toPublicIdentityView(suspended).public_key?.jwk.x).toBe(suspended.publicKey);
  });

  it('404 본문은 고정 상수 하나다', () => {
    expect(PUBLIC_IDENTITY_NOT_FOUND).toEqual({ error: 'not_found', detail: 'identity not found' });
  });
});
