import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_RULES } from "../bundle/layout.ts";
import type { Problem } from "./problem.ts";

type Rule = { id: string; severity: Problem["severity"]; check(ctx: unknown): string[] | Promise<string[]> };

/** Project-specific rules from lint.rules.js beside the manifest (07). */
export async function projectRules(root: string, manifest: unknown): Promise<Problem[]> {
  const path = join(root, PROJECT_RULES);
  if (!existsSync(path)) return [];
  const { default: rules } = (await import(path)) as { default: Rule[] };
  const problems: Problem[] = [];
  for (const rule of rules) {
    for (const message of await rule.check({ root, manifest })) {
      problems.push({ rule: rule.id, severity: rule.severity, message });
    }
  }
  return problems;
}
