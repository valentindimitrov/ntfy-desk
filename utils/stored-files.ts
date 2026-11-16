// Attachments picked for the next message. The popup closes when a file dialog opens, so files are
// picked in a window of their own and wait in IndexedDB as Blobs, shared by the popup, the extension
// tab, the file picker window and the background. A small revision key in storage.local tells the
// other views that the queue changed.

import { browser } from 'wxt/browser';

/** A queued attachment without its bytes, for listing it */
export interface StoredFileInfo {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** A queued attachment with its bytes, for sending it */
export interface StoredFile extends StoredFileInfo {
  blob: Blob;
}

interface StoredFileRecord extends StoredFile {
  /** Position in the queue: files are listed in the order they were picked */
  order: number;
}

/** storage.local key changed after every edit of the queue, so other views reload their list */
export const STORED_FILES_REVISION_KEY = 'storedFilesRevision';
/** The Web Lock that serializes every edit of the queue across views */
const QUEUE_LOCK = 'storedFiles';
const DB_NAME = 'ntfy-desk-attachments';
const DB_VERSION = 1;
const STORE = 'files';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_QUEUED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_QUEUED_FILES = 100;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
  };
  return requestResult(request);
}

/** Run one transaction and resolve with its result once it has committed. */
async function inTransaction<T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    let result: T;
    try {
      result = await task(transaction.objectStore(STORE));
    } catch (error) {
      transaction.abort();
      await done.catch(() => {});
      throw error;
    }
    await done;
    return result;
  } finally {
    db.close();
  }
}

async function readRecords(): Promise<StoredFileRecord[]> {
  const records = await inTransaction('readonly', (store) => requestResult(store.getAll() as IDBRequest<StoredFileRecord[]>));
  return records.sort((a, b) => a.order - b.order);
}

const withoutBlob = ({ id, name, type, size }: StoredFileInfo): StoredFileInfo => ({ id, name, type, size });

/** The queued attachments without their bytes */
export async function listStoredFiles(): Promise<StoredFileInfo[]> {
  return (await readRecords()).map(withoutBlob);
}

/** The queued attachments with their bytes (Blobs read from disk only when used) */
export async function readStoredFiles(): Promise<StoredFile[]> {
  return (await readRecords()).map(({ id, name, type, size, blob }) => ({ id, name, type, size, blob }));
}

/** Edits of the queue run one at a time across the popup, tab, picker and background. */
async function editStoredFiles(edit: () => Promise<void>): Promise<void> {
  await navigator.locks.request(QUEUE_LOCK, async () => {
    await edit();
    await browser.storage.local.set({ [STORED_FILES_REVISION_KEY]: crypto.randomUUID() });
  });
}

/** Validate the whole selection before storing it. Concurrent pickers share the same queue budget. */
export function addPickedFiles(files: File[]): Promise<void> {
  return editStoredFiles(async () => {
    const stored = await readRecords();
    if (stored.length + files.length > MAX_QUEUED_FILES) throw new Error(`Attach up to ${MAX_QUEUED_FILES} files at a time.`);
    if (files.some(({ size }) => size > MAX_ATTACHMENT_BYTES)) throw new Error('Each attachment must be 20 MiB or smaller.');
    const queued = stored.reduce((size, file) => size + file.size, 0);
    const selected = files.reduce((size, file) => size + file.size, 0);
    if (queued + selected > MAX_QUEUED_ATTACHMENT_BYTES) throw new Error('The attachment queue can hold up to 50 MiB.');
    const next = stored.reduce((order, file) => Math.max(order, file.order + 1), 0);
    await inTransaction('readwrite', (store) => {
      files.forEach((file, index) => {
        const record: StoredFileRecord = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          blob: file,
          order: next + index,
        };
        store.add(record);
      });
    });
  });
}

/** Remove these files only; files added meanwhile stay queued. */
export function removeStoredFiles(ids: string[]): Promise<void> {
  return editStoredFiles(() => inTransaction('readwrite', (store) => ids.forEach((id) => store.delete(id))));
}

export function clearStoredFiles(): Promise<void> {
  return editStoredFiles(() => inTransaction('readwrite', (store) => void store.clear()));
}

/** Start the request while the selected IDs still exist. Release the lock before waiting for it. */
export async function dispatchStoredUpload(ids: string[], upload: () => Promise<unknown>): Promise<boolean> {
  const { response } = await navigator.locks.request(QUEUE_LOCK, async () => {
    const current = new Set(await inTransaction('readonly', (store) => requestResult(store.getAllKeys())));
    if (ids.some((id) => !current.has(id))) return {};
    const response = upload();
    void response.catch(() => {});
    return { response };
  });
  if (!response) return false;
  await response;
  return true;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
