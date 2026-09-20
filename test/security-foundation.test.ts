import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createKeyRing, decryptVersioned, encryptVersioned } from "../src/security/crypto";
import { createTokenStore } from "../src/auth/tokens";

describe("security foundation", () => {
  it("encrypts with an explicit version and rotates through previous keys", () => {
    const first = createKeyRing(Buffer.alloc(32, 1), "1");
    const ciphertext = encryptVersioned("secret", first);
    const second = createKeyRing(Buffer.alloc(32, 2), "2", [{ version: "1", key: Buffer.alloc(32, 1) }]);
    expect(decryptVersioned(ciphertext, second)).toBe("secret");
    expect(() => decryptVersioned(ciphertext, createKeyRing(Buffer.alloc(32, 2), "2"))).toThrow(/unavailable/);
  });

  it("issues hashed, scoped, expiring, revocable tenant tokens", () => {
    const db = new DatabaseSync(":memory:");
    const tokens = createTokenStore(db);
    const issued = tokens.issue({ audience: "tenant", tenantId: "t1", scopes: ["dashboard:read"], ttlMs: 1000 });
    expect(issued.raw).not.toContain("t1");
    expect(tokens.verify(issued.raw, { audience: "tenant", tenantId: "t1", scope: "dashboard:read" })?.tenantId).toBe("t1");
    expect(tokens.verify(issued.raw, { tenantId: "t2" })).toBeNull();
    tokens.revoke(issued.claims.id);
    expect(tokens.verify(issued.raw)).toBeNull();
    db.close();
  });
});
