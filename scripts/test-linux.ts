import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureHelper } from "../packages/cli/src/render/install.ts";

if (process.env.TEST_LINUX_RUNNER === "1") {
  process.env.ARTIFACTS_HELPER_DIR = join(tmpdir(), "artifacts-test-helper");
  ensureHelper({ say: console.log } as unknown as Parameters<typeof ensureHelper>[0]);
  const args = JSON.parse(process.env.TEST_LINUX_ARGS ?? "[]") as string[];
  // Browser-heavy CLI fixtures render at three scales and lint in fresh contexts.
  // Run files serially by default; callers can explicitly request Bun parallelism.
  const child = Bun.spawn(
    ["bun", "test", "--timeout=30000", ...(args.length ? args : ["apps", "packages"])],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  process.exit(await child.exited);
}

const results = mkdtempSync(join(tmpdir(), "artifacts-test-linux-"));
const project = `artifacts-test-${crypto.randomUUID().slice(0, 8)}`;
const compose = ["docker", "compose", "-p", project, "-f", "deploy/compose/docker-compose.test-linux.yml"];
const options = {
  cwd: resolve(import.meta.dir, ".."),
  env: {
    ...process.env,
    TEST_LINUX_RESULTS_DIR: results,
    TEST_LINUX_ARGS: JSON.stringify(process.argv.slice(2)),
  },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
} as const;
console.log(`Linux test results: ${results}`);
const child = Bun.spawn(
  [
    ...compose,
    "up",
    "--build",
    "--force-recreate",
    "--abort-on-container-exit",
    "--attach",
    "runner",
    "--exit-code-from",
    "runner",
  ],
  options,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
let code = 1;
try {
  code = await child.exited;
} finally {
  await Bun.spawn([...compose, "logs", "--no-color"], {
    ...options,
    stdout: Bun.file(join(results, "compose.log")),
    stdin: "ignore",
  }).exited;
  const cleanup = await Bun.spawn(
    [...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"],
    options,
  ).exited;
  if (cleanup !== 0) console.error(`Could not clean up compose project ${project}`);
}
process.exit(code);
