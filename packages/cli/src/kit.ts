import article from "../../kit/src/article.css" with { type: "text" };
import backend from "../../kit/src/backend.js" with { type: "text" };
import components from "../../kit/src/components.css" with { type: "text" };
import data from "../../kit/src/data.js" with { type: "text" };
import frames from "../../kit/src/frames/index.js" with { type: "text" };
import icons from "../../kit/src/icons.js" with { type: "text" };
import tokens from "../../kit/src/tokens.css" with { type: "text" };
import { KIT_DIR } from "./bundle/layout.ts";
import { VERSION } from "./version.ts";

/** The kit, as `init` copies it: pinned to this CLI's version, so a bundle stays self-contained (07). */
export const kitFiles = (): Record<string, string> => ({
  [`${KIT_DIR}/frames.js`]: frames,
  [`${KIT_DIR}/data.js`]: data,
  [`${KIT_DIR}/backend.js`]: backend,
  [`${KIT_DIR}/icons.js`]: icons,
  [`${KIT_DIR}/tokens.css`]: tokens,
  [`${KIT_DIR}/components.css`]: components,
  [`${KIT_DIR}/article.css`]: article,
  [`${KIT_DIR}/VERSION`]: `${VERSION}\n`,
});

/** What `init --kind` starts a page with. */
export const STARTERS = {
  canvas: {
    page: (id: string) => ({
      id,
      kind: "canvas",
      boards: [{ id: "main", title: "Main", src: "boards/main.html" }],
      styles: [`${KIT_DIR}/tokens.css`],
      scripts: [`${KIT_DIR}/frames.js`],
    }),
    file: "boards/main.html",
    body: `<a-phone data-frame="welcome" data-title="Welcome">
  <main class="art-safe" style="padding-inline:20px">
    <h1 class="art-title">Welcome</h1>
  </main>
</a-phone>
`,
  },
  article: {
    page: (id: string) => ({ id, kind: "article", src: "README.md" }),
    file: "README.md",
    body: "# Title\n\nWrite the plan here.\n",
  },
  prototype: {
    page: (id: string) => ({ id, kind: "prototype", src: "index.html" }),
    file: "index.html",
    body: "<!doctype html>\n<title>Prototype</title>\n<h1>Prototype</h1>\n",
  },
} as const;
