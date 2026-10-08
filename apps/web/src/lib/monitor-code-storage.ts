const CODE_KEY = "anicore.monitorCode.encrypted.v1";
const LEGACY_KEY = "anicore.monitorCode";
let keyPromise: Promise<CryptoKey> | undefined;
let writes: Promise<void> = Promise.resolve();

// A non-exportable browser key lives in IndexedDB; localStorage holds ciphertext only.
function browserKey(): Promise<CryptoKey> {
  keyPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("anicore-secrets", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const database = request.result;
      try {
        // Generate before opening the transaction so it cannot expire while awaiting crypto.
        const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        const transaction = database.transaction("keys", "readwrite");
        const store = transaction.objectStore("keys");
        const existing = store.get("monitor-code");
        let selected: CryptoKey;
        existing.onsuccess = () => {
          selected = existing.result ?? candidate;
          if (!existing.result) store.put(selected, "monitor-code");
        };
        transaction.oncomplete = () => {
          database.close();
          resolve(selected);
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      } catch (error) {
        database.close();
        reject(error);
      }
    };
  });
  return keyPromise;
}

export async function encryptMonitorCode(code: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(code),
  );
  return JSON.stringify({ iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(encrypted)) });
}

export async function decryptMonitorCode(value: string, key: CryptoKey): Promise<string> {
  const { iv, ciphertext } = JSON.parse(value);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

export async function readMonitorCode(): Promise<string> {
  try {
    const encrypted = window.localStorage.getItem(CODE_KEY);
    if (encrypted) return await decryptMonitorCode(encrypted, await browserKey());
    // Move the previous session value into encrypted storage once.
    const legacy = window.sessionStorage.getItem(LEGACY_KEY) ?? "";
    if (legacy) await writeMonitorCode(legacy);
    return legacy;
  } catch {
    return "";
  } finally {
    try {
      window.sessionStorage.removeItem(LEGACY_KEY);
    } catch {
      /* Storage may be blocked. */
    }
  }
}

export function writeMonitorCode(code: string): Promise<void> {
  // Serialize encryption and storage so an older async write cannot replace a newer code.
  writes = writes.then(async () => {
    try {
      window.sessionStorage.removeItem(LEGACY_KEY);
      if (!code) {
        window.localStorage.removeItem(CODE_KEY);
        return;
      }
      const encrypted = await encryptMonitorCode(code, await browserKey());
      window.localStorage.setItem(CODE_KEY, encrypted);
    } catch {
      // Unavailable crypto/storage keeps the code in memory; never fall back to plaintext.
      try {
        window.localStorage.removeItem(CODE_KEY);
      } catch {
        /* Storage may be blocked. */
      }
    }
  });
  return writes;
}
