import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import type { MediaProvider, ProviderOptions } from "./types";

export type ProviderName = "gemini" | "openai";
export function getProvider(name: ProviderName, apiKey: string, fetchImpl?: typeof fetch, options?: ProviderOptions): MediaProvider {
  return name === "gemini" ? geminiProvider(apiKey, fetchImpl, options) : openaiProvider(apiKey, fetchImpl, options);
}
export type { MediaProvider, ProviderOptions } from "./types";
export { createFallbackProvider } from "./fallback";
export type { FallbackProviderOptions } from "./fallback";
