import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import kit from "../../../../skill/references/kit.md" with { type: "text" };
import lint from "../../../../skill/references/lint.md" with { type: "text" };
import manifest from "../../../../skill/references/manifest.md" with { type: "text" };
import microApps from "../../../../skill/references/micro-apps.md" with { type: "text" };
import templateCaseStudy from "../../../../skill/references/templates/case-study.md" with { type: "text" };
import templateDesignReview from "../../../../skill/references/templates/design-review.md" with {
  type: "text",
};
import templatePrd from "../../../../skill/references/templates/prd.md" with { type: "text" };
import templatePresentation from "../../../../skill/references/templates/presentation.md" with {
  type: "text",
};
import templateResearchReport from "../../../../skill/references/templates/research-report.md" with {
  type: "text",
};
import templateRfc from "../../../../skill/references/templates/rfc.md" with { type: "text" };
import templateWeeklyStatus from "../../../../skill/references/templates/weekly-status.md" with {
  type: "text",
};
import theme from "../../../../skill/references/theme.md" with { type: "text" };
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
  "references/theme.md": theme,
  "references/templates/design-review.md": templateDesignReview,
  "references/templates/presentation.md": templatePresentation,
  "references/templates/case-study.md": templateCaseStudy,
  "references/templates/prd.md": templatePrd,
  "references/templates/rfc.md": templateRfc,
  "references/templates/research-report.md": templateResearchReport,
  "references/templates/weekly-status.md": templateWeeklyStatus,
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
