import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 2,
  fullyParallel: true,
  reporter: [['line']],
  globalSetup: './global-setup.ts',
});
