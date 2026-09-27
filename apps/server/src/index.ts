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
  loadServerConfig,
  loadSttConfig,
  loadWebRtcConfig,
  warnAboutGaps,
} from "./config";
import { bus } from "./event-bus";
import { createWebRtcIngestion } from "./call-ingestion/webrtc";
import { createSttAdapter, createSttBridge } from "./stt-adapters";
import { createTranscriptLog } from "./transcript-log";

// TODO: register orchestrator, rules-classifier, llm-classifier, score-engine,
// alerts and event-store here as those workstreams land.

function main(): void {
  const serverCfg = loadServerConfig();
  const sttCfg = loadSttConfig();
  const webrtcCfg = loadWebRtcConfig();
  const guardian = loadGuardian();
  warnAboutGaps(serverCfg, sttCfg, webrtcCfg);

  const app = express();

  const ingestion = createWebRtcIngestion({
    webrtc: webrtcCfg,
    guardian,
    publish: (event) => bus.publish(event),
  });
  app.use(ingestion.router);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      sttProvider: sttCfg.provider,
      activeCalls: ingestion.activeCallIds,
    });
  });

  const bridge = createSttBridge(bus, createSttAdapter(sttCfg));

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

  const server = http.createServer(app);

  // One HTTP server, several WebSocket paths (the call socket now, the dashboard
  // feed when Workstream D lands), so upgrades are routed by pathname here.
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === WEBRTC_WS_PATH) {
      ingestion.handleUpgrade(req, socket, head);
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
    console.log(`[server] STT provider: ${sttCfg.provider}`);
    console.log(
      `[server] capture: ${webrtcCfg.encoding} @ ${webrtcCfg.sampleRate}Hz, ` +
        `attribution gate ${webrtcCfg.gate.enabled ? "on" : "off"}`
    );
    console.log("");
    console.log("Open one link per person, on separate devices, wearing earbuds:");
    console.log(`  caller: ${base}${CALL_PAGE_PATH}/?room=demo&role=caller${secretParam}`);
    console.log(`  victim: ${base}${CALL_PAGE_PATH}/?room=demo&role=victim${secretParam}`);
    if (!serverCfg.publicBaseUrl) {
      console.log("");
      console.log("PUBLIC_BASE_URL is unset, so these are localhost links. A second device");
      console.log("needs an https tunnel — getUserMedia refuses a plain http LAN address.");
    }
    console.log("");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} — shutting down`);
    ingestion.close();
    bridge.stop();
    transcriptLog?.stop();
    void bridge.closeAll().finally(() => {
      server.close(() => process.exit(0));
      // Don't hang forever on a socket that refuses to close.
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
