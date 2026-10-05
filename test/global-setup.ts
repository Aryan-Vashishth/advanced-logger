import * as path from 'node:path';
import { initRun } from '../src/playwright';

export default async function globalSetup(): Promise<void> {
  // Workers inherit this process's env, same as VOID_RUN_ID/VOID_RUN_DATE below.
  process.env.VOID_LOG_DIR ||= path.resolve(__dirname, '..', 'blackbox');
  initRun();
}
