import type { Tenant, TenantStore } from "../store/tenants";
import { normalizeMediaHosts } from "../media/hosts";

const CUID_SHAPE = /^c[a-z0-9]{20,}$/;

export interface CloneInput {
  label: string;
  locationId: string;
  assistantId: string;
  subAccountId?: string | null;
  /** If omitted, the source PIT is reused and re-validated. */
  ghlPit?: string | null;
  allowedMediaHosts?: string[];
  modalities?: Partial<Tenant["modalities"] & { document: boolean; video: boolean }>;
}

export interface CloneResult {
  tenant: Tenant;
  warnings: string[];
  resumed: boolean;
}

export interface CloneDeps {
  tenants: TenantStore;
  source: Tenant;
  input: CloneInput;
  validateV3: (v3Key: string, subAccountId?: string) => Promise<{ ok: boolean; detail?: string }>;
  validatePit: (pit: string, locationId: string) => Promise<{ ok: boolean; status?: number; detail?: string }>;
  provision: (tenant: Tenant) => Promise<{ ok: boolean; warning?: string }>;
}

function required(value: string | null | undefined): boolean { return Boolean(value?.trim()); }

/** Validate all operator-controlled identifiers before creating a row or making an upstream call. */
export function validateCloneInput(source: Tenant, input: CloneInput, tenants: Pick<TenantStore, "getByLocationId">): void {
  if (!required(input.label) || !required(input.locationId) || !required(input.assistantId)) {
    throw new Error("label, GHL location ID, and assistant ID are required");
  }
  if (input.locationId === source.locationId || tenants.getByLocationId(input.locationId)) {
    throw new Error(`GHL location ${input.locationId} is already connected; cloning it would create a duplicate wake path`);
  }
  if (input.subAccountId && input.subAccountId === input.locationId) {
    throw new Error("the Subaccount ID and the GHL location ID are the same value, but they are different identifiers");
  }
  if (input.locationId === source.subAccountId || input.subAccountId === source.locationId) {
    throw new Error("the Subaccount ID and GHL location ID appear swapped; they are different identifiers");
  }
  if (CUID_SHAPE.test(input.locationId)) {
    throw new Error(`\"${input.locationId}\" looks like an Assistable subaccount id, not a GHL location ID`);
  }
  if (input.subAccountId && CUID_SHAPE.test(input.subAccountId) === false && input.subAccountId.length > 160) {
    throw new Error("the Assistable subaccount ID is not valid");
  }
  if (input.allowedMediaHosts) {
    const normalized = normalizeMediaHosts(input.allowedMediaHosts);
    if (normalized.invalid.length) {
      throw new Error(`invalid attachment host: ${normalized.invalid[0]}`);
    }
  }
}

function copyOperationalSettings(tenants: TenantStore, source: Tenant, target: Tenant, input: CloneInput): void {
  tenants.setAnalysisInstruction(target.id, source.analysisInstruction);
  tenants.setWaker(target.id, source.wakerEnabled);
  tenants.setAllowedMediaHosts(target.id, input.allowedMediaHosts ?? source.allowedMediaHosts ?? []);
  tenants.setModality(target.id, "audio", input.modalities?.audio ?? source.modalities.audio);
  tenants.setModality(target.id, "image", input.modalities?.image ?? source.modalities.image);
  tenants.setModality(target.id, "document", input.modalities?.document ?? source.documentEnabled !== false);
  tenants.setModality(target.id, "video", input.modalities?.video ?? source.videoEnabled !== false);
}

/**
 * Create or resume a disabled clone. External validation/provisioning is injected
 * so the state machine is deterministic in tests and the portal can use the same
 * flow with live clients. The source's provider profile is the only shared state.
 */
export async function cloneTenant(deps: CloneDeps): Promise<CloneResult> {
  const { tenants, source, input } = deps;
  const existing = tenants.getByLocationId(input.locationId);
  if (!existing) validateCloneInput(source, input, tenants);
  else if (existing.id === source.id) throw new Error("a clone cannot target the source location");

  let target = existing;
  let resumed = Boolean(existing);
  if (!target) {
    target = tenants.create({
      label: input.label.trim(), locationId: input.locationId.trim(), assistantId: input.assistantId.trim(),
      subAccountId: input.subAccountId ?? undefined,
      provider: source.provider, v3Key: source.v3Key,
      ghlPit: input.ghlPit?.trim() || source.ghlPit,
      aiKey: source.aiKey,
      providerProfileId: source.providerProfileId ?? null,
      enabled: false, provisioningState: "pending", provisioningStep: "created",
    });
    copyOperationalSettings(tenants, source, target, input);
    target = tenants.getByLocationId(input.locationId)!;
  }

  if (target.provisioningState === "ready" && target.enabled) {
    return { tenant: target, warnings: [], resumed };
  }

  tenants.setEnabled(target.id, false);
  tenants.setProvisioning(target.id, "validating", "credentials");
  const v3 = await deps.validateV3(target.v3Key, target.subAccountId);
  if (!v3.ok) {
    tenants.setProvisioning(target.id, "failed", "Assistable credentials");
    return { tenant: tenants.getByLocationId(target.locationId)!, warnings: [v3.detail ?? "Assistable credentials failed validation"], resumed };
  }
  const pit = await deps.validatePit(target.ghlPit, target.locationId);
  if (!pit.ok) {
    tenants.setProvisioning(target.id, "pending_credentials", "GHL PIT");
    return { tenant: tenants.getByLocationId(target.locationId)!, warnings: [pit.detail ?? "GHL Private Integration Token needs to be replaced"], resumed };
  }
  tenants.setProvisioning(target.id, "provisioning", "assistant tools");
  try {
    const provisioned = await deps.provision(tenants.getByLocationId(target.locationId)!);
    if (!provisioned.ok) throw new Error(provisioned.warning ?? "assistant tool provisioning failed");
    tenants.setProvisioning(target.id, "ready", null);
    tenants.setEnabled(target.id, true);
  } catch (err) {
    tenants.setProvisioning(target.id, "failed", "assistant tools");
    return {
      tenant: tenants.getByLocationId(target.locationId)!,
      warnings: [err instanceof Error ? err.message : "assistant tool provisioning failed"],
      resumed,
    };
  }
  return { tenant: tenants.getByLocationId(target.locationId)!, warnings: [], resumed };
}
