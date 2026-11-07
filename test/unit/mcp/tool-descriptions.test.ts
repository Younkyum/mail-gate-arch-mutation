/**
 * MCP 도구 설명이 말하는 값 = 실제 값. 에이전트는 설명을 읽고 결과의 `status`·`outcome` 을 분기하므로, 설명에만 있는 값(예: 승인
 * 상태 `denied` — 실제는 `rejected`)은 영원히 오지 않는 분기를 만든다.
 */
import { describe, expect, it } from 'vitest';

import { APPROVAL_STATUSES, CANCEL_REASON_CODES, SCHEDULED_SEND_STATUSES } from '../../../src/db/schema';
import { MCP_TOOLS } from '../../../src/mcp/tools';

function description(name: string): string {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.description;
}

function schemaEnum(name: string, property: string): readonly string[] | undefined {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  const properties = (tool?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties;
  return properties?.[property]?.enum;
}

describe('MCP 도구 설명의 열거값', () => {
  it('get_approval_status 는 승인 상태 넷을 정확히 말한다(pending · approved · rejected · expired) — denied 는 승인 상태가 아니다', () => {
    const text = description('get_approval_status');
    for (const status of APPROVAL_STATUSES) expect(text).toContain(status);
    expect(text).not.toMatch(/\bdenied\b/);
  });

  it('list_scheduled 의 status 필터와 설명 = 예약 상태 전부', () => {
    expect(schemaEnum('list_scheduled', 'status')).toEqual([...SCHEDULED_SEND_STATUSES]);
    for (const status of SCHEDULED_SEND_STATUSES) expect(description('list_scheduled')).toContain(status);
  });

  it('cancel_scheduled 의 reason_code = 취소 사유 코드 전부', () => {
    expect(schemaEnum('cancel_scheduled', 'reason_code')).toEqual([...CANCEL_REASON_CODES]);
  });

  it('forward_email 은 refused 결과(주입 위험으로 전달 거부)를 말한다', () => {
    expect(description('forward_email')).toMatch(/\brefused\b/);
  });

  it('send_email · reply_email · forward_email 의 idempotency_key 설명 — 고쳐진 거부를 같은 인자로 다시 부르면 재생일 뿐이라고 말한다', () => {
    function propertyDescription(name: string): string {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      const properties = (tool?.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
      const text = properties?.['idempotency_key']?.description;
      if (text === undefined) throw new Error(`${name} has no idempotency_key description`);
      return text;
    }
    for (const name of ['send_email', 'reply_email', 'forward_email']) {
      const text = propertyDescription(name);
      expect(text).toMatch(/denial/i);
      expect(text).toMatch(/same arguments/i);
    }
  });
});
