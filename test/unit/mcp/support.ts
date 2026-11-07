/** `test/unit/mcp` 도구 단위 테스트의 공통 도우미 — 가짜 라우트 응답과 도구 실행. */

import type { ApiResponse } from '../../../src/api/http';
import { callTool, findTool, type ToolContext } from '../../../src/mcp/tools';

export const AGENT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

export function respond(status: number, body: Record<string, unknown>): () => Promise<ApiResponse> {
  return () => Promise.resolve({ status, body } as ApiResponse);
}

/** 도구를 이름으로 불러 글자 결과를 한 문자열로. */
export async function run(name: string, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const definition = findTool(name);
  if (definition === undefined) throw new Error(name);
  const outcome = await callTool(definition, ctx, args);
  return { text: outcome.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'), isError: outcome.result.isError };
}
