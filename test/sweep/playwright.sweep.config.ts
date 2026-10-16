import { defineConfig } from '@playwright/test';

/**
 * Manual sweep: every console visual plus every file the logger writes, in one run.
 *
 *   npm run sweep
 *
 * Look at the console as it prints, then at the inventory and checks printed at the end. Output lands in ./logs
 * (or VOID_LOG_DIR), like any run; nothing there is deleted, and only this run's files are checked.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'sweep.spec.ts',
  workers: 2,
  fullyParallel: true,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});
