import * as fs from 'node:fs';
import * as path from 'node:path';
import { config, configure, initRun } from '../../../src';

// Runs in the Playwright runner process only. Workers never see this call.
export default async function globalSetup(): Promise<void> {
  configure({ level: 'error', redactKeys: ['globalsetup-only'] });
  // Workers inherit env set here, so this is the one place initRun() works. PROBE_INIT_RUN=0 simulates forgetting it.
  if (process.env.PROBE_INIT_RUN !== '0') initRun();
  fs.writeFileSync(path.join(process.env.PROBE_DIR!, 'global-setup.json'), JSON.stringify({ level: config().level }));
}
