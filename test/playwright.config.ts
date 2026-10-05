import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // Deliberately fails to demonstrate attach-on-failure; run it explicitly:
  // npx playwright test --config=test/playwright.failure-demo.config.ts
  testIgnore: 'failure-demo.spec.ts',
  workers: 2,
  fullyParallel: true,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
});
