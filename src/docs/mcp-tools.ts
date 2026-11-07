/**
 * src/docs/mcp-tools.ts — 문서가 싣는 MCP 도구 이름 표(`{{mcp-tools}}`). 정본은 `src/mcp/tools.ts` 의 `MCP_TOOLS` 이고, 문서 번들은 그 파일을
 * import 하지 않는다(라우트·DB 를 끌고 온다) — 이름만 옮겨 적고 `test/unit/docs/docs-sources.test.ts` 가 순서까지 같은지 본다.
 * 도구를 더하거나 빼면 그 테스트가 빨개진다 — 여기와 `connect/mcp-tools` 페이지를 같이 고친다. import 가 없는 값 파일이다.
 */

export const DOCS_MCP_TOOL_NAMES: readonly string[] = [
  'send_email',
  'reply_email',
  'forward_email',
  'list_inbox',
  'read_email',
  'get_thread',
  'read_attachment',
  'get_attachment_url',
  'get_approval_status',
  'get_my_policy',
  'request_policy_change',
  'get_policy_request',
  'get_verification_code',
  'list_scheduled',
  'cancel_scheduled',
  'list_webhooks',
  'create_webhook',
  'delete_webhook',
  'list_webhook_deliveries',
  'redeliver_webhook',
  'get_capabilities',
  'get_realtime_connection',
  'create_draft',
  'update_draft',
  'get_draft',
  'list_drafts',
  'send_draft',
  'discard_draft',
  'set_labels',
  'list_labels',
  'create_agent',
];
