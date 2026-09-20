import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { createProviderProfileStore } from "../src/store/provider-profiles";
import { cloneTenant, validateCloneInput } from "../src/core/clone";

const key = Buffer.alloc(32, 9);
const sourceInput = {
  label: "Source clinic", locationId: "src-location", assistantId: "src-assistant",
  provider: "gemini" as const, v3Key: "v3-workspace", ghlPit: "source-pit", aiKey: "legacy-ai",
  subAccountId: "sub-source", allowedMediaHosts: ["links.wellgrow.io"],
};

function setup() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, key);
  const profiles = createProviderProfileStore(db, key);
  const profile = profiles.create({
    coverageLabel: "Shared Vela providers", primaryProvider: "gemini", fallbackEnabled: false,
    geminiKey: "gemini-secret", openaiKey: "openai-secret", geminiHealth: "healthy", openaiHealth: "healthy",
  });
  const source = tenants.create({ ...sourceInput, providerProfileId: profile.id });
  tenants.setAnalysisInstruction(source.id, "Only offer consultations after intake.");
  tenants.setModality(source.id, "audio", true);
  tenants.setModality(source.id, "image", false);
  tenants.setModality(source.id, "document", true);
  tenants.setModality(source.id, "video", false);
  tenants.setWaker(source.id, false);
  return { db, tenants, source: tenants.getByToken(source.token)!, profile };
}

describe("safe location cloning", () => {
  it("rejects missing, equal, swapped, unsafe, and duplicate identifiers before writes", () => {
    const { tenants, source } = setup();
    expect(() => validateCloneInput(source, { label: "", locationId: "", assistantId: "" }, tenants))
      .toThrow(/required/i);
    expect(() => validateCloneInput(source, { label: "x", locationId: "src-location", assistantId: "a" }, tenants))
      .toThrow(/already connected/i);
    expect(() => validateCloneInput(source, { label: "x", locationId: "sub-source", assistantId: "a", subAccountId: "src-location" }, tenants))
      .toThrow(/different identifiers/i);
    expect(() => validateCloneInput(source, { label: "x", locationId: "cms620jzf000tla049cc6msxv", assistantId: "a" }, tenants))
      .toThrow(/Assistable subaccount/i);
    expect(() => validateCloneInput(source, { label: "x", locationId: "new-location", assistantId: "a", allowedMediaHosts: ["http://evil.test/path"] }, tenants))
      .toThrow(/attachment host/i);
  });

  it("inherits operational settings and only swaps target identifiers", async () => {
    const { tenants, source } = setup();
    const r = await cloneTenant({
      tenants, source,
      input: { label: "Target clinic", locationId: "target-location", assistantId: "target-assistant", subAccountId: "sub-target" },
      validateV3: async () => ({ ok: true }),
      validatePit: async () => ({ ok: true }),
      provision: async () => ({ ok: true }),
    });
    expect(r.tenant.enabled).toBe(true);
    expect(r.tenant.provisioningState).toBe("ready");
    expect(r.tenant.providerProfileId).toBe(source.providerProfileId);
    expect(r.tenant.v3Key).toBe(source.v3Key);
    expect(r.tenant.ghlPit).toBe(source.ghlPit);
    expect(r.tenant.analysisInstruction).toBe(source.analysisInstruction);
    expect(r.tenant.modalities).toEqual(source.modalities);
    expect(r.tenant.wakerEnabled).toBe(source.wakerEnabled);
    expect(r.tenant.allowedMediaHosts).toEqual(source.allowedMediaHosts);
    expect(r.tenant.token).not.toBe(source.token);
    expect(tenants.list()).toHaveLength(2);
  });

  it("does not activate a clone when the inherited PIT needs replacement", async () => {
    const { tenants, source } = setup();
    const r = await cloneTenant({
      tenants, source,
      input: { label: "Pending clinic", locationId: "pending-location", assistantId: "pending-assistant" },
      validateV3: async () => ({ ok: true }),
      validatePit: async () => ({ ok: false, status: 403, detail: "wrong location" }),
      provision: async () => ({ ok: true }),
    });
    expect(r.tenant.enabled).toBe(false);
    expect(r.tenant.provisioningState).toBe("pending_credentials");
    expect(r.tenant.provisioningStep).toMatch(/PIT/i);
  });

  it("is safe to retry after a crash and never creates a second target row", async () => {
    const { tenants, source } = setup();
    const input = { label: "Retry clinic", locationId: "retry-location", assistantId: "retry-assistant" };
    let attempts = 0;
    const deps = {
      tenants, source, input,
      validateV3: async () => ({ ok: true }),
      validatePit: async () => ({ ok: true }),
      provision: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary tool outage"); return { ok: true }; },
    };
    const first = await cloneTenant(deps);
    expect(first.tenant.enabled).toBe(false);
    expect(first.tenant.provisioningState).toBe("failed");
    const second = await cloneTenant(deps);
    expect(second.tenant.enabled).toBe(true);
    expect(second.tenant.provisioningState).toBe("ready");
    expect(second.tenant.id).toBe(first.tenant.id);
    expect(tenants.list()).toHaveLength(2);
  });
});
