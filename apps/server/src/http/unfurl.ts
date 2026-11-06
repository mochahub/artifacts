import type { Context } from "hono";
import { findLiveLink } from "../auth/links.ts";
import { findOrg } from "../db/index.ts";
import type { Deps } from "../deps.ts";

const attribute = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Link previews read the HTML with no cookie, so a preview shows what the link itself lets a stranger
 * see. A share link names its artifact and has a cover. Any other link looks the same as any other, so
 * pasting a private artifact's address into a chat gives nothing away (SPEC §5.3).
 */
export async function unfurl(c: Context, deps: Deps, html: string) {
  const token = /^\/s\/([^/]+)$/.exec(c.req.path)?.[1];
  const current = await findOrg(deps.db);
  const site = current?.name ?? "Artifacts";
  const tags = [
    `<meta property="og:site_name" content="${attribute(site)}" />`,
    `<meta property="og:title" content="${attribute(site)}" />`,
  ];
  const live = token && current ? await findLiveLink(deps, current, token) : null;
  if (token && live) {
    const url = `${deps.env.publicUrl}/api/s/${encodeURIComponent(token)}/cover`;
    tags[1] = `<meta property="og:title" content="${attribute(live.artifact.title)}" />`;
    tags.push(
      `<meta property="og:image" content="${attribute(url)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
    );
  }
  return html.replace("</head>", () => `${tags.join("")}</head>`);
}
