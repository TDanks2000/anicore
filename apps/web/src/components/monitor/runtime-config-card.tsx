import {
  MAX_AUTO_SYNC_INTERVAL_MINUTES,
  type SyncMonitorAutomationStatus,
  type SyncMonitorRuntimeConfig,
} from "@anicore/sync-monitor";
import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { useRuntimeConfigForm } from "@/hooks/use-runtime-config-form";
import { formatDate } from "@/lib/format";
import type { RuntimeConfigDraft } from "@/lib/runtime-config-draft";
import { KeyValue } from "./stats";

type Form = ReturnType<typeof useRuntimeConfigForm>;
type TextField = {
  [K in keyof RuntimeConfigDraft]: RuntimeConfigDraft[K] extends string ? K : never;
}[keyof RuntimeConfigDraft];
type ToggleField = {
  [K in keyof RuntimeConfigDraft]: RuntimeConfigDraft[K] extends boolean ? K : never;
}[keyof RuntimeConfigDraft];

const SAVE_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";

function NumberField({
  form,
  field,
  label,
  ...input
}: { form: Form; field: TextField; label: string } & Omit<ComponentProps<typeof Input>, "form">) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium">
      {label}
      <Input
        type="number"
        step={1}
        value={form.draft[field]}
        onChange={(event) => form.update({ [field]: event.target.value })}
        {...input}
      />
    </label>
  );
}

function Toggle({ form, field, label }: { form: Form; field: ToggleField; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input
        checked={form.draft[field]}
        className="size-4 accent-primary"
        type="checkbox"
        onChange={(event) => form.update({ [field]: event.target.checked })}
      />
      {label}
    </label>
  );
}

export function RuntimeConfigCard(props: {
  form: Form;
  runtime: SyncMonitorRuntimeConfig | null;
  automation: SyncMonitorAutomationStatus | null;
}) {
  const { form, runtime, automation } = props;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime Config</CardTitle>
        <CardDescription>
          Updates are written to the API host. Automatic runs refresh the AniList ID list and resync
          from index 0.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
          <Toggle form={form} field="autoSyncEnabled" label="Run sync automatically" />
          <NumberField
            form={form}
            field="autoSyncIntervalMinutes"
            label="Run every (minutes)"
            aria-invalid={form.intervalInvalid}
            disabled={!form.draft.autoSyncEnabled}
            min={1}
            max={MAX_AUTO_SYNC_INTERVAL_MINUTES}
          />
          <div className="grid gap-2 text-xs">
            <KeyValue label="Scheduler">{automation?.state ?? "Not started"}</KeyValue>
            <KeyValue label="Next run">{formatDate(automation?.nextRunAt)}</KeyValue>
            {automation?.lastMessage ? (
              <p className="leading-5 text-muted-foreground">{automation.lastMessage}</p>
            ) : null}
          </div>
        </div>

        <NumberField form={form} field="parallel" label="Parallel fetches" min={1} max={32} />
        <NumberField
          form={form}
          field="checkpointEvery"
          label="Checkpoint every"
          min={1}
          max={10_000}
        />
        <NumberField
          form={form}
          field="rateLimitMs"
          label="AniList rate limit ms"
          min={1}
          max={60_000}
          step={100}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm font-medium">
            Start mode
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.draft.startMode}
              onChange={(event) =>
                form.update({ startMode: event.target.value === "sync" ? "sync" : "dry-run" })
              }
            >
              <option value="dry-run">Dry run</option>
              <option value="sync">Sync</option>
            </select>
          </label>
          <NumberField
            form={form}
            field="startLimit"
            label="Start limit"
            min={0}
            max={1_000_000}
            placeholder="No limit"
          />
        </div>
        <NumberField
          form={form}
          field="startFromIndex"
          label="Start from index"
          min={0}
          max={1_000_000}
          placeholder="Use saved progress"
        />
        <Toggle form={form} field="refreshIds" label="Refresh AniList IDs on start" />
        <Toggle form={form} field="resetAll" label="Reset progress on start" />

        <Button onClick={() => void form.save()} disabled={!form.canSave}>
          {form.saving ? (
            <RefreshCw className="animate-spin" data-icon="inline-start" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          {form.saving ? "Saving…" : `Save ${SAVE_SHORTCUT}`}
        </Button>
        {form.message ? (
          <div
            className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            role={form.message.kind === "error" ? "alert" : "status"}
          >
            {form.message.text}
          </div>
        ) : null}
        <div className="grid gap-2 text-xs">
          <KeyValue
            label={
              <>
                <SlidersHorizontal />
                Updated by
              </>
            }
          >
            {runtime?.updatedBy ?? "default"}
          </KeyValue>
          <KeyValue label="Updated at">{formatDate(runtime?.updatedAt)}</KeyValue>
        </div>
      </CardContent>
    </Card>
  );
}
