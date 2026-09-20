import { randomUUID } from "node:crypto";
import type { Db } from "../db";

export type OutboxState = "pending" | "in_progress" | "sent" | "failed" | "unknown";
export interface OutboxRow {
  id: string; tenantId: string; conversationId: string; contactId: string; operationId: string;
  kind: string; payload: string; state: OutboxState; idempotencyKey: string;
  requestHash: string | null; attemptCount: number; leaseExpiresAt: number | null; lastError: string | null; createdAt: number; updatedAt: number;
}

export function ensureOutboxSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_outbox (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    contact_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    idempotency_key TEXT NOT NULL, request_hash TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_expires_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (tenant_id, conversation_id, contact_id, operation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_ready ON delivery_outbox(state, updated_at);`);
}

export function createOutboxStore(db: Db) {
  ensureOutboxSchema(db);
  const map = (r: Record<string, unknown>): OutboxRow => ({
    id: String(r.id), tenantId: String(r.tenant_id), conversationId: String(r.conversation_id), contactId: String(r.contact_id), operationId: String(r.operation_id), kind: String(r.kind), payload: String(r.payload), state: r.state as OutboxState, idempotencyKey: String(r.idempotency_key), requestHash: r.request_hash == null ? null : String(r.request_hash), attemptCount: Number(r.attempt_count), leaseExpiresAt: r.lease_expires_at == null ? null : Number(r.lease_expires_at), lastError: r.last_error == null ? null : String(r.last_error), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  });
  return {
    enqueue(input: { tenantId: string; conversationId: string; contactId: string; operationId: string; kind: string; payload: unknown; idempotencyKey?: string; requestHash?: string }): OutboxRow {
      const now = Date.now();
      const idempotencyKey = input.idempotencyKey ?? `${input.tenantId}:${input.conversationId}:${input.contactId}:${input.operationId}`;
      db.prepare(`INSERT INTO delivery_outbox
        (id, tenant_id, conversation_id, contact_id, operation_id, kind, payload, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, conversation_id, contact_id, operation_id) DO NOTHING`)
        .run(randomUUID(), input.tenantId, input.conversationId, input.contactId, input.operationId, input.kind, JSON.stringify(input.payload), idempotencyKey, input.requestHash ?? null, now, now);
      return map(db.prepare(`SELECT * FROM delivery_outbox WHERE tenant_id = ? AND conversation_id = ? AND contact_id = ? AND operation_id = ?`)
        .get(input.tenantId, input.conversationId, input.contactId, input.operationId) as Record<string, unknown>);
    },
    claim(limit: number, leaseMs: number): OutboxRow[] {
      const rows = db.prepare(`SELECT * FROM delivery_outbox WHERE (state = 'pending' OR (state = 'in_progress' AND lease_expires_at < ?)) ORDER BY updated_at LIMIT ?`).all(Date.now(), limit) as Record<string, unknown>[];
      const now = Date.now();
      for (const r of rows) db.prepare(`UPDATE delivery_outbox SET state = 'in_progress', lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`).run(now + leaseMs, now, String(r.id));
      return rows.map((r) => map({ ...r, state: "in_progress", lease_expires_at: now + leaseMs, attempt_count: Number(r.attempt_count) + 1 }));
    },
    finish(id: string, state: Exclude<OutboxState, "pending" | "in_progress">, error?: string): void {
      db.prepare("UPDATE delivery_outbox SET state = ?, last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(state, error ?? null, Date.now(), id);
    },
    listUnknown(tenantId?: string): OutboxRow[] {
      const rows = tenantId ? db.prepare("SELECT * FROM delivery_outbox WHERE tenant_id = ? AND state = 'unknown'").all(tenantId) : db.prepare("SELECT * FROM delivery_outbox WHERE state = 'unknown'").all();
      return (rows as Record<string, unknown>[]).map(map);
    },
    deleteTenant(tenantId: string): void { db.prepare("DELETE FROM delivery_outbox WHERE tenant_id = ?").run(tenantId); },
  };
}
export type OutboxStore = ReturnType<typeof createOutboxStore>;
