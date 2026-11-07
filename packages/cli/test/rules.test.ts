import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasesUrl } from "../src/admin.ts";
import { helperInstalled } from "../src/render/install.ts";
import { olderThan } from "../src/version.ts";

describe("versions", () => {
  test("a prerelease comes before its release, and something that isn't a version is never older", () => {
    expect(olderThan("0.2.0-rc.1", "0.2.0")).toBe(true);
    expect(olderThan("0.2.0", "0.2.0-rc.1")).toBe(false);
    expect(olderThan("0.9.0", "0.10.0")).toBe(true);
    expect(olderThan("dev", "0.2.0")).toBe(false);
  });
});

describe("the render helper", () => {
  test("counts as installed only at the versions this CLI pins, as render decides", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifacts-helper-"));
    expect(helperInstalled(dir)).toBe(false);
    writeFileSync(join(dir, ".installed"), "playwright-core@1.0.0");
    expect(helperInstalled(dir)).toBe(false);
  });
});

describe("where releases come from", () => {
  test("http only on this machine, by the same rule as a server's address", () => {
    const at = (url: string) => {
      process.env.ARTIFACTS_RELEASES_URL = url;
      try {
        return releasesUrl();
      } finally {
        delete process.env.ARTIFACTS_RELEASES_URL;
      }
    };
    expect(at("http://releases.localhost:8080")).toBe("http://releases.localhost:8080");
    expect(() => at("http://releases.example.com")).toThrow("isn't https");
  });
});
