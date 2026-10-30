import { createInterface } from "node:readline/promises";
import { CliError } from "./output.ts";

/** Lines on stdin, shared so piped answers aren't lost between prompts. */
let lines: AsyncIterableIterator<string> | null = null;
function stdinLines() {
  lines ??= createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  return lines;
}

export async function ask(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  const { value, done } = await stdinLines().next();
  if (done) throw new CliError(`Stopped at "${question}": there's nothing more to read.`);
  return (value as string).trim();
}

const stty = (arg: string) => {
  if (process.stdin.isTTY) Bun.spawnSync(["stty", arg], { stdin: "inherit" });
};

/** Reads without echoing it. */
export async function askSecret(question: string): Promise<string> {
  stty("-echo");
  // Ctrl-C at a password prompt would otherwise leave the person's terminal not echoing what they type.
  const interrupted = () => {
    stty("echo");
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  try {
    return await ask(question);
  } finally {
    process.off("SIGINT", interrupted);
    stty("echo");
    if (process.stdin.isTTY) process.stderr.write("\n");
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [Y/n]`)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

export const closePrompts = () => lines?.return?.();
