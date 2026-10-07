import { ConnectionSection } from "@/components/monitor/connection-section";
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
      <ConnectionSection
        apiUrl={monitor.apiUrl}
        onApiUrlChange={monitor.setApiUrl}
        accessCode={monitor.accessCode}
        onAccessCodeChange={monitor.setAccessCode}
        lastRefresh={monitor.lastRefresh}
        connectionState={monitor.connectionState}
        status={monitor.statusPayload?.status ?? null}
        active={monitor.statusPayload?.active ?? false}
      />
      <EventsCard events={monitor.events} />
    </>
  );
}
