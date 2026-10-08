import { expect, test } from "bun:test";
import { decryptMonitorCode, encryptMonitorCode } from "./monitor-code-storage";

async function key() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

test("round trips a monitor code without storing plaintext and uses a fresh IV", async () => {
  const browserKey = await key();
  const code = "my-private-monitor-code-🔐";
  const first = await encryptMonitorCode(code, browserKey);
  const second = await encryptMonitorCode(code, browserKey);
  expect(first).not.toContain(code);
  expect(first).not.toEqual(second);
  expect(await decryptMonitorCode(first, browserKey)).toBe(code);
  expect(browserKey.extractable).toBe(false);
});

test("rejects tampered ciphertext, incorrect keys and corrupt saved data", async () => {
  const browserKey = await key();
  const encrypted = await encryptMonitorCode("secret", browserKey);
  const tampered = JSON.parse(encrypted);
  tampered.ciphertext[0] ^= 1;
  await expect(decryptMonitorCode(JSON.stringify(tampered), browserKey)).rejects.toThrow();
  await expect(decryptMonitorCode(encrypted, await key())).rejects.toThrow();
  await expect(decryptMonitorCode("corrupt", browserKey)).rejects.toThrow();
});
