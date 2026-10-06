import { Component, type ReactNode, Suspense } from "react";
import { Button } from "@/components/ui/button";

/** A failed chunk download should leave navigation and a recovery action usable. */
class ContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-lg border border-border p-5"
        >
          <p>Couldn't load this content. Reload the dashboard to try again.</p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload dashboard
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function AsyncContent({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ContentBoundary>
      <Suspense
        fallback={
          <p role="status" className="p-5 text-sm text-muted-foreground">
            {label}
          </p>
        }
      >
        {children}
      </Suspense>
    </ContentBoundary>
  );
}
