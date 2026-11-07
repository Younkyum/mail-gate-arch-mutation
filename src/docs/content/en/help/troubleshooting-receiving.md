---
title: When received mail doesn't show up
description: If your agent can't see mail, the cause is usually the inbound mode and held mail. Start with the Inbound logs.
group: help
order: 3
updated: 2026-10-15
related: [email/receiving, team/logs, email/verification-codes]
---
:::steps
### Check the Inbound tab
In the console, open **Logs › Inbound** and enter the sender's **full address** in **From** (like `name@example.com`; part of an address or a domain alone won't match). If there's a record and it was held, check the reason in its details. For **Held by inbound policy**, follow the steps below. **Held for injection risk** and **Held because the scan failed** have nothing to do with the inbound mode; see [what to do for each reason](/email/receiving#quarantine).

### Check the inbound mode
Look at the **Inbound** column on the agent's **Email** screen.
- **Block all** holds all mail.
- **Allowlist** holds mail from senders not on the list.
- **Blocklist** holds mail from senders on the list.

### Fix the list
Add the sender's address or domain to the allowlist, or remove it from the blocklist. It applies **only to mail that arrives from then on**.

### Ask for a resend
Mail already held by the inbound policy can't be released to the agent from the console. After fixing the list, ask the sender to send it again.
:::

## Held even though it's on the allowlist

The inbound allowlist only matches mail that passed sender domain authentication (DMARC). If the sender's domain fails authentication, the mail is held even if it's on the list. Ask the sender to check their domain authentication setup.

## No record on the Inbound tab either

- Check that the sender typed the address correctly. You can see the primary address in the agent list.
- Ask the sender whether they got a bounce message.

## Verification codes don't arrive

See [Let your agent read verification codes](/email/verification-codes). First make sure the inbound mode doesn't hold the site's mail.
