import { afterEach, describe, expect, test } from "bun:test";
import { forgetStored, readStored, writeStored } from "./storage.ts";

const real = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
};
afterEach(() => {
  for (const [name, descriptor] of Object.entries(real)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** A storage area backed by a map the test can look into. */
function area(name: "localStorage" | "sessionStorage") {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    },
  });
  return data;
}

const blocked = () =>
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });

describe("remembered preferences", () => {
  test("round trip through localStorage", () => {
    const data = area("localStorage");
    writeStored("artifacts.read.font", "sans");
    expect(readStored("artifacts.read.font")).toBe("sans");
    expect(data.get("artifacts.read.font")).toBe("sans");
    expect(readStored("missing")).toBeNull();
  });

  test("a browser that blocks storage reads as nothing remembered, and never throws", () => {
    blocked();
    expect(readStored("artifacts.read.font")).toBeNull();
    expect(() => writeStored("artifacts.read.font", "sans")).not.toThrow();
  });
});

describe("kept for this tab", () => {
  test("session storage is its own area, and forgetting clears a key", () => {
    const local = area("localStorage");
    const session = area("sessionStorage");
    writeStored("artifacts.device-code", "WDJB-MJHT", "session");
    expect(readStored("artifacts.device-code", "session")).toBe("WDJB-MJHT");
    expect(session.get("artifacts.device-code")).toBe("WDJB-MJHT");
    expect(local.size).toBe(0);
    expect(readStored("artifacts.device-code")).toBeNull();
    forgetStored("artifacts.device-code", "session");
    expect(readStored("artifacts.device-code", "session")).toBeNull();
  });
});
