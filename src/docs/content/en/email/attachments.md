---
title: Send files as attachments
nav_title: Sending attachments
description: Your agent uploads PDF, PNG, JPEG, or text files, then attaches them to new mail and replies. Every upload must pass a malware scan first.
keywords: [attachment, send a file, file upload]
group: email
order: 6
feature: attachments
updated: 2026-09-28
related: [api/attachments, email/sending, plans/plans-and-limits]
---
The agent uploads the file first, then puts the attachment ID it got back into the email. An uploaded file is attached only after it passes a **malware scan**.

## Files you can send {#types}

| Kind | `mime_type` | File name ends in |
|---|---|---|
| PDF | `application/pdf` | `.pdf` |
| PNG image | `image/png` | `.png` |
| JPEG image | `image/jpeg` | `.jpg` · `.jpeg` |
| Text | `text/plain` | `.txt` (up to 1 MB, UTF-8) |

- The file content has to match the declared kind. A file that's only named `.pdf` is refused.
- Up to 10 attachments per email. The plan sets the attachment size per email. [Plans and limits](/plans/plans-and-limits)
- Attachments go on new mail and replies only. Forwards and scheduled mail can't carry them.

## How it works {#flow}

:::steps
### Get an upload slot
The agent sends the file name, type, size, and SHA-256 to `POST /v1/attachments`. The response has an attachment ID and an upload address.

### Upload the file
Upload the file's bytes to that address as they are. The upload address works once, for 15 minutes.

### Wait for the scan
The upload is scanned for malware right away. It usually takes a few seconds.

### Attach and send
Put the attachment ID in a new email (`send_email`) or a reply (`reply_email`). If the scan isn't done yet, the result is `attachment_scan_pending`. Make the same call again a little later.
:::

Every request and response field is in the [Attachments API](/api/attachments).

## Agents connected over MCP {#mcp}

The MCP tools `send_email` and `reply_email` take `attachment_ids`. Uploading is done with the HTTP API, not an MCP tool. Use the same agent token; it needs the **Send** scope.

## When it's refused {#rejections}

| Result | Meaning | What to do |
|---|---|---|
| `attachment_scan_pending` | The scan isn't finished. | Send the same request again shortly. |
| `attachment_malicious` | Malware was found. | That file can't be sent. |
| `attachment_expired` | It's been more than 2 days since the upload. | Upload it again. |
| `attachment_bytes_exceeded` | The attachments add up to more than the per-email limit. | Make the files smaller or split them across emails. |
| `attachment_daily_limit` | The agent hit its daily upload limit (100 files or 200 MB per 24 hours). | Upload again later. |

Every error code is in the [Attachments API](/api/attachments#errors).

:::note
Mail with attachments passes the same sending policy. If a recipient is blocked, it doesn't go out, attachments or not. Mail that needs approval goes out with its attachments once a person approves it.
:::
