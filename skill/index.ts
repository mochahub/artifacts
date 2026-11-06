// The skill, as text imports: the CLI installs it from its one binary, and the MCP serves the references.

import brand from "./references/brand.md" with { type: "text" };
import kit from "./references/kit.md" with { type: "text" };
import lint from "./references/lint.md" with { type: "text" };
import manifest from "./references/manifest.md" with { type: "text" };
import microApps from "./references/micro-apps.md" with { type: "text" };
import stageshow from "./references/stageshow.md" with { type: "text" };
import templatesCaseStudy from "./references/templates/case-study.md" with { type: "text" };
import templatesDesignReview from "./references/templates/design-review.md" with { type: "text" };
import templatesPrd from "./references/templates/prd.md" with { type: "text" };
import templatesPresentation from "./references/templates/presentation.md" with { type: "text" };
import templatesResearchReport from "./references/templates/research-report.md" with { type: "text" };
import templatesRfc from "./references/templates/rfc.md" with { type: "text" };
import templatesWeeklyStatus from "./references/templates/weekly-status.md" with { type: "text" };
import theme from "./references/theme.md" with { type: "text" };
import writing from "./references/writing.md" with { type: "text" };
import skill from "./SKILL.md" with { type: "text" };

/** Every file in this folder that ships, by its path here. */
export const SKILL_FILES: Record<string, string> = {
  "SKILL.md": skill,
  "references/brand.md": brand,
  "references/kit.md": kit,
  "references/lint.md": lint,
  "references/manifest.md": manifest,
  "references/micro-apps.md": microApps,
  "references/stageshow.md": stageshow,
  "references/templates/case-study.md": templatesCaseStudy,
  "references/templates/design-review.md": templatesDesignReview,
  "references/templates/prd.md": templatesPrd,
  "references/templates/presentation.md": templatesPresentation,
  "references/templates/research-report.md": templatesResearchReport,
  "references/templates/rfc.md": templatesRfc,
  "references/templates/weekly-status.md": templatesWeeklyStatus,
  "references/theme.md": theme,
  "references/writing.md": writing,
};

/** The references, by name (`templates/prd`), as the MCP lists them for an agent with no skill installed. */
export const GUIDES: Record<string, string> = Object.fromEntries(
  Object.entries(SKILL_FILES).flatMap(([path, text]) => {
    const name = /^references\/(.+)\.md$/.exec(path)?.[1];
    return name ? [[name, text]] : [];
  }),
);
