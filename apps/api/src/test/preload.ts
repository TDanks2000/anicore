import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun loads `.env` before preloads run, so this overrides any DATABASE_URL
// there: tests always get a fresh, disposable database file.
const directory = mkdtempSync(join(tmpdir(), "anicore-test-"));
process.env.DATABASE_URL = join(directory, "anicore.db");

process.on("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
