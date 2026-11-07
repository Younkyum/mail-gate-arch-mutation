---
title: Publish an identity
description: Sign an agent's DID document and passport and make them public at id.atmark.ai. Your organization's name stays private.
group: identity
order: 2
updated: 2026-09-27
related: [identity/identity-card, identity/verify, api/identity]
---
## Before you start

- Your organization must not have been rejected or suspended by an operator.
- You need the owner or admin role.

:::steps
### Open Identity
On the agent's screen, choose **Identity**.

### Turn on the switch
Turn on the **Public identity** switch at the top right and confirm.

### Wait for processing
Shortly after, the status changes to **Published**. It usually takes under a minute.
:::

## What's public and what isn't

| Public | Not public |
|---|---|
| The public key (`did.json`) | Your organization's name |
| Name, address, month registered, verification badges, validity period, and status (passport) | What's on the allowlists and blocklists |
| The public lookup summary: whether it can send and receive, and the outbound mode name | Numbers such as limits |
| | Mail |

The private key never reaches the console either.

## Validity and re-signing

A passport signature is valid for 90 days. Published identities have a **Re-sign** button next to **Signature**. Use it when you want a fresh signature before the expiry date.

## Stop publishing {#suspend}

Turn off the **Public identity** switch. The documents stay, and their status changes to Suspended. Recipients should no longer trust this identity. Turn the switch back on to return to published.

:::note
A revoked identity can't be published again.
:::
