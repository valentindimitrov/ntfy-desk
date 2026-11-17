import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { publicKeyFingerprint, signCrx3, verifyCrx3 } from '../../scripts/crx3.ts';

// Throwaway keys, generated for this run only
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicPem = key.publicKey.export({ format: 'pem', type: 'spki' });
const archive = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);

it('signs a CRX3 and recovers the exact ZIP it carries', () => {
  const crx = signCrx3(archive, pem, publicPem);
  expect(crx.subarray(0, 4).toString()).toBe('Cr24');
  expect(verifyCrx3(crx, publicPem)).toEqual(archive);
  expect(crx.includes(pem)).toBe(false);
  expect(publicKeyFingerprint(publicPem)).toMatch(/^[0-9a-f]{64}$/);
});

it('refuses a changed archive', () => {
  const crx = signCrx3(archive, pem, publicPem);
  crx[crx.length - 1] = (crx[crx.length - 1] ?? 0) ^ 1;
  expect(() => verifyCrx3(crx, publicPem)).toThrow('signature verification failed');
});

it('refuses a signing key other than the saved public key', () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherPublic = other.publicKey.export({ format: 'pem', type: 'spki' });
  expect(() => signCrx3(archive, pem, otherPublic)).toThrow('does not match');
  expect(() => verifyCrx3(signCrx3(archive, pem, publicPem), otherPublic)).toThrow('does not match');
});

it('refuses something that is not a ZIP', () => {
  expect(() => signCrx3(Buffer.from('plain text'), pem, publicPem)).toThrow('not a ZIP');
});

it.each([0, 4, 11, 20])('refuses a CRX cut off at byte %i', (length) => {
  expect(() => verifyCrx3(signCrx3(archive, pem, publicPem).subarray(0, length), publicPem)).toThrow();
});

it('refuses a header length beyond the file', () => {
  const crx = signCrx3(archive, pem, publicPem);
  crx.writeUInt32LE(0xffffffff, 8);
  expect(() => verifyCrx3(crx, publicPem)).toThrow('header length');
});

it('refuses keys that are not RSA or too short, and does not repeat unreadable key input', () => {
  const other = generateKeyPairSync('ed25519');
  expect(() => signCrx3(archive, other.privateKey.export({ format: 'pem', type: 'pkcs8' }), publicPem)).toThrow('requires an RSA');
  const short = generateKeyPairSync('rsa', { modulusLength: 1024 });
  expect(() =>
    signCrx3(archive, short.privateKey.export({ format: 'pem', type: 'pkcs8' }), short.publicKey.export({ format: 'pem', type: 'spki' })),
  ).toThrow('at least 2048 bits');
  const secret = 'private-key-input-that-must-not-be-logged';
  let message = '';
  try {
    signCrx3(archive, secret, publicPem);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain('Cannot parse');
  expect(message).not.toContain(secret);
});
