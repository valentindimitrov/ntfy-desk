// Attachments picked for the next message. They live in storage.local as data URLs because the
// popup closes when a file dialog opens, so the file picker runs in its own window.

import { browser } from 'wxt/browser';

export interface StoredFile {
  name: string;
  type: string;
  size: number;
  /** data: URL */
  data: string;
}

export const STORED_FILES_KEY = 'storedFiles';

export async function readStoredFiles(): Promise<StoredFile[]> {
  const result = await browser.storage.local.get([STORED_FILES_KEY]);
  const files = result[STORED_FILES_KEY];
  return Array.isArray(files) ? (files as StoredFile[]) : [];
}

export async function persistStoredFiles(files: StoredFile[]): Promise<void> {
  if (files.length === 0) {
    await browser.storage.local.remove([STORED_FILES_KEY]);
  } else {
    await browser.storage.local.set({ [STORED_FILES_KEY]: files });
  }
}

export function readFileAsDataUrl(file: File): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({ name: file.name, type: file.type, size: file.size, data: String(reader.result) });
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
