// The guardian dashboard's WebSocket (docs/module-contracts.md §3.8) — the
// orchestrator's fan-out to the dashboard (§3.3).
//
// Translates bus events into ServerMsgs for whichever call each dashboard follows.
// It never computes anything: snapshots come from the orchestrator's state and
// every other message is a bus event re-shaped.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { CallId, ClientMsg, ServerMsg } from "@guardian-loop/shared-types";
import type { EventBus } from "../event-bus";
import type { Orchestrator } from "./index";

type Subscription = CallId | "latest";

export type DashboardNotification = Extract<ServerMsg, { type: "notification" }>;

export interface DashboardFeed {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Push a guardian notification to every connected dashboard, whichever call it
   * follows. Returns how many received it — 0 means no guardian is watching.
   */
  notify(notification: DashboardNotification): number;
  readonly clientCount: number;
  close(): void;
}

/**
 * Must be created AFTER the orchestrator. Bus listeners run in registration order,
 * and the snapshot pushed on call.started needs the orchestrator to have created
 * that call's state first.
 */
export function createDashboardFeed(bus: EventBus, orchestrator: Orchestrator): DashboardFeed {
  const wss = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, Subscription>();

  function send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function follows(sub: Subscription, callId: CallId): boolean {
    return sub === callId || (sub === "latest" && orchestrator.latestCallId === callId);
  }

  function broadcast(callId: CallId, msg: ServerMsg): void {
    for (const [ws, sub] of subscriptions) {
      if (follows(sub, callId)) send(ws, msg);
    }
  }

  /**
   * Full state for a (re)subscribing dashboard, so a refreshed page recovers the
   * whole call. The dashboard ignores every incremental message until it has one.
   */
  function sendSnapshot(ws: WebSocket, sub: Subscription): void {
    const callId = sub === "latest" ? orchestrator.latestCallId : sub;
    if (!callId) return; // no call yet: the first call.started pushes one
    const snapshot = orchestrator.snapshot(callId);
    if (!snapshot) return;
    send(ws, { type: "snapshot", call: snapshot });
    const endedAt = orchestrator.getCall(callId)?.endedAt;
    if (endedAt !== undefined) send(ws, { type: "call_ended", callId, ts: endedAt });
  }

  wss.on("connection", (ws: WebSocket) => {
    // Follow the latest call until told otherwise; the client subscribes on open.
    subscriptions.set(ws, "latest");

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe" || msg.type === "join_call") {
        subscriptions.set(ws, msg.callId);
        sendSnapshot(ws, msg.callId);
      } else if (msg.type === "ack_alert") {
        console.log(`[dashboard] guardian acknowledged alert ${msg.alertId}`);
      }
    });

    ws.on("close", () => subscriptions.delete(ws));
    ws.on("error", () => subscriptions.delete(ws));
  });

  const unsubscribes = [
    bus.subscribe("call.started", (event) => {
      // Dashboards following "latest" switch to the new call with a fresh snapshot.
      for (const [ws, sub] of subscriptions) {
        if (sub === "latest" || sub === event.callId) sendSnapshot(ws, event.callId);
      }
    }),
    bus.subscribe("transcript", (event) =>
      broadcast(event.callId, { type: "transcript", event })
    ),
    bus.subscribe("rules.hits", (event) =>
      broadcast(event.callId, {
        type: "highlights",
        segmentId: event.segmentId,
        isFinal: event.isFinal,
        spans: event.hits.map(({ start, end, signal }) => ({ start, end, signal })),
      })
    ),
    bus.subscribe("score.updated", (event) => broadcast(event.callId, { type: "score", event })),
    bus.subscribe("alert.triggered", (event) => broadcast(event.callId, { type: "alert", event })),
    bus.subscribe("alert.sent", (sent) => {
      // Re-send the alert with its delivery status; the dashboard merges by alertId.
      const alert = orchestrator.findAlert(sent.callId, sent.alertId);
      if (alert) broadcast(sent.callId, { type: "alert", event: alert, delivery: sent.status });
    }),
    bus.subscribe("call.ended", (event) =>
      broadcast(event.callId, { type: "call_ended", callId: event.callId, ts: event.ts })
    ),
  ];

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    notify(notification) {
      let delivered = 0;
      for (const ws of subscriptions.keys()) {
        if (ws.readyState !== ws.OPEN) continue;
        send(ws, notification);
        delivered += 1;
      }
      return delivered;
    },
    get clientCount() {
      return subscriptions.size;
    },
    close() {
      for (const off of unsubscribes) off();
      for (const ws of subscriptions.keys()) ws.close();
      subscriptions.clear();
      wss.close();
    },
  };
}
