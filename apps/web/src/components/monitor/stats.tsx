import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
  compact = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warning" | "destructive";
  compact?: boolean;
}) {
  const toneClass = {
    default: "bg-secondary text-secondary-foreground",
    primary: "bg-primary/12 text-primary",
    success: "bg-success/14 text-success",
    warning: "bg-warning/16 text-warning",
    destructive: "bg-destructive/12 text-destructive",
  }[tone];

  return (
    <Card className="hover:shadow-md">
      <CardContent className={cn("flex items-center", compact ? "gap-3 p-4" : "gap-4 p-5")}>
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg [&_svg]:size-5",
            compact ? "hidden size-9 sm:flex" : "size-11",
            toneClass,
          )}
        >
          <Icon />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span
            className={cn(
              "font-medium uppercase tracking-wide text-muted-foreground",
              compact ? "text-[10px]" : "text-xs",
            )}
          >
            {label}
          </span>
          <span
            className={cn(
              "truncate font-semibold tracking-tight tabular-nums",
              compact ? "text-xl" : "text-2xl",
            )}
            title={value}
          >
            {value}
          </span>
          {hint ? (
            <span
              className={cn("truncate text-xs text-muted-foreground", compact && "hidden sm:block")}
              title={hint}
            >
              {hint}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const valueTone = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone];

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tracking-tight tabular-nums", valueTone)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        {label}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{children}</span>
    </div>
  );
}
