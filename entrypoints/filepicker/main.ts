// File picker window: the popup closes when a file dialog opens, so files are picked here and
// added to the stored attachments, which the popup shows.

import '@/assets/styles.css';
import { addStoredFiles, readFileAsDataUrl } from '@/utils/stored-files';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const fileInput = byId<HTMLInputElement>('file-input');
const dropZone = byId<HTMLElement>('drop-zone');
const status = byId<HTMLElement>('status');

document.body.setAttribute('data-theme', new URLSearchParams(location.search).get('theme') ?? 'auto');

function showError(message: string): void {
  status.textContent = message;
  status.className = 'status visible error';
  dropZone.style.pointerEvents = '';
  dropZone.style.opacity = '';
}

async function processFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;

  dropZone.style.pointerEvents = 'none';
  dropZone.style.opacity = '0.6';
  try {
    // Read the whole selection before writing, so a read error doesn't append part of it
    const newFiles = await Promise.all(files.map(readFileAsDataUrl));
    await addStoredFiles(newFiles);

    status.textContent = `✓ ${files.length} file${files.length === 1 ? '' : 's'} attached!`;
    status.className = 'status visible success';
    setTimeout(() => window.close(), 800);
  } catch (error) {
    showError(`Error: ${(error as Error).message}`);
  }
}

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove('drag-over');
  void processFiles(Array.from(event.dataTransfer?.files ?? []));
});

// A file dropped outside the zone shouldn't open in the window
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  void processFiles(files);
});
