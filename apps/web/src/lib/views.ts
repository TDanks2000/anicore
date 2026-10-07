export type DashboardView = "monitor" | "catalog" | "review" | "data" | "logs";

export const VIEW_HASHES: Record<DashboardView, string> = {
  monitor: "#/monitor",
  catalog: "#/catalog",
  review: "#/review",
  data: "#/data",
  logs: "#/logs",
};

/** Unknown links land on the monitor. */
export function viewFromHash(hash: string): DashboardView {
  const path = hash.replace(/^#\/?/, "").split(/[/?]/, 1)[0]?.toLowerCase();
  return path === "catalog" || path === "review" || path === "data" || path === "logs"
    ? path
    : "monitor";
}
