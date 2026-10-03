import type { SyncMonitorStatus } from "@anicore/sync-monitor";
import { Activity, Server, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ConnectionState } from "@/hooks/use-sync-monitor";
import { formatDate } from "@/lib/format";
import { KeyValue } from "./stats";
import { StatusDot, type StatusTone } from "./status-dot";

const AUTH_TONE: Record<ConnectionState, StatusTone> = {
  idle: "neutral",
  loading: "warning",
  ready: "success",
  error: "destructive",
};

const STATE_TONE: Record<string, StatusTone> = {
  running: "primary",
  completed: "success",
  failed: "destructive",
  paused: "warning",
};

export function ConnectionSection(props: {
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  accessCode: string;
  onAccessCodeChange: (value: string) => void;
  lastRefresh: string | null;
  connectionState: ConnectionState;
  status: SyncMonitorStatus | null;
  active: boolean;
}) {
  const { status } = props;
  const tone = STATE_TONE[status?.state ?? ""] ?? "neutral";

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,320px)_minmax(240px,320px)]">
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Point this app at the API host exposing `/sync-monitor`.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(200px,300px)]">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            API URL
            <Input
              value={props.apiUrl}
              onChange={(event) => props.onApiUrlChange(event.target.value)}
              placeholder="http://192.168.1.45:3000"
              autoComplete="url"
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Monitor code
            <Input
              value={props.accessCode}
              onChange={(event) => props.onAccessCodeChange(event.target.value)}
              placeholder="Paste access code"
              type="password"
              autoComplete="current-password"
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>
            {props.lastRefresh
              ? `Last refresh ${formatDate(props.lastRefresh)}`
              : "Not refreshed yet"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <KeyValue
            label={
              <>
                <Server />
                API
              </>
            }
          >
            <span className="max-w-44 font-mono text-xs">{props.apiUrl}</span>
          </KeyValue>
          <KeyValue
            label={
              <>
                <ShieldCheck />
                Auth
              </>
            }
          >
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={props.accessCode ? AUTH_TONE[props.connectionState] : "neutral"} />
              {props.accessCode ? "Code set" : "Missing"}
            </span>
          </KeyValue>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run State</CardTitle>
          <CardDescription>Latest monitor process projection.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <KeyValue
            label={
              <>
                <Activity />
                State
              </>
            }
          >
            <span className="inline-flex items-center gap-2">
              <StatusDot tone={tone} pulse={props.active} />
              <span className="capitalize">{status?.state ?? "No run"}</span>
            </span>
          </KeyValue>
          <KeyValue label="PID">{status?.pid ?? "None"}</KeyValue>
          <KeyValue label="Mode">{status?.mode ?? "Idle"}</KeyValue>
          <KeyValue label="Started">{formatDate(status?.startedAt)}</KeyValue>
        </CardContent>
      </Card>
    </section>
  );
}
