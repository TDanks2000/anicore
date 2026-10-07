import { ConnectionBar } from "@/components/monitor/connection-bar";
import { EventsCard } from "@/components/monitor/events-card";
import type { SyncMonitorState } from "@/hooks/use-sync-monitor";

export function LogsView({ monitor }: { monitor: SyncMonitorState }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground">
          Live sync events, warnings, and errors, newest first.
        </p>
      </div>
      <ConnectionBar monitor={monitor} />
      <EventsCard
        key={`${monitor.apiUrl}:${monitor.accessCode}`}
        events={monitor.events}
        onClear={monitor.clearLogs}
        connected={monitor.connectionState === "ready" && !monitor.stale}
        lastRefresh={monitor.lastRefresh}
      />
    </>
  );
}
