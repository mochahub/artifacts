import { afterEach, describe, expect, test } from "bun:test";
import { readStored, writeStored } from "./storage.ts";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (real) Object.defineProperty(globalThis, "localStorage", real);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const blocked = () =>
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });

describe("remembered preferences", () => {
  test("round trip through localStorage", () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
      },
    });
    writeStored("artifacts.read.font", "sans");
    expect(readStored("artifacts.read.font")).toBe("sans");
    expect(readStored("missing")).toBeNull();
  });

  test("a browser that blocks storage reads as nothing remembered, and never throws", () => {
    blocked();
    expect(readStored("artifacts.read.font")).toBeNull();
    expect(() => writeStored("artifacts.read.font", "sans")).not.toThrow();
  });
});
