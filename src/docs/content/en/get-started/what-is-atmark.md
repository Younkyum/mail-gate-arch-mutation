---
title: What is Atmark
description: Atmark gives each AI agent a verifiable identity and its own email address, and keeps its mail inside the policy its owner sets.
group: get-started
order: 1
updated: 2026-10-15
related: [get-started/quickstart, get-started/concepts, get-started/beta-and-review, get-started/not-for]
---
Atmark issues AI agents a verifiable identity and an email address. Your agent sends and receives mail as itself, without borrowing a person's account.

## When it fits

- Your agent needs to send and receive mail at its own address, without borrowing a person's account.
- Your agent signs up for or logs in to sites and needs to receive verification codes.
- You want a person to decide who the agent can email, and a record of what went out and what was blocked.
- The people your agent writes to need a way to check that the address really belongs to an agent.

## When it doesn't fit

- You need addresses on your own company domain (`@yourcompany.com`). For now, Atmark only issues `@atmark.ai` addresses.
- You need to change an address later. Addresses can't be changed. Deleting an agent deletes its addresses too.
- You need a mailbox where people read received mail in the console. The console shows records of received mail but doesn't open the body.
- You want to send cold outreach, bulk or marketing mail, or mail people don't expect. See [What Atmark is not for](/get-started/not-for).

## What each agent gets

| Item | What it is |
|---|---|
| Email address | An address like `name@atmark.ai`. You can't change it after the agent is created. |
| DID | A public identifier that points to the agent. Each agent has its own, and because it uses `did:web`, anyone can look it up on the web. |
| Passport | A signed certificate stating the agent's name, address, and status, signed with the agent's key. Recipients use it to check the agent is real. Valid for 90 days. |
| Identity card | Name, address, DID, and status on one card in the console |
| Token | The secret the agent uses to connect over MCP or the REST API |

Once you publish the identity, anyone who gets mail from the agent can check, from public documents alone, that the address belongs to an agent Atmark issued and that it is still valid. See [Verify an agent's identity](/identity/verify).

## What the owner decides

- **Who it can email.** New agents start in outbound mode All. You narrow them to an allowlist once you know who they write to, and the agent can ask you to add someone.
- **Whose mail it sees.** Blocked mail isn't bounced. It's held, and the agent can't see it.
- **When it stops.** One emergency stop halts sending for a single agent or the whole organization.

The agent can read its policy but can't change it. Every send passes one gate that checks the suppression list, sending limits, and the owner's policy.

## Does it cost anything {#cost}

Sign-up is by waitlist invitation, and an invited sign-up starts on the Free plan right away. Only organizations an operator invited use the Beta plan for free, and payments aren't open. Monthly prices for the paid plans are on the [pricing page](https://atmark.ai/pricing).

## Can I use it today

Yes. Atmark is in beta. Sign-up is by invitation from the [waitlist](https://atmark.ai/waitlist). Once you sign up from an invitation you're on the Free plan and can create agents and tokens and send email, with no operator review to wait for. See [Plans and operator actions](/get-started/beta-and-review). Limits for each plan are in [Plans and limits](/plans/plans-and-limits), and monthly prices are on the [pricing page](https://atmark.ai/pricing).
