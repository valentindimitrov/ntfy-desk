// pnpm store:screenshots: the store listings' screenshots (assets/store-listings/screenshots/), made from the
// website's screenshots of the real extension (website/media, pnpm website:screenshots runs this after them).
// The Chrome Web Store wants 1280 x 800 px, full bleed, PNG without alpha; Firefox Add-ons takes the same files.
// Needs ImageMagick (magick) on PATH. Run with Node 23.6+ (TypeScript type stripping).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(root, 'website/media');
const OUT = join(root, 'assets/store-listings/screenshots');
const WIDTH = 1280;
const HEIGHT = 800;
/** Website screenshots captured at exactly the store's proportions (1280 x 800 CSS pixels) */
const SHOTS = ['overview'];

const sizes = JSON.parse(readFileSync(join(MEDIA, 'shots.json'), 'utf8')) as Record<string, { width: number; height: number }>;
mkdirSync(OUT, { recursive: true });
let count = 0;
for (const name of SHOTS) {
  const size = sizes[name];
  if (size?.width !== WIDTH || size.height !== HEIGHT) throw new Error(`${name} is not ${WIDTH} x ${HEIGHT} in shots.json`);
  for (const scheme of ['light', 'dark']) {
    const source = join(MEDIA, `${name}-${scheme}.webp`);
    const target = join(OUT, `${name}-${scheme}.png`);
    execFileSync('magick', [source, '-resize', `${WIDTH}x${HEIGHT}!`, '-alpha', 'off', '-strip', `PNG24:${target}`]);
    count++;
  }
}
console.log(`${count} store screenshots in assets/store-listings/screenshots`);
