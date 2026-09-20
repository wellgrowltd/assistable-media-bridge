import { loadConfig } from "./config";
import { authPauseMessage, runWakerCycle, startWaker } from "./core/waker";
import { buildApp } from "./http/app";

const config = loadConfig();
const { app, wireDeps } = buildApp(config);

app.listen(config.port, () => {
  console.log(`media-mcp listening on :${config.port} (mock=${config.mock})`);
});

startWaker(
  (t) => runWakerCycle(wireDeps.wakerDepsFor(t), t),
  () => wireDeps.tenants.list(),
  config.wakerIntervalMs,
  {
    concurrency: config.wakerConcurrency,
    // Persisted, not just in-memory: a restart must not resume polling a key
    // that is never coming back. Turning the waker back on is a deliberate
    // click on the dashboard, once the key is fixed.
    onAuthFailures: ({ tenant, consecutive, lastError }) => {
      wireDeps.tenants.setWaker(tenant.id, false);
      wireDeps.events.record(
        tenant.id, "error", authPauseMessage(consecutive, lastError)
      );
      console.warn(`[media-mcp] waker paused for tenant ${tenant.id} (${tenant.label}): ${lastError}`);
    },
  }
);
setInterval(() => wireDeps.processed.prune(7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();
setInterval(() => wireDeps.audit.prune(Date.now() - 30 * 24 * 60 * 60 * 1000), 6 * 60 * 60 * 1000).unref();
