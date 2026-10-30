#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ApiCallError } from "./client.ts";
import { login, logout, recover, serverName, whoami } from "./commands/account.ts";
import { doctor } from "./commands/doctor.ts";
import { setup } from "./commands/setup.ts";
import { normalizeUrl, pickServer } from "./config.ts";
import { CliError, createOutput, UsageError } from "./output.ts";
import { closePrompts } from "./prompt.ts";
import { VERSION } from "./version.ts";

const USAGE = `artifacts ${VERSION}

  artifacts setup [<url>] [--docker] [--dir <path>]
  artifacts login [<url>] | logout | whoami
  artifacts recover <url>
  artifacts doctor

Every command takes --json and --server <url|name>.`;

const OPTIONS = {
  json: { type: "boolean" },
  server: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  docker: { type: "boolean" },
  dir: { type: "string" },
  image: { type: "string" },
  port: { type: "string" },
  org: { type: "string" },
  name: { type: "string" },
  email: { type: "string" },
} as const;

async function main(argv: string[]) {
  let parsed: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const out = createOutput(values.json ?? false);
  const [command, first] = positionals;

  if (values.version) return console.log(VERSION);
  if (values.help || !command) return console.log(USAGE);

  switch (command) {
    case "setup":
      return setup(
        first,
        {
          docker: values.docker,
          dir: values.dir,
          image: values.image,
          port: values.port ? Number(values.port) : undefined,
          org: values.org,
          name: values.name,
          email: values.email,
        },
        out,
      );
    case "login": {
      const url = first ? normalizeUrl(first) : pickServer(values.server);
      const person = await login(url, out);
      return out.result({ server: url, person }, () =>
        out.say(`Signed in to ${serverName(url)} as ${person.name}.`),
      );
    }
    case "logout":
      return logout(values.server, out);
    case "whoami":
      return whoami(values.server, out);
    case "recover":
      if (!first) throw new UsageError("Usage: artifacts recover <url>");
      return recover(first, values.email, out);
    case "doctor":
      return doctor(values.server, out);
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof ApiCallError && process.argv.includes("--json")) {
    console.error(JSON.stringify({ error: error.failure }));
    process.exitCode = 1;
  } else if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closePrompts();
}
