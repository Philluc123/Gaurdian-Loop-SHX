// Orchestrator (docs/module-contracts.md §3.3): the only module that holds per-call
// state. Everything it drives is a pure function — the rules classifier and score
// engine — so this file is the glue: it keeps each call's state, routes audio into
// the STT sessions, feeds transcripts through the rules, feeds rule hits and a 1s
// tick through the score engine, and publishes what comes back.
//
//   audio.frame ──STT session──▶ transcript
//   transcript ──runRules──▶ rules.hits ──updateScore──▶ score.updated / alert.triggered
//   1s tick ────────────────────────────updateScore──▶ score.updated (decay)
//   rule hit / victim hit / heartbeat ──classify──▶ llm.result ──updateScore──▶ …
//
// On alert.triggered it hands the alert and the call's guardian to `sendAlert` and
// publishes the `alert.sent` that comes back (§3.3, §3.7).
//
// The LLM (M4) does two jobs the rules can't. It reads a rule hit in context (a
// grandson mentioning a gift card for a birthday isn't a scam), and, through the
// heartbeat, it reads conversations that never trip a rule at all, which is how a
// caller who avoids the keywords gets caught. Trigger policy (§3.3): a final with
// a rule hit, a victim compliance/disclosure hit, a heartbeat once new speech has
// gone unread for `llmHeartbeatMs`, and one last look after hangup at whatever the
// LLM hasn't read yet. Triggers are coalesced for `llmDebounceMs`, at most one
// request is in flight per call, and a result with a stale `seq` is dropped.

import type {
  AlertSent,
  AlertTriggered,
  CallId,
  CallStarted,
  DashboardSnapshot,
  Guardian,
  LLMRequest,
  LLMResult,
  RuleHit,
  RulesHitsEvent,
  ScoreState,
  SegmentHighlight,
  Signal,
  SttAdapter,
  TranscriptEvent,
  Turn,
} from "@guardian-loop/shared-types";
import type { EventBus } from "../event-bus";
import { runRules } from "../rules-classifier";
import { initialScoreState, updateScore, type ScoreInput } from "../score-engine";
import { createSttSessions } from "./stt-sessions";

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
  /** Rolling context window: final turns this recent go to the LLM. */
  windowSec: number;
  llm: LlmState;
}

type LlmTrigger = LLMRequest["trigger"];

export interface LlmState {
  inFlight: boolean;
  /** New final turns have arrived since the last request went out. */
  dirty: boolean;
  /** Seq of the latest request; a result carrying any other seq is stale. */
  seq: number;
  /** When the last request went out (or the call started): the heartbeat clock. */
  lastRunAt: number;
  /** One-line memory the LLM carries between calls. */
  carryContext: string;
  /** Trigger waiting on the debounce timer or on the in-flight request. */
  pending?: LlmTrigger;
  timer?: ReturnType<typeof setTimeout>;
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
  /**
   * Transcribes each call's audio. Omitted in tests that publish transcripts
   * directly, in which case audio frames are ignored.
   */
  stt?: SttAdapter;
  /**
   * The LLM classifier. Must never reject — it resolves every failure as
   * `llm_error`. Omitted when no Gemini key is configured, and in tests that
   * don't exercise it, in which case scoring runs on rules alone.
   */
  classify?: (req: LLMRequest) => Promise<LLMResult>;
  /** Sees each LLM request as it goes out — the server logs what the LLM is reading. */
  onLlmRequest?: (req: LLMRequest) => void;
  /** Triggers arriving within this window share one LLM request. The contract says ~1.2s. */
  llmDebounceMs?: number;
  /** New speech unread by the LLM for this long triggers a heartbeat request. */
  llmHeartbeatMs?: number;
  /** Rolling context window sent to the LLM, in seconds of speech. */
  windowSec?: number;
}

export interface Orchestrator {
  getCall(callId: CallId): Readonly<CallState> | undefined;
  /** The most recently started call — what a dashboard following "latest" shows. */
  readonly latestCallId: CallId | undefined;
  snapshot(callId: CallId): DashboardSnapshot | undefined;
  findAlert(callId: CallId, alertId: string): AlertTriggered | undefined;
  stop(): void;
  /** Flushes and closes every open STT session (used on shutdown). */
  closeSessions(): Promise<void>;
}

/** How many final turns the score engine sees; the last 3 go into an alert's snippet. */
const RECENT_TURNS = 6;
/** A same-speaker line ending this close before the next one may be half of its sentence. */
const PREVIOUS_LINE_GAP_MS = 5000;
/** Cap on turns per LLM request, however many fit in the window. */
const MAX_LLM_TURNS = 10;
/** Victim-side hits trigger the LLM as "victim" rather than "rule" (§3.3 trigger 2). */
const VICTIM_TRIGGER_SIGNALS: ReadonlySet<Signal> = new Set(["VICTIM_COMPLIANCE", "VICTIM_DISCLOSURE"]);
const TRIGGER_RANK: Record<LlmTrigger, number> = { heartbeat: 0, final: 0, rule: 1, victim: 2 };

export function createOrchestrator(bus: EventBus, opts: OrchestratorOptions = {}): Orchestrator {
  const tickMs = opts.tickMs ?? 1000;
  const maxEndedCalls = opts.maxEndedCalls ?? 20;
  const now = opts.now ?? Date.now;
  const llmDebounceMs = opts.llmDebounceMs ?? 1200;
  const llmHeartbeatMs = opts.llmHeartbeatMs ?? 30_000;
  const windowSec = opts.windowSec ?? 60;
  let stopped = false;

  const calls = new Map<CallId, CallState>();
  let latestCallId: CallId | undefined;
  const stt = opts.stt ? createSttSessions(opts.stt, (event) => bus.publish(event)) : undefined;

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

  function llmTriggerFor(hits: RuleHit[]): LlmTrigger | undefined {
    if (hits.some((h) => VICTIM_TRIGGER_SIGNALS.has(h.signal))) return "victim";
    return hits.length > 0 ? "rule" : undefined;
  }

  /**
   * Queues an LLM request. The first trigger starts the debounce timer and later
   * ones ride along (keeping the strongest trigger) rather than restarting it, so a
   * steady stream of rule hits can't starve the LLM.
   */
  function requestLlm(call: CallState, trigger: LlmTrigger): void {
    if (!opts.classify) return;
    const llm = call.llm;
    if (!llm.pending || TRIGGER_RANK[trigger] > TRIGGER_RANK[llm.pending]) llm.pending = trigger;
    // While a request is in flight, the pending trigger runs when it settles.
    if (llm.inFlight || llm.timer) return;
    llm.timer = setTimeout(() => {
      llm.timer = undefined;
      runLlm(call);
    }, llmDebounceMs);
  }

  function runLlm(call: CallState): void {
    const llm = call.llm;
    const trigger = llm.pending;
    if (!opts.classify || stopped || !trigger || llm.inFlight) return;
    llm.pending = undefined;
    llm.inFlight = true;
    llm.dirty = false;
    llm.lastRunAt = now();
    const seq = ++llm.seq;

    const req: LLMRequest = {
      callId: call.callId,
      seq,
      trigger,
      state: {
        score: call.score.score,
        signals: Object.keys(call.score.signals) as Signal[],
        elapsedSec: Math.max(0, (now() - call.startedAt) / 1000),
        carryContext: llm.carryContext,
      },
      turns: contextWindow(call).map(({ speaker, text }) => ({ speaker, text })),
    };

    opts.onLlmRequest?.(req);
    opts
      .classify(req)
      .then((result) => onLlmResult(call, result))
      .catch((err) => {
        // The classifier promises never to reject; guard anyway so a bug there
        // can't become an unhandled rejection or wedge this call's LLM forever.
        console.error(`[orchestrator] classify rejected for ${call.callId} seq=${seq}:`, err);
      })
      .finally(() => {
        llm.inFlight = false;
        // A trigger that arrived mid-request has already waited out its debounce.
        if (llm.pending && calls.get(call.callId) === call) runLlm(call);
      });
  }

  function onLlmResult(call: CallState, result: LLMResult): void {
    if (stopped || calls.get(call.callId) !== call) return; // call evicted meanwhile
    if (result.seq !== call.llm.seq) {
      console.warn(`[orchestrator] dropped stale llm.result for ${call.callId}: seq=${result.seq}, latest=${call.llm.seq}`);
      return;
    }
    // An llm_error result echoes the request's memory, so this never wipes it.
    call.llm.carryContext = result.carryContext;
    bus.publish(result);
    applyScore(call, result);
  }

  /** Final turns within `windowSec` of the latest one, capped at MAX_LLM_TURNS. */
  function contextWindow(call: CallState): Turn[] {
    const last = call.turns.at(-1);
    if (!last) return [];
    const from = last.endMs - call.windowSec * 1000;
    return call.turns.filter((t) => t.endMs >= from).slice(-MAX_LLM_TURNS);
  }

  /** Heartbeat (§3.3 trigger 3): new speech the LLM hasn't read, for too long. */
  function maybeHeartbeat(call: CallState, ts: number): void {
    const llm = call.llm;
    if (!llm.dirty || llm.inFlight || llm.pending) return;
    if (ts - llm.lastRunAt >= llmHeartbeatMs) requestLlm(call, "heartbeat");
  }

  function clearLlmTimer(call: CallState): void {
    clearTimeout(call.llm.timer);
    call.llm.timer = undefined;
  }

  /**
   * The same speaker's previous final line, if it ended within PREVIOUS_LINE_GAP_MS
   * of this one starting — close enough to be the same sentence split at a pause.
   */
  function previousLine(call: CallState, event: TranscriptEvent): string | undefined {
    for (let i = call.turns.length - 1; i >= 0; i--) {
      const turn = call.turns[i];
      if (turn.segmentId === event.segmentId) continue;
      if (turn.speaker !== event.speaker) continue;
      return event.startMs - turn.endMs <= PREVIOUS_LINE_GAP_MS ? turn.text : undefined;
    }
    return undefined;
  }

  function onCallStarted(event: CallStarted): void {
    stt?.open(event.callId);
    calls.set(event.callId, {
      callId: event.callId,
      guardian: event.guardian,
      startedAt: event.ts,
      turns: [],
      score: initialScoreState(),
      highlights: new Map(),
      alerts: [],
      windowSec,
      llm: { inFlight: false, dirty: false, seq: 0, lastRunAt: now(), carryContext: "" },
    });
    latestCallId = event.callId;
    evictEndedCalls();
  }

  function onTranscript(event: TranscriptEvent): void {
    const call = calls.get(event.callId);
    if (!call) return; // transcript for a call we never saw start: nothing to attach it to

    // Rules run on partials too: partial hits drive live highlighting in the
    // dashboard, and only final hits move the score (the engine enforces that).
    const hits = runRules({
      speaker: event.speaker,
      text: event.text,
      previousText: previousLine(call, event),
    });
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

    call.llm.dirty = true;
    const trigger = llmTriggerFor(hits);
    if (trigger) requestLlm(call, trigger);
  }

  // Finals keep arriving for a moment after call.ended — the STT adapter flushes
  // its last words on hangup — so an ended call stays scoreable; it just stops
  // decaying.
  //
  // Hangup also gets one last LLM look (§3.3 trigger 4). The heartbeat stops with the
  // call, so speech since the last request (a closing threat, the victim agreeing to
  // drive to the store) would otherwise never be read. It waits for the STT flush so
  // those last words are in, and is skipped when the LLM has already read everything.
  // An alert that fires from it still reaches the guardian, who can call back.
  function onCallEnded(callId: CallId, ts: number): void {
    const call = calls.get(callId);
    if (!call || call.endedAt !== undefined) {
      void stt?.close(callId);
      return;
    }
    call.endedAt = ts;
    const flushed = stt?.close(callId) ?? Promise.resolve();
    void flushed.then(() => {
      if (calls.get(callId) === call && call.llm.dirty) requestLlm(call, "final");
    });
  }

  function evictEndedCalls(): void {
    const ended = [...calls.values()]
      .filter((c) => c.endedAt !== undefined)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const call of ended.slice(0, Math.max(0, ended.length - maxEndedCalls))) {
      clearLlmTimer(call);
      calls.delete(call.callId);
    }
  }

  // One timer for every live call, rather than one per call.
  const ticker = setInterval(() => {
    const ts = now();
    for (const call of calls.values()) {
      if (call.endedAt !== undefined) continue;
      applyScore(call, { type: "tick", ts });
      maybeHeartbeat(call, ts);
    }
  }, tickMs);
  ticker.unref?.();

  const unsubscribes = [
    bus.subscribe("call.started", onCallStarted),
    bus.subscribe("audio.frame", (frame) => stt?.send(frame)),
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
      stopped = true;
      clearInterval(ticker);
      for (const call of calls.values()) clearLlmTimer(call);
      for (const off of unsubscribes) off();
    },
    closeSessions: () => stt?.closeAll() ?? Promise.resolve(),
  };
}
