import { resolve } from "node:path";

// Bun resolves the watch project before loading preloads. Restore the API's
// working directory here so its existing relative data paths stay unchanged.
process.chdir(resolve(import.meta.dir, "../apps/api"));
