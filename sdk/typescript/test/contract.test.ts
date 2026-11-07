/**
 * Contract between the SDKs and the server's OpenAPI source of truth (`src/api/openapi/*`).
 *
 * ① The SDK operation table equals the server table (both directions — a new server route fails here until the SDK has it).
 * ② Every operation is actually called by a resource method with the right method + path.
 * ③ `sdk/fixtures/openapi.json` (read by the Python contract test) equals `openApiDocument()`.
 *    Regenerate after a server change: `ATMARK_UPDATE_SDK_FIXTURES=1 pnpm test:sdk`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { openApiDocument } from '../../../src/api/openapi/document';
import { API_OPERATIONS } from '../../../src/api/openapi/operations';
import { Atmark, OPERATIONS, type OperationId } from '../src/index.js';

const SNAPSHOT = fileURLToPath(new URL('../../fixtures/openapi.json', import.meta.url));
const UPDATE = process.env['ATMARK_UPDATE_SDK_FIXTURES'] === '1';

/** One real client call per operationId. Adding a server route means adding a line here (and a method). */
const CALLS: Record<OperationId, (client: Atmark) => PromiseLike<unknown>> = {
  sendMessage: (c) => c.messages.send({ from: 'a@atmark.ai', to: ['b@example.com'], subject: 's', text: 't' }),
  replyToThread: (c) => c.messages.reply('th1', { in_reply_to: 'm1', text: 't' }),
  forwardMessage: (c) => c.messages.forward('m1', { from: 'a@atmark.ai', to: ['b@example.com'] }),
  sendTransitionAnnouncement: (c) => c.agents.sendTransitionAnnouncement(undefined, {}),
  scheduleMessage: (c) => c.messages.scheduled.create({ from: 'a@atmark.ai', to: ['b@example.com'], subject: 's', text: 't', send_at: '2026-10-09T00:00:00Z' }),
  listScheduledMessages: (c) => c.messages.scheduled.list(),
  getScheduledMessage: (c) => c.messages.scheduled.get('s1'),
  cancelScheduledMessage: (c) => c.messages.scheduled.cancel('s1', { reason_code: 'duplicate' }),
  createDraft: (c) => c.drafts.create({ subject: 's' }),
  listDrafts: (c) => c.drafts.list(),
  getDraft: (c) => c.drafts.get('d1'),
  updateDraft: (c) => c.drafts.update('d1', { subject: 's2', revision: 1 }),
  discardDraft: (c) => c.drafts.discard('d1'),
  sendDraft: (c) => c.drafts.send('d1'),
  listInboundMessages: (c) => c.messages.inbound.list(),
  getInboundMessage: (c) => c.messages.inbound.get('m1'),
  getInboundAttachmentUrl: (c) => c.messages.inbound.attachmentUrl('m1', 0),
  getInboundAttachmentContent: (c) => c.messages.inbound.attachmentContent('m1', 0),
  getThread: (c) => c.threads.get('th1'),
  getVerificationCode: (c) => c.messages.verificationCode({ sender_domain: 'example.com' }),
  setMessageLabels: (c) => c.labels.set('m1', { add: ['x'] }),
  listLabels: (c) => c.labels.list(),
  createAttachmentUpload: (c) => c.attachments.createUpload({ filename: 'a.txt', mime_type: 'text/plain', bytes: 1, sha256: '0'.repeat(64) }),
  getApproval: (c) => c.approvals.get('ap1'),
  getAgentPolicy: (c) => c.policy.get(),
  requestPolicyChange: (c) => c.policy.requestChange({ action: 'add_rule', direction: 'outbound', list: 'allow', value: 'b@example.com', reason: 'owner asked' }),
  getPolicyChangeRequest: (c) => c.policy.getRequest('pr1'),
  queryAudit: (c) => c.audit.query({ message_id: 'm1' }),
  registerWebhookEndpoint: (c) => c.webhooks.endpoints.create(undefined, { url: 'https://example.com/h' }),
  listWebhookEndpoints: (c) => c.webhooks.endpoints.list(),
  deleteWebhookEndpoint: (c) => c.webhooks.endpoints.delete(undefined, 'e1'),
  rotateWebhookSecret: (c) => c.webhooks.endpoints.rotateSecret(undefined, 'e1'),
  listWebhookDeliveries: (c) => c.webhooks.deliveries.list(),
  redeliverWebhookDelivery: (c) => c.webhooks.deliveries.redeliver(undefined, 'dl1'),
  enrollAgent: (c) => c.agents.create({ name: 'Helper' }),
  getIdentity: (c) => c.identity.lookup('a@atmark.ai'),
  getCapabilities: (c) => c.capabilities.get(),
  getRealtimeConnection: (c) => c.agents.realtime(),
  getOpenApi: (c) => c.discovery.openapi(),
  getDiscovery: (c) => c.discovery.get(),
};

function templateMatches(template: string, actualPath: string): boolean {
  const pattern = new RegExp(`^${template.replace(/\{[A-Za-z]+\}/g, '[^/]+').replace(/\./g, '\\.')}$`);
  return pattern.test(actualPath);
}

describe('SDK ↔ OpenAPI contract', () => {
  it('① the SDK operation table equals the server table (method, path, Idempotency-Key)', () => {
    const server = Object.fromEntries(
      API_OPERATIONS.map((op) => [op.operationId, { method: op.method, path: op.path, ...(op.idempotencyKey === undefined ? {} : { idempotencyKey: op.idempotencyKey }) }]),
    );
    const missingInSdk = Object.keys(server).filter((id) => !(id in OPERATIONS));
    const unknownToServer = Object.keys(OPERATIONS).filter((id) => !(id in server));
    expect({ missingInSdk, unknownToServer }).toEqual({ missingInSdk: [], unknownToServer: [] });
    expect(OPERATIONS).toEqual(server);
  });

  it('② every operation is called by a client method with the right method and path', async () => {
    expect(Object.keys(CALLS).sort()).toEqual(API_OPERATIONS.map((op) => op.operationId).sort());
    for (const op of API_OPERATIONS) {
      const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
      const client = new Atmark({
        token: 'atk_agent_test',
        agentId: 'a'.repeat(32),
        maxRetries: 0,
        fetch: async (url, init) => {
          seen.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string> });
          return new Response(JSON.stringify({ next_cursor: null }), { status: 200 });
        },
      });
      await CALLS[op.operationId as OperationId](client);
      expect(seen, op.operationId).toHaveLength(1);
      const request = seen[0]!;
      const url = new URL(request.url);
      expect(request.method, op.operationId).toBe(op.method);
      expect(url.origin).toBe('https://api.atmark.ai');
      expect(templateMatches(op.path, url.pathname), `${op.operationId}: ${url.pathname} vs ${op.path}`).toBe(true);
      expect('Idempotency-Key' in request.headers, op.operationId).toBe(op.idempotencyKey !== undefined);
      for (const query of op.query ?? []) {
        if (query.required === true) expect(url.searchParams.has(query.name), `${op.operationId} ?${query.name}`).toBe(true);
      }
    }
  });

  it('③ sdk/fixtures/openapi.json is the current OpenAPI document (regenerate: ATMARK_UPDATE_SDK_FIXTURES=1 pnpm test:sdk)', () => {
    const current = `${JSON.stringify(openApiDocument(), null, 2)}\n`;
    if (UPDATE) writeFileSync(SNAPSHOT, current);
    expect(readFileSync(SNAPSHOT, 'utf8')).toBe(current);
  });
});
