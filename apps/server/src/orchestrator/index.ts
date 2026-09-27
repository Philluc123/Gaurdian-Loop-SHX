// Orchestrator (docs/module-contracts.md §3.3): the only module that holds per-call
// state. Everything it drives is a pure function — the rules classifier and score
// engine — so this file is the glue: it keeps each call's state, feeds transcripts
// through the rules, feeds rule hits and a 1s tick through the score engine, and
// publishes what comes back.
//
//   transcript ──runRules──▶ rules.hits ──updateScore──▶ score.updated / alert.triggered
//   1s tick ────────────────────────────updateScore──▶ score.updated (decay)
//
// On alert.triggered it hands the alert and the call's guardian to `sendAlert` and
// publishes the `alert.sent` that comes back (§3.3, §3.7).
//
// Not here yet: the LLM trigger policy (M4). It slots into this file without
// changing what it already publishes.

import type {
  AlertSent,
  AlertTriggered,
  CallId,
  CallStarted,
  DashboardSnapshot,
  Guardian,
  RulesHitsEvent,
  ScoreState,
  SegmentHighlight,
  Signal,
  TranscriptEvent,
  Turn,
} from "@guardian-loop/shared-types";
import type { EventBus } from "../event-bus";
import { runRules } from "../rules-classifier";
import { initialScoreState, updateScore, type ScoreInput } from "../score-engine";

export interface CallState {
  callId: CallId;
  guardian: Guardian;
  startedAt: number;
  /** Every final turn, in order. */
  turns: Turn[];
  score: ScoreState;
  /** Latest highlight spans per segment — partial or final, whichever came last. */
  highlights: Map<string, SegmentHighlight[]>;
  alerts: AlertTriggered[];
  endedAt?: number;
}

export interface OrchestratorOptions {
  /** How often the score engine gets a decay tick. The contract says ~1s. */
  tickMs?: number;
  /** Finished calls kept in memory for late dashboard subscribers. */
  maxEndedCalls?: number;
  now?: () => number;
  /**
   * Notifies the guardian of an alert. Must never reject — the alerts module
   * resolves every failure as `status: "failed"`. Omitted in tests that don't
   * exercise alerting, in which case no `alert.sent` is published.
   */
  sendAlert?: (alert: AlertTriggered, guardian: Guardian) => Promise<AlertSent>;
}

export interface Orchestrator {
  getCall(callId: CallId): Readonly<CallState> | undefined;
  /** The most recently started call — what a dashboard following "latest" shows. */
  readonly latestCallId: CallId | undefined;
  snapshot(callId: CallId): DashboardSnapshot | undefined;
  findAlert(callId: CallId, alertId: string): AlertTriggered | undefined;
  stop(): void;
}

/** How many final turns the score engine sees; the last 3 go into an alert's snippet. */
const RECENT_TURNS = 6;

export function createOrchestrator(bus: EventBus, opts: OrchestratorOptions = {}): Orchestrator {
  const tickMs = opts.tickMs ?? 1000;
  const maxEndedCalls = opts.maxEndedCalls ?? 20;
  const now = opts.now ?? Date.now;

  const calls = new Map<CallId, CallState>();
  let latestCallId: CallId | undefined;

  function applyScore(call: CallState, input: ScoreInput): void {
    const { next, events } = updateScore(call.score, input, {
      callId: call.callId,
      startedAt: call.startedAt,
      recentTurns: call.turns.slice(-RECENT_TURNS).map(({ speaker, text }) => ({ speaker, text })),
    });
    call.score = next;
    for (const event of events) {
      if (event.type === "alert.triggered") call.alerts.push(event);
      bus.publish(event);
      if (event.type === "alert.triggered") notifyGuardian(call, event);
    }
  }

  /** Fire-and-forget: a slow notification provider must never stall the call. */
  function notifyGuardian(call: CallState, alert: AlertTriggered): void {
    if (!opts.sendAlert) return;
    opts
      .sendAlert(alert, call.guardian)
      .then((sent) => bus.publish(sent))
      .catch((err) => {
        // The alerts module promises never to reject; guard anyway so a bug there
        // can't become an unhandled rejection that takes the server down.
        console.error(`[orchestrator] sendAlert rejected for ${alert.alertId}:`, err);
      });
  }

  function onCallStarted(event: CallStarted): void {
    calls.set(event.callId, {
      callId: event.callId,
      guardian: event.guardian,
      startedAt: event.ts,
      turns: [],
      score: initialScoreState(),
      highlights: new Map(),
      alerts: [],
    });
    latestCallId = event.callId;
    evictEndedCalls();
  }

  function onTranscript(event: TranscriptEvent): void {
    const call = calls.get(event.callId);
    if (!call) return; // transcript for a call we never saw start: nothing to attach it to

    // Rules run on partials too: partial hits drive live highlighting in the
    // dashboard, and only final hits move the score (the engine enforces that).
    const hits = runRules({ speaker: event.speaker, text: event.text });
    call.highlights.set(
      event.segmentId,
      hits.map(({ start, end, signal }) => ({ segmentId: event.segmentId, start, end, signal }))
    );

    const rulesEvent: RulesHitsEvent = {
      type: "rules.hits",
      callId: event.callId,
      segmentId: event.segmentId,
      speaker: event.speaker,
      isFinal: event.isFinal,
      hits,
      ts: event.ts,
    };
    // Published even when there are no hits: an empty partial clears highlights that
    // an earlier partial of the same segment put up.
    bus.publish(rulesEvent);

    if (!event.isFinal) return;
    call.turns.push({
      segmentId: event.segmentId,
      speaker: event.speaker,
      text: event.text,
      startMs: event.startMs,
      endMs: event.endMs,
    });
    applyScore(call, rulesEvent);
  }

  // Finals keep arriving for a moment after call.ended — the STT adapter flushes
  // its last words on hangup — so an ended call stays scoreable; it just stops
  // decaying.
  function onCallEnded(callId: CallId, ts: number): void {
    const call = calls.get(callId);
    if (call && call.endedAt === undefined) call.endedAt = ts;
  }

  function evictEndedCalls(): void {
    const ended = [...calls.values()]
      .filter((c) => c.endedAt !== undefined)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const call of ended.slice(0, Math.max(0, ended.length - maxEndedCalls))) {
      calls.delete(call.callId);
    }
  }

  // One timer for every live call, rather than one per call.
  const ticker = setInterval(() => {
    const ts = now();
    for (const call of calls.values()) {
      if (call.endedAt === undefined) applyScore(call, { type: "tick", ts });
    }
  }, tickMs);
  ticker.unref?.();

  const unsubscribes = [
    bus.subscribe("call.started", onCallStarted),
    bus.subscribe("transcript", onTranscript),
    bus.subscribe("call.ended", (event) => onCallEnded(event.callId, event.ts)),
  ];

  return {
    getCall: (callId) => calls.get(callId),
    get latestCallId() {
      return latestCallId;
    },
    snapshot(callId) {
      const call = calls.get(callId);
      if (!call) return undefined;
      const signals = (Object.keys(call.score.signals) as Signal[]).sort(
        (a, b) => call.score.signals[a]!.firstSeenMs - call.score.signals[b]!.firstSeenMs
      );
      return {
        callId: call.callId,
        startedAt: call.startedAt,
        turns: [...call.turns],
        score: call.score.score,
        level: call.score.level,
        signals,
        highlights: [...call.highlights.values()].flat(),
        alerts: [...call.alerts],
      };
    },
    findAlert: (callId, alertId) => calls.get(callId)?.alerts.find((a) => a.alertId === alertId),
    stop() {
      clearInterval(ticker);
      for (const off of unsubscribes) off();
    },
  };
}
