import { test } from '@playwright/test';
import { probe } from './probe';

test('worker sees the config file (b)', async () => {
  await probe('b');
});
