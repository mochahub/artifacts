import { expect, test } from "bun:test";
import type { BoardRenders } from "@artifacts/schema/boards";
import { captureVersion } from "./capture.ts";

// A canvas stand-in isolates ticket/attachment semantics; real browser coverage lives in e2e.
test("version capture uses the fenced ticket and retains existing immutable thumbnail for new crops", async () => {
  const fetchBefore = globalThis.fetch;
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const image = { hash: "a".repeat(64), type: "image/png" as const, bytes: 1, width: 1200, height: 630 };
  const existing: BoardRenders = { thumbnail: image, crops: [] };
  const context = new Proxy({}, { get: () => () => {} });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => context,
        toBlob: (done: (blob: Blob) => void) => done(new Blob(["picture"])),
      }),
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path, body });
    if (path.endsWith("/captures"))
      return Response.json({
        ticket: "fenced",
        snapshot: { schema: 1, page: "board", objects: [], assets: [], deleted: [] },
        threads: [{ n: 7, anchor: { type: "object", object: "~0000000001", u: 0.5, v: 0.5, checkpoint: 2 } }],
      });
    if (path.endsWith("/assets/prepare")) return Response.json({ images: [] });
    if (path.endsWith("/assets/commit")) return Response.json({ images: body.images });
    if (path.endsWith("/captures/commit")) return Response.json({ version: 2 });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    await captureVersion("artifact", 2, { asset: () => "", render: () => "" }, existing);
    expect(calls[0]?.body).toEqual({ target: { kind: "version", version: 2 } });
    const commit = calls.find((call) => call.path.endsWith("/captures/commit"));
    expect(commit?.body.ticket).toBe("fenced");
    const renders = commit?.body.renders as BoardRenders;
    expect(renders.thumbnail).toEqual(image);
    expect(renders.crops.map((crop) => crop.thread)).toEqual([7]);
    expect(renders.crops[0]?.image.width).toBe(480);
  } finally {
    globalThis.fetch = fetchBefore;
    if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
