// pnpm website:card: render website/media/social-card.html, the 1200 × 627 link preview layout, to
// website/media/social-card.png at twice that size. Needs Playwright's Chromium and ImageMagick
// (magick) on PATH. Run with Node 23.6+ (TypeScript type stripping).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const target = resolve('website/media/social-card.png');
const temp = mkdtempSync(join(tmpdir(), 'ntfy-desk-card-'));
const raw = join(temp, 'raw.png');

// The layout loads the extension's fonts and icon from the repository. Chromium refuses fonts from
// file: addresses, so the three folders it needs are served on 127.0.0.1 for the capture.
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname));
  const type = TYPES[extname(path)];
  const allowed = ['/website/media/', '/public/fonts/', '/public/icon/'].some((folder) => path.startsWith(folder));
  if (!type || !allowed) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, { 'Content-Type': type }).end(readFileSync(join(resolve('.'), path)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address() as AddressInfo;

const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 627 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/website/media/social-card.html`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: raw });
} finally {
  await browser.close();
  server.close();
}
execFileSync('magick', [raw, '-background', '#141c1c', '-alpha', 'remove', '-alpha', 'off', '-depth', '8', '-strip', `PNG24:${target}`]);
rmSync(temp, { recursive: true, force: true });
console.log('website/media/social-card.png');
