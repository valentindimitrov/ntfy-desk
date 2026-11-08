// Attachments picked for the next message. They live in storage.local as data URLs because the
// popup closes when a file dialog opens, so the file picker runs in its own window.

import { browser } from 'wxt/browser';

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  /** data: URL */
  data: string;
}

export const STORED_FILES_KEY = 'storedFiles';
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_QUEUED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_QUEUED_FILES = 100;

export async function readStoredFiles(): Promise<StoredFile[]> {
  const result = await browser.storage.local.get([STORED_FILES_KEY]);
  const files = result[STORED_FILES_KEY];
  // Old attachments get stable IDs until the next edit persists them.
  return Array.isArray(files) ? (files as StoredFile[]).map((file, index) => ({ ...file, id: file.id ?? `legacy-${index}` })) : [];
}

/** The popup, tab and file picker share storage. Keep the entire read/modify/write under one lock. */
async function editStoredFiles(edit: (files: StoredFile[]) => StoredFile[] | Promise<StoredFile[]>): Promise<void> {
  return navigator.locks.request(STORED_FILES_KEY, async () => {
    const files = await edit(await readStoredFiles());
    if (files.length === 0) await browser.storage.local.remove(STORED_FILES_KEY);
    else await browser.storage.local.set({ [STORED_FILES_KEY]: files });
  });
}

/** Validate the whole selection before reading it. Concurrent pickers share the same queue budget. */
export function addPickedFiles(files: File[]): Promise<void> {
  return editStoredFiles(async (stored) => {
    if (stored.length + files.length > MAX_QUEUED_FILES) throw new Error(`Attach up to ${MAX_QUEUED_FILES} files at a time.`);
    if (files.some(({ size }) => size > MAX_ATTACHMENT_BYTES)) throw new Error('Each attachment must be 20 MiB or smaller.');
    const queued = stored.reduce((size, file) => size + file.size, 0);
    const selected = files.reduce((size, file) => size + file.size, 0);
    if (queued + selected > MAX_QUEUED_ATTACHMENT_BYTES) throw new Error('The attachment queue can hold up to 50 MiB.');
    const added: StoredFile[] = [];
    for (const file of files) added.push(await readFileAsDataUrl(file));
    return [...stored, ...added];
  });
}

export function removeStoredFiles(ids: string[]): Promise<void> {
  const removed = new Set(ids);
  return editStoredFiles((stored) => stored.filter((file) => !removed.has(file.id)));
}

export const clearStoredFiles = (): Promise<void> => editStoredFiles(() => []);

/** Start the request while the selected IDs still exist. Release the lock before waiting for it. */
export async function dispatchStoredUpload(ids: string[], upload: () => Promise<unknown>): Promise<boolean> {
  const { response } = await navigator.locks.request(STORED_FILES_KEY, async () => {
    const current = new Set((await readStoredFiles()).map(({ id }) => id));
    if (ids.some((id) => !current.has(id))) return {};
    const response = upload();
    void response.catch(() => {});
    return { response };
  });
  if (!response) return false;
  await response;
  return true;
}

function readFileAsDataUrl(file: File): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL: the result is a string
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        size: file.size,
        data: typeof reader.result === 'string' ? reader.result : '',
      });
    };
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}"`));
    reader.onabort = () => reject(new Error(`Reading "${file.name}" was cancelled`));
    reader.readAsDataURL(file);
  });
}

/** Bytes of a data: URL */
export function decodeDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
