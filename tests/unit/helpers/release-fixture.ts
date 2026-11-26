import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

// A small repository with its three release ZIPs, for the tests of scripts/validate-packages.ts and
// scripts/sign-chrome.ts. The ZIP writer is independent of the reader under test.

export const VERSION = '1.2.3';

type Entries = Record<string, string | Buffer>;

function uint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

/** A ZIP with deflated entries, in the order given */
export function zip(entries: Entries): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const shared = [uint16(20), uint16(0), uint16(8), uint32(0), uint32(crc32(data)), uint32(compressed.length), uint32(data.length)];
    const local = Buffer.concat([uint32(0x04034b50), ...shared, uint16(Buffer.byteLength(name)), uint16(0), Buffer.from(name), compressed]);
    central.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        ...shared,
        uint16(Buffer.byteLength(name)),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        Buffer.from(name),
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const count = uint16(central.length);
  const end = Buffer.concat([uint32(0x06054b50), uint16(0), uint16(0), count, count, uint32(directory.length), uint32(offset), uint16(0)]);
  return Buffer.concat([...locals, directory, end]);
}

export function manifest(browser: 'chrome' | 'firefox', changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifest_version: 3,
    name: 'ntfy Desk',
    description: 'Send and receive ntfy notifications',
    version: VERSION,
    icons: { '16': 'icon/16.png', '128': 'icon/128.png' },
    permissions: ['activeTab', 'storage', 'unlimitedStorage', 'contextMenus', 'scripting', 'notifications', 'alarms'],
    optional_permissions: ['tabs'],
    optional_host_permissions: ['<all_urls>'],
    incognito: 'not_allowed',
    commands: { 'open-popup': { description: 'Open ntfy Desk' }, 'send-page': { description: 'Send this page to ntfy' } },
    action: { default_title: 'ntfy Desk', default_popup: 'popup.html' },
    ...(browser === 'firefox'
      ? {
          background: { scripts: ['background.js'] },
          browser_specific_settings: {
            gecko: {
              id: 'ntfy-desk@valentindimitrov.github.io',
              strict_min_version: '142.0',
              data_collection_permissions: {
                required: ['authenticationInfo', 'personalCommunications', 'browsingActivity', 'websiteContent'],
              },
            },
          },
        }
      : { background: { service_worker: 'background.js' }, minimum_chrome_version: '116' }),
    ...changes,
  });
}

/** The repository files the packages are compared with */
export const REPOSITORY: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'ntfy-desk', version: VERSION }),
  LICENSE: 'Fixture license',
  'NOTICE.md': 'Fixture notices',
  'README.md': 'Fixture readme',
  'PRIVACY.md': 'Fixture privacy policy',
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'pnpm-workspace.yaml': 'patchedDependencies: {}',
  'tsconfig.json': '{}',
  'wxt.config.ts': 'export default {};',
  'public/fonts/LICENSE.txt': 'Fixture font license',
  'public/icon/128.png': 'icon',
  'entrypoints/background.ts': 'export default {};',
  'utils/ntfy.ts': 'export {};',
  'patches/example.patch': 'diff',
};

export function browserFiles(browser: 'chrome' | 'firefox', changes: Record<string, unknown> = {}): Record<string, string> {
  return {
    'manifest.json': manifest(browser, changes),
    LICENSE: 'Fixture license',
    'NOTICE.md': 'Fixture notices',
    'fonts/LICENSE.txt': 'Fixture font license',
    'fonts/roboto-400.woff2': 'font',
    'icon/16.png': 'icon',
    'icon/128.png': 'icon',
    'background.js': 'console.log("background")',
    'popup.html': '<link rel="stylesheet" href="/assets/popup-abc.css"><script type="module" src="/chunks/popup-abc.js"></script>',
    'assets/popup-abc.css': 'body {}',
    'chunks/popup-abc.js': 'export {};',
  };
}

export function write(root: string, name: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}

export function writePackage(root: string, kind: 'chrome' | 'firefox' | 'sources', entries: Entries, version = VERSION): void {
  write(root, `.output/ntfy-desk-${version}-${kind}.zip`, zip(entries));
}

/** A temporary repository whose three packages pass validation */
export function releaseFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ntfy-desk-release-'));
  for (const [name, content] of Object.entries(REPOSITORY)) write(root, name, content);
  writePackage(root, 'chrome', browserFiles('chrome'));
  writePackage(root, 'firefox', browserFiles('firefox'));
  writePackage(root, 'sources', REPOSITORY);
  return root;
}
