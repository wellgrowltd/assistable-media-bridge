import type { ProviderOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 1;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fetch one provider request with a hard deadline and one bounded transient retry. */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  provider: "gemini" | "openai",
  options: ProviderOptions = {},
  retry = true,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? `${provider} request timed out` : `${provider} request failed (network)`);
    }
    if (res.ok) return res;
    if (!retry || !TRANSIENT_STATUSES.has(res.status) || attempt >= maxRetries) return res;
    await wait(retryDelayMs * (attempt + 1));
  }
}
