import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createProviderProfileStore } from "../src/store/provider-profiles";
import { createTenantStore } from "../src/store/tenants";

const KEY = Buffer.alloc(32, 8);

describe("provider profiles", () => {
  it("stores both provider keys encrypted and returns only redacted summaries", () => {
    const db = openDb(":memory:");
    const profiles = createProviderProfileStore(db, KEY);
    const created = profiles.create({
      coverageLabel: "WellGrow shared AI",
      primaryProvider: "gemini",
      fallbackEnabled: true,
      geminiKey: "gemini-secret",
      openaiKey: "openai-secret",
      geminiHealth: "healthy",
      openaiHealth: "healthy",
    });

    expect(profiles.getSnapshot(created.id)).toMatchObject({
      id: created.id,
      primaryProvider: "gemini",
      fallbackEnabled: true,
      geminiKey: "gemini-secret",
      openaiKey: "openai-secret",
    });
    expect(profiles.listRedacted()).toEqual([expect.objectContaining({
      id: created.id,
      coverageLabel: "WellGrow shared AI",
      primaryProvider: "gemini",
      fallbackEnabled: true,
      geminiConfigured: true,
      openaiConfigured: true,
      geminiHealth: "healthy",
      openaiHealth: "healthy",
    })]);
    const raw = db.prepare("SELECT gemini_key_enc, openai_key_enc FROM provider_profiles").get() as Record<string, string>;
    expect(raw.gemini_key_enc).not.toContain("gemini-secret");
    expect(raw.openai_key_enc).not.toContain("openai-secret");
    db.close();
  });

  it("does not enable fallback unless the configured alternate provider is healthy", () => {
    const db = openDb(":memory:");
    const profiles = createProviderProfileStore(db, KEY);
    expect(() => profiles.create({
      coverageLabel: "Invalid fallback",
      primaryProvider: "gemini",
      fallbackEnabled: true,
      geminiKey: "g",
      openaiKey: "o",
      geminiHealth: "healthy",
      openaiHealth: "unhealthy",
    })).toThrow(/fallback provider must be healthy/i);
    db.close();
  });

  it("rotates a key only after candidate validation and keeps the old key on failure", async () => {
    const db = openDb(":memory:");
    const profiles = createProviderProfileStore(db, KEY);
    const created = profiles.create({
      coverageLabel: "Rotate me",
      primaryProvider: "gemini",
      fallbackEnabled: false,
      geminiKey: "old-gemini",
      geminiHealth: "healthy",
    });
    await expect(profiles.rotate(created.id, { geminiKey: "bad-gemini" }, async () => ({
      ok: false, detail: "HTTP 401",
    }))).rejects.toThrow(/HTTP 401/);
    expect(profiles.getSnapshot(created.id)?.geminiKey).toBe("old-gemini");

    await profiles.rotate(created.id, { geminiKey: "new-gemini" }, async () => ({ ok: true }));
    expect(profiles.getSnapshot(created.id)?.geminiKey).toBe("new-gemini");
    expect(profiles.getSnapshot(created.id)?.version).toBe(2);
    db.close();
  });

  it("materializes one encrypted profile and links a legacy tenant transactionally", () => {
    const db = openDb(":memory:");
    const tenants = createTenantStore(db, KEY);
    const legacy = tenants.create({ label: "Legacy", locationId: "legacy-location", assistantId: "a", provider: "gemini", v3Key: "v3", ghlPit: "pit", aiKey: "legacy-secret" });
    const profiles = createProviderProfileStore(db, KEY);
    const first = profiles.materializeLegacy({ tenantId: legacy.id, provider: "gemini", apiKey: legacy.aiKey, coverageLabel: legacy.label });
    const second = profiles.materializeLegacy({ tenantId: legacy.id, provider: "gemini", apiKey: "ignored", coverageLabel: legacy.label });
    expect(first.id).toBe(second.id);
    expect(tenants.getByLocationId(legacy.locationId)?.providerProfileId).toBe(first.id);
    expect(profiles.getSnapshot(first.id)?.geminiKey).toBe("legacy-secret");
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_profiles").get()).toEqual({ n: 1 });
    db.close();
  });
});
