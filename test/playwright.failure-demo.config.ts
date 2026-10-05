import { defineConfig } from '@playwright/test';

/**
 * Runs only failure-demo.spec.ts, which the default config (testIgnore) excludes so
 * `npm test` always exits 0. Use this to see the attach-on-failure behavior on demand,
 * from the repo root:
 *
 *   npx playwright test --config=test/playwright.failure-demo.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'failure-demo.spec.ts',
  reporter: [['list']],
  globalSetup: './global-setup.ts',
});
