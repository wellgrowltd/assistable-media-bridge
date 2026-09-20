# Vela Service Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-scoped, approved Vela service catalog tool with staged daily Vagaro refreshes, operator review/publish controls, and safe Assistable provisioning.

**Architecture:** Store approved and draft catalog snapshots in SQLite per tenant. A pure normalizer/parser turns manual rows or bounded Vagaro HTML into validated drafts; a catalog service owns refresh, diff, publish, and staleness behavior. A protected catalog tool route serves only the approved snapshot, while portal actions configure the tenant, edit/save drafts, refresh, publish, and retry Assistable provisioning. A small due-time scheduler runs staged refreshes without replacing the existing waker loop.

**Tech Stack:** TypeScript, Express, node:sqlite, Vitest, existing Assistable V3 client, existing operator-session portal, native `fetch`.

---

## File map

- Create `src/catalog/types.ts`: bounded catalog domain types, tool payload, and validation limits.
- Create `src/catalog/normalize.ts`: slugging, field limits, currency/price/duration validation, deduplication, and approved-vs-draft diff.
- Create `src/catalog/vagaro.ts`: HTTPS/host validation, bounded fetch, fixture-friendly Vagaro HTML extraction, booking-link validation, and refresh result.
- Create `src/store/catalogs.ts`: SQLite schema, snapshot persistence, leases, configuration, and optimistic versions.
- Create `src/core/catalog.ts`: catalog read, draft save, refresh orchestration, publish, stale fallback, and audit/event hooks.
- Create `src/http/catalog.ts`: Assistable `POST /catalog/:token` route returning the existing `{result: string}` envelope.
- Modify `src/db.ts`: register catalog tables and migrations.
- Modify `src/store/tenants.ts`: persist catalog opt-in, tool name/id, Vagaro URL, booking URL, and currency settings.
- Modify `src/core/provision.ts`: create/recover/update/assign the catalog tool and persist its id/name.
- Modify `src/http/portal.ts`: operator-only catalog configuration, draft editor, refresh/publish/retry actions, diff/warning display, and form handling.
- Modify `src/http/app.ts` and `src/index.ts`: wire catalog dependencies and the hourly due-refresh scheduler.
- Create `test/catalog-normalize.test.ts`, `test/catalog-vagaro.test.ts`, `test/catalog-store.test.ts`, `test/catalog-core.test.ts`, `test/catalog-tool.test.ts`, `test/catalog-provision.test.ts`, and `test/catalog-portal.test.ts`.
- Create `test/fixtures/vagaro-vela-services.html`: sanitized representative capture of `https://mysite.vagaro.com/glambynatalia1/services`.
- Modify `README.md` and `docs/operations.md`: operator setup, daily refresh behavior, safe publish, and Assistable prompt guidance.

## Task 1: Define catalog types and pure normalization

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/normalize.ts`
- Test: `test/catalog-normalize.test.ts`

- [ ] **Step 1: Write failing tests** for stable slugs, maximum service/name/description limits, two-decimal non-negative prices, positive durations, optional `deposit: null`, duplicate replacement, and deterministic approved/draft diffs.
- [ ] **Step 2: Run the focused tests** with `npm test -- test/catalog-normalize.test.ts`; verify they fail because the catalog modules do not exist.
- [ ] **Step 3: Implement the bounded domain types and pure functions** with no network or database access. Define `CatalogSnapshot`, `CatalogService`, `DepositPolicy | null`, `CatalogDraft`, warning types, and the limits from the spec.
- [ ] **Step 4: Run the focused tests** and then `npm run typecheck`; expected: all new tests pass and typecheck is clean.
- [ ] **Step 5: Commit** `feat: add catalog normalization primitives`.

## Task 2: Add SQLite catalog storage and tenant configuration

**Files:**
- Create: `src/store/catalogs.ts`
- Modify: `src/db.ts`
- Modify: `src/store/tenants.ts`
- Test: `test/catalog-store.test.ts`

- [ ] **Step 1: Write failing storage tests** for approved/draft round trips, `deposit: null`, warnings, version increments, optimistic-concurrency conflicts, configuration persistence, and expiring refresh leases.
- [ ] **Step 2: Run `npm test -- test/catalog-store.test.ts`** and verify the expected missing-store/schema failures.
- [ ] **Step 3: Implement migrations and stores**. Add `catalog_enabled`, `catalog_tool_name`, `catalog_tool_id`, `vagaro_services_url`, `catalog_booking_url`, and `catalog_currency` to tenant persistence. Add catalog snapshots, diffs/warnings, and a lease table. Keep secrets encrypted only where existing tenant secrets require it; catalog data is non-secret.
- [ ] **Step 4: Run focused tests and the migration suite** with `npm test -- test/catalog-store.test.ts test/migration.test.ts`; expected: pass without changing existing tenant behavior.
- [ ] **Step 5: Commit** `feat: persist tenant service catalogs`.

## Task 3: Implement Vagaro extraction and safe staged refresh

**Files:**
- Create: `src/catalog/vagaro.ts`
- Create: `test/fixtures/vagaro-vela-services.html`
- Test: `test/catalog-vagaro.test.ts`
- Test: `test/catalog-core.test.ts`

- [ ] **Step 1: Add the sanitized Vela HTML fixture** captured from `https://mysite.vagaro.com/glambynatalia1/services`; remove scripts, customer data, and irrelevant markup while retaining service cards, pricing, duration, deposit text, and booking links.
- [ ] **Step 2: Write failing parser/refresh tests** for the fixture, malformed HTML, timeout, disallowed host, oversized response, invalid booking links, missing deposit, service-specific deposit warnings, configured-currency mismatches, booking-link inheritance, the 256 KB snapshot limit, stale approved fallback, and refresh lease serialization.
- [ ] **Step 3: Run `npm test -- test/catalog-vagaro.test.ts test/catalog-core.test.ts`** and verify red failures.
- [ ] **Step 4: Implement bounded HTTPS fetch and parser**. Use `redirect: "error"` (or validate every redirect hop before following it) so a configured host cannot redirect the worker to an arbitrary destination. Restrict to the configured host plus approved `vagaro.com` booking links, cap response bytes and timeout, ignore scripts/hidden fields, normalize through Task 1, persist warnings, and never mutate approved data during refresh.
- [ ] **Step 5: Implement core catalog orchestration** for manual draft save, Vagaro draft refresh, approved read, 48-hour stale marking, and atomic publish with version checks.
- [ ] **Step 6: Run focused tests and `npm run typecheck`**; expected: pass with no live-network dependency.
- [ ] **Step 7: Commit** `feat: add staged Vagaro catalog refresh`.

## Task 4: Expose the Assistable catalog tool

**Files:**
- Create: `src/http/catalog.ts`
- Modify: `src/http/app.ts`
- Test: `test/catalog-tool.test.ts`

- [ ] **Step 1: Write failing route tests** for enabled/disabled tenants, missing token, no approved catalog, fresh catalog, stale catalog, and the exact `{ result: JSON.stringify(payload) }` HTTP envelope.
- [ ] **Step 2: Run `npm test -- test/catalog-tool.test.ts`** and verify red failures.
- [ ] **Step 3: Implement `POST /catalog/:token`**. Resolve only the tenant encoded by the opaque token, return HTTP 200 model-safe JSON for expected failures, record audit/events, and never accept URL, tenant, or service parameters from the caller.
- [ ] **Step 4: Wire the route into `buildApp`** and run the focused tests plus existing `test/tool-endpoint.test.ts`; expected: all pass.
- [ ] **Step 5: Commit** `feat: serve approved catalog to Assistable`.

## Task 5: Provision and recover the Assistable tool

**Files:**
- Modify: `src/core/provision.ts`
- Modify: `src/store/tenants.ts`
- Test: `test/catalog-provision.test.ts`

- [ ] **Step 1: Write failing provisioning tests** for create, conflict lookup, URL/description update, assignment to configured and workspace assistants, retry after failure, and tool-name change preserving the old id when unassign is unavailable.
- [ ] **Step 2: Run `npm test -- test/catalog-provision.test.ts`** and verify red failures.
- [ ] **Step 3: Implement `ensureCatalogTool`** with the exact Vela default name `get_vela_service_catalog`, URL `${PUBLIC_BASE_URL}/catalog/${tenant.token}`, safe description, persisted `catalog_tool_id/name`, and warnings instead of onboarding failure.
- [ ] **Step 4: Run focused tests and existing `test/provision.test.ts test/v3.test.ts`**; expected: all pass.
- [ ] **Step 5: Commit** `feat: provision Assistable service catalog tool`.

## Task 6: Add protected operator portal controls

**Files:**
- Modify: `src/http/portal.ts`
- Test: `test/catalog-portal.test.ts`

- [ ] **Step 1: Write failing portal tests** for operator authorization, catalog enable/configuration, manual row/JSON draft save (including a Save draft optimistic-concurrency conflict), refresh-now, diff/warning rendering, publish conflict, publish success, and retry-tool-setup.
- [ ] **Step 2: Run `npm test -- test/catalog-portal.test.ts`** and verify red failures.
- [ ] **Step 3: Add the operator-only catalog panel**. Every catalog GET and POST must pass the existing `requireOperator` middleware; do not expose catalog administration through a tenant-token-only route. Show approved and draft metadata, Vela defaults, Vagaro URL, currency, booking URL, service rows, warnings, and explicit buttons for Save draft, Refresh now, Publish draft, and Retry catalog tool setup.
- [ ] **Step 4: Wire enable/name changes to `ensureCatalogTool`** and surface provisioning warnings without discarding catalog data. Ensure every mutating action checks the stored snapshot version.
- [ ] **Step 5: Run portal tests plus `test/portal.test.ts test/portal-assets.test.ts`**; expected: pass.
- [ ] **Step 6: Commit** `feat: add operator catalog controls`.

## Task 7: Schedule daily staged refreshes and update operations docs

**Files:**
- Modify: `src/index.ts`
- Modify: `src/http/app.ts`
- Modify: `src/config.ts` only if a refresh interval/limit needs environment tuning
- Modify: `README.md`
- Modify: `docs/operations.md`
- Test: `test/catalog-core.test.ts` (scheduler cases)

- [ ] **Step 1: Write failing scheduler tests** for due-at startup, hourly checks, disabled tenants, missing Vagaro URL, lease expiry, and failed refresh scheduling the next normal daily attempt.
- [ ] **Step 2: Run the focused scheduler tests** and verify red failures.
- [ ] **Step 3: Add a startup refresh pass before starting the hourly unref'd timer**, then have the timer lease due catalog tenants in UTC, run staged refreshes, record errors, and schedule the next daily due time; keep it independent from the existing waker timer.
- [ ] **Step 4: Wire dependencies and document setup**: enable Vela by selecting its existing tenant, set `get_vela_service_catalog`, configure the Vagaro URL/currency/booking link, publish the first draft, and update Ava's prompt to call the tool for every service/pricing/deposit question.
- [ ] **Step 5: Run the complete suite** with `npm test` and `npm run typecheck`; expected: all existing and new tests pass.
- [ ] **Step 6: Commit** `feat: schedule safe daily catalog refreshes`.

## Task 8: Final verification and deployment handoff

**Files:**
- No code changes unless verification finds a defect.

- [ ] **Step 1: Run `npm test` and `npm run typecheck` from the worktree** and save the results.
- [ ] **Step 2: Exercise the catalog route in mock mode** with an approved fixture and confirm the exact Assistable envelope and stale behavior.
- [ ] **Step 3: Review the portal flow manually**: enable Vela, provision/retry the tool, save a draft, refresh, inspect warnings/diff, publish, then call the tool again.
- [ ] **Step 4: Confirm existing media tools and live tenant records are untouched** by checking existing tool URLs, tenant ids, and test coverage.
- [ ] **Step 5: Commit any verification-only fixes separately** and report the deployment steps; do not deploy production until the user explicitly authorizes it.
