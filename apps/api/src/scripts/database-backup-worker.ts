import { createClient } from "@libsql/client";

const [mode, source, target] = process.argv.slice(2);
const client = createClient({ url: `file:${source}` });
try {
  if (mode === "create" && target) await client.execute({ sql: "vacuum into ?", args: [target] });
  else if (mode === "verify") {
    const result = await client.execute("pragma integrity_check");
    if (result.rows.length !== 1 || Object.values(result.rows[0]!)[0] !== "ok")
      throw new Error("Backup integrity check failed");
    if ((await client.execute("pragma foreign_key_check")).rows.length)
      throw new Error("Backup foreign key check failed");
    await client.execute(
      "insert into anime_search(anime_search, rank) values ('integrity-check', 1)",
    );
    const counts = await client.execute(
      "select count(*) as animeCount, (select count(*) from anime_language_status where is_manual_override=1) as manualOverrides from anime",
    );
    console.log(JSON.stringify(counts.rows[0]));
  } else throw new Error("Invalid backup worker mode");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.close();
}
