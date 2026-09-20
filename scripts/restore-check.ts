import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] ?? process.env.DB_PATH;
if (!path) throw new Error("usage: tsx scripts/restore-check.ts <sqlite-backup>");
const db = new DatabaseSync(path, { readOnly: true });
try {
  const required = ["tenants", "events", "assistant_bindings", "tenant_cursors", "delivery_outbox", "access_tokens", "audit_log"];
  const found = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
  const missing = required.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`backup missing tables: ${missing.join(", ")}`);
  db.prepare("PRAGMA integrity_check").get();
  console.log(JSON.stringify({ ok: true, path, tenants: (db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n }));
} finally { db.close(); }
