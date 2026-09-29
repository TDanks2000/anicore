type StorageKind = "local" | "session";

function storage(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    // Storage can be unavailable (private browsing, blocked site data).
    return null;
  }
}

export function readStored(kind: StorageKind, key: string, fallback: string): string {
  try {
    return storage(kind)?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(kind: StorageKind, key: string, value: string): void {
  try {
    storage(kind)?.setItem(key, value);
  } catch {
    // Persisting a convenience value is best effort.
  }
}
