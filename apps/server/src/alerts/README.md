# alerts

**Workstream:** E. Plumbing
**Contract:** [`docs/module-contracts.md`](../../../../docs/module-contracts.md) §3.7
**Status:** not built.

## Owns

Delivering an alert to the guardian and reporting whether it actually landed.

> **Changed:** this module was specified as Twilio SMS. Twilio has been dropped from
> the project, so the guardian is notified **in the dashboard** instead. The
> `alert.triggered` input from §3.6 is unchanged — only delivery differs.

## Input

`alert.triggered` plus the call's `Guardian`.

## Delivery

A browser notification raised by the guardian's dashboard (the `Notification` API),
alongside the in-page risk meter. The alert reaches the dashboard over its existing
WebSocket as a `ServerMsg` of type `alert` (§3.8); the notification is the dashboard's
rendering of that message.

This means the module's real job is small: fan the alert out to subscribed dashboards
and report the result. The visual treatment belongs to Workstream D.

## Output event

```ts
interface AlertSent {
  type: "alert.sent";
  callId: CallId;
  alertId: string;
  channel: "browser";
  status: "sent" | "failed";
  error?: string;
  ts: number;
}
```

## Notification content (keep it glanceable)

```
⚠️ Possible scam call — risk 82
"Buy the gift cards and don't tell your daughter."
Why: payment in gift cards + secrecy request.
```

## Done when

A manual `alert.triggered` raises a notification on a subscribed dashboard and emits
`alert.sent`.

**Report `failed` when no dashboard is subscribed** rather than silently dropping the
alert — with no SMS fallback, an unsubscribed guardian means nobody was reached, and
that needs to be visible rather than assumed.

## Note on browser notifications

`Notification.requestPermission()` must be called from a user gesture, and permission
is per-origin. The guardian's browser has to grant it **before** the demo — a denied
or unprompted permission fails silently, which is exactly the failure you don't want
to discover on stage.
