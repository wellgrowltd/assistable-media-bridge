# Shared providers and safe location cloning

The bridge supports one encrypted provider profile shared by multiple locations.
Each profile can hold Gemini and OpenAI credentials, designate a primary provider,
and enable fallback only after the alternate key has passed a health check.

## Provider behavior

- Gemini remains the only route for video and PDF extraction.
- Audio and image extraction use the configured primary provider.
- OpenAI is tried only after a transient primary failure (timeout, transport
  failure, HTTP 429, or HTTP 5xx). Authentication, unsupported-input, and policy
  failures are returned without switching providers.
- Provider-attempt events contain provider, modality, outcome, status class,
  attempt number, and duration. They never contain API keys, signed URLs, media
  bytes, prompts, or upstream response bodies.
- Rotations validate the candidate key before changing the encrypted value. A
  failed rotation leaves the current profile untouched.

## Operator portal

With `OPERATOR_TOKEN` configured, use:

- `/operator/providers` to create and review redacted shared profiles.
- `/operator/tenants` to view locations and start a clone.
- `/operator/tenants/:id/clone` to enter only the target label, GHL location ID,
  Assistable assistant/subaccount IDs, and (if required) a target PIT.

Provider forms are HTTPS/operator-session protected and rate limited. API keys are
accepted only in the form request, validated server-side, encrypted at rest, and
never placed in HTML, audit detail, or logs.

## Clone lifecycle

1. Validate target IDs and trusted media hosts before writing anything.
2. Create a new disabled tenant with a fresh bridge token and `pending` state.
3. Reuse the source provider profile and operational settings (analysis guidance,
   modalities, trusted hosts, and waker policy). Assets, events, cursors,
   processed-message state, and contacts are not copied.
4. Validate the target Assistable key, assistant, and GHL PIT.
5. Create or recover a tenant-scoped attachment tool and assign it only to the
   requested assistant. A shared subaccount never causes the source tool to be
   repointed.
6. Set the tenant to `ready` and enable it only after every required step passes.

If the PIT is not authorized for the target, the row remains disabled with state
`pending_credentials`; a failed tool step is `failed` and can be retried without
minting a second token or location row. Disabling a clone preserves its records
for diagnosis and stops the waker.

## Production checklist

- Confirm `/health` reports the expected deployed commit.
- Confirm both provider health indicators before enabling fallback.
- Create one test clone and verify that its tool URL contains a different bridge
  token from the source.
- Send a non-sensitive image and voice note; inspect only redacted
  `provider_attempt` events.
- Confirm video and PDF requests remain Gemini-routed.
- Never paste live credentials into source files, shell history, commits, or chat.
