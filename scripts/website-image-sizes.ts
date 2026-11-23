// pnpm website:image-sizes: writes the smaller copies of each website screenshot (website/shot-sizes.ts)
// from its full-size WebP, and removes copies no screenshot needs any more. pnpm website:screenshots runs
// it after capturing. Needs ImageMagick (magick) on PATH. Run with Node 23.6+ (TypeScript type stripping).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shotFile, shotWidths } from '../website/shot-sizes.ts';

const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), '../website/media');
const shots = JSON.parse(readFileSync(join(MEDIA, 'shots.json'), 'utf8')) as Record<string, { width: number; height: number }>;

const wanted = new Set<string>();
for (const [name, { width: cssWidth }] of Object.entries(shots)) {
  for (const scheme of ['light', 'dark'] as const) {
    const full = join(MEDIA, shotFile(name, scheme, cssWidth * 2, cssWidth));
    for (const width of shotWidths(cssWidth).slice(0, -1)) {
      const file = shotFile(name, scheme, width, cssWidth);
      wanted.add(file);
      // The same encoder settings as the full-size files (scripts/website-screenshots.ts)
      execFileSync('magick', [full, '-resize', `${width}x`, '-strip', '-quality', '86', '-define', 'webp:method=6', join(MEDIA, file)]);
    }
  }
}
for (const file of readdirSync(MEDIA)) {
  if (/-\d+w\.webp$/.test(file) && !wanted.has(file)) rmSync(join(MEDIA, file));
}
console.log(`${wanted.size} smaller screenshot copies in website/media`);
