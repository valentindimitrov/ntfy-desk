// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendImageFromUrl } from '@/utils/ntfy';
import { addPickedFiles, MAX_ATTACHMENT_BYTES, MAX_QUEUED_ATTACHMENT_BYTES, readStoredFiles } from '@/utils/stored-files';
import { mockWebLocks } from './helpers/mock';

function sizedFile(name: string, size: number): File {
  return Object.defineProperty(new File(['x'], name), 'size', { value: size });
}

beforeEach(() => {
  fakeBrowser.reset();
  mockWebLocks();
});

describe('attachment queue', () => {
  it('rejects an oversized file before reading any file in the selection', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    await expect(addPickedFiles([new File(['x'], 'small.txt'), sizedFile('large.bin', MAX_ATTACHMENT_BYTES + 1)])).rejects.toThrow(
      '20 MiB',
    );
    expect(read).not.toHaveBeenCalled();
    expect(await readStoredFiles()).toEqual([]);
  });

  it('checks the combined budget against files queued by another picker before encoding', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    await fakeBrowser.storage.local.set({
      storedFiles: [{ id: 'prior', name: 'queued.bin', size: MAX_QUEUED_ATTACHMENT_BYTES - 1, type: '', data: 'data:;base64,eA==' }],
    });
    const results = await Promise.allSettled([
      addPickedFiles([new File(['a'], 'first.txt')]),
      addPickedFiles([new File(['b'], 'second.txt')]),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('50 MiB') }) });
    expect(read).toHaveBeenCalledTimes(1);
    expect((await readStoredFiles()).map(({ name }) => name)).toEqual(['queued.bin', 'first.txt']);
  });

  it('bounds the number of empty files as well as their total size', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    await expect(addPickedFiles(Array.from({ length: 101 }, (_, i) => new File([], String(i))))).rejects.toThrow('100 files');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('context menu image downloads', () => {
  const server = { apiUrl: 'https://ntfy.example', accessToken: '' };
  const url = 'https://images.example/source';

  it('cancels an oversized stream even when the length header is missing', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendImageFromUrl(server, 'alerts', url)).rejects.toThrow('20 MiB');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an advertised oversized image before acquiring its reader', async () => {
    const response = new Response('x', { headers: { 'Content-Length': String(MAX_ATTACHMENT_BYTES + 1) } });
    const read = vi.spyOn(response.body!, 'getReader');
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendImageFromUrl(server, 'alerts', url)).rejects.toThrow('20 MiB');
    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploads a small streamed image intact', async () => {
    const fetchMock = vi.fn(async (request: string, _init: RequestInit) =>
      request === url ? new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }) : new Response(''),
    );
    vi.stubGlobal('fetch', fetchMock);
    await sendImageFromUrl(server, 'alerts', url);
    const [destination, upload] = fetchMock.mock.calls[1]!;
    expect(destination).toBe('https://ntfy.example/alerts');
    expect(new Headers(upload.headers).get('X-Filename')).toBe('image.png');
    expect(await (upload.body as Blob).text()).toBe('image bytes');
  });
});
