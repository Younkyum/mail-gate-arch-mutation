/**
 * src/identity/address.ts — 에이전트 주소 발급 (`{name}@atmark.ai`).
 *
 * `agent_addresses.address` 는 활성 행 사이에서 전역 UNIQUE 이고, 그 유니크가 "두 에이전트가 같은 `from` 을 주장할 수 없다"(AC-1)를
 * 성립시킨다 — Stage 1(`rules/identity.ts`)의 위조 판정이 그 위에 선다. 유니크는 DB 가 집행하고, 여기서는 **DB 에 닿기 전에 표현을 하나로
 * 못박는다** — `Agent@Atmark.AI` 와 `agent@atmark.ai` 가 다른 문자열이면 유니크가 둘 다 받는다(DB CHECK 도 `address = lower(address)`).
 *
 * 고객 도메인(ADR-0014): 여기서는 도메인의 **모양**만 본다. 그 조직이 verified 로 가졌는지는 DB 트리거 `agent_addresses_verified_domain_guard`
 * 가 집행한다. 예약 로컬파트는 도메인에 따라 다르다(`reservedLocalPartsFor`, J11).
 */

/**
 * 에이전트 주소의 도메인. **설정값이 아니라 상수다** — SES 검증·DKIM·DMARC·평판이 붙어 있는 값이라, 런타임에 바꿀 수 있으면 검증되지 않은
 * 도메인으로 발송하는 경로가 열린다.
 */
export const AGENT_ADDRESS_DOMAIN = 'atmark.ai';

/** 로컬파트 최대 길이. RFC 5321 §4.5.3.1.1 의 상한. */
export const AGENT_LOCAL_PART_MAX_LENGTH = 64;

/**
 * 로컬파트 허용 형식 — 소문자 영숫자로 시작·종료, 가운데에 `.`·`_`·`-`. RFC 보다 훨씬 좁다: `+tag` 를 허용하면 `normalizeAddress` 의
 * `+tag` 절단과 충돌해 **발급한 주소가 자기 정규화형과 달라지고**, Stage 1 이 자기 주소를 위조로 읽는다.
 */
export const AGENT_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** 앵커 이름 공간 접두사 — 계약 `ANCHOR_LOCAL_PART_PREFIX` 와 같은 값(이 파일은 계약을 import 하지 않는다 — 단위 테스트가 대조). */
export const ANCHOR_NAMESPACE_PREFIX = 'ax--';

// ---------------------------------------------------------------------------
// 예약 로컬파트 — 에이전트에게 줄 수 없는 이름
// ---------------------------------------------------------------------------

/**
 * **RFC 2142 역할 주소** — 도메인 운영자(사람)가 받아야 하는 이름이다. 바운스·스팸 신고·차단 해제 협의가 `postmaster@`·`abuse@` 로 오고,
 * 에이전트에게 주면 그 메일이 LLM 에게 간다. `atmark.ai` 의 두 주소는 운영자만 지원 에이전트에 수신 전용 별칭으로 붙인다.
 */
const RFC_2142_ROLE_LOCAL_PARTS = [
  'postmaster',
  'abuse',
  'hostmaster',
  'webmaster',
  'noc',
  'security',
] as const;

/**
 * **인증·운영 예약.** `dmarc` 는 DMARC 집계 리포트(`rua=`) 수신 주소로 쓸 수 있고, `noreply`·`bounce`·`mailer-daemon` 류는 회신이 오지
 * 않는다는 관용 이름이라 회신을 전제로 하는 에이전트에 붙으면 이름과 동작이 정반대가 된다.
 */
const OPERATIONAL_RESERVED_LOCAL_PARTS = [
  'dmarc',
  'noreply',
  'no-reply',
  'bounce',
  'mailer-daemon',
  // 소유자 승인 알림의 발신 주소(`src/notify/approval-notifier.ts`). 에이전트가 가지면 승인 알림과 구별되지 않는 메일로 소유자를
  // 낚을 수 있고(소유자는 allowlist 에 넣을 수 있으므로 관문도 통과한다), 이름으로 닫는 것 말고는 막을 자리가 없다.
  'notify',
] as const;

/** **데모 예약.** `blocked-test@atmark.ai` 는 `demo:p1b` 의 차단 대상이다 — 발급 가능하면 "의도적으로 차단되는 외부 주소" 라는 뜻이 흐려진다. */
const DEMO_RESERVED_LOCAL_PARTS = ['blocked-test'] as const;

/**
 * **서비스·사칭 예약.** 주소 발급이 소유자 누구나의 버튼이므로, `support@`·`billing@`·`login@`(로그인 링크 발신 주소) 처럼 **Atmark 자신이
 * 보낸 것처럼 읽히는 주소**를 아무 조직이나 가져갈 수 있다 — 에이전트 메일은 우리 DKIM 으로 서명돼 진짜 운영 메일과 구별되지 않는다.
 */
const SERVICE_RESERVED_LOCAL_PARTS = [
  'admin',
  'support',
  'billing',
  'help',
  'info',
  'login',
  'console',
  'atmark',
  'team',
  'sales',
  'hello',
  'root',
  'system',
  'approve',
  'api',
  'mail',
  'www',
  // 지원 에이전트의 별칭이자 환영 메일 발신 주소 — 운영자 CLI 만 발급한다(`OPERATOR_ASSIGNABLE_ADDRESSES`).
  'onve',
] as const;

/**
 * **인증서 도메인 검증 예약.** CA(CA/B BR 3.2.2.4.4)·ACM 은 정해진 로컬파트로 메일을 보내 도메인 소유를 확인한다 — 이 이름을 가진 에이전트는
 * `atmark.ai` 인증서를 제3자가 발급받는 입구다. `admin`·`webmaster`·`hostmaster`·`postmaster` 는 위 목록에 있고 여기는 나머지다.
 */
const CERTIFICATE_VALIDATION_RESERVED_LOCAL_PARTS = ['administrator', 'ssladmin', 'ssl-admin', 'sslwebmaster'] as const;

/** **운영·신뢰 사칭 예약.** 서비스 예약과 같은 이유 — 법무·개인정보·보안·결제·채용·가입 확인 메일처럼 읽히는 이름이다. */
const TRUST_RESERVED_LOCAL_PARTS = [
  'it',
  'domains',
  'privacy',
  'legal',
  'contact',
  'signup',
  'verify',
  'trust',
  'compliance',
  'operator',
  'accounts',
  'payments',
  'helpdesk',
  'help-desk',
  'security-team',
  'dpo',
  'press',
  'careers',
  'jobs',
  'abuse-report',
] as const;

/**
 * **예시 예약.** 홈·OG 이미지·문서가 예시 에이전트 주소로 쓰는 이름이다 — 실제 누군가의 에이전트가 되면 "Atmark 가 소개한 에이전트"로 읽힌다.
 * 스크린샷 검사(`scripts/gen-docs-shots.ts` `screenAddressProblems`)가 화면의 `@atmark.ai` 주소가 이 목록 안인지 본다.
 */
export const EXAMPLE_RESERVED_LOCAL_PARTS = ['scout', 'help-desk', 'invoices', 'recruiting', 'research', 'ops-pager'] as const;

/**
 * **AI 에이전트·모델·회사 이름 예약.** 홈 히어로의 예시 주소(`src/site/hero-names.ts` `HERO_AGENT_NAMES` — 전부 이 목록 안)이고, 아무 조직이나
 * 가져가면 "그 회사·제품의 공식 에이전트" 메일로 읽힌다. 구분자(`.` `_` `-`)를 뺀 키가 정확히 같을 때만 막는다(`chat-gpt`·`claude.code` 는
 * 막히고 `codex-helper` 는 된다 — `brandKeyOf`).
 *
 * **`atmark.ai` 전용이다.** 고객 서브도메인에서는 받는 사람이 그 조직의 도메인을 보고 판단한다 — `codex@agents.customer.com` 은 정당하다.
 */
export const AGENT_BRAND_RESERVED_LOCAL_PARTS = [
  'claude',
  'claude-code',
  'claudecode',
  'codex',
  'openai-codex',
  'hermes',
  'openclaw',
  'openai',
  'anthropic',
  'chatgpt',
  'gpt',
  'gemini',
  'gemini-cli',
  'copilot',
  'github-copilot',
  'cursor',
  'devin',
  'manus',
  'openhands',
  'aider',
  'cline',
  'roo-code',
  'kilo-code',
  'opencode',
  'goose',
  'windsurf',
  'jules',
  'amp',
  'kiro',
  'qwen',
  'grok',
  'llama',
  'meta-ai',
  'mistral',
  'deepseek',
  'kimi',
  'perplexity',
  'replit',
  'lovable',
  'v0',
  // ---- 2026-10-14 확장(진윤겸 — "예약 주소에 grok, codex 등의 AI 기업들 이름도 포함해줘", 202610141200). 정확 일치 그대로 — 접두사로 막으면
  // `grok-fan`·`naver-blog-helper` 같은 정당한 이름이 막힌다. 흔한 낱말·사람 이름에 가까운 것(`bard`·`whisper`·`bedrock`·`nous`·`stability`·
  // `runway`·`inflection`·`poe`·`cody`·`zed`·`warp`·`bolt`·`lindy`·`adept`·`fireworks`·`moonshot`·`minimax`·`glm`·`yi`·`ernie`·`cognition`·
  // `upstage`·`solar`·`gauss`·`o1`)은 넣지 않고, 필요한 곳은 회사 접미 이름(`stability-ai` 등)으로 대신한다. 이 줄 아래는 202610141200 이전에
  // 발급된 행이 있어도 그 행은 그대로 쓴다(DB `atmark_reserved_grandfathered_address_keys()` — 새 발급만 막는다).
  'xai',
  'grokbot',
  'grok-bot',
  'groq',
  'google-ai',
  'deepmind',
  'gemma',
  'openai-agent',
  'gpt-4',
  'gpt4',
  'gpt-4o',
  'gpt4o',
  'gpt-5',
  'gpt5',
  'sora',
  'dall-e',
  'dalle',
  'chatgpt-bot',
  'codex-cli',
  'anthropic-ai',
  'claude-ai',
  'claudebot',
  'claude-bot',
  'copilot-agent',
  'microsoft-copilot',
  'bing',
  'amazon-q',
  'alexa',
  'siri',
  'apple-intelligence',
  'meta-llama',
  'llama-agent',
  'nousresearch',
  'nous-research',
  'hermes-agent',
  'cohere',
  'command-r',
  'huggingface',
  'hugging-face',
  'midjourney',
  'stability-ai',
  'stabilityai',
  'stable-diffusion',
  'runwayml',
  'inflection-ai',
  'character-ai',
  'phind',
  'tabnine',
  'codeium',
  'sourcegraph',
  'lindy-ai',
  'adept-ai',
  'cerebras',
  'together-ai',
  'fireworks-ai',
  'mistral-ai',
  'mixtral',
  'deepseek-ai',
  'qwen-agent',
  'tongyi',
  'kimi-ai',
  'moonshot-ai',
  'minimax-ai',
  'zhipu',
  'chatglm',
  'baichuan',
  'doubao',
  'ernie-bot',
  'wenxin',
  'manus-ai',
  'devin-ai',
  'cognition-ai',
  'openhands-ai',
  'cline-bot',
  'goose-ai',
  'jules-ai',
  // 한국 AI 회사·제품.
  'naver',
  'hyperclova',
  'hyperclova-x',
  'hyperclovax',
  'clova',
  'kakao',
  'kanana',
  'upstage-ai',
  'exaone',
  'lg-ai',
  'wrtn',
  'skt',
  'adot',
  'a-dot',
  'samsung-gauss',
] as const;

/**
 * 발급할 수 없는 로컬파트 전체(소문자 정규화 후 비교). 넓히기는 쉽고 좁히기는 불가능하다 — 발급된 주소는 회수 경로가 없으므로 의심스러우면
 * 예약한다. 순서는 DB `atmark_reserved_local_parts()` 와 같다(중복은 처음 자리만 — 통합 테스트가 대조).
 */
export const RESERVED_LOCAL_PARTS: readonly string[] = [
  ...new Set<string>([
    ...RFC_2142_ROLE_LOCAL_PARTS,
    ...OPERATIONAL_RESERVED_LOCAL_PARTS,
    ...DEMO_RESERVED_LOCAL_PARTS,
    ...SERVICE_RESERVED_LOCAL_PARTS,
    ...CERTIFICATE_VALIDATION_RESERVED_LOCAL_PARTS,
    ...TRUST_RESERVED_LOCAL_PARTS,
    ...EXAMPLE_RESERVED_LOCAL_PARTS,
    ...AGENT_BRAND_RESERVED_LOCAL_PARTS,
  ]),
];

const RESERVED_LOCAL_PART_SET = new Set<string>(RESERVED_LOCAL_PARTS);

// ---------------------------------------------------------------------------
// 운영자 전용 예약 주소 — 예약 로컬파트 중 **운영자 CLI 만** 발급하는 주소
// ---------------------------------------------------------------------------

/**
 * **운영자가 발급할 수 있는 예약 주소** — 예약 로컬파트지만 운영자가 지정한 조직의 에이전트에는 붙일 수 있다: 지원 에이전트(`support@`)와 그
 * 별칭(`onve@` — 환영 메일 발신), 수신 전용 별칭(`abuse@`·`postmaster@`). `claude@` 는 202610141200 에서 뺐다(진윤겸 2026-10-14 "claude는 없애주렴" —
 * 그 에이전트를 지울 수 있게). `claude` 는 브랜드 예약으로 남아 지운 뒤에도 **아무도**(같은 조직도) 다시 받지 못한다.
 *
 * SQL `atmark_operator_assignable_addresses()` 와 같은 값·같은 순서다(통합 테스트). DB 는 트리거 `agent_addresses_operator_grant_guard` 로 그 조직의
 * 운영자 허가 행(`operator_address_grants`)을 따로 요구한다(없으면 42501). 콘솔·API·MCP 경로는 `buildAgentAddress` 라 `reserved_local_part` 로 거부된다.
 */
export const OPERATOR_ASSIGNABLE_ADDRESSES = [
  'support@atmark.ai',
  'onve@atmark.ai',
  'abuse@atmark.ai',
  'postmaster@atmark.ai',
] as const;

/**
 * **수신 전용 주소** — 운영자 목록 안이지만 발신 주소가 될 수 없다. 이 주소에서 나가는 메일은 "Atmark 운영자의 공식 답" 으로 읽히므로, 신뢰할 수
 * 없는 메일을 읽는 지원 에이전트가 그 권위로 말하게 두지 않는다. 세 층이 막는다: 발송 전처리(`src/api/outbound-service.ts`) · 회신 기본 발신
 * 주소(`reply-target-store.ts`) · 발송 역할 IAM Deny(`compute-stack.ts` `SES_RECEIVE_ONLY_FROM_ADDRESSES` — 같은 값, 단위 테스트).
 */
export const RECEIVE_ONLY_ADDRESSES = ['abuse@atmark.ai', 'postmaster@atmark.ai'] as const;

/** 수신 전용 주소인가(대소문자·앞뒤 공백 무시). */
export function isReceiveOnlyAddress(address: string): boolean {
  return (RECEIVE_ONLY_ADDRESSES as readonly string[]).includes(address.trim().toLowerCase());
}

declare const OPERATOR_RESERVED_ADDRESS_BRAND: unique symbol;

/**
 * 운영자가 발급하는 예약 주소 — **`buildOperatorReservedAddress` 만 만든다**(브랜드). 프로비저닝·별칭 추가는 이 타입을 받을 때만 예약 판정을
 * 건너뛴다. 그 함수를 값으로 import 하는 곳은 운영자 CLI 하나다(`test/arch/operator-reserved-address.arch.test.ts`).
 */
export type OperatorReservedAddress = string & { readonly [OPERATOR_RESERVED_ADDRESS_BRAND]: true };

/** 입력(대소문자·앞뒤 공백 허용) → 운영자 예약 주소. 목록 밖이면 `reserved_local_part` 가 아니라 `not_an_address` 로 던진다(운영자 입력 오류). */
export function buildOperatorReservedAddress(raw: string): OperatorReservedAddress {
  const normalized = raw.trim().toLowerCase();
  if (!(OPERATOR_ASSIGNABLE_ADDRESSES as readonly string[]).includes(normalized)) {
    throw new AgentAddressError(
      'not_an_address',
      `운영자 예약 주소가 아니다 — ${OPERATOR_ASSIGNABLE_ADDRESSES.join(' · ')} 중 하나: ${JSON.stringify(raw)}`,
    );
  }
  return normalized as OperatorReservedAddress;
}

/**
 * **모든 도메인에서** 예약하는 로컬파트(ADR-0014 결정 8 · J11) — RFC 2142 역할 주소 · 인증서 도메인 검증 주소 · `mailer-daemon`. 고객 서브도메인에서도
 * 사람이 받아야 하는 이름만 담는다(나머지는 `atmark.ai` 전용). 순서는 SQL `atmark_reserved_local_parts_for(domain)` 의 고객 도메인 분기와 같다.
 */
export const GLOBAL_RESERVED_LOCAL_PARTS: readonly string[] = [
  ...RFC_2142_ROLE_LOCAL_PARTS,
  'admin',
  'administrator',
  'root',
  'ssladmin',
  'ssl-admin',
  'sslwebmaster',
  'mailer-daemon',
];

const GLOBAL_RESERVED_LOCAL_PART_SET = new Set<string>(GLOBAL_RESERVED_LOCAL_PARTS);

/** 도메인별 예약 로컬파트 — SQL `atmark_reserved_local_parts_for(domain)` 와 같은 값·같은 순서다(통합 테스트). */
export function reservedLocalPartsFor(domain: string): readonly string[] {
  return domain === AGENT_ADDRESS_DOMAIN ? RESERVED_LOCAL_PARTS : GLOBAL_RESERVED_LOCAL_PARTS;
}

/**
 * 브랜드 이름 비교 키 — 구분자(`.` `_` `-`)를 뺀 로컬파트(202610141200 · 리뷰 L2). `claude.code`·`chat-gpt`·`open_ai`·`hyperclova_x` 가 브랜드 목록을
 * 정확 일치로만 비교할 때 빠져나갔다. **브랜드 목록에만** 쓴다 — 운영 예약(`no-reply` 등)은 정확 일치 그대로다. 접두·접미는 여전히 된다(`grok-fan`).
 * SQL 은 `regexp_replace(local, '[._-]', '', 'g')` 와 `atmark_brand_reserved_keys()`(같은 값·같은 순서 — 통합 테스트).
 */
export function brandKeyOf(localPart: string): string {
  return localPart.replace(/[._-]/g, '');
}

/** 브랜드 목록의 비교 키(중복은 처음 자리만) — SQL `atmark_brand_reserved_keys()` 와 같은 값·같은 순서. */
export const AGENT_BRAND_RESERVED_KEYS: readonly string[] = [...new Set<string>(AGENT_BRAND_RESERVED_LOCAL_PARTS.map(brandKeyOf))];

const AGENT_BRAND_RESERVED_KEY_SET = new Set<string>(AGENT_BRAND_RESERVED_KEYS);

function isReservedLocalPart(localPart: string, domain: string): boolean {
  if (domain !== AGENT_ADDRESS_DOMAIN) return GLOBAL_RESERVED_LOCAL_PART_SET.has(localPart);
  return RESERVED_LOCAL_PART_SET.has(localPart) || AGENT_BRAND_RESERVED_KEY_SET.has(brandKeyOf(localPart));
}

/**
 * 주소 도메인 모양 — 소문자 LDH 라벨 둘 이상, 라벨 1~63자, 앞뒤 하이픈 없음, R-LDH(`xn--` 등 셋째·넷째 `--`) 없음, 끝 점 없음, 마지막 라벨이
 * 숫자만이 아님. `src/domains/names.ts` 보다 **넓다**(PSL 판정 없음 — 이 파일은 발송 경로가 import 하므로 PSL 을 끌어오지 않고, 소유 여부는 DB 가 본다).
 */
const AGENT_ADDRESS_DOMAIN_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const R_LDH_LABEL = /^[a-z0-9]{2}--/;
const NUMERIC_TLD = /\.[0-9]+$/;

export function isAgentAddressDomainShape(domain: string): boolean {
  return (
    // 고객 도메인 길이 상한 100(ADR-0014 · `CUSTOM_DOMAIN_MAX_LENGTH` — 이 파일은 계약을 import 하지 않는다, 단위 테스트가 대조).
    domain.length <= 100 &&
    AGENT_ADDRESS_DOMAIN_SHAPE.test(domain) &&
    !domain.split('.').some((label) => R_LDH_LABEL.test(label)) &&
    !NUMERIC_TLD.test(domain)
  );
}

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/** 거부 사유 — 닫힌 유니온. API 층이 그대로 400 응답 코드로 쓴다. */
export type AgentAddressRejection =
  | 'invalid_length'
  | 'invalid_character'
  | 'consecutive_dots'
  | 'reserved_local_part'
  | 'not_an_address'
  /** 도메인 모양이 아니다(ADR-0014 — `isAgentAddressDomainShape`). 소유 여부는 DB 가 본다. */
  | 'invalid_domain';

/** 주소 발급 실패 — 트랜잭션 전에 던진다. 호출부는 메시지가 아니라 `reason` 으로 분기한다(문구는 바뀐다). */
export class AgentAddressError extends Error {
  constructor(
    readonly reason: AgentAddressRejection,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'AgentAddressError';
  }
}

/**
 * 로컬파트(+ 도메인) → 정규화된 에이전트 주소. 로컬파트의 소문자화 외에는 관대함이 없다 — `..`·양끝 구두점은 수신측 파서마다 다르게 읽혀
 * 정렬(alignment) 실패로 이어진다.
 *
 * 고객 도메인은 **이미 정규화된 소문자 값**을 받고 여기서 고치지 않는다 — 조용히 고치면 verified 행과 다른 문자열이 DB 로 가는 결함을 숨긴다.
 */
export function buildAgentAddress(localPart: string, domain: string = AGENT_ADDRESS_DOMAIN): string {
  if (domain !== AGENT_ADDRESS_DOMAIN && !isAgentAddressDomainShape(domain)) {
    throw new AgentAddressError('invalid_domain', `주소 도메인 모양이 아니다: ${JSON.stringify(domain)}`);
  }
  const normalized = localPart.trim().toLowerCase();

  if (normalized.length === 0 || normalized.length > AGENT_LOCAL_PART_MAX_LENGTH) {
    throw new AgentAddressError(
      'invalid_length',
      `로컬파트 길이는 1~${AGENT_LOCAL_PART_MAX_LENGTH} 여야 한다: ${JSON.stringify(localPart)}`,
    );
  }
  if (!AGENT_LOCAL_PART_PATTERN.test(normalized)) {
    throw new AgentAddressError(
      'invalid_character',
      `로컬파트는 소문자 영숫자로 시작·종료하고 가운데에만 "." "_" "-" 를 허용한다: ${JSON.stringify(localPart)}`,
    );
  }
  // `..` 는 위 패턴을 통과한다(가운데 문자 집합에 `.` 이 있다).
  if (normalized.includes('..')) {
    throw new AgentAddressError(
      'consecutive_dots',
      `로컬파트에 ".." 를 쓸 수 없다: ${JSON.stringify(localPart)}`,
    );
  }
  // 앵커 이름 공간(`ax--`)은 고객 도메인 대표의 @atmark.ai 앵커 전용이다. **형식 오류**로 거부한다 — "사용 중"(409)이 아니라서 그런 앵커가 있는지
  // 새지 않는다. DB 도 `agent_addresses_anchor_namespace_guard` 로 막는다.
  if (normalized.startsWith(ANCHOR_NAMESPACE_PREFIX)) {
    throw new AgentAddressError(
      'invalid_character',
      `로컬파트는 "${ANCHOR_NAMESPACE_PREFIX}" 로 시작할 수 없다: ${JSON.stringify(localPart)}`,
    );
  }
  // 정확히 일치할 때만 거부한다 — `postmaster2`·`my-abuse` 는 역할 주소가 아니다. 브랜드 이름만 구분자를 빼고 비교한다(`chat-gpt` · `claude.code`).
  if (isReservedLocalPart(normalized, domain)) {
    throw new AgentAddressError(
      'reserved_local_part',
      `"${normalized}" 는 예약된 로컬파트다 (역할 주소·운영 예약·데모 예약): ${JSON.stringify(localPart)}`,
    );
  }

  return `${normalized}@${domain}`;
}

/** `agent_addresses.domain` 값(마지막 `@` 뒤). DB CHECK `agent_addresses_domain_matches_address` 가 주소와의 일치를 집행한다. */
export function addressDomain(address: string): string {
  const atIndex = address.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === address.length - 1) {
    throw new AgentAddressError(
      'not_an_address',
      `주소에서 도메인을 얻을 수 없다: ${JSON.stringify(address)}`,
    );
  }
  return address.slice(atIndex + 1);
}

/**
 * **메일 신원 키**(ADR-0014 결정 7) — 에이전트 주소와 사람 이메일을 같은 판정형으로: 로컬파트는 첫 `+` 앞까지 소문자(앞이 비면 전체), 도메인은
 * 소문자(마지막 `@` 기준). `Bob+x@Agents.C.com` → `bob@agents.c.com`. SQL `atmark_mail_claim_key(text)` 와 같은 표를 통과한다(패리티 테스트).
 * 주소가 아니면 `null`. 이 키의 SHA-256 이 `mail_identity_claims.claim_hash` 다(에이전트와 사람이 같은 키를 가질 수 없다 — P0A01). 멱등이다.
 */
export function mailClaimKey(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  const whole = address.slice(0, at);
  // `+tag@x.com`(실제로 쓰이는 사람 주소)은 잘라서 빈 키가 되면 가입·초대가 실패하므로 로컬파트 전체를 쓴다.
  const head = whole.split('+')[0] ?? '';
  const local = head === '' ? whole : head;
  return `${local.toLowerCase()}@${address.slice(at + 1).toLowerCase()}`;
}
