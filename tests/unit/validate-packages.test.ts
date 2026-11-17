import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readZip, validatePackages } from '../../scripts/validate-packages.ts';
import { REPOSITORY, VERSION, browserFiles, releaseFixture, write, writePackage, zip } from './helpers/release-fixture';

let root: string;
beforeEach(() => {
  root = releaseFixture();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validatePackages', () => {
  it('accepts the three packages of a release build', () => {
    expect(() => validatePackages(root)).not.toThrow();
    expect(console.log).toHaveBeenCalledTimes(3);
  });

  it('refuses a missing package', () => {
    rmSync(`${root}/.output/ntfy-desk-${VERSION}-firefox.zip`);
    expect(() => validatePackages(root)).toThrow(`ntfy-desk-${VERSION}-firefox.zip is missing`);
  });

  it('refuses a package.json version that is not a release version', () => {
    write(root, 'package.json', JSON.stringify({ version: '1.0.0-beta' }));
    expect(() => validatePackages(root)).toThrow('version must be two to four numbers');
  });

  it.each([
    ['a manifest of another version', { version: '1.2.4' }, 'does not match package.json version 1.2.3'],
    ['another name', { name: 'ntfy Desk (dev)' }, 'extension name'],
    ['an added permission', { permissions: ['activeTab', 'storage', 'tabs'] }, 'permissions differ'],
    ['a required host permission', { host_permissions: ['<all_urls>'] }, 'host_permissions must not be in the manifest'],
    ['a changed optional permission', { optional_permissions: ['tabs', 'history'] }, 'optional_permissions differ'],
    ['a narrower optional host permission', { optional_host_permissions: ['https://*/*'] }, 'optional_host_permissions differ'],
    ['a content script', { content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }] }, 'content_scripts must not be'],
    [
      'its own content security policy',
      { content_security_policy: { extension_pages: "script-src 'self' https://example.com" } },
      'content security policy',
    ],
    ['an added command', { commands: { 'open-popup': {}, 'send-page': {}, other: {} } }, 'commands differ'],
    ['a description beyond the store limit', { description: 'x'.repeat(133) }, '132 characters'],
    ['a popup that is not packaged', { action: { default_popup: 'missing.html' } }, 'missing.html is missing'],
    ['a remote icon', { icons: { '128': 'https://example.com/icon.png' } }, 'not a file of the package'],
    ['Manifest V2', { manifest_version: 2 }, 'Manifest V3'],
  ])('refuses %s', (_name, changes, message) => {
    writePackage(root, 'chrome', browserFiles('chrome', changes));
    expect(() => validatePackages(root)).toThrow(message);
  });

  it('refuses Firefox settings in the Chromium package, and a Firefox package without its id', () => {
    writePackage(root, 'chrome', browserFiles('chrome', { browser_specific_settings: { gecko: { id: 'x@example.com' } } }));
    expect(() => validatePackages(root)).toThrow('Firefox-only settings');
    root = releaseFixture();
    writePackage(root, 'firefox', browserFiles('firefox', { browser_specific_settings: { gecko: { id: 'other@example.com' } } }));
    expect(() => validatePackages(root)).toThrow('add-on id must be ntfy-desk@valentindimitrov.github.io');
    writePackage(
      root,
      'firefox',
      browserFiles('firefox', {
        browser_specific_settings: {
          gecko: {
            id: 'ntfy-desk@valentindimitrov.github.io',
            strict_min_version: '142.0',
            data_collection_permissions: { required: ['none'] },
          },
        },
      }),
    );
    expect(() => validatePackages(root)).toThrow('data_collection_permissions differ');
  });

  it.each([
    ['LICENSE', 'LICENSE differs'],
    ['NOTICE.md', 'NOTICE.md differs'],
    ['fonts/LICENSE.txt', 'fonts/LICENSE.txt differs'],
  ])('refuses a package whose %s is not the repository file', (name, message) => {
    writePackage(root, 'firefox', { ...browserFiles('firefox'), [name]: 'Another text' });
    expect(() => validatePackages(root)).toThrow(message);
    const files = browserFiles('firefox');
    delete files[name];
    writePackage(root, 'firefox', files);
    expect(() => validatePackages(root)).toThrow(`${name} is missing`);
  });

  it.each(['background.js.map', 'chunks/popup-abc.js.map', '.DS_Store', 'store-listings/description.txt', 'popup.ts', 'key.pem'])(
    'refuses the stray file %s',
    (name) => {
      writePackage(root, 'chrome', { ...browserFiles('chrome'), [name]: '{}' });
      expect(() => validatePackages(root)).toThrow(`unexpected file ${name}`);
    },
  );

  it('refuses an E2E build, a source map reference and code from outside the package', () => {
    const hook = 'Object.assign(globalThis,{__ntfyRunCommand:run})';
    writePackage(root, 'chrome', { ...browserFiles('chrome'), 'background.js': hook });
    expect(() => validatePackages(root)).toThrow('E2E hook __ntfyRunCommand');
    writePackage(root, 'chrome', { ...browserFiles('chrome'), 'chunks/popup-abc.js': 'export {};\n//# sourceMappingURL=popup.js.map' });
    expect(() => validatePackages(root)).toThrow('refers to a source map');
    writePackage(root, 'chrome', { ...browserFiles('chrome'), 'popup.html': '<script src="https://example.com/a.js"></script>' });
    expect(() => validatePackages(root)).toThrow('from outside the package');
    writePackage(root, 'chrome', { ...browserFiles('chrome'), 'popup.html': '<script src="/chunks/gone.js"></script>' });
    expect(() => validatePackages(root)).toThrow('chunks/gone.js is missing');
  });

  it('requires a ZIP to be the unpacked build next to it', () => {
    for (const [name, content] of Object.entries(browserFiles('chrome'))) write(root, `.output/chrome-mv3/${name}`, content);
    expect(() => validatePackages(root)).not.toThrow();
    write(root, '.output/chrome-mv3/background.js', 'console.log("rebuilt")');
    expect(() => validatePackages(root)).toThrow('background.js differs from .output/chrome-mv3');
    write(root, '.output/chrome-mv3/chunks/extra.js', '');
    expect(() => validatePackages(root)).toThrow('files differ from .output/chrome-mv3');
  });

  it('requires the sources to be the repository files', () => {
    writePackage(root, 'sources', { ...REPOSITORY, 'utils/ntfy.ts': 'export const changed = true;' });
    expect(() => validatePackages(root)).toThrow("utils/ntfy.ts differs from the repository's utils/ntfy.ts");
    writePackage(root, 'sources', { ...REPOSITORY, 'utils/unknown.ts': '' });
    expect(() => validatePackages(root)).toThrow('utils/unknown.ts is not in the repository');
    writePackage(root, 'sources', { ...REPOSITORY, 'package.json': JSON.stringify({ version: '9.9.9' }) });
    expect(() => validatePackages(root)).toThrow('package.json differs');
  });

  it.each([
    'LICENSE',
    'NOTICE.md',
    'PRIVACY.md',
    'pnpm-lock.yaml',
    'public/fonts/LICENSE.txt',
    'entrypoints/background.ts',
    'patches/example.patch',
  ])('refuses sources without %s', (name) => {
    const files = { ...REPOSITORY };
    delete files[name];
    writePackage(root, 'sources', files);
    expect(() => validatePackages(root)).toThrow(`${name} is missing`);
  });

  it('refuses dependencies, build output, environment files and keys in the sources', () => {
    for (const name of [
      'node_modules/a/index.js',
      '.output/chrome-mv3/manifest.json',
      '.env',
      '.env.local',
      'playwright-report/index.html',
      'test-results/trace.zip',
      'release.crx',
      'signing.key',
    ]) {
      writePackage(root, 'sources', { ...REPOSITORY, [name]: '' });
      expect(() => validatePackages(root), name).toThrow('must not be packaged');
    }
    const key = ['-----BEGIN PRIVATE', 'KEY-----\nAAAA\n-----END PRIVATE', 'KEY-----'].join(' ');
    write(root, 'docs/notes.md', key);
    writePackage(root, 'sources', { ...REPOSITORY, 'docs/notes.md': key });
    expect(() => validatePackages(root)).toThrow('docs/notes.md contains a private key');
  });
});

describe('readZip', () => {
  const archive = zip({ 'a.txt': 'hello hello hello', 'folder/b.txt': '' });

  it('reads names and contents', () => {
    const files = readZip(archive);
    expect([...files.keys()]).toEqual(['a.txt', 'folder/b.txt']);
    expect(files.get('a.txt')?.toString()).toBe('hello hello hello');
    expect(files.get('folder/b.txt')?.length).toBe(0);
  });

  it('refuses damaged, truncated and unsafe archives', () => {
    expect(() => readZip(Buffer.from('not a zip archive at all, only text'))).toThrow('not a ZIP archive');
    expect(() => readZip(archive.subarray(0, archive.length - 30))).toThrow();
    const damaged = Buffer.from(archive);
    // Inside the first entry's CRC-32 in the central directory
    const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    damaged[central + 16] = (damaged[central + 16] ?? 0) ^ 0xff;
    expect(() => readZip(damaged)).toThrow('fails its size or CRC-32 check');
    expect(() => readZip(zip({ '../outside.txt': '' }))).toThrow('unsafe entry name');
    expect(() => readZip(zip({ '/absolute.txt': '' }))).toThrow('unsafe entry name');
  });
});
