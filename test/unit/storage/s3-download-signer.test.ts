/**
 * P3c — S3 presigned GET 의 **강제 응답 헤더**와 수명. 네트워크를 타지 않는다(서명은 로컬 계산이고, 자격증명은
 * 가짜다 — 이 URL 로 요청하면 S3 가 거부한다. 여기서 보는 것은 URL 의 모양뿐이다).
 *
 * 되돌리기: `createS3DownloadSigner` 에서 `ResponseContentDisposition`·`ResponseContentType` 중 하나를 빼거나
 * 수명을 늘리면 이 파일이 빨갛다.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { DOWNLOAD_URL_TTL_SECONDS, ObjectKeyFormatError } from '../../../src/storage/object-store';
import { createS3DownloadSigner } from '../../../src/storage/s3-object-store';

const client = new S3Client({
  region: 'ap-northeast-2',
  credentials: { accessKeyId: 'AKIDEXAMPLEFAKEKEY00', secretAccessKey: 'fake-secret-for-signing-only' },
});
const NOW = new Date('2026-09-23T03:00:00.000Z');
const KEY = 'inbound/attachments/0100abc-000000/0';

describe('createS3DownloadSigner — presigned GET', () => {
  it('★ response-content-disposition=attachment · response-content-type=application/octet-stream 이 서명에 들어간다', async () => {
    const signed = await createS3DownloadSigner({ client, bucket: 'atmark-mail' }).signDownload(KEY, NOW);
    const url = new URL(signed.url);
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    // 서명된 헤더 목록이 아니라 **쿼리** 가 서명 대상이다(SigV4 canonical query) — 바꾸면 서명이 깨진다.
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.pathname).toContain('/inbound/attachments/0100abc-000000/0');
    expect(url.hostname).toContain('atmark-mail');
  });

  it('★ 수명은 5분 — X-Amz-Expires 와 expiresAt 이 같은 값을 말한다', async () => {
    const signed = await createS3DownloadSigner({ client, bucket: 'atmark-mail' }).signDownload(KEY, NOW);
    const url = new URL(signed.url);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260923T030000Z');
    expect(signed.expiresAt.toISOString()).toBe('2026-09-23T03:05:00.000Z');
  });

  it('키 형식을 입구에서 본다 — 경로 탈출 키는 서명하지 않는다', async () => {
    await expect(createS3DownloadSigner({ client, bucket: 'atmark-mail' }).signDownload('inbound/../outbound/x', NOW)).rejects.toThrow(
      ObjectKeyFormatError,
    );
  });
});
