import sharp from "sharp";
import { webkit } from "playwright-core";
const b = await webkit.launch(); const p = await b.newPage(); await p.setContent("<p style='background:#ffd84d'>x</p>");
const png = await p.screenshot(); await b.close();
const webp = await sharp(png).webp({ quality: 82 }).toBuffer();
console.log(JSON.stringify({ ok: true, bun: Bun.version, webp: webp.length, sharp: sharp.versions.sharp }));
