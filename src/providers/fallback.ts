import type { KeyCheck, MediaInput, MediaProvider, ProviderAttempt } from "./types";

type ProviderName = "gemini" | "openai";

export interface FallbackProviderOptions {
  primaryProvider: ProviderName;
  primary: MediaProvider;
  fallback?: { name: ProviderName; provider: MediaProvider };
  fallbackEnabled: boolean;
  onAttempt?: (attempt: ProviderAttempt) => void;
}

const statusClass = (error: unknown): ProviderAttempt["statusClass"] => {
  const message = error instanceof Error ? error.message : String(error);
  if (/(timed out|request failed \(network\)|\b(?:429|5\d\d)\b)/i.test(message)) return "transient";
  if (/\b(?:401|403)\b|invalid api key|unauthori[sz]ed|forbidden/i.test(message)) return "auth";
  if (/not supported|unsupported|not yet supported/i.test(message)) return "unsupported";
  return "other";
};

const emit = (fn: FallbackProviderOptions["onAttempt"], attempt: ProviderAttempt) => {
  try { fn?.(attempt); } catch { /* diagnostics must never break the customer path */ }
};

export function createFallbackProvider(options: FallbackProviderOptions): MediaProvider {
  const gemini = options.primaryProvider === "gemini"
    ? options.primary
    : options.fallback?.name === "gemini" ? options.fallback.provider : undefined;

  const call = async (name: ProviderName, provider: MediaProvider, input: MediaInput, attempt: number): Promise<string> => {
    const started = Date.now();
    try {
      const result = await provider.describe(input);
      emit(options.onAttempt, {
        provider: name, modality: input.kind, outcome: "success", statusClass: "other",
        durationMs: Math.max(0, Date.now() - started), attempt,
      });
      return result;
    } catch (error) {
      emit(options.onAttempt, {
        provider: name, modality: input.kind, outcome: "error", statusClass: statusClass(error),
        durationMs: Math.max(0, Date.now() - started), attempt,
      });
      throw error;
    }
  };

  const describe = async (input: MediaInput): Promise<string> => {
    // Gemini is the only provider in this bridge that can inspect these media
    // types. Never route them to a text/vision fallback that would guess.
    if (input.kind === "video" || input.kind === "pdf") {
      if (!gemini) throw new Error("Gemini provider is required for video and PDF attachments");
      return call("gemini", gemini, input, 1);
    }

    const primary = options.primary;
    try {
      return await call(options.primaryProvider, primary, input, 1);
    } catch (error) {
      const alternate = options.fallback;
      if (!options.fallbackEnabled || !alternate || statusClass(error) !== "transient") throw error;
      return call(alternate.name, alternate.provider, input, 2);
    }
  };

  const validateKey = async (): Promise<KeyCheck> => options.primary.validateKey();
  return { describe, validateKey };
}

