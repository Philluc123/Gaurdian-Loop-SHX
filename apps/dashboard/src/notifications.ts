// Guardian notifications (docs/module-contracts.md §3.7): raises the server's
// `notification` messages as browser notifications.
//
// Runs its own always-on connection, separate from the Live page's, so the guardian
// is alerted wherever they are in the app — the History page included. That
// connection follows no call: the server sends notifications to every dashboard
// regardless of what it follows, so it receives those and nothing else.

import { useCallback, useEffect, useState } from "react";
import type { ServerMsg } from "@guardian-loop/shared-types";
import { navigate } from "./router";
import { DashboardSocket, dashboardWsUrl } from "./ws-client";

export type AlertPermission = NotificationPermission | "unsupported";

type NotificationMsg = Extract<ServerMsg, { type: "notification" }>;

/**
 * Subscribing to a callId that can't exist means the server sends this connection
 * no call traffic at all — just the notifications it broadcasts to everyone.
 */
const NOTIFICATIONS_ONLY = "~notifications-only";

function currentPermission(): AlertPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** The dashboard's own live view of that call; `url` from the server is ignored. */
export function liveViewPath(callId: string): string {
  return `/call/${encodeURIComponent(callId)}`;
}

function show(msg: NotificationMsg): void {
  if (currentPermission() !== "granted") return; // the in-page banner still shows it
  const n = new Notification(msg.title, {
    body: msg.body,
    // Same tag replaces instead of stacking, so a retry or a second open tab
    // doesn't pile up duplicates.
    tag: msg.alertId,
    // Stay on screen until the guardian deals with it, where the OS allows.
    requireInteraction: true,
  });
  n.onclick = () => {
    window.focus();
    navigate(liveViewPath(msg.callId));
    n.close();
  };
}

/**
 * Keeps the notification connection open for the app's lifetime, and exposes the
 * permission state plus a way to ask for it.
 */
export function useAlertNotifications() {
  const [permission, setPermission] = useState<AlertPermission>(currentPermission);

  useEffect(() => {
    const socket = new DashboardSocket(
      dashboardWsUrl(),
      NOTIFICATIONS_ONLY,
      (msg) => {
        if (msg.type === "notification") show(msg);
      },
      () => {}
    );
    return () => socket.close();
  }, []);

  // Browsers only allow the permission prompt from a user gesture, so this must be
  // called from a click, never on page load.
  const request = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }, []);

  return { permission, request };
}
