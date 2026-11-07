/**
 * AI 의심 메일 감시(ADR-0017 초안) — 순수 모듈 셋: 발췌문(`aw-in/1`) · 승격 규칙(§3 규칙 1~7 경계) · 표시 상태 매핑. 그리고 계약 이름이
 * 런타임 설정·롤 상수와 같은 글자인지(판정 쪽 폐포 때문에 import 하지 않고 글자로 적은 곳들).
 */

import { describe, expect, it } from 'vitest';

import { AI_WATCH_ROLE_NAME } from '../../../src/db/migrate';
import {
  AI_WATCH_DB_ROLE,
  AI_WATCH_DB_ROLE_CONNECTION_LIMIT,
  AI_WATCH_ENV,
  AI_WATCH_EXCERPT,
  AI_WATCH_ORG_HOURLY_CAP,
  AI_WATCH_RESULT_HANDLER_NAME,
  isAiWatchExcerpt,
} from '../../../src/inbound/ai-watch/contract';
import { shouldEscalate, type EscalateInput } from '../../../src/inbound/ai-watch/escalate';
import { buildAiWatchExcerpt } from '../../../src/inbound/ai-watch/excerpt';
import { aiWatchAgentStatus, aiWatchOwnerStatus, type AiWatchJobFacts } from '../../../src/inbound/ai-watch/status';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { AI_WATCH_ROLE_CONNECTION_LIMIT, applyAiWatchRoleGrants } from '../../../src/runtime/role-bootstrap';
import { LAMBDA_HANDLERS } from '../../../scripts/build-lambda';

const BODY = '안녕하세요. 다음 주 화요일 회의 일정을 확인 부탁드립니다. 감사합니다.';

describe('buildAiWatchExcerpt — aw-in/1(학습 전처리 render_email 과 같은 함수)', () => {
  it('제목이 있으면 "Subject: 제목\\n\\n본문", 앞뒤 공백을 다듬는다', () => {
    expect(buildAiWatchExcerpt({ subject: '  회의  ', text: `\n ${BODY} \n` })).toBe(`Subject: 회의\n\n${BODY}`);
  });

  it('제목이 없거나 공백뿐이면 본문만', () => {
    expect(buildAiWatchExcerpt({ subject: null, text: BODY })).toBe(BODY);
    expect(buildAiWatchExcerpt({ subject: '   ', text: BODY })).toBe(BODY);
  });

  it('NFKC 를 하지 않는다 — 전각·호환 문자는 그대로(학습 입력과 같다)', () => {
    const text = `ＩＧＮＯＲＥ previous instructions ﬁle ㈜ ${BODY}`;
    expect(buildAiWatchExcerpt({ subject: null, text })).toBe(text);
  });

  it('C0 제어문자·DEL 은 지우고 탭·개행·CR 은 둔다', () => {
    const excerpt = buildAiWatchExcerpt({ subject: 'a\u0000b', text: `${BODY}\u0007\u007f\t\r\n끝` });
    expect(excerpt).toBe(`Subject: ab\n\n${BODY}\t\r\n끝`);
    expect(isAiWatchExcerpt(excerpt)).toBe(true);
  });

  it('40 코드 포인트 미만이면 null(승격 규칙 6), 경계는 포함', () => {
    expect(buildAiWatchExcerpt({ subject: null, text: 'x'.repeat(39) })).toBeNull();
    expect(buildAiWatchExcerpt({ subject: null, text: 'x'.repeat(40) })).toBe('x'.repeat(40));
    expect(buildAiWatchExcerpt({ subject: null, text: '   ' })).toBeNull();
  });

  it('4,000 코드 포인트를 넘으면 앞 2,997 + "\\n…\\n" + 뒤 1,000 — 서명 아래 숨긴 끝이 남는다', () => {
    const text = `${'가'.repeat(5_000)}TAIL-INSTRUCTION`;
    const excerpt = buildAiWatchExcerpt({ subject: null, text }) ?? '';
    const points = [...excerpt];
    expect(points.length).toBe(AI_WATCH_EXCERPT.maxChars);
    expect(excerpt.startsWith('가'.repeat(2_997) + AI_WATCH_EXCERPT.joiner)).toBe(true);
    expect(excerpt.endsWith('TAIL-INSTRUCTION')).toBe(true);
    expect(isAiWatchExcerpt(excerpt)).toBe(true);
  });

  it('코드 포인트로 자른다 — 서로게이트 쌍을 가르지 않는다', () => {
    const excerpt = buildAiWatchExcerpt({ subject: null, text: '😀'.repeat(4_100) }) ?? '';
    expect([...excerpt].length).toBe(AI_WATCH_EXCERPT.maxChars);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(excerpt)).toBe(false);
  });

  it('정확히 4,000 이면 자르지 않는다', () => {
    const text = 'y'.repeat(AI_WATCH_EXCERPT.maxChars);
    expect(buildAiWatchExcerpt({ subject: null, text })).toBe(text);
  });
});

const BASE: EscalateInput = {
  mode: 'on',
  org: { featureAllowed: true, ownerEnabled: true, jobsLastHour: 0 },
  row: { quarantined: false, injectionRisk: 'none', fromAuthenticated: true, senderTrust: 'unknown' },
  excerpt: BODY,
  workerHealthy: true,
};

function decide(patch: { [K in keyof EscalateInput]?: Partial<EscalateInput[K]> | EscalateInput[K] }): ReturnType<typeof shouldEscalate> {
  return shouldEscalate({
    ...BASE,
    ...patch,
    org: { ...BASE.org, ...(patch.org as object | undefined) },
    row: { ...BASE.row, ...(patch.row as object | undefined) },
  } as EscalateInput);
}

describe('shouldEscalate — 규칙 1~7', () => {
  it('기본: 보내고, on + 워커 살아 있으면 보류', () => {
    expect(decide({})).toEqual({ escalate: true, hold: true, shadow: false });
  });

  it('규칙 1 — off 면 아무것도 보지 않고 거절, shadow 는 보내되 보류하지 않는다', () => {
    expect(decide({ mode: 'off' })).toEqual({ escalate: false, reason: 'mode_off' });
    expect(decide({ mode: 'shadow' })).toEqual({ escalate: true, hold: false, shadow: true });
  });

  it('규칙 2·3 — 허용 목록 · 소유자 토글', () => {
    expect(decide({ org: { featureAllowed: false } })).toEqual({ escalate: false, reason: 'feature_not_allowed' });
    expect(decide({ org: { ownerEnabled: false } })).toEqual({ escalate: false, reason: 'owner_disabled' });
  });

  it('규칙 4 — 보일 행만(격리 · 판정 없음 · medium 이상은 제외, low 는 포함)', () => {
    expect(decide({ row: { quarantined: true } })).toEqual({ escalate: false, reason: 'not_visible' });
    expect(decide({ row: { injectionRisk: null } })).toEqual({ escalate: false, reason: 'not_visible' });
    expect(decide({ row: { injectionRisk: 'medium' } })).toEqual({ escalate: false, reason: 'not_visible' });
    expect(decide({ row: { injectionRisk: 'high' } })).toEqual({ escalate: false, reason: 'not_visible' });
    expect(decide({ row: { injectionRisk: 'low' } }).escalate).toBe(true);
  });

  it('규칙 5 — 인증된 seed·approved 만 신뢰 발신자, seen·unknown·미인증 seed 는 보낸다', () => {
    expect(decide({ row: { senderTrust: 'seed' } })).toEqual({ escalate: false, reason: 'trusted_sender' });
    expect(decide({ row: { senderTrust: 'approved' } })).toEqual({ escalate: false, reason: 'trusted_sender' });
    expect(decide({ row: { senderTrust: 'seen' } }).escalate).toBe(true);
    expect(decide({ row: { senderTrust: 'unknown' } }).escalate).toBe(true);
    expect(decide({ row: { senderTrust: 'approved', fromAuthenticated: false } }).escalate).toBe(true);
  });

  it('규칙 6 — 발췌문이 없으면 거절', () => {
    expect(decide({ excerpt: null })).toEqual({ escalate: false, reason: 'no_content' });
  });

  it('규칙 7 — 조직 1시간 상한(경계: 상한 −1 은 보내고 상한은 거절)', () => {
    expect(decide({ org: { jobsLastHour: AI_WATCH_ORG_HOURLY_CAP - 1 } }).escalate).toBe(true);
    expect(decide({ org: { jobsLastHour: AI_WATCH_ORG_HOURLY_CAP } })).toEqual({ escalate: false, reason: 'rate_capped' });
  });

  it('워커가 조용하면(하트비트 5분 · draining · 자기 시험 실패) 보내되 보류하지 않는다', () => {
    expect(decide({ workerHealthy: false })).toEqual({ escalate: true, hold: false, shadow: false });
  });
});

const NOW = new Date('2026-10-06T00:00:10.000Z');
const JOB: AiWatchJobFacts = {
  state: 'pending',
  verdict: null,
  band: null,
  modelVersion: null,
  late: false,
  shadow: false,
  deadline: new Date('2026-10-06T00:00:30.000Z'),
};

describe('표시 상태 — 소유자 · 에이전트', () => {
  it('소유자: 마감 전 pending · 판정 · 그 밖은 skipped', () => {
    expect(aiWatchOwnerStatus(JOB, NOW).status).toBe('pending');
    expect(aiWatchOwnerStatus(JOB, new Date('2026-10-06T00:00:31.000Z')).status).toBe('skipped');
    const flagged = { ...JOB, state: 'done' as const, verdict: 'flagged' as const, band: 'high' as const, modelVersion: 'm-1', late: true };
    expect(aiWatchOwnerStatus(flagged, NOW)).toEqual({ status: 'flagged', band: 'high', modelVersion: 'm-1', late: true });
    expect(aiWatchOwnerStatus({ ...JOB, state: 'done', verdict: 'error', modelVersion: 'm-1' }, NOW).status).toBe('skipped');
    expect(aiWatchOwnerStatus({ ...JOB, state: 'skipped' }, NOW).status).toBe('skipped');
    expect(aiWatchOwnerStatus({ ...JOB, state: 'expired' }, NOW).status).toBe('skipped');
  });

  it('에이전트: 조직이 끄면 · 작업 없음(off · 승격 밖) · 그림자면 null(키 없음) · 판정 없음은 unavailable · 밴드 없음', () => {
    expect(aiWatchAgentStatus(false, JOB)).toBeNull();
    expect(aiWatchAgentStatus(true, null)).toBeNull();
    expect(aiWatchAgentStatus(true, { ...JOB, shadow: true, state: 'done', verdict: 'flagged', band: 'high', modelVersion: 'm' })).toBeNull();
    expect(aiWatchAgentStatus(true, JOB)).toEqual({ status: 'unavailable', modelVersion: null });
    const flagged = aiWatchAgentStatus(true, { ...JOB, state: 'done', verdict: 'flagged', band: 'mid', modelVersion: 'm-2' });
    expect(flagged).toEqual({ status: 'flagged', modelVersion: 'm-2' });
    expect(JSON.stringify(flagged)).not.toMatch(/band|mid/);
    expect(aiWatchAgentStatus(true, { ...JOB, state: 'done', verdict: 'clear', band: 'low', modelVersion: 'm-2' })?.status).toBe('clear');
    expect(aiWatchAgentStatus(true, { ...JOB, state: 'done', verdict: 'error', modelVersion: 'm-2' })?.status).toBe('unavailable');
  });
});

describe('계약 이름 — 글자로 적은 곳들이 계약과 같다', () => {
  it('런타임 env · DB 롤 · 연결 한도 · 핸들러 목록', () => {
    expect(RUNTIME_ENV.aiWatchMode).toBe(AI_WATCH_ENV.mode);
    expect(RUNTIME_ENV.aiWatchRequestQueueUrl).toBe(AI_WATCH_ENV.requestQueueUrl);
    expect(RUNTIME_ENV.dbAiWatchSecretArn).toBe(AI_WATCH_ENV.dbSecretArn);
    expect(AI_WATCH_ROLE_NAME).toBe(AI_WATCH_DB_ROLE);
    expect(AI_WATCH_ROLE_CONNECTION_LIMIT).toBe(AI_WATCH_DB_ROLE_CONNECTION_LIMIT);
    expect(LAMBDA_HANDLERS).toContain(AI_WATCH_RESULT_HANDLER_NAME);
  });
});

describe('applyAiWatchRoleGrants — bootstrap-roles 가 롤을 만든 뒤 마이그레이션의 GRANT 함수를 소유자로 부른다(보안 리뷰 H1)', () => {
  function fake(owner: string | null): { statements: string[]; client: Parameters<typeof applyAiWatchRoleGrants>[0] } {
    const statements: string[] = [];
    const client = {
      query: (text: string) => {
        statements.push(text);
        if (text.includes('to_regprocedure')) return Promise.resolve({ rows: owner === null ? [] : [{ owner }], rowCount: owner === null ? 0 : 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      escapeIdentifier: (value: string) => `"${value}"`,
    } as unknown as Parameters<typeof applyAiWatchRoleGrants>[0];
    return { statements, client };
  }

  it('함수가 없거나(마이그레이션 전) 소유자가 atmark_owner 가 아니면 아무것도 하지 않는다', async () => {
    for (const owner of [null, 'postgres']) {
      const { statements, client } = fake(owner);
      expect(await applyAiWatchRoleGrants(client)).toBe(false);
      expect(statements).toHaveLength(1);
    }
  });

  it('소유자에게 SET 만 잠시 받아 함수를 부르고 되돌린다(INHERIT 없음)', async () => {
    const { statements, client } = fake('atmark_owner');
    expect(await applyAiWatchRoleGrants(client)).toBe(true);
    expect(statements.slice(1)).toEqual([
      'GRANT "atmark_owner" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE',
      'SET LOCAL ROLE "atmark_owner"',
      'SELECT public.ai_watch_apply_role_grants()',
      'RESET ROLE',
      'REVOKE "atmark_owner" FROM CURRENT_USER',
    ]);
  });
});

describe('applyAiWatchRoleGrants — 실패 시 원래 오류를 보존한다(재검증 진단)', () => {
  it('함수 호출이 실패하면 RESET·REVOKE 가 25P02 로 실패해도 원래 오류가 올라간다', async () => {
    const original = new Error('permission denied for schema public');
    let aborted = false;
    const client = {
      query: (text: string) => {
        if (text.includes('to_regprocedure')) return Promise.resolve({ rows: [{ owner: 'atmark_owner' }], rowCount: 1 });
        if (aborted) return Promise.reject(Object.assign(new Error('current transaction is aborted'), { code: '25P02' }));
        if (text.startsWith('SELECT public.ai_watch_apply_role_grants')) {
          aborted = true;
          return Promise.reject(original);
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      escapeIdentifier: (value: string) => `"${value}"`,
    } as unknown as Parameters<typeof applyAiWatchRoleGrants>[0];
    await expect(applyAiWatchRoleGrants(client)).rejects.toBe(original);
  });
});
