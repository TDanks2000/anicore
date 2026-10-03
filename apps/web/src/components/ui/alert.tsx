import type * as React from "react";

import { cn } from "@/lib/utils";

export function Alert({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-card p-4 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:text-muted-foreground",
        className,
      )}
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn("font-medium leading-5 tracking-tight", className)} {...props} />;
}

export function AlertDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <div
      className={cn("col-start-2 text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}
