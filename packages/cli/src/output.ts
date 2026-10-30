/** A problem the user can act on: printed plainly, exit code 1 (07). */
export class CliError extends Error {
  override name = "CliError";
}

/** Wrong flags or arguments: exit code 2 (07). */
export class UsageError extends Error {
  override name = "UsageError";
}

export type Output = {
  json: boolean;
  /** Human progress: stdout normally, stderr with --json, so stdout stays machine-only. */
  say(line: string): void;
  warn(line: string): void;
  /** The result. With --json it's the only thing on stdout. */
  result(value: unknown, human: () => void): void;
};

export function createOutput(json: boolean): Output {
  return {
    json,
    say: (line) => (json ? console.error(line) : console.log(line)),
    warn: (line) => console.error(line),
    result(value, human) {
      if (json) console.log(JSON.stringify(value, null, 2));
      else human();
    },
  };
}
