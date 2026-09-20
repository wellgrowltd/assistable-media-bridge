import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";

export type TokenAudience = "operator" | "tenant";

export interface TokenClaims {
  id: string;
  audience: TokenAudience;
  tenantId: string | null;
  scopes: string[];
  expiresAt: number;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function ensureTokenSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      audience TEXT NOT NULL,
      tenant_id TEXT,
      scopes TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_access_tokens_tenant ON access_tokens(tenant_id);
  `);
}

export function createTokenStore(db: Db) {
  ensureTokenSchema(db);
  return {
    issue(input: { audience: TokenAudience; tenantId?: string | null; scopes: string[]; ttlMs: number }) {
      if (input.audience === "tenant" && !input.tenantId) throw new Error("tenant token requires tenantId");
      const raw = randomBytes(32).toString("base64url");
      const now = Date.now();
      const claims: TokenClaims = {
        id: randomUUID(), audience: input.audience, tenantId: input.tenantId ?? null,
        scopes: [...new Set(input.scopes)], expiresAt: now + input.ttlMs,
      };
      db.prepare(`INSERT INTO access_tokens
        (id, token_hash, audience, tenant_id, scopes, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(claims.id, hashToken(raw), claims.audience, claims.tenantId,
          JSON.stringify(claims.scopes), claims.expiresAt, now);
      return { raw, claims };
    },
    verify(raw: string, expected?: { audience?: TokenAudience; tenantId?: string; scope?: string }): TokenClaims | null {
      const row = db.prepare("SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL")
        .get(hashToken(raw)) as { id: string; audience: TokenAudience; tenant_id: string | null; scopes: string; expires_at: number } | undefined;
      if (!row || row.expires_at <= Date.now()) return null;
      const scopes = JSON.parse(row.scopes) as string[];
      if (expected?.audience && row.audience !== expected.audience) return null;
      if (expected?.tenantId && row.tenant_id !== expected.tenantId) return null;
      if (expected?.scope && !scopes.includes(expected.scope)) return null;
      return { id: row.id, audience: row.audience, tenantId: row.tenant_id, scopes, expiresAt: row.expires_at };
    },
    revoke(id: string): void { db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), id); },
    revokeTenant(tenantId: string): void { db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE tenant_id = ?").run(Date.now(), tenantId); },
  };
}
export type TokenStore = ReturnType<typeof createTokenStore>;
