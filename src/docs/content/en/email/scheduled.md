---
title: View and cancel scheduled email
nav_title: Scheduled email
description: Scheduled mail checks the policy again when it's sent. Owners view and cancel it on the Scheduled tab of the console logs.
group: email
order: 7
updated: 2026-09-27
related: [api/scheduled, team/logs, email/emergency-stop]
---
Agents create scheduled mail through the REST API ([Scheduled email API](/api/scheduled)). The MCP tools can't create schedules; they can only list and cancel them.

## Good to know

- The send time must be within 30 days.
- The policy is checked **at send time**. If you change lists or modes in between, the policy at send time applies.
- During an emergency stop, scheduled mail doesn't go out either.
- A schedule that has already been sent can't be recalled.

## View in the console

Open the **Logs › Scheduled** tab. Cancelled schedules show their reason and channel (MCP = the agent's tool, API). The subject and body of scheduled mail aren't opened in the console.

![The Scheduled tab in the logs](shot:logs-scheduled)

## Cancel in the console {#cancel}

Only owners and admins can cancel. This also cancels schedules the agent isn't allowed to cancel.

:::steps
### Find the schedule
In **Logs › Scheduled**, choose **Cancel** on the row. It only appears on rows that are still scheduled.

### Pick a reason
Choose a **Reason**. It's required. A **Note (optional)** can be up to 200 characters.

### Cancel it
Choose **Cancel scheduled email**. This can't be undone and is recorded in the console logs.
:::

## When the agent cancels

The agent cancels with `cancel_scheduled` and a reason code. The reason is kept permanently, and the owner sees it in the logs.

- Make sure the agent never cancels because a received email told it to. Records with the channel MCP were cancelled by the agent itself.
- Schedules the agent isn't allowed to cancel are refused with `schedule_not_agent_cancellable`. The owner cancels them in the console.
- The agent's cancellations are limited per hour (`cancel_rate_limited`).
