import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PUBLIC_KEY_PATH, packageChrome } from '../../scripts/sign-chrome.ts';
import { VERSION, browserFiles, releaseFixture, write, writePackage, zip } from './helpers/release-fixture';

// Throwaway keys, generated for this run only; the private key exists in memory alone
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' });
const privateKey = () => Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));

let root: string;
let crx: string;
beforeEach(() => {
  root = releaseFixture();
  crx = `${root}/.output/ntfy-desk-${VERSION}-chrome.crx`;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('skips signing while no public key is committed, even with a private key', () => {
  expect(packageChrome({ root })).toEqual({ status: 'skipped' });
  const key = privateKey();
  expect(packageChrome({ root, privateKey: key })).toEqual({ status: 'skipped' });
  expect(key.every((byte) => byte === 0)).toBe(true);
  expect(existsSync(crx)).toBe(false);
  expect(() => packageChrome({ root, verifyOnly: true })).toThrow('signing is off');
});

it('signs the Chromium ZIP, verifies it without the private key and clears the key', () => {
  write(root, PUBLIC_KEY_PATH, publicPem);
  const key = privateKey();
  const signed = packageChrome({ root, privateKey: key });
  expect(signed).toMatchObject({ status: 'signed', file: crx });
  expect(key.every((byte) => byte === 0)).toBe(true);
  const written = readFileSync(crx);
  expect(written.subarray(0, 4).toString()).toBe('Cr24');
  expect(written.includes(readFileSync(`${root}/.output/ntfy-desk-${VERSION}-chrome.zip`))).toBe(true);
  expect(written.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
  expect(packageChrome({ root, verifyOnly: true })).toEqual({ ...signed, status: 'verified' });
});

it('fails when the public key is committed and the private key is missing or another one', () => {
  write(root, PUBLIC_KEY_PATH, publicPem);
  expect(() => packageChrome({ root })).toThrow('NTFY_DESK_CRX_PRIVATE_KEY is not set');
  expect(() => packageChrome({ root, privateKey: Buffer.alloc(0) })).toThrow('NTFY_DESK_CRX_PRIVATE_KEY is not set');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  expect(() => packageChrome({ root, privateKey: Buffer.from(other) })).toThrow('does not match the saved public key');
  expect(() => packageChrome({ root, privateKey: Buffer.from('not a key') })).toThrow('Cannot parse CRX signing key');
  expect(existsSync(crx)).toBe(false);
});

it('fails verification when the ZIP changed after signing or the CRX is missing', () => {
  write(root, PUBLIC_KEY_PATH, publicPem);
  expect(() => packageChrome({ root, verifyOnly: true })).toThrow();
  packageChrome({ root, privateKey: privateKey() });
  writePackage(root, 'chrome', { ...browserFiles('chrome'), 'background.js': 'console.log("changed")' });
  expect(() => packageChrome({ root, verifyOnly: true })).toThrow('does not carry the current Chromium ZIP');
  write(root, `.output/ntfy-desk-${VERSION}-chrome.crx`, zip({ 'manifest.json': '{}' }));
  expect(() => packageChrome({ root, verifyOnly: true })).toThrow('Invalid CRX3 magic');
});

it('refuses a public key file that is not a public key', () => {
  write(root, PUBLIC_KEY_PATH, privateKey());
  expect(() => packageChrome({ root, privateKey: privateKey() })).toThrow('must hold the public key only');
  write(root, PUBLIC_KEY_PATH, 'not a key');
  expect(() => packageChrome({ root, privateKey: privateKey() })).toThrow('is not a PEM public key');
});
