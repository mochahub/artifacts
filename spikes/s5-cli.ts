// Spike S5: what works from a `bun build --compile` binary.
// Build: bun build --compile s5-cli.ts --outfile dist/s5-cli
// Run:   dist/s5-cli playwright|secrets|sharp|all
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2] ?? "all";
const out: Record<string, unknown> = { bun: Bun.version, platform: `${process.platform}-${process.arch}`, compiled: !process.execPath.endsWith("bun") };

async function playwright() {
  // The real CLI installs playwright-core into ~/.artifacts/playwright/ on first render; PW_DIR stands in for it.
  const dir = process.env.PW_DIR ?? join(process.env.HOME ?? "", ".artifacts/playwright");
  const entry = pathToFileURL(join(dir, "node_modules/playwright-core/index.mjs")).href;
  const t0 = performance.now();
  const pw = await import(entry);
  const browser = await pw.webkit.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 393, height: 852 } });
  const page = await ctx.newPage();
  await page.setContent(`<div data-frame="a" style="width:200px;height:100px;background:#ffd84d;font:16px system-ui">Hello</div>`);
  const png: Uint8Array = await page.locator("[data-frame=a]").screenshot();
  const ua = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  out.playwright = { ok: true, entry, pngBytes: png.length, isPng: png[1] === 0x50, ua, ms: Math.round(performance.now() - t0) };
  return png;
}

async function secrets() {
  const s = (Bun as unknown as { secrets?: any }).secrets;
  if (!s) return (out.secrets = { ok: false, error: "Bun.secrets is undefined" });
  const service = "artifacts-spike-s5";
  const name = "https://example.invalid";
  try {
    await s.set({ service, name, value: "art_test_123" });
    const got = await s.get({ service, name });
    const deleted = await s.delete({ service, name });
    const after = await s.get({ service, name });
    out.secrets = { ok: got === "art_test_123" && after === null, got, deleted, after };
  } catch (e) {
    out.secrets = { ok: false, error: String((e as Error).message ?? e), code: (e as { code?: string }).code };
  }
}

async function sharpProbe(png?: Uint8Array) {
  try {
    // SHARP_DIR: load sharp from an external node_modules (like Playwright) instead of the bundled copy.
    const sharp = process.env.SHARP_DIR
      ? createRequire(join(process.env.SHARP_DIR, "package.json"))("sharp")
      : (await import("sharp")).default;
    const input = png ?? (await sharp({ create: { width: 64, height: 64, channels: 4, background: "#8f7cff" } }).png().toBuffer());
    const webp = await sharp(input).webp({ quality: 82, effort: 4 }).toBuffer();
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 16);
    const crop = await sharp(input).extract({ left: 0, top: 0, width: Math.min(32, info.width), height: Math.min(32, info.height) }).webp().toBuffer();
    out.sharp = { ok: true, version: sharp.versions, webpBytes: webp.length, rgbaHash: hash, w: info.width, h: info.height, cropBytes: crop.length };
  } catch (e) {
    out.sharp = { ok: false, error: String((e as Error).message ?? e).slice(0, 600) };
  }
}

let png: Uint8Array | undefined;
if (mode === "playwright" || mode === "all") {
  try {
    png = await playwright();
  } catch (e) {
    out.playwright = { ok: false, error: String((e as Error).message ?? e).slice(0, 600) };
  }
}
if (mode === "secrets" || mode === "all") await secrets();
if (mode === "sharp" || mode === "all") await sharpProbe(png);
console.log(JSON.stringify(out, null, 2));
