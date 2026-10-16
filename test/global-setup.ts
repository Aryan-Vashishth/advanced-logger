import { initRun } from '../src/playwright';

export default async function globalSetup(): Promise<void> {
  // Logs go to the default ./logs (or VOID_LOG_DIR if set). Workers inherit VOID_RUN_ID/VOID_RUN_DATE from here.
  initRun();
}
