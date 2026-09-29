import type { SyncMonitorStatus } from "@anicore/sync-monitor";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { completionPercent, formatEta, formatMs, formatRate, statusVariant } from "@/lib/format";
import { Stat } from "./stats";

export function ProgressCard(props: {
  status: SyncMonitorStatus | null;
  active: boolean;
  loading: boolean;
}) {
  const { status } = props;
  const completion = completionPercent(status);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Run Progress</CardTitle>
            <CardDescription>
              {status
                ? `${status.mode} from index ${status.startIndex} to ${status.endIndex}`
                : "Waiting for a monitor status file"}
            </CardDescription>
          </div>
          <Badge variant={statusVariant(status?.state)}>{status?.state ?? "idle"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {props.loading && !status ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-4xl font-semibold tracking-normal">{completion}%</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Current ID: {status?.currentAnilistId ?? "Not available"}
                </div>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                <div>{status?.currentStage ?? "No active stage"}</div>
                <div>{props.active ? "Active process" : "No active process detected"}</div>
              </div>
            </div>
            <Progress value={completion} />
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Created" value={status?.stats.created ?? 0} />
              <Stat label="Updated" value={status?.stats.updated ?? 0} />
              <Stat label="Failed" value={status?.stats.failed ?? 0} />
              <Stat label="Remaining" value={status?.progress?.remaining ?? 0} />
              <Stat label="Rate" value={formatRate(status?.progress?.ratePerMinute)} />
              <Stat label="ETA" value={formatEta(status?.progress?.etaSeconds)} />
            </div>
            {status ? <RuntimeSnapshot status={status} /> : null}
            {status?.lastError ? (
              <Alert className="border-destructive/40">
                <AlertTitle>Latest error</AlertTitle>
                <AlertDescription>{status.lastError}</AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeSnapshot({ status }: { status: SyncMonitorStatus }) {
  const batch = status.activeBatch;
  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm lg:grid-cols-3">
      <div>
        <div className="text-xs text-muted-foreground">Current stage</div>
        <div className="mt-1 font-medium">{status.currentStage ?? "Idle"}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Elapsed</div>
        <div className="mt-1 font-medium">{formatMs(status.progress?.elapsedMs)}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Batch</div>
        <div className="mt-1 font-medium">
          {batch
            ? `${batch.startIndex}-${batch.endIndex - 1} at x${batch.concurrency}`
            : "No active batch"}
        </div>
      </div>
      {batch ? (
        <div className="min-w-0 lg:col-span-3">
          <div className="text-xs text-muted-foreground">Batch IDs</div>
          <div className="mt-1 truncate font-mono text-xs">{batch.ids.join(", ")}</div>
        </div>
      ) : null}
    </div>
  );
}
