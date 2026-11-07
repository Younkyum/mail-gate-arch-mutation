/**
 * src/tlog/anchor-http.ts — ★ **외부 앵커 HTTP 의 유일한 문**(ADR-0008 Phase B · `test/arch/network-egress.arch.test.ts` 허용 목록).
 *
 * 나가는 곳은 **이름으로 고정한 호스트**뿐이다:
 *   - OpenTimestamps 캘린더 넷(opentimestamps-client 의 기본 목록, 2026-09-24 확인) — `POST /digest`(본문 = 32바이트 다이제스트,
 *     `Accept: application/vnd.opentimestamps.v1`) · `GET /timestamp/<commitment hex>`(업그레이드; 404 = 아직 대기). 응답 상한 10,000바이트
 *     (python-opentimestamps `RemoteCalendar` 와 같다).
 *   - Sigstore Rekor v2 샤드 `log<YYYY>-<n>.rekor.sigstore.dev` — `POST /api/v2/log/entries`(rekor-tiles CLIENTS.md). 샤드는 해마다
 *     바뀐다 — URL 은 설정(`ATMARK_TLOG_REKOR_URL`)이고 모양만 여기서 고정한다(런북 §5: SigningConfig 로 확인).
 * 리다이렉트는 따르지 않는다(`redirect: 'error'`) · 시간 제한 · 크기 상한. **밖으로 보내는 것은 체크포인트 다이제스트와 앵커 서명·공개키뿐**
 * 이다(P1 — 개인 데이터 없음, Rekor 공공 인스턴스의 "개인 데이터 금지" 경고와 맞다). 테스트는 이 파일 대신 가짜 클라이언트를 넣는다
 * (`anchor.ts` 의 포트) — 테스트에서 실제 서비스를 부르지 않는다.
 */

export const OTS_CALENDAR_HOSTS: readonly string[] = [
  'a.pool.opentimestamps.org',
  'b.pool.opentimestamps.org',
  'a.pool.eternitywall.com',
  'ots.btc.catallaxy.com',
];
export const REKOR_HOST_SHAPE = /^log[0-9]{4}-[0-9]{1,3}\.rekor\.sigstore\.dev$/;
/**
 * 업그레이드를 물을 수 있는 캘린더 — 대기 증명의 URI 는 집계기(aggregator)가 아니라 **실제 캘린더**를 가리킨다. python-opentimestamps
 * `DEFAULT_CALENDAR_WHITELIST`(`https://*.calendar.opentimestamps.org` · `*.calendar.eternitywall.com` · `*.calendar.catallaxy.com`,
 * 2026-09-24 확인)와 같은 범위 + 집계기 호스트 자신. 증명 안의 URI 는 캘린더가 준 값이다 — 이 모양 밖이면 묻지 않는다(요청 위조 방지).
 */
export const OTS_UPGRADE_HOST_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.calendar\.(opentimestamps\.org|eternitywall\.com|catallaxy\.com)$/;

export const OTS_MAX_RESPONSE_BYTES = 10_000;
export const REKOR_MAX_RESPONSE_BYTES = 1_048_576;
export const ANCHOR_HTTP_TIMEOUT_MS = 15_000;

export class AnchorHttpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'AnchorHttpError';
    this.code = code;
  }
}

/** 엔드포인트 모양 — `https://<허용 호스트>` 하나(경로·포트·자격증명 없음). `ots-upgrade` 는 대기 증명 URI 의 캘린더. */
export function anchorEndpoint(raw: string, kind: 'opentimestamps' | 'rekor' | 'ots-upgrade'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AnchorHttpError('anchor_endpoint_invalid');
  }
  const allowed =
    kind === 'rekor'
      ? REKOR_HOST_SHAPE.test(url.hostname)
      : OTS_CALENDAR_HOSTS.includes(url.hostname) || (kind === 'ots-upgrade' && OTS_UPGRADE_HOST_SHAPE.test(url.hostname));
  if (url.protocol !== 'https:' || !allowed || url.port !== '' || url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new AnchorHttpError('anchor_endpoint_not_allowed');
  }
  return `https://${url.hostname}`;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; redirect: 'error'; signal: AbortSignal }) => Promise<{
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

async function request(fetchImpl: FetchLike, url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }, max: number): Promise<{ status: number; body: Buffer }> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(ANCHOR_HTTP_TIMEOUT_MS) });
  } catch {
    throw new AnchorHttpError('anchor_http_unreachable');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > max) throw new AnchorHttpError('anchor_http_response_too_large');
  return { status: response.status, body };
}

/** OpenTimestamps 캘린더 포트. */
export interface OtsCalendarClient {
  submit(endpoint: string, digest: Buffer): Promise<Buffer>;
  /** 업그레이드 조각 — `calendarUri` 는 대기 증명 안의 캘린더 URI. 아직 없으면(404) null. */
  upgrade(calendarUri: string, commitment: Buffer): Promise<Buffer | null>;
}

/** Rekor v2 포트 — 요청 JSON → 응답 JSON(TransparencyLogEntry). */
export interface RekorClient {
  submit(endpoint: string, body: unknown): Promise<unknown>;
}

export function createHttpOtsClient(fetchImpl: FetchLike = fetch as unknown as FetchLike): OtsCalendarClient {
  const headers = { accept: 'application/vnd.opentimestamps.v1', 'user-agent': 'atmark-tlog/1', 'content-type': 'application/octet-stream' };
  return {
    async submit(endpoint: string, digest: Buffer): Promise<Buffer> {
      if (digest.length !== 32) throw new AnchorHttpError('ots_digest_size');
      const base = anchorEndpoint(endpoint, 'opentimestamps');
      const { status, body } = await request(fetchImpl, `${base}/digest`, { method: 'POST', headers, body: digest }, OTS_MAX_RESPONSE_BYTES);
      if (status !== 200) throw new AnchorHttpError(`ots_http_${String(status)}`);
      return body;
    },
    async upgrade(calendarUri: string, commitment: Buffer): Promise<Buffer | null> {
      const base = anchorEndpoint(calendarUri, 'ots-upgrade');
      const { status, body } = await request(fetchImpl, `${base}/timestamp/${commitment.toString('hex')}`, { method: 'GET', headers }, OTS_MAX_RESPONSE_BYTES);
      if (status === 404) return null;
      if (status !== 200) throw new AnchorHttpError(`ots_http_${String(status)}`);
      return body;
    },
  };
}

export function createHttpRekorClient(fetchImpl: FetchLike = fetch as unknown as FetchLike): RekorClient {
  return {
    async submit(endpoint: string, body: unknown): Promise<unknown> {
      const base = anchorEndpoint(endpoint, 'rekor');
      const { status, body: response } = await request(
        fetchImpl,
        `${base}/api/v2/log/entries`,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'atmark-tlog/1' }, body: JSON.stringify(body) },
        REKOR_MAX_RESPONSE_BYTES,
      );
      if (status !== 200 && status !== 201) throw new AnchorHttpError(`rekor_http_${String(status)}`);
      try {
        return JSON.parse(response.toString('utf8')) as unknown;
      } catch {
        throw new AnchorHttpError('rekor_response_not_json');
      }
    },
  };
}
