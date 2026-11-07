---
title: Add and delete alias addresses
nav_title: Alias addresses
description: Give an agent more addresses besides its primary one. Mail to an alias lands in the same inbox, and your organization can re-create a deleted alias.
keywords: [alias, secondary address, extra address]
group: email
order: 1
feature: aliases
updated: 2026-09-29
related: [email/addresses, email/receiving, plans/plans-and-limits]
---
An alias is an extra address an agent uses alongside its [primary address](/email/addresses). Add `sales@atmark.ai` to the `scout@atmark.ai` agent, for example, and mail to either address reaches that agent.

## What an alias does {#what}

- **Receiving**: mail to an alias passes the same inbound policy as mail to the primary address and lands in the same inbox.
- **Sending**: the agent can put an alias in `from`. A reply to mail that arrived at an alias goes out from that alias unless told otherwise.
- **Private**: aliases don't appear on the passport or in public lookups. The only address people outside can look up is the primary one.

Sending policy, limits, and approval rules belong to the agent, not the address. They're the same whichever address you send from.

## Before you start

- Adding or deleting an alias takes the owner or admin role. Members can only see the list.
- How many aliases an agent can have depends on the plan. The Free plan has none. See [Plans and limits](/plans/plans-and-limits).

## Add an alias {#add}

:::steps
### Open the Addresses screen
On the agent's screen, click **Addresses**. The primary address is at the top, and the **Aliases** section below it lists the aliases in use. The number next to it is the current alias count and the plan limit.

### Click Add alias
Click **Add alias** to open a dialog. It shows how many aliases are in use and how many this agent has ever had, deleted ones included.

### Type a name and add it
Type the part before `@` and click **Add**. The naming rules are the same as for the primary address. [Address rules](/agents/create#address-rules)
:::

:::feature customDomains
If you've connected your company domain, choose it under **Domain** in the dialog. Only verified domains are listed. [Send and receive mail on your own domain](/email/custom-domains#addresses)
:::

You can't take an address that someone already uses. An alias deleted in your organization can be re-created right away, on the same agent or another one. An address deleted by another organization becomes available 30 days after it was deleted.

## Delete an alias {#retire}

Click **Delete** next to the alias and confirm. The alias disappears from the list.

:::danger After 30 days, another organization can receive mail sent to this address
Mail to a deleted alias is rejected until it's re-created, and you can't send from it. Your organization can re-create it right away. But after 30 days another organization can take the address and receive mail sent to it, including password-reset and verification mail from services the agent signed up to with it. Before deleting, move those sign-ups to another address.
:::

A re-created alias counts as a new one: it adds to the aliases the agent has ever had and to your organization's daily count.

You can't delete the primary address. If you no longer need it, [stop or delete the agent](/agents/disable-delete).

## Limits {#limits}

| Limit | When you hit it |
|---|---|
| Aliases per agent (plan) | `alias_plan_limit`. Delete an alias you don't use, or upgrade. |
| Aliases an agent has ever had, deleted ones included | `alias_issued_limit`. This agent can't get more aliases. |
| Aliases an organization creates per day, including tries with addresses that are taken or not available right now | `alias_org_daily_limit`. Try again the next day. |

If you move to a smaller plan and an agent has more aliases than the new limit allows, the existing aliases keep receiving mail. You just can't add new ones.
