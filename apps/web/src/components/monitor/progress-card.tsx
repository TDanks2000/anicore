import type { SyncMonitorStatus } from "@anicore/sync-monitor";
import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { completionPercent, formatMs, statusVariant } from "@/lib/format";
import { displayRunState } from "@/lib/monitor-state";
import { Stat } from "./stats";

export function ProgressCard(props: {
  status: SyncMonitorStatus | null;
  active: boolean;
  loading: boolean;
}) {
  const { status } = props;
  const completion = completionPercent(status);
  const runState = displayRunState(status, props.active);
  const { toast } = useToast();
  const lastError = status?.lastError ?? null;

  useEffect(() => {
    if (lastError) {
      toast({
        id: "sync-run-error",
        variant: "error",
        title: "Latest sync error",
        description: lastError,
        durationMs: 10_000,
      });
    }
  }, [lastError, toast]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Run Progress</CardTitle>
            <CardDescription>
              {status
                ? `${status.mode} · index ${status.startIndex} → ${status.endIndex}`
                : "Waiting for a monitor status file"}
            </CardDescription>
          </div>
          <Badge variant={statusVariant(runState ?? undefined)}>
            <span className="capitalize">{runState ?? "idle"}</span>
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {props.loading && !status ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-4xl font-semibold tracking-tight tabular-nums">
                  {completion}
                  <span className="ml-0.5 text-2xl text-muted-foreground">%</span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Current ID{" "}
                  <span className="font-mono text-foreground">
                    {status?.currentAnilistId ?? "—"}
                  </span>
                </div>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                <div className="font-medium text-foreground">
                  {status?.currentStage ?? "No active stage"}
                </div>
                <div>{props.active ? "Active process" : "No active process detected"}</div>
              </div>
            </div>
            <Progress value={completion} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Created" value={status?.stats.created ?? 0} tone="success" />
              <Stat label="Updated" value={status?.stats.updated ?? 0} />
              <Stat
                label="Failed"
                value={status?.stats.failed ?? 0}
                tone={(status?.stats.failed ?? 0) > 0 ? "destructive" : "default"}
              />
              <Stat label="Skipped" value={status?.stats.skipped ?? 0} />
            </div>
            {status ? <RuntimeSnapshot status={status} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeSnapshot({ status }: { status: SyncMonitorStatus }) {
  const batch = status.activeBatch;
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-muted/40 p-4 text-sm lg:grid-cols-2">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Elapsed
        </div>
        <div className="mt-1 font-medium tabular-nums">{formatMs(status.progress?.elapsedMs)}</div>
      </div>
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Batch
        </div>
        <div className="mt-1 font-medium tabular-nums">
          {batch
            ? `${batch.startIndex}–${batch.endIndex - 1} @ ×${batch.concurrency}`
            : "No active batch"}
        </div>
      </div>
      {batch ? (
        <div className="min-w-0 lg:col-span-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Batch IDs
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {batch.ids.join(", ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
