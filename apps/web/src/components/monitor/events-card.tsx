import type { SyncMonitorEvent } from "@anicore/sync-monitor";
import { TerminalSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export function EventsCard({ events }: { events: SyncMonitorEvent[] }) {
  // Newest first. Timestamps and messages can repeat, so the key includes the position.
  const newestFirst = events
    .map((event, index) => ({ event, key: `${index}-${event.at}` }))
    .reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Events</CardTitle>
        <CardDescription>Latest entries from `events.jsonl`.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
          {newestFirst.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
              No events loaded.
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
  return (
    <div
      className={cn(
        "rounded-md border bg-muted/30 p-3 text-sm",
        event.level === "error" && "border-destructive/40",
        event.level === "warn" && "border-warning/50",
        event.level === "info" && "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare />
          <span className="truncate font-medium">{event.message}</span>
        </div>
        <Badge variant={event.level === "error" ? "destructive" : "outline"}>{event.level}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{formatDate(event.at)}</span>
        {event.anilistId ? <span>ID {event.anilistId}</span> : null}
        {event.stage ? <span>{event.stage}</span> : null}
      </div>
    </div>
  );
}
