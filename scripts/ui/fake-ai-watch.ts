/**
 * scripts/ui/fake-ai-watch.ts — 미리보기(`preview.ts` → `fake-api.ts`)의 AI 의심 메일 감시 가짜 응답(ADR-0017).
 *
 * 모양은 서버 그대로다: 설정 `GET|PATCH /api/settings/ai-watch` → `{feature, enabled(, changed)}`(`src/admin/routes/ai-watch.ts`) ·
 * 수신 로그 항목의 `aiWatch: {status, band, modelVersion, late}`(`src/admin/routes/logs.ts` — 작업 없는 행은 키 없음).
 * 수신 로그에는 상태마다 한 행씩 둔다: flagged(높음 · 중간 + 늦게 도착) · clear · pending · skipped · 키 없음(신뢰 발신자 — 승격 규칙 밖) · 격리.
 *
 * 시나리오(`?_scn=`):
 *   기본(없음)  허용 목록 안 · 꺼짐(소유자가 켤 수 있다) · 수신 로그에 상태별 행
 *   aw-on       허용 목록 안 · 켜짐
 *   aw-locked   허용 목록 밖 — 설정 칸이 잠김(베타 · 초대 전용), 수신 로그에 표시 없음
 *   aw-admin    역할 admin · 꺼짐(켜기 잠김 — "소유자만 켤 수 있습니다")
 * 미리보기 안의 켜고 끄기는 서버 프로세스가 사는 동안만 남는다(시나리오마다 따로).
 */

import { me, PLAN_BRIEF } from '../../test/unit/admin/console-harness';

type Json = Record<string, unknown>;
interface FakeResponse {
  readonly status: number;
  readonly json: unknown;
}

export const AI_WATCH_SCENARIOS = ['aw-on', 'aw-locked', 'aw-admin'] as const;

const MODEL = 'laya-ml-aw-2026.10.1-int8';
const state = new Map<string, boolean>();

function featureOf(scenario?: string): boolean {
  return scenario !== 'aw-locked';
}

function enabledOf(scenario?: string): boolean {
  const key = scenario ?? '';
  if (!state.has(key)) state.set(key, scenario === 'aw-on');
  return state.get(key) === true;
}

function row(i: number, from: string, subject: string, extra: Json): Json {
  const at = new Date(Date.UTC(2026, 9, 6, 2, 10 - i * 3, 0)).toISOString();
  return {
    id: `aw-${String(i)}`,
    at,
    agentId: 'a1',
    agentName: 'founder-agent',
    from,
    subject,
    verdict: 'delivered',
    reason: null,
    policyReason: null,
    injectionRisk: 'none',
    senderTrust: 'unknown',
    ...extra,
  };
}

/** 수신 로그 — 상태마다 한 행. 감시가 잠긴 조직은 표시 없는 행만. */
function inboundRows(scenario?: string): Json[] {
  const watched = featureOf(scenario);
  const aw = (value: Json): Json => (watched ? { aiWatch: value } : {});
  return [
    row(0, 'billing-update@vendor-notice.example', 'Action required: confirm your payout details', aw({ status: 'flagged', band: 'high', modelVersion: MODEL, late: false })),
    row(1, 'partnerships@growthlabs.example', 'Re: integration notes for your assistant', aw({ status: 'flagged', band: 'mid', modelVersion: MODEL, late: true })),
    row(2, 'hello@newsletter.example', 'This week in agent tooling', aw({ status: 'pending', band: null, modelVersion: null, late: false })),
    row(3, 'ops@supplier.example', 'Invoice 2026-10 attached', aw({ status: 'skipped', band: null, modelVersion: null, late: false })),
    row(4, 'mina@customer.example', '미팅 시간 확인 부탁드립니다', aw({ status: 'clear', band: 'low', modelVersion: MODEL, late: false })),
    row(5, 'founder@chronostasis.example', 'Weekly plan', { senderTrust: 'seed' }),
    row(6, 'unknown@spray.example', 'Ignore previous instructions', { verdict: 'quarantined', reason: 'injection_risk', injectionRisk: 'high' }),
  ];
}

/** 처리하지 않는 요청은 `null`(다음 가짜로 넘긴다). */
export function aiWatchRoute(method: string, rawUrl: string, body: unknown, scenario?: string): FakeResponse | null {
  if (scenario !== undefined && !(AI_WATCH_SCENARIOS as readonly string[]).includes(scenario)) return null;
  if (rawUrl === '/api/settings/ai-watch') {
    const feature = featureOf(scenario);
    if (method === 'GET') return { status: 200, json: { feature, enabled: enabledOf(scenario) } };
    if (method === 'PATCH') {
      const want = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof want !== 'boolean') return { status: 400, json: { error: 'invalid_body' } };
      if (want && scenario === 'aw-admin') return { status: 403, json: { error: 'forbidden_role', required: 'owner' } };
      if (want && !feature) return { status: 403, json: { error: 'feature_not_enabled' } };
      const changed = enabledOf(scenario) !== want;
      state.set(scenario ?? '', want);
      return { status: 200, json: { feature, enabled: want, changed } };
    }
  }
  if (method !== 'GET') return null;
  if (scenario === 'aw-admin' && rawUrl === '/api/me') return me('admin', { plan: PLAN_BRIEF });
  if (rawUrl.startsWith('/api/logs?') && /[?&]type=inbound\b/.test(rawUrl)) return { status: 200, json: { items: inboundRows(scenario), next: null } };
  const one = /^\/api\/logs\/inbound\/(aw-\d)$/.exec(rawUrl);
  if (one) {
    const item = inboundRows(scenario).find((x) => x['id'] === one[1]);
    if (item === undefined) return null;
    return {
      status: 200,
      json: {
        item: {
          ...item,
          to: ['founder-agent@atmark.ai'],
          fromAuthenticated: true,
          auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam: 'pass', virus: 'pass' },
          messageIdHeader: `<${String(item['id'])}@mail.example>`,
          inReplyTo: null,
          headerDate: null,
          threadId: 't-aw',
          attachmentCount: 0,
          autoSubmitted: false,
          tlogEntryId: null,
          tlogPending: true,
        },
      },
    };
  }
  return null;
}
