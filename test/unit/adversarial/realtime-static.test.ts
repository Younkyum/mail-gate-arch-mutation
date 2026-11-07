/**
 * 적대적 검증(실시간 WebSocket E) — 정적 경계: API Gateway 접근 로그에 토큰이 실릴 자리가 없는가 · 실시간 λ 에 @connections 권한이 없는가 ·
 * 푸시 전송의 시간 상한이 푸시 상한 안인가 · 관리 API SDK 를 import 하는 파일이 하나뿐인가. 소스를 읽어 단언한다(synth 는 돌리지 않는다).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REALTIME_PRODUCER_HANDLERS, REALTIME_PRODUCER_ROLES, REALTIME_ROUTE_THROTTLES, REALTIME_STAGE_THROTTLE } from '../../../infra/cdk/stacks/compute-stack';
import { REALTIME_CONNECTION_TTL_SECONDS, REALTIME_MAX_CONNECTIONS_PER_AGENT, REALTIME_MAX_FRAME_BYTES, REALTIME_PUSH_TIMEOUT_MS } from '../../../src/realtime/contract';
import { REALTIME_POST_REQUEST_TIMEOUT_MS } from '../../../src/runtime/realtime-transport';

const ROOT = join(__dirname, '..', '..', '..');
const stack = readFileSync(join(ROOT, 'infra/cdk/stacks/compute-stack.ts'), 'utf8');
const region = stack.slice(stack.indexOf('══ 실시간 WebSocket(묶음 E'), stack.indexOf('══ 실시간 WebSocket 끝'));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('E1 — 접근 로그 · 라우트 구성에 토큰이 실릴 자리가 없다', () => {
  it('[E1-G-001] 실시간 구간을 찾았다(시험이 공허하지 않다)', () => {
    expect(region.length).toBeGreaterThan(1_000);
    expect(region).toContain('WebSocketStage');
    // 2026-10-08 — 스테이지 접근 로그를 없앴다(계정 단위 CloudWatch 역할 요구로 첫 배포 롤백). 로그 자체가 없으니 토큰이 실릴 자리도 없다.
    expect(region).not.toContain('accessLogSettings:');
  });

  it.each([
    ['[E1-G-002]', '$context.requestHeaders'],
    ['[E1-G-003]', '$context.queryString'],
    ['[E1-G-004]', '$context.requestOverride'],
    ['[E1-G-005]', '$context.authorizer'],
    ['[E1-G-006]', '$context.error.message'],
    ['[E1-G-007]', '$context.error.responseType'],
    ['[E1-G-008]', 'requestBody'],
    ['[E1-G-009]', '$context.identity.userAgent'],
    ['[E1-G-010]', '$context.identity.caller'],
  ])('%s 접근 로그 형식에 %s 가 없다', (_id, forbidden) => {
    const format = region.slice(region.indexOf('AccessLogFormat.custom'), region.indexOf('...(realtimeDomain'));
    expect(format).not.toContain(forbidden);
  });

  it('[E1-G-011] 라우트에 Lambda authorizer 를 따로 두지 않는다 — 토큰 판정은 λ 한 곳(REST 와 같은 함수)', () => {
    expect(region).not.toMatch(/WebSocketLambdaAuthorizer|authorizer:/);
  });

  it('[E1-G-012] (수정 뒤) $connect 는 스테이지 버킷(10/20)과 따로 낮은 버킷(3/10)이다 — 무인증 연결 폭주가 핑 · 메시지 버킷을 비우지 못한다', () => {
    expect(REALTIME_STAGE_THROTTLE).toEqual({ rateLimit: 10, burstLimit: 20 });
    expect(REALTIME_ROUTE_THROTTLES).toEqual({ $connect: { rateLimit: 3, burstLimit: 10 } });
    expect(region).toMatch(/routeSettings/);
  });
});

describe('E4 — 권한 경계(소스)', () => {
  it('[E4-G-001] 실시간 λ 의 역할은 PostToConnection 을 받는 역할 목록에 없다(연결을 쓸 수 있는 건 만드는 λ 뿐)', () => {
    expect(REALTIME_PRODUCER_ROLES as readonly string[]).not.toContain('realtime');
    expect(REALTIME_PRODUCER_HANDLERS as readonly string[]).not.toContain('realtime');
  });

  it('[E4-G-002] PostToConnection 정책은 이 API · 이 스테이지의 POST @connections 하나뿐이다(GET · DELETE · 다른 API 없음)', () => {
    expect(region).toMatch(/POST\/@connections\/\*`/);
    expect(region).not.toMatch(/GET\/@connections|DELETE\/@connections|\/\*\/\*\/@connections|execute-api:\*|execute-api:Invoke/);
    expect(region).toContain("actions: ['execute-api:ManageConnections']");
  });

  it('[E4-G-003] SUSPECT: 발송 역할(sender)을 쓰는 다른 λ(릴리스 워커들)도 이 역할로 임의 연결에 프레임을 쓸 수 있다(콜백 URL 환경이 없으면 코드가 꺼짐 — 역할 권한은 합집합)', () => {
    expect(REALTIME_PRODUCER_ROLES as readonly string[]).toContain('sender');
    expect(REALTIME_PRODUCER_HANDLERS).toHaveLength(4);
  });

  it('[E4-G-004] 상한 · 수명 · 프레임 상수가 계약대로다(연결 5 · 2시간 · 프레임 4096)', () => {
    expect(REALTIME_MAX_CONNECTIONS_PER_AGENT).toBe(5);
    expect(REALTIME_CONNECTION_TTL_SECONDS).toBe(7_200);
    expect(REALTIME_MAX_FRAME_BYTES).toBe(4_096);
  });

  it('[E4-G-005] 마이그레이션의 상한 · 수명이 계약 상수와 같다', () => {
    const sql = readFileSync(join(ROOT, 'src/db/migrations/202610081300_realtime_connections.sql'), 'utf8');
    expect(sql).toContain(">= 5 THEN");
    expect(sql).toMatch(/interval '2 hours'/);
  });
});

describe('E5 — 푸시 시간 · 격리', () => {
  it('[E5-G-001] 전송 한 번의 요청 타임아웃(800ms)은 푸시 전체 상한(1000ms) 안이다', () => {
    expect(REALTIME_POST_REQUEST_TIMEOUT_MS).toBeLessThan(REALTIME_PUSH_TIMEOUT_MS);
  });

  it('[E5-G-002] API Gateway 관리 API SDK 를 import 하는 소스 파일은 realtime-transport.ts 하나뿐이다', () => {
    const importers = sourceFiles(join(ROOT, 'src'))
      .filter((path) => readFileSync(path, 'utf8').includes('@aws-sdk/client-apigatewaymanagementapi'))
      .map((path) => path.slice(ROOT.length + 1));
    expect(importers).toEqual(['src/runtime/realtime-transport.ts']);
  });

  it('[E5-G-003] 전송은 재시도 없이 한 번(maxAttempts 1)이다 — 최대 한 번 전달', () => {
    const transport = readFileSync(join(ROOT, 'src/runtime/realtime-transport.ts'), 'utf8');
    expect(transport).toMatch(/maxAttempts: 1/);
  });

  it('[E5-G-004] 푸시를 부르는 곳은 수신 소비자 · 콘솔 풀기 · AI 감시 결과 · 승인 링크 넷뿐이다(타이머/스윕이 밀지 않는다)', () => {
    const callers = sourceFiles(join(ROOT, 'src'))
      .filter((path) => !path.includes('/realtime/'))
      .filter((path) => /\.(messagesVisible|aiWatchReleased|approvalResolved)\(/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(ROOT.length + 1))
      .sort();
    expect(callers).toEqual(['src/admin/routes/watch.ts', 'src/runtime/composition.ts', 'src/workers/ai-watch-result.ts', 'src/workers/inbound-consumer.ts']);
  });

  it('[E5-G-005] SUSPECT: 지연으로 AI 감시 보류가 시간만 지나 풀린 메일(판정 없음)은 아무 경로도 밀지 않는다 — 위 호출처에 타이머가 없다. 폴링이 따라잡는다', () => {
    const ai = readFileSync(join(ROOT, 'src/workers/ai-watch-result.ts'), 'utf8');
    expect(ai).toContain('aiWatchReleased(result.job_id)');
    const sweepers = sourceFiles(join(ROOT, 'src/workers')).filter((p) => /messagesVisible|aiWatchReleased/.test(readFileSync(p, 'utf8')));
    expect(sweepers.map((p) => p.slice(ROOT.length + 1)).sort()).toEqual(['src/workers/ai-watch-result.ts', 'src/workers/inbound-consumer.ts']);
  });
});
