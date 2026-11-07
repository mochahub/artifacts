import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILL_FILES } from "../../../../skill/index.ts";
import { home } from "../config.ts";
import type { Output } from "../output.ts";
import { VERSION } from "../version.ts";

const FILES: Record<string, string> = { ...SKILL_FILES, ".version": `${VERSION}\n` };

export const skillDirs = () => ({
  claude: join(home(), ".claude/skills/artifacts"),
  codex: join(process.env.CODEX_HOME ?? join(home(), ".codex"), "skills/artifacts"),
});

export function installSkill(targets: { claude?: boolean; codex?: boolean }, out: Output) {
  const dirs = skillDirs();
  const both = !targets.claude && !targets.codex;
  const chosen = [
    ...(targets.claude || both ? [dirs.claude] : []),
    ...(targets.codex || both ? [dirs.codex] : []),
  ];
  for (const dir of chosen) {
    for (const [path, content] of Object.entries(FILES)) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    out.say(`✓ ${dir}`);
  }
  return chosen;
}

export function skillCurrent(dir: string) {
  const marker = join(dir, ".version");
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === VERSION;
}
