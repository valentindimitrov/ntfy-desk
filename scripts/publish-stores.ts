// node scripts/publish-stores.ts verify|chrome|firefox <version>: submits the packages of a published
// GitHub release to the Chrome Web Store and Firefox Add-ons (docs/store-publishing.md). The Publish to
// stores workflow downloads the release's files into .output first; nothing is built here.
//
// Imports only Node built-ins and release scripts that do the same, so the store jobs run it from a
// fresh checkout without installing dependencies: no dependency code runs next to the store credentials.
// API references: https://developer.chrome.com/docs/webstore/using-api (v2) and
// https://mozilla.github.io/addons-server/topics/api/addons.html (v5).

import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCrx3 } from './crx3.ts';
import { PUBLIC_KEY_PATH } from './sign-chrome.ts';
import { EXTENSION, VERSION_PATTERN, packagePath, readZip } from './validate-packages.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHROME_API = 'https://chromewebstore.googleapis.com';
const AMO_API = 'https://addons.mozilla.org/api/v5';
/** Item states that mean the submission was accepted (in review, staged or live) */
const CHROME_ACCEPTED_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

export type ChromePublishType = 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';

export type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export type StoreOptions = {
  /** Repository root: the packages are read from its .output folder, the CRX public key from the checkout */
  root?: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(bytes: Buffer | undefined, label: string): Record<string, unknown> {
  requireCondition(bytes, `${label} is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  requireCondition(isObject(parsed), `${label} is not an object`);
  return parsed;
}

/** True when CRX signing is on in this checkout: the Chromium package is then the signed CRX */
export function signingEnabled(root = repositoryRoot): boolean {
  return existsSync(join(root, PUBLIC_KEY_PATH));
}

/** The file submitted to the Chrome Web Store: the CRX when signing is on, else the ZIP */
export function chromePackage(version: string, root = repositoryRoot): string {
  return packagePath(root, version, 'chrome', signingEnabled(root) ? 'crx' : 'zip');
}

/**
 * Checks the downloaded release packages before any store sees them: both manifests name ntfy Desk at the
 * requested version, the Firefox add-on id is ours, the sources package has the same version, and, when
 * signing is on, the CRX is signed with the committed public key and carries exactly the Chromium ZIP.
 */
export function verifyStorePackages(version: string, root = repositoryRoot): void {
  requireCondition(VERSION_PATTERN.test(version), `Invalid version: ${version}`);
  const read = (kind: string, extension = 'zip') => {
    const file = packagePath(root, version, kind, extension);
    requireCondition(existsSync(file), `Missing release file: ${basename(file)}`);
    return readFileSync(file);
  };

  const chromeZip = read('chrome');
  if (signingEnabled(root)) {
    const publicKey = readFileSync(join(root, PUBLIC_KEY_PATH));
    requireCondition(verifyCrx3(read('chrome', 'crx'), publicKey).equals(chromeZip), 'The CRX does not carry the Chromium ZIP');
  }

  const manifests = {
    Chromium: readJson(readZip(chromeZip, 'Chromium ZIP').get('manifest.json'), 'Chromium ZIP: manifest.json'),
    Firefox: readJson(readZip(read('firefox'), 'Firefox ZIP').get('manifest.json'), 'Firefox ZIP: manifest.json'),
  };
  for (const [label, manifest] of Object.entries(manifests)) {
    requireCondition(manifest['manifest_version'] === 3, `${label} ZIP: expected Manifest V3`);
    requireCondition(manifest['name'] === EXTENSION.name, `${label} ZIP: the extension name is not ${EXTENSION.name}`);
    requireCondition(manifest['version'] === version, `${label} ZIP: version ${String(manifest['version'])} is not ${version}`);
  }
  const settings = manifests.Firefox['browser_specific_settings'];
  const gecko = isObject(settings) ? settings['gecko'] : undefined;
  requireCondition(isObject(gecko) && gecko['id'] === EXTENSION.firefoxId, `Firefox ZIP: the add-on id is not ${EXTENSION.firefoxId}`);

  const sources = readJson(readZip(read('sources'), 'Sources ZIP').get('package.json'), 'Sources ZIP: package.json');
  requireCondition(sources['version'] === version, `Sources ZIP: package.json version is not ${version}`);
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result;
}

/** Keeps only an API's own error message: never the request, its headers or a raw body */
function errorDetail(body: unknown): string {
  if (!isObject(body)) return '';
  const google = body['error'];
  if (isObject(google) && typeof google['message'] === 'string') return google['message'];
  if (typeof body['error_description'] === 'string') return body['error_description'];
  if (typeof google === 'string') return google;
  if (typeof body['detail'] === 'string') return body['detail'];
  for (const [field, value] of Object.entries(body)) {
    if (Array.isArray(value) && typeof value[0] === 'string') return `${field}: ${value[0]}`;
  }
  return '';
}

async function requestJson(
  fetchImpl: typeof fetch,
  service: string,
  url: string,
  init: RequestInit,
  secrets: readonly string[],
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    // Every request has a time limit; a redirect would carry the authorization elsewhere
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
  } catch {
    throw new Error(`${service}: no response (network error or time limit)`);
  }
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    // Control characters out, so the message stays one line in the log
    const detail = redact(errorDetail(body), secrets)
      .replace(/\p{Cc}+/gu, ' ')
      .slice(0, 300);
    throw new Error(`${service}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  requireCondition(isObject(body), `${service}: unexpected response`);
  return body;
}

export type ChromeConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  publisherId: string;
  extensionId: string;
  publishType: ChromePublishType;
};

export type ChromeResult = { file: string; state: string; warnings: string[] };

export async function publishChrome(
  version: string,
  config: ChromeConfig,
  { root = repositoryRoot, fetchImpl = fetch, clock = realClock }: StoreOptions = {},
): Promise<ChromeResult> {
  const secrets = [config.clientId, config.clientSecret, config.refreshToken];
  const token = await requestJson(
    fetchImpl,
    'Chrome OAuth token',
    CHROME_TOKEN_URL,
    {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }),
    },
    secrets,
  );
  const accessToken = token['access_token'];
  requireCondition(typeof accessToken === 'string' && accessToken, 'Chrome OAuth token: no access token');
  secrets.push(accessToken);
  const authorization = { Authorization: `Bearer ${accessToken}` };
  const item = `publishers/${encodeURIComponent(config.publisherId)}/items/${encodeURIComponent(config.extensionId)}`;

  const file = chromePackage(version, root);
  const signed = file.endsWith('.crx');
  const upload = await requestJson(
    fetchImpl,
    'Chrome Web Store upload',
    `${CHROME_API}/upload/v2/${item}:upload`,
    {
      method: 'POST',
      headers: {
        ...authorization,
        ...(signed
          ? { 'Content-Type': 'application/octet-stream', 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': basename(file) }
          : { 'Content-Type': 'application/zip' }),
      },
      body: new Uint8Array(readFileSync(file)),
    },
    secrets,
  );

  let state = upload['uploadState'];
  const deadline = clock.now() + 10 * 60_000;
  while (state === 'IN_PROGRESS') {
    requireCondition(clock.now() < deadline, 'Chrome Web Store upload: still processing after 10 minutes');
    await clock.sleep(10_000);
    const status = await requestJson(
      fetchImpl,
      'Chrome Web Store status',
      `${CHROME_API}/v2/${item}:fetchStatus`,
      { headers: authorization },
      secrets,
    );
    state = status['lastAsyncUploadState'];
  }
  requireCondition(state === 'SUCCEEDED', `Chrome Web Store upload: ended as ${String(state)}`);
  const uploadedVersion = upload['crxVersion'];
  requireCondition(
    uploadedVersion === undefined || uploadedVersion === version,
    `Chrome Web Store upload: the store read version ${String(uploadedVersion)}, not ${version}`,
  );

  const published = await requestJson(
    fetchImpl,
    'Chrome Web Store publish',
    `${CHROME_API}/v2/${item}:publish`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishType: config.publishType }),
    },
    secrets,
  );
  const publishedState = String(published['state']);
  requireCondition(CHROME_ACCEPTED_STATES.has(publishedState), `Chrome Web Store publish: the item is ${publishedState}`);
  const warningInfo = published['warningInfo'];
  const warnings =
    isObject(warningInfo) && Array.isArray(warningInfo['warnings'])
      ? warningInfo['warnings'].flatMap((warning) =>
          isObject(warning) && typeof warning['description'] === 'string' ? [redact(warning['description'], secrets).slice(0, 300)] : [],
        )
      : [];
  return { file: basename(file), state: publishedState, warnings };
}

/** AMO API token: HS256, a fresh `jti` and an expiry well inside AMO's five-minute limit */
export function amoToken(issuer: string, secret: string, nowSeconds: number, jti: string = randomUUID()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: issuer, jti, iat: nowSeconds, exp: nowSeconds + 60 })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

function validationSummary(validation: unknown, secrets: readonly string[]): string {
  const messages = isObject(validation) && Array.isArray(validation['messages']) ? validation['messages'] : [];
  const errors = messages.filter((message): message is Record<string, unknown> => isObject(message) && message['type'] === 'error');
  const first = errors
    .slice(0, 3)
    .map((message) => (typeof message['message'] === 'string' ? redact(message['message'], secrets).slice(0, 200) : 'error'));
  return `${errors.length} error(s)${first.length ? `: ${first.join('; ')}` : ''}`;
}

export type FirefoxConfig = { issuer: string; secret: string };

export type FirefoxResult = { version: string; fileStatus: string };

export async function publishFirefox(
  version: string,
  config: FirefoxConfig,
  { root = repositoryRoot, fetchImpl = fetch, clock = realClock }: StoreOptions = {},
): Promise<FirefoxResult> {
  const secrets = [config.issuer, config.secret];
  // A new token for every request: each one expires a minute after it is made
  const authorization = () => ({ Authorization: `JWT ${amoToken(config.issuer, config.secret, Math.floor(clock.now() / 1000))}` });
  const attach = (form: FormData, field: string, kind: string) => {
    const file = packagePath(root, version, kind);
    form.append(field, new Blob([new Uint8Array(readFileSync(file))], { type: 'application/zip' }), basename(file));
  };

  const uploadForm = new FormData();
  attach(uploadForm, 'upload', 'firefox');
  uploadForm.append('channel', 'listed');
  let upload = await requestJson(
    fetchImpl,
    'AMO upload',
    `${AMO_API}/addons/upload/`,
    { method: 'POST', headers: authorization(), body: uploadForm },
    secrets,
  );
  const uuid = upload['uuid'];
  requireCondition(typeof uuid === 'string' && /^[0-9a-f-]+$/i.test(uuid), 'AMO upload: no upload id');

  const deadline = clock.now() + 15 * 60_000;
  while (upload['processed'] !== true) {
    requireCondition(clock.now() < deadline, 'AMO upload: validation still running after 15 minutes');
    await clock.sleep(5_000);
    upload = await requestJson(fetchImpl, 'AMO upload status', `${AMO_API}/addons/upload/${uuid}/`, { headers: authorization() }, secrets);
  }
  requireCondition(upload['valid'] === true, `AMO validation failed, ${validationSummary(upload['validation'], secrets)}`);
  requireCondition(
    upload['version'] === undefined || upload['version'] === version,
    `AMO upload: the store read version ${String(upload['version'])}, not ${version}`,
  );

  // The sources go with the version, in the same request: reviewers rebuild from them
  const versionForm = new FormData();
  versionForm.append('upload', uuid);
  attach(versionForm, 'source', 'sources');
  const created = await requestJson(
    fetchImpl,
    'AMO version',
    `${AMO_API}/addons/addon/${encodeURIComponent(EXTENSION.firefoxId)}/versions/`,
    { method: 'POST', headers: authorization(), body: versionForm },
    secrets,
  );
  requireCondition(created['version'] === version, `AMO version: created ${String(created['version'])}, not ${version}`);
  const file = created['file'];
  return { version, fileStatus: isObject(file) && typeof file['status'] === 'string' ? file['status'] : 'unknown' };
}

/** Reads a required value and removes it from the environment, as the signer does with its key */
function takeEnv(name: string): string {
  const value = process.env[name]?.trim();
  delete process.env[name];
  requireCondition(value, `${name} is not set`);
  return value;
}

export function chromePublishType(input: string): ChromePublishType {
  if (input === 'publish-after-review') return 'DEFAULT_PUBLISH';
  if (input === 'stage-for-manual-publish') return 'STAGED_PUBLISH';
  throw new Error(`Unknown Chrome publish type: ${input}`);
}

async function main(argv: string[]): Promise<void> {
  // Credentials out of the environment before anything else runs
  const take = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const chromeEnv = take(['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN']);
  const amoEnv = take(['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']);
  for (const name of [...Object.keys(chromeEnv), ...Object.keys(amoEnv)]) delete process.env[name];
  const secret = (values: Record<string, string | undefined>, name: string) => {
    const value = values[name]?.trim();
    requireCondition(value, `${name} is not set`);
    return value;
  };

  const [command, version] = argv;
  requireCondition(
    argv.length === 2 && version && VERSION_PATTERN.test(version),
    'Usage: node scripts/publish-stores.ts verify|chrome|firefox <version>',
  );
  verifyStorePackages(version);
  if (command === 'verify') {
    console.log(`Verified the release packages of ${version}; the Chrome Web Store gets ${basename(chromePackage(version))}.`);
  } else if (command === 'chrome') {
    const result = await publishChrome(version, {
      clientId: secret(chromeEnv, 'CHROME_CLIENT_ID'),
      clientSecret: secret(chromeEnv, 'CHROME_CLIENT_SECRET'),
      refreshToken: secret(chromeEnv, 'CHROME_REFRESH_TOKEN'),
      publisherId: takeEnv('CHROME_PUBLISHER_ID'),
      extensionId: takeEnv('CHROME_EXTENSION_ID'),
      publishType: chromePublishType(takeEnv('CHROME_PUBLISH_TYPE')),
    });
    console.log(`Chrome Web Store: submitted ${result.file}, the item is ${result.state}.`);
    for (const warning of result.warnings) console.log(`Chrome Web Store warning: ${warning}`);
  } else if (command === 'firefox') {
    const result = await publishFirefox(version, { issuer: secret(amoEnv, 'AMO_JWT_ISSUER'), secret: secret(amoEnv, 'AMO_JWT_SECRET') });
    console.log(`Firefox Add-ons: submitted ${result.version}, its file is ${result.fileStatus}.`);
  } else {
    throw new Error(`Unknown command: ${String(command)}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Messages thrown here are this script's own, with API messages redacted
    console.error(error instanceof Error ? error.message : 'Store publishing failed');
    process.exitCode = 1;
  });
}
