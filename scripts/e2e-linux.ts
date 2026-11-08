import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Keep the browser and app on Linux loopback. Forwarding every browser connection through
// Docker Desktop to a host server can strand a reused client port's SYN before HTTP reaches the app.
if (process.env.E2E_LINUX_RUNNER === "1") {
  const args = JSON.parse(process.env.E2E_LINUX_ARGS ?? "[]") as string[];
  const child = Bun.spawn(["node", "node_modules/@playwright/test/cli.js", "test", ...args], {
    cwd: "apps/viewer",
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await child.exited);
}

const results = mkdtempSync(join(tmpdir(), "artifacts-e2e-linux-"));
const project = `artifacts-e2e-${crypto.randomUUID().slice(0, 8)}`;
const compose = ["docker", "compose", "-p", project, "-f", "deploy/compose/docker-compose.e2e-linux.yml"];
const options = {
  cwd: resolve(import.meta.dir, ".."),
  env: { ...process.env, E2E_RESULTS_DIR: results, E2E_LINUX_ARGS: JSON.stringify(process.argv.slice(2)) },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
} as const;
console.log(`Linux e2e results: ${results}`);
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
  const logs = Bun.spawn([...compose, "logs", "--no-color"], {
    ...options,
    stdout: Bun.file(join(results, "compose.log")),
    stdin: "ignore",
  });
  await logs.exited;
  const cleanup = Bun.spawn([...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"], options);
  if ((await cleanup.exited) !== 0) console.error(`Could not clean up compose project ${project}`);
}
process.exit(code);
