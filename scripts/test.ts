// `bun run test`: starts the test stack, then runs every unit, data-model and API test.
const compose = ["docker", "compose", "-f", "deploy/compose/docker-compose.test.yml"];

// Recreated each run: every bucket a test makes takes SeaweedFS volumes, and they run out after about 14 runs.
const up = Bun.spawnSync([...compose, "up", "-d", "--wait", "--force-recreate"], {
  stdout: "ignore",
  stderr: "inherit",
});
if (!up.success) process.exit(up.exitCode ?? 1);

const tests = Bun.spawnSync(
  ["bun", "test", "--timeout=30000", "apps", "packages", ...process.argv.slice(2)],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(tests.exitCode ?? 1);
