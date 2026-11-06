import { type Output, UsageError } from "./output.ts";

export type OptionSpec = { type: "string" | "boolean"; short?: string; multiple?: boolean };
export type Options = Record<string, OptionSpec>;

type Value<O extends OptionSpec> = O["type"] extends "string"
  ? O["multiple"] extends true
    ? string[]
    : string
  : boolean;
export type Flags<O extends Options> = { -readonly [K in keyof O]?: Value<O[K]> };

/** What a command gets: its positionals by name, all of them in order, its flags, and its usage line as an error. */
export type Input<A extends string = never, F = unknown> = {
  args: { [K in A]?: string };
  rest: string[];
  flags: F;
  usage(form?: number): UsageError;
};

export type Command<A extends string = string, O extends Options = Options> = {
  name: string;
  /** Each form after `artifacts `, as a usage error prints it. The first is the default. */
  usage: string | readonly string[];
  /** The lines in `artifacts --help`, when they aren't the first form; null for a command listed with another. */
  help?: readonly string[] | null;
  /** Positionals after the command's name, in order. */
  args?: readonly A[];
  options: O;
  run(input: Input<A, Flags<O> & { json?: boolean }>, out: Output): unknown;
};

/** Infers a command's positional names and flags from its own declaration. */
export const command = <const A extends string, const O extends Options>(spec: Command<A, O>) =>
  spec as unknown as Command;

/** `--port`. The content host and the bucket sit above it (+1, +253), so it must leave room. */
export function portOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65000) {
    throw new UsageError(`--port wants a number from 1 to 65000, not "${value}".`);
  }
  return port;
}
