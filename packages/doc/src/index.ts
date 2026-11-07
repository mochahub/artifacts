/**
 * `@artifacts/doc`: the editor's document model, shared by the server, the editor chunk and the tests
 * (13, "The document model"). The viewer imports the subpaths it needs (`/schema`, `/ids`,
 * `/attribution`, `/sync`), never this index, which pulls in the remark stack and node:crypto.
 */
export * from "./attribution.ts";
export * from "./ids.ts";
export * from "./markdown.ts";
export * from "./schema.ts";
export * from "./ydoc.ts";
