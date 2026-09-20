import { describe, expect, it } from "vitest";
import { createFallbackProvider } from "../src/providers/fallback";
import type { MediaInput, MediaProvider, ProviderAttempt } from "../src/providers/types";

const input = (kind: MediaInput["kind"]): MediaInput => ({
  kind, mime: kind === "audio" ? "audio/ogg" : kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "application/pdf",
  bytes: new Uint8Array([1]),
});

const provider = (describe: MediaProvider["describe"]): MediaProvider => ({
  describe,
  validateKey: async () => ({ ok: true }),
});

describe("fallback media provider", () => {
  it("uses the primary provider for a successful image without calling fallback", async () => {
    let fallbackCalls = 0;
    const p = createFallbackProvider({
      primaryProvider: "gemini",
      primary: provider(async () => "gemini image"),
      fallback: { name: "openai", provider: provider(async () => { fallbackCalls += 1; return "openai image"; }) },
      fallbackEnabled: true,
    });
    await expect(p.describe(input("image"))).resolves.toBe("gemini image");
    expect(fallbackCalls).toBe(0);
  });

  it("fails over audio after a transient primary error and records each attempt", async () => {
    const attempts: ProviderAttempt[] = [];
    let primaryCalls = 0;
    const p = createFallbackProvider({
      primaryProvider: "gemini",
      primary: provider(async () => { primaryCalls += 1; throw new Error("gemini 503"); }),
      fallback: { name: "openai", provider: provider(async () => "openai transcript") },
      fallbackEnabled: true,
      onAttempt: (a) => attempts.push(a),
    });
    await expect(p.describe(input("audio"))).resolves.toBe("openai transcript");
    expect(primaryCalls).toBe(1); // the adapter owns its bounded retry; the chain does not duplicate it
    expect(attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ["gemini", "error"], ["openai", "success"],
    ]);
    expect(attempts.every((a) => Number.isFinite(a.durationMs))).toBe(true);
  });

  it("does not fail over non-transient credential errors", async () => {
    let fallbackCalls = 0;
    const p = createFallbackProvider({
      primaryProvider: "gemini",
      primary: provider(async () => { throw new Error("gemini 401"); }),
      fallback: { name: "openai", provider: provider(async () => { fallbackCalls += 1; return "wrong"; }) },
      fallbackEnabled: true,
    });
    await expect(p.describe(input("image"))).rejects.toThrow("gemini 401");
    expect(fallbackCalls).toBe(0);
  });

  it("always routes video and PDF to Gemini even when OpenAI is primary", async () => {
    const seen: string[] = [];
    const p = createFallbackProvider({
      primaryProvider: "openai",
      primary: provider(async (i) => { seen.push(`openai:${i.kind}`); return "openai"; }),
      fallback: { name: "gemini", provider: provider(async (i) => { seen.push(`gemini:${i.kind}`); return `gemini ${i.kind}`; }) },
      fallbackEnabled: true,
    });
    await expect(p.describe(input("video"))).resolves.toBe("gemini video");
    await expect(p.describe(input("pdf"))).resolves.toBe("gemini pdf");
    expect(seen).toEqual(["gemini:video", "gemini:pdf"]);
  });

  it("refuses video when Gemini is not configured instead of asking OpenAI to guess", async () => {
    const p = createFallbackProvider({
      primaryProvider: "openai",
      primary: provider(async () => "openai"),
      fallbackEnabled: false,
    });
    await expect(p.describe(input("video"))).rejects.toThrow(/Gemini provider is required/i);
  });
});
