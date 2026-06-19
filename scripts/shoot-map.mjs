// Headless screenshot of the actual WebGL render — what a phone really shows.
// The campaign map is three.js/WebGL2; our old "software preview" didn't cull
// backfaces or draw the sea plane, so it hid real bugs (e.g. an inverted-winding
// terrain that rendered all-blue on device). This drives a real Chromium with
// SwiftShader so the screenshot matches the device.
//
// Usage: node scripts/shoot-map.mjs [out.png] [castleIndex]
//   - out.png      where to write the screenshot (default /tmp/map.png)
//   - castleIndex  which campaign castle to frame (default 0 = first objective)
//
// Requires a Chromium: set CHROME to its path, or run
//   npx puppeteer browsers install chrome-headless-shell
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'url';
import { writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const out = process.argv[2] || '/tmp/map.png';
const castleIndex = Number(process.argv[3] || 0);

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  try { return execSync('node -e "console.log(require(\'puppeteer-core\').executablePath?.()||\'\')"').toString().trim() || null; } catch { /* */ }
  try {
    const base = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell`;
    const ver = execSync(`ls ${base}`).toString().trim().split('\n')[0];
    const p = `${base}/${ver}/chrome-headless-shell-linux64/chrome-headless-shell`;
    if (existsSync(p)) return p;
  } catch { /* */ }
  return null;
}
const exe = findChrome();
if (!exe) { console.error('No Chromium found. Run: npx puppeteer browsers install chrome-headless-shell'); process.exit(1); }

// 1x1 png to satisfy the absolute-URL icon/og loads (which 404 over file://)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f7e0000000049454e44ae426082', 'hex');

const browser = await puppeteer.launch({
  executablePath: exe, headless: 'shell',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', r => (/getarsenal\.app/.test(r.url()) && /\.(png|jpg|jpeg|webmanifest|mp4)/.test(r.url())) ? r.respond({ status: 200, contentType: 'image/png', body: PNG }) : r.continue());
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // iPhone-ish portrait
// seed campaign progress so the map opens framed on the chosen objective
await page.evaluateOnNewDocument(i => { try { localStorage.setItem('castlehassle.campaign.v1', JSON.stringify({ unlocked: i, completed: Array.from({ length: i }, (_, k) => k) })); } catch { /* */ } }, castleIndex);
await page.goto(pathToFileURL('index.html').href, { waitUntil: 'load' });
await page.evaluate(() => document.getElementById('startGameBtn')?.click());
await new Promise(r => setTimeout(r, 1800));
writeFileSync(out, await page.screenshot());
console.log('wrote', out);
await browser.close();
