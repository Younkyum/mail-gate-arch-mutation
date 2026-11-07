---
title: Security commitments
description: How Atmark handles tokens, policies, sending, received mail, and identities, as promised to you.
group: security
order: 1
updated: 2026-10-15
related: [security/watch, connect/tokens, email/emergency-stop, connect/untrusted-mail]
---
## Tokens and keys

- Agent tokens and organization API keys are shown **only once**, when issued. Atmark can't show them to you again either.
- Lists show only the last four characters.
- If a token leaks, you can rotate or revoke just that one.
- Tokens are only accepted in a header, never in a URL or request body.

## The owner's policy

- Only owners and admins change the policy, in the console. An agent token can't touch the policy or billing; it can only [ask for a list or mode change](/email/allow-block-lists#requests), which changes nothing until an owner or admin approves it. It can create agents only if the owner turns on [self-enrollment](/security/watch#self-enroll) and grants that token the scope, and those agents start locked down.
- New agents start in outbound mode **All**, so you can try them right away. Once you know who an agent writes to, narrow it to an allowlist. In any mode, a send to a new recipient right after the agent reads suspicious mail waits for your approval.

## Sending

- Every send, over MCP or REST, passes one gate. The gate checks the suppression list, sending limits, and the owner's policy.
- One emergency stop halts sending for a single agent or the whole organization, right away.
- Decisions and console actions are recorded, and you can review them in the console logs.

## Received mail {#received}

- Every received email is checked for prompt injection before the agent can see it. Flagged mail gets one of two levels. **Block** mail is always held from the agent, the owner is always notified, and it waits until the owner releases it. **Risk** mail is delivered or held, as the owner chooses for each agent. See [Watch](/security/watch).
- After an agent reads Risk mail or mail the owner released, its sends to new recipients need the owner's approval. So do sends carrying credentials, codes it received, or copies of received mail. This holds even when detection misses something.
- The owner can require approval for every send an agent makes.
- Mail blocked by the inbound policy isn't bounced; it's held, and the agent can't see it.
- Received mail is handed to the agent marked as outside data, with its `risk.level`. See [Treat received mail as data](/connect/untrusted-mail).
- Webhooks and realtime events never carry the sender, subject, or body. Every webhook request is signed.

### How we measure detection {#measure}

We test the detector on LLMail-Inject, a public set of prompt-injection emails Microsoft released in 2025. The attacks are split by the team that wrote them, and one part is sealed: it was never used to tune the rules and is run only to report results.

On 2026-10-08, with ruleset `2026.10.08-1`, the detector flagged 86,394 of the 155,183 sealed attacks as Risk or Block. On 2,121 normal emails that were also kept out of tuning (public mail collections plus business mail written in seven languages), it flagged 13 as Risk and none as Block.

That means many attacks still get past detection, and detection isn't the only layer. Sends made after reading risky mail wait for the owner, and the owner decides what to release.

## Identity

- Public documents never include your organization's name, list contents, numbers such as limits, or mail.
- The agent's private key never reaches the console either.

If you find a security problem, [let us know](/help/contact).
