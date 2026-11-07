# Cloudflare DNS — `atmark.ai`

> 현재 상태 확인: **2026-09-22**. 기계 확인은 `pnpm check:dns` (AC-c1).
> 등록기관 Cloudflare Registrar · 만료 2028-04-15 · 자동갱신 ON · `clientTransferProhibited`.

계획 §3.3이 요구하는 레코드는 **8건**이다 — ① MX · ② SPF · ③④⑤ DKIM ×3 · ⑥ DMARC ·
⑦ `id` CNAME · ⑧ CAA. r3는 선언 8건 / AC-c1 7건 / demo 6건으로 세 곳이 어긋나 있었고
**AC-c1에서 빠진 것이 하필 MX**였다. 이 문서와 `scripts/check-dns.ts` 가 8건을 한 곳에서 센다.

`notify.atmark.ai` 관련 레코드는 이 표에 없다 — 도입 시점(Q2)이 열려 있어 조건부다.
Q2가 "P0에 도입"으로 닫히면 AC-c1은 10건(+SPF·DKIM)이 된다.

---

## 1. 현재 실재하는 레코드

| # | 이름 | 타입 | 값 | 판정 |
|---|---|---|---|---|
| ② | `atmark.ai` | TXT | `v=spf1 include:amazonses.com ~all` | ✓ (단, `~all` → 아래 주석) |
| ③ | `mbbtxzajg5mdwjmrbafecwpeofizzymq._domainkey.atmark.ai` | CNAME | `mbbtxzajg5mdwjmrbafecwpeofizzymq.dkim.amazonses.com` | ✓ |
| ④ | `ubyaew6zpap26law3thlritpnnthrmpk._domainkey.atmark.ai` | CNAME | `ubyaew6zpap26law3thlritpnnthrmpk.dkim.amazonses.com` | ✓ |
| ⑤ | `oqo3ullaqifoofsoob2qfuu7cuucf2fz._domainkey.atmark.ai` | CNAME | `oqo3ullaqifoofsoob2qfuu7cuucf2fz.dkim.amazonses.com` | ✓ |
| ⑥ | `_dmarc.atmark.ai` | TXT | `v=DMARC1; p=none;` | ✗ — `rua=` 누락 (아래 P0 잔여 참조) |
| — | `atmark.ai` | TXT | `google-site-verification=Uh-n7trLBv1PhbYoHmIIBT1QbLgejNnE-uW8TktIJdU` | ✓ Google Postmaster Tools 인증 (AC-c1 대상 아님) |
| — | ~~`send.atmark.ai`~~ | TXT + **MX** | ~~`v=spf1 ...`~~ / ~~`feedback-smtp.ap-northeast-1.amazonses.com`~~ | **2026-09-22 삭제 완료.** §5 참조 |

SES 도메인 identity(`atmark.ai`, ap-northeast-2)는 **Verified / DKIM Successful**
(Easy DKIM RSA-2048). SES 프로덕션 액세스 승인 완료 — 2026-09-22 10:51:16 KST,
케이스 `179004186200337`, 한도 **50,000통/일 · 14통/초**.

> **② SPF의 `~all` 에 대하여.** 계획 §3.3 Day-0 문안은 `-all`(hard fail)이다.
> 현재 `~all`(soft fail)로도 SPF 자체는 통과하지만, 위조 발신에 대한 수신측 거부
> 근거가 약하다. **DMARC를 `p=quarantine`으로 올리기 전(D+15)에 `-all`로 강화한다.**
> `check-dns.ts` 는 이 건을 ✓로 세되 주의 문구를 출력한다 — 게이트를 막을 정도는 아니고
> 잊어도 되는 것도 아니기 때문이다.

---

## 2. P0 잔여 — 3건 + 1건

| # | 할 일 | 넣을 값 | 왜 P0인가 |
|---|---|---|---|
| 1 | ⑦ `id.atmark.ai` CNAME | `id.atmark.ai` → `<CloudFront 배포>.cloudfront.net` | `did:web:id.atmark.ai:agents:{id}` 해석 경로의 지반(ADR-0002). DID 문서 자체는 P6까지 필요 없지만 **ACM 인증서 발급·검증이 달력-시간**이라 Principle P5에 따라 day 0에 건다 |
| 2 | ⑧ CAA (루트 고정) | `0 issue "amazon.com"` / `"amazontrust.com"` / `"awstrust.com"` / `"amazonaws.com"` | ADR-0002 F6. 고정하지 않으면 임의 CA가 `atmark.ai` 인증서를 발급할 수 있고, **did:web은 TLS를 신뢰의 근거로 쓴다.** 하위 도메인은 자기 레코드가 없으면 루트에서 상속하므로 루트에 건다 |
| 3 | `send.atmark.ai` TXT 정리 | 삭제 | 구 제품 잔재. 발신 도메인은 **`atmark.ai` 루트로 확정**됐다(계획 §3.3 r3). 미사용 서브도메인의 SPF는 지금 무해하지만, 남겨 두면 나중에 누군가 "발신 서브도메인이 이미 있네"라고 읽는다 — r3가 이 문자열을 계획 본문에서 "지워지지 않은 사고 과정"으로 판단해 삭제했는데 **DNS에는 실물이 남아 있었다.** 문서와 실물 중 하나를 고르는 문제이고, 답은 실물을 지우는 쪽이다 |
| 4 | ⑥ DMARC에 `rua=` 추가 | `v=DMARC1; p=none; rua=mailto:dmarc@atmark.ai; pct=100; fo=1` | **`rua=` 가 없으면 집계 리포트가 한 통도 오지 않는다.** 그러면 `pnpm parse:dmarc-rua`(AC-c6)의 입력이 영구히 비고, D+15/31/45 램프 전환 조건("직전 7일 pass rate ≥ 98%")을 판정할 방법이 사라진다. 계획 §3.3 램프 표의 D+0–14 문안이 이미 이 태그를 포함하고 있었다 — 게시된 레코드가 계획보다 짧았던 것이다 |

`dmarc@atmark.ai` 는 에이전트에 속하지 않으므로 Ontology의 `AgentAddress`가 아니라
`OrgSystemAddress`(`purpose: dmarc_rua`)다. 정책 평가 대상이 아니며 AC-8의 outbound
매니페스트에도 들어가지 않는다 (계획 §3.3 Minor ⑤).

**MX(①)는 여기 없다.** 아래 3절을 볼 것.

---

## 3. ① MX — P3에서 추가한다. 지금 걸면 안 된다

| 이름 | 타입 | 값 | 우선순위 | 시점 |
|---|---|---|---|---|
| `atmark.ai` | MX | `inbound-smtp.ap-northeast-2.amazonaws.com` | 10 | **P3 (inbound 파이프라인)** |

**지금 걸면 안 되는 이유:** MX를 게시하는 순간 세상은 `atmark.ai`가 메일을 받는다고
믿는다. 그런데 **SES 수신 규칙 세트(receipt rule set)가 아직 없으므로** 도착한 메일은
SES에서 거부된다. 즉 "받는다고 광고하고 거부하는" 상태가 되고, 이는 아무것도 광고하지
않는 것보다 나쁘다 — 반송이 쌓이고, 그 반송은 우리가 아직 평판 이력 0인 신규 도메인에서
발생한다(R3·AC-2가 방어하려는 바로 그 지점).

따라서 순서는 고정이다: **SES receipt rule set 생성 → 그 다음 MX 게시.**
`pnpm check:dns` 는 그때까지 ①을 ✗로 보고하며, 그것이 정상 동작이다.
(수신 리전은 확인 완료 — `inbound-smtp.ap-northeast-2.amazonaws.com` 해석 가능,
서울 지원. AC-c7 통과, ADR-0004 불발동. `pnpm check:ses-region`.)

---

## 4. 현재 점수

**4 / 8** — ②③④⑤ 통과, ①⑥⑦⑧ 미통과. `pnpm check:dns` 는 exit 1을 낸다.
8/8 이 되어야 AC-c1이 통과하고, MX는 정의상 P3까지 열리지 않으므로
**AC-c1의 완전 통과는 P3 시점이다.** P0에서 닫을 수 있는 것은 ⑥⑦⑧ 세 건이다.

## 5. 도메인 자체

| 항목 | 상태 | 근거 |
|---|---|---|
| 레지스트라 잠금 / 전송 잠금 | ✓ `clientTransferProhibited` | ADR-0002 F4 |
| 자동갱신 | ✓ ON | ADR-0002 F5 |
| 결제수단 2중화 | 미확인 — 확인할 것 | ADR-0002 F5. 만료된 카드 한 장이 자동갱신을 조용히 실패시킨다 |
| 만료 | 2028-04-15 | `pnpm check:domain-expiry` 가 D-180/90/30/7에 경고 (F6) |
| 만료 선구매 (최대 8년) | **P6로 연기** | 지켜야 할 passport가 P6까지 하나도 발급되지 않으므로 선구매의 가치는 P6에서 처음 생긴다. P6 착수 시 재검토 |
| DNS 계정 하드웨어 MFA | 미확인 — 확인할 것 | ADR-0002 F6 |

**도메인 통제권 = identity 통제권**이다. `atmark.ai`가 만료·탈취되면 발급된 모든
passport가 검증 불가가 되고, 최악의 경우 공격자가 위조 DID 문서를 서빙한다.
did:web의 구조적 약점이라 우회 수단이 없다 (ADR-0002 Consequences / R13).


---

## 4. 2026-09-22 실행 결과

### CAA — 게재 완료, 단 계획과 다르게 갈랐다

계획은 루트를 **Amazon 전용**으로 고정하라고 했다. 그대로 하면 향후 `atmark.ai` 에
마케팅 사이트를 올릴 때(Vercel·Cloudflare = Let's Encrypt / Google Trust) **인증서
발급이 막힌다.** ADR-0002가 실제로 보호하려는 것은 `did:web` 해석 경로인
`id.atmark.ai` 이므로, **그곳만 엄격하게** 걸었다.

| 이름 | 정책 | 건수 |
|---|---|---|
| `atmark.ai` | Amazon 4 + `letsencrypt.org` + `pki.goog` + Cloudflare Universal SSL 자동 추가분 | **14** |
| `id.atmark.ai` | **Amazon 4개만** — 다른 CA 불가 | **4** |

### `send.atmark.ai` — 고아 레코드였다

계획은 이걸 SPF TXT 하나로 보고 "구 제품 잔재"로 적었는데, 실제로는 **MX
`feedback-smtp.ap-northeast-1.amazonses.com`(우선순위 65535)** 가 함께 있었다 —
SES **custom MAIL FROM** 설정의 잔재다. 그런데 그 리전(**도쿄**)의 SES identity 는
**0개**다(`aws ses list-identities --region ap-northeast-1` 확인). 주인이 사라진
레코드이며 우리가 쓰는 리전도 아니다. **MX·TXT 둘 다 삭제했다.**

틀린 리전을 가리키는 MX 는 없느니만 못하다.

### DMARC `rua` — 왜 막혔고 어떻게 풀었나

집계 리포트가 없으면 **AC-c6의 입력이 영원히 비고 D+15/31/45 램프 전환을
판정할 수 없다.** 그런데 `rua` 를 넣는 것 자체가 막혀 있었다:

- `dmarc@atmark.ai` → **MX 가 없다.** MX 는 수신 파이프라인이 서는 P3 이후다
- 외부 주소(지메일 등) → **RFC 7489 §7.1 외부 수신지 인증.** 받는 도메인이
  `atmark.ai._report._dmarc.<그도메인>` 을 게시해야 하는데 gmail.com 에 우리가 못 쓴다

**Cloudflare DMARC Management** 가 둘 다 우회한다 — Cloudflare 자기 주소를 `rua` 에
붙이고, 그 도메인의 인증 레코드를 Cloudflare 가 이미 게시해 둔다. 무료·무제한·
가입 불필요(이미 Cloudflare DNS 사용 중), apex 도메인 전용이라 `atmark.ai` 에 맞는다.
첫 리포트는 최대 24시간.

**정책은 `p=none` 그대로 둔다.** 램프는 리포트를 보고 올린다.

---

## 5. 아직 사람이 넣어야 하는 것 — CDK 배포 이후

Route 53 호스팅 영역이 없으므로 CDK 가 DNS 를 대신 만들지 못한다.

| 이름 | 타입 | 값 | 주의 |
|---|---|---|---|
| `_<해시>.id.atmark.ai` | CNAME | `_<해시>.acm-validations.aws.` | **ACM 검증용.** 값을 미리 알 수 없다 — `AtmarkIdentityCertificate` 배포가 `CREATE_IN_PROGRESS` 로 멈춘 상태에서 다른 터미널로 `IdentityCertificateValidationLookupCommand` 출력의 명령을 돌려 읽는다. 방치하면 수 시간 뒤 스택이 실패한다 |
| `id.atmark.ai` | CNAME | `<AtmarkIdentityCdn 출력>.cloudfront.net` | **프록시 OFF(회색 구름).** 오렌지를 켜면 CloudFront 앞에 Cloudflare 가 끼어들어 TLS 종단이 둘이 된다 |


---

## 6. 2026-09-22 마감 — AC-c1 7/8

| 레코드 | 상태 |
|---|---|
| ① MX | ✗ **P3 예정** — 수신 규칙 세트 없이 MX 를 걸면 들어오는 메일이 SES 에서 거부된다 |
| ② SPF | ✓ |
| ③④⑤ DKIM | ✓ |
| ⑥ DMARC | ✓ `p=none` + Cloudflare `rua` |
| ⑦ `id` CNAME | ✓ `dsvbcl142fw74.cloudfront.net`, 프록시 OFF |
| ⑧ CAA | ✓ apex 14건 / `id` 4건 |

부가 레코드: ACM 검증용 `_e40bccdc5fbac8e4dfb59a79f7ddc270.id.atmark.ai` (유지 필요 —
삭제하면 갱신 시 재검증에 실패한다).

### 검증

`curl --resolve id.atmark.ai:443:<CloudFront IP> https://id.atmark.ai` → **HTTP/2 403**.

403 은 정상이다 — S3 버킷이 비어 있고 DID 문서는 P6 에 올라간다.
중요한 것은 **TLS 단계에서 실패하지 않았다는 점**이다 — 인증서가 `id.atmark.ai` 를
커버하지 않았다면 HTTP 응답 전에 SSL 에러가 났을 것이다.
