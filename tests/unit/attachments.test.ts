// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendImageFromUrl } from '@/utils/ntfy';
import { clearComposerOnStartup } from '@/utils/messages';
import {
  STORED_FILES_REVISION_KEY,
  addPickedFiles,
  dispatchStoredUpload,
  listStoredFiles,
  MAX_ATTACHMENT_BYTES,
  MAX_QUEUED_ATTACHMENT_BYTES,
  readStoredFiles,
  removeStoredFiles,
} from '@/utils/stored-files';
import { installIndexedDb, queuedNames, queueFiles } from './helpers/indexed-db';
import { mockWebLocks } from './helpers/mock';

function sizedFile(name: string, size: number): File {
  return Object.defineProperty(new File(['x'], name), 'size', { value: size });
}

beforeEach(() => {
  fakeBrowser.reset();
  mockWebLocks();
  installIndexedDb();
});

describe('attachment queue', () => {
  it('rejects an oversized file before storing any file in the selection', async () => {
    await expect(addPickedFiles([new File(['x'], 'small.txt'), sizedFile('large.bin', MAX_ATTACHMENT_BYTES + 1)])).rejects.toThrow(
      '20 MiB',
    );
    expect(await readStoredFiles()).toEqual([]);
  });

  it('checks the combined budget against files queued by another picker', async () => {
    await addPickedFiles([
      sizedFile('queued.bin', MAX_ATTACHMENT_BYTES),
      sizedFile('queued.bin', MAX_ATTACHMENT_BYTES),
      sizedFile('queued.bin', MAX_QUEUED_ATTACHMENT_BYTES - 2 * MAX_ATTACHMENT_BYTES - 1),
    ]);
    const results = await Promise.allSettled([
      addPickedFiles([new File(['a'], 'first.txt')]),
      addPickedFiles([new File(['b'], 'second.txt')]),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('50 MiB') }) });
    expect(await queuedNames()).toEqual(['queued.bin', 'queued.bin', 'queued.bin', 'first.txt']);
  });

  it('bounds the number of empty files as well as their total size', async () => {
    await expect(addPickedFiles(Array.from({ length: 101 }, (_, i) => new File([], String(i))))).rejects.toThrow('100 files');
    expect(await readStoredFiles()).toEqual([]);
  });

  it('keeps the bytes as a Blob in IndexedDB, in the order picked, and lists metadata only', async () => {
    await queueFiles(['b.txt', 'second'], ['a.txt', 'first']);
    const files = await readStoredFiles();
    expect(files.map(({ name, type, size }) => [name, type, size])).toEqual([
      ['b.txt', 'text/plain', 6],
      ['a.txt', 'text/plain', 5],
    ]);
    expect(await files[0]!.blob.text()).toBe('second');
    expect(await listStoredFiles()).toEqual(files.map(({ id, name, type, size }) => ({ id, name, type, size })));
    expect(await fakeBrowser.storage.local.get('storedFiles')).toEqual({});
  });

  it('removes only the given ids, leaving files added meanwhile', async () => {
    await queueFiles(['sent.txt']);
    const [sent] = await listStoredFiles();
    await queueFiles(['added.txt']);
    await removeStoredFiles([sent!.id]);
    expect(await queuedNames()).toEqual(['added.txt']);
  });

  it('changes the revision key after each edit so other views reload', async () => {
    const revisions: unknown[] = [];
    fakeBrowser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORED_FILES_REVISION_KEY]) revisions.push(changes[STORED_FILES_REVISION_KEY].newValue);
    });
    await queueFiles(['a.txt']);
    await removeStoredFiles([(await listStoredFiles())[0]!.id]);
    expect(revisions).toHaveLength(2);
    expect(new Set(revisions).size).toBe(2);
  });

  it('starts an upload only while its files are queued, and releases the lock before it completes', async () => {
    await queueFiles(['a.txt']);
    const [file] = await listStoredFiles();
    const { promise, resolve } = Promise.withResolvers<void>();
    const upload = vi.fn(() => promise);
    const dispatched = dispatchStoredUpload([file!.id], upload);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    // The queue stays editable while the request runs
    await queueFiles(['b.txt']);
    resolve();
    expect(await dispatched).toBe(true);

    const skipped = vi.fn(async () => {});
    expect(await dispatchStoredUpload(['gone'], skipped)).toBe(false);
    expect(skipped).not.toHaveBeenCalled();
  });

  it('clears the queue and a leftover data URL queue of earlier builds on browser startup', async () => {
    await queueFiles(['a.txt']);
    await fakeBrowser.storage.local.set({ draftState: { message: 'Old draft' }, storedFiles: [{ name: 'old.txt' }] });
    await clearComposerOnStartup();
    expect(await queuedNames()).toEqual([]);
    expect(await fakeBrowser.storage.local.get(['draftState', 'storedFiles'])).toEqual({});
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
