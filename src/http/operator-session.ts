import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE = "mb_operator";
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

function secureCookie(req: Request): boolean {
  return req.protocol === "https" || req.get("x-forwarded-proto") === "https";
}

function cookieValue(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}

function signature(payload: string, operatorToken: string): string {
  return createHmac("sha256", operatorToken).update(payload).digest("base64url");
}

/** Creates a stateless, short-lived cookie. It contains no operator secret. */
export function createOperatorSession(operatorToken: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const payload = `${issuedAt}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${signature(payload, operatorToken)}`;
}

export function verifyOperatorSession(
  value: string | undefined,
  operatorToken: string,
  now = Date.now(),
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [issuedAt, nonce, actual] = parts;
  if (!/^\d+$/.test(issuedAt) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  const issuedMs = Number(issuedAt) * 1000;
  if (!Number.isSafeInteger(issuedMs) || issuedMs > now + 60_000 || now - issuedMs > MAX_AGE_MS) return false;
  const expected = signature(`${issuedAt}.${nonce}`, operatorToken);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function hasOperatorAccess(req: Request, operatorToken: string | undefined): boolean {
  if (!operatorToken) return true;
  const authorization = typeof req.get === "function" ? req.get("authorization") : undefined;
  if (authorization === `Bearer ${operatorToken}`) return true;
  return verifyOperatorSession(cookieValue(req), operatorToken);
}

export function setOperatorSession(req: Request, res: Response, operatorToken: string): void {
  res.cookie(COOKIE, createOperatorSession(operatorToken), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
    maxAge: MAX_AGE_MS,
  });
}

export function clearOperatorSession(res: Response): void {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
}

/** Only permit a local relative redirect; never reflect an external URL. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  return value;
}
