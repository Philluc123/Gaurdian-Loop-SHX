// WebSocket client for /ws/dashboard (docs/module-contracts.md §3.8).
//
// Reconnects with capped backoff and re-sends `subscribe` on every open, so the
// server answers with a fresh `snapshot` and a refreshed or dropped page recovers the
// whole call rather than waiting for the next incremental update.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CallId, ClientMsg, ServerMsg } from "@guardian-loop/shared-types";
import { initialState, reduce, type DashboardState } from "./state";

declare const __DASHBOARD_WS_PATH__: string;

export type ConnectionStatus = "connecting" | "open" | "reconnecting";
export type Subscription = CallId | "latest";

export function dashboardWsUrl(): string {
  const override = import.meta.env.VITE_DASHBOARD_WS_URL as string | undefined;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${__DASHBOARD_WS_PATH__}`;
}

export class DashboardSocket {
  private ws?: WebSocket;
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private url: string,
    private subscription: Subscription,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (s: ConnectionStatus) => void
  ) {
    this.connect();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private connect() {
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus("open");
      this.send({ type: "subscribe", callId: this.subscription });
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data) as ServerMsg);
      } catch {
        console.warn("[ws] dropped unparseable message", e.data);
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.attempt++;
      this.onStatus("reconnecting");
      const delay = Math.min(5000, 250 * 2 ** this.attempt);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
}

/** Live dashboard state for one subscription, plus the client → server actions. */
export function useDashboard(subscription: Subscription) {
  const [state, dispatch] = useReducer(
    (s: DashboardState, msg: ServerMsg) => reduce(s, msg, Date.now()),
    initialState
  );
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socket = useRef<DashboardSocket>();

  useEffect(() => {
    const s = new DashboardSocket(dashboardWsUrl(), subscription, dispatch, setStatus);
    socket.current = s;
    return () => s.close();
  }, [subscription]);

  const ackAlert = useCallback((alertId: string) => {
    socket.current?.send({ type: "ack_alert", alertId });
  }, []);

  return { state, status, ackAlert };
}
