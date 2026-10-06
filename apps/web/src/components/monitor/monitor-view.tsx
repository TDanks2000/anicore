import { Activity, Database, Layers, Timer } from "lucide-react";
import { useCallback, useEffect } from "react";

import { ConnectionSection } from "@/components/monitor/connection-section";
import { ControlsSection } from "@/components/monitor/controls-section";
import { EventsCard } from "@/components/monitor/events-card";
import { ProgressCard } from "@/components/monitor/progress-card";
import { ResourcesCard } from "@/components/monitor/resources-card";
import { RuntimeConfigCard } from "@/components/monitor/runtime-config-card";
import { MetricCard } from "@/components/monitor/stats";
import { StatusDot, type StatusTone } from "@/components/monitor/status-dot";
import { useToast } from "@/components/ui/toast";
import { useRuntimeConfigForm } from "@/hooks/use-runtime-config-form";
import type { SyncMonitorState } from "@/hooks/use-sync-monitor";
import { formatDuration, formatEta, formatRate } from "@/lib/format";
import { displayRunState } from "@/lib/monitor-state";
import { startOptionsFromDraft } from "@/lib/runtime-config-draft";

export interface ConnectionDisplay {
  label: string;
  tone: StatusTone;
  pulse: boolean;
}

function stateTone(state?: string): "default" | "primary" | "success" | "warning" | "destructive" {
  if (state === "running") return "primary";
  if (state === "completed") return "success";
  if (state === "failed") return "destructive";
  if (state === "paused") return "warning";
  return "default";
}

export function MonitorView({
  monitor,
  connection,
}: {
  monitor: SyncMonitorState;
  connection: ConnectionDisplay;
}) {
  const { client, statusPayload, configPayload, setConfigPayload, refresh } = monitor;

  const status = statusPayload?.status ?? null;
  const active = statusPayload?.active ?? false;
  const runtime = configPayload?.runtime ?? status?.runtimeConfig ?? null;
  // A process that died mid-run must not keep showing "paused"/"running".
  const runState = displayRunState(status, active);

  const form = useRuntimeConfigForm({
    client,
    runtime,
    onSaved: useCallback(
      async (next) => {
        setConfigPayload(next);
        await refresh(true);
      },
      [refresh, setConfigPayload],
    ),
  });

  const { toast } = useToast();
  useEffect(() => {
    if (monitor.error && !monitor.stale) {
      toast({
        id: "monitor-load",
        variant: "error",
        title: "Unable to load monitor",
        description: monitor.error,
      });
    }
  }, [monitor.error, monitor.stale, toast]);

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Sync Monitor</h1>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground sm:hidden">
              <StatusDot tone={connection.tone} pulse={connection.pulse} />
              {connection.label}
            </span>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Live status from the machine running the AniCore sync process.
          </p>
        </div>

        <ControlsSection
          client={client}
          status={status}
          control={statusPayload?.control ?? null}
          active={active}
          startOptions={runtime ? startOptionsFromDraft(form.draft) : {}}
          onChanged={() => refresh(true)}
          onControlled={monitor.applyControl}
        />
      </div>

      <ConnectionSection
        apiUrl={monitor.apiUrl}
        onApiUrlChange={monitor.setApiUrl}
        accessCode={monitor.accessCode}
        onAccessCodeChange={monitor.setAccessCode}
        lastRefresh={monitor.lastRefresh}
        connectionState={monitor.connectionState}
        status={status}
        active={active}
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={Activity}
          label="State"
          value={runState ?? "No run"}
          tone={stateTone(runState ?? undefined)}
          hint={formatDuration(status?.startedAt, status?.completedAt)}
        />
        <MetricCard
          icon={Database}
          label="Processed"
          value={(status?.progress?.processed ?? 0).toLocaleString()}
          hint={status ? `of ${status.total.toLocaleString()} IDs` : undefined}
        />
        <MetricCard
          icon={Layers}
          label="Remaining"
          value={(status?.progress?.remaining ?? 0).toLocaleString()}
          hint={status ? `${status.total.toLocaleString()} total` : undefined}
        />
        <MetricCard
          icon={Timer}
          label="ETA"
          value={formatEta(status?.progress?.etaSeconds)}
          hint={status ? formatRate(status?.progress?.ratePerMinute) : undefined}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start xl:grid-cols-[minmax(0,1fr)_460px]">
        <ProgressCard
          status={status}
          active={active}
          loading={monitor.connectionState === "loading"}
        />
        <div className="flex flex-col gap-4">
          <RuntimeConfigCard
            form={form}
            runtime={runtime}
            automation={configPayload?.automation ?? null}
          />
          <EventsCard events={monitor.events} />
        </div>
      </section>
      <ResourcesCard
        key={`${monitor.apiUrl}:${monitor.accessCode}`}
        client={client}
        active={active}
      />
    </>
  );
}
