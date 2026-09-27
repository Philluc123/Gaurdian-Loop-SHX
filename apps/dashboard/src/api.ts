// Call history REST (docs/module-contracts.md §3.8), served by the event store.

import { useEffect, useState } from "react";
import type { CallRecord, CallSummary } from "@guardian-loop/shared-types";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(res.status === 404 ? "Call not found" : `Request failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchCalls = () => getJson<CallSummary[]>("/api/calls");
export const fetchCall = (callId: string) => getJson<CallRecord>(`/api/calls/${encodeURIComponent(callId)}`);

export type Loadable<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; data: T };

/** Runs `load` whenever `key` changes; `refreshMs` re-polls without flashing a spinner. */
export function useLoad<T>(load: () => Promise<T>, key: string, refreshMs?: number): Loadable<T> {
  const [value, setValue] = useState<Loadable<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setValue({ status: "loading" });
    const run = () =>
      load().then(
        (data) => !cancelled && setValue({ status: "ok", data }),
        (e: Error) => !cancelled && setValue({ status: "error", error: e.message })
      );
    void run();
    const timer = refreshMs ? setInterval(run, refreshMs) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, refreshMs]); // `load` is intentionally keyed by `key`, not identity

  return value;
}
