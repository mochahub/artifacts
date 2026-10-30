import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import kit from "../../../../skill/references/kit.md" with { type: "text" };
import lint from "../../../../skill/references/lint.md" with { type: "text" };
import manifest from "../../../../skill/references/manifest.md" with { type: "text" };
import microApps from "../../../../skill/references/micro-apps.md" with { type: "text" };
import writing from "../../../../skill/references/writing.md" with { type: "text" };
import skill from "../../../../skill/SKILL.md" with { type: "text" };
import { home } from "../config.ts";
import type { Output } from "../output.ts";
import { VERSION } from "../version.ts";

const FILES: Record<string, string> = {
  "SKILL.md": skill,
  "references/kit.md": kit,
  "references/lint.md": lint,
  "references/manifest.md": manifest,
  "references/micro-apps.md": microApps,
  "references/writing.md": writing,
  ".version": `${VERSION}\n`,
};

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

/** Installed, and from this CLI? */
export function skillCurrent(dir: string) {
  const marker = join(dir, ".version");
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === VERSION;
}
