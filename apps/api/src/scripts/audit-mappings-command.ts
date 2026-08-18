import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const API_ROOT = resolve(import.meta.dir, "../..");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DEFAULT_REPORT_FILENAME = "mapping-audit.json";

export interface AuditCommandOptions {
  auditArgs: string[];
  writePath: string | null;
}

function resolveOutputPath(value: string, repoRoot: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

export function parseAuditCommandArgs(
  args: string[],
  repoRoot = REPO_ROOT,
): AuditCommandOptions {
  const auditArgs: string[] = [];
  let writePath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--write") {
      const possiblePath = args[index + 1];
      if (possiblePath && !possiblePath.startsWith("-")) {
        writePath = resolveOutputPath(possiblePath, repoRoot);
        index += 1;
      } else {
        writePath = resolve(repoRoot, DEFAULT_REPORT_FILENAME);
      }
      continue;
    }

    if (arg.startsWith("--write=")) {
      const value = arg.slice("--write=".length).trim();
      if (!value) {
        throw new Error("--write= requires a non-empty file path");
      }
      writePath = resolveOutputPath(value, repoRoot);
      continue;
    }

    auditArgs.push(arg);
  }

  return { auditArgs, writePath };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function main(): Promise<void> {
  const { auditArgs, writePath } = parseAuditCommandArgs(Bun.argv.slice(2));
  const command = [
    process.execPath,
    resolve(import.meta.dir, "audit-mappings.ts"),
    ...auditArgs,
  ];

  if (!writePath) {
    const child = Bun.spawn(command, {
      cwd: API_ROOT,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
    return;
  }

  const child = Bun.spawn(command, {
    cwd: API_ROOT,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    child.exited,
  ]);

  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const reportOutput = stdout.trim().length > 0 ? stdout : stderr;
  if (reportOutput.trim().length === 0) {
    console.error("Mapping audit produced no output; no report file was written.");
    process.exitCode = 1;
    return;
  }

  try {
    await mkdir(dirname(writePath), { recursive: true });
    await Bun.write(
      writePath,
      reportOutput.endsWith("\n") ? reportOutput : `${reportOutput}\n`,
    );
    console.error(`Mapping audit report written to ${writePath}`);
  } catch (error) {
    console.error(
      `Failed to write mapping audit report to ${writePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  process.exitCode = exitCode;
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
