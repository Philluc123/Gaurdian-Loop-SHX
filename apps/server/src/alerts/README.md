# alerts

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.7

## Owns

The SMS template, sending via Twilio, and delivery status tracking.

## Interface (stateless async function — no side effects beyond sending one SMS)

```ts
function sendAlert(alert: AlertTriggered, guardian: Guardian): Promise<AlertSent>;
```

The orchestrator calls this on `alert.triggered` with `CallState.guardian` and
publishes the returned `alert.sent`. This module does not touch the event bus.

## Input

`alert.triggered` events, plus the call's `Guardian` (name + E.164 phone).

## Output event

`alert.sent` — `status: "sent" | "failed"`, with the Twilio message SID or an error
message. `"sent"` means the provider accepted the message, not that the handset
received it; carrier delivery callbacks are out of scope for now.

## Configuration

- `GUARDIAN_ALERT_FROM_NUMBER`: the sending number (falls back to `TWILIO_PHONE_NUMBER`).
- `PUBLIC_BASE_URL`: host for the live-view link. If unset, the link line is omitted.
- Tests inject a fake provider with `createAlerter({ send })`, so they need no account.
- **Twilio sender not wired yet:** the default `send` fails every alert with
  "SMS provider not configured" until the Twilio integration branch lands. Replace
  `defaultSend` in `index.ts` with the Twilio client.

## Failure handling

`sendAlert` never throws. A missing from-number or a non-E.164 guardian phone fails
without sending. Timeouts (~5s per attempt), network errors, 429 and 5xx are retried
once; anything else (e.g. 4xx) fails immediately. A retry after a timeout can in rare
cases send a duplicate text. We accept that, because a duplicate is better than a
missed alert.

## SMS template (keep under ~300 characters)

```
⚠️ Guardian Loop: possible scam call (risk 82).
"Buy the gift cards and don't tell your daughter."
Why: payment in gift cards + secrecy request.
Live view: https://<host>/call/<callId>
```

Pull the quoted snippet and reason straight from `AlertTriggered.snippet` /
`AlertTriggered.reason` — don't regenerate them here. The quote is the most recent
caller turn in `snippet` (or the last turn if the caller has none). If the body runs
over 300 characters, the quote is trimmed first, then the reason. The header and link
are never cut.

Note: the ⚠️ emoji makes Twilio send the text as UCS-2, at 70 characters per
segment, so a message near 300 characters is billed as about 5 segments.

## Done when

A manually published `alert.triggered` event sends a real text to a verified test
number and emits `alert.sent` with the correct status.
