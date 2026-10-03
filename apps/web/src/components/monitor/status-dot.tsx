import { cn } from "@/lib/utils";

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";

const TONE: Record<Tone, string> = {
  neutral: "bg-muted-foreground/60",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden="true">
      {pulse ? (
        <span className={cn("absolute inset-0 rounded-full opacity-60", TONE[tone], "live-dot")} />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", TONE[tone])} />
    </span>
  );
}

export type StatusTone = Tone;
