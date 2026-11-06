#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ApiCallError } from "./client.ts";
import type { Options } from "./command.ts";
import { commandNamed, GLOBAL_OPTIONS, helpText, usageLine } from "./commands/table.ts";
import { KeychainBlocked } from "./credentials/index.ts";
import { CliError, createOutput, UsageError } from "./output.ts";
import { closePrompts } from "./prompt.ts";
import { VERSION } from "./version.ts";

/** Set once the arguments parse, so an API failure knows to print JSON. */
let json = false;

/** Where the command's name is: after any global flags, and a `--server <url>`, that come before it. */
function commandIndex(argv: string[]) {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--server") i += 2;
    else if (arg.startsWith("--server=")) i += 1;
    else if (["--json", "--help", "-h", "--version", "-v"].includes(arg)) i += 1;
    else break;
  }
  return i;
}

function parse(args: string[], options: Options) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function main(argv: string[]) {
  const at = commandIndex(argv);
  const name = argv[at];
  const entry = name === undefined || name.startsWith("-") ? undefined : commandNamed(name);
  if (!entry) {
    const { values, positionals } = parse(argv, { ...GLOBAL_OPTIONS, server: { type: "string" } });
    if (values.version) return console.log(VERSION);
    if (values.help || positionals.length === 0) return console.log(helpText(VERSION));
    throw new UsageError(`Unknown command "${positionals[0]}".\n\n${helpText(VERSION)}`);
  }
  const { values, positionals } = parse([...argv.slice(0, at), ...argv.slice(at + 1)], {
    ...GLOBAL_OPTIONS,
    ...entry.options,
  });
  if (values.version === true) return console.log(VERSION);
  if (values.help) return console.log(helpText(VERSION));
  json = values.json === true;
  const args = Object.fromEntries((entry.args ?? []).map((arg, i) => [arg, positionals[i]]));
  return entry.run(
    {
      args,
      rest: positionals,
      // parseArgs checked them against this command's own options, which is where its flags' types come from.
      flags: values as never,
      usage: (form) => new UsageError(usageLine(entry, form)),
    },
    createOutput(json),
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof ApiCallError && json) {
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
