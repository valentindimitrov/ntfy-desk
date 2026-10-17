// pnpm browse: open the built extension in playwright-cli's Chromium, on its popup page, for driving
// it by hand or by an agent (playwright-cli snapshot, click, fill, screenshot, ...).
//
// Chromium resolves --load-extension relative to the playwright-cli daemon's directory, so the config
// (.playwright/cli.config.json, git-ignored) is written here with this checkout's absolute path.
// Run with Node 23.6+ (TypeScript type stripping). Options: --headed

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const extension = resolve('.output/chrome-mv3').replaceAll('\\', '/');
const headed = process.argv.includes('--headed');

mkdirSync('.playwright', { recursive: true });
writeFileSync(
  '.playwright/cli.config.json',
  JSON.stringify(
    {
      browser: {
        browserName: 'chromium',
        isolated: false,
        userDataDir: '.playwright/profile',
        launchOptions: {
          // Playwright's Chromium: branded Chrome no longer loads unpacked extensions from the command line
          channel: 'chromium',
          headless: !headed,
          args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        },
      },
    },
    null,
    2,
  ),
);

const cli = (args: string) => execSync(`playwright-cli ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

cli('close');
// open starts a daemon that would keep a captured stdout open, so its output isn't captured
execSync('playwright-cli open about:blank', { stdio: 'ignore' });
// The extension id comes from its service worker's URL
const workers = JSON.parse(cli('--raw run-code "async page => page.context().serviceWorkers().map(w => w.url())"')) as string[];
const id = workers.map((url) => new URL(url)).find((url) => url.protocol === 'chrome-extension:')?.host;
if (!id) {
  console.error('The extension did not load: is .output/chrome-mv3 built (pnpm build)?');
  process.exit(1);
}
cli(`goto chrome-extension://${id}/popup.html?mode=page`);
console.log(`ntfy Desk is open in playwright-cli (extension id ${id}).`);
console.log(`Popup: chrome-extension://${id}/popup.html  ·  as a tab: ?mode=page  ·  Receive tab: ?tab=receive`);
console.log('Next: playwright-cli snapshot | click <ref> | fill <ref> <text> | screenshot | close');
