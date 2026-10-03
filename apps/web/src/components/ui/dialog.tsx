import { type ReactNode, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Modal built on the native `<dialog>` element, so focus trapping, the top
 * layer and Escape-to-close come from the browser. Backdrop clicks close too.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close via the dialog's native cancel (Escape) event; this handler only catches backdrop clicks.
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className={cn(
        // The UA stylesheet gives <dialog> `overflow: auto`; the panel owns its
        // own scroll area, so hide the outer one to avoid double scrollbars.
        "m-auto w-[calc(100vw-2rem)] max-w-4xl overflow-hidden rounded-xl border border-border bg-card p-0 text-card-foreground shadow-lg outline-none",
        className,
      )}
      onClick={(event) => {
        // Clicks on ::backdrop target the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
