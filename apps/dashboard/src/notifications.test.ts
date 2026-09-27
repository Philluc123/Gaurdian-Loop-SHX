import { describe, expect, it } from "vitest";
import type { ServerMsg } from "@guardian-loop/shared-types";
import { liveViewPath } from "./notifications";
import { initialState, reduce } from "./state";

const notification: ServerMsg = {
  type: "notification",
  callId: "c1",
  alertId: "c1:alert:1",
  title: "⚠️ Possible scam call (risk 82)",
  body: "Why: secrecy request.",
  url: "https://server.example/call/c1",
};

describe("guardian notifications", () => {
  it("never changes what the dashboard shows — the banner comes from the alert message", () => {
    const snapshot: ServerMsg = {
      type: "snapshot",
      call: { callId: "c1", startedAt: 0, turns: [], score: 0, level: "low", signals: [], highlights: [], alerts: [] },
    };
    const state = reduce(initialState, snapshot, 0);
    expect(reduce(state, notification, 1)).toBe(state);
    expect(reduce(initialState, notification, 1)).toBe(initialState);
  });

  it("opens the dashboard's own live view of the call, not the server's url", () => {
    expect(liveViewPath("c1")).toBe("/call/c1");
    expect(liveViewPath("a/b c")).toBe("/call/a%2Fb%20c");
  });
});
