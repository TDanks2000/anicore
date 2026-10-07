import { CrunchyrollAccessBlockedError } from "@anicore/providers/crunchyroll/client";
import { JikanCircuitOpenError } from "@anicore/providers/jikan/sync";
import { SyncStageCooldownError } from "@anicore/providers/lib/stage-state";

export function isCrunchyrollAccessFailure(error: unknown): boolean {
  return (
    error instanceof CrunchyrollAccessBlockedError ||
    (error instanceof SyncStageCooldownError &&
      error.stage === "language:crunchyroll" &&
      error.previousError?.startsWith("Crunchyroll access blocked:") === true)
  );
}

export function isOptionalJikanFailure(message: string): boolean {
  return /\b(429|5\d\d)\b|timed out|timeout|connection|temporarily unavailable|failed to fetch/i.test(
    message,
  );
}

/** Provider failures are independent; access challenges never become empty snapshots. */
export async function syncLanguageProviders(
  animeId: number,
  providers: Record<string, (animeId: number) => Promise<unknown>>,
  runStage?: <T>(name: string, operation: () => Promise<T>) => Promise<T>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, sync] of Object.entries(providers)) {
    try {
      const operation = async () => {
        await sync(animeId);
      };
      if (runStage) await runStage(name, operation);
      else await operation();
    } catch (error) {
      if (error instanceof JikanCircuitOpenError) continue;
      const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      if (name === "crunchyroll" && isCrunchyrollAccessFailure(error)) warnings.push(message);
      else if (name === "jikan" && isOptionalJikanFailure(message)) warnings.push(message);
      else errors.push(message);
    }
  }
  return { errors, warnings };
}
