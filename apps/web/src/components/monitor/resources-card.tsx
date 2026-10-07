import type {
  DashboardProxyPatch,
  DashboardResources,
  SyncMonitorClient,
} from "@anicore/sync-monitor";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  FileText,
  HardDrive,
  Loader2,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MetricCard } from "@/components/monitor/stats";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDate } from "@/lib/format";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function proxyDraft(data: DashboardResources): DashboardProxyPatch {
  return {
    mode: data.proxy.mode,
    noProxy: data.proxy.noProxy,
    maxAttempts: data.proxy.maxAttempts,
    timeoutMs: data.proxy.timeoutMs,
  };
}
export function ResourcesCard({
  client,
  active,
}: {
  client: SyncMonitorClient | null;
  active: boolean;
}) {
  const [data, setData] = useState<DashboardResources | null>(null);
  const [draft, setDraft] = useState<DashboardProxyPatch | null>(null);
  const [url, setUrl] = useState("");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const apply = useCallback((next: DashboardResources) => {
    setData(next);
    setDraft((previous) => previous ?? proxyDraft(next));
    setUpdatedAt(new Date().toISOString());
  }, []);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const gen = ++generation.current;
      setLoading(true);
      try {
        const next = await client.getResources(offset, controller.signal, query);
        if (!controller.signal.aborted && gen === generation.current) apply(next);
      } catch (err) {
        if (!controller.signal.aborted && gen === generation.current)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted && gen === generation.current) setLoading(false);
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 10_000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, offset, query, apply]);

  async function run(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  async function reload(nextOffset = offset) {
    if (!client) return;
    const gen = ++generation.current;
    const next = await client.getResources(nextOffset, undefined, query);
    if (mounted.current && gen === generation.current) {
      apply(next);
      setLoading(false);
    }
  }
  const dirty = Boolean(
    data && draft && (url.trim() || JSON.stringify(draft) !== JSON.stringify(proxyDraft(data))),
  );
  const matches = data?.cache.totalMatches ?? data?.cache.totalFiles ?? 0;
  const idList = data?.cache.files.find((file) => file.name === "anilist_ids.txt");

  if (!client)
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
          <Database className="mb-2 size-8 text-muted-foreground/50" />
          <p className="font-medium">Connect to manage your data</p>
          <p className="text-sm text-muted-foreground">
            Enter your API URL and monitor code in connection settings.
          </p>
        </CardContent>
      </Card>
    );
  if (!data || !draft)
    return (
      <>
        <Skeleton className="h-28" />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <Skeleton className="h-80" />
        )}
      </>
    );

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {message ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 px-4 py-3 text-sm text-success"
        >
          <Check className="mt-0.5 size-4 shrink-0" />
          {message}
        </p>
      ) : null}
      <section aria-label="Resource overview" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          compact
          icon={FileText}
          label="Cache files"
          value={data.cache.totalFiles.toLocaleString()}
          hint="Managed provider and sync files"
        />
        <MetricCard
          compact
          icon={HardDrive}
          label="Storage used"
          value={formatBytes(data.cache.totalBytes)}
          hint="Across all managed cache files"
        />
        <MetricCard
          compact
          icon={ShieldCheck}
          label="Working proxies"
          value={data.proxy.pools.working.toLocaleString()}
          hint={`${data.proxy.pools.untested.toLocaleString()} waiting to be tested`}
          tone="success"
        />
        <MetricCard
          compact
          icon={Network}
          label="Request routing"
          value={
            data.proxy.effectiveMode === "free"
              ? "Free pool"
              : data.proxy.effectiveMode === "custom"
                ? "Custom"
                : "Direct"
          }
          hint={data.proxy.effectiveAddress ?? "Current connection mode"}
          tone="primary"
        />
      </section>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Database className="size-5" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">AniList ID list</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Download the latest IDs and keep locally discovered entries.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {idList
                      ? `Updated ${formatDate(idList.modifiedAt)}`
                      : "Available in the managed cache"}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start sm:self-auto"
                disabled={Boolean(busy) || active}
                onClick={() =>
                  void run("ids", async () => {
                    const result = await client.refreshAnilistIds();
                    await reload();
                    if (mounted.current)
                      setMessage(
                        "ID list refreshed: " +
                          result.total.toLocaleString() +
                          " IDs · " +
                          result.added.toLocaleString() +
                          " new · " +
                          result.keptLocal.toLocaleString() +
                          " local entries kept.",
                      );
                  })
                }
              >
                {busy === "ids" ? <Loader2 className="animate-spin" /> : <RefreshCw />}Refresh IDs
              </Button>
            </CardContent>
          </Card>
          {active ? (
            <p className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-3 text-xs leading-5 text-muted-foreground">
              Sync is running. Stop it in Monitor to refresh IDs or clear provider caches. File
              previews and proxy settings are still available.
            </p>
          ) : null}
          <Card className="min-w-0">
            <CardHeader className="gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>Cache files</CardTitle>
                  <CardDescription className="mt-1">
                    Inspect cached data or clear files to fetch them again.
                  </CardDescription>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Refresh cache files"
                  disabled={Boolean(busy)}
                  onClick={() => void run("refresh", () => reload())}
                >
                  <RefreshCw className={busy === "refresh" ? "animate-spin" : undefined} />
                </Button>
              </div>
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
                />
                <Input
                  aria-label="Search cache files"
                  disabled={Boolean(busy)}
                  maxLength={200}
                  placeholder="Search all cache files…"
                  value={search}
                  className="pl-9 pr-10"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                />
                {search ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute right-0 top-0"
                    aria-label="Clear cache search"
                    onClick={() => {
                      setSearch("");
                      setOffset(0);
                    }}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div
                className="max-h-[60vh] overflow-auto rounded-lg border border-border"
                aria-busy={loading}
              >
                <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1fr)_70px_130px_140px] gap-3 bg-muted px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid">
                  <span>File</span>
                  <span>Size</span>
                  <span>Updated</span>
                  <span className="text-right">Actions</span>
                </div>
                {data.cache.files.length ? (
                  data.cache.files.map((file) => (
                    <div
                      key={file.name}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_70px_130px_140px]"
                    >
                      <div className="col-span-2 min-w-0 lg:col-span-1">
                        <p className="break-all font-mono text-xs font-medium">{file.name}</p>
                        {!file.clearable ? (
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            Read-only
                          </span>
                        ) : null}
                      </div>
                      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground lg:contents">
                        <span className="whitespace-nowrap">{formatBytes(file.bytes)}</span>
                        <span className="text-[11px]">{formatDate(file.modifiedAt)}</span>
                      </div>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Preview ${file.name}`}
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(`preview:${file.name}`, async () => {
                              const next = await client.previewCache(file.name);
                              if (mounted.current) setPreview(next);
                            })
                          }
                        >
                          <Eye />
                          Preview
                        </Button>
                        {file.clearable ? (
                          <Button
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            variant="ghost"
                            aria-label={`Clear ${file.name}`}
                            disabled={active || Boolean(busy)}
                            onClick={() => setConfirmClear(file.name)}
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
                    <FileText className="size-7 text-muted-foreground/50" />
                    <p className="text-sm font-medium">
                      {search ? "No matching cache files" : "No cached data yet"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {search
                        ? "Try a filename or provider name."
                        : "Managed files appear after your first sync."}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {matches
                    ? (data.cache.offset + 1).toLocaleString() +
                      "–" +
                      Math.min(
                        data.cache.offset + data.cache.files.length,
                        matches,
                      ).toLocaleString() +
                      " of " +
                      matches.toLocaleString() +
                      (search ? " matching files" : " files")
                    : "0 files"}
                  {loading ? " · Updating…" : ""}
                </span>
                {matches > 50 ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!offset || Boolean(busy) || loading}
                      onClick={() => setOffset(Math.max(0, offset - 50))}
                    >
                      <ChevronLeft />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset + 50 >= matches || Boolean(busy) || loading}
                      onClick={() => setOffset(offset + 50)}
                    >
                      Next
                      <ChevronRight />
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">
                Sync checkpoints, ID lists, and proxy pools are read-only. Previews show up to 8 KB.
              </p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Proxy settings</CardTitle>
            <CardDescription>Choose how provider requests connect.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-3 text-center">
              {(["working", "untested", "dead"] as const).map((pool) => (
                <div key={pool}>
                  <div className="text-base font-semibold tabular-nums">
                    {data.proxy.pools[pool].toLocaleString()}
                  </div>
                  <div className="mt-1 text-[10px] capitalize text-muted-foreground">{pool}</div>
                </div>
              ))}
            </div>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run("proxy", async () => {
                  const next = await client.updateProxy({
                    ...draft,
                    ...(url.trim() ? { url: url.trim() } : {}),
                  });
                  if (!mounted.current) return;
                  setDraft(proxyDraft(next));
                  setUrl("");
                  await reload();
                  if (mounted.current)
                    setMessage("Proxy settings saved. New requests will use this routing.");
                });
              }}
            >
              <div className="flex flex-col gap-1.5 text-sm">
                <label className="font-medium" htmlFor="proxy-mode">
                  Connection mode
                </label>
                <Select
                  id="proxy-mode"
                  disabled={Boolean(busy)}
                  value={draft.mode ?? "environment"}
                  onValueChange={(value) =>
                    setDraft({ ...draft, mode: value as DashboardProxyPatch["mode"] })
                  }
                >
                  <SelectItem value="environment">Use environment</SelectItem>
                  <SelectItem value="direct">Direct connection</SelectItem>
                  <SelectItem value="custom">Custom proxy</SelectItem>
                  <SelectItem value="free">Free proxy pool</SelectItem>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  {draft.mode === "direct"
                    ? "Connect directly to each provider."
                    : draft.mode === "free"
                      ? "Try available public proxies, then fall back to direct."
                      : draft.mode === "custom"
                        ? "Route requests through your saved proxy."
                        : "Use the API host’s environment settings."}
                </p>
              </div>
              {draft.mode === "custom" ? (
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Custom proxy URL
                  <Input
                    type="password"
                    autoComplete="off"
                    disabled={Boolean(busy)}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder={
                      data.proxy.hasCustomUrl ? "Leave blank to keep saved URL" : "http://host:port"
                    }
                    required={!data.proxy.hasCustomUrl}
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    Saved credentials stay hidden.
                  </span>
                </label>
              ) : null}
              <details className="group rounded-lg border border-border">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-xs font-medium [&::-webkit-details-marker]:hidden">
                  Advanced settings
                  <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="flex flex-col gap-3 border-t border-border p-3">
                  <label className="flex flex-col gap-1.5 text-xs font-medium">
                    Bypass hosts
                    <Input
                      disabled={Boolean(busy)}
                      value={draft.noProxy}
                      onChange={(event) => setDraft({ ...draft, noProxy: event.target.value })}
                      placeholder="localhost,.example.com"
                    />
                    <span className="font-normal text-muted-foreground">
                      Comma-separated hosts that connect directly.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium">
                    Maximum pool attempts
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      required
                      disabled={Boolean(busy)}
                      value={draft.maxAttempts}
                      onChange={(event) =>
                        setDraft({ ...draft, maxAttempts: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium">
                    Timeout per attempt (ms)
                    <Input
                      type="number"
                      min={100}
                      max={60000}
                      required
                      disabled={Boolean(busy)}
                      value={draft.timeoutMs}
                      onChange={(event) =>
                        setDraft({ ...draft, timeoutMs: Number(event.target.value) })
                      }
                    />
                  </label>
                </div>
              </details>
              <div className="flex items-center justify-between gap-2">
                <Button type="submit" disabled={Boolean(busy) || !dirty}>
                  {busy === "proxy" ? <Loader2 className="animate-spin" /> : <Check />}Save settings
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(busy) || !dirty}
                  onClick={() => {
                    setDraft(proxyDraft(data));
                    setUrl("");
                  }}
                >
                  Discard
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {dirty ? "You have unsaved changes" : "Settings are up to date"}
              </span>
            </form>
            <p className="border-t border-border pt-3 text-[11px] leading-5 text-muted-foreground">
              Public proxies can be unreliable. Free mode connects directly to providers with
              regional data or existing bypass rules.
            </p>
            {updatedAt ? (
              <p className="text-[10px] text-muted-foreground">
                Resources updated {formatDate(updatedAt)}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <Dialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        labelledBy="cache-preview-title"
        className="max-w-3xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div className="min-w-0">
            <h2 id="cache-preview-title" className="break-all font-mono text-sm font-semibold">
              {preview?.name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {preview?.truncated ? "Preview limited to the first 8 KB" : "File preview"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close preview"
            onClick={() => setPreview(null)}
          >
            <X />
          </Button>
        </div>
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-all bg-muted/20 p-5 font-mono text-xs leading-6">
          {preview?.content || "Empty file"}
        </pre>
      </Dialog>
      <Dialog
        open={Boolean(confirmClear)}
        onClose={() => {
          if (!busy) setConfirmClear(null);
        }}
        labelledBy="clear-cache-title"
        className="max-w-md"
      >
        <div className="flex flex-col gap-4 p-6">
          <h2 id="clear-cache-title" className="text-lg font-semibold">
            Clear this cache file?
          </h2>
          <p className="break-all rounded-md bg-muted p-3 font-mono text-xs">{confirmClear}</p>
          <p className="text-sm leading-6 text-muted-foreground">
            The provider will fetch this data again on its next sync.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => setConfirmClear(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy) || active}
              onClick={() =>
                void run("clear", async () => {
                  if (!confirmClear) return;
                  await client.clearCache(confirmClear);
                  await reload(0);
                  if (!mounted.current) return;
                  setOffset(0);
                  setConfirmClear(null);
                  setMessage("Provider cache cleared.");
                })
              }
            >
              {busy === "clear" ? "Clearing…" : "Clear cache"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
