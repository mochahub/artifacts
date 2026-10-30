// Captures CameraBuddy's mock screens as stand-in content for the viewer mocks.
// Usage: node capture-cb.mjs <path to playwright package> <CameraBuddy mocks dir> <out dir>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [pw, src, out] = process.argv.slice(2);
const { webkit } = await import(pathToFileURL(path.join(pw, 'index.mjs')).href);
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 1200 }, deviceScaleFactor: 2 });
for (const name of ['01-onboarding', '02-shoot', '03-import-cull', '04-assist']) {
  await page.goto(pathToFileURL(path.join(src, `${name}.html`)).href);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => { document.body.style.background = '#1b1d22'; return document.fonts.ready; });
  const phones = await page.$$('.phone');
  for (let i = 0; i < phones.length; i++) {
    const file = path.join(out, `${name.slice(0, 2)}-${String(i + 1).padStart(2, '0')}.jpg`);
    await phones[i].screenshot({ path: file, type: 'jpeg', quality: 82, omitBackground: false });
  }
  console.log(name, phones.length);
}
await browser.close();
