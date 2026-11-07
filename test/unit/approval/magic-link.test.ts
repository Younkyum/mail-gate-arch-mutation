/**
 * `magic-link.ts` — 위협 모델(T1~T8)의 각 행을 단언으로 고정한다.
 *
 * 이 파일의 단언은 **되돌려서 실패하는지 확인했다**(보고서 참조): GET 이 redeem 을 부르게
 * 바꾸면, 단일 사용 검사를 지우면, 만료 비교를 지우면, 서명 비교를 무조건 참으로 바꾸면
 * 각각 여기서 빨간불이 켜진다.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_CONFIRMATION_PAGES,
  APPROVAL_PAGE_COPY,
  approvalPageLanguage,
  ApprovalLinkScopeError,
  ApprovalLinkTransitionLostError,
  buildApprovalLinkUrl,
  handleApprovalLinkRequest,
  mintApprovalLinkToken,
  previewApprovalLink,
  redeemApprovalLink,
  verifyApprovalLinkToken,
  type ApprovalLinkDecision,
  type ApprovalLinkPorts,
  type ApprovalLinkResolution,
  type ApprovalLinkTarget,
  type ApprovalLinkTransaction,
  type ApprovalLinkUse,
} from '../../../src/approval/magic-link';
import {
  neutralizeAgentText,
  RECIPIENT_MAX_CHARS,
  sanitizeDisplayText,
} from '../../../src/notify/approval-notification-template';
import { parseHmacKeyring, type HmacKeyring } from '../../../src/security/hmac-keyring';

function keyMaterial(): string {
  return randomBytes(32).toString('base64url');
}

const K1 = keyMaterial();
const K2 = keyMaterial();
const KEYRING: HmacKeyring = parseHmacKeyring(`k1:${K1}`, 'TEST');

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES = new Date('2026-09-24T00:00:00.000Z');

/** 한 approval 과 그 사용 기록을 흉내 내는 가짜 저장소. **트랜잭션 롤백을 흉내 낸다.** */
function fakePorts(
  targets: Map<string, ApprovalLinkTarget>,
  options: {
    readonly flipStateOnResolve?: boolean;
    readonly failResolve?: boolean | Error;
    readonly keyring?: HmacKeyring;
    readonly summary?: {
      readonly agentName?: string;
      readonly fromAddresses?: string[];
      readonly recipients?: string[];
      readonly attachments?: { readonly count: number; readonly bytes: number; readonly names: readonly string[] };
      readonly riskReasons?: readonly string[];
    };
  } = {},
) {
  const uses: ApprovalLinkUse[] = [];
  const resolutions: { approvalId: string; decision: ApprovalLinkDecision }[] = [];
  const contexts: ApprovalLinkResolution[] = [];
  let transactions = 0;
  let previews = 0;

  const ports: ApprovalLinkPorts = {
    keyring: options.keyring ?? KEYRING,
    async findApprovalSummary(approvalId) {
      previews += 1;
      const target = targets.get(approvalId);
      if (target === undefined) return null;
      return {
        ...target,
        subject: 'message',
        agentName: 'sales-bot',
        fromAddresses: ['sales-bot@atmark.ai'],
        recipients: ['<b>cfo</b>@partner.io'],
        attemptCount: 1,
        ...options.summary,
      };
    },
    async runInTransaction<T>(work: (tx: ApprovalLinkTransaction) => Promise<T>): Promise<T> {
      transactions += 1;
      const stagedUses: ApprovalLinkUse[] = [];
      const stagedResolutions: typeof resolutions = [];
      const tx: ApprovalLinkTransaction = {
        async findApprovalForUpdate(approvalId) {
          return targets.get(approvalId) ?? null;
        },
        async recordUse(use) {
          // 실제 스키마와 같은 규칙: approval 당 1행.
          const all = [...uses, ...stagedUses];
          if (all.some((u) => u.approvalId === use.approvalId || u.tokenIdHash === use.tokenIdHash)) {
            return 'already_used';
          }
          stagedUses.push(use);
          return 'recorded';
        },
        async resolveApproval(approvalId, decision, _now, context) {
          if (options.failResolve instanceof Error) throw options.failResolve;
          if (options.failResolve === true) throw new Error('전이 실패');
          stagedResolutions.push({ approvalId, decision });
          contexts.push(context);
        },
      };
      const result = await work(tx); // 던지면 staged 는 버려진다 = 롤백
      uses.push(...stagedUses);
      resolutions.push(...stagedResolutions);
      if (options.flipStateOnResolve === true) {
        for (const r of stagedResolutions) {
          const target = targets.get(r.approvalId);
          if (target) targets.set(r.approvalId, { ...target, state: 'resolved' });
        }
      }
      return result;
    },
  };
  return { ports, uses, resolutions, contexts, transactions: () => transactions, previews: () => previews };
}

/** 어떤 속성에 닿아도 던지는 포트 — "GET 은 포트에 손대지 않는다" 를 증명한다. */
function untouchablePorts(): ApprovalLinkPorts {
  return new Proxy({} as ApprovalLinkPorts, {
    get(_target, property) {
      throw new Error(`GET 이 포트에 접근했다: ${String(property)}`);
    },
  });
}

function pendingApproval(expiresAt: Date = EXPIRES): { id: string; targets: Map<string, ApprovalLinkTarget> } {
  const id = randomUUID();
  return { id, targets: new Map([[id, { state: 'pending', expiresAt }]]) };
}

function form(token: string, decision: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ token, decision, ...extra }).toString();
}

function previewForm(token: string): string {
  return new URLSearchParams({ intent: 'preview', token }).toString();
}

const FORM_TYPE = 'application/x-www-form-urlencoded';

describe('매직링크 — 서명 (T1 위조 · T5 키 · T7 가변성)', () => {
  it('발급한 토큰은 검증되고 클레임이 발급 입력과 같다', () => {
    const { id } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const result = verifyApprovalLinkToken(KEYRING, token, NOW);
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.claims.approvalId).toBe(id);
    expect(result.claims.expiresAt.getTime()).toBe(EXPIRES.getTime());
    expect(result.claims.keyId).toBe('k1');
    expect(result.claims.tokenIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('다른 키로 서명한 토큰(같은 kid)은 bad_signature', () => {
    const forger = parseHmacKeyring(`k1:${keyMaterial()}`, 'TEST');
    const token = mintApprovalLinkToken(forger, { approvalId: randomUUID(), expiresAt: EXPIRES });
    expect(verifyApprovalLinkToken(KEYRING, token, NOW)).toEqual({ kind: 'rejected', reason: 'bad_signature' });
  });

  it('페이로드를 바꾸고 서명을 그대로 두면 bad_signature — approval id 를 갈아끼울 수 없다', () => {
    const token = mintApprovalLinkToken(KEYRING, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const [head = '', payload = '', signature = ''] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const swapped = Buffer.from(JSON.stringify({ ...claims, a: randomUUID() })).toString('base64url');
    expect(verifyApprovalLinkToken(KEYRING, `${head}.${swapped}.${signature}`, NOW)).toEqual({
      kind: 'rejected',
      reason: 'bad_signature',
    });
    // 만료를 늘리는 변조도 같다.
    const extended = Buffer.from(JSON.stringify({ ...claims, e: EXPIRES.getTime() + 86_400_000 })).toString('base64url');
    expect(verifyApprovalLinkToken(KEYRING, `${head}.${extended}.${signature}`, NOW).kind).toBe('rejected');
  });

  it('kid 는 서명 범위 안이다 — kid 만 바꾸면 다른 키로도 검증되지 않는다', () => {
    const ring = parseHmacKeyring(`k1:${K1},k2:${K2}`, 'TEST');
    const token = mintApprovalLinkToken(ring, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const retagged = token.replace('atk_link_k1.', 'atk_link_k2.');
    expect(verifyApprovalLinkToken(ring, retagged, NOW)).toEqual({ kind: 'rejected', reason: 'bad_signature' });
  });

  it('묶음에 없는 kid 는 unknown_key', () => {
    const other = parseHmacKeyring(`k9:${keyMaterial()}`, 'TEST');
    const token = mintApprovalLinkToken(other, { approvalId: randomUUID(), expiresAt: EXPIRES });
    expect(verifyApprovalLinkToken(KEYRING, token, NOW)).toEqual({ kind: 'rejected', reason: 'unknown_key' });
  });

  it('회전: 새 키를 앞에 넣어도 구 키 토큰은 검증되고, 구 키를 빼면 거부된다', () => {
    const old = parseHmacKeyring(`k1:${K1}`, 'TEST');
    const token = mintApprovalLinkToken(old, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const rotated = parseHmacKeyring(`k2:${K2},k1:${K1}`, 'TEST');
    expect(verifyApprovalLinkToken(rotated, token, NOW).kind).toBe('valid');
    // 새로 발급되는 것은 새 키다.
    expect(mintApprovalLinkToken(rotated, { approvalId: randomUUID(), expiresAt: EXPIRES })).toMatch(/^atk_link_k2\./);
    const retired = parseHmacKeyring(`k2:${K2}`, 'TEST');
    expect(verifyApprovalLinkToken(retired, token, NOW)).toEqual({ kind: 'rejected', reason: 'unknown_key' });
  });

  it('비정규 base64url(끝 비트 변조)은 malformed — 같은 바이트로 풀리는 다른 문자열을 받지 않는다', () => {
    const token = mintApprovalLinkToken(KEYRING, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = token.at(-1) ?? 'A';
    // 32바이트 서명 = 43자, 마지막 문자의 하위 2비트는 패딩이다. 그 비트만 바꾼다.
    const twin = alphabet[alphabet.indexOf(last) ^ 1] ?? 'A';
    const variant = `${token.slice(0, -1)}${twin}`;
    // 전제: 변종이 정말 같은 바이트로 풀린다(아니면 이 테스트는 아무것도 증명하지 않는다).
    const sig = (t: string) => Buffer.from(t.split('.')[2] ?? '', 'base64url').toString('hex');
    expect(sig(variant)).toBe(sig(token));
    expect(variant).not.toBe(token);
    expect(verifyApprovalLinkToken(KEYRING, variant, NOW)).toEqual({ kind: 'rejected', reason: 'malformed' });
  });

  it.each([
    ['빈 문자열', ''],
    ['접두사 없음', 'k1.aaa.bbb'],
    ['다른 토큰 종류', 'atk_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['과도한 길이', `atk_link_k1.${'A'.repeat(600)}.AAAA`],
  ])('형식이 아니면 malformed: %s', (_label, token) => {
    expect(verifyApprovalLinkToken(KEYRING, token, NOW)).toEqual({ kind: 'rejected', reason: 'malformed' });
  });

  it('서명이 맞아도 페이로드 형식이 다르면 malformed (여분 키)', () => {
    const payload = Buffer.from(
      JSON.stringify({ a: randomUUID(), e: EXPIRES.getTime(), j: randomBytes(16).toString('base64url'), x: 1 }),
    ).toString('base64url');
    const key = Buffer.from(K1, 'base64url');
    const signature = createHmac('sha256', key).update(`atmark.approval-link.v1\nk1\n${payload}`).digest('base64url');
    // 전제: 정상 형식이라면 이 수제 토큰이 통과한다 — 서명 계산이 구현과 같다는 확인.
    const good = Buffer.from(
      JSON.stringify({ a: randomUUID(), e: EXPIRES.getTime(), j: randomBytes(16).toString('base64url') }),
    ).toString('base64url');
    const goodSig = createHmac('sha256', key).update(`atmark.approval-link.v1\nk1\n${good}`).digest('base64url');
    expect(verifyApprovalLinkToken(KEYRING, `atk_link_k1.${good}.${goodSig}`, NOW).kind).toBe('valid');
    expect(verifyApprovalLinkToken(KEYRING, `atk_link_k1.${payload}.${signature}`, NOW)).toEqual({
      kind: 'rejected',
      reason: 'malformed',
    });
  });
});

describe('매직링크 — 만료 (T4: 토큰과 DB 를 둘 다 본다)', () => {
  it('토큰 만료 시각 정각은 이미 만료다 — 그리고 DB 에 닿지 않는다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    expect(verifyApprovalLinkToken(KEYRING, token, EXPIRES)).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(verifyApprovalLinkToken(KEYRING, token, new Date(EXPIRES.getTime() - 1)).kind).toBe('valid');

    const fake = fakePorts(targets);
    expect(await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, EXPIRES)).toEqual({
      kind: 'rejected',
      reason: 'expired',
    });
    expect(fake.transactions()).toBe(0);
  });

  it('DB 의 expires_at 이 지났으면 토큰이 살아 있어도 거부된다 (토큰 만료만 믿지 않는다)', async () => {
    const id = randomUUID();
    const dbExpiry = new Date(NOW.getTime() - 1000);
    const targets = new Map<string, ApprovalLinkTarget>([[id, { state: 'pending', expiresAt: dbExpiry }]]);
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets);
    expect(await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'expired',
    });
    expect(fake.uses).toHaveLength(0);
  });

  it('토큰 만료와 DB 만료가 다르면 expiry_mismatch — 같은 만료로 발급된 것만 통한다', async () => {
    const id = randomUUID();
    const targets = new Map<string, ApprovalLinkTarget>([
      [id, { state: 'pending', expiresAt: new Date(EXPIRES.getTime() + 3_600_000) }],
    ]);
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets);
    expect(await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'expiry_mismatch',
    });
    expect(fake.uses).toHaveLength(0);
    expect(fake.resolutions).toHaveLength(0);
  });

  it('이미 결정된 approval 은 already_resolved', async () => {
    const id = randomUUID();
    const targets = new Map<string, ApprovalLinkTarget>([[id, { state: 'resolved', expiresAt: EXPIRES }]]);
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    expect(await redeemApprovalLink(fakePorts(targets).ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'already_resolved',
    });
  });

  it('없는 approval 은 unknown_approval', async () => {
    const token = mintApprovalLinkToken(KEYRING, { approvalId: randomUUID(), expiresAt: EXPIRES });
    expect(await redeemApprovalLink(fakePorts(new Map()).ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'unknown_approval',
    });
  });
});

describe('매직링크 — 단일 사용 (T2)', () => {
  it('두 번째 사용은 already_used — **상태 검사가 없어도** 사용 기록이 막는다', async () => {
    // flipStateOnResolve=false: approval 상태가 pending 으로 남는 최악의 경우(전이 누락)에도
    // 두 번째 사용이 거부되는가. 이것이 "서명만으로는 재사용을 못 막는다" 의 답이다.
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets);

    expect(await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'redeemed',
      approvalId: id,
      decision: 'approve',
    });
    expect(await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'already_used',
    });
    expect(fake.resolutions).toEqual([{ approvalId: id, decision: 'approve' }]);
  });

  it('승인 뒤 같은 토큰으로 거절할 수 없다 — 단일 사용은 approval 단위다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets);
    await redeemApprovalLink(fake.ports, { token, decision: 'approve' }, NOW);
    expect(await redeemApprovalLink(fake.ports, { token, decision: 'reject' }, NOW)).toMatchObject({
      kind: 'rejected',
    });
    expect(fake.resolutions).toEqual([{ approvalId: id, decision: 'approve' }]);
  });

  it('같은 approval 에 재발급된 **다른** 토큰도 두 번째는 거부된다', async () => {
    const { id, targets } = pendingApproval();
    const first = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const second = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    expect(first).not.toBe(second);
    const fake = fakePorts(targets);
    expect((await redeemApprovalLink(fake.ports, { token: first, decision: 'reject' }, NOW)).kind).toBe('redeemed');
    expect(await redeemApprovalLink(fake.ports, { token: second, decision: 'approve' }, NOW)).toEqual({
      kind: 'rejected',
      reason: 'already_used',
    });
  });

  it('상태 전이가 실패하면 사용 기록도 롤백된다 — 링크가 결정 없이 소진되지 않는다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const failing = fakePorts(targets, { failResolve: true });
    await expect(redeemApprovalLink(failing.ports, { token, decision: 'approve' }, NOW)).rejects.toThrow('전이 실패');
    expect(failing.uses).toHaveLength(0);
  });
});

describe('매직링크 — HTTP: GET 은 보여주기만, POST 만 바꾼다 (T3)', () => {
  it.each([
    ['GET', APPROVAL_CONFIRMATION_PAGES.ko],
    ['HEAD', ''],
  ])('%s 는 포트에 한 번도 닿지 않는다(언어 없음 = 한국어 페이지)', async (method, body) => {
    const response = await handleApprovalLinkRequest({ method, contentType: null, body: '' }, untouchablePorts(), NOW);
    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('스캐너가 GET 을 여러 번 해도 링크가 태워지지 않는다 — 그 뒤 사람의 POST 가 성공한다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, { flipStateOnResolve: true });
    const runInTransaction = vi.spyOn(fake.ports, 'runInTransaction');

    for (let i = 0; i < 3; i += 1) {
      // 스캐너는 fragment 를 서버로 보내지 않지만, 보냈다고 가정해도(본문에 실어도) GET 은 읽지 않는다.
      await handleApprovalLinkRequest({ method: 'GET', contentType: FORM_TYPE, body: form(token, 'approve') }, fake.ports, NOW);
    }
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(fake.uses).toHaveLength(0);
    expect(targets.get(id)?.state).toBe('pending');

    const human = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') },
      fake.ports,
      NOW,
    );
    expect(human.status).toBe(200);
    expect(fake.resolutions).toEqual([{ approvalId: id, decision: 'approve' }]);
  });

  it('POST 두 번째는 409', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, { flipStateOnResolve: true });
    const post = () =>
      handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body: form(token, 'reject') }, fake.ports, NOW);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(409);
    expect(fake.resolutions).toEqual([{ approvalId: id, decision: 'reject' }]);
  });

  it.each([
    ['decision 누락', FORM_TYPE, 'token=x'],
    ['decision 이 기본값을 가정한 빈 값', FORM_TYPE, 'token=x&decision='],
    ['알 수 없는 decision', FORM_TYPE, 'token=x&decision=auto'],
    ['token 중복', FORM_TYPE, 'token=a&token=b&decision=approve'],
    ['decision 중복', FORM_TYPE, 'token=a&decision=reject&decision=approve'],
    ['JSON 본문', 'application/json', '{"token":"x","decision":"approve"}'],
    ['content-type 없음', null, 'token=x&decision=approve'],
  ])('POST 형식 위반은 400 이고 트랜잭션을 열지 않는다: %s', async (_label, contentType, body) => {
    const fake = fakePorts(new Map());
    const response = await handleApprovalLinkRequest({ method: 'POST', contentType, body }, fake.ports, NOW);
    expect(response.status).toBe(400);
    expect(fake.transactions()).toBe(0);
  });

  it('위조 토큰 POST 는 400 이고 트랜잭션을 열지 않는다(DB 를 두드리지 않는다)', async () => {
    const forger = parseHmacKeyring(`k1:${keyMaterial()}`, 'TEST');
    const token = mintApprovalLinkToken(forger, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const fake = fakePorts(new Map());
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') },
      fake.ports,
      NOW,
    );
    expect(response.status).toBe(400);
    expect(fake.transactions()).toBe(0);
  });

  it('만료 링크 POST 는 410', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') },
      fakePorts(targets).ports,
      new Date(EXPIRES.getTime() + 1),
    );
    expect(response.status).toBe(410);
  });

  it.each(['PUT', 'DELETE', 'PATCH'])('%s 는 405', async (method) => {
    const response = await handleApprovalLinkRequest({ method, contentType: null, body: '' }, untouchablePorts(), NOW);
    expect(response.status).toBe(405);
  });
});

describe('매직링크 — URL 과 페이지 (T3 · T6)', () => {
  it('토큰은 fragment 에만 실린다 — 서버로 가는 부분(경로·쿼리)에는 없다', () => {
    const token = mintApprovalLinkToken(KEYRING, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const link = new URL(buildApprovalLinkUrl('https://app.atmark.ai/approve', token));
    expect(link.hash).toBe(`#${token}`);
    expect(`${link.origin}${link.pathname}${link.search}`).not.toContain('atk_link_');
  });

  it.each([
    ['http', 'http://app.atmark.ai/approve'],
    ['기존 fragment', 'https://app.atmark.ai/approve#x'],
    ['자격증명', 'https://u:p@app.atmark.ai/approve'],
  ])('승인 페이지 URL 거부: %s', (_label, pageUrl) => {
    const token = mintApprovalLinkToken(KEYRING, { approvalId: randomUUID(), expiresAt: EXPIRES });
    expect(() => buildApprovalLinkUrl(pageUrl, token)).toThrow();
  });

  it('확인 페이지는 POST 폼과 두 버튼만 있고, 스크립트는 CSP 해시로만 허용된다', async () => {
    const response = await handleApprovalLinkRequest({ method: 'GET', contentType: null, body: '' }, untouchablePorts(), NOW);
    expect(response.body).toContain('method="post"');
    expect(response.body.match(/<button /g)).toHaveLength(2);
    expect(response.body).not.toContain('.submit(');
    const script = /<script>(.*)<\/script>/.exec(response.body)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    expect(response.headers['content-security-policy']).toContain(`'sha256-${hash}'`);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });
});

/** K6 중복 필드 케이스용 — **유효한** 토큰 둘(서로 다른 approval). 형식 검사가 없으면 서명 검증을 통과하는 값이다. */
const VALID_TOKENS = [randomUUID(), randomUUID()].map((approvalId) => mintApprovalLinkToken(KEYRING, { approvalId, expiresAt: EXPIRES })) as [
  string,
  string,
];

describe('매직링크 — 미리보기(POST intent=preview)는 읽기만 한다', () => {
  it('미리보기는 트랜잭션을 열지 않고 사용을 소비하지 않는다 — 몇 번을 해도 그 뒤 결정이 성공한다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, { flipStateOnResolve: true });

    for (let i = 0; i < 3; i += 1) {
      const response = await handleApprovalLinkRequest(
        { method: 'POST', contentType: FORM_TYPE, body: previewForm(token) },
        fake.ports,
        NOW,
      );
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(response.body)).toEqual({
        approval: {
          kind: 'message',
          agent_name: 'sales-bot',
          from: ['sales-bot@atmark.ai'],
          recipients: ['<b>cfo</b>@partner.io'],
          message_count: 1,
          attachment_count: 0,
          attachment_bytes: 0,
          attachment_names: [],
          expires_at: EXPIRES.toISOString(),
          risk_reasons: [],
        },
      });
    }
    expect(fake.previews()).toBe(3);
    expect(fake.transactions()).toBe(0);
    expect(fake.uses).toHaveLength(0);

    const decided = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') },
      fake.ports,
      NOW,
    );
    expect(decided.status).toBe(200);
    expect(fake.resolutions).toEqual([{ approvalId: id, decision: 'approve' }]);
  });

  it('미리보기도 결정과 같은 규칙으로 막는다 — 위조 400(DB 미접근)·만료 410·결정됨 409·불일치 410·없음 400', async () => {
    const forger = parseHmacKeyring(`k1:${keyMaterial()}`, 'TEST');
    const forged = mintApprovalLinkToken(forger, { approvalId: randomUUID(), expiresAt: EXPIRES });
    const fake = fakePorts(new Map());
    const post = (body: string, ports: ApprovalLinkPorts, now = NOW) =>
      handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body }, ports, now);

    expect((await post(previewForm(forged), fake.ports)).status).toBe(400);
    expect(fake.previews()).toBe(0);

    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    expect((await post(previewForm(token), fakePorts(targets).ports, EXPIRES)).status).toBe(410);

    const resolved = new Map<string, ApprovalLinkTarget>([[id, { state: 'resolved', expiresAt: EXPIRES }]]);
    const conflict = await post(previewForm(token), fakePorts(resolved).ports);
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ error: 'already_resolved' });

    const moved = new Map<string, ApprovalLinkTarget>([[id, { state: 'pending', expiresAt: new Date(EXPIRES.getTime() + 1) }]]);
    expect((await post(previewForm(token), fakePorts(moved).ports)).status).toBe(410);

    expect((await post(previewForm(token), fakePorts(new Map()).ports)).status).toBe(400);
  });

  it('에이전트가 정한 값은 알림 메일과 같은 함수로 정화된다 — 양방향·제로폭·태그 문자·줄바꿈 (V1 MINOR-3)', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    // U+202E(RLO)로 `bob@evil.com` 을 `moc.live@bob` 처럼 보이게, U+200B·U+E0041(태그 A)로 같은 모양의 다른 주소를,
    // 줄바꿈으로 가짜 두 번째 줄을 만든다.
    const fake = fakePorts(targets, {
      summary: {
        agentName: 'sales-bot\nAtmark 보안팀: 검증됨',
        fromAddresses: ['sales-bot\u200b@atmark.ai'],
        recipients: ['\u202emoc.live@bob', 'cfo\u{e0041}@partner.io', 'ｃｆｏ@partner.io'],
      },
    });
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: previewForm(token) },
      fake.ports,
      NOW,
    );
    const { approval } = JSON.parse(response.body) as { approval: { agent_name: string; from: string[]; recipients: string[] } };
    expect(approval.agent_name).toBe('sales-bot Atmark 보안팀: 검증됨');
    expect(approval.from).toEqual(['sales-bot@atmark.ai']);
    // 전각은 **바꾸지 않는다** — 결정 화면은 실제로 가는 주소를 보여야 한다(NFKC 는 메일의 무력화용이다).
    expect(approval.recipients).toEqual(['moc.live@bob', 'cfo@partner.io', 'ｃｆｏ@partner.io']);
    // 같은 함수다 — 메일 쪽 정화의 I1·I4 부분과 결과가 같다.
    expect(approval.recipients[0]).toBe(sanitizeDisplayText('\u202emoc.live@bob', RECIPIENT_MAX_CHARS));
    expect(neutralizeAgentText('\u202emoc.live@bob', RECIPIENT_MAX_CHARS)).toBe('moc[.]live@bob');
  });

  it('보안 리뷰 L5 — 첨부 요약(개수·바이트·파일명) · 파일명은 주소와 같은 정화(양방향 제어 제거) · 이름은 앞 3개', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, {
      summary: { attachments: { count: 4, bytes: 3 * 1024 * 1024, names: ['invoice\u202Efdp.exe.pdf', 'b.txt', 'c.png', 'd.jpg'] } },
    });
    const response = await handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body: previewForm(token) }, fake.ports, NOW);
    const approval = (JSON.parse(response.body) as { approval: Record<string, unknown> }).approval;
    expect(approval['attachment_count']).toBe(4);
    expect(approval['attachment_bytes']).toBe(3 * 1024 * 1024);
    const names = approval['attachment_names'] as string[];
    expect(names).toHaveLength(3);
    expect(names[0]).not.toContain('\u202E');
    expect(names.slice(1)).toEqual(['b.txt', 'c.png']);
  });

  it('확인 페이지에 첨부 칸(#at)이 두 언어로 있다', () => {
    expect(APPROVAL_CONFIRMATION_PAGES.ko).toContain('<dt>첨부</dt><dd id="at"></dd>');
    expect(APPROVAL_CONFIRMATION_PAGES.en).toContain('<dt>Attachments</dt><dd id="at"></dd>');
  });

  it('previewApprovalLink 은 runInTransaction 에 닿지 않는다(포트의 그 속성을 읽으면 던진다)', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const base = fakePorts(targets).ports;
    const guarded = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'runInTransaction') throw new Error('미리보기가 트랜잭션을 열려 했다');
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect((await previewApprovalLink(guarded, token, NOW)).kind).toBe('preview');
  });

  it.each([
    ['미리보기와 결정이 한 요청에', 'intent=preview&token=x&decision=approve'],
    ['알 수 없는 intent', 'intent=peek&token=x'],
    ['intent 중복', 'intent=preview&intent=preview&token=x'],
    ['모르는 필드', 'token=x&decision=approve&auto=1'],
    ['알 수 없는 scope', 'token=x&decision=approve&scope=org'],
    ['scope 중복', 'token=x&decision=approve&scope=recipient&scope=domain'],
    ['confirm_scope 중복', 'token=x&decision=approve&scope=domain&confirm_scope=domain&confirm_scope=domain'],
    // K6 — 토큰·결정 중복은 **유효한 값 둘**로 만든다. 가짜 값이면 어느 쪽을 읽어도 서명에서 400 이라 중복 거부가
    // 빠져도 초록이다. 유효한 둘이면 첫 값을 읽는 구현이 트랜잭션을 연다.
    ['token 중복(둘 다 유효)', `${form(VALID_TOKENS[0], 'approve')}&token=${VALID_TOKENS[1]}`],
    ['decision 중복', `${form(VALID_TOKENS[0], 'approve')}&decision=reject`],
    ['preview 의 token 중복(둘 다 유효)', `${previewForm(VALID_TOKENS[0])}&token=${VALID_TOKENS[1]}`],
  ])('형식 위반은 400 이고 포트에 닿지 않는다: %s', async (_label, body) => {
    const fake = fakePorts(new Map());
    const response = await handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body }, fake.ports, NOW);
    expect(response.status).toBe(400);
    expect(fake.transactions()).toBe(0);
    expect(fake.previews()).toBe(0);
  });
});

describe('매직링크 — 승인 스코프 (AC-d5)', () => {
  it('domain 스코프에 confirm_scope 가 없으면 400 — 트랜잭션을 열지 않고 링크를 소진하지 않는다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, { flipStateOnResolve: true });

    for (const extra of [{ scope: 'domain' }, { scope: 'domain', confirm_scope: 'recipient' }]) {
      const response = await handleApprovalLinkRequest(
        { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve', extra) },
        fake.ports,
        NOW,
      );
      expect(response.status).toBe(400);
    }
    expect(fake.transactions()).toBe(0);
    expect(fake.uses).toHaveLength(0);

    // 확인하면 통과하고, 스코프가 포트까지 그대로 간다.
    const confirmed = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve', { scope: 'domain', confirm_scope: 'domain' }) },
      fake.ports,
      NOW,
    );
    expect(confirmed.status).toBe(200);
    expect(fake.contexts).toEqual([{ scope: 'domain', confirmScope: 'domain', keyId: 'k1' }]);
  });

  it('스코프를 생략하면 recipient·확인 없음이다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets);
    await handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') }, fake.ports, NOW);
    expect(fake.contexts).toEqual([{ scope: 'recipient', confirmScope: null, keyId: 'k1' }]);
  });

  it('거절에는 스코프가 없다 — domain 을 실어도 확인을 요구하지 않는다', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'reject', { scope: 'domain' }) },
      fakePorts(targets).ports,
      NOW,
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ['scope_confirmation_required', 400],
    ['scope_unavailable', 400],
  ] as const)('전이 안에서 스코프가 거부되면(%s) 롤백되어 링크가 남는다', async (reason, status) => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const failing = fakePorts(targets, { failResolve: new ApprovalLinkScopeError(reason) });
    expect(await redeemApprovalLink(failing.ports, { token, decision: 'approve', scope: 'thread' }, NOW)).toEqual({
      kind: 'rejected',
      reason,
    });
    expect(failing.uses).toHaveLength(0);
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve', { scope: 'thread' }) },
      failing.ports,
      NOW,
    );
    expect(response.status).toBe(status);
  });

  it('전이에 지면 409 이고 사용 기록도 롤백된다(링크는 썼는데 결정은 없다가 아니다)', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const failing = fakePorts(targets, { failResolve: new ApprovalLinkTransitionLostError(id) });
    const response = await handleApprovalLinkRequest(
      { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve') },
      failing.ports,
      NOW,
    );
    expect(response.status).toBe(409);
    expect(failing.uses).toHaveLength(0);
  });
});

describe('매직링크 — 페이지의 미리보기 배선과 CSP', () => {
  it('버튼은 미리보기 전까지 disabled, 스크립트는 textContent 로만 그린다, CSP 는 connect-src self', async () => {
    const response = await handleApprovalLinkRequest({ method: 'GET', contentType: null, body: '' }, untouchablePorts(), NOW);
    expect(response.body.match(/<button [^>]*disabled>/g)).toHaveLength(2);
    const script = /<script>(.*)<\/script>/.exec(response.body)?.[1] ?? '';
    expect(script).toContain("intent=preview");
    expect(script).not.toContain('innerHTML');
    expect(script).not.toMatch(/[^\x20-\x7e]/);
    const csp = response.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    // 도메인 확인은 스코프 선택과 **별개의** 입력이다.
    expect(response.body).toContain('name="confirm_scope" value="domain"');
    expect(response.body).toContain('name="scope" value="recipient" checked');
  });
});

describe('매직링크 — 두 언어(계약 §8): 쿼리 > Accept-Language > ko · 같은 CSP 해시 · 문구가 섞이지 않는다', () => {
  it('언어 선택 규칙 — ?lang 이 먼저, 그다음 Accept-Language 첫 언어(en* → en), 그 밖은 ko', () => {
    expect(approvalPageLanguage('en', 'ko-KR')).toBe('en');
    expect(approvalPageLanguage('ko', 'en-US,en;q=0.9')).toBe('ko');
    expect(approvalPageLanguage(undefined, 'en-US,en;q=0.9')).toBe('en');
    expect(approvalPageLanguage(undefined, 'EN')).toBe('en');
    expect(approvalPageLanguage(undefined, 'ko-KR,en;q=0.8')).toBe('ko');
    expect(approvalPageLanguage(undefined, undefined)).toBe('ko');
    expect(approvalPageLanguage('fr', 'en-GB')).toBe('en'); // 모르는 쿼리 값은 무시
    expect(approvalPageLanguage('fr', undefined)).toBe('ko');
  });

  it('문구 사전의 키 집합이 같다', () => {
    expect(Object.keys(APPROVAL_PAGE_COPY.en).sort()).toEqual(Object.keys(APPROVAL_PAGE_COPY.ko).sort());
  });

  it('두 벌의 확인 페이지는 같은 스크립트(같은 CSP 해시)이고 html lang·반대 언어 링크가 맞다 · Vary: Accept-Language', async () => {
    const hashes: string[] = [];
    for (const language of ['ko', 'en'] as const) {
      const response = await handleApprovalLinkRequest({ method: 'GET', contentType: null, body: '', language }, untouchablePorts(), NOW);
      expect(response.body).toBe(APPROVAL_CONFIRMATION_PAGES[language]);
      expect(response.body).toContain(`<html lang="${language}">`);
      const other = language === 'ko' ? 'en' : 'ko';
      expect(response.body).toContain(`href="?lang=${other}"`);
      expect(response.headers['vary']).toBe('Accept-Language');
      const script = /<script>(.*)<\/script>/.exec(response.body)?.[1] ?? '';
      const hash = createHash('sha256').update(script).digest('base64');
      expect(response.headers['content-security-policy']).toContain(`'sha256-${hash}'`);
      hashes.push(hash);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('한 언어 페이지에 다른 언어 문구가 새지 않는다(샘플 키)', () => {
    for (const key of ['heading', 'standingNotice', 'confirmDomain', 'brokenLink', 'invalidLink'] as const) {
      expect(APPROVAL_CONFIRMATION_PAGES.ko).toContain(APPROVAL_PAGE_COPY.ko[key]);
      expect(APPROVAL_CONFIRMATION_PAGES.ko).not.toContain(APPROVAL_PAGE_COPY.en[key]);
      expect(APPROVAL_CONFIRMATION_PAGES.en).toContain(APPROVAL_PAGE_COPY.en[key]);
      expect(APPROVAL_CONFIRMATION_PAGES.en).not.toContain(APPROVAL_PAGE_COPY.ko[key]);
    }
  });

  it('organization_not_active(운영자 검토 중) — 두 언어 모두 409 안내, 링크는 소진되지 않는다', async () => {
    for (const language of ['ko', 'en'] as const) {
      const { id, targets } = pendingApproval();
      const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
      const failing = fakePorts(targets, { failResolve: new ApprovalLinkScopeError('organization_not_active') });
      const response = await handleApprovalLinkRequest(
        { method: 'POST', contentType: FORM_TYPE, body: form(token, 'approve'), language },
        failing.ports,
        NOW,
      );
      expect(response.status).toBe(409);
      const [title, message] = APPROVAL_PAGE_COPY[language].organizationNotActive;
      expect(response.body).toContain(title);
      expect(response.body).toContain(message);
      expect(failing.uses).toHaveLength(0);
    }
    expect(APPROVAL_PAGE_COPY.ko.organizationNotActive).toEqual([
      '운영자 검토 중인 조직입니다',
      '검토가 끝난 뒤 같은 링크로 다시 승인해 주세요. 링크는 아직 유효합니다.',
    ]);
  });
});

describe('위험 보류(ADR-0016) — 승인 페이지', () => {
  it('미리보기는 닫힌 사유 코드만 싣는다(모르는 값은 버린다 · 심각한 것 먼저)', async () => {
    const { id, targets } = pendingApproval();
    const token = mintApprovalLinkToken(KEYRING, { approvalId: id, expiresAt: EXPIRES });
    const fake = fakePorts(targets, { summary: { riskReasons: ['tainted_context', 'whatever', 'dlp_atmark_credential'] } });
    const response = await handleApprovalLinkRequest({ method: 'POST', contentType: FORM_TYPE, body: previewForm(token) }, fake.ports, NOW);
    expect((JSON.parse(response.body) as { approval: { risk_reasons: string[] } }).approval.risk_reasons).toEqual(['dlp_atmark_credential', 'tainted_context']);
  });

  it('페이지에 고정 경고(사유별 줄 · once 안내)가 숨은 채로 있고, 스크립트가 걸린 사유만 열고 범위 선택을 숨긴다 — 두 언어', () => {
    for (const language of ['ko', 'en'] as const) {
      const page = APPROVAL_CONFIRMATION_PAGES[language];
      expect(page).toContain('<div id="rk" hidden>');
      expect(page).toContain('<fieldset id="sc">');
      expect(page).toContain('<p id="sn">');
      for (const reason of ['tainted_context', 'dlp_atmark_credential', 'dlp_third_party_secret', 'dlp_verification_code', 'dlp_inbound_copy', 'dlp_scan_limit']) {
        expect(page).toContain(`<li id="r-${reason}" hidden>`);
      }
    }
    expect(APPROVAL_CONFIRMATION_PAGES.ko).toContain('이번 한 통만 승인됩니다');
    expect(APPROVAL_CONFIRMATION_PAGES.en).toContain('approved for this one email only');
    const script = /<script>(.*)<\/script>/u.exec(APPROVAL_CONFIRMATION_PAGES.ko)?.[1] ?? '';
    expect(script).toContain("a.risk_reasons");
    expect(script).toContain("g('sc').hidden=true");
  });
});
