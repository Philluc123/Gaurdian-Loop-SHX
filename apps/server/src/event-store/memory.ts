// In-memory event store (docs/module-contracts.md §3.9), standing in for MongoDB.
//
// Same storage rules and the same two endpoints as the Mongo version will have, so
// swapping it in is a change to how events are persisted, not to what's stored or
// how it's served. History survives as long as the process does — enough for a
// demo, and it keeps the dashboard's History tab working without a database.

import express, { type Router } from "express";
import type {
  CallId,
  CallRecord,
  CallSummary,
  GuardianEvent,
  StoredEvent,
} from "@guardian-loop/shared-types";
import type { EventBus } from "../event-bus";

export interface MemoryEventStoreOptions {
  /** Oldest calls are dropped beyond this, so a long-running server stays bounded. */
  maxCalls?: number;
}

export interface MemoryEventStore {
  router: Router;
  list(): CallSummary[];
  get(callId: CallId): CallRecord | undefined;
  stop(): void;
}

interface StoredCall {
  summary: CallSummary;
  events: StoredEvent[];
}

/**
 * §3.9: never audio frames, never partials. Empty final rule hits are skipped too —
 * they carry no information and would be one row per sentence.
 */
export function shouldStore(event: GuardianEvent): boolean {
  switch (event.type) {
    case "audio.frame":
      return false;
    case "transcript":
      return event.isFinal;
    case "rules.hits":
      return event.isFinal && event.hits.length > 0;
    default:
      return true;
  }
}

export function createMemoryEventStore(
  bus: EventBus,
  opts: MemoryEventStoreOptions = {}
): MemoryEventStore {
  const maxCalls = opts.maxCalls ?? 50;
  const calls = new Map<CallId, StoredCall>();

  function onEvent(event: GuardianEvent): void {
    if (event.type === "call.started") {
      calls.set(event.callId, {
        summary: {
          callId: event.callId,
          source: event.source,
          from: event.from,
          to: event.to,
          guardian: event.guardian,
          startedAt: event.ts,
          maxScore: 0,
          finalLevel: "low",
          alertCount: 0,
        },
        events: [],
      });
      // Map iteration is insertion order, so the first key is the oldest call.
      while (calls.size > maxCalls) calls.delete(calls.keys().next().value as CallId);
    }

    const call = calls.get(event.callId);
    if (!call || !shouldStore(event)) return;
    call.events.push({ callId: event.callId, ts: event.ts, type: event.type, payload: event });

    const s = call.summary;
    if (event.type === "score.updated") {
      s.maxScore = Math.max(s.maxScore, event.score);
      s.finalLevel = event.level;
    } else if (event.type === "alert.triggered") {
      s.alertCount += 1;
    } else if (event.type === "call.ended") {
      s.endedAt = event.ts;
    }
  }

  const unsubscribe = bus.subscribeAll(onEvent);

  const list = (): CallSummary[] =>
    [...calls.values()].map((c) => ({ ...c.summary })).sort((a, b) => b.startedAt - a.startedAt);

  const get = (callId: CallId): CallRecord | undefined => {
    const call = calls.get(callId);
    if (!call) return undefined;
    // Events are appended as they're published, but order by ts per the contract.
    return { call: { ...call.summary }, events: [...call.events].sort((a, b) => a.ts - b.ts) };
  };

  const router = express.Router();
  router.get("/api/calls", (_req, res) => res.json(list()));
  router.get("/api/calls/:callId", (req, res) => {
    const record = get(req.params.callId);
    if (!record) return res.status(404).json({ error: "call not found" });
    res.json(record);
  });

  return { router, list, get, stop: unsubscribe };
}
