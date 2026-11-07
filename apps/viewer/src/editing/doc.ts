/**
 * The one door from the editor chunk to the document model (`@artifacts/doc`, 13 "The document model").
 * Only the schema and the id plugin come through here, by their subpaths: never the Markdown
 * converters, which carry remark and would blow the editor chunk's budget.
 */
export { blockIdPlugin, mintBlockId } from "@artifacts/doc/ids";
export { editorSchema } from "@artifacts/doc/schema";
