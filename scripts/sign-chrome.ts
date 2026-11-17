// pnpm sign:chrome: signs .output/ntfy-desk-<version>-chrome.zip as a CRX3 for Chrome Web Store
// verified uploads. pnpm verify:crx: checks an existing CRX against the committed public key and the
// ZIP, without the private key. See docs/crx-signing.md.
//
// Signing is on once the public key is committed. Without that file, signing is skipped (exit 0); with
// it, a missing or different private key is an error. The private key comes from the environment
// (NTFY_DESK_CRX_PRIVATE_KEY, PKCS#8 PEM) and is never written to a file or printed.
//
// Imports only Node built-ins and the two scripts next to it: the release workflow's signing job runs
// it from a fresh checkout without installing dependencies.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyFingerprint, signCrx3, verifyCrx3 } from './crx3.ts';
import { packagePath, readPackageVersion } from './validate-packages.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLIC_KEY_PATH = 'assets/store-listings/chrome-web-store/crx-signing-public-key.pem';
export const PRIVATE_KEY_VARIABLE = 'NTFY_DESK_CRX_PRIVATE_KEY';

export type SignResult =
  | { status: 'skipped' }
  /** file: the CRX; fingerprint: SHA-256 of the public key (DER SubjectPublicKeyInfo) */
  | { status: 'signed' | 'verified'; file: string; fingerprint: string };

type Options = {
  root?: string;
  /** PKCS#8 PEM; its buffer is zeroed after use */
  privateKey?: Buffer | undefined;
  /** Check an existing CRX instead of writing one */
  verifyOnly?: boolean;
};

export function packageChrome({ root = repositoryRoot, privateKey, verifyOnly = false }: Options = {}): SignResult {
  try {
    const publicKeyFile = join(root, PUBLIC_KEY_PATH);
    if (!existsSync(publicKeyFile)) {
      if (verifyOnly) throw new Error(`Nothing to verify: ${PUBLIC_KEY_PATH} is not committed, so signing is off`);
      return { status: 'skipped' };
    }
    const publicKey = readFileSync(publicKeyFile);
    if (/PRIVATE KEY/.test(publicKey.toString('latin1'))) throw new Error(`${PUBLIC_KEY_PATH} must hold the public key only`);
    let fingerprint: string;
    try {
      fingerprint = publicKeyFingerprint(publicKey);
    } catch {
      throw new Error(`${PUBLIC_KEY_PATH} is not a PEM public key`);
    }

    const version = readPackageVersion(root);
    const archive = readFileSync(packagePath(root, version, 'chrome'));
    const file = packagePath(root, version, 'chrome', 'crx');
    if (!verifyOnly) {
      if (!privateKey?.length) {
        throw new Error(`${PUBLIC_KEY_PATH} is committed, so signing is on, but ${PRIVATE_KEY_VARIABLE} is not set`);
      }
      writeFileSync(file, signCrx3(archive, privateKey, publicKey));
    }
    if (!verifyCrx3(readFileSync(file), publicKey).equals(archive)) throw new Error('The CRX does not carry the current Chromium ZIP');
    return { status: verifyOnly ? 'verified' : 'signed', file, fingerprint };
  } finally {
    privateKey?.fill(0);
  }
}

/** For the workflow: a step output (signed=true|false) and a line in the run's summary */
function report(result: SignResult, hadPrivateKey: boolean): void {
  const output = process.env['GITHUB_OUTPUT'];
  if (output) appendFileSync(output, `signed=${result.status === 'skipped' ? 'false' : 'true'}\n`);
  let line: string;
  if (result.status === 'skipped') {
    line =
      `CRX signing skipped: ${PUBLIC_KEY_PATH} is not committed, so the release carries the unsigned ZIPs only.` +
      (hadPrivateKey ? ` ${PRIVATE_KEY_VARIABLE} is set but was not used.` : '');
  } else {
    const done = result.status === 'signed' ? 'Signed and verified' : 'Verified';
    line = `${done} ${relative(repositoryRoot, result.file)} (public key SHA-256 ${result.fingerprint}).`;
  }
  console.log(line);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, `${line}\n\n`);
}

if (import.meta.main) {
  // Out of the environment before anything else runs
  const pem = process.env[PRIVATE_KEY_VARIABLE];
  delete process.env[PRIVATE_KEY_VARIABLE];
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--verify')) throw new Error('Usage: node scripts/sign-chrome.ts [--verify]');
    const verifyOnly = args.includes('--verify');
    report(packageChrome({ privateKey: pem && !verifyOnly ? Buffer.from(pem) : undefined, verifyOnly }), Boolean(pem));
  } catch (error) {
    // Messages thrown here are this script's own; signCrx3 hides the key parser's
    console.error(error instanceof Error ? error.message : 'CRX packaging failed');
    process.exitCode = 1;
  }
}
