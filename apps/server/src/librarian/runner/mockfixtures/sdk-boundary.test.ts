import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider, ProviderFailure, SDK_ISOLATION } from "../provider.ts";

test("installed SDK constructs with explicit key, ambient auth and tracing disabled; count reaches denied transport only", async () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE",
    "ANTHROPIC_OPEN_TELEMETRY_PROPAGATION",
  ];
  const saved = names.map((name) => process.env[name]);
  const original = globalThis.fetch;
  let denied = 0;
  try {
    process.env.ANTHROPIC_API_KEY = "synthetic-ambient-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-ambient-token";
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    process.env.ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE = "content";
    process.env.ANTHROPIC_OPEN_TELEMETRY_PROPAGATION = "true";
    const client = new Anthropic({ apiKey: "synthetic-explicit", ...SDK_ISOLATION });
    expect(client.authToken).toBeNull();
    expect(client.openTelemetry.traces.enabled).toBe(false);
    expect(client.openTelemetry.propagation).toBe(false);
    globalThis.fetch = (async (url: string | Request | URL, init?: RequestInit) => {
      denied++;
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("synthetic-explicit");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("traceparent")).toBe(false);
      throw new Error("NETWORK_DENIED");
    }) as unknown as typeof fetch;
    const provider = await createAnthropicProvider(Buffer.from("synthetic-explicit"));
    await expect(
      provider.countTokens({
        model: "fixture",
        system: "private",
        messages: [{ role: "user", content: [{ type: "text", text: "private" }] }],
        tools: [],
        maxOutputTokens: 4096,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ProviderFailure);
    expect(denied).toBe(1);
  } finally {
    globalThis.fetch = original;
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});
