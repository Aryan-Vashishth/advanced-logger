import * as fs from 'node:fs';
import * as path from 'node:path';
import { config, configure } from '../../../src';

// Runs in the Playwright runner process only. Workers never see this call.
export default async function globalSetup(): Promise<void> {
  configure({ level: 'error', redactKeys: ['globalsetup-only'] });
  fs.writeFileSync(path.join(process.env.PROBE_DIR!, 'global-setup.json'), JSON.stringify({ level: config().level }));
}
