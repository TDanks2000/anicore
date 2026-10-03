import type {
  DashboardProxyPatch,
  DashboardResources,
  SyncMonitorClient,
} from "@anicore/sync-monitor";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const apply = useCallback((next: DashboardResources) => {
    setData(next);
    setDraft(
      (previous) =>
        previous ?? {
          mode: next.proxy.mode,
          noProxy: next.proxy.noProxy,
          maxAttempts: next.proxy.maxAttempts,
          timeoutMs: next.proxy.timeoutMs,
        },
    );
  }, []);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await client.getResources(offset, controller.signal);
        if (!controller.signal.aborted) {
          apply(next);
          setError("");
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 10_000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, offset, apply]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cache &amp; proxies</CardTitle>
        <CardDescription>
          Settings and cached provider data on the API host. Status refreshes every 10 seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!client ? (
          <p className="text-sm text-muted-foreground">
            Connect with your monitor code to manage resources.
          </p>
        ) : !data || !draft ? (
          <p className="text-sm text-muted-foreground">Loading resources…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 text-sm">
              <span>
                Routing: <strong>{data.proxy.effectiveMode}</strong>
              </span>
              {data.proxy.effectiveAddress && (
                <span className="break-all text-muted-foreground">
                  {data.proxy.effectiveAddress}
                </span>
              )}
              <span>{data.proxy.pools.working.toLocaleString()} working</span>
              <span>{data.proxy.pools.untested.toLocaleString()} untested</span>
              <span>{data.proxy.pools.dead.toLocaleString()} dead</span>
            </div>
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const next = await client.updateProxy({
                    ...draft,
                    ...(url.trim() ? { url: url.trim() } : {}),
                  });
                  if (!mounted.current) return;
                  apply(next);
                  setUrl("");
                  setOffset(0);
                  setMessage(
                    "Proxy settings saved. New requests use these settings; in-flight requests keep their current routing.",
                  );
                });
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Proxy mode
                <select
                  className="h-9 rounded-md border border-input bg-card px-3"
                  value={draft.mode}
                  onChange={(event) =>
                    setDraft({ ...draft, mode: event.target.value as DashboardProxyPatch["mode"] })
                  }
                >
                  <option value="environment">Use environment</option>
                  <option value="direct">Disabled (direct)</option>
                  <option value="custom">Custom proxy</option>
                  <option value="free">Enable free proxy pool</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Custom proxy URL
                <Input
                  type="password"
                  autoComplete="off"
                  disabled={draft.mode !== "custom"}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={
                    data.proxy.hasCustomUrl ? "Leave blank to keep saved URL" : "http://host:port"
                  }
                  required={draft.mode === "custom" && !data.proxy.hasCustomUrl}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Free-pool attempts
                <Input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={draft.maxAttempts}
                  onChange={(event) =>
                    setDraft({ ...draft, maxAttempts: Number(event.target.value) })
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Free-pool timeout (ms)
                <Input
                  type="number"
                  min={100}
                  max={60000}
                  required
                  value={draft.timeoutMs}
                  onChange={(event) =>
                    setDraft({ ...draft, timeoutMs: Number(event.target.value) })
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                Bypass hosts
                <Input
                  value={draft.noProxy}
                  onChange={(event) => setDraft({ ...draft, noProxy: event.target.value })}
                  placeholder="localhost,.example.com"
                />
              </label>
              <div className="flex items-end gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Working…" : "Save proxy settings"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      mode: data.proxy.mode,
                      noProxy: data.proxy.noProxy,
                      maxAttempts: data.proxy.maxAttempts,
                      timeoutMs: data.proxy.timeoutMs,
                    });
                    setUrl("");
                  }}
                >
                  Reset form
                </Button>
              </div>
            </form>
            <p className="text-xs leading-5 text-muted-foreground">
              Custom and free proxies fall back to direct requests on connection failures. Free mode
              bypasses Kitsu, TVDB, TMDB, AnimeSchedule and GitHub. Use environment mode to restore
              environment-variable routing. Public proxies are unsuitable for sensitive
              authenticated requests. Saved credentials are hidden.
            </p>
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  Cache files · {data.cache.totalFiles.toLocaleString()} files ·{" "}
                  {(data.cache.totalBytes / 1024).toFixed(1)} KB
                </h3>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await client.getResources(offset);
                      if (mounted.current) apply(next);
                    })
                  }
                >
                  Refresh cache
                </Button>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                Preview up to 8 KB per file. Provider caches can be cleared while sync is idle. ID
                lists, proxy pools and sync checkpoints are read-only.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2">File</th>
                      <th className="p-2">Size</th>
                      <th className="p-2">Updated</th>
                      <th className="p-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cache.files.map((file) => (
                      <tr className="border-t border-border" key={file.name}>
                        <td className="p-2 font-mono text-xs">{file.name}</td>
                        <td className="p-2 whitespace-nowrap">
                          {(file.bytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                          {formatDate(file.modifiedAt)}
                        </td>
                        <td className="p-2">
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const next = await client.previewCache(file.name);
                                  if (mounted.current) setPreview(next);
                                })
                              }
                            >
                              Preview
                            </Button>
                            {file.clearable && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={active || busy}
                                onClick={() => setConfirmClear(file.name)}
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.cache.totalFiles === 0 && (
                <p className="p-3 text-sm text-muted-foreground">No managed cache files yet.</p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || busy}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  {data.cache.totalFiles
                    ? `${data.cache.offset + 1}–${Math.min(data.cache.offset + 50, data.cache.totalFiles)} of ${data.cache.totalFiles}`
                    : "0 files"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + 50 >= data.cache.totalFiles || busy}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </div>
            </div>
            {confirmClear && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
                <span>Clear {confirmClear}? The provider will fetch it again.</span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || active}
                  onClick={() =>
                    void run(async () => {
                      await client.clearCache(confirmClear);
                      const next = await client.getResources(0);
                      if (!mounted.current) return;
                      apply(next);
                      setOffset(0);
                      setPreview(null);
                      setConfirmClear(null);
                      setMessage("Provider cache cleared.");
                    })
                  }
                >
                  Confirm clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmClear(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {preview && (
              <div className="min-w-0 rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="break-all text-sm font-medium">
                    {preview.name}
                    {preview.truncated ? " (first 8 KB)" : ""}
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                    Close preview
                  </Button>
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {preview.content || "Empty file"}
                </pre>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
