---
title: Attachment upload API
nav_title: Attachments API
description: Get an upload slot with POST /v1/attachments, upload the file, then put the attachment ID in attachments on new mail and replies.
group: api
order: 3
feature: attachments
updated: 2026-10-08
related: [email/attachments, api/messages, api/errors]
---
Attaching takes three steps: create an upload slot, upload the file, and send the email with the ID. Uploading needs the **Send** (`messages:send`) scope too. An `Idempotency-Key` header is optional here.

- **With a key**, repeating the same request returns the same attachment ID and a freshly signed upload address (`200`, `replayed: true`). It doesn't create a new attachment or count toward the daily limit. The same key with a different request gives `409 idempotency_key_reused`. Once the attachment has expired, its key gives `409 attachment_expired`; use a new key.
- **Without a key**, every call creates a new attachment ID.

## Create an upload slot {#create}

```http
POST /v1/attachments
```

| Field | Required | Description |
|---|---|---|
| `agent_id` | No | Defaults to the token's agent. If given, it must be the token's agent ID. |
| `filename` | Yes | The file name recipients see. 1–255 characters. The ending must match the type. With no dot, the matching ending is added. |
| `mime_type` | Yes | `application/pdf` · `image/png` · `image/jpeg` · `text/plain` |
| `bytes` | Yes | File size in bytes |
| `sha256` | Yes | The file's SHA-256, 64 lowercase hex characters |

```bash
curl -sS https://api.atmark.ai/v1/attachments \
  -H "Authorization: Bearer $ATMARK_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "report.pdf",
    "mime_type": "application/pdf",
    "bytes": 48213,
    "sha256": "9f86…0a08"
  }'
```

```json title="Example 201 response"
{
  "replayed": false,
  "attachment_id": "3b0c…9e21",
  "filename": "report.pdf",
  "expires_at": "2026-09-30T09:00:00.000Z",
  "upload": {
    "method": "PUT",
    "url": "https://…",
    "headers": { "…": "…" },
    "expires_at": "2026-09-28T09:15:00.000Z"
  }
}
```

- `filename` is the name that was stored. If an ending was added, you get the name with it.
- `expires_at` (the attachment) is 2 days out. Send before then.
- `upload.expires_at` (the upload address) is 15 minutes out.

## Upload the file {#upload}

Send the file's bytes to `upload.url` with `upload.method`. Include **every header in `upload.headers`, unchanged**. The upload is refused if the size or SHA-256 differs from what you declared, or if you upload to the same address twice. Don't put the agent token on this request.

```js title="Node.js example"
const res = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: fileBytes });
if (!res.ok) throw new Error(`upload failed: ${res.status}`);
```

The malware scan starts as soon as the upload finishes. It usually takes a few seconds. There's no separate notice; sending tells you the result.

## Attach to an email {#attach}

Add `attachments` to the body of a [new email](/api/messages#send) or a [reply](/api/messages#reply).

| Field | Required | Description |
|---|---|---|
| `attachments` | No | An array of attachment IDs. Up to 10, each ID once. Attached in order. |

```json
{ "from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "Report", "text": "See the attachment.", "attachments": ["3b0c…9e21"] }
```

- If the scan isn't done, you get `409 attachment_scan_pending`. No message is created, so send again shortly **with the same `Idempotency-Key`**.
- One attachment can go on several emails (up to 50 per attachment).
- Forwards (`/forward`) and scheduled mail don't take `attachments`. Including it returns `400 attachments_not_supported`.

## Errors {#errors}

When creating an upload slot:

| Status | `error` | Meaning |
|---|---|---|
| `400` | `invalid_request` | A field is missing or malformed. |
| `400` | `attachment_type_not_allowed` | That `mime_type` isn't accepted. |
| `400` | `attachment_filename_extension_mismatch` | The file name's ending doesn't match `mime_type`. |
| `400` | `attachment_filename_invalid` | The file name contains a form that isn't allowed. |
| `400` | `attachment_too_large` | One file is bigger than the per-email attachment limit. `text/plain` is limited to 1 MB. |
| `403` | `agent_not_active` · `organization_not_sending` | This agent or organization can't send right now. |
| `429` | `attachment_daily_limit` | The agent hit its daily limit (100 files or 200 MB per 24 hours). |
| `409` | `idempotency_key_reused` | The `Idempotency-Key` was used for a different upload. |
| `409` | `attachment_expired` | The attachment made with this `Idempotency-Key` has expired. Use a new key. |
| `429` | `attachment_org_daily_limit` | The organization hit its daily limit (1 GB per 24 hours). |

When attaching to an email:

| Status | `error` | Meaning |
|---|---|---|
| `400` | `attachment_malicious` | Malware was found. That file can't be sent. |
| `400` | `attachment_scan_failed` | The scan couldn't finish. Upload the file again. |
| `400` | `attachment_integrity_mismatch` | The uploaded file's size or SHA-256 differs from what you declared. |
| `400` | `attachment_content_mismatch` | The content isn't the declared type. |
| `400` | `attachment_bytes_exceeded` | The attachments add up to more than the per-email limit. |
| `400` | `attachment_type_not_allowed` | This agent's policy doesn't allow that type. |
| `404` | `attachment_not_found` | It doesn't exist or belongs to another agent. |
| `409` | `attachment_scan_pending` | Still scanning. Send the same request again shortly. |
| `409` | `attachment_not_uploaded` | The file hasn't been uploaded yet. |
| `409` | `attachment_expired` | It's been more than 2 days since the upload. Upload it again. |
| `409` | `attachment_link_limit` | This attachment is already on 50 emails. Upload it again. |
| `503` | `attachment_check_timeout` | Checking took too long. Send again with the same `Idempotency-Key`. |

When you get an attachment error, the email doesn't go out.
