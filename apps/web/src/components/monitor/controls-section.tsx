import {
  isControlPending,
  type SyncMonitorClient,
  type SyncMonitorControlResponse,
  type SyncMonitorControlState,
  SyncMonitorRequestError,
  type SyncMonitorStatus,
} from "@anicore/sync-monitor";
import { CircleCheck, Loader2, Pause, Play, Square } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { syncControlMode } from "@/lib/monitor-state";

type ControlName = "start" | "pause" | "resume" | "stop";

export function ControlsSection(props: {
  client: SyncMonitorClient | null;
  status: SyncMonitorStatus | null;
  control: SyncMonitorControlState | null;
  active: boolean;
  onChanged: () => Promise<void>;
  onControlled: (response: SyncMonitorControlResponse) => void;
}) {
  const { client, status, control, active } = props;
  const [busy, setBusy] = useState<ControlName | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { toast } = useToast();

  const mode = syncControlMode({ active, status, control });
  const disabled = !client || busy !== null;
  const pending = active && isControlPending(control);
  // The loop acknowledges pause/stop; while pending we spin on that exact button.
  const pendingName = pending ? (control?.command as ControlName | undefined) : undefined;

  async function run(name: ControlName, successMessage: string) {
    if (!client) return;
    setBusy(name);
    setMessage(null);
    try {
      const response = await client[name]();
      props.onControlled(response);
      setMessage(successMessage);
      void props.onChanged();
    } catch (err) {
      if (err instanceof SyncMonitorRequestError && err.status === 409) {
        // The process changed between the last poll and this click — for
        // example it was stopped from a terminal. Refresh and report calmly
        // instead of showing the stale-state conflict as a failure.
        toast({
          id: "sync-control",
          variant: "info",
          title: err.detail ?? "The sync state changed",
          description: "The status was refreshed.",
        });
        await props.onChanged();
        return;
      }
      toast({
        id: "sync-control",
        variant: "error",
        title: "Sync control failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  const showSpinner = (name: ControlName) => busy === name || pendingName === name;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {mode === "pause" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void run("pause", "Pause requested.")}
        >
          {showSpinner("pause") ? <Loader2 className="animate-spin" /> : <Pause />}
          {showSpinner("pause") ? "Pausing…" : "Pause"}
        </Button>
      ) : mode === "resume" ? (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => void run("resume", "Resume requested.")}
        >
          {showSpinner("resume") ? <Loader2 className="animate-spin" /> : <Play />}
          {showSpinner("resume") ? "Resuming…" : "Resume"}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => void run("start", "Sync start requested.")}
        >
          {showSpinner("start") ? <Loader2 className="animate-spin" /> : <Play />}
          {showSpinner("start") ? "Starting…" : "Start"}
        </Button>
      )}

      <Button
        size="sm"
        variant="destructive"
        disabled={disabled || !active}
        onClick={() => void run("stop", "Stop requested.")}
      >
        {showSpinner("stop") ? <Loader2 className="animate-spin" /> : <Square />}
        {showSpinner("stop") ? "Stopping…" : "Stop"}
      </Button>

      {message ? (
        <div
          role="status"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
        >
          <CircleCheck className="size-3.5 shrink-0 text-success" />
          <span>{message}</span>
        </div>
      ) : null}
    </div>
  );
}
