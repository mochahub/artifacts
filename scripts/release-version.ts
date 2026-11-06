// What release.yml calls. `next <patch|minor|major>` prints the next version; `stamp <version>` writes it
// into the packages the CLI and the server read their version from. The repo never needs a version commit.
import { readFileSync, writeFileSync } from "node:fs";

export type Bump = "patch" | "minor" | "major";

const STAMPED = ["packages/cli/package.json", "apps/server/package.json"];
const parse = (version: string) => version.split(".").map(Number) as [number, number, number];
const newer = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
};

/** The highest vX.Y.Z tag, without its v. Other tags aren't releases. */
export function latestTag(tags: string[]) {
  return tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1))
    .reduce<string | null>((best, tag) => (best && !newer(tag, best) ? best : tag), null);
}

/** The package version wins when it's ahead, so a version can still be chosen by hand. */
export function nextVersion(latest: string | null, packaged: string, bump: Bump) {
  if (!latest || newer(packaged, latest)) return packaged;
  const [major, minor, patch] = parse(latest);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (import.meta.main) {
  const [command, value] = process.argv.slice(2);
  if (command === "next" && (value === "patch" || value === "minor" || value === "major")) {
    const tags = Bun.spawnSync(["git", "tag", "--list"]).stdout.toString().split("\n");
    const packaged = JSON.parse(readFileSync(STAMPED[0] as string, "utf8")).version;
    console.log(nextVersion(latestTag(tags), packaged, value));
  } else if (command === "stamp" && value && /^\d+\.\d+\.\d+$/.test(value)) {
    for (const path of STAMPED) {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, `${JSON.stringify({ ...pkg, version: value }, null, 2)}\n`);
    }
  } else {
    console.error("usage: release-version.ts next <patch|minor|major> | stamp <x.y.z>");
    process.exit(1);
  }
}
