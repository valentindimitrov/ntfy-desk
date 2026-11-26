import { createHmac, generateKeyPairSync } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signCrx3 } from '../../scripts/crx3.ts';
import {
  type Clock,
  amoToken,
  chromePackage,
  chromePublishType,
  publishChrome,
  publishFirefox,
  verifyStorePackages,
} from '../../scripts/publish-stores.ts';
import { PUBLIC_KEY_PATH } from '../../scripts/sign-chrome.ts';
import { EXTENSION, packagePath } from '../../scripts/validate-packages.ts';
import { REPOSITORY, VERSION, browserFiles, manifest, releaseFixture, write, writePackage, zip } from './helpers/release-fixture';

// Throwaway keys, generated for this run only
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' });

let root: string;
beforeEach(() => {
  root = releaseFixture();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (kind: string, extension = 'zip') => packagePath(root, VERSION, kind, extension);

/** Turns signing on in the fixture and writes the CRX of its Chromium ZIP */
function sign(privateKey: string | Buffer = privatePem, publicKey: string | Buffer = publicPem): void {
  write(root, PUBLIC_KEY_PATH, publicPem);
  const archive = zip(browserFiles('chrome'));
  writePackage(root, 'chrome', browserFiles('chrome'));
  write(root, `.output/ntfy-desk-${VERSION}-chrome.crx`, signCrx3(archive, privateKey, publicKey));
}

it('accepts the release packages, with or without CRX signing', () => {
  expect(() => verifyStorePackages(VERSION, root)).not.toThrow();
  expect(chromePackage(VERSION, root)).toBe(file('chrome'));
  sign();
  expect(() => verifyStorePackages(VERSION, root)).not.toThrow();
  expect(chromePackage(VERSION, root)).toBe(file('chrome', 'crx'));
});

it.each([
  [
    'a CRX signed with another key',
    () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
      sign(other.privateKey.export({ format: 'pem', type: 'pkcs8' }), other.publicKey.export({ format: 'pem', type: 'spki' }));
    },
    /public key|signature/i,
  ],
  [
    'a CRX of another ZIP',
    () => {
      sign();
      writePackage(root, 'chrome', { ...browserFiles('chrome'), 'background.js': 'console.log("changed")' });
    },
    'does not carry the Chromium ZIP',
  ],
  [
    'a missing CRX while signing is on',
    () => {
      sign();
      rmSync(file('chrome', 'crx'));
    },
    `Missing release file: ntfy-desk-${VERSION}-chrome.crx`,
  ],
  [
    'a Chromium package of another version',
    () => writePackage(root, 'chrome', { ...browserFiles('chrome'), 'manifest.json': manifest('chrome', { version: '1.0.0' }) }),
    'Chromium ZIP: version 1.0.0',
  ],
  [
    'another extension name',
    () => writePackage(root, 'firefox', { ...browserFiles('firefox'), 'manifest.json': manifest('firefox', { name: 'Other' }) }),
    'Firefox ZIP: the extension name',
  ],
  [
    'another Firefox add-on id',
    () =>
      writePackage(root, 'firefox', {
        ...browserFiles('firefox'),
        'manifest.json': manifest('firefox', { browser_specific_settings: { gecko: { id: 'other@example.invalid' } } }),
      }),
    'add-on id',
  ],
  [
    'a sources package of another version',
    () => writePackage(root, 'sources', { ...REPOSITORY, 'package.json': JSON.stringify({ version: '1.0.0', license: 'Apache-2.0' }) }),
    'Sources ZIP: package.json version',
  ],
  [
    "a sources package with a license AMO doesn't offer",
    () => writePackage(root, 'sources', { ...REPOSITORY, 'package.json': JSON.stringify({ version: VERSION, license: 'Apache 2.0' }) }),
    "license Apache 2.0 is not one of AMO's licenses",
  ],
  ['a missing Firefox package', () => rmSync(file('firefox')), 'Missing release file'],
])('rejects %s before any store upload', (_, prepare, message) => {
  prepare();
  expect(() => verifyStorePackages(VERSION, root)).toThrow(message);
});

it('rejects a version that is not two to four numbers', () => {
  expect(() => verifyStorePackages('v1.2.3', root)).toThrow('Invalid version');
});

it('maps the workflow choices to Chrome publish types', () => {
  expect(chromePublishType('publish-after-review')).toBe('DEFAULT_PUBLISH');
  expect(chromePublishType('stage-for-manual-publish')).toBe('STAGED_PUBLISH');
  expect(() => chromePublishType('DEFAULT_PUBLISH')).toThrow('Unknown Chrome publish type');
});

it('signs AMO tokens with HS256 and a one-minute expiry', () => {
  const [header, payload, signature] = amoToken('user:1:2', 'amo-secret', 1_000, 'nonce').split('.');
  expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toEqual({ iss: 'user:1:2', jti: 'nonce', iat: 1_000, exp: 1_060 });
  expect(signature).toBe(createHmac('sha256', 'amo-secret').update(`${header}.${payload}`).digest('base64url'));
});

type Call = { url: string; init: RequestInit };

/** Answers each request with the next response, which must match its URL */
function fakeFetch(responses: Array<[RegExp, number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const next = responses.shift();
    if (!next?.[0].test(url)) return Promise.reject(new Error(`Unexpected request to ${url}`));
    return Promise.resolve(new Response(JSON.stringify(next[2]), { status: next[1] }));
  }) as typeof fetch;
  return { calls, fetchImpl, remaining: responses };
}

function fakeClock(): Clock & { slept: number } {
  let time = 1_000_000;
  const clock = {
    slept: 0,
    now: () => time,
    sleep: (milliseconds: number) => {
      clock.slept += milliseconds;
      time += milliseconds;
      return Promise.resolve();
    },
  };
  return clock;
}

const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string> | undefined)?.[name];

const chromeConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
  publisherId: 'publisher',
  extensionId: 'extension',
  publishType: 'STAGED_PUBLISH' as const,
};

it('uploads the signed CRX, waits for processing and submits it', async () => {
  sign();
  const store = fakeFetch([
    [/^https:\/\/oauth2\.googleapis\.com\/token$/, 200, { access_token: 'access' }],
    [/\/upload\/v2\/publishers\/publisher\/items\/extension:upload$/, 200, { uploadState: 'IN_PROGRESS' }],
    [/\/v2\/publishers\/publisher\/items\/extension:fetchStatus$/, 200, { lastAsyncUploadState: 'IN_PROGRESS' }],
    [/:fetchStatus$/, 200, { lastAsyncUploadState: 'SUCCEEDED' }],
    [/\/v2\/publishers\/publisher\/items\/extension:publish$/, 200, { state: 'PENDING_REVIEW' }],
  ]);
  const clock = fakeClock();

  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl, clock })).resolves.toEqual({
    file: `ntfy-desk-${VERSION}-chrome.crx`,
    state: 'PENDING_REVIEW',
    warnings: [],
  });
  expect(store.remaining).toEqual([]);
  expect(clock.slept).toBeGreaterThan(0);
  const upload = store.calls[1];
  expect(upload?.init.headers).toMatchObject({
    Authorization: 'Bearer access',
    'X-Goog-Upload-Protocol': 'raw',
    'X-Goog-Upload-File-Name': `ntfy-desk-${VERSION}-chrome.crx`,
  });
  expect(
    Buffer.from(upload?.init.body as Uint8Array)
      .subarray(0, 4)
      .toString(),
  ).toBe('Cr24');
  expect(JSON.parse(store.calls[4]?.init.body as string)).toEqual({ publishType: 'STAGED_PUBLISH' });
  for (const call of store.calls) expect(call.init.redirect).toBe('error');
});

it('uploads the ZIP while CRX signing is off', async () => {
  const store = fakeFetch([
    [/token$/, 200, { access_token: 'access' }],
    [/:upload$/, 200, { uploadState: 'SUCCEEDED', crxVersion: VERSION }],
    [/:publish$/, 200, { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ description: 'Takes longer' }] } }],
  ]);
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl, clock: fakeClock() })).resolves.toEqual({
    file: `ntfy-desk-${VERSION}-chrome.zip`,
    state: 'PENDING_REVIEW',
    warnings: ['Takes longer'],
  });
  expect(header(store.calls[1], 'Content-Type')).toBe('application/zip');
  expect(header(store.calls[1], 'X-Goog-Upload-Protocol')).toBeUndefined();
});

it.each([
  ['the upload fails', [[/:upload$/, 200, { uploadState: 'FAILED' }]], 'ended as FAILED'],
  ['the store reads another version', [[/:upload$/, 200, { uploadState: 'SUCCEEDED', crxVersion: '9.9' }]], 'read version 9.9'],
] as Array<[string, Array<[RegExp, number, unknown]>, string]>)(
  'stops before publishing to Chrome when %s',
  async (_, responses, message) => {
    const store = fakeFetch([[/token$/, 200, { access_token: 'access' }], ...responses]);
    await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl, clock: fakeClock() })).rejects.toThrow(message);
    expect(store.calls).toHaveLength(2);
  },
);

it('gives up when Chrome is still processing after ten minutes', async () => {
  const store = fakeFetch([
    [/token$/, 200, { access_token: 'access' }],
    [/:upload$/, 200, { uploadState: 'IN_PROGRESS' }],
    ...Array.from({ length: 60 }, (): [RegExp, number, unknown] => [/:fetchStatus$/, 200, { lastAsyncUploadState: 'IN_PROGRESS' }]),
  ]);
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl, clock: fakeClock() })).rejects.toThrow(
    'still processing after 10 minutes',
  );
  expect(store.calls.some((call) => call.url.endsWith(':publish'))).toBe(false);
});

it('refuses an item state that is not a submission', async () => {
  const store = fakeFetch([
    [/token$/, 200, { access_token: 'access' }],
    [/:upload$/, 200, { uploadState: 'SUCCEEDED' }],
    [/:publish$/, 200, { state: 'REJECTED' }],
  ]);
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl, clock: fakeClock() })).rejects.toThrow(
    'the item is REJECTED',
  );
});

it('reports API errors without credentials or control characters', async () => {
  const store = fakeFetch([[/token$/, 400, { error: 'invalid_grant', error_description: 'Bad refresh-token\nhere' }]]);
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: store.fetchImpl })).rejects.toThrow(
    /^Chrome OAuth token: HTTP 400 \(Bad \[redacted\] here\)$/,
  );

  const later = fakeFetch([
    [/token$/, 200, { access_token: 'access-token-value' }],
    [/:upload$/, 403, { error: { message: 'Token access-token-value lacks the scope' } }],
  ]);
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl: later.fetchImpl })).rejects.toThrow(
    'Chrome Web Store upload: HTTP 403 (Token [redacted] lacks the scope)',
  );
});

it('reports a network failure without details', async () => {
  const fetchImpl = (() => Promise.reject(new Error('connect to client-secret failed'))) as typeof fetch;
  await expect(publishChrome(VERSION, chromeConfig, { root, fetchImpl })).rejects.toThrow(
    /^Chrome OAuth token: no response \(network error or time limit\)$/,
  );
});

const firefoxConfig = { issuer: 'user:1:2', secret: 'amo-secret' };

it('uploads to AMO, waits for validation and creates the version with the sources', async () => {
  const store = fakeFetch([
    [/^https:\/\/addons\.mozilla\.org\/api\/v5\/addons\/upload\/$/, 201, { uuid: 'abc-123', processed: false }],
    [/\/addons\/upload\/abc-123\/$/, 200, { uuid: 'abc-123', processed: true, valid: true, version: VERSION }],
    [
      new RegExp(`/addons/addon/${encodeURIComponent(EXTENSION.firefoxId)}/versions/$`),
      201,
      { version: VERSION, file: { status: 'unreviewed' } },
    ],
  ]);

  await expect(publishFirefox(VERSION, firefoxConfig, { root, fetchImpl: store.fetchImpl, clock: fakeClock() })).resolves.toEqual({
    version: VERSION,
    fileStatus: 'unreviewed',
  });
  expect(store.remaining).toEqual([]);
  for (const call of store.calls) expect(header(call, 'Authorization')).toMatch(/^JWT [\w-]+\.[\w-]+\.[\w-]+$/);
  const uploadForm = store.calls[0]?.init.body as FormData;
  expect(uploadForm.get('channel')).toBe('listed');
  expect((uploadForm.get('upload') as File).name).toBe(`ntfy-desk-${VERSION}-firefox.zip`);
  const versionForm = store.calls[2]?.init.body as FormData;
  expect(versionForm.get('upload')).toBe('abc-123');
  expect((versionForm.get('source') as File).name).toBe(`ntfy-desk-${VERSION}-sources.zip`);
  expect(versionForm.get('license')).toBe('Apache-2.0');
});

it('stops before creating a version when AMO validation fails', async () => {
  const store = fakeFetch([
    [
      /\/addons\/upload\/$/,
      201,
      {
        uuid: 'abc-123',
        processed: true,
        valid: false,
        validation: { messages: [{ type: 'error', message: 'Bad manifest' }, { type: 'warning' }] },
      },
    ],
  ]);
  await expect(publishFirefox(VERSION, firefoxConfig, { root, fetchImpl: store.fetchImpl })).rejects.toThrow(
    'AMO validation failed, 1 error(s): Bad manifest',
  );
  expect(store.calls).toHaveLength(1);
});

it('reports a version AMO already has', async () => {
  const store = fakeFetch([
    [/\/addons\/upload\/$/, 201, { uuid: 'abc-123', processed: true, valid: true }],
    [/\/versions\/$/, 409, { version: [`Version ${VERSION} already exists.`] }],
  ]);
  await expect(publishFirefox(VERSION, firefoxConfig, { root, fetchImpl: store.fetchImpl })).rejects.toThrow(
    `AMO version: HTTP 409 (version: Version ${VERSION} already exists.)`,
  );
});
