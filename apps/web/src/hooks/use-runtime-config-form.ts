import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  type SyncMonitorClient,
  type SyncMonitorConfigResponse,
  type SyncMonitorRuntimeConfig,
} from "@anicore/sync-monitor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_DRAFT,
  draftFromRuntime,
  draftsEqual,
  isAutoSyncIntervalValid,
  parseRuntimeConfigDraft,
  type RuntimeConfigDraft,
} from "@/lib/runtime-config-draft";

export type FormMessage = { kind: "success" | "error"; text: string };

/**
 * Editable copy of the runtime config. Server updates flow into the draft until
 * the user diverges from them; after that the draft is theirs until saved.
 * `dirty` is derived from the draft vs. the last server baseline, so reverting a
 * field back to its saved value correctly disables Save again.
 */
export function useRuntimeConfigForm(options: {
  client: SyncMonitorClient | null;
  runtime: SyncMonitorRuntimeConfig | null;
  onSaved: (config: SyncMonitorConfigResponse) => void | Promise<void>;
}) {
  const { client, runtime, onSaved } = options;
  const [draft, setDraft] = useState<RuntimeConfigDraft>(DEFAULT_DRAFT);
  const [baseline, setBaseline] = useState<RuntimeConfigDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const baselineRef = useRef(baseline);

  useEffect(() => {
    baselineRef.current = baseline;
  }, [baseline]);

  useEffect(() => {
    if (!runtime) return;
    const next = draftFromRuntime(runtime);
    setDraft((current) => (draftsEqual(current, baselineRef.current) ? next : current));
    setBaseline(next);
  }, [runtime]);

  const dirty = useMemo(() => !draftsEqual(draft, baseline), [draft, baseline]);

  const update = useCallback((change: Partial<RuntimeConfigDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...change };
      return draftsEqual(current, next) ? current : next;
    });
  }, []);

  const intervalInvalid = !isAutoSyncIntervalValid(draft);
  const canSave = Boolean(client) && dirty && !saving && !intervalInvalid;

  const save = useCallback(async () => {
    if (!client) return;
    setMessage(null);

    const parsed = parseRuntimeConfigDraft(
      draft,
      runtime?.autoSyncIntervalMinutes ?? DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
    );
    if (!parsed.ok) {
      setMessage({ kind: "error", text: parsed.error });
      return;
    }

    setSaving(true);
    try {
      const next = await client.updateConfig(parsed.patch);
      const savedDraft = draftFromRuntime(next.runtime);
      setDraft(savedDraft);
      setBaseline(savedDraft);
      setMessage({ kind: "success", text: "Runtime and automatic sync settings saved." });
      await onSaved(next);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }, [client, draft, onSaved, runtime?.autoSyncIntervalMinutes]);

  // Cmd/Ctrl+S saves, like an editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (!canSave) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSave, save]);

  return { draft, update, dirty, saving, message, intervalInvalid, canSave, save };
}
