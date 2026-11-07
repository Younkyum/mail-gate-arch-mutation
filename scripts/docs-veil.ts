/**
 * scripts/docs-veil.ts — 가림(veil) 금지어 검사(계획 `.omc/plans/docs-site.md` §4). 공개 문서에 내부 구현·공급자·운영 경로·과장 문구가
 * 새지 않게 한다. `pnpm gen:docs` 가 콘텐츠 원문에 돌려 멈추고, 테스트(`test/unit/docs/docs-content.test.ts`)가 원문 두 언어 + 렌더된 HTML·`.md`·
 * llms 파일·검색 색인 전부에 돌린다. 핸들러 번들과 무관한 빌드 도구라 `scripts/` 에 둔다.
 *
 * 계획의 정규식 그대로이되 두 곳만 다르다:
 *   - `\bλ\b` → `λ` — JS 의 `\b` 는 ASCII 단어 경계라 `λ` 앞뒤에서 늘 거짓이 된다(공허한 항목). 문서에 λ 가 나올 이유가 없으므로 글자 하나로 건다.
 *   - `ATMARK_[A-Z_]+` → `ATMARK_(?!AGENT_TOKEN\b)[A-Z_]+`, 그리고 **이 항목만 대소문자 구분**(`VEIL_ENV_PATTERN`) — `ATMARK_AGENT_TOKEN` 은
 *     콘솔 연결 탭·토큰 대화상자에 **사용자에게 보이는** 변수 이름이고(설정 예시가 그 이름을 써야 화면과 맞는다), 소문자 `mcp__atmark__…` 는
 *     MCP 클라이언트가 보여 주는 도구 이름이다. 다른 `ATMARK_*`(운영 환경 변수)는 그대로 막는다.
 * 대소문자를 무시한다. Paddle 은 가격 페이지의 승인된 문장("Paddle processes …" / "Paddle이 판매자 …")만 허용한다.
 */

export const VEIL_PATTERN = new RegExp(
  [
    String.raw`\bAWS\b|Amazon|Lambda|λ|\bSES\b|\bRDS\b|Aurora|Postgre|\bS3\b|\bSQS\b|\bSNS\b|\bKMS\b|CloudFront|CloudWatch|GuardDuty|\bIAM\b|API Gateway|execute-api|Cloudflare|Vercel|ap-northeast|us-east-1`,
    String.raw`\bADR[- ]?\d|runbook|런북|\bsrc/|\.ts\b|migration|마이그레이션|pnpm |admin:`,
    String.raw`owner_actions|org_entitlements|agent_api_keys|agent_addresses|scheduled_sends|inbound_messages|ses_events|billing_audit`,
    String.raw`\bStage \d|outbox|sequencer|tlog|kill[-_ ]?switch|warmup|WARMUP|Paddle(?! processes|이 판매자)`,
    String.raw`블록체인\s*신원|blockchain[\s-]*identit|\bNFTs?\b|민팅|\bmint(s|ed|ing)?\b|독립\s*검증|independent(ly)?[\s-]*verif|변조\s*불가|tamper[\s-]*(proof|resistant)|SOC\s?2|ISO\s?27001|\d{2}(\.\d+)?\s*%|\bSLA\b|uptime`,
  ].join('|'),
  'gi',
);

/**
 * 운영 환경 변수 이름(`ATMARK_*`) — 계획의 정규식에서 이 한 항목만 **대소문자를 가린다**. 대소문자를 무시하면 MCP 클라이언트가 보여 주는 도구 이름
 * `mcp__atmark__send_email` 이 걸린다(사용자에게 보이는 이름 — 공허하지 않은 오탐). 환경 변수는 늘 대문자다.
 */
export const VEIL_ENV_PATTERN = /ATMARK_(?!AGENT_TOKEN\b)[A-Z_]+/g;

export interface VeilHit {
  readonly match: string;
  readonly line: number;
  readonly context: string;
}

/** 글에서 금지어를 찾는다. 줄 번호는 1부터. */
export function veilHits(text: string): VeilHit[] {
  const hits: VeilHit[] = [];
  const lines = text.split('\n');
  lines.forEach((line, k) => {
    for (const m of [...line.matchAll(VEIL_PATTERN), ...line.matchAll(VEIL_ENV_PATTERN)]) {
      const at = m.index;
      hits.push({ match: m[0], line: k + 1, context: line.slice(Math.max(0, at - 30), at + m[0].length + 30) });
    }
  });
  return hits;
}

/**
 * HTML 을 검사 대상으로 — 스타일 블록과 실행 스크립트(검색·테마 스크립트)는 사람에게 보이지 않는 코드라 뺀다(CSS 의 `100%` 같은 값이
 * `\d{2}%` 에 걸린다). JSON-LD 데이터 블록·속성 값(alt·href·meta)은 남긴다.
 */
export function veilTextOfHtml(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/></g, '>\n<');
}
