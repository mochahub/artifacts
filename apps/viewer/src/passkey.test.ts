import { afterEach, describe, expect, test } from "bun:test";
import { canUseHomePasskey } from "./passkey.ts";
import { meta } from "./session.ts";

const globals = globalThis as Record<string, unknown>;
afterEach(() => {
  delete globals.location;
  delete globals.PublicKeyCredential;
  meta.value = null;
});

const visit = (hostname: string) => {
  globals.location = { hostname };
  meta.value = { homeDomain: "art.example" } as typeof meta.value;
};

describe("whether a passkey from the home domain can be used here", () => {
  test("yes on the home domain, with no WebAuthn lookup", async () => {
    visit("art.example");
    expect(await canUseHomePasskey()).toBe(true);
  });

  test("no on another domain in a browser with no WebAuthn, without throwing", async () => {
    visit("review.example");
    expect(await canUseHomePasskey()).toBe(false);
  });

  test("follows the browser's related-origins answer elsewhere", async () => {
    visit("review.example");
    globals.PublicKeyCredential = { getClientCapabilities: async () => ({ relatedOrigins: true }) };
    expect(await canUseHomePasskey()).toBe(true);
    globals.PublicKeyCredential = { getClientCapabilities: async () => ({ relatedOrigins: false }) };
    expect(await canUseHomePasskey()).toBe(false);
  });

  test("no on another domain when the browser can't say", async () => {
    visit("review.example");
    globals.PublicKeyCredential = {};
    expect(await canUseHomePasskey()).toBe(false);
  });
});
