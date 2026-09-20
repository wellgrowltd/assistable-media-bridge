import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? "./media-mcp.sqlite";
  const dir = process.env.BACKUP_DIR ?? join(dirname(dbPath), "backups");
  const retention = Math.max(1, Number(process.env.BACKUP_RETENTION ?? "7"));

  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(dir, `media-mcp-${stamp}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); } finally { db.close(); }

  const files = (await readdir(dir)).filter((f) => f.startsWith("media-mcp-") && f.endsWith(".sqlite"));
  const ordered = (await Promise.all(files.map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })))).sort((a, b) => b.mtime - a.mtime);
  for (const old of ordered.slice(retention)) await unlink(join(dir, old.name));
  console.log(JSON.stringify({ ok: true, destination, retained: Math.min(retention, ordered.length) }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
