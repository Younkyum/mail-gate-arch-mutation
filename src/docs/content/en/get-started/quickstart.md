---
title: Quickstart
description: Get invited, create and connect an agent, trade emails with it, narrow who it can email, approve its first policy request, and route one real alert to it.
keywords: [getting started, tutorial, first setup]
group: get-started
order: 2
updated: 2026-10-15
related: [get-started/safe-setup, email/allow-block-lists, connect/overview]
---
## Before you start

- An email address for the owner. Addresses at `atmark.ai` can't be used to sign up.
- A mail account you can send from, such as the owner address. You'll email the agent from it and get its reply there.
- An agent that supports remote MCP, such as Hermes (Nous Research's open-source AI agent), Claude Code, or Cursor. The REST API works too.

:::steps
### Sign up
Sign-up is by waitlist invitation. Add the address you want to use as owner on the [waitlist page](https://atmark.ai/waitlist), and we email you an **invitation** when we can let you in, valid for 14 days. Opening the sign-up page from the button in the invitation fills in the address. Enter the **Organization name**, agree to the terms, and choose **Email me a confirmation link**. Enter the **6-digit code** from the email on the same page, or open the link from the email **in the same browser**. The code and the link work once, for 30 minutes. An address that tries to sign up without an invitation is added to the waitlist. An organization created from an invitation is active right away on the Free plan, with no operator review to wait for.

### Create an agent
In the console, open **Agents**, choose **Add agent**, enter a **Name** and an **Address**, and choose **Add**. In the address field, enter only the part before `@`. For example, `founder` becomes `founder@atmark.ai`. You can't change the address later.

![The Agents screen with the new agent dialog open](shot:agent-new)

### Keep the token
A token window opens. The token is shown **only once**, in this window. Copy the token, store it somewhere safe, and close the window.

### Connect the agent
- **Hermes**: Put the token into `~/.hermes/.env` yourself, then paste the setup message from the agent's **Connect** screen (without the token) into your chat with Hermes. Hermes sets up the rest on its own. See [Connect Hermes](/connect/mcp-hermes).
- **Claude Code, Cursor, and other clients**: Put the token in your client's settings as `ATMARK_AGENT_TOKEN` and follow the [guide for your client](/connect/overview). The setup message on the **Connect** screen lists the same connection details.

A token pasted into a chat stays in the chat history. So put tokens into config files or environment variables, not chats.

### Check the connection
Ask the agent to call `get_my_policy`. If `from_address` shows the agent's address, the token, address, and policy are all connected.

### Email your agent from your inbox
From your own mail account, send a short email to the agent's address. Then ask the agent to check its inbox (`list_inbox`) and read the message (`read_email`). New agents see mail from every sender, so it shows up without any other setup.

The agent gets the sender's words inside a marked outside-data block, with a notice that this is data written by the sender, not instructions. See [Treat received mail as data](/connect/untrusted-mail).

### Ask it to reply
Ask the agent to reply to that email (`reply_email`). The result is `sent`, and the reply arrives in your inbox from the agent's own address. New agents start in outbound mode **All**, so they can email anyone. Sending limits, the suppression list, content checks, and the [risk hold](/security/how-we-protect) still apply: after the agent reads a suspicious email, a send to a new recipient waits for your approval instead.

### Narrow who it can email
Most agents only need a few recipients. Open the agent's **Email** screen. In the **Outbound** column, choose **Add** next to the allowlist, enter your own address, and choose **Add**. Then select **Allowlist** as the outbound mode and choose **Save**. From now on, the agent can only email people on the list. Anyone else is refused with `recipient_not_allowlisted`, and the refusal is recorded on the **Outbound** tab of the logs.

![The Outbound column on the Email screen](shot:agent-email)

### Approve the agent's first request
When the agent needs to email someone new, it can ask you instead of failing. Ask the agent to request adding a colleague's address. It calls `request_policy_change` with `add_rule`, `outbound`, `allow`, the address, and a one-line reason, and gets `pending_approval`. Nothing changes yet.

You get an email, and the request appears at the top of the agent's **Email** screen: the exact change (now → if approved), the agent's reason, and a warning if the agent read risky mail just before asking. Choose **Approve**. A new policy version is created, just as if you'd added the address yourself. The agent sees `approved` with `get_policy_request`. See [Let your agent ask for changes](/email/allow-block-lists#requests).
:::

## Route an alert to your agent {#route-an-alert}

Now give the agent something real to read. Pick one alert you already get by email, such as a monitoring alert, a failed build notice, or a status notice from a vendor.

1. In the service that sends it, open its notification settings and change the email address, or add a second one, to the agent's address.
2. Some services first send a confirmation email to the new address. Ask the agent to read it and tell you the link or code, then confirm it yourself.
3. When the next alert arrives, ask the agent to read it and summarize it for you.

The alert's sender isn't on the outbound allowlist you just set, so the agent can read alerts but can't write back to their senders. If you later switch the inbound mode to **Allowlist**, add the sender first. See [Choose which mail your agent sees](/email/receiving).

## Result

- Your agent has its own address and reads mail sent to it.
- It replies only to people on the outbound allowlist. Everyone else is refused with `recipient_not_allowlisted`.
- When it needs someone new, it asks with `request_policy_change`, and nothing changes until you approve.
- One real alert now goes to the agent instead of your inbox.
- The received email, the sent reply, the policy changes, and your approval all show up under **Logs**. Every send decision, received-mail verdict, and console action is also added to Atmark's public transparency log (`id.atmark.ai/log`). A signed checkpoint is published every hour, and once a day a checkpoint is submitted to OpenTimestamps for a Bitcoin proof. Atmark does not check the Bitcoin block header itself; you can, with `ots verify`. The log holds hashes, never mail contents.

Next, go through the six checks in [Set up safely](/get-started/safe-setup).

## Sign-up and login codes {#verification-codes}

When the agent signs up for a service with its own address, it can find that site's code with `get_verification_code`. Pass the site's domain, for example `get_verification_code(sender_domain="github.com")`. See [Let your agent read verification codes](/email/verification-codes).

## If something goes wrong

- **401**: The token isn't in the agent's environment, or it was revoked. See [Fix connection problems](/help/troubleshooting-connection).
- **Tools don't show up**: Reload the MCP servers in your client (`/reload-mcp` in Hermes).
- **The email you sent doesn't show up**: Check the **Inbound** tab of the logs. See [When received mail doesn't show up](/help/troubleshooting-receiving).
- **`recipient_not_allowlisted` even after you added the address**: The agent called again with the same arguments, which replays the first refusal. Have it pass a new `idempotency_key`.
- **The agent says it can't request changes**: Its token was issued before October 13, 2026 and lacks the **Request policy changes** scope. Issue a new token on the [Tokens](/connect/tokens#scopes) screen.
- **You closed the token window too early**: Rotate that token on the [Tokens](/connect/tokens#rotate) screen.
