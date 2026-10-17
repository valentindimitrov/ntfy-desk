import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, createZip, getEntryName } from '@/utils/zip';

/** Minimal reader for the archives createZip writes: local headers in order, deflated entries */
function readZip(bytes: Uint8Array): { name: string; data: Buffer; crc: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(8); // deflate
    const crc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength;
    const data = inflateRawSync(bytes.subarray(start, start + compressedSize));
    entries.push({ name, data, crc });
    offset = start + compressedSize;
  }
  // The end-of-central-directory record closes the archive
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(entries.length);
  return entries;
}

describe('createZip', () => {
  it('writes deflated entries that unpack to the original files', async () => {
    const files = [
      { name: 'notes.txt', data: new TextEncoder().encode('hello hello hello') },
      { name: 'dir\\Grüße.bin', data: new Uint8Array([0, 1, 2, 255]).buffer },
    ];
    const zip = await createZip(files);
    expect(zip.type).toBe('application/zip');

    const entries = readZip(new Uint8Array(await zip.arrayBuffer()));
    expect(entries.map(e => e.name)).toEqual(['notes.txt', 'Grüße.bin']);
    expect(entries[0]!.data.toString()).toBe('hello hello hello');
    expect([...entries[1]!.data]).toEqual([0, 1, 2, 255]);
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(new Uint8Array(entry.data)));
    }
  });

  it('needs at least two files', async () => {
    await expect(createZip([{ name: 'a', data: new Uint8Array(1) }])).rejects.toThrow('At least two files');
  });

  it('cleans entry names', () => {
    expect(getEntryName('a/b/c.txt', 0)).toBe('c.txt');
    expect(getEntryName('', 2)).toBe('file-3');
    expect(getEntryName('bad\u0001name', 0)).toBe('bad_name');
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
