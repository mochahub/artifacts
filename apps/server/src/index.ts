import { EnvError, parseEnv } from "./env.ts";
import { createLogger } from "./log.ts";
import { startServer } from "./server.ts";

try {
  const { env, warnings } = parseEnv(process.env);
  const log = createLogger(env.logLevel);
  for (const warning of warnings) log.warn(warning);

  const server = await startServer(env, { log });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log.info("shutting down", { signal });
      server.stop().then(() => process.exit(0));
    });
  }
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(`The environment isn't valid:\n${error.message}`);
  process.exit(1);
}
