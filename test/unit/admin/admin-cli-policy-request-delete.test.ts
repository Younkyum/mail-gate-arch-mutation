/**
 * `admin:policy-request` · `admin:agent-delete` 플래그 파싱 — 연결 전에 거부하는 것들. DB 없음.
 */

import { describe, expect, it } from 'vitest';

import { DELETE_REASON_MAX, parseAgentDeleteArgs } from '../../../scripts/admin/agent-delete';
import { actorOf, AdminInputError, isInputError } from '../../../scripts/admin/common';
import { changeText, parsePolicyRequestArgs, reasonPreview, REASON_PREVIEW_MAX } from '../../../scripts/admin/policy-request';

const AGENT = 'a'.repeat(32);
const REQ = '00000000-0000-4000-8000-000000000001';

describe('admin:policy-request 파싱', () => {
  it('동작 셋 중 정확히 하나 · 에이전트 id 모양', () => {
    expect(parsePolicyRequestArgs(['--agent', AGENT, '--list'])).toMatchObject({ action: 'list', ackRisk: false });
    expect(parsePolicyRequestArgs(['--agent', AGENT, '--approve', REQ, '--ack-risk', '--yes'])).toMatchObject({ action: 'approve', requestId: REQ, ackRisk: true, yes: true });
    expect(parsePolicyRequestArgs(['--agent', AGENT, '--reject', REQ, '--by', 'jin'])).toMatchObject({ action: 'reject', requestId: REQ, by: 'jin' });
    expect(parsePolicyRequestArgs(['--help'])).toBeNull();
    expect(() => parsePolicyRequestArgs(['--agent', AGENT])).toThrow(AdminInputError);
    expect(() => parsePolicyRequestArgs(['--agent', AGENT, '--list', '--reject', REQ])).toThrow(/정확히 하나/);
    expect(() => parsePolicyRequestArgs(['--agent', 'nope', '--list'])).toThrow(/--agent/);
    expect(() => parsePolicyRequestArgs(['--agent', AGENT, '--reject', REQ, '--ack-risk'])).toThrow(/--ack-risk/);
    expect(() => parsePolicyRequestArgs(['--agent', AGENT, '--approve', '  '])).toThrow(/요청 id/);
  });

  it('모르는 플래그는 exit 2(입력 오류) — 세션 · 사용자 흉내 플래그는 없다', () => {
    for (const flag of ['--session', '--user', '--expected-version']) {
      let caught: unknown;
      try {
        parsePolicyRequestArgs(['--agent', AGENT, '--approve', REQ, flag, 'x']);
      } catch (error) {
        caught = error;
      }
      expect(isInputError(caught)).toBe(true);
    }
  });

  it('표시 — 변경 한 줄 · 이유는 한 줄로 걸러 자른다', () => {
    expect(changeText({ action: 'set_mode', direction: 'inbound', mode: 'allowlist' } as never)).toBe('inbound mode → allowlist');
    expect(changeText({ action: 'remove_rule', direction: 'outbound', list: 'block', value: 'x@example.com' } as never)).toBe('outbound block − x@example.com');
    const preview = reasonPreview(`line one\nline two ${'z'.repeat(200)}`);
    expect(preview).not.toMatch(/[\n\r]/);
    expect(preview.length).toBeLessThanOrEqual(REASON_PREVIEW_MAX);
  });
});

describe('admin:agent-delete 파싱', () => {
  it('--reason 필수 · 한 줄 · 상한', () => {
    expect(parseAgentDeleteArgs(['--agent', AGENT, '--reason', ' abuse '])).toEqual({ agentId: AGENT, reason: 'abuse', fromOperatorSuspension: false, by: undefined, yes: false });
    expect(parseAgentDeleteArgs(['--agent', AGENT, '--reason', 'x', '--from-operator-suspension'])).toMatchObject({ fromOperatorSuspension: true });
    expect(parseAgentDeleteArgs(['--help'])).toBeNull();
    expect(() => parseAgentDeleteArgs(['--agent', AGENT])).toThrow(/--reason/);
    expect(() => parseAgentDeleteArgs(['--agent', AGENT, '--reason', ''])).toThrow(/--reason/);
    expect(() => parseAgentDeleteArgs(['--agent', AGENT, '--reason', 'a\nb'])).toThrow(/한 줄/);
    for (const bad of ['a\u200bb', 'a\u202eb', 'a\u2066b', 'a\u3164b', 'a\ufeffb']) {
      expect(() => parseAgentDeleteArgs(['--agent', AGENT, '--reason', bad])).toThrow(/보이지 않는/);
      expect(() => parsePolicyRequestArgs(['--agent', AGENT, '--reject', REQ, '--reason', bad])).toThrow(/보이지 않는/);
    }
    expect(() => parseAgentDeleteArgs(['--agent', AGENT, '--reason', 'x'.repeat(DELETE_REASON_MAX + 1)])).toThrow(/자 이하/);
    expect(() => parseAgentDeleteArgs(['--agent', 'nope', '--reason', 'x'])).toThrow(/--agent/);
  });
});

describe('actorOf — 모든 관리 CLI 의 행위자(보안 리뷰 L2)', () => {
  it('제어 문자(줄바꿈 · ESC · C1) · 100자 초과는 거부 · 없으면 USER', () => {
    expect(actorOf('admin:x', 'jin', {})).toBe('admin:x:jin');
    expect(actorOf('admin:x', undefined, { USER: 'boni' })).toBe('admin:x:boni');
    for (const bad of ['a\nb', 'a\rb', 'a\u001b[31mb', 'a\u0000b', 'a\u0085b', 'a\tb']) {
      expect(() => actorOf('admin:x', bad, {})).toThrow(AdminInputError);
    }
    // --by 가 없을 때의 USER 에도 같은 규칙.
    expect(() => actorOf('admin:x', undefined, { USER: 'x\ny' })).toThrow(/제어 문자/);
    expect(() => actorOf('admin:x', 'x'.repeat(101), {})).toThrow(/100자/);
  });
});
