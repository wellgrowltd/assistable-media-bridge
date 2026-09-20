import type { Db } from "../db";

export interface CursorRow { tenantId: string; source: string; cursor: string | null; generation: number; updatedAt: number; }

export function ensureCursorSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_cursors (
    tenant_id TEXT NOT NULL, source TEXT NOT NULL, cursor TEXT,
    generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, source)
  );`);
}

export function createCursorStore(db: Db) {
  ensureCursorSchema(db);
  return {
    get(tenantId: string, source = "v3"): CursorRow | null {
      const r = db.prepare("SELECT * FROM tenant_cursors WHERE tenant_id = ? AND source = ?").get(tenantId, source) as Record<string, unknown> | undefined;
      return r ? { tenantId, source, cursor: r.cursor == null ? null : String(r.cursor), generation: Number(r.generation), updatedAt: Number(r.updated_at) } : null;
    },
    set(tenantId: string, cursor: string | null, source = "v3"): void {
      db.prepare(`INSERT INTO tenant_cursors (tenant_id, source, cursor, generation, updated_at)
        VALUES (?, ?, ?, 0, ?) ON CONFLICT(tenant_id, source) DO UPDATE SET
        cursor = excluded.cursor, generation = tenant_cursors.generation + 1, updated_at = excluded.updated_at`)
        .run(tenantId, source, cursor, Date.now());
    },
    deleteTenant(tenantId: string): void { db.prepare("DELETE FROM tenant_cursors WHERE tenant_id = ?").run(tenantId); },
  };
}
export type CursorStore = ReturnType<typeof createCursorStore>;
