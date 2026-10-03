import { useEffect, useState } from "react";

import { type DashboardView, viewFromHash } from "@/lib/views";

/** Hash-based view switching so tabs are deep-linkable and Back works. */
export function useDashboardView(): DashboardView {
  const [view, setView] = useState<DashboardView>(() =>
    typeof window === "undefined" ? "monitor" : viewFromHash(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return view;
}
