import { expect, test } from "bun:test";
import { latestTag, nextVersion } from "../src/release-version.ts";

test("the latest tag compares numbers, and ignores anything that isn't a release", () => {
  expect(latestTag(["v0.9.0", "v0.10.0", "v0.2.0", "nightly", "v1.0.0-rc1", ""])).toBe("0.10.0");
  expect(latestTag(["nightly", ""])).toBeNull();
});

test("the first release is the version in the package", () => {
  expect(nextVersion(null, "0.1.0", "patch")).toBe("0.1.0");
});

test("later releases bump the latest tag", () => {
  expect(nextVersion("0.1.9", "0.1.0", "patch")).toBe("0.1.10");
  expect(nextVersion("0.1.9", "0.1.0", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.9", "0.1.0", "major")).toBe("1.0.0");
});

test("a package version set ahead of the tags is used as it is", () => {
  expect(nextVersion("0.1.9", "0.3.0", "patch")).toBe("0.3.0");
});
