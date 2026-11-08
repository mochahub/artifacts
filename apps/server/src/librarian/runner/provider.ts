import type { Usage } from "@anthropic-ai/sdk/resources/messages";
import type { Deps } from "../../deps.ts";
import { type RunFence, withProviderKey } from "../index.ts";
/** Deliberately small SDK boundary. Never includes keys or provider error bodies in results. */
export type Message = { role: "user" | "assistant"; content: unknown[] };
export type Tool = { name: string; description: string; input_schema: object; strict: true };
export type Prompt = {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  maxOutputTokens: number;
  signal: AbortSignal;
};
export type Response = {
  content: unknown[];
  stop_reason: string;
  usage: Record<string, unknown>;
  requestId: string;
};
export interface LibrarianProvider {
  countTokens(prompt: Prompt): Promise<number>;
  respond(prompt: Prompt): Promise<Response>;
}
export class ProviderFailure extends Error {
  constructor(
    readonly status?: number,
    readonly retryAfterMs = 0,
  ) {
    super("provider_failed");
  }
}
interface SDK {
  messages: {
    countTokens(body: object, options: object): Promise<{ input_tokens: number }>;
    stream(
      body: object,
      options: object,
    ): {
      finalMessage(): Promise<{
        content: unknown[];
        stop_reason: string | null;
        usage: Usage;
        _request_id?: string;
      }>;
    };
  };
}
function body(p: Prompt) {
  return {
    model: p.model,
    system: p.system,
    messages: p.messages,
    tools: p.tools,
    thinking: { type: "adaptive" },
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  };
}
export const SDK_ISOLATION = {
  authToken: null,
  openTelemetry: { traces: false, propagation: false },
} as const;
/** Caller must obtain the key through withProviderKey and guard both counting and dispatch. */
export async function createAnthropicProvider(key: Buffer): Promise<LibrarianProvider> {
  if (!key.length) throw new Error("key_required");
  // SDK merges this environment variable even with explicit defaultHeaders. Refuse ambient headers.
  if (Object.hasOwn(process.env, "ANTHROPIC_CUSTOM_HEADERS")) throw new Error("ambient_headers_forbidden");
  // Literal import validates the installed SDK boundary without loading it in private mocks.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client: SDK = new Anthropic({
    apiKey: key.toString("utf8"),
    ...SDK_ISOLATION,
    webhookKey: null,
    baseURL: "https://api.anthropic.com",
    maxRetries: 0,
    timeout: 60_000,
    defaultHeaders: {},
    logLevel: "off",
  });
  async function safe<T>(use: () => Promise<T>): Promise<T> {
    try {
      return await use();
    } catch (error) {
      const e = error as { status?: number; headers?: { get(name: string): string | null } };
      const retry = e.headers?.get?.("retry-after");
      const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : 0;
      throw new ProviderFailure(
        Number.isInteger(e.status) ? e.status : undefined,
        Math.max(0, seconds * 1000),
      );
    }
  }
  return {
    countTokens: (p) =>
      safe(async () =>
        tokenInteger((await client.messages.countTokens(body(p), { signal: p.signal })).input_tokens),
      ),
    respond: (p) =>
      safe(async () => {
        const m = await client.messages
          .stream(
            {
              ...body(p),
              max_tokens: p.maxOutputTokens,
              tool_choice: { type: "auto", disable_parallel_tool_use: true },
            },
            { signal: p.signal },
          )
          .finalMessage();
        return {
          content: m.content,
          stop_reason: m.stop_reason ?? "invalid_response",
          usage: { ...m.usage },
          requestId: m._request_id ?? "",
        };
      }),
  };
}
export function tokenInteger(n: unknown): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("invalid_usage");
  return n;
}
export function cost(input: number, output: number, rates: { input: string; output: string }): bigint {
  tokenInteger(input);
  tokenInteger(output);
  if (![rates.input, rates.output].every((r) => /^\d+$/.test(r))) throw new Error("unpriced_model");
  return (BigInt(input) * BigInt(rates.input) + BigInt(output) * BigInt(rates.output) + 999999n) / 1000000n;
}
export function usageCost(r: Response, ceiling: number, rates: { input: string; output: string }) {
  const allowed = new Set([
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cache_creation",
    "server_tool_use",
    "service_tier",
    "inference_geo",
  ]);
  for (const [key, value] of Object.entries(r.usage)) {
    if (!allowed.has(key)) throw new Error("unknown_usage");
    if (key.startsWith("cache_") || key === "server_tool_use") {
      if (key === "cache_creation" && value && typeof value === "object") {
        const entries = Object.entries(value);
        if (
          entries.some(
            ([k, v]) => !["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].includes(k) || v !== 0,
          )
        )
          throw new Error("unsupported_usage");
      } else if (value !== null && value !== 0) throw new Error("unsupported_usage");
    }
    if (key === "service_tier" && value !== "standard" && value !== null)
      throw new Error("unsupported_usage");
    if (key === "inference_geo" && value !== null) throw new Error("unsupported_usage");
  }
  const input = tokenInteger(r.usage.input_tokens),
    output = tokenInteger(r.usage.output_tokens);
  if (!r.requestId || input > ceiling || output > 4096) throw new Error("invalid_usage");
  return cost(input, output, rates);
}

/** The SDK client/key lives for one fenced operation only; no cached credential survives rotation. */
export function guardedAnthropicProvider(deps: Deps, fence: RunFence): LibrarianProvider {
  return {
    countTokens: (prompt) =>
      withProviderKey(deps, fence, async (key) => (await createAnthropicProvider(key)).countTokens(prompt)),
    respond: (prompt) =>
      withProviderKey(deps, fence, async (key) => (await createAnthropicProvider(key)).respond(prompt)),
  };
}
