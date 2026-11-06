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
// Built in, without touching the tracked file: the build reads this table in its place.
const viewer: Bun.BunPlugin = {
  name: "viewer",
  setup(build) {
    build.onLoad({ filter: /dev\/viewer\.gen\.ts$/ }, () => ({
      contents: `export const VIEWER: Record<string, string> = ${JSON.stringify(assets)};\n`,
      loader: "ts",
    }));
  },
};

mkdirSync(out, { recursive: true });
const sums: string[] = [];
for (const [target, name] of TARGETS) {
  if (only && only !== target) continue;
  const path = join(out, name);
  const built = await Bun.build({
    entrypoints: ["packages/cli/src/index.ts"],
    compile: {
      target: `bun-${target}` as Bun.Build.CompileTarget,
      outfile: path,
      // The folder a person runs the CLI in isn't configuration. A repo's .env could point it elsewhere.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    plugins: [viewer],
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
  sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}`);
  console.log(`built ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
