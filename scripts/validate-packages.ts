// pnpm verify:packages: checks the three release ZIPs in .output (Chromium, Firefox, sources) against
// this checkout before they are published. CI runs it on every push, and the Prepare release workflow
// runs it twice: after building, and again in the signing job on the downloaded packages.
//
// Imports only Node built-ins, so the signing job can run it from a fresh checkout without installing
// dependencies (Node 24: TypeScript type stripping). Options: --root <dir> (default: the repository).
//
// The expected manifest values are written out here on purpose, not read from wxt.config.ts: a changed
// permission has to be changed here too, and justified in assets/store-listings/.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXTENSION = {
  name: 'ntfy Desk',
  /** Start of every package file name: ntfy-desk-<version>-<chrome|firefox|sources>.zip */
  artifact: 'ntfy-desk',
  firefoxId: 'ntfy-desk@valentindimitrov.github.io',
  permissions: ['activeTab', 'alarms', 'contextMenus', 'notifications', 'scripting', 'storage', 'unlimitedStorage'],
  optionalPermissions: ['tabs'],
  optionalHostPermissions: ['<all_urls>'],
  commands: ['open-popup', 'send-page'],
  firefoxDataCollection: ['authenticationInfo', 'browsingActivity', 'personalCommunications', 'websiteContent'],
} as const;

/** Chrome and Firefox both accept one to four dot-separated numbers; a release uses at least two */
export const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

/** License files every extension ZIP carries: path in the ZIP, path in the repository */
const BROWSER_NOTICES = [
  ['LICENSE', 'LICENSE'],
  ['NOTICE.md', 'NOTICE.md'],
  ['fonts/LICENSE.txt', 'public/fonts/LICENSE.txt'],
] as const;

/** Everything an extension ZIP may contain. A new kind of file is added here once it is meant to ship. */
const BROWSER_FILES = [
  /^(?:LICENSE|NOTICE\.md|manifest\.json|background\.js)$/,
  /^[a-z][a-z-]*\.html$/,
  /^assets\/[\w.-]+\.css$/,
  /^chunks\/[\w.-]+\.js$/,
  /^fonts\/(?:LICENSE\.txt|[\w-]+\.woff2)$/,
  /^icon\/\d+\.png$/,
];

/** What a reviewer needs to rebuild the extension from the sources ZIP */
const SOURCE_FILES = [
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'PRIVACY.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'wxt.config.ts',
  'public/fonts/LICENSE.txt',
];
/** Every file of these repository folders has to be in the sources ZIP: the build reads them */
const SOURCE_FOLDERS = ['entrypoints', 'utils', 'public', 'patches'];

/** Never part of the sources ZIP: dependencies, build and test output */
const GENERATED_FOLDERS = ['node_modules', '.output', '.wxt', '.git', 'playwright-report', 'test-results'];

/** Present only in the E2E build (entrypoints/background.ts, MODE === 'e2e'): must never ship */
const E2E_HOOK = /__ntfy[A-Z]\w*/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/;
const TEXT_FILE = /\.(?:js|mjs|ts|html|css|json|md|txt|ya?ml|toml|pem|patch)$|^[^.]+$/;

type Files = Map<string, Buffer>;
type Target = { browser: 'chrome' | 'firefox'; directory: string };

const TARGETS: Target[] = [
  { browser: 'chrome', directory: '.output/chrome-mv3' },
  { browser: 'firefox', directory: '.output/firefox-mv3' },
];

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The same strings, in any order */
function sameSet(actual: unknown, expected: readonly string[]): boolean {
  return isStringArray(actual) && JSON.stringify(actual.toSorted()) === JSON.stringify(expected.toSorted());
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function readPackageVersion(root: string): string {
  const metadata = parseJson(readFileSync(join(root, 'package.json')), 'package.json');
  const version = isObject(metadata) ? metadata['version'] : undefined;
  requireCondition(typeof version === 'string' && VERSION_PATTERN.test(version), 'package.json: version must be two to four numbers');
  return version;
}

/** Path of a release package: kind is chrome, firefox or sources */
export function packagePath(root: string, version: string, kind: string, extension = 'zip'): string {
  return join(root, '.output', `${EXTENSION.artifact}-${version}-${kind}.${extension}`);
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/**
 * Reads every file of a ZIP into memory. The release ZIPs are small, so this supports only what WXT
 * writes: stored or deflated entries, no ZIP64, encryption or several disks. Names, sizes and CRC-32
 * values are all checked.
 */
export function readZip(archive: Buffer, label = 'ZIP archive'): Files {
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 0xffff - 22); offset--) {
    if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  requireCondition(end >= 0, `${label}: not a ZIP archive`);
  const entryCount = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  requireCondition(
    archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0 && archive.readUInt16LE(end + 8) === entryCount,
    `${label}: archives on several disks are not supported`,
  );
  requireCondition(entryCount !== 0xffff && directoryOffset !== 0xffffffff, `${label}: ZIP64 archives are not supported`);
  requireCondition(directoryOffset + directorySize <= end, `${label}: central directory is out of bounds`);

  const files: Files = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    requireCondition(
      cursor + 46 <= end && archive.readUInt32LE(cursor) === ZIP_CENTRAL_HEADER,
      `${label}: central directory entry ${index} is malformed`,
    );
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    requireCondition(cursor + 46 + nameLength <= end, `${label}: central directory entry ${index} is malformed`);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    requireCondition(
      name.length > 0 &&
        !name.includes('\\') &&
        !name.startsWith('/') &&
        !/^[a-z]:/i.test(name) &&
        !name.split('/').some((part) => part === '..' || part === '.'),
      `${label}: unsafe entry name ${JSON.stringify(name)}`,
    );
    requireCondition((flags & 1) === 0, `${label}: ${name} is encrypted`);
    requireCondition(!files.has(name), `${label}: ${name} appears more than once`);
    if (name.endsWith('/')) continue;

    requireCondition(
      localOffset + 30 <= directoryOffset && archive.readUInt32LE(localOffset) === ZIP_LOCAL_HEADER,
      `${label}: local header for ${name} is malformed`,
    );
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    requireCondition(dataStart + compressedSize <= directoryOffset, `${label}: ${name} is out of bounds`);
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) {
      try {
        data = inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new Error(`${label}: ${name} cannot be decompressed`);
      }
    } else throw new Error(`${label}: ${name} uses unsupported compression method ${method}`);
    requireCondition(data.length === size && crc32(data) === checksum, `${label}: ${name} fails its size or CRC-32 check`);
    files.set(name, data);
  }
  return files;
}

/** Files below a directory, as forward-slash paths relative to it; names starting with a dot are skipped */
function listFiles(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(directory, relative);
    return entry.isFile() ? [relative] : [];
  });
}

function readPackage(root: string, version: string, kind: string): { label: string; files: Files } {
  const file = packagePath(root, version, kind);
  const label = `${EXTENSION.artifact}-${version}-${kind}.zip`;
  requireCondition(existsSync(file), `${label} is missing from .output`);
  return { label, files: readZip(readFileSync(file), label) };
}

function requireFile(files: Files, name: string, label: string): Buffer {
  const data = files.get(name);
  requireCondition(data, `${label}: ${name} is missing`);
  return data;
}

function requireSameAsRepository(files: Files, name: string, root: string, repositoryPath: string, label: string): void {
  requireCondition(existsSync(join(root, repositoryPath)), `${label}: ${repositoryPath} is not in the repository`);
  requireCondition(
    requireFile(files, name, label).equals(readFileSync(join(root, repositoryPath))),
    `${label}: ${name} differs from the repository's ${repositoryPath}`,
  );
}

function requireNoSecrets(files: Files, label: string): void {
  for (const [name, data] of files) {
    if (!TEXT_FILE.test(name)) continue;
    requireCondition(!PRIVATE_KEY.test(data.toString('latin1')), `${label}: ${name} contains a private key`);
  }
}

function localReference(reference: unknown): reference is string {
  return typeof reference === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(reference) && !reference.startsWith('//');
}

function validateManifest(manifest: unknown, target: Target, version: string, files: Files, label: string): void {
  requireCondition(isObject(manifest), `${label}: manifest.json must hold an object`);
  requireCondition(manifest['manifest_version'] === 3, `${label}: expected Manifest V3`);
  requireCondition(manifest['name'] === EXTENSION.name, `${label}: the extension name must be ${EXTENSION.name}`);
  requireCondition(
    manifest['version'] === version,
    `${label}: manifest version ${JSON.stringify(manifest['version'])} does not match package.json version ${version}`,
  );
  const description = manifest['description'];
  requireCondition(
    typeof description === 'string' && description.length > 0 && description.length <= 132,
    `${label}: the description must have 1 to 132 characters (Chrome Web Store summary)`,
  );
  requireCondition(
    sameSet(manifest['permissions'], EXTENSION.permissions),
    `${label}: permissions differ from the expected list (scripts/validate-packages.ts)`,
  );
  requireCondition(
    sameSet(manifest['optional_permissions'], EXTENSION.optionalPermissions),
    `${label}: optional_permissions differ from the expected list`,
  );
  requireCondition(
    sameSet(manifest['optional_host_permissions'], EXTENSION.optionalHostPermissions),
    `${label}: optional_host_permissions differ from the expected list`,
  );
  for (const key of ['host_permissions', 'content_scripts', 'web_accessible_resources', 'externally_connectable', 'key', 'update_url']) {
    requireCondition(manifest[key] === undefined, `${label}: ${key} must not be in the manifest`);
  }
  requireCondition(manifest['content_security_policy'] === undefined, `${label}: the default content security policy must apply`);
  const commands = manifest['commands'];
  requireCondition(
    isObject(commands) && sameSet(Object.keys(commands), EXTENSION.commands),
    `${label}: commands differ from the expected list`,
  );

  const background = manifest['background'];
  requireCondition(isObject(background), `${label}: background is missing`);
  const gecko = isObject(manifest['browser_specific_settings']) ? manifest['browser_specific_settings']['gecko'] : undefined;
  let backgroundFile: unknown;
  if (target.browser === 'firefox') {
    const scripts = background['scripts'];
    requireCondition(isStringArray(scripts) && scripts.length === 1, `${label}: one background script is expected`);
    backgroundFile = scripts[0];
    requireCondition(
      isObject(gecko) && gecko['id'] === EXTENSION.firefoxId,
      `${label}: the Firefox add-on id must be ${EXTENSION.firefoxId}`,
    );
    requireCondition(typeof gecko['strict_min_version'] === 'string', `${label}: strict_min_version is missing`);
    const collection = gecko['data_collection_permissions'];
    requireCondition(
      isObject(collection) && sameSet(collection['required'], EXTENSION.firefoxDataCollection),
      `${label}: data_collection_permissions differ from the expected list`,
    );
  } else {
    backgroundFile = background['service_worker'];
    requireCondition(manifest['browser_specific_settings'] === undefined, `${label}: Firefox-only settings must not be packaged`);
  }

  const action = manifest['action'];
  const icons = manifest['icons'];
  requireCondition(isObject(action) && isObject(icons), `${label}: action or icons are missing`);
  requireCondition(icons['128'] !== undefined, `${label}: the 128 px icon is missing`);
  for (const reference of [backgroundFile, action['default_popup'], ...Object.values(icons)]) {
    requireCondition(localReference(reference), `${label}: the manifest refers to something that is not a file of the package`);
    requireFile(files, reference.replace(/^\/+/, ''), label);
  }
}

function validateBrowserPackage(target: Target, version: string, root: string): void {
  const { label, files } = readPackage(root, version, target.browser);
  validateManifest(parseJson(requireFile(files, 'manifest.json', label), `${label}: manifest.json`), target, version, files, label);
  for (const [name, repositoryPath] of BROWSER_NOTICES) requireSameAsRepository(files, name, root, repositoryPath, label);

  for (const [name, data] of files) {
    requireCondition(
      BROWSER_FILES.some((pattern) => pattern.test(name)),
      `${label}: unexpected file ${name} (source maps and stray files must not ship; extend BROWSER_FILES if it is meant to)`,
    );
    if (!/\.(?:js|html|css)$/.test(name)) continue;
    const text = data.toString('utf8');
    const hook = E2E_HOOK.exec(text)?.[0];
    requireCondition(!hook, `${label}: ${name} contains the E2E hook ${hook}: this is an E2E build, not a release build`);
    requireCondition(!text.includes('sourceMappingURL'), `${label}: ${name} refers to a source map`);
    if (!name.endsWith('.html')) continue;
    // No remote code: every script and stylesheet of a page is a file of the package
    for (const tag of text.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const reference = /\b(?:src|href)=["']([^"']*)["']/i.exec(tag[0])?.[1];
      if (reference === undefined) continue;
      requireCondition(localReference(reference), `${label}: ${name} loads ${reference} from outside the package`);
      requireFile(files, reference.replace(/^\/+/, ''), label);
    }
  }
  requireNoSecrets(files, label);

  // Next to its unpacked build (the build job, a local run), the ZIP must be that build exactly
  const buildDirectory = join(root, target.directory);
  if (existsSync(buildDirectory)) {
    const built = listFiles(buildDirectory).toSorted();
    requireCondition(
      JSON.stringify([...files.keys()].toSorted()) === JSON.stringify(built),
      `${label}: files differ from ${target.directory}`,
    );
    for (const name of built) {
      requireCondition(
        requireFile(files, name, label).equals(readFileSync(join(buildDirectory, name))),
        `${label}: ${name} differs from ${target.directory}`,
      );
    }
  }
  console.log(`Validated ${label} (${files.size} files, version ${version}).`);
}

function validateSourcesPackage(version: string, root: string): void {
  const { label, files } = readPackage(root, version, 'sources');
  for (const name of SOURCE_FILES) requireFile(files, name, label);
  for (const folder of SOURCE_FOLDERS) {
    if (!existsSync(join(root, folder))) continue;
    for (const name of listFiles(join(root, folder))) requireFile(files, `${folder}/${name}`, label);
  }
  for (const name of files.keys()) {
    const parts = name.split('/');
    requireCondition(
      !parts.some((part) => GENERATED_FOLDERS.includes(part)),
      `${label}: generated or dependency file ${name} must not be packaged`,
    );
    requireCondition(!/^\.env(?:\..*)?$/.test(parts.at(-1) ?? ''), `${label}: environment file ${name} must not be packaged`);
    requireCondition(!/\.(?:crx|key|p12|pfx)$/i.test(name), `${label}: ${name} must not be packaged`);
    // The sources are this commit's: the reviewer builds what the repository holds
    requireSameAsRepository(files, name, root, name, label);
  }
  requireNoSecrets(files, label);
  console.log(`Validated ${label} (${files.size} files, identical to the repository).`);
}

/** Validates the three release ZIPs in <root>/.output against the repository files in <root> */
export function validatePackages(root = repositoryRoot): void {
  const version = readPackageVersion(root);
  for (const target of TARGETS) validateBrowserPackage(target, version, root);
  validateSourcesPackage(version, root);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const custom = args[0] === '--root' && args.length === 2 ? args[1] : undefined;
    if (args.length > 0 && custom === undefined) throw new Error('Usage: node scripts/validate-packages.ts [--root <dir>]');
    validatePackages(custom === undefined ? repositoryRoot : resolve(custom));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
