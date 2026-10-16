import * as fs from 'node:fs';
import * as path from 'node:path';
import { config, getRun, info } from '../../../src';

/** Record what this worker process sees, and log one line. Waits so both workers are alive at once. */
export async function probe(name: string): Promise<void> {
  const c = config();
  info.log(`probe ${name}`);
  fs.writeFileSync(
    path.join(process.env.PROBE_DIR!, `${name}.json`),
    JSON.stringify({ pid: process.pid, worker: process.env.TEST_WORKER_INDEX, level: c.level, redactKeys: c.redactKeys, runId: getRun().runId }),
  );
  await new Promise((r) => setTimeout(r, 600));
}
