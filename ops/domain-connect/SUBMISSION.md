# Domain Connect 제출 초안 (Templates PR · Cloudflare 온보딩)

비공개 작업 문서. **아무것도 자동으로 보내지 않는다** — PR 열기 · 메일 발송은 진윤겸이 한다. 결정 근거는 ADR-0014 "2026-10 덧붙임 — Domain Connect",
배포 순서는 `docs/runbooks/deploy.md` §42.

## 0. 진윤겸 체크리스트

1. [ ] Compute 배포로 서명 키 생성(deploy §42 1~2) — 키는 꺼진 채로 생긴다.
2. [ ] 공개키 TXT 게시: `AWS_PROFILE=atmark pnpm admin:dc-pubkey` 가 찍는 두 줄을 Cloudflare `atmark.ai` 존에 TXT 레코드 2개로(이름 `_dcpubkeyv1.dc`, DNS only) →
       `pnpm admin:dc-pubkey --verify` 가 "게시 확인".
3. [ ] 로고 확인: `https://atmark.ai/favicon.svg`(흑백 SVG — 검은 둥근 사각형 위 흰 로고 심볼, 이미 서빙 중 · 린터 `-logos` 통과).
       전용 로고 URL 을 따로 원하면 사이트에 `/dc/logo.svg` 를 추가한 뒤 템플릿의 `logoUrl` 과 `version` 을 함께 바꾼다.
4. [ ] 온라인 편집기 테스트(아래 §1-3) — **링크는 사람이 직접 만들어 붙인다**(지어낸 링크 금지 — Templates 리포 규칙).
5. [ ] Domain-Connect/Templates 에 PR(아래 §1 본문). 파일: `atmark.ai.mail.json` **하나**(이 폴더의 파일을 그대로 리포 루트에).
   2026-10-05 one-shot 으로 `atmark.ai.ownership` 은 제출 전에 폐기했다 — 소유 TXT 가 같은 템플릿 안(`_atmark-challenge.<host>`)으로 들어왔다.
6. [ ] Cloudflare 메일 발송(아래 §2) — PR 링크를 넣어서.
7. [ ] Cloudflare 회신 뒤 켜기(deploy §42 7).

## 1. Templates PR

### 1-1. 린터 결과 (dc-template-linter version 131, 2026-10-06 로컬 재실행 — 템플릿 하나, DMARC 레코드 추가 뒤)

| 파일 | `-merge-or-fail` | `-tolerate warn` | 기본(info) | `-logos` | `-cloudflare` |
|---|---|---|---|---|---|
| `atmark.ai.mail.json` | **exit 0**(자동 병합 조건 충족) | exit 0 | exit 0 | exit 0(2026-10-05) | info DCTL5003(syncRedirectDomain 미지원) · DCTL5008 ×4(TXT conflict matching 미지원 — 소유 TXT · DMARC 각 2) · DCTL5011(essential 미지원) · exit 0 |

`hostRequired` 는 **쓰지 않는다**(2026-10-05 리드 결정): 켜면 info DCTL1037("host @ 의 NS/CNAME 과 함께 쓰라")로 `-merge-or-fail` 이 exit 2 →
사람 검토가 되고, Cloudflare 는 그 플래그를 무시한다(DCTL5006). apex 적용은 서버가 서명 전에 거부한다(`dc-url.ts` `hostOf` → `apex_not_allowed`;
apex 는 고객 도메인 판정이 먼저 거부한다). 자동 병합 경로로 심사 기간을 줄이는 쪽을 택했다.

옛 ownership 의 DCTL1043(`multiInstance` → 사람 검토)은 템플릿을 하나로 합치며 사라졌다 — 소유 TXT 가 서브도메인 아래(`_atmark-challenge.<host>`)라
서브도메인마다 이름이 달라 여러 토큰이 한 이름에 공존할 일이 없다. TXT 는 `txtConflictMatchingMode: Prefix`(`atmark-domain-verification=`)로
**같은 호스트의 옛 토큰을 바꾼다**(같은 서브도메인을 지우고 다시 추가 · 다른 조직이 그 DNS 를 가진 사람으로 다시 연결 = 옛 행의 토큰이 사라지는 것이 맞다 —
양도 경로). Cloudflare 는 conflict matching 을 무시하므로(DCTL5008) 거기서는 TXT 를 더한다 — 우리 판정은 값이 들어 있기만 하면 되므로 결과가 같다.

**DMARC(2026-10-06 추가, 진윤겸 결정):** 마지막 레코드 TXT `_dmarc` = `v=DMARC1; p=none`(권장 — 우리 확인과 무관, `rua=` 없음: 고객 도메인 리포트 메일함을
운영하지 않는다). `txtConflictMatchingMode: Prefix` · prefix `v=DMARC1` — 같은 호스트에 `v=DMARC1` TXT 가 둘이면 DMARC 자체가 무효(RFC 7489 §6.6.3)라
**더하지 않고 바꾼다**(에이전트 전용 서브도메인이라 바뀌는 쪽은 대개 없다). `essential: OnApply` — 고객이 나중에 `quarantine`/`reject` · `rua=` 로 고쳐도 템플릿 적용이
깨진 것으로 보지 않게. Cloudflare 는 conflict matching(DCTL5008)과 essential(DCTL5011)을 무시한다 — 거기서는 TXT 가 **더해지므로** 이미 DMARC 가 있던 고객에게는
하나를 지우라고 안내한다(런북 custom-domains §6). 템플릿은 아직 제출 전이라 `version` 1 그대로.

### 1-2. 커밋 제목

`Atmark, 1 template`

### 1-3. 온라인 편집기 테스트 방법 (https://domainconnect.paulonet.eu/dc/free/templateedit)

파일 내용을 붙여 넣고 "Check template" → 아래 값으로 "Test apply template" → "Copy Markdown" 링크를 PR 본문에 붙인다.

- 서브도메인(우리가 쓰는 유일한 경우): `domain=example.com`, `host=agents`, `token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde`,
  `t1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, `t2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, `t3=cccccccccccccccccccccccccccccccc`
- apex: 같은 값에 host 비움(리포 규칙상 apex · 서브도메인 둘 다 요구 — 우리 서버는 apex 요청에 서명하지 않는다)

### 1-4. PR 본문 (영어, 그대로 붙여 넣기)

```markdown
# Description

Atmark (https://atmark.ai) gives AI agents an identity and an email address. Customers can bring their own domain
(in practice a subdomain such as `agents.example.com`). This PR adds **one** template for the synchronous flow, so the
whole setup is a single consent from the Atmark console:

`atmark.ai.mail`, applied with `domain=<registrable domain>&host=<subdomain>` (Atmark agent domains are always subdomains;
our server refuses to sign an apex request):
- TXT `_atmark-challenge` — the Atmark ownership challenge for this host (`atmark-domain-verification=%token%`),
- MX on the host — inbound mail through Amazon SES (ap-northeast-2),
- custom MAIL FROM `bounce.<host>` — MX + SPFM,
- three Easy DKIM CNAMEs `%t1%._domainkey` … `%t3%._domainkey`,
- TXT `_dmarc` — a minimal recommended DMARC record (`v=DMARC1; p=none`, no `rua`), so mail from the host passes DMARC at receivers that require it.

All requests are signed (`syncPubKeyDomain: dc.atmark.ai`, key `_dcpubkeyv1`, RSA 2048 / SHA-256, private key held in AWS KMS);
every query parameter is generated server-side from our database. After the redirect we verify every record by querying the
authoritative name servers — we do not trust the redirect parameters.

The subdomain is passed only through the standard `host` parameter — there is no host variable (rule 8). The only variables in a
`host` field are the DKIM selectors `%t1%._domainkey` … `%t3%._domainkey` (fixed `._domainkey` suffix, fixed `.dkim.amazonses.com`
target). The challenge TXT uses `txtConflictMatchingMode: Prefix` with prefix `atmark-domain-verification=`, so re-applying for the
same host replaces a stale challenge instead of accumulating tokens. The DMARC TXT uses the same mode with prefix `v=DMARC1` (two DMARC
records at one name make DMARC fail) and `essential: OnApply`, so the customer can later tighten the policy or add `rua` without breaking the template.

## Type of change

- [x] New template

# How Has This Been Tested?

- [ ] Template functionality checked using [Online Editor](https://domainconnect.paulonet.eu/dc/free/templateedit)   <!-- 편집기 테스트를 실제로 한 뒤에만 [x] -->
- [x] Template file name follows the pattern `<providerId>.<serviceId>.json`
- [x] resource URL provided with `logoUrl` is actually served by a webserver (`dc-template-linter -logos`: OK)

`dc-template-linter -merge-or-fail`: exit 0.

# Checklist of common problems

- [x] `syncPubKeyDomain` is set
- [x] `warnPhishing` is **not** set alongside `syncPubKeyDomain`
- [x] `syncRedirectDomain` is set (`console.atmark.ai`)
- [x] no TXT record contains SPF content — `SPFM` is used for `bounce`
- [x] `txtConflictMatchingMode` is set on both TXT records (`Prefix`: `atmark-domain-verification=` · `v=DMARC1`)
- [x] no variable is used as a bare full record value (`atmark-domain-verification=%token%`)
- [x] no bare variable is used as the full `host` label (`%t1%._domainkey`)
- [x] no variable is used in the `host` field to create a subdomain
- [x] `%host%` does not appear explicitly in any `host` attribute
- [x] `essential` — `OnApply` only on the DMARC TXT (customers tighten it later); the other records are not meant to be edited independently (the SPFM result is non-essential by spec)

## Online Editor test results

**Editor test link(s):**
- subdomain (host=agents): <붙여 넣기>
- apex: <붙여 넣기>
```

## 2. Cloudflare 온보딩 메일

**한국어 요약:** Cloudflare 는 템플릿 리포 병합만으로 켜지지 않는다. `domain-connect@cloudflare.com` 으로 템플릿 PR 링크 · 공개키 FQDN · 로고 ·
프록시 선호(CNAME 은 DKIM 이라 DNS only)를 보낸다. 병합 뒤 갱신은 문서상 "보통 8시간 안" 이지만 최초 온보딩 기간은 문서에 없다 — 회신을 기다린다.
보내는 주소는 진윤겸이 고른다(예: `support@atmark.ai` 또는 개인 Gmail). 사업자 번호 · 주소는 넣지 않는다.

**제목:** Domain Connect onboarding request — Atmark (providerId atmark.ai)

**본문(영어):**

```text
Hello Cloudflare Domain Connect team,

We would like to onboard Atmark as a Domain Connect service provider (synchronous flow).

Service: Atmark — identity and email addresses for AI agents (https://atmark.ai)
providerId: atmark.ai
Template (Domain-Connect/Templates): <PR or merged file link>
  - atmark.ai.mail — ownership challenge TXT, inbound MX, MAIL FROM (MX + SPFM), three DKIM CNAMEs and a p=none DMARC TXT for a subdomain
    (one template, applied once with domain + host)
Request signing: syncPubKeyDomain dc.atmark.ai, key _dcpubkeyv1
  (public key published at _dcpubkeyv1.dc.atmark.ai; RSA 2048, SHA-256)
Redirect: https://console.atmark.ai/app (all requests are signed)
Logo (SVG): https://atmark.ai/favicon.svg
Proxy preference: all CNAME records are DKIM records and must be DNS only (not proxied). The templates contain no A/AAAA records.

Notes:
- A single application sets up everything; the DKIM tokens exist as soon as the domain is added in Atmark.
- We understand state, TXT conflict matching and essential are not supported on Cloudflare; we verify all records by DNS lookup after the redirect.

A Cloudflare account ID for testing can be provided on request.

Thank you,
<이름>
Atmark
```
