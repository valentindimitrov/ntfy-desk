// CRX3 signing and verification for Chrome Web Store verified uploads (docs/crx-signing.md).
// Imports only Node built-ins: the release workflow's signing job runs it from a fresh checkout
// without installing dependencies.
//
// Wire format: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
// Chromium's creator uses RSA PKCS#1 v1.5 with SHA-256 for the RSA proof.

import { constants, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const CONTEXT = Buffer.from('CRX3 SignedData\0');
const MAGIC = Buffer.from('Cr24');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 3, 4]);

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.push((rest % 128) | (rest >= 128 ? 128 : 0));
    rest = Math.floor(rest / 128);
  } while (rest);
  return Buffer.from(bytes);
}

/** A length-delimited protobuf field */
function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

/** Reads a message that holds exactly the expected length-delimited fields, each once */
function fields(bytes: Buffer, expected: number[]): Map<number, Buffer> {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = bytes[offset++];
      requireValid(byte !== undefined, 'Truncated CRX3 header');
      value += (byte & 127) * 2 ** shift;
      requireValid(value <= 0xffffffff, 'Invalid CRX3 header integer');
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid CRX3 header integer');
  };
  const result = new Map<number, Buffer>();
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Math.floor(tag / 8);
    requireValid(tag % 8 === 2 && expected.includes(number), 'Unexpected CRX3 header field');
    requireValid(!result.has(number), 'Duplicate CRX3 header field');
    const length = readVarint();
    requireValid(length <= bytes.length - offset, 'Truncated CRX3 header field');
    result.set(number, bytes.subarray(offset, offset + length));
    offset += length;
  }
  requireValid(result.size === expected.length, 'Missing CRX3 header field');
  return result;
}

function required(map: Map<number, Buffer>, number: number): Buffer {
  const value = map.get(number);
  requireValid(value, 'Missing CRX3 header field');
  return value;
}

function publicDer(pem: string | Buffer): Buffer {
  return createPublicKey(pem).export({ format: 'der', type: 'spki' });
}

/** SHA-256 of the DER SubjectPublicKeyInfo, as hex: the fingerprint to compare with the registered key */
export function publicKeyFingerprint(publicPem: string | Buffer): string {
  return createHash('sha256').update(publicDer(publicPem)).digest('hex');
}

/** Checks a CRX3 against the saved public key and returns the ZIP it carries */
export function verifyCrx3(crx: Buffer, expectedPublicKey: string | Buffer): Buffer {
  requireValid(crx.length >= 12 && crx.subarray(0, 4).equals(MAGIC), 'Invalid CRX3 magic');
  requireValid(crx.readUInt32LE(4) === 3, 'Unsupported CRX version');
  const headerLength = crx.readUInt32LE(8);
  requireValid(headerLength <= 1024 * 1024 && headerLength <= crx.length - 12, 'Invalid CRX3 header length');
  const header = fields(crx.subarray(12, 12 + headerLength), [2, 10000]);
  const proof = fields(required(header, 2), [1, 2]);
  const publicKey = required(proof, 1);
  requireValid(publicKey.equals(publicDer(expectedPublicKey)), 'CRX3 signing key does not match the saved public key');
  const signedHeader = required(header, 10000);
  const signedData = fields(signedHeader, [1]);
  const id = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  requireValid(required(signedData, 1).equals(id), 'CRX3 ID does not match its signing key');
  const archive = crx.subarray(12 + headerLength);
  requireValid(archive.subarray(0, 4).equals(ZIP_MAGIC), 'CRX3 archive is not a ZIP');
  requireValid(
    verify(
      'sha256',
      Buffer.concat([CONTEXT, uint32(signedHeader.length), signedHeader, archive]),
      { key: createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_PADDING },
      required(proof, 2),
    ),
    'CRX3 signature verification failed',
  );
  return archive;
}

/** Signs a ZIP as a CRX3. The private key must be the pair of the saved public key. */
export function signCrx3(archive: Buffer, privatePem: string | Buffer, expectedPublicKey: string | Buffer): Buffer {
  let key;
  try {
    key = createPrivateKey(privatePem);
  } catch {
    // The parser's own message could quote its input, which is the secret
    throw new Error('Cannot parse CRX signing key; expected an RSA PEM private key');
  }
  requireValid(
    key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
    'CRX signing requires an RSA key of at least 2048 bits',
  );
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' });
  requireValid(publicKey.equals(publicDer(expectedPublicKey)), 'CRX signing key does not match the saved public key');
  const id = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedHeader = field(1, id);
  const signature = sign('sha256', Buffer.concat([CONTEXT, uint32(signedHeader.length), signedHeader, archive]), {
    key,
    padding: constants.RSA_PKCS1_PADDING,
  });
  const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
  const crx = Buffer.concat([MAGIC, uint32(3), uint32(header.length), header, archive]);
  requireValid(verifyCrx3(crx, expectedPublicKey).equals(archive), 'Signed archive verification failed');
  return crx;
}
