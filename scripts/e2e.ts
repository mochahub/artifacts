// `bun run e2e`: starts the test stack, builds the viewer, runs Playwright in WebKit.
// Its addresses are apps/viewer/e2e/stack.ts's defaults; a stack of your own sets E2E_PORT, E2E_DATABASE_URL
// and E2E_S3_ENDPOINT and runs Playwright itself, since this recreates the shared one.
const run = (command: string[], cwd = ".") => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!result.success) process.exit(result.exitCode ?? 1);
};

// Recreated so each run starts unclaimed: storage is tmpfs, and the first test claims the server.
run([
  "docker",
  "compose",
  "-f",
  "deploy/compose/docker-compose.test.yml",
  "up",
  "-d",
  "--wait",
  "--force-recreate",
]);
run(["bun", "run", "--filter", "@artifacts/viewer", "build"]);
run(["bunx", "playwright", "test", ...process.argv.slice(2)], "apps/viewer");
