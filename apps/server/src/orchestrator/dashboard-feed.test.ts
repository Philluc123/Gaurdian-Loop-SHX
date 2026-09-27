// Drives the feed over a real WebSocket, so what's asserted is exactly what the
// React dashboard receives — including the ordering it depends on.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ClientMsg, GuardianEvent, ServerMsg } from "@guardian-loop/shared-types";
import { EventBus } from "../event-bus";
import { createOrchestrator, type Orchestrator } from "./index";
import { createDashboardFeed, type DashboardFeed } from "./dashboard-feed";

const guardian = { name: "Maria", phone: "+13055551234" };
const WS_PATH = "/ws/dashboard";

let bus: EventBus;
let orchestrator: Orchestrator;
let feed: DashboardFeed;
let server: http.Server;
let url: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  bus = new EventBus();
  orchestrator = createOrchestrator(bus, { tickMs: 60_000 }); // no decay noise
  feed = createDashboardFeed(bus, orchestrator);
  server = http.createServer();
  server.on("upgrade", (req, socket, head) => feed.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WS_PATH}`;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  feed.close();
  orchestrator.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A dashboard client that records every ServerMsg it receives. */
async function connect(subscription?: ClientMsg): Promise<{ ws: WebSocket; msgs: ServerMsg[] }> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const msgs: ServerMsg[] = [];
  ws.on("message", (data) => msgs.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  if (subscription) ws.send(JSON.stringify(subscription));
  await settle();
  return { ws, msgs };
}

/** Let in-flight socket messages land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const publish = async (...events: GuardianEvent[]) => {
  for (const e of events) bus.publish(e);
  await settle();
};

function start(callId: string): GuardianEvent {
  return { type: "call.started", callId, source: "webrtc", guardian, ts: Date.now() };
}

function final(callId: string, segmentId: string, text: string, speaker: "caller" | "victim" = "caller"): GuardianEvent {
  return { type: "transcript", callId, speaker, segmentId, text, isFinal: true, startMs: 0, endMs: 1000, ts: Date.now() };
}

const types = (msgs: ServerMsg[]) => msgs.map((m) => m.type);

describe("dashboard feed", () => {
  it("pushes a snapshot to a waiting dashboard when a call starts — without it the UI stays blank", async () => {
    const { msgs } = await connect({ type: "subscribe", callId: "latest" });
    expect(msgs).toHaveLength(0); // no call yet, nothing to show

    await publish(start("c1"));
    expect(msgs[0]).toMatchObject({ type: "snapshot", call: { callId: "c1", turns: [] } });
  });

  it("streams transcript, highlights and score for the followed call", async () => {
    const { msgs } = await connect({ type: "subscribe", callId: "latest" });
    await publish(start("c1"), final("c1", "s1", "Buy the gift cards and don't tell your daughter."));

    const t = types(msgs);
    expect(t[0]).toBe("snapshot");
    expect(t).toContain("transcript");
    expect(t).toContain("highlights");
    expect(t).toContain("score");

    const highlights = msgs.find((m) => m.type === "highlights");
    expect(highlights).toMatchObject({ segmentId: "s1", isFinal: true });
  });

  it("sends the alert, then re-sends it with its delivery status", async () => {
    const { msgs } = await connect({ type: "subscribe", callId: "latest" });
    await publish(start("c1"), final("c1", "s1", "Buy the gift cards and don't tell your daughter."));

    const alert = msgs.find((m) => m.type === "alert");
    expect(alert).toBeDefined();
    if (alert?.type !== "alert") return;

    await publish({
      type: "alert.sent", callId: "c1", alertId: alert.event.alertId,
      channel: "notification", status: "sent", ts: Date.now(),
    });
    const delivered = msgs.filter((m) => m.type === "alert").at(-1);
    expect(delivered).toMatchObject({ type: "alert", event: { alertId: alert.event.alertId }, delivery: "sent" });
  });

  it("gives a refreshed page the whole call so far, not just what comes next", async () => {
    await publish(start("c1"), final("c1", "s1", "Hello, this is Medicare."), final("c1", "s2", "Hi there.", "victim"));

    const { msgs } = await connect({ type: "subscribe", callId: "latest" });
    expect(msgs[0]).toMatchObject({ type: "snapshot", call: { callId: "c1" } });
    if (msgs[0].type === "snapshot") expect(msgs[0].call.turns).toHaveLength(2);
  });

  it("tells a late subscriber the call already ended", async () => {
    await publish(start("c1"), { type: "call.ended", callId: "c1", reason: "hangup", ts: Date.now() });
    const { msgs } = await connect({ type: "subscribe", callId: "c1" });
    expect(types(msgs)).toEqual(["snapshot", "call_ended"]);
  });

  it("moves a dashboard following 'latest' onto the next call", async () => {
    const { msgs } = await connect({ type: "subscribe", callId: "latest" });
    await publish(start("c1"), start("c2"), final("c2", "s1", "Hello."));

    const snapshots = msgs.filter((m) => m.type === "snapshot");
    expect(snapshots.map((s) => s.type === "snapshot" && s.call.callId)).toEqual(["c1", "c2"]);
    const transcript = msgs.find((m) => m.type === "transcript");
    expect(transcript?.type === "transcript" && transcript.event.callId).toBe("c2");
  });

  it("keeps a dashboard pinned to one call off every other call", async () => {
    await publish(start("c1"));
    const { msgs } = await connect({ type: "subscribe", callId: "c1" });
    const before = msgs.length;

    await publish(start("c2"), final("c2", "s1", "Buy the gift cards."));
    expect(msgs.slice(before)).toHaveLength(0);
  });

  it("drops a closed dashboard from its subscriber list", async () => {
    const { ws } = await connect({ type: "subscribe", callId: "latest" });
    expect(feed.clientCount).toBe(1);
    ws.close();
    await settle();
    expect(feed.clientCount).toBe(0);
  });

  it("ignores malformed client messages instead of dropping the connection", async () => {
    const { ws, msgs } = await connect();
    ws.send("not json");
    ws.send(JSON.stringify({ type: "subscribe", callId: "latest" }));
    await publish(start("c1"));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(types(msgs)).toContain("snapshot");
  });
});

describe("dashboard feed: guardian notifications (M3)", () => {
  const notification = {
    type: "notification" as const, callId: "c1", alertId: "c1:alert:1",
    title: "⚠️ Possible scam call (risk 82)", body: "Why: secrecy request.",
  };

  it("reaches every connected dashboard, whatever call it follows", async () => {
    await publish(start("c1"));
    const following = await connect({ type: "subscribe", callId: "latest" });
    const pinnedElsewhere = await connect({ type: "subscribe", callId: "some-other-call" });

    expect(feed.notify(notification)).toBe(2);
    await settle();
    for (const client of [following, pinnedElsewhere]) {
      expect(client.msgs.at(-1)).toEqual(notification);
    }
  });

  it("reports zero recipients when no dashboard is open", () => {
    expect(feed.notify(notification)).toBe(0);
  });
});
