import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  name: string;
  workspaces?: { packages: string[]; catalog: Record<string, string> };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = (await Bun.file(resolve(root, "package.json")).json()) as Manifest;
if (!rootManifest.workspaces) throw new Error("Missing Bun workspace catalog");
const catalog = rootManifest.workspaces.catalog;
const manifests = new Map<string, Manifest>([["package.json", rootManifest]]);
for (const pattern of rootManifest.workspaces.packages) {
  for await (const path of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root })) {
    manifests.set(path, (await Bun.file(resolve(root, path)).json()) as Manifest);
  }
}
const names = new Set([...manifests.values()].map((manifest) => manifest.name));
const referenced = new Set<string>();
const errors: string[] = [];
for (const [path, manifest] of manifests) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (names.has(name)) {
        if (version !== "workspace:*") errors.push(`${path}: ${name} must use workspace:*`);
      } else {
        if (version !== "catalog:")
          errors.push(`${path}: ${name} must use catalog:, not ${version}`);
        if (!catalog[name]) errors.push(`${path}: ${name} is missing from the root catalog`);
        referenced.add(name);
      }
    }
  }
}
for (const [name, version] of Object.entries(catalog)) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`catalog: ${name} must pin one stable version`);
  if (!referenced.has(name)) errors.push(`catalog: ${name} is unused`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${manifests.size} manifests: ${referenced.size} external dependencies share one Bun catalog.`,
  );
}
