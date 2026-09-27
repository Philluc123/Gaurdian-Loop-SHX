# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The **guardian**: a family member watching over an older relative's phone calls. They
open the dashboard when a notification tells them a call looks like a scam, or keep it
open while a call is in progress. Their job is to understand, at a glance, whether the
person they care about is being scammed right now, and why.

## Product Purpose

Guardian Loop listens to a live phone call, transcribes both sides, scores the call for
scam risk (impersonation, urgency, untraceable payment requests, secrecy coaching,
remote access, credential requests, threats), and alerts the guardian when the risk
crosses a threshold. Success is the guardian learning about a scam while it is still
happening, with enough evidence to act.

## Positioning

Real-time, during the call: the risk score moves as the words are spoken, and every
point of risk traces back to highlighted words in the transcript. Not a call blocker and
not an after-the-fact report.

## Operating Context

- A call happens between a **caller** (possibly a scammer) and the **protected person**.
- The guardian sees: the live risk score (0-100; low 0-39, elevated 40-69, high 70-100),
  the signals detected and a one-line reason, alert reports with the caller's words that
  triggered them, a call summary, and the live transcript with risky phrases highlighted.
- An alert fires once when the score reaches 70; the guardian can acknowledge it. The
  guardian is also notified by a browser notification.
- A History view lists past calls and their stored record.
- Hackathon demo (ShellHacks): the dashboard will be shown framed inside a phone image to
  simulate a guardian's phone. Design mobile-first, and it must also work on desktop.

## Capabilities and Constraints

- React + Vite single-page app (`apps/dashboard`); state arrives over a WebSocket and the
  dashboard never computes scores itself.
- Routes: `/` (latest call), `/call/:callId` (one live call), `/history[/:id]`.
- Light and dark mode are required.

## Brand Commitments

- Name: Guardian Loop.
- Logo: `src/assets/glLogo.png` — two hands forming a teal-to-blue ring around a phone
  marked "GL". Transparent PNG.
- Colors (user-specified): primary darker blue `#1d5a9d`, light teal secondary `#4eb8b3`,
  background `#e7fdfb`, text black.
- No emoji anywhere in the UI.
- The person on the call is called **"Protected person"**, never "victim", in guardian-facing
  UI.

## Evidence on Hand

Real transcripts from `fixtures/calls/*.jsonl` and live calls. No testimonials, customers,
or statistics exist; none may be invented.

## Product Principles

1. The score is the answer; the transcript is the evidence. Every risk shown must be traceable to words.
2. Calm until it matters: nothing alarms the guardian before the risk warrants it.
3. Readable at a glance, on a phone, by someone who is worried.
4. Report what the system knows, never more (no invented certainty or claims).

## Accessibility & Inclusion

Guardians can be any age; the protected person is typically older. Large legible type,
strong contrast in both themes, and risk never conveyed by color alone.
