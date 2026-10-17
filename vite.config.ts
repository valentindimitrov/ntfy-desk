// Vite+ (vp lint, vp fmt, vp check) settings only. The extension itself is built by WXT
// (wxt.config.ts), and the tests run with vitest.config.ts.

import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['.output/**', '.wxt/**', 'node_modules/**'],
    options: {
      // Rules that need type information, and the full type check (as tsc --noEmit)
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    // Markdown stays as written: padded tables are hard to edit by hand
    ignorePatterns: ['.output/**', '.wxt/**', 'pnpm-lock.yaml', '**/*.md'],
    singleQuote: true,
    printWidth: 140,
  },
});
