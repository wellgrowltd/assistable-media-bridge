import type { Request, Response, NextFunction } from "express";

/** Strict same-origin guard for browser dashboard writes. Tool/MCP clients do
 * not send Origin and are intentionally unaffected. */
export function sameOrigin(publicBaseUrl: string) {
  const expected = new URL(publicBaseUrl).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin && origin !== expected) { res.status(403).json({ error: "cross-origin request rejected" }); return; }
    const site = req.get("sec-fetch-site");
    if (site === "cross-site" && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      res.status(403).json({ error: "cross-site request rejected" }); return;
    }
    next();
  };
}

export function strictCors(publicBaseUrl: string) {
  const expected = new URL(publicBaseUrl).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin) {
      if (origin !== expected) { res.status(403).json({ error: "origin not allowed" }); return; }
      res.setHeader("Access-Control-Allow-Origin", expected);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-CSRF-Token");
      res.status(204).end();
      return;
    }
    next();
  };
}
