import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

export type ToastVariant = "error" | "success" | "info";

export interface ToastOptions {
  /**
   * Stable id. A visible toast with the same id is updated in place instead of
   * stacking, which keeps recurring failures (a failing poll, for example) from
   * flooding the viewport.
   */
  id?: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
}

interface ToastRecord {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  error: 8_000,
  success: 4_000,
  info: 5_000,
};

let toastSequence = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const viewportRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const schedule = useCallback(
    (id: string, durationMs: number) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
    },
    [dismiss],
  );

  const toast = useCallback(
    (options: ToastOptions) => {
      const variant = options.variant ?? "info";
      const id = options.id ?? `toast-${++toastSequence}`;
      const record: ToastRecord = {
        id,
        title: options.title,
        description: options.description,
        variant,
        durationMs: options.durationMs ?? DEFAULT_DURATION_MS[variant],
      };

      setToasts((current) => {
        const index = current.findIndex((entry) => entry.id === id);
        if (index === -1) return [...current, record];
        const next = [...current];
        next[index] = record;
        return next;
      });
      schedule(id, record.durationMs);
      return id;
    },
    [schedule],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  // The viewport is a manual popover so it renders in the browser's top layer,
  // above any open <dialog>. Browsers without the API show the element normally.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof viewport.showPopover !== "function") return;
    try {
      viewport.showPopover();
    } catch {
      // Already open; nothing to do.
    }
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        ref={viewportRef}
        popover="manual"
        aria-live="polite"
        className="pointer-events-none fixed inset-auto bottom-4 right-4 z-50 m-0 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 border-0 bg-transparent p-0 text-foreground"
      >
        {toasts.map((entry) => (
          <ToastCard key={entry.id} toast={entry} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a ToastProvider");
  return context;
}

const TOAST_STYLES: Record<
  ToastVariant,
  { icon: typeof Info; iconClass: string; cardClass: string }
> = {
  error: {
    icon: CircleAlert,
    iconClass: "text-destructive",
    cardClass: "border-destructive/40",
  },
  success: {
    icon: CircleCheck,
    iconClass: "text-success",
    cardClass: "border-border",
  },
  info: {
    icon: Info,
    iconClass: "text-muted-foreground",
    cardClass: "border-border",
  },
};

function ToastCard({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  const style = TOAST_STYLES[toast.variant];
  const Icon = style.icon;

  return (
    <div
      role={toast.variant === "error" ? "alert" : "status"}
      className={cn(
        "anicore-toast-in pointer-events-auto flex items-start gap-3 rounded-lg border bg-card p-3.5 text-sm shadow-lg",
        style.cardClass,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", style.iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
            {toast.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-m-1 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
