import { ConnectionSection } from "@/components/monitor/connection-section";
import { ResourcesCard } from "@/components/monitor/resources-card";
import type { SyncMonitorState } from "@/hooks/use-sync-monitor";

export function DataCacheView({ monitor }: { monitor: SyncMonitorState }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Data &amp; Cache</h1>
        <p className="text-sm text-muted-foreground">
          Manage cached data, AniList IDs, and proxy settings.
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
      <ResourcesCard
        key={`${monitor.apiUrl}:${monitor.accessCode}`}
        client={monitor.client}
        active={monitor.statusPayload?.active ?? false}
      />
    </>
  );
}
