import type { SyncMonitorEvent } from "@anicore/sync-monitor";
import { AlertTriangle, CircleAlert, Info, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL_STYLES = {
  error: {
    icon: CircleAlert,
    iconClass: "text-destructive",
    badgeClass: "bg-destructive/12 text-destructive",
    rowClass: "border-destructive/30 bg-destructive/[0.04]",
  },
  warn: {
    icon: AlertTriangle,
    iconClass: "text-warning",
    badgeClass: "bg-warning/16 text-warning",
    rowClass: "border-warning/30 bg-warning/[0.04]",
  },
  info: {
    icon: Info,
    iconClass: "text-muted-foreground",
    badgeClass: "bg-secondary text-secondary-foreground",
    rowClass: "border-border bg-muted/30",
  },
} as const;

export function EventsCard({ events }: { events: SyncMonitorEvent[] }) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  // Newest first. Identical events (same timestamp and text) can legitimately
  // repeat, so the key is content-based with an occurrence suffix.
  const occurrences = new Map<string, number>();
  const newestFirst = events
    .map((event) => {
      const base = `${event.at}|${event.pid ?? ""}|${event.event ?? ""}|${event.message}`;
      const seen = occurrences.get(base) ?? 0;
      occurrences.set(base, seen + 1);
      return { event, key: `${base}#${seen}` };
    })
    .reverse()
    .filter(
      ({ event }) =>
        (level === "all" || event.level === level) &&
        `${event.message} ${event.anilistId ?? ""} ${event.stage ?? ""} ${event.event ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Sync Logs</CardTitle>
            <CardDescription>Recent sync activity updates automatically.</CardDescription>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
            <TerminalSquare />
            {newestFirst.length} / {events.length}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <Input
            aria-label="Search logs"
            placeholder="Search message, ID, or stage…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select aria-label="Log level" value={level} onValueChange={setLevel}>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
            <SelectItem value="warn">Warnings</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </Select>
        </div>
        <div className="flex max-h-[65vh] flex-col gap-1.5 overflow-auto pr-1">
          {newestFirst.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
              <TerminalSquare className="size-5 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                {events.length ? "No matching logs" : "No events yet"}
              </p>
            </div>
          ) : (
            newestFirst.map(({ event, key }) => <EventRow key={key} event={event} />)
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventRow({ event }: { event: SyncMonitorEvent }) {
  const style = LEVEL_STYLES[event.level ?? "info"];
  const Icon = style.icon;

  return (
    <div className={cn("rounded-md border px-3 py-2.5 text-sm transition-colors", style.rowClass)}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", style.iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 flex-1 break-words font-medium leading-snug">
              {event.message}
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                style.badgeClass,
              )}
            >
              {event.level}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{formatDate(event.at)}</span>
            {event.anilistId ? <span className="font-mono">ID {event.anilistId}</span> : null}
            {event.stage ? <span>{event.stage}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
