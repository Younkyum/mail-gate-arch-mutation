/**
 * 문서 스크린샷(`src/docs/generated/shots.ts` — `pnpm gen:docs-shots` 가 실제 콘솔 화면에서 찍는다)의 모양과 원천:
 *   - 등록부(`shots.ts`)의 id 만 있고, 각 id 는 두 언어 × 두 테마 WebP · 경로의 해시 = 바이트 해시 · 핸들러가 1년 immutable 로 낸다.
 *   - 발급 직후 대화상자를 찍는 가짜 API 시나리오 `docs` 는 토큰·키 값을 **토큰 모양이 아닌 예시 글자**로 바꾼다(계획 §6) — 캡처 스크립트의
 *     검사 정규식(`TOKEN_SHAPE`)이 공허하지 않다(하네스의 진짜 모양 값은 잡는다).
 * 다시 찍지 않는다(Chrome 없음) — 커밋된 바이트만 본다.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isExampleLocalPart, screenAddressProblems, TOKEN_SHAPE } from '../../../scripts/gen-docs-shots';
import { DOCS_AGENT_IDS, DOCS_EXAMPLE_ORG_KEY, DOCS_EXAMPLE_TOKEN, docsAddress, fakeConsoleApi } from '../../../scripts/ui/fake-api';
import { AgentAddressError, buildAgentAddress, EXAMPLE_RESERVED_LOCAL_PARTS, RESERVED_LOCAL_PARTS } from '../../../src/identity/address';
import { handleDocsRequest } from '../../../src/docs/http';
import { DOCS_SHOT_IMAGES } from '../../../src/docs/generated/shots';
import { DOCS_SHOT_AGENT_ID, DOCS_SHOTS, isDocsShotId } from '../../../src/docs/shots';
import { NEW_TOKEN, ORG_KEY } from '../admin/console-harness';

describe('스크린샷 바이트', () => {
  it('등록부에 있는 id 만 · 두 언어 × 두 테마 · WebP · 경로 해시 = 바이트 해시', () => {
    const ids = Object.keys(DOCS_SHOT_IMAGES);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isDocsShotId(id), id).toBe(true);
      for (const lang of ['ko', 'en'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const img = DOCS_SHOT_IMAGES[id]?.[lang][theme];
          if (img === undefined) throw new Error(`${id} ${lang} ${theme} 없음`);
          const bytes = Buffer.from(img.base64, 'base64');
          expect(bytes.subarray(0, 4).toString('latin1'), id).toBe('RIFF');
          expect(bytes.subarray(8, 12).toString('latin1'), id).toBe('WEBP');
          expect(bytes.length).toBe(img.bytes);
          const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
          expect(img.hash).toBe(hash);
          expect(img.path).toBe(`/_img/${hash}/${id}-${lang}-${theme}.webp`);
        }
      }
    }
  });

  it('등록부의 모든 id 가 찍혀 있다', () => {
    expect(Object.keys(DOCS_SHOTS).filter((id) => DOCS_SHOT_IMAGES[id] === undefined)).toEqual([]);
  });

  it('핸들러가 낸다 — image/webp · 1년 immutable · base64', () => {
    const img = Object.values(DOCS_SHOT_IMAGES)[0]?.ko.light;
    if (img === undefined) throw new Error('샷 없음');
    const r = handleDocsRequest({ rawPath: img.path, requestContext: { http: { method: 'GET' } } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.isBase64Encoded).toBe(true);
    expect(r.body).toBe(img.base64);
  });
});

describe('발급 값 — 토큰 모양이 아닌 예시 글자', () => {
  it('검사 정규식은 진짜 모양 값을 잡고 예시 글자는 통과시킨다', () => {
    expect(TOKEN_SHAPE.test(NEW_TOKEN)).toBe(true);
    expect(TOKEN_SHAPE.test(ORG_KEY)).toBe(true);
    expect(TOKEN_SHAPE.test(DOCS_EXAMPLE_TOKEN)).toBe(false);
    expect(TOKEN_SHAPE.test(DOCS_EXAMPLE_ORG_KEY)).toBe(false);
  });

  it('시나리오 docs — 토큰 발급·조직 키 발급 응답의 값을 예시 글자로 바꾼다', () => {
    const token = fakeConsoleApi('POST', '/api/agents/a1/tokens', { label: 'hermes', capabilities: ['send'] }, 'docs');
    expect((token.json as { token: string }).token).toBe(DOCS_EXAMPLE_TOKEN);
    const key = fakeConsoleApi('POST', '/api/org-keys', { label: 'ci', capabilities: ['agents:read'] }, 'docs');
    expect((key.json as { key: string }).key).toBe(DOCS_EXAMPLE_ORG_KEY);
    // 기본 데이터는 그대로(다른 스크린샷 도구에 영향 없음).
    expect((fakeConsoleApi('POST', '/api/agents/a1/tokens', { label: 'x', capabilities: ['send'] }).json as { token: string }).token).toBe(NEW_TOKEN);
  });

  it('시나리오 docs-pending — 예시 조직이 검토 대기', () => {
    const me = fakeConsoleApi('GET', '/api/me', undefined, 'docs-pending').json as { organization: { name: string; reviewStatus: string } };
    expect(me.organization.name).toBe('Example Labs');
    expect(me.organization.reviewStatus).toBe('pending_review');
  });
});

describe('보안 검토 F1 · 비평 5 — 문서 스크린샷 예시 데이터', () => {
  const routes = (id: string): string[] => [
    '/api/me',
    '/api/agents',
    '/api/agents?limit=50',
    `/api/agents/${id}`,
    `/api/agents/${id}/identity`,
    // 신원 화면의 변경 이력 — 기본 데이터(하네스 a1 = founder@)가 그대로 흘러 캡처 검사에 걸렸다(2026-09-29).
    `/api/agents/${id}/identity-blocks`,
    `/api/agents/${id}/tokens?status=active`,
    `/api/agents/${id}/tokens?status=all`,
    `/api/agents/${id}/channels/email/policy`,
    `/api/agents/${id}/addresses`,
    `/api/agents/${id}/aliases`,
    '/api/stats?days=7',
    '/api/logs?type=outbound&limit=50',
    '/api/logs?type=inbound&limit=50',
    '/api/logs?type=scheduled&limit=50',
    '/api/members',
    '/api/org-keys?status=all',
    '/api/plan',
  ];
  const addresses = (json: unknown): string[] => [...JSON.stringify(json).matchAll(/([a-z0-9][a-z0-9._-]*)@atmark\.ai/gi)].map((m) => (m[1] ?? '').toLowerCase());

  it('응답 속 @atmark.ai 주소는 전부 예시 예약 이름(아무도 발급받을 수 없다)이다 — docs · docs-pending · landing(홈 히어로·OG) · blog', () => {
    let seen = 0;
    for (const scenario of ['docs', 'docs-pending', 'landing', 'blog']) {
      for (const url of [...routes(DOCS_SHOT_AGENT_ID), ...routes('a1')]) {
        for (const local of addresses(fakeConsoleApi('GET', url, undefined, scenario).json)) {
          seen += 1;
          expect(isExampleLocalPart(local), `${scenario} ${url} ${local}`).toBe(true);
          expect(RESERVED_LOCAL_PARTS.includes(local), `${scenario} ${url} ${local}`).toBe(true);
        }
      }
      if (scenario !== 'landing') {
        const issued = fakeConsoleApi('POST', `/api/agents/${DOCS_SHOT_AGENT_ID}/tokens`, { label: 'x', capabilities: ['send'] }, scenario).json;
        for (const local of addresses(issued)) expect(isExampleLocalPart(local), local).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(5);
    // 규칙이 공허하지 않다 — 실제 서비스 주소·발급 가능한 이름·예전 `-demo` 이름은 걸린다.
    expect(screenAddressProblems('support@atmark.ai · scout@atmark.ai · ops@atmark.ai · desk-demo@atmark.ai · nova@atmark.ai')).toEqual([
      'support@atmark.ai',
      'ops@atmark.ai',
      'desk-demo@atmark.ai',
      'nova@atmark.ai',
    ]);
    expect(docsAddress('support')).toBe('help-desk');
    expect(docsAddress('ops')).toBe('ops-pager');
    expect(docsAddress('founder')).toBe('scout');
  });

  it('예시 예약 이름은 전부 발급할 수 없다(같은 사유·같은 코드 — 목록의 용도를 드러내지 않는다)', () => {
    for (const local of EXAMPLE_RESERVED_LOCAL_PARTS) {
      expect(RESERVED_LOCAL_PARTS).toContain(local);
      let caught: unknown;
      try {
        buildAgentAddress(local);
      } catch (e) {
        caught = e;
      }
      expect(caught, local).toBeInstanceOf(AgentAddressError);
      expect((caught as AgentAddressError).reason).toBe('reserved_local_part');
    }
  });

  it('landing — 에이전트 이름 = 주소 로컬 파트', () => {
    const agents = fakeConsoleApi('GET', '/api/agents', undefined, 'landing').json as { name: string; address: string }[];
    expect(agents.length).toBeGreaterThan(3);
    for (const a of agents) expect(a.address).toBe(`${a.name}@atmark.ai`);
  });

  it('예시 에이전트 id 는 32 hex — 등록부 경로와 가짜 API 가 같은 값', () => {
    expect(DOCS_SHOT_AGENT_ID).toBe(DOCS_AGENT_IDS['a1']);
    for (const hex of Object.values(DOCS_AGENT_IDS)) expect(hex).toMatch(/^[0-9a-f]{32}$/);
    const agent = fakeConsoleApi('GET', `/api/agents/${DOCS_SHOT_AGENT_ID}`, undefined, 'docs').json as { id: string };
    expect(agent.id).toBe(DOCS_SHOT_AGENT_ID);
    for (const spec of Object.values(DOCS_SHOTS)) expect(spec.path).not.toMatch(/\/agents\/a[0-9]+\b/);
  });

  it('신원 — 게시됨 · 공개 문서 세 링크 · 만료(발급 90일 뒤) · did 에 예시 id', () => {
    const x = fakeConsoleApi('GET', `/api/agents/${DOCS_SHOT_AGENT_ID}/identity`, undefined, 'docs').json as Record<string, string>;
    expect(x['status']).toBe('published');
    expect(x['did']).toBe(`did:web:id.atmark.ai:agents:${DOCS_SHOT_AGENT_ID}`);
    for (const k of ['didDocumentUrl', 'passportUrl', 'passportJwsUrl']) expect(x[k]).toMatch(new RegExp(`^https://id\\.atmark\\.ai/agents/${DOCS_SHOT_AGENT_ID}/(did\\.json|passport\\.json|passport\\.jws)$`));
    expect((Date.parse(x['validUntil'] ?? '') - Date.parse(x['issuedAt'] ?? '')) / 86_400_000).toBe(90);
  });

  it('로그 › 예약 — 취소할 수 있는 예약 · 에이전트가 취소한 예약 · 보낸 예약', () => {
    const items = (fakeConsoleApi('GET', '/api/logs?type=scheduled&limit=50', undefined, 'docs').json as { items: { status: string; cancelledVia: string | null }[] }).items;
    expect(items.map((i) => i.status)).toEqual(['scheduled', 'cancelled', 'dispatched']);
    expect(items[1]?.cancelledVia).toBe('mcp');
  });

  it('쓰지 않는 샷은 등록부에 없다(번들에 실리지 않게)', () => {
    expect(Object.keys(DOCS_SHOTS)).not.toContain('console-overview');
    expect(Object.keys(DOCS_SHOTS)).not.toContain('console-agents');
  });
});
