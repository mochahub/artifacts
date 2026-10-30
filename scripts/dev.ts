// `bun run dev`: starts Postgres and SeaweedFS, then the server with watch, and Vite.
const compose = ["docker", "compose", "-f", "deploy/compose/docker-compose.dev.yml", "up", "-d", "--wait"];
const up = Bun.spawnSync(compose, { stdout: "ignore", stderr: "inherit" });
if (!up.success) process.exit(up.exitCode ?? 1);

const children = [
  Bun.spawn(["bun", "--env-file=.env.example", "--watch", "apps/server/src/index.ts"], {
    stdio: ["ignore", "inherit", "inherit"],
  }),
  Bun.spawn(["node_modules/.bin/vite"], { cwd: "apps/viewer", stdio: ["ignore", "inherit", "inherit"] }),
];

const stop = () => {
  for (const child of children) child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// If either exits, stop the other rather than leaving half a dev server running.
await Promise.race(children.map((child) => child.exited));
stop();
process.exit((await Promise.all(children.map((child) => child.exited)))[0]);
