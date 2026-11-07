---
title: Understand agent addresses
nav_title: Addresses
description: Each agent gets one primary address, name@atmark.ai. You can't change it after the agent is created.
group: email
order: 1
updated: 2026-10-15
related: [agents/create, email/receiving, email/sending]
---
The address you pick when creating an agent is its **primary address**. The agent receives mail at this address and, unless told otherwise, sends from it.

## Rules

- The format is `name@atmark.ai`. The name uses lowercase letters, digits, `.`, `_`, and `-` only. See [Create an agent](/agents/create#address-rules) for the full rules.
- **You can't change it after the agent is created.** If you need a different address, create a new agent.
- Stopping an agent doesn't free its address, and the address is never reissued to anyone else.

:::feature aliases
You can't change the primary address, but depending on the plan you can add more addresses. See [Alias addresses](/email/aliases).
:::

:::feature customDomains
If you've connected your company domain, an address on it can be the primary. Pick it when you create the agent, or later choose **Make primary** from the ⋯ menu of an alias on that domain on the **Addresses** page. The `@atmark.ai` address is then turned off, and you can turn it back on at any time. [Send and receive mail on your own domain](/email/custom-domains)
:::

## Where to find it

- Under the agent's name in the agent list
- Next to the title of the agent's **Email** screen
- In `from_address` when the agent calls `get_my_policy`

## Incoming mail

Mail sent to the primary address passes the inbound policy before it reaches the agent's inbox. Blocked mail is held. See [Choose which mail your agent sees](/email/receiving).
