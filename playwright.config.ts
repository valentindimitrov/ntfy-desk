import { defineConfig } from '@playwright/test';

// End-to-end tests: the isolated E2E build in Playwright's Chromium against a test ntfy server.
// Run with pnpm test:e2e, which builds first.
export default defineConfig({
  testDir: 'tests/e2e',
  // Each test starts its own Chromium with the extension; several at once time out on a laptop and
  // are hardly faster, so one at a time
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
