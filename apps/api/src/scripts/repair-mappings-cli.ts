export type RepairMappingsMode = "dry-run" | "apply";

export interface RepairMappingsOptions {
  mode: RepairMappingsMode;
}

export function parseRepairMappingsArgs(args: string[]): RepairMappingsOptions {
  let requestedMode: RepairMappingsMode | null = null;

  for (const arg of args) {
    if (arg === "--dry-run") {
      if (requestedMode === "apply") {
        throw new Error("--dry-run and --apply cannot be used together");
      }
      requestedMode = "dry-run";
      continue;
    }

    if (arg === "--apply") {
      if (requestedMode === "dry-run") {
        throw new Error("--dry-run and --apply cannot be used together");
      }
      requestedMode = "apply";
      continue;
    }

    throw new Error(`Unknown db:repair-mappings argument: ${arg}`);
  }

  return { mode: requestedMode ?? "dry-run" };
}
