import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  Moon,
  PlugZap,
  RefreshCw,
  Sun,
} from "lucide-react";
import { useCallback } from "react";

import { ConnectionSection } from "@/components/monitor/connection-section";
import { ControlsSection } from "@/components/monitor/controls-section";
import { EventsCard } from "@/components/monitor/events-card";
import { ProgressCard } from "@/components/monitor/progress-card";
import { RuntimeConfigCard } from "@/components/monitor/runtime-config-card";
import { MetricCard } from "@/components/monitor/stats";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRuntimeConfigForm } from "@/hooks/use-runtime-config-form";
import { type ConnectionState, useSyncMonitor } from "@/hooks/use-sync-monitor";
import { formatDuration } from "@/lib/format";
import { useTheme } from "./theme-provider";

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: "Idle",
  loading: "Connecting",
  ready: "Connected",
  error: "Needs attention",
};

export function App() {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const monitor = useSyncMonitor();
  const { client, statusPayload, configPayload, setConfigPayload, refresh } = monitor;

  const status = statusPayload?.status ?? null;
  const active = statusPayload?.active ?? false;
  const runtime = configPayload?.runtime ?? status?.runtimeConfig ?? null;

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

  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="grid gap-4 border-b border-border pb-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">AniCore</Badge>
              <Badge variant={monitor.connectionState === "ready" ? "secondary" : "outline"}>
                {CONNECTION_LABELS[monitor.connectionState]}
              </Badge>
            </div>
            <div>
              <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">Sync Monitor</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Live status from the machine running the AniCore sync process.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label={`Switch to ${nextTheme} mode`}
              onClick={() => setTheme(nextTheme)}
              title={`Theme: ${theme}`}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button variant="outline" onClick={() => void refresh(true)}>
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </header>

        <ConnectionSection
          apiUrl={monitor.apiUrl}
          onApiUrlChange={monitor.setApiUrl}
          accessCode={monitor.accessCode}
          onAccessCodeChange={monitor.setAccessCode}
          lastRefresh={monitor.lastRefresh}
        />

        {monitor.error ? (
          <Alert className="border-destructive/40">
            <AlertTriangle />
            <AlertTitle>Unable to load monitor</AlertTitle>
            <AlertDescription>{monitor.error}</AlertDescription>
          </Alert>
        ) : null}

        <ControlsSection
          client={client}
          status={status}
          control={statusPayload?.control ?? null}
          active={active}
          onChanged={() => refresh(true)}
        />

        <section className="grid gap-4 lg:grid-cols-4">
          <MetricCard icon={Activity} label="State" value={status?.state ?? "No run"} />
          <MetricCard
            icon={Database}
            label="Processed"
            value={(status?.progress?.processed ?? 0).toLocaleString()}
          />
          <MetricCard
            icon={Clock3}
            label="Elapsed"
            value={formatDuration(status?.startedAt, status?.completedAt)}
          />
          <MetricCard
            icon={PlugZap}
            label="Parallel"
            value={runtime ? `x${runtime.parallel}` : "Unknown"}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
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
      </div>
    </main>
  );
}
