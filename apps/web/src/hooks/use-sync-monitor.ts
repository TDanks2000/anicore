import {
  SyncMonitorClient,
  type SyncMonitorConfigResponse,
  type SyncMonitorEvent,
  type SyncMonitorStatusResponse,
} from "@anicore/sync-monitor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readStored, writeStored } from "@/lib/storage";

const DEFAULT_API_URL = import.meta.env.VITE_ANICORE_API_URL?.trim() || "http://localhost:3000";
const configuredPollMs = Number(import.meta.env.VITE_SYNC_MONITOR_POLL_MS);
const POLL_MS =
  Number.isFinite(configuredPollMs) && configuredPollMs >= 1000 ? configuredPollMs : 2500;
const EVENT_LIMIT = 80;

export type ConnectionState = "idle" | "loading" | "ready" | "error";

/**
 * Connection settings plus a polling snapshot of the monitor API. The code is
 * kept in session storage only, so it is never persisted across sessions or
 * compiled into the bundle.
 */
export function useSyncMonitor() {
  const [apiUrl, setApiUrl] = useState(() =>
    readStored("local", "anicore.apiUrl", DEFAULT_API_URL),
  );
  const [accessCode, setAccessCode] = useState(() =>
    readStored("session", "anicore.monitorCode", ""),
  );
  const [statusPayload, setStatusPayload] = useState<SyncMonitorStatusResponse | null>(null);
  const [configPayload, setConfigPayload] = useState<SyncMonitorConfigResponse | null>(null);
  const [events, setEvents] = useState<SyncMonitorEvent[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  // Responses from a superseded refresh (e.g. after the URL changed) are dropped.
  const sequence = useRef(0);
  const inFlight = useRef<number | null>(null);

  useEffect(() => writeStored("local", "anicore.apiUrl", apiUrl), [apiUrl]);
  useEffect(() => writeStored("session", "anicore.monitorCode", accessCode), [accessCode]);

  const client = useMemo(
    () => (apiUrl && accessCode ? new SyncMonitorClient({ baseUrl: apiUrl, accessCode }) : null),
    [apiUrl, accessCode],
  );

  const refresh = useCallback(
    async (force = false) => {
      if (!client) {
        sequence.current++;
        setConnectionState("idle");
        setError("Enter the API URL and monitor code to connect.");
        return;
      }
      if (inFlight.current !== null && !force) return;

      const current = ++sequence.current;
      inFlight.current = current;
      setConnectionState((state) => (state === "ready" ? "ready" : "loading"));

      try {
        const [nextStatus, nextEvents, nextConfig] = await Promise.all([
          client.getStatus(),
          client.getEvents(EVENT_LIMIT),
          client.getConfig(),
        ]);
        if (current !== sequence.current) return;
        setStatusPayload(nextStatus);
        setEvents(nextEvents.events);
        setConfigPayload(nextConfig);
        setLastRefresh(new Date().toISOString());
        setError(null);
        setConnectionState("ready");
      } catch (err) {
        if (current !== sequence.current) return;
        setConnectionState("error");
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (inFlight.current === current) inFlight.current = null;
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh();
    if (!client) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(interval);
      sequence.current++;
    };
  }, [client, refresh]);

  return {
    apiUrl,
    setApiUrl,
    accessCode,
    setAccessCode,
    client,
    statusPayload,
    configPayload,
    setConfigPayload,
    events,
    connectionState,
    error,
    lastRefresh,
    refresh,
  };
}
