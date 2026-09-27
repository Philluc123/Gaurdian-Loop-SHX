// Mock dashboard backend (docs/module-contracts.md §3.8, §5).
//
// Replays fixtures/calls/*.jsonl as live calls, one after another, and speaks the
// exact dashboard contract: ServerMsg over WebSocket at DASHBOARD_WS_PATH, plus
// GET /api/calls and GET /api/calls/:callId. Highlights, scores, and alerts come from
// the real rules classifier and score engine, so what the UI shows is what the
// pipeline would produce (minus the LLM, which this mock doesn't call).
//
//   npm run mock:dashboard -- [--speed 2] [--port 3000] [fixtures/calls/x.jsonl ...]

import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AlertTriggered,
  CallId,
  CallRecord,
  CallSummary,
  ClientMsg,
  RulesHitsEvent,
  ScoreState,
  SegmentHighlight,
  ServerMsg,
  Signal,
  StoredEvent,
  TranscriptEvent,
  Turn,
} from "@guardian-loop/shared-types";
import { runRules } from "../apps/server/src/rules-classifier";
import { initialScoreState, updateScore, type ScoreInput } from "../apps/server/src/score-engine";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const PORT = flag("port", Number(process.env.PORT ?? 3000));
const SPEED = flag("speed", 1);
const WS_PATH = process.env.DASHBOARD_WS_PATH ?? "/ws/dashboard";
const GAP_BETWEEN_CALLS_MS = 6000;
const ALERT_DELIVERY_DELAY_MS = 900;
const GUARDIAN = { name: "Maria (daughter)", phone: "+13055551234" };

const fixtureFiles = args.filter((a) => a.endsWith(".jsonl"));
if (fixtureFiles.length === 0) {
  const dir = resolve(__dirname, "../fixtures/calls");
  fixtureFiles.push(...readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(dir, f)));
}
if (fixtureFiles.length === 0) throw new Error("no fixtures/calls/*.jsonl found");

// --- per-call state (the slice of orchestrator state the dashboard needs) ---

interface MockCall {
  summary: CallSummary;
  turns: Turn[];
  score: ScoreState;
  highlights: Map<string, SegmentHighlight[]>; // by segmentId, latest version only
  alerts: AlertTriggered[];
  events: StoredEvent[];
  ended: boolean;
}

const calls = new Map<CallId, MockCall>();
let latestCallId: CallId | undefined;

function snapshot(c: MockCall): ServerMsg {
  return {
    type: "snapshot",
    call: {
      callId: c.summary.callId,
      startedAt: c.summary.startedAt,
      turns: c.turns,
      score: c.score.score,
      level: c.score.level,
      signals: (Object.keys(c.score.signals) as Signal[]).sort(
        (a, b) => c.score.signals[a]!.firstSeenMs - c.score.signals[b]!.firstSeenMs
      ),
      highlights: [...c.highlights.values()].flat(),
      alerts: c.alerts,
    },
  };
}

function record(c: MockCall, type: string, payload: object) {
  c.events.push({ callId: c.summary.callId, ts: Date.now(), type, payload });
}

// --- clients ---

const subs = new Map<WebSocket, CallId | "latest">();

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(callId: CallId, msg: ServerMsg) {
  for (const [ws, sub] of subs) {
    if (sub === callId || (sub === "latest" && latestCallId === callId)) send(ws, msg);
  }
}

function sendSnapshotFor(ws: WebSocket, sub: CallId | "latest") {
  const c = calls.get(sub === "latest" ? latestCallId ?? "" : sub);
  if (!c) return; // "latest" before any call started: the first call.started will snapshot
  send(ws, snapshot(c));
  if (c.ended) send(ws, { type: "call_ended", callId: c.summary.callId, ts: c.summary.endedAt! });
}

// --- replay ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function applyScore(c: MockCall, input: ScoreInput) {
  const recentTurns = c.turns.slice(-3).map(({ speaker, text }) => ({ speaker, text }));
  const { next, events } = updateScore(c.score, input, {
    callId: c.summary.callId,
    startedAt: c.summary.startedAt,
    recentTurns,
  });
  c.score = next;
  c.summary.maxScore = Math.max(c.summary.maxScore, next.score);
  c.summary.finalLevel = next.level;
  for (const ev of events) {
    record(c, ev.type, ev);
    if (ev.type === "score.updated") {
      broadcast(c.summary.callId, { type: "score", event: ev });
    } else {
      c.alerts.push(ev);
      c.summary.alertCount++;
      broadcast(c.summary.callId, { type: "alert", event: ev });
      // Stand-in for the alerts module: report notification delivery a moment later.
      setTimeout(() => {
        const sent = { type: "alert.sent" as const, callId: ev.callId, alertId: ev.alertId, channel: "notification" as const, status: "sent" as const, ts: Date.now() };
        record(c, sent.type, sent);
        broadcast(c.summary.callId, { type: "alert", event: ev, delivery: "sent" });
      }, ALERT_DELIVERY_DELAY_MS / SPEED);
    }
  }
}

function onTranscript(c: MockCall, fixtureEv: TranscriptEvent) {
  const callId = c.summary.callId;
  const ev: TranscriptEvent = { ...fixtureEv, callId, ts: Date.now() };
  if (ev.isFinal) record(c, ev.type, ev);
  broadcast(callId, { type: "transcript", event: ev });

  const hits = runRules({ speaker: ev.speaker, text: ev.text });
  const spans = hits.map(({ start, end, signal }) => ({ start, end, signal }));
  c.highlights.set(ev.segmentId, spans.map((s) => ({ ...s, segmentId: ev.segmentId })));
  broadcast(callId, { type: "highlights", segmentId: ev.segmentId, isFinal: ev.isFinal, spans });

  if (!ev.isFinal) return;
  c.turns.push({ segmentId: ev.segmentId, speaker: ev.speaker, text: ev.text, startMs: ev.startMs, endMs: ev.endMs });
  const rulesEv: RulesHitsEvent = { type: "rules.hits", callId, segmentId: ev.segmentId, speaker: ev.speaker, isFinal: true, hits, ts: ev.ts };
  if (hits.length > 0) record(c, rulesEv.type, rulesEv);
  applyScore(c, rulesEv);
}

async function playCall(file: string, run: number) {
  const events: TranscriptEvent[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const callId = `${basename(file, ".jsonl")}-${run}`;
  const startedAt = Date.now();
  const from = `+1800555${String(1000 + fixtureFiles.indexOf(file) * 137).slice(-4)}`; // stable per fixture
  const c: MockCall = {
    summary: { callId, source: "webrtc", from, to: "+13055550100", guardian: GUARDIAN, startedAt, maxScore: 0, finalLevel: "low", alertCount: 0 },
    turns: [],
    score: initialScoreState(),
    highlights: new Map(),
    alerts: [],
    events: [],
    ended: false,
  };
  calls.set(callId, c);
  latestCallId = callId;
  record(c, "call.started", { type: "call.started", callId, source: "webrtc", guardian: GUARDIAN, ts: startedAt });
  console.log(`[mock] call started: ${callId}`);
  for (const [ws, sub] of subs) if (sub === "latest") send(ws, snapshot(c));

  const ticker = setInterval(() => applyScore(c, { type: "tick", ts: Date.now() }), 1000 / SPEED);
  for (const ev of events) {
    const wait = startedAt + ev.ts / SPEED - Date.now();
    if (wait > 0) await sleep(wait);
    onTranscript(c, ev);
  }
  await sleep(1500 / SPEED);
  clearInterval(ticker);

  c.ended = true;
  c.summary.endedAt = Date.now();
  record(c, "call.ended", { type: "call.ended", callId, reason: "hangup", ts: c.summary.endedAt });
  broadcast(callId, { type: "call_ended", callId, ts: c.summary.endedAt });
  console.log(`[mock] call ended: ${callId} (max score ${c.summary.maxScore}, ${c.summary.alertCount} alert(s))`);
}

async function replayForever() {
  for (let run = 1; ; run++) {
    for (const file of fixtureFiles) {
      await playCall(file, run);
      await sleep(GAP_BETWEEN_CALLS_MS / SPEED);
    }
  }
}

// --- HTTP (call history) + WebSocket ---

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return json(405, { error: "method not allowed" });
  if (url.pathname === "/api/calls") {
    const list: CallSummary[] = [...calls.values()].map((c) => c.summary).sort((a, b) => b.startedAt - a.startedAt);
    return json(200, list);
  }
  const m = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (m) {
    const c = calls.get(decodeURIComponent(m[1]));
    if (!c) return json(404, { error: "call not found" });
    const body: CallRecord = { call: c.summary, events: c.events };
    return json(200, body);
  }
  json(404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: WS_PATH });
wss.on("connection", (ws) => {
  subs.set(ws, "latest");
  ws.on("close", () => subs.delete(ws));
  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe" || msg.type === "join_call") {
      subs.set(ws, msg.callId);
      sendSnapshotFor(ws, msg.callId);
    } else if (msg.type === "ack_alert") {
      console.log(`[mock] alert acknowledged: ${msg.alertId}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[mock] dashboard backend on http://localhost:${PORT} (ws ${WS_PATH}, speed ${SPEED}x)`);
  console.log(`[mock] fixtures: ${fixtureFiles.map((f) => basename(f)).join(", ")}`);
  void replayForever();
});
