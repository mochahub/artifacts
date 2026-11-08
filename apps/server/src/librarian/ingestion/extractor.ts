export const EXTRACTION_VERSION = "librarian-inert-v1";
export const MIME_TYPES = ["text/plain", "text/markdown", "text/html", "application/pdf"] as const;
export function safeFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\\/]/.test(name) &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32) &&
    name !== "." &&
    name !== ".."
  );
}
export function validateSource(bytes: Uint8Array, mime: string): void {
  if (
    !MIME_TYPES.includes(mime as (typeof MIME_TYPES)[number]) ||
    bytes.length > 10 * 1024 * 1024 ||
    !bytes.length
  )
    throw new Error("source_format_rejected");
  const start = Buffer.from(bytes.subarray(0, 1024));
  if (mime === "application/pdf") {
    if (!start.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("source_format_rejected");
    return;
  }
  if (
    bytes.includes(0) ||
    [
      Buffer.from("%PDF-"),
      Buffer.from([80, 75, 3, 4]),
      Buffer.from("MZ"),
      Buffer.from([127, 69, 76, 70]),
    ].some((signature) => start.subarray(0, signature.length).equals(signature))
  )
    throw new Error("source_format_rejected");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (mime !== "text/html" && /<(?:!doctype\s+html|html|script|iframe)\b/i.test(start.toString()))
    throw new Error("source_format_rejected");
}
/** Trusted deployment adapter, never request-selected. Must enforce all limits before parsing input. */
export type SandboxedExtractor = (input: {
  bytes: Uint8Array;
  mime: string;
  network: false;
  memoryBytes: 268435456;
  cpuSeconds: 10;
  maxPages: 100;
  maxOutputBytes: 1048576;
}) => Promise<string>;
export async function extractBytes(
  bytes: Uint8Array,
  mime: string,
  sandbox?: SandboxedExtractor,
): Promise<string> {
  validateSource(bytes, mime);
  if (!sandbox) throw new Error("extractor_unavailable");
  const text = await sandbox({
    bytes,
    mime,
    network: false,
    memoryBytes: 268435456,
    cpuSeconds: 10,
    maxPages: 100,
    maxOutputBytes: 1048576,
  });
  if (!text.trim() || Buffer.byteLength(text) > 1048576 || text.includes("\0"))
    throw new Error("extraction_rejected");
  return text;
}
