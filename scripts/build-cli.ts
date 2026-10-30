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

// Puts the built viewer inside the binary, for `artifacts dev`.
const build = Bun.spawnSync(["bun", "run", "--filter", "@artifacts/viewer", "build"], {
  stdout: "ignore",
  stderr: "inherit",
});
if (!build.success) process.exit(build.exitCode ?? 1);
const assets: Record<string, string> = {};
for (const path of new Bun.Glob("**/*").scanSync("apps/viewer/dist")) {
  assets[`/${path}`] = readFileSync(join("apps/viewer/dist", path)).toString("base64");
}
const generated = "packages/cli/src/dev/viewer.gen.ts";
const STUB =
  "// Filled in by scripts/build-cli.ts for the compiled binary, then put back.\nexport const VIEWER: Record<string, string> = {};\n";
writeFileSync(generated, `export const VIEWER: Record<string, string> = ${JSON.stringify(assets)};\n`);

mkdirSync(out, { recursive: true });
const sums: string[] = [];
for (const [target, name] of TARGETS) {
  if (only && only !== target) continue;
  const path = join(out, name);
  const compile = Bun.spawnSync(
    ["bun", "build", "packages/cli/src/index.ts", "--compile", `--target=bun-${target}`, `--outfile=${path}`],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (!compile.success) process.exit(compile.exitCode ?? 1);
  sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}`);
  console.log(`built ${name}`);
}
writeFileSync(generated, STUB);
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
