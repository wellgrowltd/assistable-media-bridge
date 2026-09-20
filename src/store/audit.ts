import type { Db } from "../db";

export interface AuditRow {
  id: number;
  tenantId: string | null;
  actor: string;
  action: string;
  detail: string;
  at: number;
}

export function ensureAuditSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, id DESC);
  `);
}

export function createAuditStore(db: Db) {
  ensureAuditSchema(db);
  return {
    record(input: { tenantId?: string | null; actor: string; action: string; detail?: string }): void {
      db.prepare("INSERT INTO audit_log (tenant_id, actor, action, detail, at) VALUES (?,?,?,?,?)")
        .run(input.tenantId ?? null, input.actor, input.action, input.detail ?? "", Date.now());
    },
    latest(tenantId: string | null, limit = 100): AuditRow[] {
      const rows = tenantId == null
        ? db.prepare("SELECT * FROM audit_log WHERE tenant_id IS NULL ORDER BY id DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?").all(tenantId, limit);
      return rows as unknown as AuditRow[];
    },
    prune(before: number): void { db.prepare("DELETE FROM audit_log WHERE at < ?").run(before); },
  };
}
export type AuditStore = ReturnType<typeof createAuditStore>;
