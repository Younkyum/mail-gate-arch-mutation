/**
 * src/security/dlp/secrets.ts — 발신 본문 속 **자격 증명 모양** 탐지(ADR-0016 B). 결정론 · 선형 시간 · 값을 돌려주지 않는다.
 *
 * 두 계열:
 *   - `atmark_credential` — 우리가 발급하는 비밀. 형식은 발급 코드에서 왔다:
 *       · 불투명 토큰 `atk_agent_`(`src/identity/agent-token.ts`) · `atk_org_`(`src/identity/org-api-key.ts`) ·
 *         `atk_admin_`(`src/admin/session.ts`) — 접두사 + base64url 43자(256비트).
 *       · 서명 토큰 `atk_invite_`(`src/security/invite-token.ts`) · `atk_link_`(`src/approval/magic-link.ts`) · 옛 `atk_login_` · `atk_signup_`
 *         (2026-10-10 발급 중단 — 남은 메일 속 토큰도 잡는다) — `접두사 kid . 페이로드 . 서명(base64url 43자)`.
 *       · 웹훅 시크릿 `whsec_` + 표준 base64(`src/webhooks/signing.ts` — 32바이트 = 43자 + `=`).
 *   - `third_party_secret` — 널리 알려진 남의 비밀 형식: AWS 액세스 키 id(`AKIA`·`ASIA` + 16) · GitHub(`gh[pousr]_` · `github_pat_`) ·
 *     GitLab(`glpat-`) · Slack(`xox[abpe]-` · `xoxe.xox[bp]-` · `xapp-`) · Stripe 라이브 키(`sk_live_`·`rk_live_`) · Anthropic(`sk-ant-`) ·
 *     OpenAI(`sk-proj-` · 옛 형식 `sk-` + 정확히 48자) · Google API 키(`AIza` + 정확히 35자) · PEM 개인 키 머리(`-----BEGIN … PRIVATE KEY-----`) ·
 *     JWT 세 마디(`eyJ….eyJ….…`). `sk-` 는 옛 OpenAI 길이(48)에 정확히 맞을 때만 — 넓히면 `sk-` 로 시작하는 낱말·해시가 걸린다.
 *
 * **접은 보기(`injection/normalize.ts` `fold`) 위에서 본다.** 접으면 소문자가 되므로 패턴은 소문자형으로 적는다 — base64 문자 집합은
 * 대소문자를 둘 다 담으므로 잃는 것이 없다. 대신 얻는 것: 전각(`ａｔｋ＿`)·제로폭 끼우기(`atk_age​nt_…`)·동형문자가 그대로 걸린다.
 *
 * **정규식 규율(`injection-redos` 와 같다):** 가변 수량자(`+` `*` `{n,}`) 없음 — 모든 반복은 상한이 있다. 문자 집합은 구분자(`.`)를
 * 포함하지 않아 마디 경계에서 역추적이 갈리지 않는다. `test/unit/security/dlp/dlp-redos.test.ts` 가 정적 감사와 1MB 실측을 한다.
 *
 * **알려진 한계:** base64 · 16진수 · `%XX` 로 감싼 비밀은 `scan.ts` 가 풀어 본 보기(`decode.ts`)를 이 함수에 한 번 더 넘겨 잡는다. 글자 사이 공백 ·
 * 뒤집기 · 암호화는 잡지 않는다(`docs/security/encoding-limits.md`). 이 탐지는 실수로 새는 비밀과 순진한
 * 유출을 붙잡는 그물이고, 작정한 우회의 본체 방어는 위험 적응 승인(A)이다(ADR-0016 "남는 한계").
 */

export type SecretFamily = 'atmark_credential' | 'third_party_secret';

interface SecretPattern {
  readonly name: string;
  readonly family: SecretFamily;
  readonly pattern: RegExp;
}

/** base64url 한 글자(접은 보기 — 소문자). */
const B64URL = '[a-z0-9_-]';

/** 탐지 정규식 전부. **새 정규식은 여기에 넣는다** — 목록 밖 정규식은 ReDoS 감사를 받지 않는다. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'atmark.opaque_token',
    family: 'atmark_credential',
    pattern: new RegExp(`(?<![a-z0-9_])atk_(?:agent|org|admin)_${B64URL}{43}`),
  },
  {
    name: 'atmark.signed_token',
    family: 'atmark_credential',
    pattern: new RegExp(`(?<![a-z0-9_])atk_(?:invite|login|signup|link)_[a-z0-9]{1,16}\\.${B64URL}{8,2048}\\.${B64URL}{43}`),
  },
  { name: 'atmark.webhook_secret', family: 'atmark_credential', pattern: /(?<![a-z0-9_])whsec_[a-z0-9+/]{40,88}/ },
  { name: 'aws.access_key_id', family: 'third_party_secret', pattern: /(?<![a-z0-9])(?:akia|asia)[0-9a-z]{16}(?![0-9a-z])/ },
  { name: 'github.token', family: 'third_party_secret', pattern: /(?<![a-z0-9_])gh[pousr]_[a-z0-9]{36,255}/ },
  { name: 'github.fine_grained_pat', family: 'third_party_secret', pattern: /(?<![a-z0-9_])github_pat_[a-z0-9_]{60,255}/ },
  { name: 'gitlab.pat', family: 'third_party_secret', pattern: /(?<![a-z0-9_-])glpat-[0-9a-z_-]{20,255}/ },
  { name: 'slack.token', family: 'third_party_secret', pattern: /(?<![a-z0-9.])(?:xox[abpe]|xoxe\.xox[bp]|xapp)-[0-9a-z-]{10,255}/ },
  { name: 'stripe.live_key', family: 'third_party_secret', pattern: /(?<![a-z0-9_])[sr]k_live_[0-9a-z]{16,255}/ },
  { name: 'anthropic.api_key', family: 'third_party_secret', pattern: /(?<![a-z0-9_-])sk-ant-[0-9a-z_-]{32,255}/ },
  { name: 'openai.project_key', family: 'third_party_secret', pattern: /(?<![a-z0-9_-])sk-proj-[0-9a-z_-]{32,255}/ },
  { name: 'openai.legacy_key', family: 'third_party_secret', pattern: /(?<![a-z0-9_-])sk-[0-9a-z]{48}(?![0-9a-z_-])/ },
  { name: 'google.api_key', family: 'third_party_secret', pattern: /(?<![a-z0-9_-])aiza[0-9a-z_-]{35}(?![0-9a-z_-])/ },
  {
    name: 'pem.private_key',
    family: 'third_party_secret',
    pattern: /-----begin[ \n](?:[a-z]{1,16}[ \n]){0,3}private[ \n]key-----/,
  },
  {
    name: 'jwt',
    family: 'third_party_secret',
    pattern: new RegExp(`(?<![a-z0-9_-])eyj${B64URL}{8,4096}\\.eyj${B64URL}{8,4096}\\.${B64URL}{16,4096}`),
  },
];

/** ReDoS 감사용(`dlp-redos.test.ts`). */
export const SECRET_AUDITED_PATTERNS: readonly { readonly name: string; readonly source: string }[] = SECRET_PATTERNS.map((p) => ({
  name: p.name,
  source: p.pattern.source,
}));

/**
 * 접은 보기 → 걸린 계열(닫힌 집합, 중복 없음, `atmark_credential` 먼저). **매칭 원문·위치를 돌려주지 않는다** — 결과는 감사 행·로그·
 * 승인 메일로 가고, 거기에 토큰 값이 실리면 탐지가 곧 유출이 된다(진윤겸 결정 2 — "값은 가린다").
 */
export function detectSecretFamilies(folded: string): SecretFamily[] {
  const found = new Set<SecretFamily>();
  for (const { family, pattern } of SECRET_PATTERNS) {
    if (found.has(family)) continue;
    if (pattern.test(folded)) found.add(family);
  }
  return (['atmark_credential', 'third_party_secret'] as const).filter((family) => found.has(family));
}
