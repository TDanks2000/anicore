export type DashboardView = "monitor" | "catalog";

export const VIEW_HASHES: Record<DashboardView, string> = {
  monitor: "#/monitor",
  catalog: "#/catalog",
};

/** Anything that is not an explicit catalog link lands on the monitor. */
export function viewFromHash(hash: string): DashboardView {
  const path = hash.replace(/^#\/?/, "").split(/[/?]/, 1)[0]?.toLowerCase();
  return path === "catalog" ? "catalog" : "monitor";
}
