// The public website (pnpm website:dev, website:build, website:preview): static pages, no scripts.
// Separate from the extension build (WXT, wxt.config.ts) and from the root vite.config.ts (Vite+).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { HEADERS_FILE, renderPage } from './site.ts';

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const root = fromHere('.').replace(/\/$/, '');

/** The extension's licence, its notices and the licence of the Roboto fonts the site also uses (once if they are the same) */
const license = () =>
  [...new Set(['../LICENSE', '../NOTICE.md', '../public/fonts/LICENSE.txt'].map((path) => readFileSync(fromHere(path), 'utf8')))].join(
    '\n\n',
  );

export default defineConfig(({ command }) => ({
  root,
  base: '/',
  // Several pages, no single-page fallback: an unknown address gets 404.html, as on the host
  appType: 'mpa',
  publicDir: fromHere('./public'),
  plugins: [
    {
      name: 'ntfy-desk-website',
      transformIndexHtml: {
        // Before Vite resolves the pages' images and styles, so the shared parts go through it too
        order: 'pre',
        handler: (html, context) => renderPage(html, basename(context.filename, '.html'), root, command === 'build'),
      },
      configureServer(server) {
        server.middlewares.use('/LICENSE.txt', (_request, response) => {
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end(license());
        });
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: license() });
        this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS_FILE });
        // Fixed, unhashed name: the pages' og:image points at this absolute URL
        this.emitFile({ type: 'asset', fileName: 'social-card.png', source: readFileSync(fromHere('./media/social-card.png')) });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5180, strictPort: true, open: false },
  preview: { host: '127.0.0.1', port: 5181, strictPort: true, open: false },
  build: {
    // Every image and font is a file of the site: the Content-Security-Policy allows no data: URLs
    assetsInlineLimit: 0,
    modulePreload: false,
    outDir: fromHere('../.output/website'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: fromHere('./index.html'),
        'setup-instructions': fromHere('./setup-instructions.html'),
        'privacy-policy': fromHere('./privacy-policy.html'),
        '404': fromHere('./404.html'),
      },
    },
  },
}));
