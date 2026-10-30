// Spike S5 (server half): sharp under Bun on the server image. Cuts a crop like 05 "Crops".
import sharp from "sharp";
const frame = await sharp({ create: { width: 786, height: 1704, channels: 4, background: "#20232a" } }).png().toBuffer();
const t0 = performance.now();
const x = 0.4, y = 0.3, W = 786, H = 1704, cw = 480, ch = 320;
const left = Math.max(0, Math.min(W - cw, Math.round(x * W - cw / 2))), top = Math.max(0, Math.min(H - ch, Math.round(y * H - ch / 2)));
const ring = Buffer.from(`<svg width="${cw}" height="${ch}"><circle cx="${x * W - left}" cy="${y * H - top}" r="12" fill="none" stroke="#ffd84d" stroke-width="6"/></svg>`);
const crop = await sharp(frame).extract({ left, top, width: cw, height: ch }).composite([{ input: ring }]).webp({ quality: 82 }).toBuffer();
console.log(JSON.stringify({ ok: true, arch: process.arch, bun: Bun.version, sharp: sharp.versions.sharp, cropBytes: crop.length, ms: Math.round(performance.now() - t0) }));
