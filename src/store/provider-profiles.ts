import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import type { KeyCheck } from "../providers/types";

export type ProviderName = "gemini" | "openai";
export type ProviderHealth = "unknown" | "healthy" | "unhealthy";

export interface ProviderProfileInput {
  coverageLabel: string;
  primaryProvider: ProviderName;
  fallbackEnabled: boolean;
  geminiKey?: string | null;
  openaiKey?: string | null;
  geminiHealth?: ProviderHealth;
  openaiHealth?: ProviderHealth;
  geminiHealthDetail?: string | null;
  openaiHealthDetail?: string | null;
  legacyTenantId?: string | null;
}

export interface ProviderProfileSnapshot {
  id: string;
  coverageLabel: string;
  primaryProvider: ProviderName;
  fallbackEnabled: boolean;
  geminiKey: string | null;
  openaiKey: string | null;
  geminiHealth: ProviderHealth;
  openaiHealth: ProviderHealth;
  geminiHealthDetail: string | null;
  openaiHealthDetail: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastGeminiCheckAt: number | null;
  lastOpenaiCheckAt: number | null;
}

export interface ProviderProfileSummary {
  id: string;
  coverageLabel: string;
  primaryProvider: ProviderName;
  fallbackEnabled: boolean;
  geminiConfigured: boolean;
  openaiConfigured: boolean;
  geminiHealth: ProviderHealth;
  openaiHealth: ProviderHealth;
  geminiHealthDetail: string | null;
  openaiHealthDetail: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastGeminiCheckAt: number | null;
  lastOpenaiCheckAt: number | null;
}

type Row = {
  id: string;
  coverage_label: string;
  primary_provider: string;
  fallback_enabled: number;
  gemini_key_enc: string | null;
  openai_key_enc: string | null;
  gemini_health: string;
  openai_health: string;
  gemini_health_detail: string | null;
  openai_health_detail: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  last_gemini_check_at: number | null;
  last_openai_check_at: number | null;
};

const HEALTH: ProviderHealth[] = ["unknown", "healthy", "unhealthy"];
const provider = (value: string): ProviderName => value === "openai" ? "openai" : "gemini";
const health = (value: string): ProviderHealth => HEALTH.includes(value as ProviderHealth) ? value as ProviderHealth : "unknown";
const cleanDetail = (detail: string | null | undefined): string | null => detail ? detail.slice(0, 240) : null;

function alternate(name: ProviderName): ProviderName { return name === "gemini" ? "openai" : "gemini"; }

export function createProviderProfileStore(db: Db, key: Buffer) {
  const getRow = (id: string): Row | null =>
    (db.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id) as Row | undefined) ?? null;

  const snapshot = (row: Row): ProviderProfileSnapshot => ({
    id: row.id,
    coverageLabel: row.coverage_label,
    primaryProvider: provider(row.primary_provider),
    fallbackEnabled: row.fallback_enabled === 1,
    geminiKey: row.gemini_key_enc ? decryptSecret(row.gemini_key_enc, key) : null,
    openaiKey: row.openai_key_enc ? decryptSecret(row.openai_key_enc, key) : null,
    geminiHealth: health(row.gemini_health),
    openaiHealth: health(row.openai_health),
    geminiHealthDetail: row.gemini_health_detail,
    openaiHealthDetail: row.openai_health_detail,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastGeminiCheckAt: row.last_gemini_check_at,
    lastOpenaiCheckAt: row.last_openai_check_at,
  });

  const assertInput = (input: ProviderProfileInput) => {
    const geminiKey = input.geminiKey?.trim() || null;
    const openaiKey = input.openaiKey?.trim() || null;
    if (!geminiKey && !openaiKey) throw new Error("at least one provider key is required");
    const alternateProvider = alternate(input.primaryProvider);
    const alternateKey = alternateProvider === "gemini" ? geminiKey : openaiKey;
    const alternateHealth = alternateProvider === "gemini" ? input.geminiHealth : input.openaiHealth;
    if (input.fallbackEnabled && (!alternateKey || alternateHealth !== "healthy")) {
      throw new Error("fallback provider must be healthy before fallback can be enabled");
    }
    return { geminiKey, openaiKey };
  };

  const create = (input: ProviderProfileInput): ProviderProfileSnapshot => {
    const { geminiKey, openaiKey } = assertInput(input);
    const now = Date.now();
    const id = randomUUID();
    db.prepare(`INSERT INTO provider_profiles
      (id, gemini_key_enc, openai_key_enc, primary_provider, fallback_enabled,
       coverage_label, version, gemini_health, openai_health,
       gemini_health_detail, openai_health_detail, created_at, updated_at,
       last_gemini_check_at, last_openai_check_at, legacy_tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, geminiKey ? encryptSecret(geminiKey, key) : null,
        openaiKey ? encryptSecret(openaiKey, key) : null,
        input.primaryProvider, input.fallbackEnabled ? 1 : 0,
        input.coverageLabel.trim().slice(0, 160), 1,
        input.geminiHealth ?? "unknown", input.openaiHealth ?? "unknown",
        cleanDetail(input.geminiHealthDetail), cleanDetail(input.openaiHealthDetail),
        now, now,
        input.geminiHealth ? now : null, input.openaiHealth ? now : null,
        input.legacyTenantId ?? null);
    const row = getRow(id);
    if (!row) throw new Error("provider profile insert failed");
    return snapshot(row);
  };

  const getSnapshot = (id: string): ProviderProfileSnapshot | null => {
    const row = getRow(id);
    return row ? snapshot(row) : null;
  };

  const toSummary = (row: Row): ProviderProfileSummary => ({
    id: row.id,
    coverageLabel: row.coverage_label,
    primaryProvider: provider(row.primary_provider),
    fallbackEnabled: row.fallback_enabled === 1,
    geminiConfigured: Boolean(row.gemini_key_enc),
    openaiConfigured: Boolean(row.openai_key_enc),
    geminiHealth: health(row.gemini_health),
    openaiHealth: health(row.openai_health),
    geminiHealthDetail: row.gemini_health_detail,
    openaiHealthDetail: row.openai_health_detail,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastGeminiCheckAt: row.last_gemini_check_at,
    lastOpenaiCheckAt: row.last_openai_check_at,
  });

  const listRedacted = (): ProviderProfileSummary[] =>
    (db.prepare("SELECT * FROM provider_profiles ORDER BY created_at ASC").all() as Row[]).map(toSummary);

  const validateAndCreate = async (
    input: ProviderProfileInput,
    validate: (name: ProviderName, apiKey: string) => Promise<KeyCheck>,
  ): Promise<ProviderProfileSnapshot> => {
    const keys = assertInput(input);
    const checks: Partial<Record<ProviderName, KeyCheck>> = {};
    if (keys.geminiKey) checks.gemini = await validate("gemini", keys.geminiKey);
    if (keys.openaiKey) checks.openai = await validate("openai", keys.openaiKey);
    for (const name of ["gemini", "openai"] as ProviderName[]) {
      if (!checks[name]) continue;
      if (!checks[name]?.ok) throw new Error(`${name} key validation failed: ${checks[name]?.detail ?? "unknown error"}`);
    }
    return create({
      ...input,
      geminiHealth: keys.geminiKey ? "healthy" : undefined,
      openaiHealth: keys.openaiKey ? "healthy" : undefined,
    });
  };

  const rotate = async (
    id: string,
    changes: { geminiKey?: string | null; openaiKey?: string | null; primaryProvider?: ProviderName; fallbackEnabled?: boolean },
    validate: (name: ProviderName, apiKey: string) => Promise<KeyCheck>,
  ): Promise<ProviderProfileSnapshot> => {
    const current = getSnapshot(id);
    if (!current) throw new Error("provider profile not found");
    const geminiKey = changes.geminiKey === undefined ? current.geminiKey : changes.geminiKey?.trim() || null;
    const openaiKey = changes.openaiKey === undefined ? current.openaiKey : changes.openaiKey?.trim() || null;
    if (!geminiKey && !openaiKey) throw new Error("at least one provider key is required");
    const checks: Partial<Record<ProviderName, KeyCheck>> = {};
    if (changes.geminiKey !== undefined && geminiKey) checks.gemini = await validate("gemini", geminiKey);
    if (changes.openaiKey !== undefined && openaiKey) checks.openai = await validate("openai", openaiKey);
    for (const name of ["gemini", "openai"] as ProviderName[]) {
      if (checks[name] && !checks[name]?.ok) throw new Error(`${name} key validation failed: ${checks[name]?.detail ?? "unknown error"}`);
    }
    const primaryProvider = changes.primaryProvider ?? current.primaryProvider;
    const fallbackEnabled = changes.fallbackEnabled ?? current.fallbackEnabled;
    const alternateProvider = alternate(primaryProvider);
    const alternateKey = alternateProvider === "gemini" ? geminiKey : openaiKey;
    const alternateHealth = alternateProvider === "gemini" ? (checks.gemini?.ok ? "healthy" : current.geminiHealth) : (checks.openai?.ok ? "healthy" : current.openaiHealth);
    if (fallbackEnabled && (!alternateKey || alternateHealth !== "healthy")) {
      throw new Error("fallback provider must be healthy before fallback can be enabled");
    }
    const now = Date.now();
    const geminiHealth = checks.gemini?.ok ? "healthy" : current.geminiHealth;
    const openaiHealth = checks.openai?.ok ? "healthy" : current.openaiHealth;
    db.prepare(`UPDATE provider_profiles SET
      gemini_key_enc = ?, openai_key_enc = ?, primary_provider = ?, fallback_enabled = ?,
      version = version + 1, gemini_health = ?, openai_health = ?,
      gemini_health_detail = ?, openai_health_detail = ?, updated_at = ?,
      last_gemini_check_at = ?, last_openai_check_at = ? WHERE id = ?`)
      .run(geminiKey ? encryptSecret(geminiKey, key) : null,
        openaiKey ? encryptSecret(openaiKey, key) : null,
        primaryProvider, fallbackEnabled ? 1 : 0,
        geminiHealth, openaiHealth,
        checks.gemini?.ok ? null : current.geminiHealthDetail,
        checks.openai?.ok ? null : current.openaiHealthDetail,
        now,
        checks.gemini ? now : current.lastGeminiCheckAt,
        checks.openai ? now : current.lastOpenaiCheckAt,
        id);
    const updated = getSnapshot(id);
    if (!updated) throw new Error("provider profile update failed");
    return updated;
  };

  /**
   * Link one legacy tenant to a shared profile exactly once. This deliberately
   * lives beside the profile table so the insert and tenant update share one
   * synchronous SQLite write lock; concurrent requests cannot mint two profiles.
   * The caller is responsible for validating the legacy key before invoking it.
   */
  const materializeLegacy = (input: {
    tenantId: string; provider: ProviderName; apiKey: string; coverageLabel: string;
  }): ProviderProfileSnapshot => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const linked = db.prepare("SELECT provider_profile_id FROM tenants WHERE id = ?").get(input.tenantId) as { provider_profile_id: string | null } | undefined;
      if (!linked) throw new Error("tenant not found");
      if (linked.provider_profile_id) {
        const existing = getSnapshot(linked.provider_profile_id);
        if (existing) { db.exec("COMMIT"); return existing; }
      }
      const found = db.prepare("SELECT id FROM provider_profiles WHERE legacy_tenant_id = ?").get(input.tenantId) as { id: string } | undefined;
      const id = found?.id ?? randomUUID();
      if (!found) {
        const now = Date.now();
        const geminiKey = input.provider === "gemini" ? input.apiKey : null;
        const openaiKey = input.provider === "openai" ? input.apiKey : null;
        db.prepare(`INSERT INTO provider_profiles
          (id, gemini_key_enc, openai_key_enc, primary_provider, fallback_enabled,
           coverage_label, version, gemini_health, openai_health, created_at, updated_at, legacy_tenant_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, geminiKey ? encryptSecret(geminiKey, key) : null, openaiKey ? encryptSecret(openaiKey, key) : null,
            input.provider, 0, input.coverageLabel.slice(0, 160), 1,
            input.provider === "gemini" ? "unknown" : "unknown", input.provider === "openai" ? "unknown" : "unknown",
            now, now, input.tenantId);
      }
      db.prepare("UPDATE tenants SET provider_profile_id = ? WHERE id = ?").run(id, input.tenantId);
      const result = getSnapshot(id);
      if (!result) throw new Error("legacy provider profile materialization failed");
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw err;
    }
  };

  return { create, getSnapshot, listRedacted, validateAndCreate, rotate, materializeLegacy };
}

export type ProviderProfileStore = ReturnType<typeof createProviderProfileStore>;
