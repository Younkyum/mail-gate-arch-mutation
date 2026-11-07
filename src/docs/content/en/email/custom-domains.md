---
title: Send and receive mail on your own domain
nav_title: Your own domain
description: Connect a subdomain of your company domain that only agents use, and your agents send and receive mail at addresses on it.
keywords: [custom domain, own domain, DNS, DKIM, subdomain]
group: email
order: 1
feature: customDomains
updated: 2026-10-15
related: [email/addresses, email/aliases, agents/create]
---
Connect a subdomain that only your agents use, like `agents.example.com`, and they can send and receive mail at addresses such as `scout@agents.example.com`. Policy, limits, and approval rules apply exactly as they do to `@atmark.ai` addresses.

## Before you start

- This is in beta and open to invited organizations only. If **Settings** in the console has no **Domains** item, it isn't open for your organization yet.
- Adding or removing a domain takes the owner or admin role. Members can only view.
- You need to be able to edit the domain's DNS records. Keep your DNS provider's dashboard open.
- Your plan sets how many domains you can connect: 1 on Beta and Pro, 3 on Team, 10 on Scale, counting domains still waiting for verification. Up to 2 domains can wait for ownership verification at a time.

## Which domain to use {#which-domain}

Use a **new subdomain** that only agents use, so agent mail never mixes with people's mail.

| Domains you can't use | Why |
|---|---|
| A top-level domain (`example.com`) | People may receive mail there. Use a subdomain such as `agents.example.com`. |
| A subdomain that already has another mail server | We won't take over mail that people use. |
| Domains of public mail services | They aren't your company's domain. |
| Domains under `atmark.ai` | Agents get their `@atmark.ai` address when they're created. |
| Internationalized domains (`xn--`), or domains over 100 characters | Not supported yet. |

## Connect a domain {#connect}

:::steps
### Add the domain
In the console, open **Settings**, then **Domains**, and click **Add domain**. Enter the subdomain and click **Add**. The domain's page opens with the DNS records to create.

### Add the ownership record
Add the TXT record from the first card, **Ownership**, at your DNS provider. It's an `_atmark-challenge` record on your top-level domain. Keep it in place after verification.

### Add the mail records
Add the two MX records and one TXT record from the **Receiving and bounces** card. Incoming mail and bounces follow them to Atmark. You can add these while ownership is still pending.

### Add the signing records
Once ownership is verified, three CNAME records appear in the **Signing (DKIM)** card. Add them exactly as shown.

### Wait for verification
Atmark checks on its own: every 30 minutes while ownership is pending, then every 6 hours. To check right after adding records, click **Check now** (once every 60 seconds per domain).
:::

:::tip Enter only the first part as the name
If your DNS provider appends your domain automatically, enter only the **first part** shown in gray under each record as the name. Entering the full name adds the domain twice, and verification fails. Copy values exactly with the copy buttons.
:::

If ownership isn't verified within 72 hours of adding the domain, or signing isn't verified within 72 hours after ownership, the domain is removed automatically. The domain's page shows the **Time left**. If it's removed, fix the records and add it again.

A DMARC record is optional. Add a TXT record `v=DMARC1; p=none` at this domain with `_dmarc.` in front, so receivers know its mail policy. If your top-level domain already has DMARC, that policy covers this subdomain too.

## Statuses {#status}

| Status | Meaning |
|---|---|
| **Pending** | Waiting for the ownership TXT record. |
| **Verifying** | Ownership is verified; the signing and mail records are being checked. |
| **Active** | You can create addresses on this domain and send and receive mail. Once every record checks out, **Ready to receive and send** appears too. |
| **Suspended** | Sending has stopped. See [Suspension](#suspended) for the reason and what to do. |
| **Removed** | No mail is sent or received on it any more. |

## When verification doesn't go through {#pending-reasons}

- **This subdomain already has another mail server**: its MX record points to another mail server. Add a new subdomain just for agents, or change the MX record to the value on the page.
- **This domain can't be verified yet**: another `_atmark-challenge` TXT record added earlier is still on your top-level domain. Delete any `_atmark-challenge` record other than the one on the page, then click **Check now**. If it still fails, [contact support](/help/contact).

## Create addresses on the domain {#addresses}

- **New agents**: pick the domain at the end of the **Address** field in the **Add agent** dialog, and that address becomes the agent's primary address. The agent never shows or uses an `@atmark.ai` address. [Create an agent](/agents/create)
- **Existing agents**: on the agent's **Addresses** page, click **Add alias** and choose the domain. Aliases on your domain count toward your plan's alias limit. [Alias addresses](/email/aliases)
- An agent whose primary is on your domain can still have `@atmark.ai` aliases. They're new aliases, separate from the turned-off `@atmark.ai` primary.
- **Change the primary address**: on the **Addresses** page, open the ⋯ menu on an alias on your domain and choose **Make primary**. The primary address is the one the agent sends from by default and the one its passport and public lookup show. You can change it up to 5 times a day.

New domains start with a small daily sending limit that grows over a few days, so an agent may not be able to send much at first.

## What happens to the @atmark.ai address {#atmark-address}

When an address on your domain becomes the primary, the agent's `@atmark.ai` address is **turned off**. It doesn't appear in the console, the passport, or public lookups, mail to it is rejected, and the agent can't send from it.

You can make it the primary again at any time with **Turn on @atmark.ai address** on the agent's **Addresses** page. For an agent created with your domain as its primary, the address that appears then is a random name starting with `ax--`. It can't be changed.

## Suspension {#suspended}

| Reason | What happened | What to do |
|---|---|---|
| **ownership lost** | The ownership TXT record is missing. No mail is sent or received. | Add the record again exactly as shown, and the domain recovers on its own. If it isn't restored within 14 days, the domain is removed and its addresses are retired. |
| **DKIM failing** | The signing (DKIM) records can't be verified. No mail is sent or received. | Make sure the three CNAME records are in place exactly as shown. Once fixed, the domain recovers on its own. |
| **sending reputation** | Sending stopped because of too many bounces or spam complaints. Incoming mail is still accepted. | [Contact support](/help/contact). |
| **operator hold** | An Atmark operator stopped sending. Incoming mail is still accepted. | [Contact support](/help/contact). |
| **plan limit** | After a plan downgrade, you have more domains than the plan allows. Incoming mail is still accepted. | Upgrade your plan or remove another domain, and sending resumes on its own. |

The organization's owners and admins get an email when a domain is suspended or removed, 3 days before a removal, and when the domain's registration is about to expire.

## Remove a domain {#remove}

At the bottom of the domain's page, under **Remove domain**, click **Remove** and confirm. No mail is sent or received on a removed domain. Delete its DNS records at your DNS provider yourself.

- Addresses on the domain are **kept by default**, and come back if you reconnect the same domain. Choose **Also retire** in the confirmation to retire them now.
- Agents whose primary address is on the domain end up with **no primary address**. They aren't moved to their `@atmark.ai` address automatically. If they have other aliases (an `@atmark.ai` alias or one on another domain), those keep receiving, and the agent can send by putting one in `from`. With no alias at all, they can't send or receive mail.

:::danger Agents with their primary address on this domain lose it
The confirmation shows how many there are. Until you reconnect the domain, or click **Turn on @atmark.ai address** on the agent's **Addresses** page, those agents have no default sending address. Agents without an alias can't send or receive mail.
:::

## Manage domains with the organization API {#org-api}

An [organization API key](/team/org-api-keys) with the `domains:manage` permission can do the same.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/domains` | List domains and the plan limit |
| `POST` | `/domains` | Add. Body `{"domain": "agents.example.com"}` |
| `GET` | `/domains/{domainId}` | One domain and the records to create |
| `POST` | `/domains/{domainId}/check` | Check now (202) |
| `DELETE` | `/domains/{domainId}` | Remove. With body `{"releaseAddresses": true}`, its addresses are retired too |

When creating an agent, add `"domain": "agents.example.com"` to the `POST /agents` body to make an address on that domain its primary.

## Error codes {#errors}

| Code | Meaning |
|---|---|
| `registrable_apex` | It's a top-level domain. Use a subdomain. |
| `shared_mailbox_domain` · `platform_domain` · `idn_label` · `too_long` · `invalid_label` | A domain you can't use (see the table above). |
| `domain_exists` | You've already added this domain. |
| `plan_custom_domains_exceeded` | You've reached your plan's domain limit, including pending domains. |
| `custom_domains_pending_exceeded` | Two domains are already waiting for ownership verification. |
| `domain_add_rate_limited` | You can't add more domains today. |
| `domain_check_rate_limited` | Check now was clicked too often. Try again shortly. |
| `domain_not_verified` | Only verified domains can be used for addresses. |
| `address_is_primary` | An alias that is the primary address can't be deleted. Make another address the primary first. |
| `primary_change_rate_limited` | The primary address can be changed up to 5 times a day. |
| `feature_not_enabled` | Custom domains aren't open for your organization yet. |
