// `bun run e2e`: starts the test stack, builds the viewer, runs Playwright in WebKit.
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
