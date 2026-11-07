/**
 * 초안 보내기(`draft_send`, 묶음 B)의 Layer D 구동용 가짜 — 초안 한 개(메모리)와 본문 하나. 관문 · 서비스 · 전송단은 진짜(하네스)다.
 */

import type { DraftRow, DraftStore } from '../../../../src/db/repositories/draft-store';
import type { AgentId } from '../../../../src/db/schema';
import type { DraftContentStore } from '../../../../src/storage/draft-content-store';

export const DRAFT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export interface FakeDraft {
  readonly drafts: DraftStore & { readonly current: () => DraftRow };
  readonly draftContent: DraftContentStore;
}

/** 보낼 준비가 된 초안 하나 — 발신 · 받는 사람 · 제목 · 본문을 준다. */
export function fakeDraft(agentId: AgentId, fields: { readonly from: string; readonly to: readonly string[]; readonly subject: string; readonly text: string }): FakeDraft {
  let row: DraftRow = {
    id: DRAFT_ID,
    agentId,
    revision: 1,
    fromAddress: fields.from,
    recipients: fields.to,
    subject: fields.subject,
    inReplyTo: null,
    attachmentIds: [],
    contentStorageKey: `outbound/drafts/${DRAFT_ID}/1.json`,
    contentBytes: fields.text.length,
    createdAt: new Date('2026-10-08T00:00:00.000Z'),
    updatedAt: new Date('2026-10-08T00:00:00.000Z'),
    discardedAt: null,
    sendIdempotencyKey: null,
    sentMessageId: null,
    sentAt: null,
  };
  const unused = (): never => {
    throw new Error('이 구동에서 쓰지 않는 초안 저장소 함수');
  };
  const drafts: FakeDraft['drafts'] = {
    current: () => row,
    insert: unused,
    list: unused,
    update: unused,
    discard: unused,
    find: (owner, id) => Promise.resolve(owner === agentId && id === DRAFT_ID ? row : null),
    claimSend: (owner, id, key) => {
      if (owner !== agentId || id !== DRAFT_ID) return Promise.resolve({ kind: 'not_found' });
      if (row.sentMessageId !== null) {
        return Promise.resolve(row.sendIdempotencyKey === key ? { kind: 'claimed', row } : { kind: 'unavailable', row });
      }
      if (row.sendIdempotencyKey !== null && row.sendIdempotencyKey !== key) return Promise.resolve({ kind: 'unavailable', row });
      row = { ...row, sendIdempotencyKey: key };
      return Promise.resolve({ kind: 'claimed', row });
    },
    markSent: (_owner, _id, key, messageId) => {
      if (row.sendIdempotencyKey !== key) return Promise.resolve(null);
      row = { ...row, sentMessageId: messageId, sentAt: new Date() };
      return Promise.resolve(row);
    },
    releaseClaim: (_owner, _id, key) => {
      if (row.sendIdempotencyKey === key && row.sentMessageId === null) row = { ...row, sendIdempotencyKey: null };
      return Promise.resolve();
    },
  };
  const draftContent: DraftContentStore = {
    keyFor: (id, revision) => `outbound/drafts/${id}/${String(revision)}.json`,
    sizeOf: (content) => content.text.length,
    put: unused,
    load: () => Promise.resolve({ text: fields.text, html: null }),
  };
  return { drafts, draftContent };
}
