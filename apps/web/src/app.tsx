import { Activity, type LucideIcon, Moon, RefreshCw, Sun, Table2 } from "lucide-react";
import { useEffect } from "react";

import { AnimeCatalogView } from "@/components/catalog/anime-catalog-view";
import { type ConnectionDisplay, MonitorView } from "@/components/monitor/monitor-view";
import { StatusDot } from "@/components/monitor/status-dot";
import { Button } from "@/components/ui/button";
import { useDashboardView } from "@/hooks/use-dashboard-view";
import { type ConnectionState, useSyncMonitor } from "@/hooks/use-sync-monitor";
import { cn } from "@/lib/utils";
import { type DashboardView, VIEW_HASHES } from "@/lib/views";
import { useTheme } from "./theme-provider";

const CONNECTION: Record<ConnectionState, ConnectionDisplay> = {
  idle: { label: "Idle", tone: "neutral", pulse: false },
  loading: { label: "Connecting", tone: "warning", pulse: true },
  ready: { label: "Connected", tone: "success", pulse: true },
  error: { label: "Needs attention", tone: "destructive", pulse: false },
};

const VIEW_TITLES: Record<DashboardView, string> = {
  monitor: "Sync Monitor · AniCore",
  catalog: "Anime Catalog · AniCore",
};

export function App() {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const monitor = useSyncMonitor();
  const view = useDashboardView();

  const connection: ConnectionDisplay = monitor.stale
    ? { label: "Reconnecting", tone: "warning", pulse: true }
    : CONNECTION[monitor.connectionState];

  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";

  useEffect(() => {
    document.title = VIEW_TITLES[view];
  }, [view]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1920px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8 xl:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
              <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
                <path
                  d="M9 22 16 9l7 13"
                  stroke="currentColor"
                  strokeWidth="3"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="hidden leading-tight sm:block">
              <div className="text-sm font-semibold tracking-tight">AniCore</div>
              <div className="text-xs text-muted-foreground">
                {view === "catalog" ? "Anime Catalog" : "Sync Monitor"}
              </div>
            </div>

            <nav
              aria-label="Dashboard views"
              className="ml-1 flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-xs"
            >
              <ViewLink view="monitor" current={view} icon={Activity} label="Monitor" />
              <ViewLink view="catalog" current={view} icon={Table2} label="Catalog" />
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {view === "monitor" ? (
              <span className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground md:inline-flex">
                <StatusDot tone={connection.tone} pulse={connection.pulse} />
                {connection.label}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${nextTheme} mode`}
              onClick={() => setTheme(nextTheme)}
              title={`Theme: ${theme}`}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            </Button>
            {view === "monitor" ? (
              <Button variant="outline" size="sm" onClick={() => void monitor.refresh(true)}>
                <RefreshCw />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1920px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 xl:px-10">
        {view === "monitor" ? (
          <MonitorView monitor={monitor} connection={connection} />
        ) : (
          <AnimeCatalogView apiUrl={monitor.apiUrl} />
        )}
      </main>
    </div>
  );
}

function ViewLink({
  view,
  current,
  icon: Icon,
  label,
}: {
  view: DashboardView;
  current: DashboardView;
  icon: LucideIcon;
  label: string;
}) {
  const active = view === current;

  return (
    <a
      href={VIEW_HASHES[view]}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-secondary text-secondary-foreground shadow-xs"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </a>
  );
}
