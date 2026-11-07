/** Every address the viewer makes: its own pages, and the API's. public/sw.js copies a few (sw.test.ts). */

type Ref = { project: string; slug: string };

export const projectHref = (slug: string) => `/${slug}`;
export const teamHref = (slug: string) => `/settings/teams/${slug}`;
export const artifactHref = ({ project, slug }: Ref, page?: string | null) =>
  `/${project}/${slug}${page ? `/${page}` : ""}`;
/** Opens a page at one of its comments (06, "URL state"). */
export const threadHref = (ref: Ref, page: string, n: number) => `${artifactHref(ref, page)}?c=${n}`;
/** Opens a canvas page at one of its frames. */
export const frameHref = (ref: Ref, page: string | null, frame: string) =>
  `${artifactHref(ref, page)}#${frameHash(frame)}`;
export const compareHref = (ref: Ref, from: number, to: number) =>
  `${artifactHref(ref)}/compare?from=${from}&to=${to}`;

/** The address fragment for a focused frame. A frame id is whatever the author wrote in data-frame. */
export const frameHash = (key: string) => `frame=${encodeURIComponent(key)}`;

/** The frame a fragment names, or null. Reads what frameHash wrote, and old links with a plain id. */
export function frameFromHash(hash: string): string | null {
  const found = /(?:^#|&)frame=([^&]*)/.exec(hash);
  if (!found) return null;
  try {
    return decodeURIComponent(found[1] as string) || null;
  } catch {
    return null;
  }
}

/**
 * Only same-site paths, so a crafted link can't send someone elsewhere after signing in. Browsers drop
 * tabs and line breaks from a URL, so "/<tab>/evil.test" would mean "//evil.test": whitespace is refused.
 */
export function safeNext(value: string | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value) ? value : "/";
}

export const signInHref = (next: string) => `/sign-in?next=${encodeURIComponent(next)}`;

/** A round trip through Google. It's a link: CSP stops a form leaving the site (03). */
export const googleStart = (intent: string, params: Record<string, string>) =>
  `/api/auth/google/start?intent=${intent}${Object.entries(params)
    .map(([name, value]) => `&${name}=${encodeURIComponent(value)}`)
    .join("")}`;

export const artifactApi = ({ project, slug }: Ref) =>
  `/api/artifacts/by-slug/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`;
export const renderUrl = (artifactId: string, hash: string) => `/api/artifacts/${artifactId}/r/${hash}`;
export const articleUrl = (artifactId: string, version: number, page: string) =>
  `/api/artifacts/${artifactId}/v/${version}/article/${page}`;
