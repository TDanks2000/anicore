import { resolve } from "node:path";

// Keep the API's existing relative data paths while placing Bun's watch
// entrypoint at the workspace root. That lets changes in shared packages
// restart the API as well as changes under apps/api.
process.chdir(resolve(import.meta.dir, "../apps/api"));

await import("../apps/api/src/index.ts");
