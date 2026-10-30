// Builds the CLI for every target, with SHA256SUMS, into the folder given. Used by release.yml and the dry run.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "dist/release";
const only = process.argv[3];
const TARGETS = [
  ["darwin-arm64", "artifacts-darwin-arm64"],
  ["darwin-x64", "artifacts-darwin-x64"],
  ["linux-x64", "artifacts-linux-x64"],
  ["linux-arm64", "artifacts-linux-arm64"],
  ["windows-x64", "artifacts-windows-x64.exe"],
] as const;

mkdirSync(out, { recursive: true });
const sums: string[] = [];
for (const [target, name] of TARGETS) {
  if (only && only !== target) continue;
  const path = join(out, name);
  const build = Bun.spawnSync(
    ["bun", "build", "packages/cli/src/index.ts", "--compile", `--target=bun-${target}`, `--outfile=${path}`],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (!build.success) process.exit(build.exitCode ?? 1);
  sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}`);
  console.log(`built ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
