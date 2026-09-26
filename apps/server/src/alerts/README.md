# alerts

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.7

## Owns

The SMS template, sending via Twilio, and delivery status tracking.

## Input

`alert.triggered` events, plus the call's `Guardian` (name + E.164 phone).

## Output event

`alert.sent` — `status: "sent" | "failed"`, with the Twilio message SID or an error
message.

## SMS template (keep under ~300 characters)

```
⚠️ Guardian Loop: possible scam call (risk 82).
"Buy the gift cards and don't tell your daughter."
Why: payment in gift cards + secrecy request.
Live view: https://<host>/call/<callId>
```

Pull the quoted snippet and reason straight from `AlertTriggered.snippet` /
`AlertTriggered.reason` — don't regenerate them here.

## Done when

A manually published `alert.triggered` event sends a real text to a verified test
number and emits `alert.sent` with the correct status.
