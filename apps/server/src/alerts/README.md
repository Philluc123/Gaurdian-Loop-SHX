# alerts

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.7

## Owns

The notification template, sending via the notification provider, and delivery
status tracking.

## Interface (stateless async function — no side effects beyond sending one notification)

```ts
function sendAlert(alert: AlertTriggered, guardian: Guardian): Promise<AlertSent>;
```

The orchestrator calls this on `alert.triggered` with `CallState.guardian` and
publishes the returned `alert.sent`. This module does not touch the event bus.

## Input

`alert.triggered` events, plus the call's `Guardian`. The provider's `send`
receives the `Guardian` with the notification and resolves which device(s) to
deliver to.

## Output event

`alert.sent` — `channel: "notification"`, `status: "sent" | "failed"`, with the
provider's message ID or an error message. `"sent"` means the provider accepted the
notification, not that the guardian's device displayed it; delivery receipts are out
of scope for now.

## Configuration

- `PUBLIC_BASE_URL`: host for the live-view link. If unset, the notification has no
  tap-through `url`.
- Tests inject a fake provider with `createAlerter({ send })`, so they need no account.
- **Notification provider not chosen yet:** the default `send` fails every alert with
  "notification provider not configured". Replace `defaultSend` in `index.ts` with
  the provider's client once one is picked.

## Failure handling

`sendAlert` never throws. Timeouts (~5s per attempt), network errors, 429 and 5xx are
retried once; anything else (e.g. 4xx) fails immediately. A retry after a timeout can
in rare cases send a duplicate notification. We accept that, because a duplicate is
better than a missed alert.

## Notification template (body under ~180 characters)

```
Title: ⚠️ Possible scam call (risk 82)
Body:  "Buy the gift cards and don't tell your daughter."
       Why: payment in gift cards + secrecy request.
Tap:   https://<host>/call/<callId>
```

Pull the quoted snippet and reason straight from `AlertTriggered.snippet` /
`AlertTriggered.reason` — don't regenerate them here. The quote is the most recent
caller turn in `snippet` (or the last turn if the caller has none). If the body runs
over 180 characters (about what a lock screen shows), the quote is trimmed first,
then the reason. The title and link are never cut.

## Done when

A manually published `alert.triggered` event sends a real notification to a test
guardian's device and emits `alert.sent` with the correct status.
