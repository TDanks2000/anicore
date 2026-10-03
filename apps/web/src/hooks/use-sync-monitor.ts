import {
  SyncMonitorClient,
  type SyncMonitorConfigResponse,
  type SyncMonitorEvent,
  type SyncMonitorSnapshotResponse,
  type SyncMonitorStatusResponse,
} from "@anicore/sync-monitor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nextPollDelay } from "@/lib/polling";
import { readStored, writeStored } from "@/lib/storage";

const DEFAULT_API_URL = import.meta.env.VITE_ANICORE_API_URL?.trim() || "http://localhost:3000";
const configuredPollMs = Number(import.meta.env.VITE_SYNC_MONITOR_POLL_MS);
const POLL_MS =
  Number.isFinite(configuredPollMs) && configuredPollMs >= 1000 ? configuredPollMs : 2500;
const IDLE_POLL_MS = Math.max(POLL_MS, 5000);
const MAX_BACKOFF_MS = 20_000;
const EVENT_LIMIT = 80;
const TIMING = { activeMs: POLL_MS, idleMs: IDLE_POLL_MS, maxBackoffMs: MAX_BACKOFF_MS };

export type ConnectionState = "idle" | "loading" | "ready" | "error";

/**
 * Connection settings plus a polling snapshot of the monitor API. The code is
 * kept in session storage only, so it is never persisted across sessions or
 * compiled into the bundle.
 *
 * Polling is single-flight (one request at a time), aborts in-flight requests on
 * unmount or URL change, backs off on failures, and keeps the last good data
 * with a `stale` flag instead of blanking the dashboard.
 */
export function useSyncMonitor() {
  const [apiUrl, setApiUrl] = useState(() =>
    readStored("local", "anicore.apiUrl", DEFAULT_API_URL),
  );
  const [accessCode, setAccessCode] = useState(() =>
    readStored("session", "anicore.monitorCode", ""),
  );
  const [statusPayload, setStatusPayload] = useState<SyncMonitorStatusResponse | null>(null);
  const [configPayload, setConfigPayloadState] = useState<SyncMonitorConfigResponse | null>(null);
  const [events, setEvents] = useState<SyncMonitorEvent[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const refreshingRef = useRef(false);
  const rerunRef = useRef(false);
  const failuresRef = useRef(0);
  const activeRef = useRef(false);
  const revisionRef = useRef<string | null>(null);
  const runtimeStampRef = useRef<string | null>(null);
  const hasDataRef = useRef(false);

  useEffect(() => writeStored("local", "anicore.apiUrl", apiUrl), [apiUrl]);
  useEffect(() => writeStored("session", "anicore.monitorCode", accessCode), [accessCode]);

  const client = useMemo(
    () => (apiUrl && accessCode ? new SyncMonitorClient({ baseUrl: apiUrl, accessCode }) : null),
    [apiUrl, accessCode],
  );

  // Switching servers must not keep showing the previous server's data.
  useEffect(() => {
    generation.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    refreshingRef.current = false;
    rerunRef.current = false;
    failuresRef.current = 0;
    activeRef.current = false;
    revisionRef.current = null;
    runtimeStampRef.current = null;
    hasDataRef.current = false;
    setStatusPayload(null);
    setConfigPayloadState(null);
    setEvents([]);
    setStale(false);
    setError(null);
    setConnectionState(client ? "loading" : "idle");
  }, [client]);

  const applySnapshot = useCallback((snapshot: SyncMonitorSnapshotResponse) => {
    activeRef.current = snapshot.active;
    // Idle ticks repeat the same revision; skip the state writes (and renders).
    if (snapshot.revision === revisionRef.current) return;
    revisionRef.current = snapshot.revision;

    // A response older than the config we already have must not undo a save.
    const stamp = snapshot.config.runtime.updatedAt;
    const latest = runtimeStampRef.current;
    if (latest === null || stamp >= latest) {
      runtimeStampRef.current = stamp;
      setConfigPayloadState({ ...snapshot.config, automation: snapshot.automation });
    }

    setStatusPayload({
      status: snapshot.status,
      active: snapshot.active,
      control: snapshot.control,
      files: snapshot.files,
    });
    setEvents(snapshot.events);
    hasDataRef.current = true;
  }, []);

  const refresh = useCallback(
    async (force = false) => {
      if (!client) {
        generation.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        refreshingRef.current = false;
        rerunRef.current = false;
        failuresRef.current = 0;
        setConnectionState("idle");
        setStale(false);
        setError(null);
        return;
      }

      if (refreshingRef.current) {
        if (force) rerunRef.current = true;
        return;
      }

      const gen = ++generation.current;
      const controller = new AbortController();
      abortRef.current = controller;
      refreshingRef.current = true;
      if (!hasDataRef.current) setConnectionState("loading");

      try {
        const snapshot = await client.getSnapshot(EVENT_LIMIT, controller.signal);
        if (gen !== generation.current) return;
        applySnapshot(snapshot);
        failuresRef.current = 0;
        setLastRefresh(new Date().toISOString());
        setError(null);
        setStale(false);
        setConnectionState("ready");
      } catch (err) {
        if (controller.signal.aborted || gen !== generation.current) return;
        failuresRef.current += 1;
        setError(err instanceof Error ? err.message : String(err));
        if (hasDataRef.current) {
          setStale(true);
          setConnectionState("ready");
        } else {
          setConnectionState("error");
        }
      } finally {
        if (gen === generation.current) {
          refreshingRef.current = false;
          abortRef.current = null;
          if (rerunRef.current) {
            rerunRef.current = false;
            void refresh(false);
          }
        }
      }
    },
    [applySnapshot, client],
  );

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, delay);
    };

    const scheduleNext = () => {
      schedule(nextPollDelay(failuresRef.current, activeRef.current, TIMING));
    };

    const run = () => {
      if (cancelled) return;
      if (document.hidden) {
        schedule(IDLE_POLL_MS);
        return;
      }
      void refresh().finally(scheduleNext);
    };

    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      void refresh(true).finally(scheduleNext);
    };

    void refresh().finally(scheduleNext);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      generation.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      refreshingRef.current = false;
      rerunRef.current = false;
    };
  }, [client, refresh]);

  const setConfigPayload = useCallback((next: SyncMonitorConfigResponse) => {
    runtimeStampRef.current = next.runtime.updatedAt;
    setConfigPayloadState(next);
  }, []);

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
    stale,
    error,
    lastRefresh,
    refresh,
  };
}

export type SyncMonitorState = ReturnType<typeof useSyncMonitor>;
