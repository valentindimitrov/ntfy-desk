// pnpm store:screenshots: the store listings' images.
// - Screenshots (assets/store-listings/screenshots/): made from the website's screenshots of the real extension
//   (website/media, pnpm website:screenshots runs this after them). The Chrome Web Store wants 1280 x 800 px, full
//   bleed, PNG without alpha; Firefox Add-ons takes the same files.
// - Chrome Web Store promo tiles (assets/store-listings/chrome-web-store/small-promo-tile.png, 440 x 280, and
//   marquee-promo-tile.png, 1400 x 560): the extension's icon, name and claims from its README on a drawn
//   background, rendered by Playwright's Chromium with the extension's own Roboto.
// Needs ImageMagick (magick) on PATH and Playwright's Chromium (pnpm exec playwright install chromium). Run with
// Node 23.6+ (TypeScript type stripping). Options: --tiles or --screenshots makes only those.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(root, 'website/media');
const SCREENSHOTS = join(root, 'assets/store-listings/screenshots');
const CHROME = join(root, 'assets/store-listings/chrome-web-store');
const WIDTH = 1280;
const HEIGHT = 800;
/** Website screenshots captured at exactly the store's proportions (1280 x 800 CSS pixels) */
const SHOTS = ['overview'];

const only = process.argv.find((arg) => arg === '--tiles' || arg === '--screenshots');

/** PNG without alpha, as both stores want */
function rgbPng(source: string, target: string, size: string): void {
  execFileSync('magick', [
    source,
    '-resize',
    `${size}!`,
    '-background',
    '#ffffff',
    '-alpha',
    'remove',
    '-alpha',
    'off',
    '-strip',
    `PNG24:${target}`,
  ]);
}

function screenshots(): number {
  const sizes = JSON.parse(readFileSync(join(MEDIA, 'shots.json'), 'utf8')) as Record<string, { width: number; height: number }>;
  mkdirSync(SCREENSHOTS, { recursive: true });
  let count = 0;
  for (const name of SHOTS) {
    const size = sizes[name];
    if (size?.width !== WIDTH || size.height !== HEIGHT) throw new Error(`${name} is not ${WIDTH} x ${HEIGHT} in shots.json`);
    for (const scheme of ['light', 'dark']) {
      rgbPng(join(MEDIA, `${name}-${scheme}.webp`), join(SCREENSHOTS, `${name}-${scheme}.png`), `${WIDTH}x${HEIGHT}`);
      count++;
    }
  }
  return count;
}

const dataUrl = (file: string, type: string) => `data:${type};base64,${readFileSync(join(root, file)).toString('base64')}`;

/** One tile: icon, name, claim and three features, in the extension's teal on a dark background */
function tileHtml(width: number, height: number, small: boolean): string {
  const fonts = ['400', '500', '600']
    .map(
      (weight) =>
        `@font-face{font-family:Roboto;font-weight:${weight};src:url(${dataUrl(`public/fonts/roboto-${weight}.woff2`, 'font/woff2')})}`,
    )
    .join('');
  // Claims from README.md's features: live desktop notifications, an inbox per topic, sending with files
  const features = small ? [] : ['Desktop notifications', 'An inbox per topic', 'Files, priority and tags'];
  const claim = small ? 'Send and receive ntfy notifications' : 'Send and receive ntfy notifications in your browser';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
*{box-sizing:border-box}
body{margin:0;width:${width}px;height:${height}px;overflow:hidden;color:#fff;font-family:Roboto,sans-serif;
  background:radial-gradient(ellipse at 92% 0%,#2f8a76 0%,transparent 55%),radial-gradient(ellipse at 0% 100%,#1c4f63 0%,transparent 58%),#0e1b19}
.layout{position:relative;height:100%;display:flex;align-items:center;justify-content:${small ? 'center' : 'flex-start'};padding:${small ? '0 30px' : '80px 110px'};gap:${small ? '22px' : '64px'}}
/* The icon's own 128 px at most: it has no larger source */
.logo{width:${small ? '92px' : '128px'};height:auto;filter:drop-shadow(0 12px 28px #66c0ac40)}
h1{font-size:${small ? '40px' : '88px'};font-weight:600;letter-spacing:${small ? '-1px' : '-2px'};margin:0;line-height:1.05}
.claim{font-size:${small ? '16px' : '30px'};font-weight:400;color:#d3ebe5;line-height:1.35;margin:${small ? '8px' : '18px'} 0 0;max-width:${small ? '200px' : '820px'}}
.features{display:flex;gap:14px;margin-top:34px}
.features span{font-size:21px;font-weight:500;color:#e9f6f2;border:1px solid #66c0ac80;background:#ffffff0d;border-radius:999px;padding:12px 22px}
.ring{position:absolute;right:-120px;top:-170px;width:440px;height:440px;border:1px solid #66c0ac30;border-radius:50%;display:${small ? 'none' : 'block'}}
</style></head><body><div class="ring"></div><div class="layout">
<img class="logo" src="${dataUrl('public/icon/128.png', 'image/png')}" alt="">
<div><h1>ntfy Desk</h1><p class="claim">${claim}</p>${features.length ? `<div class="features">${features.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}</div>
</div></body></html>`;
}

async function tiles(): Promise<number> {
  const temp = mkdtempSync(join(tmpdir(), 'ntfy-desk-tiles-'));
  const browser = await chromium.launch();
  try {
    for (const [name, width, height] of [
      ['small-promo-tile', 440, 280],
      ['marquee-promo-tile', 1400, 560],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      await page.setContent(tileHtml(width, height, width < 1000));
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const capture = join(temp, `${name}.png`);
      await page.screenshot({ path: capture });
      await page.close();
      // Rendered at twice the size and scaled down, for smooth text and edges
      rgbPng(capture, join(CHROME, `${name}.png`), `${width}x${height}`);
    }
  } finally {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  }
  return 2;
}

if (only !== '--tiles') console.log(`${screenshots()} store screenshots in assets/store-listings/screenshots`);
if (only !== '--screenshots') console.log(`${await tiles()} promo tiles in assets/store-listings/chrome-web-store`);
