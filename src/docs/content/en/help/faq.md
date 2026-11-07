---
title: FAQ
description: Common questions about what Atmark is, how agents connect, who runs it, and more.
group: help
order: 4
updated: 2026-10-13
related: [get-started/what-is-atmark, help/contact]
---
:::details What is Atmark?
Atmark is a service that issues AI agents a verifiable identity and an email address. Each agent gets a did:web identifier, a passport signed with its own key, and an address like `name@atmark.ai`.
:::

:::details How do I check a did:web identity?
A did:web identity is an identifier you check against a did.json document at a public HTTPS address. Anyone can fetch a published agent's did.json from id.atmark.ai, then verify the signature and expiry of its passport.jws with the key in that document. See [Verify an agent's identity](/identity/verify).
:::

:::details How does an agent connect to Atmark?
Over remote MCP or the REST API. You create its token in the console, and the token is shown once, when you create it. See [Choose how to connect your agent](/connect/overview).
:::

:::details Can an agent email anyone it wants?
No. The owner decides who an agent can email. New agents start in outbound mode All so you can try them right away; narrow them to an allowlist once you know the recipients. Every send passes one gate that checks the suppression list, sending limits, the owner's policy, and the risk hold, which holds a send to a new recipient right after the agent reads suspicious mail.
:::

:::details Can I use Atmark today?
Yes. Atmark is available today as a beta service. Sign-up is by invitation from the [waitlist](https://atmark.ai/waitlist). Once you sign up from an invitation you're on the Free plan and can create agents and tokens and send email, with no operator review to wait for.
:::

:::details Does it cost anything?
An invited sign-up starts on the Free plan right away. Only organizations an operator invited use the Beta plan for free, and payments aren't open. Monthly prices for the paid plans are on the [pricing page](https://atmark.ai/pricing).
:::

:::details Can I change an agent's address?
No. The address can't be changed after the agent is created. If you need a different address, create a new agent.
:::

:::details Can I delete an agent?
Yes. Choose **Delete agent** at the bottom of Overview. It can't be undone: its tokens are revoked and it stops sending and receiving. Received mail and records are kept. After 30 days, another organization can take its address. See [Deleting an agent](/agents/disable-delete#delete).
:::

:::details I lost a token's value.
You can't see it again. Choose **Rotate** in the ⋯ menu on the Tokens screen to get a new token with the same name and scopes. See [Rotate a token](/connect/tokens#rotate).
:::

:::details Is there an approval inbox in the console?
No. Approvals happen from the link in the email sent to the primary owner. The four current outbound modes never ask for approval; anyone off the list is simply blocked. See [Approvals](/email/approvals).
:::

:::details Who runs Atmark?
Atmark is a service operated by SHAKA (Younkyum Jin). Questions go to support@atmark.ai.
:::
