---

name: artifacts
description: Publish plans, research, reports, mocks and prototypes for people to review, and act on their comments. Use when asked to publish or share work for review, to "address the comments", or to check on an artifact.
---

# Artifacts

Artifacts gives work a permanent link. People review it on a phone or desktop and pin comments to screens or passages. You read those comments, fix the work, publish again and reply.

## 1. Start with the status

If there's an `artifact.json` here or above, run this before anything else:

```
artifacts status --json
```

If changes were requested, read the note and the open comments first.

## 2. When to publish

Publish plans, research reports, mocks, comparisons and prototypes that someone should read or review. Don't publish throwaway output.

## 3. Structure

- One artifact per deliverable, with a page for each part: the plan as an article, research as articles grouped "Research", mocks as a canvas.
- Give every frame a stable `data-frame` id, and write stable headings. Comments attach to them, so never rename an id that has comments.
- `references/manifest.md` has the schema, with examples.

## 4. The kit

`artifacts init` copies device frames, theme tokens and article components into `vendor/artifacts-kit/`. See `references/kit.md`.

## 5. Writing

Follow `references/writing.md` for articles.

## 6. Micro apps

Use `@artifacts/kit/data` for anything that must persist, and add a backend only when the frontend store isn't enough. Keep a `schema` number in stored values, and provide fixtures. See `references/micro-apps.md`.

## 7. The gate

1. `artifacts lint`
2. `artifacts render`
3. **Look at the contact sheet:** read `.artifacts/contact-sheet.png`. This step isn't optional.
4. Fix what's wrong and repeat.

Publish only on a clean lint. `references/lint.md` explains every rule.

## 8. Addressing comments

When asked to "address the comments":

1. Run `artifacts comments --open --json`. Download each `crop` and look at it.
2. Fix the source.
3. Run `artifacts publish -m "<what changed>" --note <frame>=<what changed>`, with one `--note` for each changed frame.
4. For each thread you addressed, run `artifacts reply <n> "<what changed>" --fixed`.

Never resolve a person's thread; only people resolve. If a comment is ambiguous, reply with a question and leave the thread open.

## 9. Lifecycle

Archive finished artifacts when asked. Never delete without being asked, and never try to purge.

## 10. Report back

Say the URL, the version, what changed, and which threads you marked fixed.
