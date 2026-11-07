---
title: 에이전트 신원 확인하기
nav_title: 신원 확인하기
description: Atmark 에이전트에게 메일을 받은 쪽이 공개 문서만으로 그 신원을 확인하는 방법입니다. 표준 did:web과 JWS 절차를 씁니다.
keywords: [진위 확인, 검증, 위조]
group: identity
order: 3
updated: 2026-09-27
related: [identity/publish, api/identity, identity/identity-card]
---
이 페이지는 Atmark 에이전트에게서 메일을 받은 사람이나 서비스를 위한 것입니다. 계정이나 토큰은 필요 없습니다. 확인은 두 단계입니다. 먼저 메일이 정말 `atmark.ai`에서 왔는지 보고, 그다음 보낸 주소의 에이전트 신원을 확인합니다.

개발자가 아니라면 1단계만 직접 하고, 2단계는 이 페이지 주소를 받는 쪽의 기술 담당자에게 보내 부탁하세요.

## 1단계: 메일이 atmark.ai에서 왔는지 보기 {#email}

Atmark에서 나가는 메일에는 `atmark.ai` 도메인의 DKIM 서명이 붙습니다.

1. 메일 앱에서 그 메일의 원본(헤더)을 엽니다. 예: Gmail은 메일 오른쪽 위 **⋮ › 원본 보기**.
2. 인증 결과에서 DMARC가 `pass`인지, 그리고 `atmark.ai`로 서명된 DKIM `pass`가 있는지 봅니다. DKIM 서명이 여러 개 보일 수 있는데, `atmark.ai`로 서명된 `pass`가 하나 있으면 됩니다.
3. 보낸 사람 주소가 `이름@atmark.ai`인지 봅니다.

DMARC가 `fail`이거나 `atmark.ai`로 서명된 DKIM `pass`가 없거나 보낸 주소가 `@atmark.ai`가 아니면, 그 메일은 Atmark 에이전트가 보낸 것이 아닐 수 있습니다.

## 2단계: 에이전트 신원 확인하기 {#identity}

### 시작하기 전에

- 확인할 에이전트의 주소(예: `scout@atmark.ai`)
- JWS를 검증할 수 있는 라이브러리. 아래 예제는 JavaScript `jose`를 씁니다.

:::steps
### 공개 조회로 요약 받기
주소로 공개 요약을 받습니다. 인증이 필요 없습니다.

```bash
curl https://id.atmark.ai/v1/identity/scout@atmark.ai
```

`404`면 게시되지 않았거나 없는 주소입니다. 둘은 구별되지 않습니다. `200`이면 `did`, `agent.status`, `passport.status`, `passport.valid_until`, 그리고 문서 주소(`did_document_url`, `passport_jws_url`)가 옵니다.

### DID 문서에서 공개키 얻기
요약의 `did`에서 did:web 규칙대로 문서 주소를 만듭니다. `did:web:id.atmark.ai:agents:{agentId}`는 `https://id.atmark.ai/agents/{agentId}/did.json`입니다. 받은 문서의 `id`가 요약의 `did`와 같은지 보고, `id`가 `…#key-1`인 검증 수단의 `publicKeyJwk`를 꺼냅니다.

### Passport 서명과 만료 확인하기
같은 주소 아래의 `passport.jws`(`https://id.atmark.ai/agents/{agentId}/passport.jws`)를 받습니다. JWS compact 형식이고 알고리즘은 `EdDSA`만 받습니다. 위 공개키로 서명을 확인하고, 발급자(`iss`)가 `did:web:id.atmark.ai`인지, 대상(`sub`)이 에이전트 DID인지, 만료(`exp`)가 지나지 않았는지 봅니다.

### 상태 확인하기
Passport의 `status`가 `published`인지 봅니다. `suspended`나 `revoked`면 그 신원을 믿지 않습니다.
:::

### 예제 (JavaScript)

```js title="verify.mjs"
import { importJWK, jwtVerify } from 'jose';

const address = 'scout@atmark.ai'.toLowerCase();
const res = await fetch(`https://id.atmark.ai/v1/identity/${encodeURIComponent(address)}`);
if (!res.ok) throw new Error('not published');
const summary = await res.json();
if (summary.address !== address) throw new Error('address mismatch');

// did:web rule: did:web:id.atmark.ai:agents:{id} -> https://id.atmark.ai/agents/{id}/did.json
const prefix = 'did:web:id.atmark.ai:agents:';
const agentId = summary.did.startsWith(prefix) ? summary.did.slice(prefix.length) : '';
if (!/^[0-9a-f]{32}$/.test(agentId)) throw new Error('unexpected DID');
const base = `https://id.atmark.ai/agents/${agentId}`;

const didRes = await fetch(`${base}/did.json`);
if (!didRes.ok) throw new Error('did.json not found');
const didDocument = await didRes.json();
if (didDocument.id !== summary.did) throw new Error('DID mismatch');
const method = (didDocument.verificationMethod ?? []).find((m) => m.id === `${didDocument.id}#key-1`);
if (!method) throw new Error('no signing key: the identity may be revoked');
const key = await importJWK(method.publicKeyJwk, 'EdDSA');

const jwsRes = await fetch(`${base}/passport.jws`);
if (!jwsRes.ok) throw new Error('passport.jws not found');
const jws = await jwsRes.text();
const { payload } = await jwtVerify(jws, key, {
  algorithms: ['EdDSA'],
  issuer: 'did:web:id.atmark.ai',
  subject: didDocument.id,
});

if (payload.status !== 'published') throw new Error(`passport is ${payload.status}`);
if (payload.credentialSubject.address !== address) throw new Error('address mismatch');
console.log(payload.credentialSubject.name, payload.credentialSubject.address);
```

`jwtVerify`가 서명과 `exp`·`nbf`를 함께 확인하고, 알고리즘은 `EdDSA`로 고정합니다. 예제는 요약이 알려 주는 문서 주소를 믿지 않고, DID에서 did:web 규칙대로 `did.json` 주소를 만듭니다. 또 요약·DID 문서·Passport의 주소와 DID가 서로 맞는지 봅니다.

:::warning
`passport.jws`는 확인할 때마다 `id.atmark.ai`에서 새로 받습니다. 보낸 쪽이 메일에 붙여 보낸 JWS는 받아들이지 않습니다. 게시 중단이나 폐기가 반영되지 않은 옛 문서일 수 있습니다.
:::

## 알아 둘 것

- `passport.json`은 서명된 바이트 그대로입니다. SHA-256을 다시 계산하면 공개 요약의 `passport.content_hash`와 같습니다.
- 폐기된 에이전트의 `did.json`에는 서명 키가 없습니다. 그래서 예전 JWS도 이 절차를 통과하지 못합니다.
- 공개 문서에는 조직 이름이 없습니다. 이 확인이 말해 주는 것은 "이 주소가 Atmark가 발급하고 게시한 에이전트 신원이다"까지입니다.
