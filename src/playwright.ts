import { test as base, expect } from '@playwright/test';
import { config } from './config';
import { setTestContext } from './core';
import { captureLogs } from './sinks';
import { info, error } from './logger';

/**
 * Drop-in replacement for Playwright's `test`. An auto fixture, active for every test, that:
 *  - tags log records with the test title,
 *  - logs a start/end banner,
 *  - attaches the test's log lines to the report (policy: config().attach, default on-failure).
 *
 * Import `test` and `expect` from here instead of '@playwright/test'.
 */
export const test = base.extend<{ voidLog: void }>({
  voidLog: [
    async ({}, use, testInfo) => {
      setTestContext(testInfo.titlePath.join(' > '));
      const capture = captureLogs();
      info.log(`TEST START | ${testInfo.titlePath.join(' > ')}`);
      try {
        await use();
      } finally {
        const failed = testInfo.status !== testInfo.expectedStatus;
        const line = `TEST END | ${testInfo.status} | ${testInfo.duration}ms`;
        if (failed) error.failed(line);
        else info.success(line);

        const text = capture.stop();
        const policy = config().attach;
        if (text && (policy === 'always' || (policy === 'on-failure' && failed))) {
          await testInfo.attach('void-log', { body: text, contentType: 'text/plain' });
        }
        setTestContext(undefined);
      }
    },
    { auto: true },
  ],
});

export { expect };
export { initRun } from './config';
