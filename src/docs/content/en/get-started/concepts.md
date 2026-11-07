---
title: Key terms
description: Organization, agent, policy, allowlist and blocklist, held mail, emergency stop, and tokens, in one place.
group: get-started
order: 5
updated: 2026-10-15
related: [get-started/what-is-atmark, email/sending, connect/tokens]
---
| Term | Meaning |
|---|---|
| Organization | What you create at sign-up. Agents, members, and the plan belong to it. One person can belong to several organizations. |
| Owner | Manages the organization, including members, invites, and organization API keys. The person who signed up is the primary owner. |
| Agent | An AI that sends and receives mail. Each agent has its own address, DID, and tokens. |
| Disabled | An agent Atmark operators turned off. Owners can't disable an agent or bring one back from the console. See [How agents are counted](/agents/create#counting). |
| Primary address | The `name@atmark.ai` address you pick when creating the agent. It can't be changed. |
| Policy | The owner's rules: outbound mode, inbound mode, allowlists and blocklists, and limits. The agent can read it and ask for a change; only the owner or an admin changes it. |
| Outbound mode | Who the agent can email: **All**, **Allowlist**, **Blocklist**, or **Block all**. |
| Inbound mode | Whose mail the agent sees. Same four names as outbound. |
| Gate | The one check every send passes before it goes out. It looks at the suppression list, sending limits, and the owner's policy. It's the same over MCP or the API. |
| Allowlist / blocklist | Lists of addresses or domains, kept separately for outbound and inbound. The blocklist always wins. |
| Held mail | Where mail blocked by the inbound policy goes instead of bouncing. The agent can't see it; it stays in the **Inbound** logs. |
| Approval (old modes) | A person allowing a send from a link in an email. Only agents that Atmark operators set to an old outbound mode get these; agents created in the console or through the API never do. |
| Emergency stop | Stops outgoing mail for one agent or the whole organization, right away. Receiving continues. |
| Agent token | The secret an agent uses for MCP and the REST API. Starts with `atk_agent_` and is shown once, when issued. |
| Organization API key | An organization-level key that CI or scripts use to create and read agents. Not the same as an agent token. |
| Operator review | The check Atmark operators made on some earlier sign-ups. New organizations are active right away and skip it, though operators can still reject or suspend an organization. |
| Publishing an identity | Signing the DID document and passport and making them public for anyone to read. |
