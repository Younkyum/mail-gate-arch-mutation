---
title: Reply and forward
description: A reply goes to the sender by default, from the address that received the email. Forwarding carries the body text only.
group: email
order: 6
updated: 2026-09-27
related: [email/sending, connect/mcp-tools, api/messages]
---
Replies and forwards pass the same gate as new mail. If the outbound policy blocks the recipient, nothing goes out.

## Reply {#reply}

The agent passes the received email's `message_id` and a body to `reply_email`.

| Field | If omitted |
|---|---|
| Recipient | The sender of that email |
| Subject | `Re: original subject` |
| From | The address that received the email, otherwise the primary address |

:::note
In allowlist mode, the person you're replying to must be on the allowlist too.
:::

## Forward {#forward}

The agent passes the received email's `message_id` and the recipients to `forward_email`. A note on top (`note`) is optional.

- Only the **body text** is carried over. Attachments aren't forwarded.
- With no subject, it becomes `Fwd: original subject`.
- Mail that seems to carry instructions aimed at tricking an agent can't be forwarded; the forward is refused with `forward_refused_injection_risk`. If the content matters, the agent writes a new email in its own words.

## No duplicate sends

Calling again with the same arguments sends only once; the second call returns the first result. To send identical content again on purpose, pass a new `idempotency_key`.
