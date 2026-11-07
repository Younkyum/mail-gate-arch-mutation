---
title: Plans and operator actions
nav_title: Plans and operator actions
description: Sign-up is by waitlist invitation, and you start on Free right away. Only operators grant Beta, and they can reject or suspend an organization.
group: get-started
order: 4
updated: 2026-10-13
related: [get-started/quickstart, plans/plans-and-limits, help/contact]
---
Sign-up is by waitlist invitation. Add your address to the [waitlist](https://atmark.ai/waitlist) and we email you an invitation when we can let you in, valid for 14 days. An address that tries to sign up without an invitation is added to the waitlist. When you sign up from an invitation, your organization is active right away and starts on the **Free** plan. You don't wait for an operator to approve it again. Create an agent and it can email right away; narrow it to an allowlist once you know who it writes to.

## What you can send on Free

- 3 agents
- 100 recipients a day for the organization
- 5 emails a minute per agent

The organization's daily recipient limit ramps up to this value over about two weeks after the first send. The full table is in [Plans and limits](/plans/plans-and-limits).

## Only operators grant Beta

You can't get Beta by signing up or by paying. An operator grants it directly, to organizations they invite. Organizations that already have Beta keep it.

## If an operator rejects or suspends your organization

An operator can reject or suspend an organization. When that happens, its agents can't email outside addresses, and you can't release them from the console.

- If the banner at the top of the console says sign-up wasn't approved, an operator rejected the organization. Sends come back `denied` with the reason `org_review_rejected`.
- Organizations that signed up earlier and are still waiting for operator review show an "under operator review" banner, and sends come back with the reason `org_pending_review`. New sign-ups don't go through this state.

You can also see the status under **Review status** in **Settings › General**. If you think a decision is a mistake, [contact support](/help/contact) with your organization name and owner address.
