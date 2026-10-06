import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Always isolate this benchmark: importing the DB only happens after redirecting it.
const worker = process.argv.find((arg) => arg.startsWith("--benchmark-worker="));
if (!worker) {
  const directory = mkdtempSync(join(tmpdir(), "anicore-catalogue-benchmark-"));
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
      `--benchmark-worker=${directory}`,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    },
  );
  const code = await child.exited;
  // The worker owns libsql's native handles; process exit releases all of them
  // before the parent removes its isolated fixture, including on Windows.
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exit(code);
}
const directory = resolve(worker.slice("--benchmark-worker=".length));
if (
  dirname(directory) !== resolve(tmpdir()) ||
  !basename(directory).startsWith("anicore-catalogue-benchmark-")
) {
  throw new Error("Invalid isolated benchmark directory");
}
const previousUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = join(directory, "catalogue.db");
const { closeDb, db, migrateDatabase } = await import("@anicore/db");
const { anime } = await import("@anicore/db/schema");
const { sql } = await import("drizzle-orm");
const { listAnime } = await import("../modules/anime/anime.service");

try {
  const rowOption = process.argv.slice(2).find((arg) => arg.startsWith("--rows="));
  const rows = Number(rowOption?.slice(7) ?? 30_000);
  if (!Number.isInteger(rows) || rows < 100 || rows > 100_000) {
    throw new Error("--rows must be an integer between 100 and 100000");
  }
  await migrateDatabase();
  const insertStarted = performance.now();
  for (let offset = 0; offset < rows; offset += 100) {
    await db.insert(anime).values(
      Array.from({ length: Math.min(100, rows - offset) }, (_, j) => {
        const id = offset + j + 1;
        return {
          slug: `anime-${id}`,
          titleRomaji: id % 1000 === 0 ? `Naruto story ${id}` : `Catalogue title ${id}`,
          titleEnglish: `English title ${id}`,
          titleNative: `作品名${id}`,
          synonymsJson: JSON.stringify([
            id % 599 === 0 ? `Naruto alternative ${id}` : `Alias ${id}`,
          ]),
          description: "An anime synopsis with typical catalogue metadata. ".repeat(20),
          format: id % 5 === 0 ? "MOVIE" : "TV",
          status: "FINISHED",
          seasonYear: 2000 + (id % 27),
          season: "SPRING",
          averageScore: id % 10 === 0 ? null : id % 101,
          popularity: id % 10 === 0 ? null : id % 10_001,
        };
      }),
    );
  }
  const insertMs = performance.now() - insertStarted;
  const scenarios = [
    { name: "first page", query: { limit: 50, offset: 0 } },
    { name: "substring search", query: { limit: 50, offset: 0, q: "naruto" } },
    {
      name: "filtered score sort",
      query: { limit: 50, offset: 0, format: "TV", sort: "score" as const, order: "desc" as const },
    },
    {
      name: "popularity sort",
      query: { limit: 50, offset: 0, sort: "popularity" as const, order: "desc" as const },
    },
    { name: "title sort", query: { limit: 50, offset: 0, sort: "title" as const } },
    { name: "deep offset", query: { limit: 50, offset: Math.floor(rows * 0.8) } },
  ];
  const measurements = [];
  for (const scenario of scenarios) {
    for (let i = 0; i < 5; i++) await listAnime(scenario.query);
    const durations = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      await listAnime(scenario.query);
      durations.push(performance.now() - started);
    }
    const result = await listAnime(scenario.query);
    durations.sort((a, b) => a - b);
    measurements.push({
      name: scenario.name,
      total: result.total,
      p50Ms: Number(durations[14]!.toFixed(2)),
      p95Ms: Number(durations[28]!.toFixed(2)),
    });
  }
  const plans = {
    filteredScore: await db.all(
      sql`explain query plan select * from anime where format = 'TV' order by average_score desc nulls last, id asc limit 50`,
    ),
    popularity: await db.all(
      sql`explain query plan select * from anime order by popularity desc nulls last, id asc limit 50`,
    ),
    title: await db.all(
      sql`explain query plan select * from anime order by lower(title_romaji), id asc limit 50`,
    ),
  };
  const concurrentDurations: number[] = [];
  const writeStarted = performance.now();
  const writes = (async () => {
    for (let i = 0; i < 30; i++)
      await db.transaction(async (tx) => {
        await tx.run(sql`update anime set average_score=${i} where id=1`);
        await Bun.sleep(10);
      });
  })();
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    await listAnime({ limit: 50, offset: 0, projection: "summary" });
    concurrentDurations.push(performance.now() - started);
  }
  await writes;
  concurrentDurations.sort((a, b) => a - b);
  const concurrentWrites = {
    transactions: 30,
    writeMs: Math.round(performance.now() - writeStarted),
    readP50Ms: Number(concurrentDurations[14]!.toFixed(2)),
    readP95Ms: Number(concurrentDurations[28]!.toFixed(2)),
  };
  const [version] = await db.all<{ version: string }>(sql`select sqlite_version() as version`);
  console.log(
    JSON.stringify(
      {
        rows,
        sqlite: version?.version,
        bun: Bun.version,
        insertMs: Math.round(insertMs),
        databaseBytes: statSync(process.env.DATABASE_URL!).size,
        measurements,
        plans,
        concurrentWrites,
      },
      null,
      2,
    ),
  );
} finally {
  await closeDb();
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
}
