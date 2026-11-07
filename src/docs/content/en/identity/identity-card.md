---
title: Read the identity card
nav_title: Identity card
description: The Identity screen shows an agent's name, address, DID, signature, and publishing status at a glance.
group: identity
order: 1
updated: 2026-09-27
related: [identity/publish, identity/verify, agents/overview-screen]
---
Choose **Identity** on the agent's screen. The identity card is on the left and the details are on the right.

![An agent's Identity screen](shot:agent-identity)

## What's on the card

| Field | Content |
|---|---|
| Organization | Your organization's name. **Visible in console only**; it's never put in the public documents. |
| Name · Address | The agent's name and primary address |
| DID | An identifier like `did:web:id.atmark.ai:agents:…`. A signed identity shows a **Signed** mark. |
| Issued · Expires · Version | When the current passport was signed, when it expires, and its version |
| Status | Not published, Published, Suspended, or Revoked |

The card's pattern and color come from the agent's public key, so every agent looks different.

## Details on the right

- **Identifiers**: DID, address, and agent ID, each with a copy button.
- **Signature**: passport status, public key, and JWS fingerprint. Published identities have a **Re-sign** button.
- **Public documents**: links to `did.json`, `passport.json`, and `passport.jws` appear once published.

## What each status means

| Status | Meaning |
|---|---|
| Not published | Not public yet. A public lookup sees it the same as an address that doesn't exist. |
| Published | Anyone can read and check the DID document and passport. |
| Suspended | The documents stay, but their status changes to suspended. Recipients should no longer trust this identity. |
| Revoked | It can't be published again. |
