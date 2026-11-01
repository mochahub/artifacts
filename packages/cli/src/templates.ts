// The templates, as text imports, because the CLI is one compiled binary. A test checks this against the folders.

import caseStudyArtifactJson from "../../kit/src/templates/case-study/artifact.json.txt" with {
  type: "text",
};
import caseStudyBoardsCoverHtml from "../../kit/src/templates/case-study/boards/cover.html" with {
  type: "text",
};
import caseStudyDocMd from "../../kit/src/templates/case-study/doc.md" with { type: "text" };
import caseStudyStyleCss from "../../kit/src/templates/case-study/style.css" with { type: "text" };
import designReviewArtifactJson from "../../kit/src/templates/design-review/artifact.json.txt" with {
  type: "text",
};
import designReviewBoardsJourneyHtml from "../../kit/src/templates/design-review/boards/journey.html" with {
  type: "text",
};
import designReviewBoardsVariantsHtml from "../../kit/src/templates/design-review/boards/variants.html" with {
  type: "text",
};
import designReviewStyleCss from "../../kit/src/templates/design-review/style.css" with { type: "text" };
import prdArtifactJson from "../../kit/src/templates/prd/artifact.json.txt" with { type: "text" };
import prdBoardsCoverHtml from "../../kit/src/templates/prd/boards/cover.html" with { type: "text" };
import prdDocMd from "../../kit/src/templates/prd/doc.md" with { type: "text" };
import prdStyleCss from "../../kit/src/templates/prd/style.css" with { type: "text" };
import presentationArtifactJson from "../../kit/src/templates/presentation/artifact.json.txt" with {
  type: "text",
};
import presentationBoardsDeckHtml from "../../kit/src/templates/presentation/boards/deck.html" with {
  type: "text",
};
import presentationStyleCss from "../../kit/src/templates/presentation/style.css" with { type: "text" };
import researchReportArtifactJson from "../../kit/src/templates/research-report/artifact.json.txt" with {
  type: "text",
};
import researchReportBoardsCoverHtml from "../../kit/src/templates/research-report/boards/cover.html" with {
  type: "text",
};
import researchReportDocMd from "../../kit/src/templates/research-report/doc.md" with { type: "text" };
import researchReportStyleCss from "../../kit/src/templates/research-report/style.css" with { type: "text" };
import rfcArtifactJson from "../../kit/src/templates/rfc/artifact.json.txt" with { type: "text" };
import rfcBoardsCoverHtml from "../../kit/src/templates/rfc/boards/cover.html" with { type: "text" };
import rfcDocMd from "../../kit/src/templates/rfc/doc.md" with { type: "text" };
import rfcStyleCss from "../../kit/src/templates/rfc/style.css" with { type: "text" };
import weeklyStatusArtifactJson from "../../kit/src/templates/weekly-status/artifact.json.txt" with {
  type: "text",
};
import weeklyStatusBoardsCoverHtml from "../../kit/src/templates/weekly-status/boards/cover.html" with {
  type: "text",
};
import weeklyStatusDocMd from "../../kit/src/templates/weekly-status/doc.md" with { type: "text" };
import weeklyStatusStyleCss from "../../kit/src/templates/weekly-status/style.css" with { type: "text" };

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
