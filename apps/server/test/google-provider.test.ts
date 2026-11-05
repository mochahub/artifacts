import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { googleProvider } from "../src/auth/google.ts";

const exchange = () =>
  googleProvider.exchange({
    code: "code",
    verifier: "verifier",
    redirectUri: "https://art.example.com/api/auth/google/callback",
    clientId: "client",
    clientSecret: "secret-value",
  });

const answers = (status: number, body: string) =>
  spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));

describe("Google's token endpoint", () => {
  let spy: ReturnType<typeof answers>;
  afterEach(() => spy.mockRestore());

  test("a refusal names Google's reason, and nothing else from the reply", async () => {
    spy = answers(
      400,
      JSON.stringify({ error: "redirect_uri_mismatch", error_description: "client secret-value" }),
    );
    const message = await exchange().catch((error) => String(error));
    expect(message).toContain("Google answered 400 redirect_uri_mismatch");
    expect(message).not.toContain("secret-value");
  });

  test("a reply that isn't JSON is still a refusal", async () => {
    spy = answers(502, "<html>Bad gateway</html>");
    expect(exchange()).rejects.toThrow("Google answered 502");
  });

  test("a reply with no ID token is a refusal", async () => {
    spy = answers(200, JSON.stringify({ access_token: "token" }));
    expect(exchange()).rejects.toThrow("Google sent no ID token");
  });

  test("the ID token comes back", async () => {
    spy = answers(200, JSON.stringify({ id_token: "a.b.c" }));
    expect(await exchange()).toBe("a.b.c");
  });
});
