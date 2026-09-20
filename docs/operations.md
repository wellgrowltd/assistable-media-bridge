# Media bridge operations

The media bridge is a separate service from the booking bridge. One tenant is
one GHL location. A tenant token only addresses that location; credentials are
encrypted at rest and are never rendered in the dashboard.

## Render

Run one web instance with `WEB_CONCURRENCY=1` and a persistent disk. Set
`MOCK_MODE=0`, `DB_PATH=/data/media-mcp.sqlite`, `ENCRYPTION_KEY`, and the
public Render URL. Set a long random `OPERATOR_TOKEN`. Open the public URL in a
browser and paste that token into the operator sign-in page; the bridge keeps a
short-lived signed browser session, so the token is not stored in the cookie.
Provisioning API/CLI calls may still send `Authorization: Bearer <OPERATOR_TOKEN>`
directly. Keep the disk for recovery only: run `npm run backup` to a
private object store or private backup volume and retain at least seven daily
copies. Run `npm run restore-check -- <backup>` weekly in an isolated process.

## Scope checklist

The GHL token must include `conversations.readonly` and
`conversations/message.readonly` for inbound media. `conversations/message.write`
is required before `send_media` can send an asset. If a token is read-only, the
send tool refuses before making an upstream call.

## Rollout and smoke test

1. Onboard one non-critical location in the portal and verify the credentials.
2. Confirm every discovered assistant appears in the dashboard and is `ready`.
3. Send one voice note, image, PDF, and video; confirm one assistant reply per
   attachment and inspect the event feed for latency/errors.
4. Register one HTTPS asset and send it once; inspect the outbox state.
5. Toggle the bridge or a modality off and verify the tool returns a truthful
   disabled message. Re-enable only after the upstream issue is understood.

## Incidents

Disable the affected tenant first. Do not delete the database or rotate keys
while a send is `unknown`; reconcile the upstream conversation before retrying.
If a provider or GHL credential fails repeatedly, the waker pauses that tenant
only. Fix the credential, then re-enable the tenant and run the dashboard
reconciliation action. Booking services are not coupled to this service.

## Restore

Restore into a fresh directory, run `npm run restore-check`, and compare tenant
counts and recent audit entries. Reconcile cursor/outbox state before enabling
the waker. Never restore production over the live database without a tested
rollback copy.
