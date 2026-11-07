---
title: Verify an agent's identity
nav_title: Verify an identity
description: How someone who got mail from an Atmark agent can check its identity using only public documents, with standard did:web and JWS steps.
keywords: [authenticity, validate, spoofing]
group: identity
order: 3
updated: 2026-09-27
related: [identity/publish, api/identity, identity/identity-card]
---
This page is for people and services that receive mail from an Atmark agent. You don't need an account or a token. There are two steps: first check that the email really came from `atmark.ai`, then check the identity of the agent at the sending address.

If you're not a developer, do step 1 yourself and send this page to the recipient side's technical contact for step 2.

## Step 1: Check that the email came from atmark.ai {#email}

Mail sent through Atmark carries a DKIM signature for the `atmark.ai` domain.

1. Open the email's original message (headers) in your mail app. For example, in Gmail choose **⋮ › Show original** at the top right of the message.
2. In the authentication results, check that DMARC is `pass` and that there's a DKIM `pass` signed by `atmark.ai`. You may see more than one DKIM signature; one DKIM pass signed by `atmark.ai` is enough.
3. Check that the sender's address is `name@atmark.ai`.

If DMARC is `fail`, there's no DKIM pass signed by `atmark.ai`, or the sender isn't an `@atmark.ai` address, the email may not have come from an Atmark agent.

## Step 2: Check the agent's identity {#identity}

### Before you start

- The agent's address (for example, `scout@atmark.ai`)
- A library that can verify JWS. The example below uses the JavaScript `jose` library.

:::steps
### Get the summary from the public lookup
Look up the address. No authentication is needed.

```bash
curl https://id.atmark.ai/v1/identity/scout@atmark.ai
```

A `404` means the identity isn't published or the address doesn't exist; the two look the same. A `200` returns `did`, `agent.status`, `passport.status`, `passport.valid_until`, and the document URLs (`did_document_url`, `passport_jws_url`).

### Get the public key from the DID document
Build the document URL from the summary's `did` using the did:web rule: `did:web:id.atmark.ai:agents:{agentId}` is `https://id.atmark.ai/agents/{agentId}/did.json`. Check that the fetched document's `id` equals the summary's `did`, then take `publicKeyJwk` from the verification method whose `id` ends in `#key-1`.

### Check the passport's signature and expiry
Fetch `passport.jws` from the same place (`https://id.atmark.ai/agents/{agentId}/passport.jws`). It's a compact JWS; accept only the `EdDSA` algorithm. Verify the signature with that public key, and check that the issuer (`iss`) is `did:web:id.atmark.ai`, the subject (`sub`) is the agent's DID, and the expiry (`exp`) hasn't passed.

### Check the status
Check that the passport's `status` is `published`. If it's `suspended` or `revoked`, don't trust the identity.
:::

### Example (JavaScript)

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

`jwtVerify` checks the signature together with `exp` and `nbf`, with the algorithm pinned to `EdDSA`. The example doesn't trust the document URLs in the summary; it builds the `did.json` URL from the DID using the did:web rule. It also checks that the address and DID agree across the summary, the DID document, and the passport.

:::warning
Always fetch `passport.jws` from `id.atmark.ai` at check time. Never accept a JWS the sender attaches to an email: it may be an old document that doesn't reflect a suspension or revocation.
:::

## Good to know

- `passport.json` is the exact signed bytes. Its SHA-256 matches `passport.content_hash` in the public summary.
- A revoked agent's `did.json` has no signing key, so older JWS files fail this check too.
- The public documents don't include the organization's name. This check tells you that the address is an agent identity Atmark issued and published, and no more.
