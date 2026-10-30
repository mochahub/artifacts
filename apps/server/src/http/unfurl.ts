import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Deps } from "../api/deps.ts";
import { sha256 } from "../auth/secrets.ts";
import { findOrg } from "../db/index.ts";
import { artifacts, shareLinks } from "../db/schema.ts";

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
  if (token && current?.settings.linkSharing) {
    const [row] = await deps.db
      .select({ link: shareLinks, artifact: artifacts })
      .from(shareLinks)
      .innerJoin(artifacts, eq(artifacts.id, shareLinks.artifactId))
      .where(and(eq(shareLinks.orgId, current.id), eq(shareLinks.tokenHash, sha256(token))))
      .limit(1);
    const live =
      row &&
      !row.link.revokedAt &&
      !row.artifact.deletedAt &&
      !(row.link.expiresAt && row.link.expiresAt <= deps.clock.now());
    if (live) {
      const url = `${deps.env.publicUrl}/api/s/${encodeURIComponent(token)}/cover`;
      tags[1] = `<meta property="og:title" content="${attribute(row.artifact.title)}" />`;
      tags.push(
        `<meta property="og:image" content="${attribute(url)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
      );
    }
  }
  return html.replace("</head>", `${tags.join("")}</head>`);
}
