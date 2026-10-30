# 05 · Publishing, rendering and storage

**Contract document** for the manifest schema, the render outputs, re-anchoring and clean-up. Endpoints are in [03-api.md](03-api.md#publishing-cli); tables and bucket prefixes in [02-data-model.md](02-data-model.md).

## The manifest (`artifact.json`)

Defined with zod in `packages/schema/manifest.ts`; `artifacts lint` reports schema errors with paths.

```ts
const Manifest = z.object({
  project: Slug,                 // a-z0-9-, 1–40, not reserved (06-viewer.md#routes)
  projectName: z.string().optional(),
  slug: Slug,
  title: z.string().min(1).max(120),
  visibility: z.enum(["me", "org"]).optional(),
  theme: z.object({
    accent: Hex.optional(), font: z.string().optional(),
    mode: z.enum(["light", "dark", "auto"]).default("auto"),
  }).optional(),
  backend: z.object({ src: RelPath }).optional(),            // Phase 2
  pages: z.array(Page).min(1),
});
const Page = z.discriminatedUnion("kind", [
  z.object({ id: Key, kind: z.literal("article"), src: RelPath, title: z.string().optional(), group: z.string().optional() }),
  z.object({ id: Key, kind: z.literal("canvas"), title: z.string().optional(), group: z.string().optional(),
    boards: z.array(z.object({ id: Key, title: z.string(), subtitle: z.string().optional(), src: RelPath })).min(1),
    styles: z.array(RelPath).default([]), scripts: z.array(RelPath).default([]) }),
  z.object({ id: Key, kind: z.literal("prototype"), src: RelPath, device: Device.default("iphone") }),   // Phase 2
  z.object({ id: Key, kind: z.literal("gallery"), title: z.string().optional(), items: z.array(z.object({ src: RelPath, caption: z.string().optional() })) }), // Phase 2
]);
// Key: a-z0-9-, 1–60. RelPath: relative, no "..", no leading "/", must exist.
```

**Fixtures** (SPEC §7.9) live next to the manifest: `fixtures/data.json` (`{ "shared": { key: value }, "me": { key: value } }`) and `fixtures/files/{shared,me}/<name>`.

## What gets uploaded

The bundle is:
- every file the manifest references
- everything those files reference by relative URL: `src`, `href`, CSS `url()`, `@import`, and JS `import` and `fetch` of literal relative paths
- the generated outputs below

Files are collected by a crawler that parses HTML (htmlparser2), CSS (postcss) and JS (es-module-lexer). Anything unreferenced isn't uploaded. Absolute URLs and paths outside the manifest's folder are lint errors.

| Output | Made by | Stored as |
|---|---|---|
| Source files (HTML, CSS, JS, images, fonts) | The author | `blobs/<sha256>`, with the path in `versions.files` |
| Images | `render` resizes over-budget images and converts them to WebP (AVIF where smaller) with sharp; the original path is kept and the content replaced | Blobs |
| Frame renders | Playwright WebKit (below) | `frames.renders` → blobs |
| Article HTML | The Markdown pipeline (below) | A blob; `pages.meta.htmlHash` |
| Backend module (Phase 2) | `bun build api/index.ts --target=browser --format=esm --minify` | A blob; `versions.backend_hash` |

## Rendering canvases (CLI, Playwright WebKit)

For each canvas page and each board:
1. **Build the board page.** Start from a minimal HTML shell, add the page's `styles` and `scripts`, then the board's HTML. A local static server rooted at the bundle (`http://127.0.0.1:<port>/`) serves it beside the board's own file, as `__board-<id>.html`, so the board's relative paths work. All other network requests are blocked (`page.route("**", …)`), so a missing file fails here rather than in the viewer.
2. **Make it deterministic:**
   - inject the fixtures in place of the data API (`window.__ARTIFACTS_FIXTURES__`)
   - freeze `Date` to `2026-01-01T09:41:00` local
   - seed `Math.random` from the board id
   - disable animations (`prefers-reduced-motion`, and a stylesheet that zeroes durations)
   - wait for `document.fonts.ready` and every image's `decode()`
3. **Capture frames.** For every element with `data-frame`, record its id, `data-device`, title (`data-title`, or the nearest heading) and its box on the board. Screenshot the element at device scale factors 1, 2 and 3 (one browser context per factor), plus a thumbnail (1x, max 320 px wide).
4. **Encode and hash.** Encode each image as WebP with sharp (quality 82, effort 4). `content_hash` is the SHA-256 of the 1x **raw RGBA pixels** (decoded from the PNG Playwright returns), not of any encoded file, so encoder differences can't change it.
5. **Check determinism.** For `lint`, the 1x render is taken twice in fresh contexts; differing pixels are a lint error (§9 of the spec).
6. **Live frames.** If `data-live` is set on a frame, or the page kind is `prototype`, record `live_path`. For canvas frames, `render` writes a standalone `__live-<frame>.html` beside the board's file, so its relative paths work (the content host's CSP forbids `<base>`). It loads the page's styles and scripts and just that frame, and is added to the bundle.

The **contact sheet** `.artifacts/contact-sheet.png` tiles every 1x render with its id, for the agent to look at before publishing (the skill requires it).

**OG image:** a 1200×630 composite of the first three frames (or the article title set in the kit's article type), as `__og.webp` in the bundle.

## Building articles (CLI)

Pipeline: unified, then `remark-parse`, `remark-gfm` and `remark-directive`. Custom plugins handle:
- **callouts:** `> [!NOTE]`
- **figures:** an image followed by an italic paragraph becomes `figure` with `figcaption`
- **verdict badges:** `{Verified}`, `{Unverified}`
- **`::frame{ref="mocks/onboarding/welcome"}`:** resolves to the frame's render hash in this version
- **`::chart{src="charts/x.json"}`:** `{ "type": "bar"|"line", "labels": [...], "series": [{ "name", "values": [...] }] }` drawn to SVG by the CLI at publish
- **Mermaid code blocks:** rendered to SVG in WebKit at publish

It then runs `remark-rehype`, `rehype-slug` and `rehype-sanitize`. Sanitizing uses an allowlist (no `script`, `style`, `iframe`, event attributes or `javascript:` URLs); **raw HTML in Markdown is dropped**.

**Block ids:**
- Each heading gets its slug.
- Each other top-level block (paragraph, list, table, figure, callout, code) gets `<heading slug>/p<n>`, counting from 1 under its heading (`intro/p<n>` before the first heading).
- Each block's `data-block` attribute is its id.
- Each block's `content_hash` is the SHA-256 of its normalized text (whitespace collapsed).
- `blocks.text` stores the plain text.

**The server re-sanitizes at commit.** The CLI's output can't be trusted (any token with `publish` could upload anything), and article HTML is inserted into the viewer's own page. So `commit` re-runs `rehype-sanitize` with the same allowlist (`@artifacts/schema/sanitize`) over every article's HTML blob, including inline SVG from Mermaid and charts (no `script`, `foreignObject`, `style` elements or attributes, or event attributes). Mermaid's styles are copied onto presentation attributes in the render helper, because a `<style>` in an article would apply to the whole viewer page. It stores the result as a new blob and records that hash in `pages.meta.htmlHash`. The viewer only ever loads that hash.

Images referenced by articles are bundle files; the viewer loads them through `GET /api/artifacts/:id/r/:hash`. The CLI rewrites `src` to `artifacts:blob/<hash>` and the viewer maps that.

## Publish protocol (CLI side)

1. **Gate.** Run `lint`, which renders, and stop on errors.
2. **Hash.** SHA-256 every bundle file and render.
3. **Prepare.** `POST /api/publish/prepare` with all `{ path, sha256, size, type }`. The response lists only missing hashes, each with a presigned PUT.
4. **Upload.** Upload missing blobs with 6 parallel PUTs, sending `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` as signed headers. Retry 3 times with backoff.
   Each PUT is signed with `If-None-Match: *`, so it can only create an object, never replace one. A 412 means the object already exists; the upload moves on, and commit decides whether its content is right.
5. **Commit.** `POST /api/publish/commit` with files, pages, frames, blocks, message, `--name`, `--note` and the detected agent. The server re-anchors threads and returns the summary.
6. **Report.** Print the result (format in [07-cli-and-skill.md](07-cli-and-skill.md#publish)). With `--json`, print the `PublishResult` as is.

**Agent detection:** `CLAUDECODE=1` means "Claude Code"; `CODEX_*` environment variables mean "Codex". `ARTIFACTS_AGENT` overrides it. Otherwise it's null, meaning a person published.

## Re-anchoring

The server runs this inside commit, for every thread with `status ≠ resolved` and an anchor on a page that exists in the new version:

**Canvas** (`anchor.type = frame`):
- frame key missing in the new version: `anchor_state = orphaned`, page-level from now on, with a link to view it in `created_version`
- content hash differs from the frame's hash in `created_version`: `updated` ("frame changed since this comment")
- otherwise: `ok`

**Article text** (`anchor.type = text`):
1. If the block exists and contains `quote.exact` exactly once, it's `ok` (or `updated` if the block's hash changed).
2. Else search all blocks of the page for `exact`, scoring matches by how much `prefix` and `suffix` match nearby text. Use the best match above a threshold of 0.6 (normalized), and **move** the anchor's `blockKey`, marking it `updated`.
3. Else `orphaned`.

**Article block** (`anchor.type = block`): treated like a canvas frame, keyed by `blockKey`.

**Restored and removed versions:**
- Restoring a version re-anchors exactly the same way.
- Removing a version moves threads made on it to the next live version, with `moved_from_version` set and their anchors re-checked against that version. The API reports `anchorState: moved_version` for them while the anchor is still fine. Purging the version deletes their crops and removes quoted text, because both show what was removed.

The change summary in `PublishResult` and `GET /compare` comes from comparing `content_hash` per frame key and block key between the two versions.

## Crops

When a canvas thread is created:
1. The server reads the frame's 2x render.
2. It cuts a 480×320 window centred on the pin (clamped to the frame), with sharp.
3. It draws the pin's position as a 6 px yellow ring.
4. It writes `crops/<thread id>.webp`.

Article threads have no crop; their quote is the context.

## Presigned URLs

- **Library:** `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, path-style, created with `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`. The SDK's default puts a checksum of an empty body into presigned PUT URLs, which some S3 servers reject (spike S3).
- **Endpoint:** `S3_ENDPOINT` (Railway's bucket endpoint, or SeaweedFS's).
- **GET URLs:** signed with the time rounded down to the UTC day and an expiry of 24 hours plus a margin, so URLs are stable within a day (03).
- **PUT URLs:** signed per request, valid 15 minutes, with `Content-Type`, `Content-Length`, `Cache-Control` and `If-None-Match: *` signed. The signed `Content-Type` is the declared one only for PNG, JPEG, GIF, WebP and AVIF; every other file is stored as `application/octet-stream`, because the viewer's `/r/<hash>` route and the bucket both send the stored type, and an author's page, script or SVG must not run from either. Live previews serve the manifest's type, so they don't change.
- **Verifying content:** the `blobs` table (02) lists hashes the server has checked. `prepare` calls a hash missing unless it has a row. `commit` downloads every referenced hash without a row, hashes it, and adds the row; a mismatch deletes the object and answers 400 `invalid`. Reading from the bucket is free, and each blob is only read once.

## Clean-up

A job in the app (`apps/server/src/jobs/`) runs daily, guarded by `pg_try_advisory_lock(<constant>)` so only one replica runs it:

1. **Purge expired deletions.** Artifacts with `purge_after < now()`, then removed versions with `purge_after < now()`. Artifact purge:
   - In one transaction, delete threads, comments, decisions, views, access, links, invites, versions, pages, frames, blocks and activity for the artifact.
   - Insert one `tombstones` row and one `purged` activity row.
   - Delete the `crops/<thread id>.webp` objects and every object under `data/<artifact id>/`.
2. **Collect garbage.**
   - **`blobs` rows** are deleted with their objects.
   - **Referenced set:** every hash in `versions.files`, `versions.backend_hash`, `frames.renders` and `pages.meta.htmlHash` of non-purged versions.
   - **Sweep:** list `blobs/` (paginated `ListObjectsV2`) and delete objects not in the set whose `LastModified` is more than 24 hours old. The age check protects uploads from a publish that hasn't committed yet.
   - **Log:** record counts and bytes freed.
3. **Expire leftovers:** `webauthn_challenges`, `device_codes`, used or expired `invites` and `reset_links` older than 30 days, and `backend_logs` older than 24 hours.

A manual trigger exists for testing and operators: `POST /internal/jobs/:name` on the internal port, with `OPS_SECRET`.
