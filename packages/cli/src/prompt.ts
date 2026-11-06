import { createInterface } from "node:readline/promises";
import { PASSWORD_MIN } from "@artifacts/schema";
import { CliError } from "./output.ts";

/** Lines on stdin, shared so piped answers aren't lost between prompts. */
let lines: AsyncIterableIterator<string> | null = null;
function stdinLines() {
  lines ??= createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  return lines;
}

/** Stdin ended before a question got its answer: nobody is there to give one. */
class NoMoreInput extends CliError {}

export async function ask(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  const { value, done } = await stdinLines().next();
  if (done) throw new NoMoreInput(`Stopped at "${question}": there's nothing more to read.`);
  return (value as string).trim();
}

const stty = (arg: string) => {
  if (process.stdin.isTTY) Bun.spawnSync(["stty", arg], { stdin: "inherit" });
};

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

/** A yes or no. `enter` is the answer to an empty line, and `unattended` the answer when stdin has ended. */
export async function confirm(question: string, answers: { enter: boolean; unattended: boolean }) {
  let answer: string;
  try {
    answer = (await ask(`${question} ${answers.enter ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
  } catch (error) {
    if (error instanceof NoMoreInput) return answers.unattended;
    throw error;
  }
  return answer === "" ? answers.enter : answer === "y" || answer === "yes";
}

/** One of `choices`, asked again until it is one. Enter picks the first. */
export async function choose<T extends string>(question: string, choices: readonly T[]): Promise<T> {
  for (;;) {
    const answer = (await ask(`${question} [${choices.join("/")}]`)).toLowerCase();
    if (answer === "") return choices[0] as T;
    const chosen = choices.find((choice) => choice === answer);
    if (chosen) return chosen;
    console.error(`That isn't one of ${choices.join(", ")}.`);
  }
}

export async function askNewPassword() {
  for (;;) {
    const first = await askSecret(`Password (${PASSWORD_MIN} or more characters):`);
    if (first.length < PASSWORD_MIN) {
      console.error(`That's under ${PASSWORD_MIN} characters.`);
      continue;
    }
    if (first === (await askSecret("Again:"))) return first;
    console.error("Those didn't match.");
  }
}

export const closePrompts = () => lines?.return?.();
