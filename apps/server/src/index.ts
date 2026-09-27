// Composition root. Wires every module's event bus subscriptions together and
// starts the HTTP/WebSocket server. Keep this file thin — it should only import
// and connect modules, never contain module logic itself.
//
// See ./README.md and docs/module-contracts.md section 1 for the wiring diagram.

import http from "node:http";
import express from "express";
import {
  CALL_PAGE_PATH,
  WEBRTC_WS_PATH,
  loadGuardian,
  loadLlmConfig,
  loadServerConfig,
  loadSttConfig,
  loadWebRtcConfig,
  warnAboutGaps,
} from "./config";
import { bus } from "./event-bus";
import { createWebRtcIngestion } from "./call-ingestion/webrtc";
import { createMemoryEventStore } from "./event-store/memory";
import { createClassifier } from "./llm-classifier";
import { createOrchestrator } from "./orchestrator";
import { createDashboardAlerter } from "./orchestrator/dashboard-alerts";
import { createDashboardFeed, type DashboardFeed } from "./orchestrator/dashboard-feed";
import { createSttAdapter } from "./stt-adapters";
import { createTranscriptLog } from "./transcript-log";

function main(): void {
  const serverCfg = loadServerConfig();
  const sttCfg = loadSttConfig();
  const webrtcCfg = loadWebRtcConfig();
  const llmCfg = loadLlmConfig();
  const guardian = loadGuardian();
  warnAboutGaps(serverCfg, sttCfg, webrtcCfg, llmCfg);

  const app = express();
  const stt = createSttAdapter(sttCfg);

  const ingestion = createWebRtcIngestion({
    webrtc: webrtcCfg,
    guardian,
    publish: (event) => bus.publish(event),
  });
  app.use(ingestion.router);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      sttProvider: stt.name,
      llmModel: llmCfg.gemini.apiKey ? llmCfg.gemini.model : null,
      activeCalls: ingestion.activeCallIds,
    });
  });

  // Order matters: the dashboard feed pushes a snapshot on call.started, which
  // needs the orchestrator to have created that call's state first, and bus
  // listeners run in the order they were registered.
  //
  // Guardian notifications go out through the dashboard feed, which doesn't exist
  // yet when the orchestrator is built — hence the getter, resolved at send time.
  let feedForAlerts: DashboardFeed | undefined;
  const orchestrator = createOrchestrator(bus, {
    stt,
    sendAlert: createDashboardAlerter(() => feedForAlerts),
    // No key, no LLM: scoring runs on rules alone rather than logging an
    // llm_error for every trigger.
    classify: llmCfg.gemini.apiKey
      ? createClassifier({ apiKey: llmCfg.gemini.apiKey, model: llmCfg.gemini.model })
      : undefined,
    llmHeartbeatMs: llmCfg.heartbeatSec * 1000,
    // What the LLM is actually reading, for tuning the trigger policy and prompt.
    onLlmRequest: (req) => {
      console.log(
        `[LLM >] seq=${req.seq} trigger=${req.trigger} @${req.state.elapsedSec.toFixed(0)}s ` +
          `score=${req.state.score} turns=${req.turns.length}`
      );
      if (req.state.carryContext) console.log(`        memory: ${req.state.carryContext}`);
      for (const t of req.turns) console.log(`        ${t.speaker.padEnd(6)} ${t.text}`);
    },
  });
  const dashboardFeed = createDashboardFeed(bus, orchestrator);
  feedForAlerts = dashboardFeed;

  // Call history for the dashboard's History tab, held in memory until MongoDB.
  const eventStore = createMemoryEventStore(bus);
  app.use(eventStore.router);

  // Dev-only place to read a call back after hanging up. Replaced by the event
  // store (§3.9) when Workstream E lands; TRANSCRIPT_LOG=0 turns it off.
  const transcriptLogDir = process.env.TRANSCRIPT_LOG_DIR || "logs/calls";
  const transcriptLog =
    process.env.TRANSCRIPT_LOG === "0"
      ? undefined
      : createTranscriptLog(bus, { dir: transcriptLogDir });
  if (transcriptLog) console.log(`[server] transcripts -> ${transcriptLogDir}/<callId>.txt`);

  // Until the dashboard exists, the transcript stream is the visible output —
  // this is what tells you the whole capture -> STT chain is alive.
  const logPartials = process.env.LOG_PARTIALS === "1";
  bus.subscribe("transcript", (e) => {
    if (!e.isFinal && !logPartials) return;
    const tag = e.isFinal ? "FINAL" : "  ...";
    const at = `${(e.startMs / 1000).toFixed(1)}s`;
    console.log(`[${tag}] ${e.speaker.padEnd(6)} @${at.padStart(7)}  ${e.text}`);
  });

  // Score movement worth seeing in the terminal; per-second decay is left out.
  bus.subscribe("score.updated", (e) => {
    if (e.source === "decay") return;
    console.log(`[SCORE] ${String(e.score).padStart(3)} ${e.level.padEnd(8)} (${e.source}) ${e.reason}`);
  });
  bus.subscribe("llm.result", (e) => {
    const signals = e.signals.length ? ` [${e.signals.join(", ")}]` : "";
    console.log(
      `[LLM <] seq=${e.seq} ${e.latencyMs}ms (${e.model}) score=${e.score}` +
        `${e.benignContext ? " benign" : ""}${signals}: ${e.reason}`
    );
    if (e.reason !== "llm_error") console.log(`        memory: ${e.carryContext}`);
  });
  bus.subscribe("alert.triggered", (e) => {
    console.log(`[ALERT] risk ${e.score} >= ${e.threshold}: ${e.reason}`);
  });
  bus.subscribe("alert.sent", (e) => {
    console.log(`[ALERT] guardian notification ${e.status}${e.error ? `: ${e.error}` : ""}`);
  });

  const server = http.createServer(app);

  // One HTTP server, several WebSocket paths, so upgrades are routed by pathname.
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === WEBRTC_WS_PATH) {
      ingestion.handleUpgrade(req, socket, head);
      return;
    }
    if (pathname === serverCfg.dashboardWsPath) {
      dashboardFeed.handleUpgrade(req, socket, head);
      return;
    }
    console.warn(`[server] rejected WebSocket upgrade for ${pathname}`);
    socket.destroy();
  });

  server.listen(serverCfg.port, () => {
    const base = serverCfg.publicBaseUrl || `http://localhost:${serverCfg.port}`;
    const secretParam = webrtcCfg.roomSecret
      ? `&secret=${encodeURIComponent(webrtcCfg.roomSecret)}`
      : "";

    console.log(`[server] listening on http://localhost:${serverCfg.port}`);
    console.log(`[server] STT provider: ${stt.name}`);
    console.log(
      `[server] LLM: ${llmCfg.gemini.apiKey ? `${llmCfg.gemini.model}, heartbeat ${llmCfg.heartbeatSec}s` : "off (no GEMINI_API_KEY)"}`
    );
    console.log(
      `[server] capture: ${webrtcCfg.encoding} @ ${webrtcCfg.sampleRate}Hz, ` +
        `attribution gate ${webrtcCfg.gate.enabled ? "on" : "off"}`
    );
    console.log(`[server] dashboard feed on ${serverCfg.dashboardWsPath}, call history on /api/calls`);
    console.log("");
    console.log("Guardian dashboard (separate terminal): npm run dev --workspace=@guardian-loop/dashboard");
    console.log("  then open http://localhost:5173");
    console.log("");
    // Localhost links always work on this machine, since localhost counts as a secure
    // context for the microphone. The public links only work while the tunnel runs,
    // and opening them without it just shows the tunnel's "offline" error page.
    const local = `http://localhost:${serverCfg.port}`;
    const link = (origin: string, role: string) =>
      `${origin}${CALL_PAGE_PATH}/?room=demo&role=${role}${secretParam}`;

    console.log("Call links — one per person, wear headphones or earbuds:");
    console.log("  On THIS computer (always works):");
    console.log(`    caller: ${link(local, "caller")}`);
    console.log(`    victim: ${link(local, "victim")}`);
    if (serverCfg.publicBaseUrl) {
      console.log("  On OTHER devices (only while the tunnel is running):");
      console.log(`    caller: ${link(base, "caller")}`);
      console.log(`    victim: ${link(base, "victim")}`);
    } else {
      console.log("  Other devices need an https tunnel and PUBLIC_BASE_URL set — the");
      console.log("  microphone is blocked on a plain http LAN address.");
    }
    console.log("");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} — shutting down`);
    ingestion.close();
    dashboardFeed.close();
    orchestrator.stop();
    eventStore.stop();
    transcriptLog?.stop();
    void orchestrator.closeSessions().finally(() => {
      server.close(() => process.exit(0));
      // Don't hang forever on a socket that refuses to close.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
