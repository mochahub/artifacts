// The starter templates, as text imports, because the CLI is one compiled binary and the MCP serves them.
// A test checks this against the folders.

import caseStudyArtifactJson from "./templates/case-study/artifact.json.txt" with { type: "text" };
import caseStudyBoardsCoverHtml from "./templates/case-study/boards/cover.html" with { type: "text" };
import caseStudyDocMd from "./templates/case-study/doc.md" with { type: "text" };
import caseStudyStyleCss from "./templates/case-study/style.css" with { type: "text" };
import designReviewArtifactJson from "./templates/design-review/artifact.json.txt" with { type: "text" };
import designReviewBoardsJourneyHtml from "./templates/design-review/boards/journey.html" with {
  type: "text",
};
import designReviewBoardsVariantsHtml from "./templates/design-review/boards/variants.html" with {
  type: "text",
};
import designReviewStyleCss from "./templates/design-review/style.css" with { type: "text" };
import prdArtifactJson from "./templates/prd/artifact.json.txt" with { type: "text" };
import prdBoardsCoverHtml from "./templates/prd/boards/cover.html" with { type: "text" };
import prdDocMd from "./templates/prd/doc.md" with { type: "text" };
import prdStyleCss from "./templates/prd/style.css" with { type: "text" };
import presentationArtifactJson from "./templates/presentation/artifact.json.txt" with { type: "text" };
import presentationBoardsDeckHtml from "./templates/presentation/boards/deck.html" with { type: "text" };
import presentationStyleCss from "./templates/presentation/style.css" with { type: "text" };
import researchReportArtifactJson from "./templates/research-report/artifact.json.txt" with { type: "text" };
import researchReportBoardsCoverHtml from "./templates/research-report/boards/cover.html" with {
  type: "text",
};
import researchReportDocMd from "./templates/research-report/doc.md" with { type: "text" };
import researchReportStyleCss from "./templates/research-report/style.css" with { type: "text" };
import rfcArtifactJson from "./templates/rfc/artifact.json.txt" with { type: "text" };
import rfcBoardsCoverHtml from "./templates/rfc/boards/cover.html" with { type: "text" };
import rfcDocMd from "./templates/rfc/doc.md" with { type: "text" };
import rfcStyleCss from "./templates/rfc/style.css" with { type: "text" };
import weeklyStatusArtifactJson from "./templates/weekly-status/artifact.json.txt" with { type: "text" };
import weeklyStatusBoardsCoverHtml from "./templates/weekly-status/boards/cover.html" with { type: "text" };
import weeklyStatusDocMd from "./templates/weekly-status/doc.md" with { type: "text" };
import weeklyStatusStyleCss from "./templates/weekly-status/style.css" with { type: "text" };

// Bun types an .html import as a page bundle, but `type: "text"` makes it a string.
export const TEMPLATES = {
  "design-review": {
    "artifact.json": designReviewArtifactJson,
    "boards/journey.html": designReviewBoardsJourneyHtml,
    "boards/variants.html": designReviewBoardsVariantsHtml,
    "style.css": designReviewStyleCss,
  },
  presentation: {
    "artifact.json": presentationArtifactJson,
    "boards/deck.html": presentationBoardsDeckHtml,
    "style.css": presentationStyleCss,
  },
  "case-study": {
    "artifact.json": caseStudyArtifactJson,
    "boards/cover.html": caseStudyBoardsCoverHtml,
    "doc.md": caseStudyDocMd,
    "style.css": caseStudyStyleCss,
  },
  prd: {
    "artifact.json": prdArtifactJson,
    "boards/cover.html": prdBoardsCoverHtml,
    "doc.md": prdDocMd,
    "style.css": prdStyleCss,
  },
  rfc: {
    "artifact.json": rfcArtifactJson,
    "boards/cover.html": rfcBoardsCoverHtml,
    "doc.md": rfcDocMd,
    "style.css": rfcStyleCss,
  },
  "research-report": {
    "artifact.json": researchReportArtifactJson,
    "boards/cover.html": researchReportBoardsCoverHtml,
    "doc.md": researchReportDocMd,
    "style.css": researchReportStyleCss,
  },
  "weekly-status": {
    "artifact.json": weeklyStatusArtifactJson,
    "boards/cover.html": weeklyStatusBoardsCoverHtml,
    "doc.md": weeklyStatusDocMd,
    "style.css": weeklyStatusStyleCss,
  },
} as unknown as Record<string, Record<string, string>>;

/** What a template's artifact.json says until someone writes their own. */
export const TEMPLATE_SUMMARY =
  "Replace this: say what this holds and why it mattered, in up to 280 characters.";
