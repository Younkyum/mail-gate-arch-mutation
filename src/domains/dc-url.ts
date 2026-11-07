/**
 * src/domains/dc-url.ts — Domain Connect **동기 흐름**의 서명된 적용 URL(순수 — I/O 없음). 서명은 포트(`DcSigner`)로 받는다:
 * 운영은 KMS(`dc-kms-signer.ts`), 테스트는 메모리 RSA 키.
 *
 * 템플릿 **하나**(`ops/domain-connect/atmark.ai.mail.json` — 2026-10 one-shot · 근거 `docs/adr/0014-…` "Domain Connect" 절 · ADR-0014 결정 2 개정):
 *   `mail` — `domain=<registrable>&host=<서브도메인 라벨>`(apex 자체는 고객 도메인 판정이 이미 거부하고, 여기서도 서명 전에 `apex_not_allowed` 로 거부한다 — 템플릿 `hostRequired` 는 쓰지 않는다:
 *   린터 DCTL1037 로 자동 병합이 막히고 Cloudflare 는 그 플래그를 무시한다)로 **한 번** 적용 → 동의 한 번. 레코드 7:
 *   TXT `_atmark-challenge`(= `_atmark-challenge.<domain>` — 소유 증명은 서브도메인 아래도 인정, apex 와 OR) · MX @ · MX bounce · SPFM bounce ·
 *   CNAME `%t1..3%._domainkey`. SES identity 를 추가 직후 만들므로 토큰이 처음부터 있다 — 적용은 DKIM 토큰 셋이 있을 때 언제든.
 *   **host 변수(`%sub%`)를 쓰지 않는다** — Templates 품질 규칙 8. 서브도메인은 프로토콜의 `host` 로만 넘긴다. 옛 `ownership` 템플릿(apex 에 host
 *   없이 · 단계 `setup`/`dkim` 둘)은 제출 전에 폐기했다.
 *
 * **서명 오라클 금지:** 쿼리의 모든 값은 서버가 DB 행에서 만든다 — 클라이언트 입력은 도메인 id 뿐이다. 서명 대상은 **보내는 문자열
 * 그대로**(`sig`·`key` 를 뺀 `?` 뒤 전체, 값은 URL 인코딩된 상태 — 스펙 "Digitally Sign Requests"). `sig`·`key` 는 끝에 붙인다.
 */

import { CHALLENGE_TOKEN_SHAPE, dnsRecordsFor, type DnsRecordSpec } from './contract';

/** 템플릿의 `providerId`(파일 이름 `atmark.ai.<serviceId>.json`). */
export const DC_PROVIDER_ID = 'atmark.ai';
/** 공개키 TXT 의 도메인(템플릿 `syncPubKeyDomain`) — `_dcpubkeyv1.dc.atmark.ai`. */
export const DC_PUBKEY_DOMAIN = 'dc.atmark.ai';
/** 공개키 TXT 의 호스트 라벨(쿼리 `key`). 키 회전 = 새 KMS 키 + `_dcpubkeyv2` + 이 상수. */
export const DC_PUBKEY_LABEL = '_dcpubkeyv1';
/** 템플릿 `syncRedirectDomain`. */
export const DC_REDIRECT_DOMAIN = 'console.atmark.ai';

/** 템플릿 serviceId(파일 `atmark.ai.mail.json`) — 하나뿐이다. */
export const DC_SERVICE_ID = 'mail';

const DKIM_TOKEN_SHAPE = /^[a-z0-9]{1,64}$/; // DB CHECK 와 같다(SES 는 32자)
/** DNS 라벨(LDH) 점 연결 — 서브도메인 부분(`host`). */
const HOST_SHAPE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/** 서명 포트 — RSASSA-PKCS1-v1_5 SHA-256 서명(원문 그대로 — 해시는 구현이 한다). */
export interface DcSigner {
  sign(message: Buffer): Promise<Buffer>;
}

export class DomainConnectInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DomainConnectInputError';
  }
}

/** 적용 URL 의 입력이 되는 행 칸. */
export interface DomainConnectRow {
  readonly id: string;
  readonly domain: string;
  readonly registrable: string;
  readonly challengeToken: string;
  readonly dkimTokens: readonly string[];
}

/** 서브도메인 부분 — `agents.example.com` / `example.com` → `agents`. 도메인이 apex 자체면 거부(`apex_not_allowed` — 서명 전 · 서버 쪽 방어). */
export function hostOf(domain: string, registrable: string): string {
  if (domain === registrable) throw new DomainConnectInputError('apex_not_allowed');
  const suffix = `.${registrable}`;
  if (!domain.endsWith(suffix)) throw new DomainConnectInputError('domain_not_under_registrable');
  const host = domain.slice(0, -suffix.length);
  if (!HOST_SHAPE.test(host)) throw new DomainConnectInputError('host_shape');
  return host;
}

/** 복귀 URL — 경로 기반(조각 `#` 은 업체가 지울 수 있다). 콘솔이 `dc`·`d` 를 읽어 그 도메인 화면으로 가서 지금 확인을 부른다. 신뢰하지 않는다. */
export function redirectUriOf(domainId: string): string {
  return `https://${DC_REDIRECT_DOMAIN}/app?dc=1&d=${encodeURIComponent(domainId)}`;
}

/** 템플릿 변수 + domain/host — **서버가 행에서 만든다**(순서 고정: domain · host · token · t1 · t2 · t3). */
export function applyParamsOf(row: DomainConnectRow): readonly (readonly [string, string])[] {
  if (!CHALLENGE_TOKEN_SHAPE.test(row.challengeToken)) throw new DomainConnectInputError('challenge_token_shape');
  if (row.dkimTokens.length !== 3 || !row.dkimTokens.every((token) => DKIM_TOKEN_SHAPE.test(token))) throw new DomainConnectInputError('dkim_tokens_shape');
  const host = hostOf(row.domain, row.registrable);
  const [t1, t2, t3] = row.dkimTokens as [string, string, string];
  return [['domain', row.registrable], ['host', host], ['token', row.challengeToken], ['t1', t1], ['t2', t2], ['t3', t3]];
}

/** 적용이 넣는 레코드(사람이 읽을 요약 — 수동 표 · 존 파일과 같은 이름·값·순서, 8줄 — 마지막 DMARC 는 권장). */
export function connectRecordsOf(row: DomainConnectRow): readonly DnsRecordSpec[] {
  return dnsRecordsFor(row.domain, row.challengeToken, row.dkimTokens);
}

/** `key=value` 를 `&` 로 — 값은 `encodeURIComponent`. 서명 대상 = 이 문자열 그대로. */
export function queryStringOf(params: readonly (readonly [string, string])[]): string {
  return params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

/** `urlSyncUX` 는 https · 자격·조각·쿼리 없음(업체 설정 응답 — 발견 단계가 한 번 걸렀다). 끝 `/` 는 뗀다. */
function syncUxBase(urlSyncUX: string): string {
  let url: URL;
  try {
    url = new URL(urlSyncUX);
  } catch {
    throw new DomainConnectInputError('sync_ux_invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new DomainConnectInputError('sync_ux_invalid');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 서명된 적용 URL: `{urlSyncUX}/v2/domainTemplates/providers/atmark.ai/services/{serviceId}/apply?{params}&redirect_uri=…&sig=…&key=_dcpubkeyv1`.
 */
export async function buildApplyUrl(input: {
  readonly urlSyncUX: string;
  readonly row: DomainConnectRow;
  readonly signer: DcSigner;
}): Promise<string> {
  const base = syncUxBase(input.urlSyncUX);
  const query = queryStringOf([...applyParamsOf(input.row), ['redirect_uri', redirectUriOf(input.row.id)]]);
  const signature = await input.signer.sign(Buffer.from(query, 'utf8'));
  return `${base}/v2/domainTemplates/providers/${DC_PROVIDER_ID}/services/${DC_SERVICE_ID}/apply?${query}&sig=${encodeURIComponent(signature.toString('base64'))}&key=${DC_PUBKEY_LABEL}`;
}

/** 공개키 TXT 한 줄의 `d` 길이 — `p=N,a=RS256,d=` 를 더해도 TXT 문자열 255바이트 안. */
export const DC_PUBKEY_CHUNK = 200;

/** SPKI(DER) → `_dcpubkeyv1.dc.atmark.ai` TXT 값들(`p=1,a=RS256,d=…`). */
export function pubkeyTxtValues(spkiDer: Buffer): readonly string[] {
  const base64 = spkiDer.toString('base64');
  const values: string[] = [];
  for (let offset = 0; offset < base64.length; offset += DC_PUBKEY_CHUNK) {
    values.push(`p=${String(values.length + 1)},a=RS256,d=${base64.slice(offset, offset + DC_PUBKEY_CHUNK)}`);
  }
  return values;
}

/** TXT 값들 → SPKI(DER). 업체가 하는 재조립(순서는 `p`) — 게시 확인 · 왕복 테스트용. */
export function spkiFromPubkeyTxt(values: readonly string[]): Buffer {
  const parts = values.map((value) => {
    const fields = new Map(value.split(',').map((field) => [field.slice(0, field.indexOf('=')), field.slice(field.indexOf('=') + 1)] as const));
    const p = Number(fields.get('p'));
    const d = fields.get('d');
    if (!Number.isInteger(p) || p < 1 || d === undefined) throw new DomainConnectInputError('pubkey_txt_shape');
    if ((fields.get('a') ?? 'RS256') !== 'RS256') throw new DomainConnectInputError('pubkey_txt_algorithm');
    return { p, d };
  });
  parts.sort((a, b) => a.p - b.p);
  return Buffer.from(parts.map((part) => part.d).join(''), 'base64');
}
