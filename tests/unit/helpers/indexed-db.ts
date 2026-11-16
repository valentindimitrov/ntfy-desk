// IndexedDB for unit tests: Happy DOM and Node have none. fake-indexeddb copies values with
// structuredClone, which keeps Node's Blob and File but not Happy DOM's, so tests use Node's.

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';
import { addPickedFiles, listStoredFiles } from '@/utils/stored-files';

/** A new, empty IndexedDB for each test (stubs are undone after each test) */
export function installIndexedDb(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
}

/** Queue text files as the file picker would */
export function queueFiles(...files: [name: string, content?: string][]): Promise<void> {
  return addPickedFiles(files.map(([name, content = 'x']) => new File([content], name, { type: 'text/plain' })));
}

export async function queuedNames(): Promise<string[]> {
  return (await listStoredFiles()).map(({ name }) => name);
}
