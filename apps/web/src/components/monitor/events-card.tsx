import type { SyncMonitorEvent } from "@anicore/sync-monitor";
import {
  AlertTriangle,
  CircleAlert,
  Info,
  Pause,
  Play,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL_STYLES = {
  error: {
    icon: CircleAlert,
    iconClass: "text-destructive",
    badgeClass: "bg-destructive/12 text-destructive",
    rowClass: "border-l-destructive",
  },
  warn: {
    icon: AlertTriangle,
    iconClass: "text-warning",
    badgeClass: "bg-warning/16 text-warning",
    rowClass: "border-l-warning",
  },
  info: {
    icon: Info,
    iconClass: "text-muted-foreground",
    badgeClass: "bg-secondary text-secondary-foreground",
    rowClass: "border-l-transparent",
  },
} as const;

export function EventsCard({
  events,
  onClear,
  connected,
  lastRefresh,
}: {
  events: SyncMonitorEvent[];
  onClear: () => Promise<void>;
  connected: boolean;
  lastRefresh: string | null;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [pausedEvents, setPausedEvents] = useState<SyncMonitorEvent[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const displayed = pausedEvents ?? events;
  const counts = {
    all: displayed.length,
    error: displayed.filter((event) => event.level === "error").length,
    warn: displayed.filter((event) => event.level === "warn").length,
    info: displayed.filter((event) => event.level === "info").length,
  };
  const occurrences = new Map<string, number>();
  const newestFirst = displayed
    .map((event) => {
      const base = JSON.stringify(event);
      const seen = occurrences.get(base) ?? 0;
      occurrences.set(base, seen + 1);
      return { event, key: `${base}#${seen}` };
    })
    .reverse()
    .filter(
      ({ event }) =>
        (level === "all" || event.level === level) &&
        [event.message, event.anilistId, event.pid, event.stage, event.event]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );

  async function clear() {
    setClearing(true);
    setError("");
    try {
      await onClear();
      setPausedEvents(null);
      setQuery("");
      setLevel("all");
      setMessage("Saved logs cleared. New sync events will appear here.");
      setConfirmClear(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <TerminalSquare className="size-4" />
              </div>
              <div>
                <CardTitle>Sync activity</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pausedEvents
                    ? "Display paused · sync continues in the background"
                    : connected
                      ? "Live updates · newest first"
                      : "Waiting for a connection"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={clearing || (!pausedEvents && !displayed.length)}
                onClick={() => setPausedEvents(pausedEvents ? null : [...events])}
              >
                {pausedEvents ? <Play /> : <Pause />}
                {pausedEvents ? "Resume live" : "Pause display"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={!connected || clearing}
                onClick={() => {
                  setError("");
                  setConfirmClear(true);
                }}
              >
                <Trash2 />
                Clear logs
              </Button>
            </div>
          </div>
          <fieldset
            className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap"
            aria-label="Filter logs by level"
          >
            {(["all", "error", "warn", "info"] as const).map((value) => (
              <Button
                key={value}
                variant={level === value ? "secondary" : "ghost"}
                size="sm"
                className="justify-between sm:justify-center"
                aria-pressed={level === value}
                onClick={() => setLevel(value)}
              >
                {value === "all"
                  ? "All events"
                  : value === "error"
                    ? "Errors"
                    : value === "warn"
                      ? "Warnings"
                      : "Info"}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                    value === "error" && counts.error
                      ? "bg-destructive/10 text-destructive"
                      : value === "warn" && counts.warn
                        ? "bg-warning/10 text-warning"
                        : "bg-background text-muted-foreground",
                  )}
                >
                  {counts[value]}
                </span>
              </Button>
            ))}
          </fieldset>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Search logs"
              className="pl-9 pr-10"
              placeholder="Search messages, IDs, or stages…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 size-9"
                aria-label="Clear log search"
                onClick={() => setQuery("")}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {message ? (
            <p role="status" className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
              {message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {newestFirst.length.toLocaleString()} of {displayed.length.toLocaleString()} recent
              events
            </span>
            <span>
              {pausedEvents
                ? "Display paused"
                : lastRefresh
                  ? `Updated ${formatDate(lastRefresh)}`
                  : "No updates yet"}
            </span>
          </div>
          <div className="max-h-[65vh] overflow-auto rounded-lg border border-border">
            {newestFirst.length ? (
              newestFirst.map(({ event, key }) => <EventRow key={key} event={event} />)
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
                <TerminalSquare className="mb-1 size-7 text-muted-foreground/50" />
                <p className="text-sm font-medium">
                  {displayed.length ? "No matching events" : "No logs yet"}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {displayed.length
                    ? "Try another search or log level."
                    : connected
                      ? "New sync activity will appear here automatically."
                      : "Connect to your API to see sync activity."}
                </p>
                {displayed.length ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      setLevel("all");
                    }}
                  >
                    Reset filters
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      <Dialog
        open={confirmClear}
        onClose={() => {
          if (!clearing) setConfirmClear(false);
        }}
        labelledBy="clear-logs-title"
        className="max-w-md"
      >
        <div className="flex flex-col gap-4 p-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Trash2 className="size-5" />
          </div>
          <h2 id="clear-logs-title" className="text-lg font-semibold">
            Clear all saved logs?
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            This removes sync events and archived logs from the API host. Run progress and settings
            stay unchanged. New events will continue to appear.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={clearing} onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={clearing} onClick={() => void clear()}>
              {clearing ? "Clearing…" : "Clear all logs"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function EventRow({ event }: { event: SyncMonitorEvent }) {
  const style = LEVEL_STYLES[event.level ?? "info"];
  const Icon = style.icon;
  return (
    <div
      className={cn(
        "border-b border-l-2 border-b-border bg-card px-3 py-3 last:border-b-0 sm:px-4",
        style.rowClass,
      )}
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", style.iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className={cn("rounded px-1.5 py-0.5 font-semibold uppercase", style.badgeClass)}>
              {event.level}
            </span>
            <time dateTime={event.at} className="tabular-nums">
              {formatDate(event.at)}
            </time>
            {event.anilistId ? <span className="font-mono">ID {event.anilistId}</span> : null}
            {event.pid ? <span className="font-mono">PID {event.pid}</span> : null}
            {event.stage ? <span className="break-all">{event.stage}</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{event.message}</p>
        </div>
      </div>
    </div>
  );
}
