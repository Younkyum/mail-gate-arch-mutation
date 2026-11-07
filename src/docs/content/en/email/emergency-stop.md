---
title: Stop sending with an emergency stop
nav_title: Emergency stop
description: Stop outgoing mail for one agent or your whole organization, right away. Receiving and reading continue.
keywords: [pause, halt, stop sending]
group: email
order: 9
updated: 2026-09-27
related: [agents/disable-delete, connect/tokens, team/settings]
---
:::warning If a token leaked, revoke it instead
An emergency stop doesn't revoke tokens. During the stop, a leaked token can still read received mail, and after you resume it can send again. [Revoke that token](/connect/tokens#leak).
:::

## Before you start

- Owners and admins can stop sending. Only owners can **resume** a whole-organization stop.

## What stops

| Stops | Keeps working |
|---|---|
| New mail, replies, and forwards | Receiving mail |
| Sending approved mail (old outbound modes) | Reading received mail |
| Scheduled mail | Viewing and changing settings in the console |

Mail blocked during the stop doesn't go out automatically when you resume.

## Stop one agent {#agent}

:::steps
### Open Overview
Open the agent's **Overview** and scroll to the **Emergency stop** row at the bottom.

### Stop
Choose **Stop** and confirm.
:::

To resume, choose **Resume** in the same place. Sending follows the policy again. An agent that Atmark operators put on hold can't be resumed from the console; [contact support](/help/contact).

## Stop the whole organization {#org}

:::steps
### Open Settings
Go to **Settings › Emergency stop**.

### Stop everything
Choose **Stop the whole organization** and confirm. A banner at the top of every screen says emergency stop is on for the whole organization.
:::

![The emergency stop screen in Settings](shot:settings-pause)

To resume, an owner chooses **Resume** under **Settings › Emergency stop**. Admins can turn on a whole-organization stop but can't lift it.


## Operator freeze

If a banner says Atmark operators froze sending for your organization, an operator stopped it. Resuming from your side won't lift it. [Contact support](/help/contact).
