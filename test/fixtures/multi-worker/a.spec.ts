import { test } from '@playwright/test';
import { probe } from './probe';

test('worker sees the config file (a)', async () => {
  await probe('a');
});
