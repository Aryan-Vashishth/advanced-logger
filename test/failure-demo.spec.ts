import { test, expect } from '../src/playwright';
import { error } from '../src';

/**
 * Deliberately fails, to demonstrate the voidLog fixture's attach-on-failure behavior
 * (config().attach, default 'on-failure'): the test's log lines get attached to the
 * Playwright report. Kept out of `npm test` (see playwright.config.ts testIgnore) so
 * that always exits 0; run this one on demand, from the repo root:
 *
 *   npx playwright test --config=test/playwright.failure-demo.config.ts
 */
test('a failing test attaches the log', async () => {
  error.failed('about to fail');
  expect(1).toBe(2);
});
