import {
  MAX_AUTO_SYNC_INTERVAL_MINUTES,
  type SyncMonitorAutomationStatus,
  type SyncMonitorRuntimeConfig,
} from "@anicore/sync-monitor";
import { CalendarClock, Loader2, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import type { useRuntimeConfigForm } from "@/hooks/use-runtime-config-form";
import { formatDate } from "@/lib/format";
import type { RuntimeConfigDraft } from "@/lib/runtime-config-draft";
import { cn } from "@/lib/utils";
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

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function NumberField({
  form,
  field,
  label,
  hint,
  ...input
}: { form: Form; field: TextField; label: string; hint?: string } & Omit<
  ComponentProps<typeof Input>,
  "form"
>) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <Input
        type="number"
        step={1}
        value={form.draft[field]}
        onChange={(event) => form.update({ [field]: event.target.value })}
        {...input}
      />
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Toggle({ form, field, label }: { form: Form; field: ToggleField; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
      <input
        checked={form.draft[field]}
        className="size-4 cursor-pointer rounded accent-primary"
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
          Written to the API host. Automatic runs refresh the AniList ID list and resync from index
          0.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
            <CalendarClock />
            Automation
          </div>
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
          <div className="grid gap-1.5 border-t border-border/70 pt-3 text-xs">
            <KeyValue label="Scheduler">{automation?.state ?? "Not started"}</KeyValue>
            <KeyValue label="Next run">{formatDate(automation?.nextRunAt)}</KeyValue>
            {automation?.lastMessage ? (
              <p className="mt-1 leading-5 text-muted-foreground">{automation.lastMessage}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <SectionLabel>Performance</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-3">
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
              label="Rate limit (ms)"
              min={1}
              max={60_000}
              step={100}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <SectionLabel>Start behavior</SectionLabel>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <label htmlFor="sync-start-mode">Start mode</label>
              <Select
                id="sync-start-mode"
                value={form.draft.startMode}
                onValueChange={(value) =>
                  form.update({ startMode: value === "sync" ? "sync" : "dry-run" })
                }
              >
                <SelectItem value="dry-run">Dry run</SelectItem>
                <SelectItem value="sync">Sync</SelectItem>
              </Select>
            </div>
            <NumberField
              form={form}
              field="startLimit"
              label="Start limit"
              min={0}
              max={1_000_000}
              placeholder="No limit"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <label htmlFor="sync-id-selection">IDs to sync</label>
              <Select
                id="sync-id-selection"
                aria-describedby="sync-id-selection-hint"
                value={form.draft.newIdsOnly ? "new" : "all"}
                onValueChange={(value) => form.update({ newIdsOnly: value === "new" })}
              >
                <SelectItem value="all">All IDs</SelectItem>
                <SelectItem value="new">New IDs only</SelectItem>
              </Select>
              <span
                id="sync-id-selection-hint"
                className="text-xs font-normal text-muted-foreground"
              >
                New IDs are AniList IDs not yet in the database.
              </span>
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <label htmlFor="sync-id-order">ID order</label>
              <Select
                id="sync-id-order"
                value={form.draft.idOrder}
                onValueChange={(value) =>
                  form.update({
                    idOrder: value === "descending" ? "descending" : "ascending",
                  })
                }
              >
                <SelectItem value="ascending">Lowest IDs first</SelectItem>
                <SelectItem value="descending">Highest IDs first</SelectItem>
              </Select>
            </div>
          </div>
          {form.draft.newIdsOnly || form.draft.idOrder === "descending" ? (
            <p className="text-xs text-muted-foreground">
              These runs start at index 0 unless specified below and keep normal sync progress
              unchanged. Options apply to manual starts and dry runs.
            </p>
          ) : null}
          <NumberField
            form={form}
            field="startFromIndex"
            label="Start from index"
            min={0}
            max={1_000_000}
            placeholder="Use saved progress"
          />
          <div className="flex flex-col gap-2.5 pt-1">
            <Toggle form={form} field="refreshIds" label="Refresh AniList IDs on start" />
            <Toggle form={form} field="resetAll" label="Reset progress on start" />
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <Button onClick={() => void form.save()} disabled={!form.canSave}>
            {form.saving ? <Loader2 className="animate-spin" /> : <Save />}
            {form.saving ? "Saving…" : `Save changes`}
            <span className="hidden text-[11px] font-normal text-primary-foreground/70 sm:inline">
              {SAVE_SHORTCUT}
            </span>
          </Button>
          {form.message ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                form.message.kind === "error"
                  ? "border-destructive/40 bg-destructive/5 text-destructive"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
              role={form.message.kind === "error" ? "alert" : "status"}
            >
              {form.message.kind === "error" ? <RefreshCw className="size-3.5" /> : null}
              {form.message.text}
            </div>
          ) : null}
        </div>

        <div className="grid gap-1.5 border-t border-border pt-3 text-xs">
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
          <KeyValue label="Updated at">
            {runtime && runtime.updatedBy !== "default"
              ? formatDate(runtime.updatedAt)
              : "Not saved yet"}
          </KeyValue>
        </div>
      </CardContent>
    </Card>
  );
}
