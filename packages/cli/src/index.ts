#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ApiCallError } from "./client.ts";
import { login, logout, recover, serverName, whoami } from "./commands/account.ts";
import { brandCommand } from "./commands/brand.ts";
import { dataCommand, logsCommand } from "./commands/data.ts";
import { devCommand } from "./commands/dev.ts";
import { doctor } from "./commands/doctor.ts";
import {
  exportCommand,
  listCommand,
  pullCommand,
  readCommand,
  searchCommand,
  viewCommand,
} from "./commands/library.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { domainCommand, upgradeCommand } from "./commands/operate.ts";
import { orgCommand, shareCommand, visibilityCommand } from "./commands/people.ts";
import {
  archiveCommand,
  commentsCommand,
  deleteCommand,
  diffCommand,
  replyCommand,
  restoreCommand,
  statusCommand,
  undeleteCommand,
  versionsCommand,
} from "./commands/review.ts";
import { setup } from "./commands/setup.ts";
import { initCommand, lintCommand, openCommand, publishCommand, renderCommand } from "./commands/write.ts";
import { normalizeUrl, pickServer } from "./config.ts";
import { KeychainBlocked } from "./credentials/index.ts";
import { CliError, createOutput, UsageError } from "./output.ts";
import { closePrompts } from "./prompt.ts";
import { installSkill } from "./skill/install.ts";
import { VERSION } from "./version.ts";

const USAGE = `artifacts ${VERSION}

  artifacts setup [<url>] [--docker [--dir <path>] [--image <ref>] [--port <n>]]
                  [--org <name>] [--name <you>] [--email <you>] [--no-skill]
  artifacts login [<url>] | logout | whoami
  artifacts recover <url>
  artifacts doctor
  artifacts upgrade [--server] [--to <version>]
  artifacts domain add <domain> | list
  artifacts init [--project <slug>] [--slug <slug>] [--kind canvas|article|prototype]
                 [--template <name>] [--in-repo]
  artifacts lint | render [<slug>]
  artifacts publish [<slug>] [-m <message>] [--name <label>] [--note <frame>=<text>]
  artifacts search <words> [--project <slug>] [--repo <remote>] [--here] [--limit <n>] [--cursor <c>]
  artifacts list [<project>[/<slug>[/<page>]]] [--repo <remote>] [--here] [--limit <n>] [--cursor <c>]
  artifacts read <project>/<slug> [--page <key>] [--version <n>] [--cursor <c>] [--chars <n>]
  artifacts view <project>/<slug> [--page <key>] [--frame <key>] [--size thumb|1x|2x] [--out <file>]
  artifacts pull <project>/<slug> [--version <n>] [--dir <path>] [--force]
  artifacts export <project> [--dir <path>]
  artifacts brand [show] | prompt | preview <file> | propose <file>
  artifacts open [<project>/<slug>] [--version <n>] [--page <key>]
  artifacts status [<project>/<slug>]
  artifacts comments [<project>/<slug>] [--open|--fixed|--all] [--page <key>]
  artifacts reply <n> "<text>" [--fixed]
  artifacts skill install [--claude] [--codex]
  artifacts org invite <email> [--role member|reviewer|admin] | org reset-link <email>
  artifacts dev [--port 4321]
  artifacts mcp
  artifacts data ls | get <key> | export | clear [--scope shared|me]
  artifacts logs [--follow] [--version <n>]
  artifacts visibility org|me
  artifacts versions | versions name <n> "<label>" | diff <a> <b> | restore <n>
  artifacts archive [<project>/<slug>] [--undo]
  artifacts delete | undelete [<project>/<slug>] [--version <n>]
  artifacts share --link [--comment] [--expires 1d|7d|30d]
  artifacts share --invite <email> [--comment|--publish]

Every command takes --json. Commands that talk to a server take --server <url|name>
(on upgrade, --server means "the server too", and it can't name one).`;

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
  role: { type: "string" },
  follow: { type: "boolean" },
  scope: { type: "string" },
  to: { type: "string" },
  undo: { type: "boolean" },
  link: { type: "boolean" },
  invite: { type: "string" },
  comment: { type: "boolean" },
  publish: { type: "boolean" },
  expires: { type: "string" },
  claude: { type: "boolean" },
  codex: { type: "boolean" },
  "no-skill": { type: "boolean" },
  "in-repo": { type: "boolean" },
  template: { type: "string" },
  repo: { type: "string" },
  here: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  chars: { type: "string" },
  frame: { type: "string" },
  size: { type: "string" },
  out: { type: "string" },
  force: { type: "boolean" },
} as const;

/** `--version` is a boolean everywhere except `open --version <n>`, where it takes a number. */
function optionAfter(flag: string) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** A port number. The content host and the bucket sit above it (+1, +253), so it must leave room. */
function portOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65000) {
    throw new UsageError(`--port wants a number from 1 to 65000, not "${value}".`);
  }
  return port;
}

/** `upgrade --server` is a flag, unlike `--server <url>` everywhere else. */
const optionFlag = (flag: string) => process.argv.includes(flag);
const serverValue = () => undefined;

async function main(argv: string[]) {
  let parsed: ReturnType<
    typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    // Its number would otherwise be read as a positional.
    const isUpgrade = argv[0] === "upgrade";
    const takesVersion = ["open", "delete", "undelete", "logs", "read", "view", "pull"].includes(
      argv[0] ?? "",
    );
    const args = takesVersion
      ? argv.filter((_, i) => argv[i - 1] !== "--version" && argv[i] !== "--version")
      : argv;
    parsed = parseArgs({
      args: isUpgrade ? args.filter((arg) => arg !== "--server") : args,
      options: OPTIONS,
      allowPositionals: true,
    });
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
          port: portOption(values.port),
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
    case "data":
      return dataCommand(first, positionals[2], { scope: values.scope, server: values.server }, out);
    case "logs":
      return logsCommand(
        { follow: values.follow, version: optionAfter("--version"), server: values.server },
        out,
      );
    case "mcp":
      return mcpCommand();
    case "dev":
      return devCommand({ port: portOption(values.port) ?? 4321 }, out);
    case "versions":
      return versionsCommand(first, positionals.slice(2), { server: values.server }, out);
    case "diff":
      return diffCommand(first, positionals[2], { server: values.server }, out);
    case "restore":
      return restoreCommand(first, { server: values.server }, out);
    case "archive":
      return archiveCommand(first, { undo: values.undo, server: values.server }, out);
    case "delete":
      return deleteCommand(first, { version: optionAfter("--version"), server: values.server }, out);
    case "undelete":
      return undeleteCommand(first, { version: optionAfter("--version"), server: values.server }, out);
    case "upgrade":
      return upgradeCommand({ server: optionFlag("--server"), to: values.to, target: serverValue() }, out);
    case "domain":
      return domainCommand(first, positionals[2], { target: values.server }, out);
    case "org":
      return orgCommand(first, positionals[2], { role: values.role, server: values.server }, out);
    case "visibility":
      return visibilityCommand(first, positionals[2], values.server, out);
    case "share":
      return shareCommand(
        first,
        {
          link: values.link,
          invite: values.invite,
          comment: values.comment,
          publish: values.publish,
          expires: values.expires,
          server: values.server,
        },
        out,
      );
    case "init":
      return initCommand(
        {
          project: values.project,
          slug: values.slug,
          kind: values.kind,
          template: values.template,
          inRepo: values["in-repo"],
        },
        out,
      );
    case "lint":
      return lintCommand(first, out);
    case "render":
      return renderCommand(first, out);
    case "publish":
      return publishCommand(
        first,
        { message: values.message, name: values.name, notes: values.note ?? [], server: values.server },
        out,
      );
    case "search":
      return searchCommand(
        positionals.slice(1).join(" "),
        {
          project: values.project,
          repo: values.repo,
          here: values.here,
          limit: values.limit,
          cursor: values.cursor,
          server: values.server,
        },
        out,
      );
    case "list":
      return listCommand(
        first,
        {
          repo: values.repo,
          here: values.here,
          limit: values.limit,
          cursor: values.cursor,
          server: values.server,
        },
        out,
      );
    case "read":
      return readCommand(
        first,
        {
          page: values.page,
          version: optionAfter("--version"),
          cursor: values.cursor,
          chars: values.chars,
          server: values.server,
        },
        out,
      );
    case "view":
      return viewCommand(
        first,
        {
          page: values.page,
          frame: values.frame,
          size: values.size,
          version: optionAfter("--version"),
          out: values.out,
          server: values.server,
        },
        out,
      );
    case "pull":
      return pullCommand(
        first,
        { version: optionAfter("--version"), dir: values.dir, force: values.force, server: values.server },
        out,
      );
    case "brand":
      return brandCommand(first, positionals[2], { server: values.server }, out);
    case "export":
      return exportCommand(first, { dir: values.dir, server: values.server }, out);
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
  } else if (error instanceof KeychainBlocked) {
    console.error(error.message);
    // The dialog still holds a thread open, so the process wouldn't end by itself.
    process.exit(1);
  } else if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closePrompts();
}
