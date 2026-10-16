import { test } from '../../../src/playwright';
import { probe } from './probe';

test('worker sees the config file (a)', async () => {
  await probe('a');
});
