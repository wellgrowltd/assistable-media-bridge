import { isIP } from "node:net";

export const MAX_CUSTOM_MEDIA_HOSTS = 20;
export const MAX_MEDIA_HOST_LENGTH = 253;

/**
 * Parse operator-entered hostnames, never URLs. Custom hosts are intentionally
 * host suffixes: `links.wellgrow.io` also permits its CDN subdomains, while a
 * lookalike such as `links.wellgrow.io.evil.example` still fails closed.
 */
export function normalizeMediaHosts(raw: string | string[] | null | undefined): {
  hosts: string[];
  invalid: string[];
} {
  const values = Array.isArray(raw) ? raw : (raw ?? "").split(/[\n,]+/);
  const hosts: string[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    const candidate = value.trim().toLowerCase();
    if (!candidate) continue;
    const valid = candidate.length <= MAX_MEDIA_HOST_LENGTH
      && candidate === candidate.replace(/\.$/, "")
      && !candidate.includes("/")
      && !candidate.includes(":")
      && !candidate.includes("@")
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(candidate)
      && isIP(candidate) === 0;
    if (!valid) {
      invalid.push(value.trim() || candidate);
      continue;
    }
    if (!hosts.includes(candidate)) hosts.push(candidate);
  }
  if (hosts.length > MAX_CUSTOM_MEDIA_HOSTS) {
    invalid.push(...hosts.slice(MAX_CUSTOM_MEDIA_HOSTS));
    hosts.length = MAX_CUSTOM_MEDIA_HOSTS;
  }
  return { hosts, invalid };
}
