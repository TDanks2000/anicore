import { ChevronDown, Server, Settings2 } from "lucide-react";
import { useState } from "react";
import { ConnectionSection } from "@/components/monitor/connection-section";
import { StatusDot } from "@/components/monitor/status-dot";
import type { SyncMonitorState } from "@/hooks/use-sync-monitor";

/** Connection details stay available without taking over each dashboard view. */
export function ConnectionBar({ monitor }: { monitor: SyncMonitorState }) {
  const [expanded, setExpanded] = useState(() => !monitor.client);
  const ready = monitor.connectionState === "ready" && !monitor.stale;
  const label = ready
    ? "Connected"
    : monitor.stale
      ? "Reconnecting"
      : monitor.connectionState === "loading"
        ? "Connecting"
        : monitor.error
          ? "Connection failed"
          : "Not connected";
  return (
    <details
      className="group rounded-lg border border-border bg-card"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-xs [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2 font-medium">
          <StatusDot
            tone={ready ? "success" : monitor.error ? "destructive" : "warning"}
            pulse={monitor.stale}
          />
          {label}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-2 text-muted-foreground sm:flex">
          <Server className="size-3.5 shrink-0" />
          <span className="truncate">{monitor.apiUrl || "No API configured"}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
          <Settings2 className="size-3.5" />
          Connection settings
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="border-t border-border p-4">
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
      </div>
      {monitor.error ? (
        <p role="alert" className="border-t border-border px-4 py-3 text-sm text-destructive">
          {monitor.error}
        </p>
      ) : null}
    </details>
  );
}
