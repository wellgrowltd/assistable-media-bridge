# Provider Fallback and Location Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add encrypted shared Gemini/OpenAI provider profiles, deterministic media fallback, and a safe operator workflow for cloning GHL/Assistable locations without re-entering provider keys.

**Architecture:** Keep the current tenant and `MediaProvider` interfaces compatible while adding a provider-profile store and a fallback wrapper. Legacy tenants are lazily migrated to one profile in a synchronous SQLite transaction. New clone records start disabled, validate their target credentials/IDs, provision tools idempotently, and become enabled only after every required step succeeds.

**Tech Stack:** Node.js 26, TypeScript, Express 5, built-in `node:sqlite`, Vitest, Supertest, existing encrypted-secret helpers and operator-session middleware.

**Design reference:** `docs/superpowers/specs/2026-09-20-provider-fallback-location-cloning-design.md`

---

## File map

- Create `src/providers/fallback.ts` — modality-aware provider routing, transient-error classification, fallback metadata, and redacted diagnostics.
- Create `src/store/provider-profiles.ts` — encrypted Gemini/OpenAI profile persistence, health metadata, rotation, and legacy materialization helpers.
- Create `src/core/clone.ts` — clone validation and idempotent provisioning state machine orchestration.
- Modify `src/db.ts` — provider-profile schema, tenant foreign key, clone/provisioning columns, indexes, and idempotent migrations.
- Modify `src/store/tenants.ts` — profile references, provisioning state, clone-safe creation/update methods, and compatibility reads.
- Modify `src/providers/index.ts` and `src/providers/types.ts` — profile/provider factory types and fallback diagnostics metadata.
- Modify `src/http/app.ts` — load profile snapshots and wire fallback provider instances to tool, MCP, and waker paths.
- Modify `src/http/portal.ts` — provider settings, redacted profile list, key rotation/validation forms, location list, clone form, and retry/disable actions using the Connect-style white/orange UI.
- Modify `src/core/provision.ts` — expose idempotent tool provisioning steps and preserve legacy onboarding behavior.
- Modify `src/core/analyze.ts` and `src/http/tool.ts` — pass modality/attempt context and emit redacted provider diagnostics without changing user-safe output.
- Test `test/provider-profiles.test.ts`, `test/fallback-provider.test.ts`, `test/clone.test.ts`, and extend `test/migration.test.ts`, `test/stores.test.ts`, `test/portal.test.ts`, `test/providers.test.ts`.

## Task 1: Add encrypted provider-profile persistence and legacy migration

**Files:**
- Create: `src/store/provider-profiles.ts`
- Modify: `src/db.ts`
- Modify: `src/store/tenants.ts`
- Test: `test/provider-profiles.test.ts`
- Test: `test/migration.test.ts`
- Test: `test/stores.test.ts`

- [ ] **Step 1: Write failing profile-store tests.** Cover encrypted round trips for Gemini/OpenAI keys, redacted list output, one profile reused by two tenants, staged rotation on validation failure, and successful rotation versioning. Assert raw SQLite never contains plaintext keys.
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm test -- test/provider-profiles.test.ts test/migration.test.ts test/stores.test.ts`

  Expected: FAIL because the profile store/schema/API do not exist.
- [ ] **Step 3: Add idempotent SQLite schema/migrations.** Add `provider_profiles` with `id`, encrypted `gemini_key_enc`/`openai_key_enc`, `primary_provider`, `fallback_enabled`, `coverage_label`, `version`, `created_at`, `updated_at`, `gemini_health`, `openai_health`, `gemini_health_detail`, `openai_health_detail`, `last_gemini_check_at`, `last_openai_check_at`, and `legacy_tenant_id UNIQUE`; add nullable `tenants.provider_profile_id` with an index/foreign-key reference, plus `provisioning_state` and `provisioning_step`. Preserve old encrypted columns and make repeated `openDb()` safe.
- [ ] **Step 4: Implement the profile store.** Reuse `encryptSecret`/`decryptSecret`; expose `create`, `getSnapshot`, `listRedacted`, `validateAndCreate`, `rotate`, `setHealth`, and `materializeLegacy(tenantId)`. Candidate keys are validated before the transaction; fallback enablement is rejected unless the fallback provider health is `healthy`, while a primary health failure does not erase a previously valid key. `materializeLegacy` must insert/link under an explicit synchronous SQLite transaction/write lock and recover a uniqueness conflict by re-reading the existing profile.
- [ ] **Step 5: Wire tenant compatibility reads.** Add `providerProfileId` and provisioning fields to `Tenant`; lazily materialize exactly one profile for legacy rows while keeping old fields readable; never render key values. Materialization must verify the legacy provider/key first, atomically insert/link the profile, and disable the affected tenant with a redacted event if migration fails; it must not silently continue an invalid credential path.
- [ ] **Step 6: Run the focused tests and typecheck.**

  Run: `npm test -- test/provider-profiles.test.ts test/migration.test.ts test/stores.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 7: Commit the persistence layer.**

  Run: `git add src/db.ts src/store/tenants.ts src/store/provider-profiles.ts test/provider-profiles.test.ts test/migration.test.ts test/stores.test.ts && git commit -m "feat: add encrypted shared provider profiles"`

## Task 2: Implement modality-aware Gemini/OpenAI fallback

**Files:**
- Create: `src/providers/fallback.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/index.ts`
- Test: `test/fallback-provider.test.ts`
- Extend: `test/providers.test.ts`

- [ ] **Step 1: Write failing routing tests.** Cover Gemini-primary audio/image success, transient retry then OpenAI fallback, OpenAI-primary routing, Gemini-only video/PDF, no fallback on 401/invalid input/policy errors, both providers failing, and redacted attempt metadata.
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm test -- test/fallback-provider.test.ts test/providers.test.ts`

  Expected: FAIL because the fallback wrapper and metadata types do not exist.
- [ ] **Step 3: Define provider result/diagnostic types and classifier.** Keep `MediaProvider.describe()` compatible; add an internal `ProviderAttempt`/diagnostic callback type and classify only timeout, transport, 429, and 5xx as fallback-eligible.
- [ ] **Step 4: Implement deterministic routing.** Force video/PDF to Gemini; route audio/image to the configured primary, then the alternate only after eligible transient failure. Do not mutate profile configuration during a request.
- [ ] **Step 5: Ensure provider adapters preserve redaction.** Do not include keys, media bytes, signed URLs, or upstream bodies in errors/events. Keep OpenAI’s honest unsupported notices out of fallback success paths.
- [ ] **Step 6: Run tests and typecheck.**

  Run: `npm test -- test/fallback-provider.test.ts test/providers.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 7: Commit fallback behavior.**

  Run: `git add src/providers src/providers/fallback.ts test/fallback-provider.test.ts test/providers.test.ts && git commit -m "feat: add modality-aware provider fallback"`

## Task 3: Wire profile snapshots and redacted diagnostics into the runtime

**Files:**
- Modify: `src/http/app.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/http/tool.ts`
- Modify: `src/core/waker.ts`
- Modify: `src/store/events.ts` only if a typed redacted event helper is needed
- Test: `test/tool-endpoint.test.ts`, `test/analyze.test.ts`, `test/e2e-mock.test.ts`

- [ ] **Step 1: Write failing runtime tests.** Assert a tenant linked to a profile gets the fallback provider in direct tool, MCP, and waker paths; transient primary failures return fallback text; diagnostics include provider/status/duration but never credentials or attachment content.
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm test -- test/tool-endpoint.test.ts test/analyze.test.ts test/e2e-mock.test.ts`

  Expected: FAIL because `app.ts` still calls `getProvider(t.provider, t.aiKey)`.
- [ ] **Step 3: Add a profile snapshot factory.** In `buildApp`, resolve legacy profiles once per request/tenant, construct primary/fallback providers with existing timeout options, and inject the same provider factory into tool, MCP, portal, and waker dependencies.
- [ ] **Step 4: Emit redacted provider diagnostics.** Thread an optional diagnostic sink through attachment analysis; record one event per attempt with `{provider, modality, outcome, statusClass, durationMs, attempt}` plus a redacted aggregate result, while preserving the existing safe user-facing error contract. Never include keys, media bytes, signed URLs, prompts, or upstream bodies.
- [ ] **Step 5: Run the focused tests and full typecheck.**

  Run: `npm test -- test/tool-endpoint.test.ts test/analyze.test.ts test/e2e-mock.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 6: Commit runtime wiring.**

  Run: `git add src/http/app.ts src/core/analyze.ts src/http/tool.ts src/core/waker.ts src/store/events.ts test/tool-endpoint.test.ts test/analyze.test.ts test/e2e-mock.test.ts && git commit -m "feat: wire provider profiles into media runtime"`

## Task 4: Add safe clone validation and idempotent provisioning state

**Files:**
- Create: `src/core/clone.ts`
- Modify: `src/core/provision.ts`
- Modify: `src/store/tenants.ts`
- Modify: `src/db.ts` if state columns were not added in Task 1
- Test: `test/clone.test.ts`
- Extend: `test/provision.test.ts`, `test/batch.test.ts`

- [ ] **Step 1: Write failing clone tests.** Cover missing/equal/swapped IDs, duplicate GHL location rejection, source profile reuse, source PIT reuse when it validates, `pending_credentials` when it does not, one requested assistant, disabled-on-assignment-failure, crash/retry resumption, no duplicate tenant/tool on repeated retry, and clone isolation (fresh bridge token, cursor, processed-message namespace, event history, and assets while sharing only the provider profile).
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm test -- test/clone.test.ts test/provision.test.ts test/batch.test.ts`

  Expected: FAIL because clone orchestration/state methods do not exist.
- [ ] **Step 3: Implement clone input validation and inheritance.** Reuse the existing CUID/location checks and media-host normalizer; reject unsafe hosts, duplicate locations, ambiguous assistant lists, and invalid source/profile references before any write. Copy the source tenant’s label-independent operational settings (analysis instruction, modalities, trusted hosts, waker policy, provider-profile link) and apply only the requested label/IDs/overrides.
- [ ] **Step 4: Implement the persisted state machine and credential completion.** Create a disabled pending row, validate profile/v3/PIT/assistant, provision/reuse analyze and send tools with stable names/URLs, record each completed step, and enable only at `ready`. If source PIT validation fails, persist `pending_credentials` with no plaintext PIT in HTML/logs; add a credential-completion operation that encrypts the target PIT, re-runs validation, and resumes from `validating`. Reuse the workspace-scoped Assistable v3 key by default and never ask for provider keys on a clone.
- [ ] **Step 5: Implement targeted tool assignment and retry/disable semantics.** Add clone-specific provisioning that verifies and assigns tools only to the requested assistant ID; leave legacy `ensureTool`/`ensureSendTool` all-assistant behavior unchanged. If source and target share a subaccount, never repoint the source’s static-name tool: create a tenant-scoped tool name/identity and persist it; only reuse a tool when its URL already matches the target token. Retry resumes idempotently after crashes or external API success before SQLite update. Disable prevents waking but preserves source and clone records for diagnosis; never mint a second token for the same target location.
- [ ] **Step 6: Run tests and typecheck.**

  Run: `npm test -- test/clone.test.ts test/provision.test.ts test/batch.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 7: Commit cloning/provisioning.**

  Run: `git add src/core/clone.ts src/core/provision.ts src/store/tenants.ts src/db.ts test/clone.test.ts test/provision.test.ts test/batch.test.ts && git commit -m "feat: add idempotent location cloning"`

## Task 5: Build the Connect-style provider and location operator UI

**Files:**
- Modify: `src/http/portal.ts`
- Modify: `src/http/app.ts` portal context wiring
- Test: `test/portal.test.ts`

- [ ] **Step 1: Write failing portal tests.** Cover redacted provider list, create/rotate validation responses, repeated idempotent `PUT` rotation, no secret in HTML/audit events, clone form with source profile read-only, successful clone redirect/status, pending-credentials state, retry, disable, and operator auth on every new route.
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm test -- test/portal.test.ts`

  Expected: FAIL because the new routes and screens do not exist.
- [ ] **Step 3: Add provider settings routes.** Implement `GET /operator/providers`, `POST /operator/providers`, `PUT /operator/providers/:id`, and `POST /operator/providers/:id/validate`; accept keys only in HTTPS-authenticated forms, validate before save, and return provider names/status timestamps only. Apply the existing operator rate-limit pattern (or add a small in-memory limiter if none exists) to health probes, rotations, and audit writes so a bad key or refresh cannot create an upstream/API-cost loop.
- [ ] **Step 4: Add locations/clone routes.** Implement `GET /operator/tenants`, `GET /operator/tenants/:id/clone`, `POST /operator/tenants/:id/clone`, retry, credential completion, and disable routes using existing session, same-origin, and audit patterns.
- [ ] **Step 5: Render the white/orange Connect-style UI.** Add left navigation for Locations, Provider settings, Activity & diagnostics, Assistants, and Media tools; show Gemini Primary/OpenAI Fallback cards, last health checks, coverage count, and a clone form that requests only swappable IDs plus target PIT when required.
- [ ] **Step 6: Run portal tests, full tests, and typecheck.** Include tests for invalid legacy materialization, fallback-enable gating, profile rotation while a request is in flight, and operator rate limits.

  Run: `npm test -- test/portal.test.ts && npm test && npm run typecheck`

  Expected: PASS with no secret leakage.
- [ ] **Step 7: Commit operator UI/API.**

  Run: `git add src/http/portal.ts src/http/app.ts test/portal.test.ts && git commit -m "feat: add provider and location operator portal"`

## Task 6: Production readiness verification and safe Vela rollout

**Files:**
- Modify: `README.md` or `docs/` operational documentation
- Test: all existing tests plus new provider/clone suites
- Verify: Render environment and health endpoint; do not commit secrets

- [ ] **Step 1: Run the complete local verification suite.**

  Run: `npm test && npm run typecheck`

  Expected: all tests pass and TypeScript exits 0.
- [ ] **Step 2: Add operational documentation.** Document profile creation/rotation, fallback eligibility, clone credential behavior, retry/disable states, redaction guarantees, and the Vela acceptance checks without including any live key or dashboard token.
- [ ] **Step 3: Verify the production build artifact.** Build/deploy from the feature branch, check `/health` reports the deployed commit, and inspect logs for startup errors or unredacted secrets.
- [ ] **Step 4: Configure the Vela profile through the authenticated portal.** Enter the user-supplied OpenAI key and existing Gemini credential only into the live HTTPS form; confirm both health checks and that Vela references the shared profile. Never paste the key into a shell command, file, commit, or chat response.
- [ ] **Step 5: Run non-destructive Vela smoke tests.** Exercise image/audio fallback with a forced transient test seam, verify video/PDF remain Gemini-routed, confirm tool assignment and one-location dedupe, verify clone isolation for assets/events/cursors/processed-message state, and inspect redacted diagnostics.
- [ ] **Step 6: Commit documentation and release notes.**

  Run: `git add README.md docs && git commit -m "docs: document provider fallback and location cloning"`

## Final verification checklist

- `npm test` passes, including legacy migration and live-clinic regression tests.
- `npm run typecheck` passes.
- No API key, ciphertext, signed URL, media bytes, or dashboard token appears in git diff, HTML, logs, or audit detail.
- Legacy tenants continue using their existing tool URLs and dedupe/cursor namespaces.
- Vela uses one shared provider profile; Gemini remains the video/PDF route, and OpenAI fallback is limited to eligible transient audio/image failures.
- Cloning a location changes only the approved swappable identifiers/settings and never copies contacts, appointments, assets, or message history.
- Failed external provisioning leaves a disabled, retryable record rather than a partially active live clinic.
