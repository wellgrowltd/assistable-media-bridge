# Provider fallback and location cloning

## Goal

Add a production-safe operator workflow for using WellGrow's paid AI provider
credentials across multiple Assistable/GHL locations, while allowing each
location to swap only its own identifiers. The first live consumer is the Vela
location, but the design must support additional locations without copying API
keys or creating a second source of truth.

## Non-goals

- Do not expose provider keys in HTML, logs, audit detail, tool URLs, or git.
- Do not remove the existing single-provider tenant path in one release; live
  locations must continue working during migration.
- Do not add automatic cloning of conversations, contacts, assets, or GHL data.
- Do not promise OpenAI support for modalities it cannot process in this bridge
  (currently video and PDF/document extraction stay on Gemini).

## Chosen approach: shared provider profiles plus location clones

Create a shared, encrypted provider profile containing the Gemini key, the
OpenAI key, the primary provider, and the fallback policy. A tenant/location
references that profile. A clone copies the location's operational settings
and references the same provider profile; only these fields are replaced:

- display/location label
- GHL location ID
- Assistable subaccount ID
- Assistable assistant ID
- optional per-location trusted media host overrides and enabled modalities

The source tenant remains unchanged. The clone receives a new bridge token,
processed-message namespace, cursor, event history, and tool URLs. No contacts,
appointments, assets, or media history are copied.

Existing tenants retain their current `provider`/`aiKey` fields during a
backward-compatible migration. On first read, the service may materialize a
profile from those fields; the original encrypted value remains valid until a
successful migration. New and migrated tenants use `provider_profile_id`.

## Provider profile and fallback behavior

The profile store contains encrypted-at-rest fields for `gemini_key` and
`openai_key`, `primary_provider`, `fallback_enabled`, an ownership/coverage
label, and timestamps for creation, update, and last validation. The API
returns only provider names, configured/healthy status, and last-check time;
never return key material or reversible ciphertext.

The runtime builds a deterministic provider route per tenant:

1. Video and PDF/document input always routes to Gemini. If Gemini is not
   configured, the profile is invalid for that modality and the request fails
   safely; OpenAI is never selected for these inputs.
2. Audio and image input starts with the configured primary provider. Retry it
   once only for transient upstream failures already covered by the existing
   bounded request policy (timeouts, 429, 5xx, transport failures).
3. If still transient and fallback is enabled, try the other configured
   provider when it supports that modality. The normal Vela profile is Gemini
   primary with OpenAI fallback, but the route remains deterministic if an
   operator later chooses OpenAI primary.
4. Do not fall back for invalid credentials, malformed input, policy/content
   rejection, or an unsupported modality. Record which provider produced the
   result and each attempt's latency.
5. If all eligible providers fail, return the existing user-safe attachment error and
   emit a redacted diagnostic event containing provider, modality, status class,
   attempt count, and duration — never request bodies, URLs with secrets, or
   response bodies that may contain attachment content.

The wrapper preserves the current `MediaProvider` interface so the tool,
waker, dedupe, and attachment download code do not need provider-specific
branches. Fallback is per attachment invocation, not a global provider switch,
so a transient failure does not mutate configuration.

## Validation and key rotation

The operator can save a profile only after format validation and a live health
probe for each configured key. A failed fallback-key probe blocks enabling
fallback but does not disable an already healthy primary. Rotation validates a
candidate in memory before commit, then updates the encrypted value and
version in one SQLite transaction; if validation fails, the old value is
untouched. Runtime requests take a profile snapshot at start, so in-flight
calls finish with the old key and new calls use the new version. Key inputs are
accepted only over the authenticated operator portal and are never redisplayed
after submission.

Health checks and audit events are redacted and rate limited. A profile can be
shared by multiple locations owned/covered by WellGrow; the portal displays
the coverage scope so an operator can see which locations would be affected by
rotation.

## Location cloning workflow

The operator portal adds a Locations view and a Clone location action. The
clone form shows the source location and provider profile as read-only, then
asks for the new label, GHL location ID, Assistable subaccount ID, assistant ID,
and optional media-host/modality overrides. Provider keys are never requested
by the clone form. The source profile is reused. The source encrypted
Assistable v3 key is also reused by default when it is workspace-scoped. GHL
PIT handling is explicit: if the source PIT validates for the target GHL
location, it is reused; otherwise the clone is created in
`pending_credentials` and the portal asks for the target PIT through a separate
HTTPS credential form before it can be enabled. This preserves the “swap only
IDs” fast path without pretending a location-scoped PIT can authorize another
location. The workflow must:

1. Reject missing IDs, equal/swapped GHL and Assistable IDs, and an existing
   GHL location before any write.
2. Validate the reused or newly supplied GHL PIT, the Assistable v3 key, and
   the shared provider profile for the target.
3. Verify the target assistant is visible to the target subaccount and that the
   target location is not already provisioned.
4. Create a `pending` tenant record and run idempotent provisioning steps for
   its new tool URLs, then assign the analyze and send tools to the one
   requested assistant ID. The existing legacy path may still assign tools to
   all assistants discovered by v3; the clone contract itself is one requested
   assistant and does not accept an ambiguous assistant list.
5. Mark the tenant enabled only after all required steps succeed. If a
   downstream tool assignment fails, leave the location disabled with a
   clear retry action; never partially enable a location that could double-wake
   messages.

The clone result shows non-secret identifiers, provider health, tool assignment
status, and a copyable dashboard link. It offers Retry setup and Disable, not
destructive deletion of the source tenant. Provisioning is a small persisted
state machine (`pending` → `validating` → `provisioning` → `ready`, or
`pending_credentials`/`failed`). Retry resumes from the last idempotent step;
repeated retries never create a second tenant or duplicate tool. A crash before
the final enable leaves the tenant disabled and recoverable.

## Portal/API surface

- `GET /operator/providers`: list provider profiles with redacted status.
- `POST /operator/providers`: create a profile; accepts provider keys only in
  the request body and returns health results without key data. Rotation uses
  `PUT /operator/providers/:id` with the same staged validation semantics, so a
  retried request is idempotent for the profile ID.
- `POST /operator/providers/:id/validate`: re-run health checks.
- `POST /operator/tenants/:id/clone`: clone a tenant with the swappable IDs.
- `GET /operator/tenants`: list locations, profile assignment, status, and last
  provider check.

All operator routes use the existing operator session/token, CSRF protection
where present, audit logging, and the same white/orange Connect-style UI. The
existing dark onboarding pages remain valid for backward compatibility; the new
views can be linked from the operator dashboard without changing live tool
URLs.

## Persistence and migration

Add a provider-profile table and a tenant foreign key/index. Migration is
idempotent and safe for old SQLite files. The migration must:

- create the profile table if absent;
- add a nullable profile reference to tenants;
- preserve and decrypt existing tenant secrets;
- materialize a profile for legacy tenants only when both the old key and
  provider value are valid. The deterministic source of truth is the tenant's
  `provider_profile_id`: while null, create exactly one profile for that tenant
  in the same synchronous SQLite transaction and set the FK; after that, the
  profile is authoritative and legacy columns are read-only compatibility data.
  A unique `(legacy_tenant_id)` marker prevents duplicate first-read profiles;
- leave the old columns readable until all runtime and portal paths use the
  profile reference.

Any migration error must fail closed for the affected tenant, not erase or
overwrite credentials. A restart must be safe and must not create duplicate
tenants or duplicate provider profiles. Per-location trusted media-host
overrides reuse the existing hostname normalizer/allowlist: lower-cased HTTPS
hostnames only; localhost, IP literals, private/link-local/reserved suffixes,
credentials, paths, and wildcards are rejected before clone creation.

## Testing and acceptance criteria

Provider-chain tests cover primary success, transient retry then fallback,
primary auth failure with no fallback, unsupported video/PDF behavior, both
providers failing, redacted diagnostics, and latency/attempt metadata. Store
tests cover encrypted profile round trips, legacy migration, profile reuse,
atomic rotation, and clone isolation (new token/cursor/dedupe namespace with
shared profile ID). Portal tests cover redacted responses, validation errors,
duplicate-location rejection, successful clone, disabled-on-assignment-failure,
and no secret leakage in rendered HTML or audit logs. Existing test suites and
TypeScript checks must remain green.

The feature is ready for Vela when: the Vela profile validates both providers,
the Vela tenant references that profile, a forced Gemini transient failure
returns an OpenAI result for image/audio, video/PDF remain Gemini-backed, and a
new location can be cloned and validated without entering either provider key.
