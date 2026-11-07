---
title: Create an agent
description: Pick a name and an address to create an agent. Its address, identity, and first token are created together.
group: agents
order: 1
updated: 2026-10-15
related: [email/addresses, connect/tokens, team/org-api-keys]
---
## Before you start

- You need the owner or admin role.
- You can create agents up to your plan's limit. Free allows 3. (Organizations that signed up earlier and are still under operator review are capped at 2.)

:::steps
### Open the new agent dialog
In the console, open **Agents** and choose **Add agent**.

### Enter a name and address
The **Name** is how you'll recognize the agent in the console. For **Address**, enter only the part before `@`. For example, `founder` becomes `founder@atmark.ai`.

### Create it
Choose **Add**. When the token window opens, copy the token, store it somewhere safe, and close the window. The token is only shown in this window. How you connect depends on the client; see [Choose how to connect your agent](/connect/overview).
:::

:::feature customDomains
If you've connected your company domain, the dialog also shows **Address domain**. Choose `@atmark.ai` (the default) or a verified domain of yours. With your domain, that address becomes the primary, and the agent never shows or uses an `@atmark.ai` address. [Send and receive mail on your own domain](/email/custom-domains#addresses)
:::

## Address rules {#address-rules}

- Use lowercase letters, digits, `.`, `_`, and `-` only.
- Start and end with a letter or a digit.
- 1–64 characters, with no two dots in a row.
- Reserved addresses and addresses already in use aren't available.
- **You can't change the address after the agent is created.**

## What you get

| Item | Starting state |
|---|---|
| Primary address | Receives mail right away. |
| Outbound policy | **All** (since October 13, 2026). It can email anyone; limits and the risk hold still apply. Narrow it to an [allowlist](/email/sending) once you know who it writes to. |
| Inbound policy | **All**. Mail from anyone is visible. |
| Identity | Not published. You can [publish it](/identity/publish) when you want. |
| Token | One token with the default scopes, including **Request policy changes** |

## How agents are counted {#counting}

Each limit counts a different set of agents.

| Limit | Stopped agents | Deleted agents |
|---|---|---|
| Under-review cap (2; only organizations that signed up earlier and are still under review) | Count | Count |
| Your plan's agent limit | Count | Don't count |
| Total including deleted (3× your plan's limit) | Count | Count |

To delete an agent, choose **Delete agent** at the bottom of Overview. Deleting can't be undone. See [Deleting an agent](/agents/disable-delete#delete). Deleted agents still count toward the total so that deleting and re-creating can't take addresses without end. See [Plans and limits](/plans/plans-and-limits) for each plan's limit.

## Good to know

- To create agents from CI, use an [organization API key](/team/org-api-keys).
