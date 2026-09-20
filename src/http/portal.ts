import { Router, type Request, type Response, type NextFunction } from "express";
import { parseBatchRows, provisionBatch, redactPits } from "../core/batch";
import { mapLimit } from "../core/concurrency";
import { assetWarnings, normalizeAssetName, validateAssetUrl } from "../core/asset-url";
import { PROMPT_SNIPPET, type ProvisionDeps, ensureSendTool, ensureTool, ensureToolForAssistant, provisionTenant } from "../core/provision";
import { cloneTenant, validateCloneInput, type CloneInput } from "../core/clone";
import type { LookupFn } from "../media/download";
import { MAX_CUSTOM_MEDIA_HOSTS, normalizeMediaHosts } from "../media/hosts";
import { MAX_ASSETS, type AssetStore } from "../store/assets";
import type { EventStore } from "../store/events";
import { MAX_ANALYSIS_INSTRUCTION } from "../store/tenants";
import { forgetTokens, rememberToken, rememberedTokens } from "./session";
import { clearOperatorSession, hasOperatorAccess, safeNext, setOperatorSession } from "./operator-session";
import type { AssistantBindingStore } from "../store/assistants";
import type { AuditStore } from "../store/audit";
import type { ProviderName, ProviderProfileStore } from "../store/provider-profiles";

export interface PortalCtx extends ProvisionDeps {
  assistantBindings?: AssistantBindingStore;
  audit?: AuditStore;
  operatorToken?: string;
  events: EventStore;
  assets: AssetStore;
  /** Injected by tests so asset validation never performs real DNS or HTTP. */
  assetLookup?: LookupFn;
  assetFetch?: typeof fetch;
  profiles?: ProviderProfileStore;
}

// ---- shared shell -----------------------------------------------------
// Signature element: the "wire trace" — a thin dotted connector rendered
// between each step of the pipeline (GHL -> Bridge -> Assistable), used on
// the form and success pages to make the plumbing legible at a glance.

const STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0b0f10; --panel: #12181a; --panel-2: #17201f;
    --line: #223030; --line-soft: #1a2323;
    --ink: #e9f2ee; --ink-dim: #9db3ab; --ink-faint: #5f7570;
    --accent: #59d9b3; --accent-dim: #2c5b4c;
    --warn: #e8b34d; --warn-bg: #2a2412;
    --danger: #e8715f; --danger-bg: #2a1712;
    --radius: 10px;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --sans: -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 15px; line-height: 1.5;
  }
  body {
    background-image:
      radial-gradient(circle at 1px 1px, var(--line-soft) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .brand .dot {
    width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .brand span {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--ink-dim);
  }
  h1 {
    font-size: 26px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 6px;
  }
  .lede { color: var(--ink-dim); margin: 0 0 32px; max-width: 52ch; }
  .journey {
    display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 28px;
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.05em;
  }
  .journey .s {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 13px 7px 8px; border: 1px solid var(--line);
    border-radius: 999px; color: var(--ink-faint); background: var(--panel-2);
  }
  .journey .s b { font-weight: 600; }
  .journey .s.now { color: var(--ink); border-color: var(--accent-dim); }
  .journey .s.done { color: var(--accent); border-color: var(--accent-dim); }
  .journey .s .n {
    width: 17px; height: 17px; border-radius: 50%; display: grid;
    place-items: center; font-size: 10px; background: var(--panel);
    border: 1px solid var(--line); color: inherit;
  }
  .journey .s.done .n {
    background: var(--accent-dim); border-color: var(--accent-dim); color: var(--accent);
  }
  .trace {
    display: flex; align-items: center; gap: 0; margin: 0 0 32px;
    font-family: var(--mono); font-size: 12px; color: var(--ink-faint);
  }
  .trace .node {
    padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px;
    color: var(--ink-dim); background: var(--panel-2); white-space: nowrap;
  }
  .trace .node.on { color: var(--accent); border-color: var(--accent-dim); }
  .trace .wire {
    flex: 1; height: 1px; min-width: 16px;
    background-image: linear-gradient(to right, var(--line) 50%, transparent 0);
    background-size: 6px 1px;
  }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 28px;
  }
  fieldset { border: 0; padding: 0; margin: 0 0 22px; }
  legend {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--accent); margin-bottom: 12px; padding: 0;
  }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  label {
    display: block; font-size: 13px; color: var(--ink-dim); margin-bottom: 6px;
  }
  label .hint { color: var(--ink-faint); font-weight: 400; }
  input, select, textarea {
    width: 100%; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; color: var(--ink);
    font-size: 14px; font-family: var(--sans); outline: none;
    transition: border-color 0.15s ease;
  }
  input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible {
    border-color: var(--accent); outline: 2px solid var(--accent-dim); outline-offset: 1px;
  }
  input::placeholder, textarea::placeholder { color: var(--ink-faint); }
  textarea {
    font-family: var(--mono); font-size: 13px; line-height: 1.7;
    min-height: 190px; resize: vertical; white-space: pre;
  }
  .altlink {
    margin: 14px 0 0; font-size: 13px; color: var(--ink-faint); text-align: center;
  }
  .pill.warnpill { background: var(--warn-bg); color: var(--warn); }
  td.why { color: var(--ink-dim); font-size: 12.5px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
  button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 11px 20px; border-radius: 7px; border: 1px solid transparent;
    font-size: 14px; font-weight: 600; cursor: pointer; font-family: var(--sans);
    text-decoration: none;
  }
  .btn-primary { background: var(--accent); color: #04211a; width: 100%; margin-top: 6px; }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost {
    background: transparent; border-color: var(--line); color: var(--ink-dim);
  }
  .btn-ghost:hover { border-color: var(--accent-dim); color: var(--ink); }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 0; }
  code, pre {
    font-family: var(--mono); font-size: 13px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; color: var(--accent);
  }
  code { padding: 2px 7px; word-break: break-all; }
  pre {
    padding: 16px; margin: 0; color: var(--ink); white-space: pre-wrap;
    line-height: 1.6;
  }
  .callout {
    display: flex; gap: 10px; padding: 13px 14px; border-radius: 7px;
    font-size: 13.5px; margin: 0 0 14px; border: 1px solid;
  }
  .callout.ok { background: rgba(89,217,179,0.08); border-color: var(--accent-dim); color: var(--ink); }
  .callout.warn { background: var(--warn-bg); border-color: #4a3d1c; color: var(--ink); }
  .callout.error { background: var(--danger-bg); border-color: #4a281f; color: var(--ink); }
  .callout .mark { flex-shrink: 0; font-family: var(--mono); }
  .section-title {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-faint); margin: 26px 0 10px;
  }
  .stat-row { display: flex; gap: 18px; flex-wrap: wrap; margin: 4px 0 4px; }
  .stat {
    display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ink-dim);
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600; font-family: var(--mono);
  }
  .pill.on { background: rgba(89,217,179,0.12); color: var(--accent); }
  .pill.off { background: rgba(232,113,95,0.1); color: var(--danger); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td {
    text-align: left; padding: 9px 10px; font-size: 13px; border-bottom: 1px solid var(--line-soft);
  }
  th {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink-faint); font-weight: 500;
  }
  td { color: var(--ink-dim); }
  td.kind { color: var(--ink); font-family: var(--mono); font-size: 12.5px; }
  td.detail { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  .empty { color: var(--ink-faint); font-size: 13px; padding: 18px 0; }
  .row-actions { display: flex; gap: 6px; align-items: center; }
  .row-actions form { margin: 0; }
  a.link { color: var(--accent); }
  footer.copy {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 12px; gap: 10px;
  }
  footer.copy small { color: var(--ink-faint); font-size: 11.5px; }
`;

// The operator workspace is intentionally a separate theme from the legacy
// tenant setup flow. This keeps existing clinic onboarding pages stable while
// matching the white/orange Connect product shell used by operators.
const CONNECT_STYLE = `
  :root {
    color-scheme: light;
    --bg: #f7f8fa; --panel: #ffffff; --panel-2: #fff7f0;
    --line: #e5e7eb; --line-soft: #eef0f2;
    --ink: #1f2937; --ink-dim: #667085; --ink-faint: #98a2b3;
    --accent: #f97316; --accent-dim: #fed7aa;
    --warn: #b45309; --warn-bg: #fff7ed;
    --danger: #b42318; --danger-bg: #fff1f0;
    --radius: 12px;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --sans: -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.5; }
  body { min-height: 100vh; }
  a { color: inherit; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 42px 28px 72px; }
  .brand { display: flex; align-items: center; gap: 11px; margin-bottom: 18px; }
  .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px #ffedd5; }
  .brand span { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #475467; font-weight: 700; }
  .connect-nav { display: flex; gap: 8px; margin: 0 0 30px; }
  .connect-nav a { padding: 7px 12px; border-radius: 8px; color: #667085; text-decoration: none; font-size: 13px; font-weight: 600; }
  .connect-nav a:hover { color: var(--accent); background: #fff1e8; }
  h1 { font-size: 30px; font-weight: 700; letter-spacing: -.025em; margin: 0 0 7px; color: #101828; }
  .lede { color: var(--ink-dim); margin: 0 0 28px; max-width: 68ch; }
  .journey { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 22px; font-family: var(--mono); font-size: 11px; letter-spacing: .04em; }
  .journey .s { display: inline-flex; align-items: center; gap: 8px; padding: 7px 13px 7px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-faint); background: #fff; }
  .journey .s b { font-weight: 600; }
  .journey .s.now { color: var(--accent); border-color: var(--accent-dim); background: #fffaf5; }
  .journey .s.done { color: #c2410c; border-color: #fdba74; background: #fff7ed; }
  .journey .s .n { width: 17px; height: 17px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; background: #f2f4f7; border: 1px solid var(--line); color: inherit; }
  .journey .s.done .n { background: #ffedd5; border-color: #fdba74; color: #c2410c; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; box-shadow: 0 8px 24px rgba(16,24,40,.05); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 680px) { .grid2 { grid-template-columns: 1fr; } .wrap { padding: 28px 18px 56px; } }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  label { display: block; font-size: 13px; color: #475467; margin-bottom: 6px; font-weight: 600; }
  label .hint { color: var(--ink-faint); font-weight: 400; }
  input, select, textarea { width: 100%; padding: 10px 12px; background: #fff; border: 1px solid #d0d5dd; border-radius: 8px; color: var(--ink); font-size: 14px; font-family: var(--sans); outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
  input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible { border-color: var(--accent); outline: 2px solid #fed7aa; outline-offset: 1px; box-shadow: 0 0 0 3px rgba(249,115,22,.12); }
  input::placeholder, textarea::placeholder { color: #98a2b3; }
  textarea { font-family: var(--mono); font-size: 13px; line-height: 1.7; min-height: 190px; resize: vertical; white-space: pre; }
  .section-title { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #98a2b3; margin: 26px 0 10px; }
  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 16px; border-radius: 8px; border: 1px solid transparent; font-size: 14px; font-weight: 650; cursor: pointer; font-family: var(--sans); text-decoration: none; }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; margin-top: 6px; box-shadow: 0 2px 5px rgba(249,115,22,.22); }
  .btn-primary:hover { background: #ea580c; }
  .btn-ghost { background: #fff; border-color: #d0d5dd; color: #475467; }
  .btn-ghost:hover { border-color: #fdba74; color: #c2410c; background: #fffaf5; }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 0; }
  code, pre { font-family: var(--mono); font-size: 13px; background: #f8fafc; border: 1px solid var(--line); border-radius: 7px; color: #c2410c; }
  code { padding: 2px 7px; word-break: break-all; }
  .callout { display: flex; gap: 10px; padding: 13px 14px; border-radius: 8px; font-size: 13.5px; margin: 0 0 14px; border: 1px solid; }
  .callout.ok { background: #ecfdf3; border-color: #a6f4c5; color: #14532d; }
  .callout.warn { background: var(--warn-bg); border-color: #fed7aa; color: #7c2d12; }
  .callout.error { background: var(--danger-bg); border-color: #fecdca; color: #912018; }
  .callout .mark { flex-shrink: 0; font-family: var(--mono); }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 650; font-family: var(--mono); }
  .pill.on { background: #ecfdf3; color: #087443; }
  .pill.off { background: #fff1f0; color: #b42318; }
  .pill.warnpill { background: var(--warn-bg); color: var(--warn); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { text-align: left; padding: 11px 10px; font-size: 13px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #98a2b3; font-weight: 600; }
  td { color: #667085; }
  td.kind { color: #344054; font-family: var(--mono); font-size: 12.5px; }
  td.detail { font-family: var(--mono); font-size: 12px; color: #98a2b3; }
  .empty { color: #98a2b3; font-size: 13px; padding: 18px 0; }
  .trace { display: flex; align-items: center; gap: 0; margin: 0 0 32px; font-family: var(--mono); font-size: 12px; color: #98a2b3; }
  .trace .node { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; color: #667085; background: #fff; white-space: nowrap; }
  .trace .node.on { color: #c2410c; border-color: #fdba74; background: #fff7ed; }
  .trace .wire { flex: 1; height: 1px; min-width: 16px; background: #e5e7eb; }
`;

const wireTrace = (stage: 0 | 1 | 2) => `
  <div class="trace" aria-hidden="true">
    <span class="node${stage >= 0 ? " on" : ""}">GHL subaccount</span>
    <span class="wire"></span>
    <span class="node${stage >= 1 ? " on" : ""}">Media bridge</span>
    <span class="wire"></span>
    <span class="node${stage >= 2 ? " on" : ""}">Assistable v3</span>
  </div>`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="dot"></span><span>Media MCP Bridge</span></div>
    ${body}
  </div>
</body>
</html>`;

const connectShell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${CONNECT_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="dot"></span><span>Wellgrow Connect</span></div>
    <nav class="connect-nav" aria-label="Operator navigation"><a href="/operator/tenants">Locations</a><a href="/operator/providers">Providers</a></nav>
    ${body}
  </div>
</body>
</html>`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createPortalRouter(ctx: PortalCtx): Router {
  const router = Router();
  const requireOperator = (req: Request, res: Response, next: NextFunction) => {
    if (hasOperatorAccess(req, ctx.operatorToken)) return next();
    const accept = req.get("accept") ?? "";
    if (accept.includes("text/html")) {
      const nextPath = req.path === "/setup/batch" || req.path.startsWith("/operator/") ? req.path : "/";
      res.redirect(302, `/operator-login?next=${encodeURIComponent(nextPath)}`);
      return;
    }
    res.status(401).send("operator authorization required");
  };

  const operatorLogin = (next: string, error = "") => shell("Media MCP — Operator sign in", `
    <h1>Operator sign in</h1>
    <p class="lede">This bridge is protected. Paste the <code>OPERATOR_TOKEN</code> from the Render
      Environment page to manage connected subaccounts.</p>
    ${error ? `<div class="callout error"><span class="mark">&#10007;</span><span>${esc(error)}</span></div>` : ""}
    <div class="panel">
      <form method="post" action="/operator-login">
        <input type="hidden" name="next" value="${esc(next)}">
        <div class="field">
          <label for="operator_token">Operator token</label>
          <input id="operator_token" name="operator_token" type="password" autocomplete="current-password" required autofocus>
        </div>
        <button type="submit" class="btn btn-primary">Continue</button>
      </form>
    </div>
  `);

  router.get("/operator-login", (req, res) => {
    if (!ctx.operatorToken) {
      res.status(404).send("operator login is not configured");
      return;
    }
    if (hasOperatorAccess(req, ctx.operatorToken)) {
      res.redirect(302, safeNext(req.query.next));
      return;
    }
    res.send(operatorLogin(safeNext(req.query.next)));
  });

  router.post("/operator-login", (req, res) => {
    if (!ctx.operatorToken) {
      res.status(404).send("operator login is not configured");
      return;
    }
    const next = safeNext(req.body?.next);
    if (typeof req.body?.operator_token !== "string" || req.body.operator_token !== ctx.operatorToken) {
      res.status(401).send(operatorLogin(next, "Invalid operator token."));
      return;
    }
    setOperatorSession(req, res, ctx.operatorToken);
    res.redirect(302, next);
  });

  router.post("/operator-logout", (req, res) => {
    clearOperatorSession(res);
    res.redirect(302, "/operator-login");
  });

  // ---- shared provider profiles and safe location cloning -------------
  // These actions are intentionally operator-session protected and rate-limited:
  // a typo in a key must not become an upstream health-check loop, and provider
  // secrets never appear in the rendered response or audit detail.
  const actionHits = new Map<string, number[]>();
  const allowAction = (req: Request, name: string, limit = 8): boolean => {
    const key = `${req.ip ?? "unknown"}:${name}`;
    const now = Date.now();
    const recent = (actionHits.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= limit) { actionHits.set(key, recent); return false; }
    recent.push(now); actionHits.set(key, recent); return true;
  };
  const operatorFrame = (title: string, body: string) => connectShell(`Connect — ${title}`, `
    <div class="journey"><span class="s done"><span class="n">✓</span> <b>Locations</b></span><span class="s now"><span class="n">2</span> <b>Providers</b></span><span class="s"><span class="n">3</span> <b>Diagnostics</b></span></div>
    ${body}`);
  const providerSummary = () => ctx.profiles?.listRedacted() ?? [];

  router.get("/operator/providers", requireOperator, (_req, res) => {
    const profiles = providerSummary();
    res.send(operatorFrame("Provider settings", `
      <h1>Shared provider profiles</h1>
      <p class="lede">Keep Gemini primary and OpenAI fallback credentials in one encrypted profile. Locations reference the profile; clones never ask you to paste provider keys again.</p>
      <div class="panel">
        ${profiles.length ? `<table><tr><th>Profile</th><th>Primary</th><th>Fallback</th><th>Health</th><th>Version</th></tr>${profiles.map((p) => `<tr><td><strong>${esc(p.coverageLabel)}</strong><br><code>${esc(p.id)}</code></td><td>${esc(p.primaryProvider)}</td><td><span class="pill ${p.fallbackEnabled ? "on" : "off"}">${p.fallbackEnabled ? "enabled" : "off"}</span></td><td>Gemini ${esc(p.geminiHealth)} · OpenAI ${esc(p.openaiHealth)}</td><td>${p.version}</td></tr>`).join("")}</table>` : `<p class="empty">No shared profiles yet.</p>`}
        <div class="section-title">Add a profile</div>
        <form method="post" action="/operator/providers">
          <div class="field"><label>Coverage label<input name="coverageLabel" placeholder="WellGrow shared AI" required></label></div>
          <div class="grid2"><div class="field"><label>Primary<select name="primaryProvider"><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label></div><div class="field"><label>Enable fallback<select name="fallbackEnabled"><option value="true">Yes</option><option value="false">No</option></select></label></div></div>
          <div class="field"><label>Gemini API key<input name="geminiKey" type="password" autocomplete="off"></label></div>
          <div class="field"><label>OpenAI API key<input name="openaiKey" type="password" autocomplete="off"></label></div>
          <button class="btn btn-primary">Validate and save</button>
        </form>
      </div>
      <div class="btn-row"><a class="btn btn-ghost" href="/operator/tenants">Locations &amp; cloning</a><form method="post" action="/operator-logout"><button class="btn btn-ghost">Sign out</button></form></div>
    `));
  });

  router.post("/operator/providers", requireOperator, async (req, res) => {
    if (!ctx.profiles) { res.status(503).send("provider profiles are not configured"); return; }
    if (!allowAction(req, "provider-create")) { res.status(429).send("too many provider checks; wait a minute"); return; }
    const b = req.body as Record<string, string>;
    try {
      const profile = await ctx.profiles.validateAndCreate({
        coverageLabel: b.coverageLabel ?? "", primaryProvider: b.primaryProvider === "openai" ? "openai" : "gemini",
        fallbackEnabled: b.fallbackEnabled === "true", geminiKey: b.geminiKey || null, openaiKey: b.openaiKey || null,
      }, async (name, key) => ctx.providerFactory(name, key).validateKey());
      ctx.audit?.record({ actor: "operator", action: "provider_profile_create", detail: `profile ${profile.id}` });
      res.redirect(303, "/operator/providers");
    } catch (err) {
      res.status(400).send(operatorFrame("Provider validation failed", `<h1>Provider not saved</h1><div class="panel"><div class="callout error"><span class="mark">✕</span><span>${esc(err instanceof Error ? err.message : "validation failed")}</span></div><a class="btn btn-ghost" href="/operator/providers">Back</a></div>`));
    }
  });

  router.put("/operator/providers/:id", requireOperator, async (req, res) => {
    if (!ctx.profiles) { res.status(503).json({ ok: false, error: "provider profiles are not configured" }); return; }
    if (!allowAction(req, "provider-rotate")) { res.status(429).json({ ok: false, error: "too many provider checks" }); return; }
    const b = req.body as Record<string, string>;
    try {
      const updated = await ctx.profiles.rotate(String(req.params.id), {
        ...(b.geminiKey !== undefined ? { geminiKey: b.geminiKey || null } : {}),
        ...(b.openaiKey !== undefined ? { openaiKey: b.openaiKey || null } : {}),
        ...(b.primaryProvider ? { primaryProvider: b.primaryProvider as ProviderName } : {}),
        ...(b.fallbackEnabled !== undefined ? { fallbackEnabled: b.fallbackEnabled === "true" } : {}),
      }, async (name, key) => ctx.providerFactory(name, key).validateKey());
      ctx.audit?.record({ actor: "operator", action: "provider_profile_rotate", detail: `profile ${updated.id} v${updated.version}` });
      res.json({ ok: true, profile: providerSummary().find((p) => p.id === updated.id) ?? null });
    } catch (err) { res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "rotation failed" }); }
  });

  router.get("/operator/tenants", requireOperator, (_req, res) => {
    const rows = ctx.tenants.list();
    res.send(operatorFrame("Locations", `<h1>Locations</h1><p class="lede">Clone a configured clinic without copying contacts, appointments, assets, cursors, or conversation history.</p><div class="panel"><table><tr><th>Location</th><th>Status</th><th>Provider profile</th><th></th></tr>${rows.map((t) => `<tr><td><strong>${esc(t.label)}</strong><br><code>${esc(t.locationId)}</code></td><td><span class="pill ${t.enabled ? "on" : "off"}">${esc(t.provisioningState ?? (t.enabled ? "ready" : "disabled"))}</span></td><td>${t.providerProfileId ? "shared profile" : "legacy"}</td><td><a class="btn btn-ghost" href="/operator/tenants/${t.id}/clone">Clone</a></td></tr>`).join("")}</table></div><div class="btn-row"><a class="btn btn-ghost" href="/operator/providers">Provider settings</a></div>`));
  });

  router.get("/operator/tenants/:id/clone", requireOperator, (req, res) => {
    const source = ctx.tenants.list().find((t) => t.id === req.params.id);
    if (!source) { res.status(404).send("location not found"); return; }
    res.send(operatorFrame("Clone location", `<h1>Clone ${esc(source.label)}</h1><p class="lede">Provider profile, extraction settings, trusted hosts, and waker policy are inherited. Only the target identifiers and optional PIT change.</p><div class="panel"><form method="post" action="/operator/tenants/${encodeURIComponent(source.id)}/clone"><div class="field"><label>Target label<input name="label" required></label></div><div class="grid2"><div class="field"><label>Target GHL location ID<input name="locationId" required></label></div><div class="field"><label>Target Assistable assistant ID<input name="assistantId" required></label></div></div><div class="field"><label>Target Assistable subaccount ID<input name="subAccountId" required></label></div><div class="field"><label>Target GHL PIT <span class="hint">optional if the source PIT is authorized for the target</span><input name="ghlPit" type="password" autocomplete="off"></label></div><button class="btn btn-primary">Validate, provision, and activate</button></form></div><div class="btn-row"><a class="btn btn-ghost" href="/operator/tenants">Back to locations</a></div>`));
  });

  router.post("/operator/tenants/:id/clone", requireOperator, async (req, res) => {
    if (!allowAction(req, "clone", 6)) { res.status(429).send("too many clone attempts; wait a minute"); return; }
    const source = ctx.tenants.list().find((t) => t.id === req.params.id);
    if (!source) { res.status(404).send("location not found"); return; }
    const b = req.body as Record<string, string>;
    const input: CloneInput = { label: b.label ?? "", locationId: b.locationId ?? "", assistantId: b.assistantId ?? "", subAccountId: b.subAccountId || null, ghlPit: b.ghlPit || null };
    try {
      validateCloneInput(source, input, ctx.tenants);
      const r = await cloneTenant({
        tenants: ctx.tenants, source, input,
        validateV3: async (v3Key, subAccountId) => {
          const v3 = ctx.v3Factory(v3Key, subAccountId);
          const check = await v3.validateKey();
          if (!check.ok) return check;
          const assistants = await v3.listAssistants();
          return assistants.some((a) => a.id === input.assistantId) ? { ok: true } : { ok: false, detail: `assistant ${input.assistantId} is not visible in the target subaccount` };
        },
        validatePit: (pit, locationId) => ctx.ghlFactory(pit).validatePit(locationId),
        provision: async (target) => {
          const v3 = ctx.v3Factory(target.v3Key, target.subAccountId);
          const tool = await ensureToolForAssistant(v3, ctx.tenants, ctx.publicBaseUrl, target);
          return { ok: Boolean(tool.toolId) && tool.warnings.length === 0, warning: tool.warnings.join("; ") };
        },
      });
      ctx.audit?.record({ tenantId: r.tenant.id, actor: "operator", action: "location_clone", detail: r.tenant.provisioningState ?? "unknown" });
      res.redirect(303, `/dashboard/${r.tenant.token}`);
    } catch (err) {
      res.status(400).send(operatorFrame("Clone failed", `<h1>Clone not created</h1><div class="panel"><div class="callout error"><span class="mark">✕</span><span>${esc(err instanceof Error ? err.message : "clone validation failed")}</span></div><a class="btn btn-ghost" href="/operator/tenants/${encodeURIComponent(source.id)}/clone">Back</a></div>`));
    }
  });

  router.get("/", (req, res) => {
    if (!hasOperatorAccess(req, ctx.operatorToken)) {
      res.redirect(302, "/operator-login?next=%2F");
      return;
    }
    // Anything remembered but since deleted is dropped silently — a stale
    // token is not an error worth showing anyone.
    const mine = rememberedTokens(req)
      .map((tok) => ctx.tenants.getByToken(tok))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const returning = mine.length === 0 ? "" : `
      <div class="panel" style="margin-bottom:22px">
        <div class="section-title" style="margin-top:0">Your connected subaccounts</div>
        <table>
          ${mine.map((t) => `
            <tr>
              <td><strong>${esc(t.label)}</strong><br>
                <small class="copy">${esc(t.locationId)}</small></td>
              <td>${t.enabled ? `<span class="pill on">enabled</span>` : `<span class="pill">disabled</span>`}</td>
              <td><a class="btn btn-ghost" href="/dashboard/${t.token}">Open dashboard</a></td>
            </tr>`).join("")}
        </table>
        <p class="lede" style="margin:14px 0 0;font-size:13px">Remembered on this browser only.
          Your dashboard link is also the key to it, so bookmark it if you use more than one device.</p>
        <form method="post" action="/forget">
          <div class="btn-row">
            <button class="btn btn-ghost">Forget this browser</button>
          </div>
        </form>
      </div>`;
    res.send(shell("Media MCP — Connect", returning + `
      <div class="journey" aria-label="Setup progress">
        <span class="s done"><span class="n">✓</span> <b>Deployed</b> · your instance</span>
        <span class="s now"><span class="n">2</span> <b>Connect</b> your account</span>
        <span class="s"><span class="n">3</span> <b>Test</b> a voice note</span>
      </div>
      <h1>Connect a subaccount</h1>
      <p class="lede">Wire a GHL location to an Assistable v3 assistant so it can read voice notes,
        photos, and documents contacts send in. Every credential below is checked live before
        anything is saved.</p>
      ${wireTrace(0)}
      <div class="panel">
        <form method="post" action="/setup">
          <fieldset>
            <legend>Subaccount</legend>
            <div class="field">
              <label for="label">Label <span class="hint">— a name you'll recognize on the dashboard</span></label>
              <input id="label" name="label" placeholder="e.g. Main Street Dental" required>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="locationId">GHL location ID</label>
                <input id="locationId" name="locationId" placeholder="loc_..." required>
              </div>
              <div class="field">
                <label for="assistantId">Default assistant ID</label>
                <input id="assistantId" name="assistantId" placeholder="asst_..." required>
              </div>
            </div>
            <div class="field">
              <label for="subAccountId">Subaccount ID <span class="hint">— optional, only if your API key
                covers multiple subaccounts. This is Assistable's own id from the dashboard URL
                (<code>/portal/&lt;subAccountId&gt;/...</code>), <strong>not</strong> the GHL location ID above.</span></label>
              <input id="subAccountId" name="subAccountId" placeholder="leave blank for a single-subaccount key">
            </div>
          </fieldset>
          <fieldset>
            <legend>Credentials</legend>
            <div class="field">
              <label for="v3Key">Assistable v3 API key <span class="hint">— starts with <code>ask_live_</code>; mint one under Dashboard &rarr; Integrations &rarr; API Key</span></label>
              <input id="v3Key" name="v3Key" type="password" autocomplete="off"
                pattern="ask_(live|stag)_.+" title="A v3 API key starts with ask_live_ (Dashboard -> Integrations -> API Key). Older portal keys and tokens from other pages will not work." required>
            </div>
            <div class="field">
              <label for="ghlPit">GHL Private Integration Token</label>
              <input id="ghlPit" name="ghlPit" type="password" autocomplete="off" required>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="provider">AI provider</label>
                <select id="provider" name="provider">
                  <option value="gemini">Gemini (recommended)</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div class="field">
                <label for="aiKey">Provider API key</label>
                <input id="aiKey" name="aiKey" type="password" autocomplete="off" required>
              </div>
            </div>
          </fieldset>
          <button type="submit" class="btn btn-primary">Validate &amp; connect</button>
        </form>
        <p class="altlink">Running an agency?
          <a class="link" href="/setup/batch">Connect several subaccounts at once &rarr;</a></p>
      </div>
    `));
  });

  router.post("/setup", requireOperator, async (req, res) => {
    const b = req.body as Record<string, string>;
    try {
      const r = await provisionTenant(ctx, {
        label: b.label, locationId: b.locationId, assistantId: b.assistantId,
        provider: b.provider === "openai" ? "openai" : "gemini",
        v3Key: b.v3Key, ghlPit: b.ghlPit, aiKey: b.aiKey,
        ...(b.subAccountId?.trim() ? { subAccountId: b.subAccountId.trim() } : {}),
      });
      const mcpUrl = `${ctx.publicBaseUrl}/mcp/${r.tenant.token}`;
      const title = r.reconnected ? "Reconnected" : "Connected";
      ctx.audit?.record({ tenantId: r.tenant.id, actor: "portal", action: "provision", detail: title });
      rememberToken(req, res, r.tenant.token);
      res.send(shell(title, `
        <h1>${title}</h1>
        <p class="lede">${esc(r.tenant.label)} is wired up. Point the assistant at the tool below
          and it will read attachments on demand.</p>
        ${wireTrace(2)}
        <div class="panel">
          <div class="callout ok">
            <span class="mark">&#10003;</span>
            <span>Credentials validated live against GHL and Assistable v3.</span>
          </div>
          ${r.reconnected ? `
            <div class="callout ok">
              <span class="mark">&#8635;</span>
              <span>This GHL location was already connected, so its settings were updated in place
                rather than added twice. The tool URL, dashboard link and activity history below are
                unchanged, and already-read attachments stay read.</span>
            </div>` : ""}
          ${r.warnings.map((w) => `
            <div class="callout warn">
              <span class="mark">!</span>
              <span>${esc(w)}</span>
            </div>`).join("")}
          <div class="section-title">Tool</div>
          <p>${r.toolId
            ? `<span class="pill on">analyze_attachment created</span> &nbsp; <code>${esc(r.toolId)}</code>`
            : `<span class="pill off">manual creation needed</span> — add a CUSTOM tool named
               <code>analyze_attachment</code> in the Assistable v3 dashboard pointing at the URL below.`}
          </p>
          <div class="section-title">MCP endpoint</div>
          <code>${esc(mcpUrl)}</code>
          <div class="section-title">Add to the assistant's prompt</div>
          <pre>${esc(PROMPT_SNIPPET)}</pre>
          <div class="btn-row">
            <a class="btn btn-primary" href="/dashboard/${r.tenant.token}">Open dashboard</a>
            <a class="btn btn-ghost" href="/">Connect another</a>
          </div>
        </div>
      `));
    } catch (err) {
      res.status(400).send(shell("Validation failed", `
        <h1>Connection failed</h1>
        <p class="lede">One of the credentials didn't check out. Nothing was saved.</p>
        ${wireTrace(0)}
        <div class="panel">
          <div class="callout error">
            <span class="mark">&#10007;</span>
            <span>${esc(err instanceof Error ? err.message : "Validation error")}</span>
          </div>
          <a class="btn btn-ghost" href="/">&larr; Back to setup</a>
        </div>
      `));
    }
  });

  // ---- bulk setup ------------------------------------------------------
  // An agency runs ONE Assistable workspace across many subaccounts, so the
  // three credentials are identical on every row and only the identifiers
  // differ. Pasting them 40 times is the whole friction.

  const batchCredentialFields = `
    <fieldset>
      <legend>Shared credentials</legend>
      <p class="lede" style="margin-bottom:14px">Used for every subaccount below. The v3 key must be
        workspace-wide, so it can reach each subaccount you list.</p>
      <div class="field">
        <label for="v3Key">Assistable v3 API key <span class="hint">— starts with <code>ask_live_</code></span></label>
        <input id="v3Key" name="v3Key" type="password" autocomplete="off"
          pattern="ask_(live|stag)_.+" title="A v3 API key starts with ask_live_." required>
      </div>
      <div class="field">
        <label for="ghlPit">GHL Private Integration Token <span class="hint">— optional if every row
          carries its own <code>pit=</code>. A private integration may be agency-wide or scoped to one
          location depending on how it was minted; if yours only covers one location, leave this blank
          and put <code>pit=&lt;token&gt;</code> on each row instead.</span></label>
        <input id="ghlPit" name="ghlPit" type="password" autocomplete="off">
      </div>
      <div class="grid2">
        <div class="field">
          <label for="provider">AI provider</label>
          <select id="provider" name="provider">
            <option value="gemini">Gemini (recommended)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div class="field">
          <label for="aiKey">Provider API key</label>
          <input id="aiKey" name="aiKey" type="password" autocomplete="off" required>
        </div>
      </div>
    </fieldset>`;

  const batchForm = (rowsText: string, error?: string) => `
    <h1>Connect several subaccounts</h1>
    <p class="lede">Paste your credentials once, then list the subaccounts. Every row is validated
      against the live APIs on its own — one bad line fails that row, not the batch.</p>
    ${wireTrace(0)}
    <div class="panel">
      ${error ? `<div class="callout error"><span class="mark">&#10007;</span><span>${esc(error)}</span></div>` : ""}
      <form method="post" action="/setup/batch">
        ${batchCredentialFields}
        <fieldset>
          <legend>Subaccounts</legend>
          <div class="field">
            <label for="rows">One per line <span class="hint">— <code>subAccountId, locationId, assistantId, label</code>.
              Commas or tabs, so a spreadsheet paste works. Leave the assistant blank and it is filled
              in automatically when the subaccount has exactly one. Add <code>pit=&lt;token&gt;</code>
              anywhere in a row to give that location its own GHL token.<br>
              <strong>These are two different ids.</strong> The <em>subaccount id</em> is Assistable's own
              and comes from the dashboard URL, <code>/portal/&lt;subAccountId&gt;/...</code>; the
              <em>location id</em> comes from the CRM. Pasting the same value into both is the usual
              slip.</span></label>
            <textarea id="rows" name="rows" spellcheck="false" required
              placeholder="clx7k2p9a0001qw8h3n5v2m4t, ve9EPM428h8vShlRW1KT, , Main Street Dental&#10;clx8m4r2b0002qw8h7j1k9p3z, kQ2mNb71xTfLpR3wZaYd, , Riverside Chiropractic&#10;clx9n5s3c0004qw8h2v6b8n1m, wR4pLc82yUgMqS5xBbZe, , Lakeside Vets, pit=pit-abc123">${esc(rowsText)}</textarea>
          </div>
        </fieldset>
        <button type="submit" class="btn btn-primary">Validate &amp; connect all</button>
      </form>
      <p class="altlink">Just one subaccount? <a class="link" href="/">Use the single form &rarr;</a></p>
    </div>`;

  router.get("/setup/batch", (req, res) => {
    if (!hasOperatorAccess(req, ctx.operatorToken)) {
      res.redirect(302, "/operator-login?next=%2Fsetup%2Fbatch");
      return;
    }
    res.send(shell("Media MCP — Bulk connect", batchForm("")));
  });

  router.post("/setup/batch", requireOperator, async (req, res) => {
    const b = req.body as Record<string, string>;
    const rowsText = b.rows ?? "";
    const { rows, errors } = parseBatchRows(rowsText);
    if (rows.length === 0) {
      const why = errors.length
        ? errors.map((e) => (e.line ? `line ${e.line}: ${e.error}` : e.error)).join(" · ")
        : "no subaccounts were listed";
      // Echo the list back so the operator can fix it in place, but never write
      // live tokens into an HTML response a proxy or log might retain.
      const safe = redactPits(rowsText);
      const note = safe === rowsText
        ? why
        : `${why}. Your pit= tokens were removed from this form — re-add them before submitting.`;
      res.status(400).send(shell("Nothing to connect", batchForm(safe, note)));
      return;
    }

    const results = await provisionBatch(
      ctx,
      {
        provider: b.provider === "openai" ? "openai" : "gemini",
        v3Key: b.v3Key, ghlPit: b.ghlPit, aiKey: b.aiKey,
      },
      rows
    );

    const connected = results.filter((r) => r.ok && !r.reconnected).length;
    const reconnected = results.filter((r) => r.ok && r.reconnected).length;
    const failed = results.filter((r) => !r.ok);

    const statusCell = (r: (typeof results)[number]) => {
      if (!r.ok) return `<span class="pill off">failed</span>`;
      if (r.warnings.length) return `<span class="pill warnpill">needs attention</span>`;
      return `<span class="pill on">${r.reconnected ? "reconnected" : "connected"}</span>`;
    };
    const detailCell = (r: (typeof results)[number]) => {
      if (!r.ok) return esc(r.error ?? "provisioning failed");
      const bits = [
        r.toolId ? `tool ${esc(r.toolId)}` : "tool not created",
        `<a class="link" href="/dashboard/${r.token}">dashboard</a>`,
      ];
      if (r.warnings.length) bits.push(esc(r.warnings.join("; ")));
      return bits.join(" &middot; ");
    };
    const resultRows = results.map((r) => `
      <tr>
        <td class="kind">${esc(r.row.locationId)}</td>
        <td class="detail">${esc(r.row.subAccountId)}</td>
        <td class="detail">${esc(r.assistantId ?? "—")}</td>
        <td>${statusCell(r)}</td>
        <td class="why">${detailCell(r)}</td>
      </tr>`).join("");

    res.send(shell("Bulk connect results", `
      <h1>${connected + reconnected} of ${results.length} connected</h1>
      <p class="lede">Every row was validated live. Re-submitting the same list is safe — rows that
        already worked reconnect in place rather than duplicating, so fix the failures below and
        paste the whole list again.</p>
      ${wireTrace(failed.length === results.length ? 0 : 2)}
      <div class="panel">
        <div class="stat-row">
          <span class="stat">New <span class="pill on">${connected}</span></span>
          <span class="stat">Reconnected <span class="pill on">${reconnected}</span></span>
          <span class="stat">Failed <span class="pill ${failed.length ? "off" : "on"}">${failed.length}</span></span>
        </div>
        ${errors.length ? `
          <div class="callout warn">
            <span class="mark">!</span>
            <span>${errors.length} line(s) were skipped as unparseable:
              ${esc(errors.map((e) => `line ${e.line}`).join(", "))}</span>
          </div>` : ""}
        <div class="section-title">Results</div>
        <table>
          <tr><th>Location</th><th>Subaccount</th><th>Assistant</th><th>Status</th><th>Detail</th></tr>
          ${resultRows}
        </table>
        <div class="section-title">Add to every connected assistant's prompt</div>
        <pre>${esc(PROMPT_SNIPPET)}</pre>
        <div class="btn-row">
          <a class="btn btn-ghost" href="/setup/batch">Connect more</a>
        </div>
      </div>
    `));
  });

  router.get("/dashboard/:token", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) {
      res.status(404).send(shell("Not found", `
        <h1>Unknown dashboard</h1>
        <p class="lede">This link doesn't match any connected subaccount.</p>
        <a class="btn btn-ghost" href="/">&larr; Back to setup</a>
      `));
      return;
    }
    rememberToken(req, res, t.token);
    const events = ctx.events.latest(t.id, 20);
    const assetList = ctx.assets.list(t.id);
    const assistantList = ctx.assistantBindings?.list(t.id) ?? [];
    // Surfaced via a query param so a failed add can redirect back to the
    // dashboard and still explain itself, rather than stranding the operator
    // on a bare error page with their form contents gone.
    const assetError = typeof req.query.assetError === "string" ? req.query.assetError : "";
    // Non-blocking compatibility notes from the last add — the asset saved,
    // but it may not render everywhere.
    const assetNotice = typeof req.query.assetNotice === "string"
      ? req.query.assetNotice.split("\n").filter(Boolean) : [];
    const mediaHostError = typeof req.query.mediaHostError === "string" ? req.query.mediaHostError : "";
    // Edit prefills the same form: add-with-an-existing-name already updates in
    // place, so editing needs no second route, just the values filled in.
    const editing = typeof req.query.edit === "string"
      ? assetList.find((a) => a.name === req.query.edit) ?? null : null;
    const rows = events.map((e) => `
      <tr>
        <td>${esc(new Date(e.at).toISOString())}</td>
        <td class="kind">${esc(e.kind)}</td>
        <td class="detail">${esc(e.detail)}</td>
      </tr>`).join("");
    res.send(shell(`Dashboard — ${t.label}`, `
      <h1>${esc(t.label)}</h1>
      <p class="lede">GHL location <code>${esc(t.locationId)}</code> &middot; assistant <code>${esc(t.assistantId)}</code></p>
      ${wireTrace(t.enabled ? 2 : 1)}
      <div class="panel">
        <div class="stat-row">
          <span class="stat">Status <span class="pill ${t.enabled ? "on" : "off"}">${t.enabled ? "enabled" : "disabled"}</span></span>
          <span class="stat">Waker <span class="pill ${t.wakerEnabled ? "on" : "off"}">${t.wakerEnabled ? "on" : "off"}</span></span>
          <span class="stat">Provider <span class="pill on">${esc(t.provider)}</span></span>
          <span class="stat">Voice notes <span class="pill ${t.modalities.audio ? "on" : "off"}">${t.modalities.audio ? "on" : "off"}</span></span>
          <span class="stat">Images <span class="pill ${t.modalities.image ? "on" : "off"}">${t.modalities.image ? "on" : "off"}</span></span>
          <span class="stat">Documents <span class="pill ${t.documentEnabled ? "on" : "off"}">${t.documentEnabled ? "on" : "off"}</span></span>
          <span class="stat">Video <span class="pill ${t.videoEnabled ? "on" : "off"}">${t.videoEnabled ? "on" : "off"}</span></span>
        </div>
        <form method="post" action="/dashboard/${t.token}/toggle">
          <div class="btn-row">
            <button class="btn btn-ghost" name="what" value="enabled">${t.enabled ? "Disable" : "Enable"} bridge</button>
            <button class="btn btn-ghost" name="what" value="waker">Turn waker ${t.wakerEnabled ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="audio">Turn voice notes ${t.modalities.audio ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="image">Turn images ${t.modalities.image ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="document">Turn documents ${t.documentEnabled ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="video">Turn video ${t.videoEnabled ? "off" : "on"}</button>
          </div>
        </form>
        <div class="section-title">What to look for</div>
        <form method="post" action="/dashboard/${t.token}/instruction">
          <div class="field">
            <label for="instruction">Extra guidance <span class="hint">— appended to the built-in
              extraction prompt for every attachment. Leave blank for the default.</span></label>
            <textarea id="instruction" name="instruction" spellcheck="false" style="min-height:96px"
              maxlength="${MAX_ANALYSIS_INSTRUCTION}"
              placeholder="e.g. Receipts are common here. Always extract the amount, currency, date, payer name and any reference or transaction number.">${esc(t.analysisInstruction ?? "")}</textarea>
          </div>
          <div class="callout warn">
            <span class="mark">!</span>
            <span>This changes what the reader <em>extracts</em>, not what is true. A screenshot can be
              edited in seconds and models misread digits, so never let the assistant confirm a payment
              on this alone — check it against your payment provider or invoice record.</span>
          </div>
          <div class="btn-row">
            <button class="btn btn-ghost">Save guidance</button>
          </div>
        </form>
        <div class="section-title">Trusted attachment hosts</div>
        <form method="post" action="/dashboard/${t.token}/media-hosts">
          <div class="field">
            <label for="media_hosts">Additional HTTPS hostnames <span class="hint">— one per line or comma-separated; use only hosts you control or have verified with the channel provider.</span></label>
            <textarea id="media_hosts" name="media_hosts" spellcheck="false" style="min-height:72px"
              placeholder="links.wellgrow.io\ncdn.example.com">${esc((t.allowedMediaHosts ?? []).join("\n"))}</textarea>
          </div>
          ${mediaHostError ? `<div class="callout warn"><span class="mark">!</span><span>${esc(mediaHostError)}</span></div>` : ""}
          <div class="callout warn">
            <span class="mark">!</span>
            <span>Hosts are still required to use HTTPS and resolve to public addresses. This setting allows fetching media from the host; it does not grant access to other locations.</span>
          </div>
          <div class="btn-row"><button class="btn btn-ghost">Save attachment hosts</button></div>
        </form>
        <div class="section-title">Assistants in this location</div>
        ${assistantList.length === 0 ? `<p class="empty">Assistant bindings will appear after the next provisioning run. Onboarding attaches the media tools to every assistant discovered in this location.</p>` : `<table>
          <tr><th>Assistant</th><th>Status</th><th>Provisioning</th><th></th></tr>
          ${assistantList.map((a) => `<tr>
            <td><code>${esc(a.assistantId)}</code></td>
            <td><span class="pill ${a.enabled ? "on" : "off"}">${a.enabled ? "enabled" : "disabled"}</span></td>
            <td>${esc(a.lastProvisioningStatus)}${a.lastProvisioningError ? ` — ${esc(a.lastProvisioningError)}` : ""}</td>
            <td><form method="post" action="/dashboard/${t.token}/assistants/${encodeURIComponent(a.assistantId)}/toggle"><button class="btn btn-ghost">${a.enabled ? "Disable" : "Enable"}</button></form></td>
          </tr>`).join("")}
        </table>`}
        <div class="section-title">Media the assistant can send</div>
        ${assetError ? `
          <div class="callout warn">
            <span class="mark">!</span>
            <span>${esc(assetError)}</span>
          </div>` : ""}
        ${assetNotice.length ? `
          <div class="callout warn">
            <span class="mark">!</span>
            <span><strong>Saved, but check this before it goes to a customer:</strong>
              ${assetNotice.map((n) => `<br>&bull; ${esc(n)}`).join("")}</span>
          </div>` : ""}
        ${assetList.length === 0
          ? `<p class="empty">No assets yet. Add one and the assistant can send it when the
              conversation calls for it.</p>`
          : `<table>
              <tr><th>Name</th><th>Type</th><th>What it is</th><th></th></tr>
              ${assetList.map((a) => `
                <tr>
                  <td><code>${esc(a.name)}</code></td>
                  <td>${esc(a.kind)}</td>
                  <td>${esc(a.description)}</td>
                  <td class="row-actions">
                    <a class="btn btn-ghost" href="/dashboard/${t.token}?edit=${encodeURIComponent(a.name)}#assets">Edit</a>
                    <form method="post" action="/dashboard/${t.token}/assets/remove">
                      <input type="hidden" name="name" value="${esc(a.name)}">
                      <button class="btn btn-ghost">Remove</button>
                    </form>
                  </td>
                </tr>`).join("")}
            </table>`}
        <form method="post" action="/dashboard/${t.token}/assets" id="assets">
          ${editing ? `
          <div class="callout ok">
            <span class="mark">&#9998;</span>
            <span>Editing <code>${esc(editing.name)}</code>. The name stays the same so the
              assistant keeps referring to the same asset — change the description or the URL.</span>
          </div>
          <input type="hidden" name="name" value="${esc(editing.name)}">`
          : `<label>Name<input name="name" placeholder="demo-video" required></label>`}
          <label>What it is<input name="description"
            placeholder="60s walkthrough of how the product works"
            value="${editing ? esc(editing.description) : ""}" required></label>
          <label>URL<input name="url" placeholder="https://..."
            value="${editing ? esc(editing.url) : ""}" required></label>
          <div class="hint">
            <span>Host the file wherever it already lives — your CRM's media library is the usual
              place — and paste the link. The assistant picks by <em>what it is</em>, so describe it
              the way a customer would ask for it. Limit ${MAX_ASSETS} assets.</span>
          </div>
          <div class="btn-row">
            <button class="btn ${editing ? "btn-primary" : "btn-ghost"}">${editing ? "Save changes" : "Add asset"}</button>
            ${editing ? `<a class="btn btn-ghost" href="/dashboard/${t.token}">Cancel</a>` : ""}
          </div>
        </form>
        <div class="section-title">Recent activity</div>
        ${events.length === 0
          ? `<p class="empty">No events yet — activity will appear here once a contact sends an attachment.</p>`
          : `<table>
              <tr><th>Time</th><th>Event</th><th>Detail</th></tr>
              ${rows}
            </table>`}
        <footer class="copy">
          <small>Tool: ${t.toolId ? `analyze_attachment (${esc(t.toolId)})` : "not yet created"}</small>
          <small><code>${esc(ctx.publicBaseUrl)}/mcp/${t.token}</code></small>
        </footer>
        ${t.toolId ? `
        <form method="post" action="/dashboard/${t.token}/assign-all">
          <div class="btn-row">
            <button class="btn btn-ghost">Attach tool to all assistants</button>
          </div>
        </form>
        <p class="lede" style="margin:10px 0 0;font-size:13px">The tool is attached to an assistant the
          first time that assistant receives an attachment, so a subaccount with several assistants fills
          in as they are used. Press this to attach it to all of them now, so any assistant can read
          attachments before it has ever been sent one.</p>` : `
        <form method="post" action="/dashboard/${t.token}/retry-tool">
          <div class="btn-row">
            <button class="btn btn-primary">Retry tool setup</button>
          </div>
        </form>`}
      </div>
    `));
  });

  // Re-run tool create/recover/assign for an already-connected tenant. The
  // onboarding path can leave toolId null (e.g. platform-side create failure);
  // this makes that state recoverable in one click instead of forcing a
  // re-onboard (which would duplicate the tenant and double-wake conversations).
  router.post("/dashboard/:token/retry-tool", async (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    try {
      const v3 = ctx.v3Factory(t.v3Key, t.subAccountId);
      const r = await ensureTool(v3, ctx.tenants, ctx.publicBaseUrl, t);
      if (r.toolId) {
        ctx.events.record(t.id, "assign", `tool ready (${r.toolId})${r.warnings.length ? ` — ${r.warnings.join("; ")}` : ""}`);
        ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "retry_tool", detail: r.toolId });
      } else {
        ctx.events.record(t.id, "error", `tool retry failed: ${r.warnings.join("; ")}`);
      }
    } catch (err) {
      ctx.events.record(t.id, "error", `tool retry failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    res.redirect(`/dashboard/${t.token}`);
  });

  // Reconcile the media tools to EVERY assistant in the subaccount. Onboarding
  // already performs this desired-state attach; this button is an idempotent
  // repair path when an assistant was added later or an upstream assignment
  // was removed.
  router.post("/dashboard/:token/assign-all", async (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const toolId = t.toolId;
    if (!toolId) {
      ctx.events.record(
        t.id, "error",
        "attach-to-all skipped: the tool does not exist yet — use Retry tool setup first"
      );
      res.redirect(`/dashboard/${t.token}`);
      return;
    }
    try {
      const v3 = ctx.v3Factory(t.v3Key, t.subAccountId);
      const assistants = await v3.listAssistants();
      // Both tools, not just the reader. A send tool attached only to the
      // onboarding assistant is the exact failure assign-on-wake was built to
      // fix: on a multi-assistant account the assistant actually handling the
      // conversation has no tool to call, and nothing errors anywhere.
      const toolIds = [toolId, ...(t.sendToolId ? [t.sendToolId] : [])];
      const results = await mapLimit(assistants, 4, async (a) => {
        try {
          for (const id of toolIds) {
            const r = await v3.assignTool(id, a.id);
            if (!r.ok) return { id: a.id, ok: false, error: r.error };
          }
          return { id: a.id, ok: true };
        } catch (err) {
          return { id: a.id, ok: false, error: err instanceof Error ? err.message : "unknown" };
        }
      });
      const failed = results.filter((r) => !r.ok);
      if (ctx.assistantBindings) {
        for (const result of results) {
          ctx.assistantBindings.upsert(t.id, result.id);
          ctx.assistantBindings.markProvisioned(t.id, result.id, result.ok ? "ready" : "failed", result.ok ? undefined : result.error);
        }
      }
      ctx.events.record(
        t.id, failed.length ? "error" : "assign",
        `tool attached to ${results.length - failed.length}/${results.length} assistants` +
        (failed.length ? ` — failed: ${failed.map((f) => `${f.id} (${f.error})`).join("; ")}` : "")
      );
    } catch (err) {
      // One assistant failing is recorded above; this is the whole call dying.
      ctx.events.record(
        t.id, "error",
        `attach-to-all failed: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
    res.redirect(`/dashboard/${t.token}`);
  });

  router.post("/dashboard/:token/instruction", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const text = (req.body as { instruction?: string }).instruction ?? "";
    ctx.tenants.setAnalysisInstruction(t.id, text);
    const clean = text.trim();
    ctx.events.record(
      t.id, "config",
      clean ? `analysis guidance set (${Math.min(clean.length, MAX_ANALYSIS_INSTRUCTION)} chars)` : "analysis guidance cleared"
    );
    ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "analysis_guidance", detail: clean ? "set" : "cleared" });
    res.redirect(`/dashboard/${t.token}`);
  });

  router.post("/dashboard/:token/media-hosts", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const raw = (req.body as { media_hosts?: string }).media_hosts ?? "";
    const parsed = normalizeMediaHosts(raw);
    if (parsed.invalid.length) {
      res.status(400).send(shell("Invalid attachment host", `
        <h1>Invalid attachment host</h1>
        <p class="lede">Enter hostnames only, without <code>https://</code>, paths, ports, wildcards or IP addresses.</p>
        <p>Rejected: <code>${esc(parsed.invalid.join(", "))}</code></p>
        <p>The limit is ${MAX_CUSTOM_MEDIA_HOSTS} hostnames.</p>
        <a class="btn btn-ghost" href="/dashboard/${t.token}">&larr; Back to dashboard</a>
      `));
      return;
    }
    ctx.tenants.setAllowedMediaHosts(t.id, parsed.hosts);
    ctx.events.record(t.id, "config", parsed.hosts.length ? `media hosts set (${parsed.hosts.length})` : "media hosts cleared");
    ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "media_hosts", detail: parsed.hosts.length ? "set" : "cleared" });
    res.redirect(`/dashboard/${t.token}`);
  });

  router.post("/dashboard/:token/assistants/:assistantId/toggle", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t || !ctx.assistantBindings) { res.status(404).end(); return; }
    const binding = ctx.assistantBindings.list(t.id).find((a) => a.assistantId === req.params.assistantId);
    if (!binding) { res.status(404).end(); return; }
    ctx.assistantBindings.setEnabled(t.id, binding.assistantId, !binding.enabled);
    ctx.events.record(t.id, "config", `assistant ${binding.assistantId} ${binding.enabled ? "disabled" : "enabled"}`);
    ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "assistant_toggle", detail: `${binding.assistantId}:${!binding.enabled}` });
    res.redirect(`/dashboard/${t.token}`);
  });

  /**
   * Push the current library into the send tool's description.
   *
   * Called after every mutation because the description is the ONLY place the
   * model learns which assets exist — v3 tools carry no parameter schema. A
   * failure here is surfaced but never blocks the edit: the asset is already
   * saved, and a stale description is recoverable on the next edit.
   */
  const refreshSendTool = async (token: string): Promise<string> => {
    const t = ctx.tenants.getByToken(token);
    if (!t) return "";
    try {
      const { warnings } = await ensureSendTool(
        ctx.v3Factory(t.v3Key, t.subAccountId) as never,
        ctx.tenants, ctx.publicBaseUrl, t, ctx.assets.list(t.id)
      );
      return warnings[0] ?? "";
    } catch (err) {
      return `the asset was saved, but the assistant's tool could not be updated (${err instanceof Error ? err.message : "unknown"}) — edit any asset to retry`;
    }
  };

  router.post("/dashboard/:token/assets", async (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const body = req.body as { name?: string; description?: string; url?: string };
    const back = (error: string) =>
      res.redirect(`/dashboard/${t.token}?assetError=${encodeURIComponent(error)}`);

    const name = normalizeAssetName(body.name ?? "");
    const description = (body.description ?? "").trim().slice(0, 200);
    const url = (body.url ?? "").trim();
    if (!name) return back("give the asset a name using letters or numbers");
    if (!description) return back("describe what the asset is — the assistant picks by that description");

    const check = await validateAssetUrl(url, {
      ...(ctx.assetFetch ? { fetchImpl: ctx.assetFetch } : {}),
      ...(ctx.assetLookup ? { lookupImpl: ctx.assetLookup } : {}),
    });
    if (!check.ok) return back(check.error);

    const existed = ctx.assets.get(t.id, name) !== null;
    try {
      ctx.assets.add(t.id, { name, description, kind: check.kind, url });
    } catch (err) {
      return back(err instanceof Error ? err.message : "the asset could not be saved");
    }
    ctx.events.record(
      t.id, "config", `asset ${existed ? "updated" : "added"}: ${name} (${check.kind})`
    );
    const warning = await refreshSendTool(t.token);
    const notes = assetWarnings({
      kind: check.kind, url, contentType: check.contentType, bytes: check.bytes,
    });
    const params = new URLSearchParams();
    if (warning) params.set("assetError", warning);
    if (notes.length) params.set("assetNotice", notes.join("\n"));
    const qs = params.toString();
    return res.redirect(`/dashboard/${t.token}${qs ? `?${qs}` : ""}`);
  });

  router.post("/dashboard/:token/assets/remove", async (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const name = normalizeAssetName((req.body as { name?: string }).name ?? "");
    if (ctx.assets.remove(t.id, name)) {
      ctx.events.record(t.id, "config", `asset removed: ${name}`);
      ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "asset_remove", detail: name });
    }
    const warning = await refreshSendTool(t.token);
    return warning
      ? res.redirect(`/dashboard/${t.token}?assetError=${encodeURIComponent(warning)}`)
      : res.redirect(`/dashboard/${t.token}`);
  });

  router.post("/forget", (_req, res) => {
    forgetTokens(res);
    res.redirect("/");
  });

  router.post("/dashboard/:token/toggle", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const what = (req.body as { what?: string }).what;
    if (what === "enabled") ctx.tenants.setEnabled(t.id, !t.enabled);
    if (what === "waker") ctx.tenants.setWaker(t.id, !t.wakerEnabled);
    if (what === "audio") ctx.tenants.setModality(t.id, "audio", !t.modalities.audio);
    if (what === "image") ctx.tenants.setModality(t.id, "image", !t.modalities.image);
    if (what === "document") ctx.tenants.setModality(t.id, "document", !t.documentEnabled);
    if (what === "video") ctx.tenants.setModality(t.id, "video", !t.videoEnabled);
    if (["enabled", "waker", "audio", "image", "document", "video"].includes(what ?? "")) {
      ctx.audit?.record({ tenantId: t.id, actor: "portal", action: "kill_switch", detail: what ?? "unknown" });
    }
    res.redirect(`/dashboard/${t.token}`);
  });

  return router;
}
