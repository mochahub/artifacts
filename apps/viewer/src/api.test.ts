import { describe, expect, test } from "bun:test";
import { ApiFailure, isMissing, message, parseJson, readText } from "./api.ts";

const fail = (status: number) => new ApiFailure(status, "x", "x");

describe("which failures replace a screen", () => {
  test.each([400, 403, 404, 410])("%i means there's nothing here", (status) => {
    expect(isMissing(fail(status))).toBe(true);
  });

  test.each([401, 429, 500, 502, 503])("%i leaves what's on screen alone", (status) => {
    expect(isMissing(fail(status))).toBe(false);
  });

  test("no failure is no problem", () => {
    expect(isMissing(null)).toBe(false);
  });
});

describe("reading an answer", () => {
  const answer = (status: number, body: string) => new Response(body, { status });

  test("an error answer becomes the API's own failure", async () => {
    const body = JSON.stringify({ error: { code: "forbidden", message: "You can't.", details: { a: 1 } } });
    const failure = await readText(answer(403, body)).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "You can't.",
      details: { a: 1 },
    });
  });

  test("a proxy's error page still fails with its status", async () => {
    const failure = await readText(answer(502, "<html>Bad gateway</html>")).catch((error) => error);
    expect(failure).toMatchObject({ status: 502, code: "unknown", message: "Something went wrong." });
  });

  test("a good answer that isn't JSON fails as a failure, not a SyntaxError", () => {
    expect(() => parseJson(200, "<html>")).toThrow(ApiFailure);
    expect(parseJson(200, "")).toBeUndefined();
    expect(parseJson(200, '{"a":1}')).toEqual({ a: 1 });
  });
});

describe("what to tell someone", () => {
  test("the API's words, or the fallback for anything else", () => {
    expect(message(new ApiFailure(400, "invalid", "Too long."))).toBe("Too long.");
    expect(message(new TypeError("Load failed"))).toBe("Something went wrong.");
    expect(message(new DOMException("No", "NotAllowedError"), "That passkey didn't work.")).toBe(
      "That passkey didn't work.",
    );
  });
});
