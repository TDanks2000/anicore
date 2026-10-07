import { ConnectionBar } from "@/components/monitor/connection-bar";
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
      <ConnectionBar monitor={monitor} />
      <ResourcesCard
        key={`${monitor.apiUrl}:${monitor.accessCode}`}
        client={monitor.client}
        active={monitor.statusPayload?.active ?? false}
      />
    </>
  );
}
