/**
 * A response type from a schema that `@artifacts/schema` exports as a zod value only. The viewer can't
 * import zod into its first chunk, and doesn't depend on it, so this reads what `z.infer` reads.
 */
export type Infer<Schema extends { _zod: { output: unknown } }> = Schema["_zod"]["output"];
