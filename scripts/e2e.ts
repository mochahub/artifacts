// `bun run e2e`: starts the test stack, builds the viewer, runs Playwright in WebKit.
const run = (command: string[], cwd = ".") => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!result.success) process.exit(result.exitCode ?? 1);
};

run(["docker", "compose", "-f", "deploy/compose/docker-compose.test.yml", "up", "-d", "--wait"]);
run(["bun", "run", "--filter", "@artifacts/viewer", "build"]);
run(["bunx", "playwright", "test", ...process.argv.slice(2)], "apps/viewer");
