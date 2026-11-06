/** Where everything lives in the bucket. 02 ("Bucket") owns these prefixes. */

export const BLOBS = "blobs/";
export const CROPS = "crops/";
export const PLANS = "plans/";
export const DATA = "data/";

/** Every bundle file, render, generated article and backend module, by content. */
export const blobKey = (hash: string) => `${BLOBS}${hash}`;
export const hashOf = (key: string) => key.slice(BLOBS.length);

export const cropKey = (threadId: string) => `${CROPS}${threadId}.webp`;

/** A connector's upload plan, kept out of tool results. */
export const planKey = (id: string) => `${PLANS}${id}.json`;

export type DataScope = "shared" | "me";

export const dataPrefix = (artifactId: string) => `${DATA}${artifactId}/`;

/**
 * A scope's values or its files: `shared/`, `me/`, `files/shared/` or `files/me/`. With `me`, one caller's
 * space inside `me/`, named by their pseudonym (08).
 */
export const dataScopePrefix = (
  artifactId: string,
  scope: DataScope,
  options: { files?: boolean; me?: string } = {},
) =>
  `${dataPrefix(artifactId)}${options.files ? "files/" : ""}${scope}/${scope === "me" && options.me ? `${options.me}/` : ""}`;

/** Which usage row an object under `data/<artifact id>/` counts against. */
export const usageScopeOf = (path: string): DataScope | "files" | null =>
  path.startsWith("shared/")
    ? "shared"
    : path.startsWith("me/")
      ? "me"
      : path.startsWith("files/")
        ? "files"
        : null;
