import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  type SyncMonitorClient,
  type SyncMonitorConfigResponse,
  type SyncMonitorRuntimeConfig,
} from "@anicore/sync-monitor";
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_DRAFT,
  draftFromRuntime,
  isAutoSyncIntervalValid,
  parseRuntimeConfigDraft,
  type RuntimeConfigDraft,
} from "@/lib/runtime-config-draft";

export type FormMessage = { kind: "success" | "error"; text: string };

/**
 * Editable copy of the runtime config. Server updates flow into the draft
 * until the user starts editing; after that the draft is theirs until saved.
 */
export function useRuntimeConfigForm(options: {
  client: SyncMonitorClient | null;
  runtime: SyncMonitorRuntimeConfig | null;
  onSaved: (config: SyncMonitorConfigResponse) => void | Promise<void>;
}) {
  const { client, runtime, onSaved } = options;
  const [draft, setDraft] = useState<RuntimeConfigDraft>(DEFAULT_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);

  useEffect(() => {
    if (!dirty && runtime) setDraft(draftFromRuntime(runtime));
  }, [dirty, runtime]);

  const update = useCallback((change: Partial<RuntimeConfigDraft>) => {
    setDirty(true);
    setDraft((current) => ({ ...current, ...change }));
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
      setDraft(draftFromRuntime(next.runtime));
      setDirty(false);
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
