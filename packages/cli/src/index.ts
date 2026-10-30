#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ApiCallError } from "./client.ts";
import { login, logout, recover, serverName, whoami } from "./commands/account.ts";
import { doctor } from "./commands/doctor.ts";
import { commentsCommand, replyCommand, statusCommand } from "./commands/review.ts";
import { setup } from "./commands/setup.ts";
import { initCommand, lintCommand, openCommand, publishCommand, renderCommand } from "./commands/write.ts";
import { normalizeUrl, pickServer } from "./config.ts";
import { CliError, createOutput, UsageError } from "./output.ts";
import { closePrompts } from "./prompt.ts";
import { installSkill } from "./skill/install.ts";
import { VERSION } from "./version.ts";

const USAGE = `artifacts ${VERSION}

  artifacts setup [<url>] [--docker] [--dir <path>]
  artifacts login [<url>] | logout | whoami
  artifacts recover <url>
  artifacts doctor
  artifacts init [--project <slug>] [--slug <slug>] [--kind canvas|article|prototype]
  artifacts lint | render
  artifacts publish [-m <message>] [--name <label>] [--note <frame>=<text>]
  artifacts open [<project>/<slug>] [--version <n>] [--page <key>]
  artifacts status [<project>/<slug>]
  artifacts comments [<project>/<slug>] [--open|--fixed|--all] [--page <key>]
  artifacts reply <n> "<text>" [--fixed]
  artifacts skill install [--claude] [--codex]

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
  project: { type: "string" },
  slug: { type: "string" },
  kind: { type: "string" },
  message: { type: "string", short: "m" },
  note: { type: "string", multiple: true },
  page: { type: "string" },
  open: { type: "boolean" },
  fixed: { type: "boolean" },
  all: { type: "boolean" },
  claude: { type: "boolean" },
  codex: { type: "boolean" },
  "no-skill": { type: "boolean" },
} as const;

/** `--version` is a boolean everywhere except `open --version <n>`, where it takes a number. */
function optionAfter(flag: string) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function main(argv: string[]) {
  let parsed: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    // Its number would otherwise be read as a positional.
    const args =
      argv[0] === "open"
        ? argv.filter((_, i) => argv[i - 1] !== "--version" && argv[i] !== "--version")
        : argv;
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true });
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
          skill: !values["no-skill"],
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
    case "status":
      return statusCommand(first, values.server, out);
    case "comments":
      return commentsCommand(
        first,
        { open: values.open, fixed: values.fixed, all: values.all, page: values.page, server: values.server },
        out,
      );
    case "reply":
      return replyCommand(first, positionals[2], { fixed: values.fixed, server: values.server }, out);
    case "skill": {
      if (first !== "install") throw new UsageError("Usage: artifacts skill install [--claude] [--codex]");
      const dirs = installSkill({ claude: values.claude, codex: values.codex }, out);
      return out.result({ installed: dirs }, () => {});
    }
    case "init":
      return initCommand({ project: values.project, slug: values.slug, kind: values.kind }, out);
    case "lint":
      return lintCommand(out);
    case "render":
      return renderCommand(out);
    case "publish":
      return publishCommand(
        { message: values.message, name: values.name, notes: values.note ?? [], server: values.server },
        out,
      );
    case "open":
      return openCommand(
        first,
        { version: optionAfter("--version"), page: values.page, server: values.server },
        out,
      );
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
