---
title: Read the logs
nav_title: Logs
description: See what your agents tried to send and the decisions, the mail they received, console actions, and scheduled sends.
group: team
order: 4
updated: 2026-10-15
related: [email/scheduled, help/troubleshooting-sending, help/troubleshooting-receiving]
---
Organization-wide logs are under **Logs** in the sidebar; a single agent's logs are under **Logs** on the agent's screen. Every role can view them.

![The Logs screen](shot:logs)

## Tabs {#tabs}

| Tab | Content |
|---|---|
| Outbound | Mail your agents tried to send, and the gate's decision. Denials are recorded with a policy code. |
| Inbound | Mail sent to your agents' addresses. Held mail is recorded here too. Bodies aren't opened in the console. |
| Console | Console actions in this organization (what, when, target). An audit record that can't be deleted. |
| Scheduled | Scheduled sends and cancellations. Cancelled schedules show their reason and channel. See [Scheduled email](/email/scheduled). |

## Filter

- Filter by **Agent** and **Result**.
- On the **Inbound** tab, you can also filter by **From** (the full address, exact match) and a date range.
- Load new records with **Refresh** and older ones with **Load more**.

## Details

Select a row to open the details on the right. Outbound records show recipients, the decision, reasons, the policy version, and delivery events. Records older than the 1-year retention period have their body deleted.

## When to look

- Mail didn't go out: the result and reason on **Outbound**
- The agent didn't see an email: whether it was held, on **Inbound**
- Who changed a policy or token: **Console**
- The agent cancelled a schedule: the channel and reason on **Scheduled**
