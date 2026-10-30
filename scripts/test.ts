// `bun run test`: starts the test stack, then runs every unit, data-model and API test.
import { tmpdir } from "node:os";

const compose = ["docker", "compose", "-f", "deploy/compose/docker-compose.test.yml"];

// Recreated each run: every bucket a test makes takes SeaweedFS volumes, and they run out after about 14 runs.
const up = Bun.spawnSync([...compose, "up", "-d", "--wait", "--force-recreate"], {
  stdout: "ignore",
  stderr: "inherit",
});
if (!up.success) process.exit(up.exitCode ?? 1);

const hits = `${tmpdir()}/artifacts-route-hits-${process.pid}`;
await Bun.write(hits, "");
const tests = Bun.spawnSync(
  ["bun", "test", "--timeout=30000", "apps", "packages", ...process.argv.slice(2)],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ARTIFACTS_ROUTE_HITS: hits },
  },
);
if (!tests.success) process.exit(tests.exitCode ?? 1);

// Only on a full run: a filtered run reaches some routes on purpose.
if (process.argv.length === 2) {
  const coverage = Bun.spawnSync(["bun", "scripts/route-coverage.ts", hits], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(coverage.exitCode ?? 1);
}
