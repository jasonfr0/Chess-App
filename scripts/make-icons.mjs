// Renders public/icons/*.png from an inline knight SVG using Playwright's Chromium.
// Run manually: node scripts/make-icons.mjs  (output is committed; not part of the build)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const KNIGHT =
  'M30 82 L30 74 C30 62 36 54 44 46 C38 46 33 43 30 38 L36 28 L38 18 L46 24 C50 20 56 18 62 20 ' +
  'C74 26 80 40 78 56 C77 66 72 74 70 82 Z';

const svg = (size, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1d5fc4"/>
  <g transform="translate(50 50) scale(${pad}) translate(-50 -50)">
    <path d="${KNIGHT}" fill="#f4f4f1" stroke="#0b1220" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="52" cy="34" r="3" fill="#0b1220"/>
    <rect x="24" y="82" width="52" height="8" rx="3" fill="#f4f4f1" stroke="#0b1220" stroke-width="2.5"/>
  </g>
</svg>`;

const out = new URL('../public/icons/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [name, size, pad] of [
  ['icon-192.png', 192, 1.0],
  ['icon-512.png', 512, 1.0],
  ['icon-maskable-512.png', 512, 0.7], // glyph kept inside the central safe zone
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg(size, pad)}</body>`);
  await page.screenshot({ path: out + name });
  await page.close();
}
await browser.close();
