export type Chunk = {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  isEntry?: boolean;
};
export type Manifest = Record<string, Chunk>;

/** Static load closure only: dynamic imports are separate user actions. Missing edges fail closed. */
export function closure(manifest: Manifest, key: string, into = new Set<string>()) {
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing build chunk: ${key}`);
  if (into.has(chunk.file)) return into;
  into.add(chunk.file);
  for (const css of chunk.css ?? []) into.add(css);
  for (const next of chunk.imports ?? []) closure(manifest, next, into);
  return into;
}

export function coldLoad(manifest: Manifest, editor: string, reader: string) {
  const baseline = closure(manifest, reader);
  return [...closure(manifest, editor)].filter((file) => !baseline.has(file)).sort();
}
