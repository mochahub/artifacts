/**
 * The document model the server's editing code uses, from `@artifacts/doc` (13, "The document model").
 * One narrow import, so the rest of `editing/` names only what it needs.
 */
export {
  authorRuns,
  blockMarkdown,
  contentHash,
  docToMarkdown,
  docToY,
  markdownToDoc,
  mintBlockId,
  topBlocks,
  validate,
  yToDoc,
} from "@artifacts/doc";
