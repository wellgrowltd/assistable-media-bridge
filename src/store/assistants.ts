import type { Db } from "../db";

export interface AssistantBinding {
  tenantId: string;
  assistantId: string;
  enabled: boolean;
  desiredToolVersion: string;
  toolsProvisionedAt: number | null;
  lastProvisioningStatus: "pending" | "ready" | "failed";
  lastProvisioningError: string | null;
}

export function ensureAssistantSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_bindings (
      tenant_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      desired_tool_version TEXT NOT NULL DEFAULT '1',
      tools_provisioned_at INTEGER,
      last_provisioning_status TEXT NOT NULL DEFAULT 'pending',
      last_provisioning_error TEXT,
      PRIMARY KEY (tenant_id, assistant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_bindings_tenant ON assistant_bindings(tenant_id);
  `);
}

export function createAssistantBindingStore(db: Db) {
  ensureAssistantSchema(db);
  const row = (r: Record<string, unknown>): AssistantBinding => ({
    tenantId: String(r.tenant_id), assistantId: String(r.assistant_id),
    enabled: Number(r.enabled) === 1, desiredToolVersion: String(r.desired_tool_version),
    toolsProvisionedAt: r.tools_provisioned_at == null ? null : Number(r.tools_provisioned_at),
    lastProvisioningStatus: r.last_provisioning_status as AssistantBinding["lastProvisioningStatus"],
    lastProvisioningError: r.last_provisioning_error == null ? null : String(r.last_provisioning_error),
  });
  return {
    upsert(tenantId: string, assistantId: string): AssistantBinding {
      db.prepare(`INSERT INTO assistant_bindings (tenant_id, assistant_id)
        VALUES (?, ?) ON CONFLICT(tenant_id, assistant_id) DO NOTHING`).run(tenantId, assistantId);
      return row(db.prepare("SELECT * FROM assistant_bindings WHERE tenant_id = ? AND assistant_id = ?")
        .get(tenantId, assistantId) as Record<string, unknown>);
    },
    list(tenantId: string): AssistantBinding[] {
      return (db.prepare("SELECT * FROM assistant_bindings WHERE tenant_id = ? ORDER BY assistant_id")
        .all(tenantId) as Record<string, unknown>[]).map(row);
    },
    reconcile(tenantId: string, assistantIds: string[]): void {
      const ids = new Set(assistantIds);
      const existing = this.list(tenantId);
      for (const assistantId of assistantIds) this.upsert(tenantId, assistantId);
      for (const binding of existing) {
        if (!ids.has(binding.assistantId)) {
          db.prepare(`UPDATE assistant_bindings SET enabled = 0, last_provisioning_status = 'failed',
            last_provisioning_error = ? WHERE tenant_id = ? AND assistant_id = ?`)
            .run("assistant is no longer visible from the Assistable workspace", tenantId, binding.assistantId);
        }
      }
    },
    setEnabled(tenantId: string, assistantId: string, enabled: boolean): void {
      db.prepare(`UPDATE assistant_bindings SET enabled = ?, last_provisioning_status = ?
        WHERE tenant_id = ? AND assistant_id = ?`).run(enabled ? 1 : 0, enabled ? "pending" : "ready", tenantId, assistantId);
    },
    markProvisioned(tenantId: string, assistantId: string, status: "ready" | "failed", error?: string): void {
      db.prepare(`UPDATE assistant_bindings SET tools_provisioned_at = ?, last_provisioning_status = ?, last_provisioning_error = ?
        WHERE tenant_id = ? AND assistant_id = ?`).run(Date.now(), status, error ?? null, tenantId, assistantId);
    },
    disableAll(tenantId: string): void { db.prepare("UPDATE assistant_bindings SET enabled = 0 WHERE tenant_id = ?").run(tenantId); },
    deleteTenant(tenantId: string): void { db.prepare("DELETE FROM assistant_bindings WHERE tenant_id = ?").run(tenantId); },
  };
}
export type AssistantBindingStore = ReturnType<typeof createAssistantBindingStore>;
