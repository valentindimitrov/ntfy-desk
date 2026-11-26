// pnpm icons: renders the extension's icon (assets/icon/icon.svg, and icon-16.svg drawn for 16 px) to
// public/icon/<size>.png with Playwright's Chromium, transparent around the rounded square. The manifest, the
// popup, notifications, the website and the store images use those PNGs.
// Needs Playwright's Chromium (pnpm exec playwright install chromium). Run with Node 23.6+ (TypeScript type stripping).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Each size and the drawing it comes from: 16 px has its own, with fewer details */
const SIZES: [number, string][] = [
  [16, 'icon-16.svg'],
  [32, 'icon.svg'],
  [48, 'icon.svg'],
  [96, 'icon.svg'],
  [128, 'icon.svg'],
];

const browser = await chromium.launch();
try {
  for (const [size, source] of SIZES) {
    const svg = readFileSync(join(root, 'assets/icon', source), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: join(root, 'public/icon', `${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`${SIZES.length} icon sizes in public/icon`);
