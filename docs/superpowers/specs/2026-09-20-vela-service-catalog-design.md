# Vela service catalog and Vagaro refresh

## Goal

Provide the Vela Med Spa assistant with a reliable `get_vela_service_catalog` tool for service names, prices, durations, deposits, and booking links. The live assistant must use an approved catalog, while Vagaro remains an optional source for detecting updates. A Vagaro parsing failure or unexpected change must never remove or silently replace the catalog used in customer replies.

## Scope and non-goals

The first release covers one catalog per connected bridge tenant (GHL location). Catalog opt-in is an explicit per-tenant setting (`catalog_enabled`, `catalog_tool_name`, and `vagaro_services_url`) set by an operator in the portal. For Vela, the operator enables the existing tenant whose GHL location is `drQDCqdgidEaO2Sexp34` and sets the exact tool name `get_vela_service_catalog`; there is no hidden “first tenant” selection and no hardcoded secret. Future tenants may opt in with their own tool name; no tenant can read another tenant's catalog. The release includes an Assistable custom tool endpoint, a protected operator portal, and a once-daily staged refresh from the configured public Vagaro services page. It does not place bookings, collect payments, or depend on a private Vagaro API. It does not auto-publish scraped prices. Multi-location catalog sharing, automatic publishing, and arbitrary website scraping are out of scope.

## Alternatives considered

1. **Manual catalog only.** Safest and simplest, but prices become stale and require an operator edit for every change.
2. **Live Vagaro lookup on every assistant call.** Always current, but adds latency and makes customer replies depend on a brittle public page and parser availability.
3. **Approved catalog plus staged Vagaro refresh (recommended).** Fast and deterministic for callers, with current data detected daily and human review before publication. The approved snapshot remains available during outages.

## Architecture

The existing bridge remains the system boundary. A new catalog store is keyed by the existing tenant id and keeps two snapshots:

- `approved`: the only snapshot exposed to the assistant;
- `draft`: the most recent manually edited or Vagaro-refreshed candidate.

Each snapshot contains a version, source (`manual` or `vagaro`), `refreshed_at`, `approved_at`, normalized services, booking URL, one global deposit policy, and a validation status. The approved snapshot's `last_updated` is its `approved_at`; a draft has its own `refreshed_at` and is never reported as approved. Catalog data is stored in SQLite alongside tenant data; no secrets or raw scraped HTML are persisted.

The portal uses the existing `requireOperator` session, not a tenant token, for catalog administration. It exposes the current approved catalog, draft differences, a JSON/row editor, the configured Vagaro services URL, `Refresh now`, `Save draft`, and `Publish draft`. A daily job invokes the same refresh service for enabled tenants with a Vagaro URL. Due times are stored in UTC as `next_refresh_at`; an hourly in-process timer runs due tenants and startup runs any tenant already overdue. A SQLite lease (`catalog_refresh_leases`) prevents duplicate work across processes, with a short expiry for crash recovery. A failed run records the attempt and schedules the next normal daily attempt; it does not retry in a tight loop.

## Catalog contract

The normalized payload returned inside the existing Assistable custom-tool envelope is:

```json
{
  "ok": true,
  "location": "Vela Med Spa",
  "source": "approved_catalog",
  "last_updated": "2026-09-20T12:00:00.000Z",
  "stale": false,
  "booking_url": "https://…",
  "deposit": {
    "amount": 20,
    "currency": "USD",
    "refundable": false,
    "note": "A $20 non-refundable deposit is required to reserve an appointment."
  },
  "services": [
    {
      "id": "stable-slug",
      "name": "Service name",
      "category": "Category",
      "duration_minutes": 60,
      "price": { "amount": 150, "currency": "USD" },
      "description": "Approved customer-facing description"
    }
  ],
  "message": "Use only these approved prices and details."
}
```

`deposit` is either the approved global policy object or `null` when the page and operator have not established a policy. The assistant must never infer a deposit from a service price; when it is `null`, it must say the deposit is not listed and offer the booking link or team follow-up.

The HTTP wire shape is always `200 application/json` with `{ "result": "<JSON-serialized catalog payload>" }`, matching the existing media tools. The tool accepts no customer-supplied URL or tenant id. The route identifies the tenant using its opaque bridge token. An empty or unavailable catalog returns a serialized `ok: false` payload with a safe message and never invents pricing. A draft is not usable until an operator publishes it, so a new tenant's tool returns the unavailable response until its first approved snapshot exists.

## Assistable provisioning

When an operator enables catalog access or changes its tool name, the portal immediately runs the same create-or-recover provisioning flow and shows warnings inline if it cannot complete. Provisioning adds/reuses a custom V3 tool named `get_vela_service_catalog` for the Vela tenant, points it to `POST /catalog/:tenantToken`, updates the description and URL when an existing tool is found, assigns it to the configured assistant and any assistants returned by the existing workspace-wide `listAssistants` call, and persists both `catalog_tool_id` and `catalog_tool_name`. A later tool-name change provisions/reuses the new name before replacing the stored id; the old tool is left untouched if the API has no delete/unassign operation and is reported for manual cleanup. A `Retry catalog tool setup` action repeats the flow without changing catalog data. Re-running setup is safe. Other tenants can opt in with a tenant-specific tool name later; this release must not cross-read another tenant's catalog.

The tool description instructs the model to call it for any service, pricing, duration, deposit, or booking-link question; to use only returned values; and to say the team will confirm when the catalog is unavailable or marked stale. It must not expose operator tokens or internal URLs.

## Vagaro refresh flow

1. The tenant stores a validated HTTPS Vagaro services URL. The Vela fixture and initial configuration use `https://mysite.vagaro.com/glambynatalia1/services`; other tenants must configure their own URL in the portal.
2. The refresh worker fetches the page with a bounded timeout, follows no arbitrary redirects, and limits response size.
3. The parser extracts visible service name, category, duration, price, description, booking URL, and deposit text where present. Unsupported or ambiguous rows are reported as warnings rather than guessed. The initial parser fixture is a checked-in, sanitized HTML capture of the Vela URL above, so parser tests do not depend on the live site.
4. The result is normalized, deduplicated by stable slug, validated (prices are finite and non-negative with at most two decimal places; durations are positive; required names exist), and saved as `draft` with a diff against `approved`. The parser supports one global deposit policy; service-specific deposit text is reported as a warning and is not guessed into the global field. No deposit produces `deposit: null`.
5. The operator reviews and publishes the draft. Publish atomically swaps the approved snapshot and clears the draft.

If fetch, parsing, validation, or persistence fails, the approved catalog stays unchanged. The portal shows the error and timestamp, and the tool continues serving the previous approved snapshot. Daily refreshes use a per-tenant lock so two runs cannot overwrite one another.

## Error handling and safety

- All catalog tool failures return HTTP 200 with a model-safe JSON result, matching the existing media tool convention.
- The route validates the tenant is enabled and records audit events for reads, refresh attempts, publish operations, and failures.
- Vagaro URLs are restricted to HTTPS and an allowlist of the tenant's configured host; no user-provided URL is fetched by the assistant.
- Currency is an explicit tenant setting, defaulting to `USD` for Vela. A parsed currency symbol wins only when it is unambiguous and matches the configured currency; otherwise the row is warned and excluded from publication.
- Extracted booking URLs must be HTTPS and either share the configured services host or end in the approved `vagaro.com` domain. Other links are omitted and recorded as warnings. A service without a valid booking URL inherits the catalog-level `booking_url` when one exists; otherwise its link is omitted.
- HTML is treated as untrusted text; scripts, hidden fields, and arbitrary links are ignored.
- Staleness is informational. An approved catalog is marked stale when its `approved_at` is more than 48 hours old, but remains usable until replaced, so a temporary Vagaro outage does not break replies. A draft's age never changes the approved tool response.
- No customer PII is sent to Vagaro. The refresh is a public-page read only.

Catalog limits are explicit: at most 200 services, 120-character names/categories, 1,000-character descriptions, prices from 0 through 1,000,000 in the declared currency, and a 256 KB serialized snapshot. These limits keep tool responses and SQLite rows bounded.

Refresh warnings are persisted with the draft and displayed in the portal. Snapshot versions increment monotonically per tenant. `Save draft` and `Publish draft` accept the version currently displayed by the operator; a mismatch returns a conflict and leaves the newer snapshot untouched, preventing two browser tabs from silently overwriting one another.

## Testing and acceptance criteria

Test-first coverage will include:

- schema migration and round-trip persistence of approved/draft snapshots;
- normalization, slugging, price/duration validation, deduplication, and diff generation;
- parser fixtures for the Vela Vagaro page plus malformed/changed HTML;
- refresh success, timeout, disallowed-host, parser failure, and stale-catalog fallback;
- atomic publish and concurrent refresh serialization;
- tool responses for enabled, disabled, missing, empty, and stale tenants;
- provisioning create, reuse, URL update, assignment, and retry behavior;
- portal authentication and operator-only refresh/publish actions.

Acceptance is met when a Vela assistant call returns the approved catalog in one bridge request, the portal can refresh a draft and publish it without changing the old catalog first, and all existing media-bridge tests remain green.
