import type { Output } from "../output.ts";

/** One lint finding (07): a rule id, how bad it is, and what to do about it. */
export type Problem = { rule: string; severity: "error" | "warning"; message: string; file?: string };

export const hasErrors = (problems: Problem[]) => problems.some((problem) => problem.severity === "error");

export function printProblems(problems: Problem[], out: Output) {
  for (const problem of problems) {
    out.warn(`${problem.severity === "error" ? "✗" : "!"} ${problem.rule}  ${problem.message}`);
  }
}
