import type {
  SyncMonitorClient,
  SyncMonitorControlState,
  SyncMonitorStatus,
} from "@anicore/sync-monitor";
import { Pause, Play, Square } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { KeyValue, Stat } from "./stats";

type ControlName = "start" | "pause" | "resume" | "stop";

export function ControlsSection(props: {
  client: SyncMonitorClient | null;
  status: SyncMonitorStatus | null;
  control: SyncMonitorControlState | null;
  active: boolean;
  onChanged: () => Promise<void>;
}) {
  const { client, status, control, active } = props;
  const [busy, setBusy] = useState<ControlName | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const paused = status?.state === "paused" || control?.command === "pause";
  const disabled = !client || busy !== null;

  async function run(name: ControlName, successMessage: string) {
    if (!client) return;
    setBusy(name);
    setMessage(null);
    try {
      if (name === "start") await client.start();
      else await client[name]();
      setMessage(successMessage);
      await props.onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader>
          <CardTitle>Sync Controls</CardTitle>
          <CardDescription>
            Commands are written through the monitor API and applied by the sync loop.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || active}
              onClick={() => void run("start", "Sync start requested.")}
            >
              <Play data-icon="inline-start" />
              {active ? "Running" : "Start"}
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !active || paused}
              onClick={() => void run("pause", "Pause requested.")}
            >
              <Pause data-icon="inline-start" />
              Pause
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !active || !paused}
              onClick={() => void run("resume", "Resume requested.")}
            >
              <Play data-icon="inline-start" />
              Resume
            </Button>
            <Button
              variant="destructive"
              disabled={disabled || !active}
              onClick={() => void run("stop", "Stop requested.")}
            >
              <Square data-icon="inline-start" />
              Stop
            </Button>
          </div>
          {message ? (
            <Alert>
              <AlertTitle>Control update</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <Stat label="Command" value={control?.command ?? "None"} />
            <Stat label="Requested" value={formatDate(control?.requestedAt)} />
            <Stat label="Active" value={active ? "Yes" : "No"} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run State</CardTitle>
          <CardDescription>Latest monitor process projection from the API.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <KeyValue label="PID">{status?.pid ?? "None"}</KeyValue>
          <KeyValue label="Mode">{status?.mode ?? "Idle"}</KeyValue>
          <KeyValue label="Stage">{status?.currentStage ?? "No active stage"}</KeyValue>
        </CardContent>
      </Card>
    </section>
  );
}
