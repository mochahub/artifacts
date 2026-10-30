// Screenshots boards from the review server for visual checks.
// Usage: node shoot.mjs <path to playwright package> <out dir> <board> [board…]
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [pw, out, ...names] = process.argv.slice(2);
const { webkit } = await import(pathToFileURL(path.join(pw, 'index.mjs')).href);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
for (const name of names) {
  await page.goto(`http://127.0.0.1:8788/board/${name}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  const bad = await page.evaluate(() => [...document.images].filter(i => !i.naturalWidth).map(i => i.src));
  console.log(name, bad.length ? `broken: ${bad.join(', ')}` : 'ok');
}
await browser.close();
