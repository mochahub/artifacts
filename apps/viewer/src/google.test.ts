import { describe, expect, test } from "bun:test";
import { googleAnswer } from "./google.ts";

describe("what a way back from Google says", () => {
  test("the re-auth sheet says why Google didn't confirm someone, including an account with no Google", () => {
    expect(googleAnswer("reauth", "not-linked")).toBe(
      "Google isn't connected to your account. Use another way.",
    );
    expect(googleAnswer("reauth", "mismatch")).toBe("That's a different Google account.");
    expect(googleAnswer("reauth", "expired")).toBe("Google didn't confirm it. Try again.");
  });

  test("the same answer can read differently where it lands", () => {
    expect(googleAnswer("sign-in", "cancelled")).toBe("Google sign-in was cancelled.");
    expect(googleAnswer("settings", "cancelled")).toBe("Cancelled.");
  });

  test("an answer that means nothing in a place shows nothing there", () => {
    expect(googleAnswer("sign-in", "linked")).toBeNull();
    expect(googleAnswer("reauth", "tested")).toBeNull();
  });

  test.each([null, undefined, "", "nonsense", "constructor", "__proto__"])("%p shows nothing", (outcome) => {
    expect(googleAnswer("sign-in", outcome)).toBeNull();
  });
});
