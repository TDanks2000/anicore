import type { SyncMonitorStatus } from "@anicore/sync-monitor";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  month: "short",
  day: "numeric",
});

export function formatDate(value?: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : dateFormat.format(date);
}

export function formatMs(value?: number): string {
  if (value === undefined) return "Not available";
  const seconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds % 60}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatDuration(start?: string, end?: string, now = Date.now()): string {
  if (!start) return "Not available";
  const endMs = end ? new Date(end).getTime() : now;
  return formatMs(endMs - new Date(start).getTime());
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "Calculating";
  return formatMs(seconds * 1000);
}

export function formatRate(perMinute: number | undefined): string {
  if (perMinute === undefined) return "Unknown";
  return `${perMinute.toFixed(perMinute >= 10 ? 0 : 1)}/min`;
}

export function completionPercent(status: SyncMonitorStatus | null): number {
  if (status?.progress) return status.progress.percent;
  if (!status || status.total <= 0) return 0;
  const current = status.currentIndex === null ? status.startIndex : status.currentIndex + 1;
  const done = Math.max(0, current - status.startIndex);
  return Math.max(0, Math.min(100, Math.round((done / status.total) * 100)));
}

export function statusVariant(state?: SyncMonitorStatus["state"]) {
  if (state === "running") return "default" as const;
  if (state === "completed") return "secondary" as const;
  if (state === "failed") return "destructive" as const;
  return "outline" as const;
}
