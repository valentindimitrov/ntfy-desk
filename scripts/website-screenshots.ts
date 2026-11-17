// pnpm website:screenshots: the website's screenshots (website/media/*.webp and their sizes in
// shots.json), taken from the real
// extension. Playwright's Chromium loads the E2E build (.output/chrome-mv3-e2e, built by the package
// script) and talks to the test ntfy server of the end-to-end tests, filled with invented content.
//
// The extension shows the server address, so the test server is given an invented name: Chromium maps
// ntfy.example.com (and the demo web page's host) to a local HTTPS front with a certificate made for
// this run, which also serves the attachment route (/file/<name>) the test server lacks. Nothing here
// reads a browser profile, a real server or a real token.
//
// Needs Playwright's Chromium (pnpm exec playwright install chromium), openssl and ImageMagick
// (magick) on PATH. Run with Node 23.6+ (TypeScript type stripping). Options: --keep-png keeps the raw
// captures next to the WebP files.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { startNtfyServer, type NtfyTestServer, type ServerMessage } from '../tests/e2e/ntfy-server.ts';

const EXTENSION_PATH = resolve('.output/chrome-mv3-e2e');
const MEDIA = resolve('website/media');
const SERVER_HOST = 'ntfy.example.com';
const SERVER_URL = `https://${SERVER_HOST}`;
const PAGE_HOST = 'blog.example.org';
const PAGE_URL = `https://${PAGE_HOST}/quiet-notifications`;
const PAGE_TITLE = 'Quiet notifications for a noisy home lab';
const TOPICS = ['home-lab', 'backups', 'deploys', 'front-door', 'reading-list'];
const SCHEMES = ['light', 'dark'] as const;
const SCALE = 2;
const keepPng = process.argv.includes('--keep-png');

const temp = mkdtempSync(join(tmpdir(), 'ntfy-desk-shots-'));

/** A certificate for the invented hosts, valid for this run only (Chromium is told to accept it) */
function createCertificate(): { key: Buffer; cert: Buffer } {
  const key = join(temp, 'key.pem');
  const cert = join(temp, 'cert.pem');
  const names = `subjectAltName=DNS:${SERVER_HOST},DNS:${PAGE_HOST}`;
  const options = ['-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${SERVER_HOST}`, '-addext', names];
  execFileSync('openssl', ['req', ...options, '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const DEMO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${PAGE_TITLE}</title>
<style>body{font:18px/1.6 system-ui,sans-serif;max-width:680px;margin:64px auto;padding:0 24px;color:#1d2422}h1{line-height:1.2}</style>
</head><body><h1>${PAGE_TITLE}</h1><p>Route alerts by priority, keep the routine ones in the inbox, and let only the urgent ones interrupt.</p></body></html>`;

/** The chart attached to a demo message: drawn here, rendered to PNG by the same Chromium */
const CHART = `<!doctype html><html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260" font-family="Roboto, Arial, sans-serif">
<rect width="640" height="260" fill="#16201f"/>
<text x="24" y="36" fill="#e8efed" font-size="17" font-weight="600">/srv/data usage, last 7 days</text>
<g stroke="#2c3a38" stroke-width="1"><path d="M24 80h592M24 130h592M24 180h592M24 230h592"/></g>
<path d="M24 80h592" stroke="#ffba70" stroke-width="1.5" stroke-dasharray="6 5"/>
<text x="24" y="72" fill="#ffba70" font-size="13">85 % threshold</text>
<path d="M24 196 L122 188 L221 176 L320 150 L418 128 L517 96 L616 70 L616 230 L24 230 Z" fill="#338574" opacity="0.28"/>
<path d="M24 196 L122 188 L221 176 L320 150 L418 128 L517 96 L616 70" fill="none" stroke="#66c0ac" stroke-width="3" stroke-linejoin="round"/>
<circle cx="616" cy="70" r="5" fill="#66c0ac"/>
<g fill="#9fb0ac" font-size="12"><text x="24" y="250">Mon</text><text x="212" y="250">Wed</text><text x="408" y="250">Fri</text><text x="590" y="250">Sun</text></g>
</svg></body></html>`;

/** HTTPS front: the demo web page, the attachment route, and everything else passed on to the test ntfy server */
async function startFront(ntfy: NtfyTestServer, files: Map<string, Buffer>): Promise<{ port: number; close: () => Promise<void> }> {
  const upstream = new URL(ntfy.url);
  const server = createHttpsServer(createCertificate(), (req, res) => {
    if (req.headers.host?.split(':')[0] === PAGE_HOST) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DEMO_PAGE);
      return;
    }
    const file = /^\/file\/([\w.-]+)$/.exec(req.url ?? '')?.[1];
    if (file) {
      const body = files.get(file);
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' }).end(body);
      return;
    }
    // The demo server needs no sign-in (the front signs in to the test server), so no token is stored in
    // the extension and it has no reason to ask for access to the server in a browser prompt
    const forward = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, authorization: `Bearer ${ntfy.token}` },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    forward.on('error', () => res.destroy());
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

type Demo = Partial<ServerMessage> & { topic: string; minutesAgo: number; read?: boolean; extra?: Record<string, unknown> };

/** The inbox content, oldest first. Hosts are reserved example names; nothing is real. */
const MESSAGES: Demo[] = [
  {
    topic: 'front-door',
    minutesAgo: 20 * 60,
    read: true,
    title: 'Parcel delivered',
    message: 'Left with the neighbour at number 14.',
    tags: ['package'],
  },
  {
    topic: 'deploys',
    minutesAgo: 16 * 60,
    read: true,
    title: 'blog: deployed 4f2c91a',
    message: 'Build 2 min 12 s, health check passed.',
    tags: ['rocket'],
    click: 'https://ci.example.com/blog/runs/412',
  },
  {
    topic: 'backups',
    minutesAgo: 31,
    title: 'Nightly backup finished',
    content_type: 'text/markdown',
    message:
      '**3 volumes** backed up in 14 minutes.\n\n- photos: 212 GB\n- documents: 18 GB\n- databases: 6 GB\n\nNext run: *tomorrow 02:00*. [Open the report](https://backup.example.com/reports/latest)',
    tags: ['white_check_mark'],
  },
  {
    topic: 'home-lab',
    minutesAgo: 185,
    read: true,
    title: 'UPS on battery for 40 seconds',
    message: 'Mains power is back. Battery at 97 %.',
    priority: 4,
    tags: ['electric_plug'],
  },
  {
    topic: 'deploys',
    minutesAgo: 47,
    title: 'api: build failed',
    message: 'Step "test" failed: 2 of 318 tests. Details: https://ci.example.com/api/runs/977',
    priority: 5,
    tags: ['rotating_light'],
  },
  {
    topic: 'home-lab',
    minutesAgo: 12,
    title: 'Disk usage above 85 %',
    message: '/srv/data is at 87 % and growing about 3 % a day.',
    priority: 4,
    tags: ['warning'],
    extra: { attachment: { name: 'disk-usage.png', type: 'image/png', size: 0, url: `${SERVER_URL}/file/k3Tq9LmZ.png` } },
  },
  {
    topic: 'front-door',
    minutesAgo: 4,
    title: 'Doorbell',
    message: 'Someone rang at the front door.',
    tags: ['bell'],
  },
];

function publishDemo(ntfy: NtfyTestServer, files: Map<string, Buffer>): void {
  const now = Math.floor(Date.now() / 1000);
  for (const { topic, minutesAgo, read: _read, extra, ...fields } of MESSAGES) {
    const attachment = extra?.attachment as { size: number } | undefined;
    if (attachment) attachment.size = files.get('k3Tq9LmZ.png')?.length ?? 0;
    ntfy.publish(topic, { time: now - minutesAgo * 60, ...fields, ...extra });
  }
}

async function configure(worker: Worker): Promise<void> {
  await worker.evaluate(
    async ({ apiUrl, topics }) => {
      await chrome.storage.local.set({ authOrigins: [new URL(apiUrl).origin] });
      await chrome.storage.sync.set({
        apiUrl,
        fallbackUrl: '',
        topics: topics.join(','),
        // Stored as lists keyed by topic, as the settings save them
        notifyRules: [
          ['backups', 'off'],
          ['deploys', 'high'],
        ],
        topicSendDefaults: [
          { topic: 'home-lab', priority: 4, tags: ['warning'] },
          { topic: 'reading-list', priority: 2, tags: ['bookmark'] },
        ],
        lastTopic: 'reading-list',
      });
    },
    { apiUrl: SERVER_URL, topics: TOPICS },
  );
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const READ = MESSAGES.filter(({ read }) => read).length;
const shots: string[] = [];
/** Size of each view in CSS pixels (the files have twice as many), for the width and height in the pages */
const sizes: Record<string, { width: number; height: number }> = {};

/** One view in both colour schemes: the page, or one element of it */
async function capture(page: Page, name: string, target: string | null): Promise<void> {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    const path = join(MEDIA, `${name}-${scheme}.png`);
    if (target) await page.locator(target).screenshot({ path, animations: 'disabled' });
    else await page.screenshot({ path, animations: 'disabled' });
    shots.push(path);
    // PNG: width and height are the two 32-bit numbers after the IHDR chunk name
    const header = readFileSync(path);
    sizes[name] = { width: header.readUInt32BE(16) / SCALE, height: header.readUInt32BE(20) / SCALE };
  }
}

async function openExtension(context: BrowserContext, id: string, search: string, width: number, height: number): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${id}/popup.html${search}`);
  return page;
}

async function main(): Promise<void> {
  mkdirSync(MEDIA, { recursive: true });
  const ntfy = await startNtfyServer('tk_demo');
  const files = new Map<string, Buffer>();
  const front = await startFront(ntfy, files);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    deviceScaleFactor: SCALE,
    viewport: { width: 1280, height: 800 },
    args: [
      '--screen-info={1600x1000}',
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--host-resolver-rules=MAP ${SERVER_HOST} 127.0.0.1:${front.port}, MAP ${PAGE_HOST} 127.0.0.1:${front.port}`,
      '--ignore-certificate-errors',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;

    const chart = await context.newPage();
    await chart.setViewportSize({ width: 640, height: 260 });
    await chart.setContent(CHART);
    files.set('k3Tq9LmZ.png', await chart.screenshot());
    await chart.close();

    // The history first (a topic's first sync is silent), then the live subscription
    publishDemo(ntfy, files);
    await configure(worker);
    await until(() => ntfy.subscriptions.length > 0, 'the subscription');

    const page = await openExtension(context, id, '?mode=page', 1280, 800);
    const items = page.locator('.notification-item');
    await until(async () => (await items.count()) === MESSAGES.length, 'the demo messages');
    await until(() => page.locator('.notification-item img').evaluate((image: HTMLImageElement) => image.complete), 'the image preview');
    for (const { title, read } of MESSAGES) {
      if (read) await items.filter({ hasText: title }).getByRole('button', { name: 'Mark as Read' }).click();
    }
    await until(async () => (await page.getByRole('button', { name: 'Mark as Unread' }).count()) === READ, 'the read marks');
    const toTop = () => page.locator('#notifications-list').evaluate((list) => list.scrollTo(0, 0));

    // Home, top: inbox and Send form side by side, with a message being written
    await page.locator('#topic-select').selectOption('home-lab');
    await page.locator('#title-input').fill('Router firmware 7.4 installed');
    await page.locator('#message-input').fill('Rebooted at 21:40, all links are back up.');
    await page.locator('#title-input').blur();
    await toTop();
    await capture(page, 'overview', null);

    // The inbox alone: Send collapsed to its rail, a taller window
    await page.locator('#send-section > summary').click();
    await page.setViewportSize({ width: 860, height: 940 });
    await toTop();
    await capture(page, 'inbox', null);

    // The Send form with every option in use, and two queued files
    await worker.evaluate(() => {
      const background = globalThis as unknown as { __ntfyAddPickedFiles: (files: File[]) => Promise<void> };
      return background.__ntfyAddPickedFiles([
        new File(['time,value\n'.repeat(4000)], 'ups-load.csv', { type: 'text/csv' }),
        new File(['Mains restored\n'.repeat(900)], 'ups-events.log', { type: 'text/plain' }),
      ]);
    });
    await page.locator('#send-section > summary').click();
    await page.setViewportSize({ width: 1280, height: 1010 });
    await page.locator('#title-input').fill('UPS battery test passed');
    await page.locator('#message-input').fill('**Runtime 41 min** at 35 % load.\nNext test in 90 days.');
    await until(async () => (await page.locator('#file-preview').textContent())?.includes('ups-events.log') ?? false, 'the queued files');
    await page.locator('#zip-checkbox').check();
    await page.locator('#more-options > summary').click();
    await page.locator('#click-input').fill('https://status.example.com/ups');
    await page.locator('#markdown-checkbox').check();
    await page.locator('#delay-select').selectOption('30m');
    await page.locator('#click-input').blur();
    await capture(page, 'send', '#send-section');

    // Settings: the server, the topic table (sync, notification rule, send defaults), shortcuts and backup
    await page.locator('#settings-btn').click();
    for (const [tab, name, height] of [
      ['Server', 'settings-server', 580],
      ['Topics', 'settings-topics', 680],
      ['More', 'settings-more', 500],
    ] as const) {
      await page.setViewportSize({ width: 920, height });
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.getByRole('tabpanel', { name: tab, exact: true }).waitFor();
      // Deletion sync is chosen in the table but not applied: applying it asks for access to the server
      // in a browser prompt, which this script can't answer
      if (tab === 'Topics')
        await page
          .locator('#topic-settings-rows tr', { hasText: 'deploys' })
          .locator('select')
          .first()
          .selectOption({ label: 'Sync server deletions' });
      await capture(page, name, null);
    }
    await page.close();

    // The real "Send this page to ntfy" command (the handler the keyboard shortcut calls), run for
    // the demo page; the capture shows what it delivered to the inbox
    await worker.evaluate(() => chrome.storage.sync.set({ lastTopic: 'reading-list' }));
    const article = await context.newPage();
    await article.goto(PAGE_URL);
    await worker.evaluate(
      (tab) =>
        (globalThis as unknown as { __ntfyRunCommand: (command: string, tab: unknown) => Promise<void> }).__ntfyRunCommand(
          'send-page',
          tab,
        ),
      { id: 1, url: PAGE_URL, title: PAGE_TITLE },
    );
    await article.close();
    const sent = await openExtension(context, id, '?mode=page&topic=reading-list', 860, 290);
    await until(async () => (await sent.locator('.notification-item').count()) === 1, 'the sent page');
    await sent.locator('#send-section > summary').click();
    await capture(sent, 'sent-page', null);
  } finally {
    await context.close();
    await front.close();
    await ntfy.close();
    rmSync(temp, { recursive: true, force: true });
  }

  for (const png of shots) {
    execFileSync('magick', [png, '-strip', '-quality', '86', '-define', 'webp:method=6', png.replace(/\.png$/, '.webp')]);
    if (!keepPng) rmSync(png);
  }
  writeFileSync(join(MEDIA, 'shots.json'), `${JSON.stringify(sizes, null, 2)}\n`);
  console.log(`${shots.length} screenshots in website/media`);
}

await main();
